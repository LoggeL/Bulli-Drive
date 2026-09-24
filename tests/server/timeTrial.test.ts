import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleClientMessage } from '../../src/server/dispatch.js';
import { mapFor } from '../../src/server/maps.js';
import { RoomManager } from '../../src/server/rooms/lobby.js';
import { trackRuntime } from '../../src/server/rooms/RaceRoom.js';
import { MemoryGhostStore, ReplayBudget } from '../../src/server/race/ghostStore.js';
import { ghostKeyFor, TimeTrialRoom } from '../../src/server/rooms/TimeTrialRoom.js';
import type { Session } from '../../src/server/session.js';
import { mulberry32 } from '../../src/shared/math/rng.js';
import { statesEqual } from '../../src/shared/net/prediction.js';
import type { ClientMessage } from '../../src/shared/protocol.js';
import { createGhostPose, fromBase64, ghostSampleCount, readGhostPose } from '../../src/shared/race/ghostTrack.js';
import { LineDriver } from '../../src/shared/race/lineDriver.js';
import { replayRun, RUN_INPUT_BYTES } from '../../src/shared/race/replay.js';
import { COUNTDOWN_TICKS, GHOST_POSE_EVERY, RESULTS_TICKS, TIMETRIAL_PREP_TICKS } from '../../src/shared/race/rules.js';
import { HILL_SPRINT } from '../../src/shared/race/tracks/index.js';
import { BTN_RESET } from '../../src/shared/sim/constants.js';
import { copyVehicleState, createVehicleInput, createVehicleState, type VehicleInput, type VehicleState } from '../../src/shared/sim/types.js';
import { roomOptions } from '../../src/server/rooms/Room.js';
import { ghostRun } from './ghostStore.contract.js';
import { fakeClock, fakeSession, feed, type FakeTransport } from './helpers.js';

// The time trial (docs/phase-2-design.md, 6.2, 15 and 20.1): a run driven
// in the room with scripted inputs (a line driver on the server's own car,
// like a perfect client) is kept as a ghost; the replay reproduces it bit
// for bit from the recorded inputs, a changed input changes it; the next
// countdown brings the ghost. Two independent paths: the room's tick with
// its input buffer, rules and phases against the bare replay.

type Player = Session & { transport: FakeTransport };

let clock: ReturnType<typeof fakeClock>;
let lobby: RoomManager;

beforeEach(() => {
    clock = fakeClock();
    lobby = new RoomManager(mapFor(), { maxPlayersPerRoom: 32, emptyRoomTtlMs: 60_000, now: clock.now });
});

afterEach(() => {
    for (const r of lobby.list()) r.dispose();
    roomOptions.allowDebugPlace = false;
});

function send(player: Session, msg: ClientMessage): void {
    expect(handleClientMessage(lobby, player, msg, clock.now())).toBe('ok');
}

function trialPlayer(name: string): { player: Player; room: TimeTrialRoom } {
    const player = fakeSession(name);
    lobby.join(player, 'timetrial', { track: 'hill-sprint' });
    send(player, { type: 'ready' });
    const room = player.room as TimeTrialRoom;
    room.step();
    return { player, room };
}

/**
 * Drives one run: START, then every tick the line driver's input for the
 * server car, until the results. Returns the car state right after the
 * finishing tick.
 */
function driveRun(
    player: Player, room: TimeTrialRoom, seed: number,
    script: (T: number, S: number) => Partial<VehicleInput> | null = () => null
): VehicleState {
    const start: ClientMessage = { type: 'raceReady', ready: true };
    send(player, start);
    room.step();
    expect(room.phase).toBe('countdown');
    const car = player.member!.car!;
    const driver = new LineDriver(trackRuntime(room.map, 'hill-sprint').course, car.params, 'hard', mulberry32(seed));
    driver.startRace(room.startTick!);
    const input = createVehicleInput();
    const atFinish = createVehicleState();
    let finished = false;
    for (let i = 0; i < 4000 && room.phase !== 'results'; i++) {
        driver.drive(car.state, car.params, room.tick + 1, room.startTick, [], input);
        const scripted = script(room.tick + 1, room.startTick!);
        feed(room, player, scripted ? { ...input, ...scripted } : input);
        room.step();
        if (!finished && room.racer(player.id)!.progress.status === 'finished') {
            finished = true;
            copyVehicleState(atFinish, car.state);
        }
    }
    expect(room.phase).toBe('results');
    return atFinish;
}

describe('time trial', () => {
    it('starts at once on START with the short preparation and no bots', () => {
        const { player, room } = trialPlayer('Solo');
        expect(room.id).toMatch(/^timetrial-/);
        send(player, { type: 'raceReady', ready: true });
        const t = room.tick;
        room.step();
        expect(room.phase).toBe('countdown');
        expect(room.startTick).toBe(t + 1 + TIMETRIAL_PREP_TICKS + COUNTDOWN_TICKS);
        expect(room.racers.map(r => r.id)).toEqual([player.id]);
        expect(room.members.size).toBe(1);
    });

    it('keeps a finished run that the replay reproduces bit for bit, and a changed input changes it', () => {
        const { player, room } = trialPlayer('Solo');
        const atFinish = driveRun(player, room, 7);
        const racer = room.racer(player.id)!;
        expect(racer.progress.status).toBe('finished');
        expect(room.rejectedRuns).toBe(0);
        const run = lobby.ghosts.personalBest(room.ghostKey, player.id)!;
        expect(run.finishTicks).toBe(racer.progress.finishTicks);
        expect(run.gateTicks).toEqual(racer.progress.gateTimes);
        expect(run.playerName).toBe('Solo');

        const { world, course } = trackRuntime(room.map, 'hill-sprint');
        const replay = replayRun(world, course, run);
        expect(replay.finishTicks).toBe(run.finishTicks);
        expect(replay.gateTicks).toEqual(run.gateTicks);
        expect(statesEqual(replay.state, atFinish)).toBe(true);
        // A hard driver on the hill sprint: 20 to 40 s
        expect(run.finishTicks / 60).toBeGreaterThan(20);
        expect(run.finishTicks / 60).toBeLessThan(40);

        // One tick of steering changed a second after the start
        const changed = run.inputs.slice();
        const at = (run.spawnToStart + 60) * RUN_INPUT_BYTES;
        changed[at] = (changed[at] + 60) & 0xff;
        const other = replayRun(world, course, { ...run, inputs: changed });
        expect(other.finishTicks).not.toBe(run.finishTicks);

        const results = player.transport.of('raceResults').at(-1)!;
        expect(results.personal).toEqual({ finishTicks: run.finishTicks, improved: false });
        expect(results.record).toEqual({ name: 'Solo', finishTicks: run.finishTicks });
    });

    it('replays a run with a reset in it (the reset pose and the check of 10.3 run in the replay too)', () => {
        const { player, room } = trialPlayer('Solo');
        // Reset held for 34 ticks five seconds into the run
        const atFinish = driveRun(player, room, 7, (T, S) => (T >= S + 300 && T < S + 334 ? { steer: 0, throttle: 0, brake: 0, buttons: BTN_RESET } : null));
        expect(room.rejectedRuns).toBe(0);
        const run = lobby.ghosts.best(room.ghostKey)!;
        const { world, course } = trackRuntime(room.map, 'hill-sprint');
        const replay = replayRun(world, course, run);
        expect(replay.finishTicks).toBe(run.finishTicks);
        expect(statesEqual(replay.state, atFinish)).toBe(true);
    });

    it('drops a run the replay cannot reproduce (an e2e teleport), keeping no ghost', () => {
        roomOptions.allowDebugPlace = true;
        const { player, room } = trialPlayer('Solo');
        let placed = false;
        driveRun(player, room, 7, (T, S) => {
            if (!placed && T === S + 30) {
                placed = true;
                send(player, { type: 'debugPlace', x: 356 - 20 * Math.sin(0.54), z: 30 - 20 * Math.cos(0.54), yaw: 0.54 });
            }
            return null;
        });
        expect(room.racer(player.id)!.progress.status).toBe('finished');
        expect(room.rejectedRuns).toBe(1);
        expect(lobby.ghosts.best(room.ghostKey)).toBeNull();
        const results = player.transport.of('raceResults').at(-1)!;
        expect(results.personal).toBeUndefined();
        expect(results.record).toBeUndefined();
    });

    it('sends the own best as the ghost at the next countdown, and the record to another player', () => {
        const { player, room } = trialPlayer('Solo');
        driveRun(player, room, 7);
        const run = lobby.ghosts.best(room.ghostKey)!;
        player.transport.clear();
        // RETRY straight from the results
        send(player, { type: 'timeTrialRestart' });
        expect(room.phase).toBe('countdown');
        const ghost = player.transport.of('ghostData').at(-1)!;
        expect(ghost).toMatchObject({ kind: 'personal', name: 'Solo', finishTicks: run.finishTicks, gateTicks: run.gateTicks, hz: 20 });
        const poses = fromBase64(ghost.poses)!;
        // One sample every 3 ticks from startTick up to the finish
        expect(ghostSampleCount(poses)).toBe(Math.floor(Math.ceil(run.finishTicks) / GHOST_POSE_EVERY) + 1);
        // The first sample is the car on the pole at green
        const first = readGhostPose(poses, 0, createGhostPose());
        expect(first.x).toBeCloseTo(HILL_SPRINT.grid[0].x, 2);
        expect(first.z).toBeCloseTo(HILL_SPRINT.grid[0].z, 1);

        const other = trialPlayer('Other');
        expect(other.room).not.toBe(room);
        send(other.player, { type: 'raceReady', ready: true });
        other.room.step();
        expect(other.player.transport.of('ghostData').at(-1)).toMatchObject({ kind: 'record', name: 'Solo', finishTicks: run.finishTicks });
    });

    it('goes back to its lobby after the results on the same track, unless the player asks for the next', () => {
        const { player, room } = trialPlayer('Solo');
        driveRun(player, room, 7);
        for (let i = 0; i < RESULTS_TICKS && room.phase === 'results'; i++) room.step();
        expect(room.phase).toBe('lobby');
        expect(room.trackId).toBe('hill-sprint');
        expect(room.ghostKey.trackId).toBe('hill-sprint');
    });

    it('restarts from the race itself and keeps the better of two runs', () => {
        const { player, room } = trialPlayer('Solo');
        driveRun(player, room, 7);
        const first = lobby.ghosts.best(room.ghostKey)!.finishTicks;
        // A second run by an easier driver: slower, so the first stays
        send(player, { type: 'timeTrialRestart' });
        const car = player.member!.car!;
        const easy = new LineDriver(trackRuntime(room.map, 'hill-sprint').course, car.params, 'easy', mulberry32(3));
        easy.startRace(room.startTick!);
        const input = createVehicleInput();
        for (let i = 0; i < 4000 && room.phase !== 'results'; i++) {
            easy.drive(car.state, car.params, room.tick + 1, room.startTick, [], input);
            feed(room, player, input);
            room.step();
        }
        const second = room.racer(player.id)!.progress.finishTicks!;
        expect(second).toBeGreaterThan(first);
        expect(lobby.ghosts.personalBest(room.ghostKey, player.id)!.finishTicks).toBe(first);
        expect(player.transport.of('raceResults').at(-1)!.personal).toEqual({ finishTicks: first, improved: false });
        // RETRY in the middle of a run: a new countdown, the car back on the pole
        send(player, { type: 'timeTrialRestart' });
        for (let i = 0; i < 400; i++) {
            feed(room, player, { steer: 0, throttle: 255, brake: 0, buttons: 0 });
            room.step();
        }
        expect(room.phase).toBe('racing');
        send(player, { type: 'timeTrialRestart' });
        expect(room.phase).toBe('countdown');
        expect([player.member!.car!.state.x, player.member!.car!.state.z]).toEqual([HILL_SPRINT.grid[0].x, HILL_SPRINT.grid[0].z]);
    });

    it('starts one countdown for a burst of RETRYs, none in the countdown, and sends a ghost only when the client lacks it', () => {
        const { player, room } = trialPlayer('Solo');
        driveRun(player, room, 7);
        const run = lobby.ghosts.personalBest(room.ghostKey, player.id)!;
        // The check replay's pose track is kept: the countdown replays nothing
        expect(lobby.ghosts.cachedPoses(run)).not.toBeNull();
        const stepUntil = (done: () => boolean, input: Partial<VehicleInput> = {}) => {
            for (let i = 0; i < 600 && !done(); i++) {
                if (player.member!.car) feed(room, player, input);
                room.step();
            }
            expect(done()).toBe(true);
        };
        player.transport.clear();
        for (let i = 0; i < 20; i++) send(player, { type: 'timeTrialRestart' });
        const S = room.startTick!;
        room.step();
        expect(room.phase).toBe('countdown');
        // Later in the countdown: still ignored
        stepUntil(() => room.tick >= S - 100);
        send(player, { type: 'timeTrialRestart' });
        room.step();
        expect(room.startTick).toBe(S);
        expect(player.transport.events('spawn').filter(e => e.id === player.id)).toHaveLength(1);
        expect(player.transport.of('ghostData')).toHaveLength(1);
        // RETRY once racing: a new countdown, the same ghost is not sent again
        stepUntil(() => room.phase === 'racing');
        send(player, { type: 'timeTrialRestart' });
        room.step();
        expect(room.startTick).toBeGreaterThan(S);
        expect(player.transport.of('ghostData')).toHaveLength(1);
        // The client drops the ghost with the track: after a track change
        // and back it comes again (to the results by an e2e placement)
        stepUntil(() => room.phase === 'racing');
        roomOptions.allowDebugPlace = true;
        send(player, { type: 'debugPlace', x: 356 - 20 * Math.sin(0.54), z: 30 - 20 * Math.cos(0.54), yaw: 0.54 });
        stepUntil(() => room.phase === 'results', { throttle: 255 });
        send(player, { type: 'raceVote', choice: 'next' });
        room.step();
        expect(room.phase).toBe('lobby');
        expect(player.transport.of('raceState').at(-1)!.trackId).toBe('downtown-loop');
        // Back to the Hill Sprint before the voter's countdown starts
        send(player, { type: 'raceConfig', track: 'hill-sprint' });
        expect(room.trackId).toBe('hill-sprint');
        room.step();
        expect(room.phase).toBe('countdown');
        expect(player.transport.of('ghostData')).toHaveLength(2);
        // And after a resume (the client starts over on the room state)
        room.resume(player.member!);
        expect(player.transport.of('roomState').at(-1)!.resume).toBeDefined();
        stepUntil(() => room.phase === 'racing');
        send(player, { type: 'timeTrialRestart' });
        expect(player.transport.of('ghostData')).toHaveLength(3);
    });

    it('waits for the replay budget with a ghost whose pose track is not at hand', () => {
        let replays = 0;
        const store = new MemoryGhostStore(() => { replays++; return new Uint8Array(13); });
        store.submit(ghostRun('someone', 1800, ghostKeyFor(mapFor(), 'hill-sprint')));
        const budget = new ReplayBudget(1, 1);
        const room = new TimeTrialRoom(9, mapFor(), clock.now, { track: 'hill-sprint', ghosts: store, replays: budget });
        const player = fakeSession('Solo');
        room.join(player);
        room.markReady(player.member!);
        room.step();
        // Another room took the budget just now
        expect(budget.take(clock.now())).toBe(true);
        room.onMessage(player.member!, { type: 'raceReady', ready: true });
        for (let i = 0; i < 30; i++) room.step();
        expect(room.phase).toBe('countdown');
        expect(player.transport.of('ghostData')).toHaveLength(0);
        expect(replays).toBe(0);
        // A second later the budget has one replay again: the ghost comes
        clock.advance(1000);
        room.step();
        expect(replays).toBe(1);
        expect(player.transport.of('ghostData').at(-1)).toMatchObject({ kind: 'record', name: 'Name someone', finishTicks: 1800 });
        room.dispose();
    });

    it('sends the ghost again once it is a different run: a new record', () => {
        const key = ghostKeyFor(mapFor(), 'hill-sprint');
        const store = new MemoryGhostStore(() => new Uint8Array(13));
        store.submit(ghostRun('first', 1800, key));
        const room = new TimeTrialRoom(9, mapFor(), clock.now, { track: 'hill-sprint', ghosts: store });
        const player = fakeSession('Solo');
        room.join(player);
        room.markReady(player.member!);
        room.step();
        room.onMessage(player.member!, { type: 'raceReady', ready: true });
        for (let i = 0; i < 300 && room.phase !== 'racing'; i++) room.step();
        expect(player.transport.of('ghostData').map(g => g.finishTicks)).toEqual([1800]);
        // Somebody else sets a faster time meanwhile; the next RETRY brings it
        store.submit(ghostRun('second', 1700, key));
        room.onMessage(player.member!, { type: 'timeTrialRestart' });
        expect(player.transport.of('ghostData').map(g => g.finishTicks)).toEqual([1800, 1700]);
        room.dispose();
    });
});

