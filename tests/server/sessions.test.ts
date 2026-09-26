import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mulberry32 } from '../../src/shared/math/rng.js';
import { placeVehicle } from '../../src/shared/sim/vehicle.js';
import { acceptHelloResult, type HandshakeContext } from '../../src/server/handshake.js';
import { mapFor } from '../../src/server/maps.js';
import { RoomManager } from '../../src/server/rooms/lobby.js';
import type { PartyRoom } from '../../src/server/rooms/PartyRoom.js';
import { TicketSigner } from '../../src/server/resumeTicket.js';
import { SessionRegistry } from '../../src/server/sessions.js';
import { ticketFor } from '../../src/server/shutdown.js';
import { CAR_IDLE } from '../../src/shared/net/codec.js';
import { CLOSE_TAKEN_OVER, GRACE_MS, RESUME_TICKET_MS } from '../../src/shared/net/constants.js';
import { PROTOCOL_VERSION } from '../../src/shared/protocol.js';
import { FakeTransport, feed, ready, steps } from './helpers.js';

// Sessions, the grace time and the resume (docs/phase-1b-design.md, 11.1),
// resume tickets over a restart (11.3).

let lobby: RoomManager;
let sessions: SessionRegistry;
let tickets: TicketSigner;
let ctx: HandshakeContext;
let wallClock: number;

beforeEach(() => {
    // Spawn points and colours are random: the same ones in every run
    vi.spyOn(Math, 'random').mockImplementation(mulberry32(1234));
    lobby = new RoomManager(mapFor(), { maxPlayersPerRoom: 32, emptyRoomTtlMs: 60_000 });
    sessions = new SessionRegistry();
    wallClock = 1_700_000_000_000;
    tickets = new TicketSigner('a test secret of some length', () => wallClock);
    ctx = { lobby, serverBuild: null, sessions, tickets };
});

afterEach(() => {
    vi.restoreAllMocks();
    for (const room of lobby.list()) room.dispose();
});

function hello(extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
        type: 'hello', protocolVersion: PROTOCOL_VERSION, build: null, connId: 'page-1',
        name: 'Ada', carType: 'jeep', profile: 'standard', room: 'party', ...extra
    });
}

function join(extra: Record<string, unknown> = {}) {
    const transport = new FakeTransport();
    const result = acceptHelloResult(transport, hello(extra), ctx)!;
    return { transport, ...result };
}

// A player past the splash screen whose car has spawned
function driving(extra: Record<string, unknown> = {}) {
    const joined = join(extra);
    ready(lobby, joined.session);
    steps(joined.session.room!, 1);
    expect(joined.session.member!.car).not.toBeNull();
    return joined;
}

function drop(transport: FakeTransport, now: number) {
    transport.close(1006);
    const session = sessions.findByToken(transport.of('welcome')[0].sessionToken)!;
    sessions.disconnect(session, now);
    return session;
}

describe('grace time and resume', () => {
    it('keeps the car as an idle ghost while the connection is gone', () => {
        const a = driving();
        const b = driving({ connId: 'page-2', name: 'Bob' });
        const room = a.session.room!;
        drop(a.transport, 0);
        // The server repeats the last input for 15 ticks, then stops the car
        steps(room, 20);
        expect(room.members.get(a.session.id)!.idle).toBe(true);
        expect(room.members.get(a.session.id)!.car!.state.ghostTicks).toBeGreaterThan(0);
        const snap = b.transport.lastSnapshot!;
        const other = snap.cars.find(car => car.slot === a.session.member!.slot)!;
        expect(other.flags & CAR_IDLE).toBe(CAR_IDLE);
        expect(sessions.inGrace).toBe(1);
    });

    it('takes the session back on the same page: same id, slot, car and score', () => {
        const a = driving();
        const room = a.session.room as PartyRoom;
        room.partyState(a.session.id)!.score = 70;
        const { slot } = a.session.member!;
        const car = a.session.member!.car;
        // On a free stretch of road, 40 m from any item: the drive picks up
        // no coin or powerup, which would change the score and the resume
        // (the spawn point alone did in about 6 % of the runs)
        placeVehicle(car!.state, room.map.simWorld, 58, 10, 0);
        for (let i = 0; i < 10; i++) {
            feed(room, a.session, { throttle: 255 });
            steps(room, 1);
        }
        drop(a.transport, 1000);
        steps(room, 30);

        const again = join({ sessionToken: a.transport.of('welcome')[0].sessionToken });
        expect(again.resumed).toBe(true);
        expect(again.session).toBe(a.session);
        expect(again.session.transport).toBe(again.transport);
        expect(again.transport.of('welcome')[0]).toEqual(expect.objectContaining({ playerId: a.session.id, resumed: true }));
        const state = again.transport.of('roomState')[0];
        expect(state.resume).toEqual({ alive: true, spawnTick: 1, powerups: [] });
        expect(again.session.member!.slot).toBe(slot);
        expect(again.session.member!.car).toBe(car);
        expect(room.partyState(a.session.id)!.score).toBe(70);
        expect(sessions.inGrace).toBe(0);
        // Its snapshots flow again, the old socket gets nothing
        const before = a.transport.snapshots.length;
        feed(room, again.session, { throttle: 255 });
        steps(room, 3);
        expect(again.transport.snapshots.length).toBeGreaterThan(0);
        expect(a.transport.snapshots.length).toBe(before);
        expect(again.transport.lastSnapshot!.self).not.toBeNull();
        // No longer idle once inputs come
        steps(room, 1);
        expect(again.session.member!.idle).toBe(false);
    });

    it('lets the grace time run out: the player leaves the room', () => {
        const a = driving();
        const b = driving({ connId: 'page-2', name: 'Bob' });
        drop(a.transport, 1000);
        expect(sessions.expire(1000 + GRACE_MS - 1)).toEqual([]);
        const gone = sessions.expire(1000 + GRACE_MS);
        expect(gone).toEqual([a.session]);
        for (const session of gone) lobby.leave(session);
        steps(b.session.room!, 3);
        expect(b.transport.of('playerLeft').map(m => m.id)).toContain(a.session.id);
        expect(lobby.playerCount()).toBe(1);
        // The token is void now: a new session
        const again = join({ sessionToken: a.transport.of('welcome')[0].sessionToken });
        expect(again.resumed).toBe(false);
        expect(again.session.id).not.toBe(a.session.id);
    });

    it('takes over from a socket of the same page that is not noticed as gone yet (4005)', () => {
        const a = driving();
        const again = join({ sessionToken: a.transport.of('welcome')[0].sessionToken });
        expect(again.resumed).toBe(true);
        expect(a.transport.closed?.code).toBe(CLOSE_TAKEN_OVER);
        expect(again.session.transport).toBe(again.transport);
    });

    it('gives a duplicated tab (same token, other page, still connected) its own session', () => {
        const a = driving();
        const copy = join({ sessionToken: a.transport.of('welcome')[0].sessionToken, connId: 'page-copy' });
        expect(copy.resumed).toBe(false);
        expect(copy.session.id).not.toBe(a.session.id);
        expect(a.transport.closed).toBeNull();
        expect(lobby.playerCount()).toBe(2);
    });

    it('brings a reloaded page back as the same player behind the splash screen, score kept', () => {
        const a = driving();
        const room = a.session.room as PartyRoom;
        room.partyState(a.session.id)!.score = 40;
        drop(a.transport, 0);
        const reloaded = join({ sessionToken: a.transport.of('welcome')[0].sessionToken, connId: 'page-reloaded' });
        expect(reloaded.resumed).toBe(true);
        expect(reloaded.session.id).toBe(a.session.id);
        const state = reloaded.transport.of('roomState')[0];
        expect(state.resume).toBeUndefined();
        const member = reloaded.session.member!;
        expect(member.ready).toBe(false);
        expect(member.car).toBeNull();
        expect((reloaded.session.room as PartyRoom).partyState(a.session.id)!.score).toBe(40);
        ready(lobby, reloaded.session);
        steps(reloaded.session.room!, 3);
        expect(reloaded.transport.events('spawn').map(e => e.id)).toContain(a.session.id);
    });

    it('takes the paint of the page over on a reload and on a resume, and shows a resumed one to the room', () => {
        const a = driving({ paint: 'sea' });
        const b = driving({ connId: 'page-2', name: 'Bob' });
        expect(a.session.color).toBe(0x5E8C7A);
        // The same page after a short drop, now in Ochre (docs/ui.md 5)
        drop(a.transport, 0);
        const resumed = join({ sessionToken: a.transport.of('welcome')[0].sessionToken, paint: 'ochre' });
        expect(resumed.resumed).toBe(true);
        expect(resumed.session.color).toBe(0xB8862F);
        expect(resumed.transport.of('welcome')[0].color).toBe(0xB8862F);
        steps(b.session.room!, 1, 60_000);
        expect(b.transport.of('playerUpdated').at(-1)).toEqual({ type: 'playerUpdated', id: a.session.id, color: 0xB8862F });
        // A reload without a wish keeps the paint
        drop(resumed.transport, 1000);
        const reloaded = join({ sessionToken: a.transport.of('welcome')[0].sessionToken, connId: 'page-reloaded' });
        expect(reloaded.session.color).toBe(0xB8862F);
        // So does one with a paint this palette does not know
        drop(reloaded.transport, 2000);
        const unknown = join({ sessionToken: a.transport.of('welcome')[0].sessionToken, connId: 'page-3', paint: 'neon' });
        expect(unknown.resumed).toBe(true);
        expect(unknown.session.color).toBe(0xB8862F);
    });

    it('never resumes a kicked session', () => {
        const a = driving();
        a.session.kicked = true;
        lobby.leave(a.session, 'kicked');
        sessions.remove(a.session);
        const again = join({ sessionToken: a.transport.of('welcome')[0].sessionToken });
        expect(again.resumed).toBe(false);
    });
});

describe('resume tickets', () => {
    it('carries colour and Party score over a restart, once', () => {
        const a = driving();
        (a.session.room as PartyRoom).partyState(a.session.id)!.score = 120;
        const ticket = ticketFor(a.session, tickets);

        // A new process: new rooms and sessions, same secret
        const fresh = new RoomManager(mapFor(), { maxPlayersPerRoom: 32, emptyRoomTtlMs: 60_000 });
        const newCtx: HandshakeContext = { lobby: fresh, serverBuild: null, sessions: new SessionRegistry(), tickets: new TicketSigner('a test secret of some length', () => wallClock) };
        const t1 = new FakeTransport();
        const back = acceptHelloResult(t1, hello({ resume: ticket, sessionToken: 'unknown-token' }), newCtx)!;
        expect(back.resumed).toBe(false);
        expect(back.session.color).toBe(a.session.color);
        expect((back.session.room as PartyRoom).partyState(back.session.id)!.score).toBe(120);
        // Used up
        const t2 = new FakeTransport();
        const twice = acceptHelloResult(t2, hello({ resume: ticket, connId: 'page-2' }), newCtx)!;
        expect((twice.session.room as PartyRoom).partyState(twice.session.id)!.score).toBe(0);
        for (const room of fresh.list()) room.dispose();
    });

    it('does not bring the Party score into Free Roam', () => {
        const a = driving();
        (a.session.room as PartyRoom).partyState(a.session.id)!.score = 50;
        const ticket = ticketFor(a.session, tickets);
        const back = join({ resume: ticket, room: 'freeroam', connId: 'page-9' });
        expect(back.session.room!.kind).toBe('freeroam');
        expect(back.session.carryScore).toBe(0);
        // Switching into the Party later starts at 0
        lobby.switch(back.session, 'party');
        expect((back.session.room as PartyRoom).partyState(back.session.id)!.score).toBe(0);
    });

    it('rejects forged, foreign and expired tickets', () => {
        const a = driving();
        const ticket = ticketFor(a.session, tickets);
        const [payload, mac] = ticket.split('.');
        const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), score: 9999 })).toString('base64url');
        expect(tickets.redeem(`${forged}.${mac}`)).toBeNull();
        expect(new TicketSigner('another secret, also long', () => wallClock).redeem(ticket)).toBeNull();
        expect(tickets.redeem('garbage')).toBeNull();
        expect(tickets.redeem('a.b.c')).toBeNull();
        wallClock += RESUME_TICKET_MS;
        expect(tickets.redeem(ticket)).toBeNull();
    });

    it('accepts a genuine ticket within its time', () => {
        const ticket = tickets.sign({ name: 'Ada', color: 0x123456, carType: 'jeep', profile: 'touch', roomKind: 'party', score: 30 });
        wallClock += RESUME_TICKET_MS - 1;
        expect(tickets.redeem(ticket)).toEqual(expect.objectContaining({ name: 'Ada', color: 0x123456, score: 30, roomKind: 'party' }));
    });
});

describe('session limits (11.7)', () => {
    it('pushes out the session that waited longest when MAX_SESSIONS is reached', () => {
        const evicted: string[] = [];
        ctx.maxSessions = 3;
        ctx.evict = session => {
            evicted.push(session.name);
            lobby.leave(session);
            sessions.remove(session);
        };
        const a = driving({ name: 'Ann', connId: 'a' });
        const b = driving({ name: 'Ben', connId: 'b' });
        driving({ name: 'Cy', connId: 'c' });
        drop(b.transport, 2000);
        drop(a.transport, 5000);
        // Full: the fourth takes Ben's place (gone since 2000), Ann waits on
        const d = join({ name: 'Dee', connId: 'd' });
        expect(d.session).toBeTruthy();
        expect(evicted).toEqual(['Ben']);
        expect(sessions.size).toBe(3);
        expect(lobby.playerCount()).toBe(3);
        // Ann can still come back
        expect(join({ sessionToken: a.transport.of('welcome')[0].sessionToken, connId: 'a' }).resumed).toBe(true);
        // Everyone connected: a new player is turned away as full
        const transport = new FakeTransport();
        expect(acceptHelloResult(transport, hello({ name: 'Eve', connId: 'e' }), ctx)).toBeNull();
        expect(transport.of('reject')[0]).toEqual(expect.objectContaining({ reason: 'full' }));
        expect(sessions.size).toBe(3);
    });

    it('turns a new session away when its address is over budget, a resume still works', () => {
        const a = driving();
        drop(a.transport, 1000);
        ctx.admitNewSession = () => false;
        const transport = new FakeTransport();
        expect(acceptHelloResult(transport, hello({ connId: 'other' }), ctx)).toBeNull();
        expect(transport.of('reject')[0]).toEqual(expect.objectContaining({ reason: 'full' }));
        expect(join({ sessionToken: a.transport.of('welcome')[0].sessionToken }).resumed).toBe(true);
    });
});
