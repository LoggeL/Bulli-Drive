import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleClientMessage } from '../../src/server/dispatch.js';
import { mapFor } from '../../src/server/maps.js';
import { RoomManager } from '../../src/server/rooms/lobby.js';
import type { Room } from '../../src/server/rooms/Room.js';
import type { Session } from '../../src/server/session.js';
import { mulberry32 } from '../../src/shared/math/rng.js';
import { TICK_MS } from '../../src/shared/net/constants.js';
import { placeVehicle } from '../../src/shared/sim/vehicle.js';
import { fakeClock, fakeSession, feed, ready, steps, type FakeTransport } from './helpers.js';

// Room rules shared by both room kinds (src/server/rooms/Room.ts,
// docs/phase-1b-design.md 5): member order, idle kick, contact events,
// honk limit, the tick clock and the byte count behind /healthz.

type TestSession = Session & { transport: FakeTransport };

let clock: ReturnType<typeof fakeClock>;
let lobby: RoomManager;

beforeEach(() => {
    // Spawn points are random: the same ones in every run
    vi.spyOn(Math, 'random').mockImplementation(mulberry32(99));
    clock = fakeClock();
    lobby = new RoomManager(mapFor(), { maxPlayersPerRoom: 32, emptyRoomTtlMs: 60_000, now: clock.now });
});

afterEach(() => {
    for (const room of lobby.list()) room.dispose();
    vi.restoreAllMocks();
});

function driver(kind: 'party' | 'freeroam' = 'freeroam'): TestSession {
    const session = fakeSession();
    lobby.join(session, kind);
    ready(lobby, session);
    steps(session.room!, 1);
    session.member!.car!.state.ghostTicks = 0;
    return session;
}

function put(session: Session, x: number, z: number, yaw = 0, speed = 0): void {
    const s = session.member!.car!.state;
    placeVehicle(s, session.room!.map.simWorld, x, z, yaw);
    s.vx = Math.sin(yaw) * speed;
    s.vz = Math.cos(yaw) * speed;
}

describe('member order', () => {
    it('keeps the members in id order, whatever order they joined in', () => {
        const [a, b, c] = [fakeSession(), fakeSession(), fakeSession()];
        for (const s of [c, a, b]) lobby.join(s, 'freeroam');
        const room = a.room!;
        expect(room.orderedMembers.map(m => m.id)).toEqual([a.id, b.id, c.id]);
        const state = b.transport.of('roomState').at(-1)!;
        expect(state.members.map(m => m.id)).toEqual([a.id, b.id, c.id]);
        lobby.leave(a);
        expect(room.orderedMembers.map(m => m.id)).toEqual([b.id, c.id]);
    });
});

describe('idle kick', () => {
    it('kicks a member idle for more than 10 minutes, checked once a second', () => {
        const kicked: string[] = [];
        lobby.onIdleKick = session => kicked.push(session.id);
        const alice = driver();
        const room = alice.room!;
        // The tab goes to the background: idle from the next tick, at 0 ms
        handleClientMessage(lobby, alice, { type: 'visibility', hidden: true }, 0);
        room.step(0);
        expect(alice.member!.idle).toBe(true);
        // Up to the tick before the next full second (T % 60 = 59)
        while (room.tick % 60 !== 59) room.step(0);
        // Exactly 10 minutes: not yet
        room.step(600_000);
        expect(kicked).toEqual([]);
        // Past 10 minutes, but between the once-a-second checks
        for (let i = 0; i < 59; i++) room.step(600_001);
        expect(kicked).toEqual([]);
        room.step(600_001);
        expect(kicked).toEqual([alice.id]);
    });

    it('never kicks a member that is not idle', () => {
        const kicked: string[] = [];
        lobby.onIdleKick = session => kicked.push(session.id);
        const alice = driver();
        const room = alice.room!;
        for (let i = 0; i < 180; i++) {
            feed(room, alice, {});
            room.step(10_000_000);
        }
        expect(alice.member!.idle).toBe(false);
        expect(kicked).toEqual([]);
    });
});

describe('contact events', () => {
    // Bob drives into Alice (the lower id) at 20 m/s on a free road
    function bump(): { alice: TestSession; bob: TestSession; near: TestSession; far: TestSession; room: Room } {
        const alice = driver(), bob = driver(), near = driver(), far = driver();
        const room = alice.room!;
        put(alice, 58, -74);
        put(bob, 58, -80, 0, 20);
        put(near, -46, -46);   // about 107 m away
        put(far, 110, 110);    // about 191 m away
        for (let i = 0; i < 30; i++) {
            for (const s of [alice, bob, near, far]) feed(room, s, {});
            room.step(0);
        }
        return { alice, bob, near, far, room };
    }

    it('names the pair in id order, whoever hit whom, with dv in cm/s', () => {
        const { alice, bob } = bump();
        const contacts = bob.transport.events('contact');
        expect(contacts.length).toBeGreaterThanOrEqual(1);
        expect(contacts[0]).toEqual(expect.objectContaining({ a: alice.id, b: bob.id }));
        expect(contacts[0].dv).toBeGreaterThanOrEqual(3);
        expect(Math.round(contacts[0].dv * 100)).toBe(contacts[0].dv * 100);
        // Both cars feel the same bump: one event per pair, not one per car
        expect(new Set(contacts.map(c => `${c.a}|${c.b}`)).size).toBe(1);
        const ticks = bob.transport.of('events').filter(m => m.list.some(e => e.type === 'contact')).map(m => m.tick);
        expect(ticks.length).toBe(contacts.length);
    });

    it('reaches the members within 150 m only', () => {
        const { alice, near, far } = bump();
        expect(alice.transport.events('contact').length).toBeGreaterThanOrEqual(1);
        expect(near.transport.events('contact')).toEqual(alice.transport.events('contact'));
        expect(far.transport.events('contact')).toEqual([]);
    });
});

describe('honking', () => {
    it('lets a member honk at most every 300 ms, and not before the splash screen ends', () => {
        const alice = driver(), bob = driver();
        const waiting = fakeSession();
        lobby.join(waiting, 'freeroam');
        const room = alice.room!;
        const honk = (s: Session) => handleClientMessage(lobby, s, { type: 'honk' }, clock.now());
        const flush = () => { for (let i = 0; i < room.snapshotEvery; i++) room.step(0); };
        honk(alice);
        clock.advance(299);
        honk(alice);
        honk(waiting);
        flush();
        expect(bob.transport.events('honk')).toEqual([{ type: 'honk', id: alice.id }]);
        clock.advance(1);
        honk(alice);
        flush();
        expect(bob.transport.events('honk')).toHaveLength(2);
    });
});

describe('the tick clock for pongs', () => {
    it('gives the tick and how far the next one has come, 0 to 0.999', () => {
        const alice = driver();
        const room = alice.room!;
        expect(room.clockAt(5000).tick).toBe(room.tick);
        room.step(1000);
        expect(room.clockAt(1000 + TICK_MS / 2).tick).toBe(room.tick);
        expect(room.clockAt(1000 + TICK_MS / 2).sub).toBeCloseTo(0.5, 9);
        expect(room.clockAt(1000 + 5 * TICK_MS).sub).toBe(0.999);
        expect(room.clockAt(900).sub).toBe(0);
    });

    it('says 0 before the first step', () => {
        const session = fakeSession();
        lobby.join(session, 'freeroam');
        expect(session.room!.clockAt(123_456)).toEqual({ tick: 0, sub: 0 });
    });
});

describe('bytes out', () => {
    it('counts every byte the room sends: snapshots, events and scoreboards', () => {
        const alice = driver('party'), bob = driver('party');
        const room = alice.room!;
        const before = room.bytesOut;
        const sessionBytes = () => alice.bytesOut + bob.bytesOut;
        const sessionsBefore = sessionBytes();
        handleClientMessage(lobby, alice, { type: 'honk' }, clock.now());
        for (let i = 0; i < 60; i++) {
            feed(room, alice, { throttle: 255 });
            feed(room, bob, {});
            room.step(0);
        }
        const sent = sessionBytes() - sessionsBefore;
        expect(alice.transport.snapshots.length).toBeGreaterThan(0);
        expect(sent).toBeGreaterThan(0);
        expect(room.bytesOut - before).toBe(sent);
    });
});

describe('resume state', () => {
    it('says whether the car is in the sim and when it spawned', () => {
        const waiting = fakeSession();
        lobby.join(waiting, 'freeroam');
        const room = waiting.room!;
        expect(room.resumeState(waiting.member!)).toEqual({ alive: false, spawnTick: -1, powerups: [] });
        ready(lobby, waiting);
        room.step(0);
        expect(room.resumeState(waiting.member!)).toEqual({ alive: true, spawnTick: room.tick, powerups: [] });
    });
});
