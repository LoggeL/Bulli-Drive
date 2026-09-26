import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleClientMessage } from '../../src/server/dispatch.js';
import { mapFor } from '../../src/server/maps.js';
import { RoomManager } from '../../src/server/rooms/lobby.js';
import type { RaceRoom } from '../../src/server/rooms/RaceRoom.js';
import { roomOptions } from '../../src/server/rooms/Room.js';
import type { Session } from '../../src/server/session.js';
import { CAR_LAGGY, CAR_RACE_GHOST } from '../../src/shared/net/codec.js';
import { LAGGY_RECOVER_TICKS } from '../../src/shared/net/constants.js';
import type { ClientMessage } from '../../src/shared/protocol.js';
import {
    COUNTDOWN_PREP_TICKS, COUNTDOWN_TICKS, DNF_AFTER_FIRST_TICKS, LOBBY_ALL_READY_TICKS, LOBBY_AUTOSTART_TICKS,
    RACE_STATUS_EVERY, RESULTS_TICKS, START_GHOST_TICKS
} from '../../src/shared/race/rules.js';
import { createProjection, pointAt } from '../../src/shared/race/geometry.js';
import { nextGateIndex } from '../../src/shared/race/progress.js';
import { createCourse } from '../../src/shared/race/progress.js';
import { racingLine } from '../../src/shared/race/racingLine.js';
import { trackDef } from '../../src/shared/race/tracks/index.js';
import { BTN_BOOST, BTN_HANDBRAKE, BTN_RESET } from '../../src/shared/sim/constants.js';
import { placeVehicle } from '../../src/shared/sim/vehicle.js';
import { fakeClock, fakeSession, feed, type FakeTransport } from './helpers.js';

// The race room (docs/phase-2-design.md, 6, 7, 10 to 12 and 20.1) with fake
// sessions and a tick loop: the phases and their tick counts, the freeze,
// the launch, the bots filling the field, the start ghost, DNF, the vote,
// spectators, an emptied room, the wrong-way flag and the reset check. The
// expected tick counts come from the rules (section 4), not from the room.

type Player = Session & { transport: FakeTransport };
type Input = { steer?: number; throttle?: number; brake?: number; buttons?: number };

let clock: ReturnType<typeof fakeClock>;
let lobby: RoomManager;
let room: RaceRoom;

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

/** A player in the race room, past the splash screen; the car is on the grid after the next tick. */
function human(name: string, fresh = false): Player {
    const session = fakeSession(name);
    lobby.join(session, 'race', { fresh });
    room = session.room as RaceRoom;
    send(session, { type: 'ready' });
    return session;
}

// n ticks; every player with a car sends an input (neutral unless given)
function tick(n = 1, inputs: Map<Session, Input | ((T: number) => Input)> = new Map()): void {
    for (let i = 0; i < n; i++) {
        const T = room.tick + 1;
        for (const m of room.orderedMembers) {
            if (m.bot || !m.car) continue;
            const given = inputs.get(m.session);
            feed(room, m.session, typeof given === 'function' ? given(T) : given ?? {});
        }
        room.step(clock.now());
    }
}

// Runs ticks until the condition holds (at most max)
function tickUntil(done: () => boolean, max: number, inputs?: Map<Session, Input | ((T: number) => Input)>): void {
    for (let i = 0; i < max && !done(); i++) tick(1, inputs);
    expect(done()).toBe(true);
}

/** Players ready, the countdown started; returns startTick. */
function startRace(players: Player[], track: 'hill-sprint' | 'downtown-loop' = 'hill-sprint'): number {
    tick();
    if (room.trackId !== track) send(players[0], { type: 'raceConfig', track });
    for (const p of players) send(p, { type: 'raceReady', ready: true });
    tickUntil(() => room.phase === 'countdown', LOBBY_ALL_READY_TICKS + 2);
    return room.startTick!;
}

function pos(player: Session): { x: number; z: number } {
    const s = player.member!.car!.state;
    return { x: s.x, z: s.z };
}

const DOWNTOWN_LOOP = trackDef(mapFor(), 'downtown-loop');
const HILL_SPRINT = trackDef(mapFor(), 'hill-sprint');
const HARBOR_CIRCUIT = trackDef(mapFor(), 'harbor-circuit');

// A point of a track's racing line at station s (a circuit wraps), facing
// along the line (against it with back = true)
function onLine(track: typeof HILL_SPRINT, s: number, back = false): { x: number; z: number; yaw: number } {
    const p = pointAt(racingLine(track), s, createProjection());
    return { x: p.x, z: p.z, yaw: back ? Math.atan2(-p.tx, -p.tz) : Math.atan2(p.tx, p.tz) };
}

// 20 m before the Ridge Climb's finish gate on its racing line, facing along it
const FINISH_S = createCourse(HILL_SPRINT, racingLine(HILL_SPRINT)).gateS.at(-1)!;
const BEFORE_FINISH = onLine(HILL_SPRINT, FINISH_S - 20);

/**
 * E2E placement of the players' cars just before the finish, full throttle
 * until the results; the i-th one 5 m further back, 3 m to the side (so
 * they cross in the order given).
 */
function finishAll(players: Player[]): void {
    roomOptions.allowDebugPlace = true;
    const fx = Math.sin(BEFORE_FINISH.yaw), fz = Math.cos(BEFORE_FINISH.yaw);
    players.forEach((p, i) => {
        const back = 5 * i, side = i === 0 ? 0 : i % 2 ? 3 : -3;
        send(p, { type: 'debugPlace', x: BEFORE_FINISH.x - back * fx + side * fz, z: BEFORE_FINISH.z - back * fz - side * fx, yaw: BEFORE_FINISH.yaw });
    });
    tickUntil(() => room.phase === 'results', 400, new Map(players.map(p => [p, { throttle: 255 }])));
}

describe('lobby', () => {
    it('puts a player past the splash screen onto grid slot 0 of the track, frozen', () => {
        const a = human('A');
        // The car spawns at the end of the first tick; the events go out with the next snapshot
        tick(2);
        const slot = DOWNTOWN_LOOP.grid[0];
        expect(pos(a)).toEqual({ x: slot.x, z: slot.z });
        expect(a.transport.events('spawn').at(-1)).toMatchObject({ id: a.id, grid: 0, x: slot.x, z: slot.z, yaw: slot.yaw });
        tick(120, new Map([[a, { throttle: 255, steer: 90 }]]));
        expect(pos(a)).toEqual({ x: slot.x, z: slot.z });
        expect(room.phase).toBe('lobby');
    });

    it('starts the countdown LOBBY_ALL_READY_TICKS after everyone is ready', () => {
        const a = human('A');
        tick();
        send(a, { type: 'raceReady', ready: true });
        const t = room.tick;
        tick(LOBBY_ALL_READY_TICKS);
        expect(room.phase).toBe('lobby');
        expect(room.phaseEndTick).toBe(t + 1 + LOBBY_ALL_READY_TICKS);
        tick();
        expect(room.phase).toBe('countdown');
        // T0 = t + 61; startTick = T0 + prep + countdown
        expect(room.startTick).toBe(t + 1 + LOBBY_ALL_READY_TICKS + COUNTDOWN_PREP_TICKS + COUNTDOWN_TICKS);
        expect(a.transport.of('raceState').at(-1)).toMatchObject({ phase: 'countdown', startTick: room.startTick, mode: 'race' });
    });

    it('with one of two ready starts after LOBBY_AUTOSTART_TICKS, sooner once the other is ready too', () => {
        const a = human('A');
        const b = human('B');
        tick();
        send(a, { type: 'raceReady', ready: true });
        const t = room.tick;
        tick(LOBBY_AUTOSTART_TICKS);
        expect(room.phase).toBe('lobby');
        tick();
        expect(room.phase).toBe('countdown');
        expect(room.startTick).toBe(t + 1 + LOBBY_AUTOSTART_TICKS + COUNTDOWN_PREP_TICKS + COUNTDOWN_TICKS);
        // B was not ready: a spectator without a car
        expect(room.racers.map(r => r.id)).not.toContain(b.id);
        expect(b.member!.car).toBeNull();
        expect(b.transport.events('despawn')).toEqual([{ type: 'despawn', id: b.id, tick: room.tick }]);

        const c = human('C', true);
        const d = human('D');
        expect(d.room).toBe(c.room);
        tick();
        send(c, { type: 'raceReady', ready: true });
        tick(100);
        send(d, { type: 'raceReady', ready: true });
        const both = room.tick;
        tickUntil(() => room.phase === 'countdown', LOBBY_ALL_READY_TICKS + 1);
        expect(room.tick).toBe(both + 1 + LOBBY_ALL_READY_TICKS);
    });

    it('takes back a ready flag, and takes raceReady only in the lobby', () => {
        const a = human('A');
        const b = human('B');
        tick();
        send(a, { type: 'raceReady', ready: true });
        send(a, { type: 'raceReady', ready: false });
        tick(LOBBY_AUTOSTART_TICKS + 5);
        expect(room.phase).toBe('lobby');
        expect(room.ready.size).toBe(0);
        startRace([a, b]);
        send(a, { type: 'raceReady', ready: false });
        expect(room.ready.has(a.id)).toBe(true);
    });

    it('changes track and bot level by raceConfig, at most once a second per player, and moves the cars', () => {
        const a = human('A');
        tick();
        send(a, { type: 'raceConfig', track: 'hill-sprint', botLevel: 'hard' });
        expect([room.trackId, room.botLevel]).toEqual(['hill-sprint', 'hard']);
        const slot = HILL_SPRINT.grid[0];
        expect(pos(a)).toEqual({ x: slot.x, z: slot.z });
        // Within the second: ignored
        tick(59);
        send(a, { type: 'raceConfig', track: 'downtown-loop', botLevel: 'easy' });
        expect([room.trackId, room.botLevel]).toEqual(['hill-sprint', 'hard']);
        tick();
        send(a, { type: 'raceConfig', botLevel: 'easy' });
        expect([room.trackId, room.botLevel]).toEqual(['hill-sprint', 'easy']);
        tick();
        expect(a.transport.of('raceState').at(-1)).toMatchObject({ trackId: 'hill-sprint', botLevel: 'easy', trackVersion: HILL_SPRINT.trackVersion });
    });
});

describe('lobby details', () => {
    it('lets a player behind the splash screen not hold up the others', () => {
        const a = human('A');
        const c = fakeSession('C');
        lobby.join(c, 'race');
        expect(c.room).toBe(room);
        tick();
        send(a, { type: 'raceReady', ready: true });
        tick(LOBBY_ALL_READY_TICKS + 1);
        expect(room.phase).toBe('countdown');
        expect(room.racers.map(r => r.id)).not.toContain(c.id);
    });

    it('seats eight on the grid: the ninth player watches, in the lobby and in the race', () => {
        const players = Array.from({ length: 9 }, (_, i) => human(`P${i}`));
        tick();
        expect(players.filter(p => p.member!.car).length).toBe(8);
        expect(players[8].member!.car).toBeNull();
        for (const p of players) send(p, { type: 'raceReady', ready: true });
        tick(LOBBY_ALL_READY_TICKS + 1);
        expect(room.phase).toBe('countdown');
        expect(room.racers).toHaveLength(8);
        expect(room.racers.every(r => !r.bot)).toBe(true);
        expect(room.racers.map(r => r.id)).not.toContain(players[8].id);
    });

    it('orders the first grid by who came first, not by id', () => {
        // B's session is older (a smaller id) but A joins the room first
        const bSession = fakeSession('B');
        const a = human('A');
        lobby.join(bSession, 'race');
        send(bSession, { type: 'ready' });
        expect(bSession.id < a.id).toBe(true);
        startRace([a, bSession as Player]);
        expect(room.racers.slice(0, 2).map(r => r.id)).toEqual([a.id, bSession.id]);
    });

    it('sends the race state when something changes, not every tick, with the racers, the ready list and no votes', () => {
        const a = human('A');
        const b = human('B');
        tick(2);
        a.transport.clear();
        tick(30);
        expect(a.transport.of('raceState')).toHaveLength(0);
        send(b, { type: 'raceReady', ready: true });
        send(a, { type: 'raceReady', ready: true });
        tick();
        const state = a.transport.of('raceState').at(-1)!;
        expect(state.ready).toEqual([a.id, b.id].sort());
        expect(state.votes).toBeNull();
        tickUntil(() => room.phase === 'countdown', LOBBY_ALL_READY_TICKS + 1);
        const racers = a.transport.of('raceState').at(-1)!.racers;
        expect(racers.slice(0, 2)).toEqual([{ id: a.id, grid: 0, bot: false }, { id: b.id, grid: 1, bot: false }]);
        expect(racers.slice(2).every((r, i) => r.bot && r.grid === i + 2)).toBe(true);
    });

    it('changes the car in the lobby at once, and takes the lobby messages only there', () => {
        const a = human('A');
        const b = human('B');
        tick();
        send(a, { type: 'setCar', carType: 'pickup', profile: 'standard' });
        tick(2);
        expect(a.member!.car!.base.mass).toBe(2000);
        const S = startRace([a, b]);
        // Config in the countdown, a vote before the results: ignored
        send(a, { type: 'raceConfig', track: 'downtown-loop', botLevel: 'easy' });
        send(a, { type: 'raceVote', choice: 'rematch' });
        expect([room.trackId, room.botLevel, room.votes.size]).toEqual(['hill-sprint', 'medium', 0]);
        expect(room.startTick).toBe(S);
    });
});

describe('countdown and start', () => {
    it('fills the field with bots up to 6 that count as no players and are tagged', () => {
        const a = human('A');
        startRace([a]);
        expect(room.racers).toHaveLength(6);
        expect(room.racers.filter(r => r.bot)).toHaveLength(5);
        expect(room.racers[0].id).toBe(a.id);
        expect(room.members.size).toBe(6);
        expect(room.size).toBe(1);
        const joined = a.transport.of('playerJoined').map(m => m.member);
        expect(joined).toHaveLength(5);
        expect(joined.every(m => m.bot === true)).toBe(true);
        // Every car on its grid slot, the grid in the spawn events
        room.racers.forEach((r, k) => {
            const s = r.member!.car!.state;
            expect([s.x, s.z, s.yaw]).toEqual([HILL_SPRINT.grid[k].x, HILL_SPRINT.grid[k].z, HILL_SPRINT.grid[k].yaw]);
        });
        expect(a.transport.events('spawn').filter(e => e.tick === room.tick).map(e => e.grid)).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('holds every car still before startTick, whatever the input, and lets them go at it', () => {
        const a = human('A');
        const S = startRace([a]);
        const grid = room.racers.map(r => ({ x: r.member!.car!.state.x, z: r.member!.car!.state.z }));
        const everything = { throttle: 255, brake: 255, steer: 127, buttons: BTN_BOOST | BTN_RESET | BTN_HANDBRAKE };
        tickUntil(() => room.tick === S - 1, S, new Map([[a, everything]]));
        expect(room.racers.map(r => ({ x: r.member!.car!.state.x, z: r.member!.car!.state.z }))).toEqual(grid);
        expect(a.member!.car!.state.resetHold).toBe(0);
        tick(60, new Map([[a, { throttle: 255 }]]));
        expect(room.phase).toBe('racing');
        const moved = room.racers.map(r => Math.hypot(r.member!.car!.state.x - grid[room.racers.indexOf(r)].x, r.member!.car!.state.z - grid[room.racers.indexOf(r)].z));
        expect(Math.min(...moved)).toBeGreaterThan(1);
    });

    it('gives a perfect launch to a throttle edge in the window and an early one to a held throttle', () => {
        const a = human('A');
        const b = human('B');
        const S = startRace([a, b]);
        // A presses 10 ticks before green, B from the start of the countdown
        const inputs = new Map<Session, (T: number) => Input>([
            [a, T => ({ throttle: T >= S - 10 ? 255 : 0 })],
            [b, () => ({ throttle: 255 })]
        ]);
        tickUntil(() => room.tick === S, S, inputs);
        const launches = a.transport.events('launch');
        expect(launches.find(e => e.id === a.id)).toEqual({ type: 'launch', id: a.id, result: 'perfect', tick: S });
        expect(launches.find(e => e.id === b.id)?.result).toBe('early');
        expect(launches).toHaveLength(6);
        // One launch per racer: none in the ticks after green
        tick(30, inputs);
        expect(a.transport.events('launch')).toHaveLength(6);
    });

    it('keeps two overlapping cars apart in the start ghost, and lets them part without a push after it', () => {
        const a = human('A');
        const b = human('B');
        const S = startRace([a, b]);
        tickUntil(() => room.tick === S - 1, S);
        // B right on top of A (1 m behind), both frozen
        const at = pos(a);
        placeVehicle(b.member!.car!.state, room.map.simWorld, at.x, at.z + 1, Math.PI);
        b.member!.car!.state.y = a.member!.car!.state.y;
        tickUntil(() => room.tick === S + START_GHOST_TICKS - 1, S + START_GHOST_TICKS);
        // Standing in each other through the start ghost: nobody moved
        expect(pos(a)).toEqual(at);
        expect(pos(b)).toEqual({ x: at.x, z: at.z + 1 });
        // A drives off, B stands: B is never flung away
        let bTop = 0;
        for (let i = 0; i < 240; i++) {
            tick(1, new Map([[a, { throttle: 255 }]]));
            const s = b.member!.car!.state;
            bTop = Math.max(bTop, Math.hypot(s.vx, s.vz));
        }
        expect(Math.hypot(pos(a).x - at.x, pos(a).z - at.z)).toBeGreaterThan(20);
        expect(bTop).toBeLessThan(0.5);
        expect(a.member!.car!.state.ghostTicks).toBe(0);
        expect(b.member!.car!.state.ghostTicks).toBe(0);
        // Nor do the snapshots call a racing car a race ghost: the
        // prediction would take every bump in the race for a pass-through
        const snap = b.transport.lastSnapshot!;
        expect(snap.self!.flags & CAR_RACE_GHOST).toBe(0);
        expect(snap.cars.find(c => c.slot === a.member!.slot)!.flags & CAR_RACE_GHOST).toBe(0);
        expect(a.transport.lastSnapshot!.self!.flags & CAR_RACE_GHOST).toBe(0);
    });
});

describe('finish, DNF and results', () => {
    it('ends DNF_AFTER_FIRST_TICKS after the first finisher with the rest DNF', () => {
        roomOptions.allowDebugPlace = true;
        const a = human('A');
        const b = human('B');
        const S = startRace([a, b]);
        tickUntil(() => room.tick === S + 10, S + 10);
        // The bots see every car in the start ghost
        expect(room.trafficStates).toHaveLength(6);
        send(a, { type: 'debugPlace', ...BEFORE_FINISH });
        const go = new Map([[a, { throttle: 255 }]]);
        tickUntil(() => room.phase === 'finished', 300, go);
        const T1 = room.tick;
        tick(1, go);
        const finishGate = a.transport.events('gate').find(e => e.id === a.id && e.passed === HILL_SPRINT.gates.length)!;
        expect(finishGate.tick).toBe(T1);
        expect(a.transport.events('finish').find(e => e.id === a.id)).toMatchObject({ pos: 1, time: finishGate.time });
        expect(room.phaseEndTick).toBe(T1 + DNF_AFTER_FIRST_TICKS);
        // After the start ghost: A in the finish drives on as a contact
        // ghost, B, still racing, is solid again
        tickUntil(() => room.tick === S + START_GHOST_TICKS + 20, START_GHOST_TICKS + 20, go);
        expect(a.member!.car!.state.ghostTicks).toBeGreaterThan(0);
        expect(b.member!.car!.state.ghostTicks).toBe(0);
        // ...and out of the bots' traffic: they drive through it like the players
        expect(room.trafficStates).not.toContain(a.member!.car!.state);
        expect(room.trafficStates).toContain(b.member!.car!.state);
        expect(room.trafficStates).toHaveLength(5);
        tickUntil(() => room.tick === T1 + DNF_AFTER_FIRST_TICKS - 1, DNF_AFTER_FIRST_TICKS, go);
        expect(room.phase).toBe('finished');
        tick(1, go);
        expect(room.phase).toBe('results');
        const results = a.transport.of('raceResults').at(-1)!;
        expect(results.entries[0]).toMatchObject({ id: a.id, pos: 1, status: 'finished', bot: false });
        expect(results.entries.at(-1)).toMatchObject({ id: b.id, status: 'dnf', finishTicks: null });
        const finished = results.entries.filter(e => e.status === 'finished');
        expect(finished.map(e => e.finishTicks)).toEqual([...finished.map(e => e.finishTicks!)].sort((x, y) => x - y));
        expect(results.entries.map(e => e.pos)).toEqual([1, 2, 3, 4, 5, 6]);
        // The bots stop in the results
        tick(240, go);
        for (const r of room.racers.filter(x => x.bot)) {
            const s = r.member!.car!.state;
            expect(Math.hypot(s.vx, s.vz), r.id).toBeLessThan(0.5);
        }
        // Finished and DNF cars are race ghosts in the snapshots
        tick();
        expect(a.transport.lastSnapshot!.self!.flags & CAR_RACE_GHOST).toBe(CAR_RACE_GHOST);
        expect(b.transport.lastSnapshot!.self!.flags & CAR_RACE_GHOST).toBe(CAR_RACE_GHOST);
    });

    it('ends as soon as every player is through, the bots still out get DNF', () => {
        roomOptions.allowDebugPlace = true;
        const a = human('A');
        const b = human('B');
        const c = human('C');
        const S = startRace([a, b, c]);
        tickUntil(() => room.tick === S + 10, S + 10);
        finishAll([a, b, c]);
        const ids = [a.id, b.id, c.id];
        const gates = a.transport.events('gate').filter(e => ids.includes(e.id) && e.passed === HILL_SPRINT.gates.length);
        expect(gates).toHaveLength(3);
        expect(room.tick).toBe(Math.max(...gates.map(e => e.tick)));
        const results = room.lastResults!;
        expect(results.slice(0, 3).map(e => e.id)).toEqual(ids);
        expect(results.slice(0, 3).map(e => e.status)).toEqual(['finished', 'finished', 'finished']);
        expect(results.slice(3).every(e => e.bot && e.status === 'dnf')).toBe(true);
        // Both finish events reach the players before the results, the final order with them
        const sent = a.transport.sent;
        const resultsAt = sent.findIndex(m => m.type === 'raceResults');
        const finishAt = (id: string) => sent.findIndex(m => m.type === 'events' && m.list.some(e => e.type === 'finish' && e.id === id));
        expect(finishAt(a.id)).toBeGreaterThanOrEqual(0);
        expect(finishAt(b.id)).toBeGreaterThanOrEqual(0);
        expect(Math.max(finishAt(a.id), finishAt(b.id))).toBeLessThan(resultsAt);
        const status = sent.slice(0, resultsAt).filter(m => m.type === 'raceStatus').at(-1);
        expect(status && status.type === 'raceStatus' && status.order.map(e => e.status)).toEqual(results.map(e => e.status));
        // The finish crossings: gate 7 of the sprint, its only lap, the lap
        // time the race time; the split against the car directly ahead (C
        // against B, not the leader A), none for A
        const [ga, gb, gc] = [a, b, c].map(p => gates.find(e => e.id === p.id)!);
        expect(ga).toMatchObject({ gate: HILL_SPRINT.gates.length - 1, lap: 1, lapTime: ga.time });
        expect(ga.gapAhead).toBeUndefined();
        expect(gb.gapAhead).toBeCloseTo(gb.time - ga.time, 9);
        expect(gb.gapAhead).toBeGreaterThan(0);
        expect(gc.gapAhead).toBeCloseTo(gc.time - gb.time, 9);
        expect(gc.time - gb.time).toBeGreaterThan(0);
    });

    it('sends the positions at 5 Hz while racing, in race order', () => {
        const a = human('A');
        const S = startRace([a]);
        a.transport.clear();
        tickUntil(() => room.tick === S + 10 * RACE_STATUS_EVERY - 1, S + 10 * RACE_STATUS_EVERY);
        const status = a.transport.of('raceStatus');
        expect(status.map(m => m.tick % RACE_STATUS_EVERY)).toEqual(status.map(() => 0));
        expect(status.length).toBeGreaterThanOrEqual(9);
        const last = status.at(-1)!;
        expect(last.order.map(e => e.id)).toEqual(room.standings().map(r => r.id));
        // The player stood at the pole: every bot drove past
        expect(last.order.at(-1)!.id).toBe(a.id);
    });
});

describe('vote and the next race', () => {
    // A race of the players, all through the finish in the order given
    function raceToResults(...players: Player[]): void {
        const S = startRace(players);
        tickUntil(() => room.tick === S + 10, S + 10);
        finishAll(players);
    }

    it('a tie goes to the next track; once all voted the lobby opens, voters ready, bots gone', () => {
        const a = human('A');
        const b = human('B');
        raceToResults(a, b);
        send(a, { type: 'raceVote', choice: 'rematch' });
        tick();
        expect(room.phase).toBe('results');
        expect(a.transport.of('raceState').at(-1)!.votes).toEqual({ rematch: 1, next: 0 });
        send(b, { type: 'raceVote', choice: 'next' });
        tick();
        expect(room.phase).toBe('lobby');
        // The track after the Ridge Climb in the rotation
        expect(room.trackId).toBe('harbor-circuit');
        expect([...room.ready].sort()).toEqual([a.id, b.id].sort());
        expect(room.members.size).toBe(2);
        expect([...room.members.values()].some(m => m.bot)).toBe(false);
        // Both on the new grid
        expect([pos(a), pos(b)].map(p => [p.x, p.z]).sort()).toEqual(HARBOR_CIRCUIT.grid.slice(0, 2).map(g => [g.x, g.z]).sort());
        const T = room.tick;
        tick(2);
        const spawns = a.transport.events('spawn').filter(e => e.tick === T);
        expect(spawns.map(e => e.grid).sort()).toEqual([0, 1]);
    });

    it('a majority for the rematch keeps the track; the winner starts on the pole', () => {
        const a = human('A');
        const b = human('B');
        // B wins, though A came first (and had the pole)
        raceToResults(b, a);
        expect(room.lastResults![0].id).toBe(b.id);
        send(a, { type: 'raceVote', choice: 'rematch' });
        send(b, { type: 'raceVote', choice: 'rematch' });
        tick();
        expect(room.phase).toBe('lobby');
        expect(room.trackId).toBe('hill-sprint');
        expect(pos(b)).toEqual({ x: HILL_SPRINT.grid[0].x, z: HILL_SPRINT.grid[0].z });
        expect(pos(a)).toEqual({ x: HILL_SPRINT.grid[1].x, z: HILL_SPRINT.grid[1].z });
    });

    it('without votes goes on to the next track after RESULTS_TICKS, nobody ready', () => {
        const a = human('A');
        const b = human('B');
        raceToResults(a, b);
        const T = room.tick;
        tickUntil(() => room.phase === 'lobby', RESULTS_TICKS + 1);
        expect(room.tick).toBe(T + RESULTS_TICKS);
        expect(room.trackId).toBe('harbor-circuit');
        expect(room.ready.size).toBe(0);
    });

    it('takes a car change during the race only in the next lobby', () => {
        const a = human('A');
        const b = human('B');
        const S = startRace([a, b]);
        tickUntil(() => room.tick === S + 5, S + 5);
        const mass = a.member!.car!.base.mass;
        send(a, { type: 'setCar', carType: 'pickup', profile: 'standard' });
        tick(200);
        expect(a.member!.car!.base.mass).toBe(mass);
        finishAll([a, b]);
        send(a, { type: 'raceVote', choice: 'next' });
        send(b, { type: 'raceVote', choice: 'next' });
        tick();
        expect(room.phase).toBe('lobby');
        expect(a.member!.car!.base.mass).toBe(2000);
        expect(b.transport.of('playerUpdated').at(-1)).toMatchObject({ id: a.id, carType: 'pickup' });
    });
});

describe('spectators and leaving', () => {
    it('lets a late joiner watch without a car and gives them a grid slot in the next lobby', () => {
        const a = human('A');
        const S = startRace([a]);
        const c = human('C');
        expect(c.room).toBe(room);
        tick(2);
        expect(c.member!.car).toBeNull();
        expect(room.racers.map(r => r.id)).not.toContain(c.id);
        expect(c.transport.lastSnapshot!.self).toBeNull();
        expect(c.transport.lastSnapshot!.cars).toHaveLength(6);
        expect(c.transport.of('roomState').at(-1)!.race).toMatchObject({ phase: 'countdown', startTick: S });
        tickUntil(() => room.tick === S + 10, S);
        finishAll([a]);
        send(a, { type: 'raceVote', choice: 'next' });
        send(c, { type: 'raceVote', choice: 'next' });
        tick();
        expect(room.phase).toBe('lobby');
        expect(c.member!.car).not.toBeNull();
    });

    it('marks a racer who leaves as left; with the last player gone the bots leave and the room closes at once', () => {
        const a = human('A');
        const b = human('B');
        const S = startRace([a, b]);
        tickUntil(() => room.tick === S + 30, S + 30);
        lobby.leave(b);
        expect(room.racer(b.id)!.progress.status).toBe('left');
        expect(room.phase).toBe('racing');
        const id = room.id;
        lobby.leave(a);
        expect(room.members.size).toBe(0);
        expect(room.size).toBe(0);
        expect(room.phase).toBe('lobby');
        expect(room.racers).toHaveLength(0);
        expect(lobby.get(id)).toBeUndefined();
    });
});

describe('wrong way and the reset', () => {
    it('flags a car driving against the line after WRONG_WAY_ENTER_TICKS as a race ghost', () => {
        roomOptions.allowDebugPlace = true;
        const a = human('A');
        const S = startRace([a]);
        tickUntil(() => room.tick === S + START_GHOST_TICKS, S + START_GHOST_TICKS);
        // On the line 250 m past the start, facing back: against the line,
        // and seconds ahead of the bots (it must not meet them head-on)
        const start = room.runtime.course.gateS[0];
        send(a, { type: 'debugPlace', ...onLine(HILL_SPRINT, start + 250, true) });
        tickUntil(() => a.transport.events('wrongWay').some(e => e.id === a.id && e.on), 200, new Map([[a, { throttle: 200 }]]));
        tick(2, new Map([[a, { throttle: 200 }]]));
        expect(a.transport.lastSnapshot!.self!.flags & CAR_RACE_GHOST).toBe(CAR_RACE_GHOST);
        expect(room.racer(a.id)!.progress.wrongWay).toBe(true);
        // The bots drive through a wrong-way car instead of evading it far ahead
        expect(room.trafficStates).not.toContain(a.member!.car!.state);
        expect(room.trafficStates).toHaveLength(5);
        // One event when it starts, not one per tick
        expect(a.transport.events('wrongWay').filter(e => e.id === a.id)).toEqual([{ type: 'wrongWay', id: a.id, on: true }]);
    });

    it('puts a reset that lands past the next gate 5 m before that gate', () => {
        roomOptions.allowDebugPlace = true;
        const a = human('A');
        const S = startRace([a], 'downtown-loop');
        tickUntil(() => room.tick === S + START_GHOST_TICKS, S + START_GHOST_TICKS);
        // Just past the start line (next gate: G1)
        const { gateS } = room.runtime.course;
        send(a, { type: 'debugPlace', ...onLine(DOWNTOWN_LOOP, gateS[0] + 5) });
        tick(3);
        expect(room.racer(a.id)!.progress.passed).toBe(1);
        // Pushed onto the line 20 m past G2: the nearest line point is past G1
        const beyond = onLine(DOWNTOWN_LOOP, gateS[2] + 20);
        placeVehicle(a.member!.car!.state, room.runtime.world, beyond.x, beyond.z, beyond.yaw);
        tick(40, new Map([[a, { buttons: BTN_RESET }]]));
        const s = a.member!.car!.state;
        // 5 m before G1 on the line, facing along it
        const before = onLine(DOWNTOWN_LOOP, gateS[1] - 5);
        expect(s.x).toBeCloseTo(before.x, 6);
        expect(s.z).toBeCloseTo(before.z, 6);
        expect(s.yaw).toBeCloseTo(before.yaw, 6);
        expect(room.racer(a.id)!.progress.passed).toBe(1);
    });
});

describe('the lag ghost in the race', () => {
    const dist = (p: { x: number; z: number }, q: { x: number; z: number }) => Math.hypot(p.x - q.x, p.z - q.z);

    it('costs a racer who leaves out every 4th input those ticks: the stop input, not the last one repeated', () => {
        const a = human('A');
        const b = human('B');
        const S = startRace([a, b]);
        const gridA = pos(a), gridB = pos(b);
        // Full throttle from the countdown on; B leaves out 25 % of the
        // ticks (more than the 20 % of the lag ghost)
        while (room.tick < S + 240) {
            const T = room.tick + 1;
            feed(room, a, { throttle: 255 });
            if (T % 4 !== 0) feed(room, b, { throttle: 255 });
            room.step(clock.now());
        }
        expect(b.member!.laggy).toBe(true);
        expect(a.member!.laggy).toBe(false);
        // Repeated, B's car would drive like A's; braking every 4th tick
        // it is left far behind
        expect(dist(pos(a), gridA)).toBeGreaterThan(40);
        expect(dist(pos(b), gridB)).toBeLessThan(0.5 * dist(pos(a), gridA));
    });

    it('takes no lag ghost from the round trip alone in the race, as it does in the lobby', () => {
        const a = human('A');
        tick();
        a.rttMs = 400;
        tick();
        expect(a.member!.laggy).toBe(true);
        a.rttMs = 50;
        tick(LAGGY_RECOVER_TICKS);
        expect(a.member!.laggy).toBe(false);
        const S = startRace([a]);
        a.rttMs = 400;
        tickUntil(() => room.tick === S + 60, S + 60, new Map([[a, { throttle: 255 }]]));
        expect(a.member!.laggy).toBe(false);
        expect(a.transport.lastSnapshot!.self!.flags & CAR_LAGGY).toBe(0);
    });
});

describe('the bots', () => {
    it('reset a bot that went round a gate to just before it, and it goes through', () => {
        const a = human('A');
        const S = startRace([a]);
        const { course, world } = room.runtime;
        const bot = room.racers.find(r => r.bot)!;
        // Past the start ghost, 5 to 15 m before its next gate
        tickUntil(() => room.tick > S + START_GHOST_TICKS && bot.progress.remaining > 5 && bot.progress.remaining < 15, 3000);
        const passed = bot.progress.passed;
        const k = nextGateIndex(course.track, passed);
        // On the line 35 m past that gate, without crossing it
        const past = pointAt(course.line, course.gateS[k] + 35, createProjection());
        placeVehicle(bot.member!.car!.state, world, past.x, past.z, Math.atan2(past.tx, past.tz));
        tick();
        expect(bot.progress.missedGate).toBe(true);
        // The reset puts it 5 m before the gate (10.3); it drives through
        tickUntil(() => bot.progress.passed > passed, 240);
        expect(bot.progress.status).toBe('racing');
    });
});
