import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleClientMessage } from '../../src/server/dispatch.js';
import { mapFor } from '../../src/server/maps.js';
import { RoomManager } from '../../src/server/rooms/lobby.js';
import { trackRuntime } from '../../src/server/rooms/RaceRoom.js';
import type { TimeTrialRoom } from '../../src/server/rooms/TimeTrialRoom.js';
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
});
