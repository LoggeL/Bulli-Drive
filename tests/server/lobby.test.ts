import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleClientMessage } from '../../src/server/dispatch.js';
import { mapFor } from '../../src/server/maps.js';
import { RoomManager } from '../../src/server/rooms/lobby.js';
import { PartyRoom } from '../../src/server/rooms/PartyRoom.js';
import type { RaceRoom } from '../../src/server/rooms/RaceRoom.js';
import { SLOT_REUSE_DELAY_MS } from '../../src/server/rooms/Room.js';
import { fakeClock, fakeSession, ready, steps } from './helpers.js';

// Rooms, instances, joining, leaving and switching
// (docs/phase-1b-design.md, 2.3 and 15.1).

let clock: ReturnType<typeof fakeClock>;
let lobby: RoomManager;

function makeLobby(maxPlayersPerRoom = 32) {
    return new RoomManager(mapFor(), { maxPlayersPerRoom, emptyRoomTtlMs: 60_000, now: clock.now });
}

beforeEach(() => {
    clock = fakeClock();
    lobby = makeLobby();
});

afterEach(() => {
    for (const room of lobby.list()) room.dispose();
});

describe('map data', () => {
    it('is built once and shared by every room', () => {
        expect(mapFor()).toBe(mapFor());
        const party2 = new PartyRoom(2, mapFor(), clock.now);
        expect(party2.map).toBe(lobby.get('party-1')!.map);
    });

    it('is Bulli Bay, the map of map.json, with the Party\'s fixed items from pois.json', () => {
        const map = mapFor();
        expect(map.mapId).toBe('bulli-bay');
        expect(map.mapVersion).toBe(map.sources.map.mapVersion);
        // The arena's, then the harbour yards' round it
        const { arena, party } = map.sources.pois;
        expect(map.items.coins.map(c => [c.x, c.z])).toEqual([...arena.coins, ...party!.coins]);
        expect(map.items.powerups.map(p => [p.x, p.z])).toEqual([...arena.powerups, ...party!.powerups]);
    });

    it('gives every Party room its own items and never touches the map', () => {
        const party1 = lobby.get('party-1') as PartyRoom;
        const party2 = new PartyRoom(2, mapFor(), clock.now);
        party1.coins[0].collected = true;
        party1.powerups[3].collected = true;
        expect(party2.coins[0].collected).toBe(false);
        expect(party2.powerups[3].collected).toBe(false);
        expect(mapFor().items.coins.some(c => c.collected) || mapFor().items.powerups.some(p => p.collected)).toBe(false);
        expect(party2.coins).toHaveLength(30 + 21);
        expect(party2.powerups).toHaveLength(25 + 8);
        party2.dispose();
    });
});

describe('instances', () => {
    it('always has party-1 and puts new players there', () => {
        expect(lobby.list().map(r => r.id)).toEqual(['party-1']);
        const session = fakeSession();
        lobby.join(session, 'party');
        expect(session.room?.id).toBe('party-1');
        expect(session.member?.slot).toBe(0);
    });

    it('opens party-2 for the 33rd player', () => {
        const sessions = Array.from({ length: 33 }, () => fakeSession());
        for (const session of sessions) lobby.join(session, 'party');
        expect(sessions.slice(0, 32).every(s => s.room?.id === 'party-1')).toBe(true);
        expect(sessions[32].room?.id).toBe('party-2');
        expect(lobby.get('party-1')!.size).toBe(32);
        expect(lobby.playerCount()).toBe(33);
    });

    it('fills the fullest room that has space, the lower number on a tie', () => {
        lobby = makeLobby(2);
        const a = fakeSession(), b = fakeSession(), c = fakeSession(), d = fakeSession();
        lobby.join(a, 'party');
        lobby.join(b, 'party');
        lobby.join(c, 'party');          // party-1 full -> party-2
        expect(c.room?.id).toBe('party-2');
        lobby.leave(a);                  // party-1: 1, party-2: 1
        lobby.join(d, 'party');
        expect(d.room?.id).toBe('party-1');
    });

    it('prefers the fuller room over the lower number, and only rooms of the kind asked for', () => {
        lobby = makeLobby(3);
        const [a, b, c, d, e, f, g] = Array.from({ length: 7 }, () => fakeSession());
        for (const s of [a, b, c, d, e]) lobby.join(s, 'party');   // party-1: 3, party-2: 2
        expect(e.room?.id).toBe('party-2');
        lobby.leave(a);
        lobby.leave(b);                                              // party-1: 1, party-2: 2
        lobby.join(f, 'party');
        expect(f.room?.id).toBe('party-2');
        // A fuller room of the other kind does not count
        lobby.join(g, 'freeroam');
        expect(g.room?.id).toBe('freeroam-1');
        expect(() => lobby.join(g, 'party')).toThrow();
    });

    it('opens freeroam-1 on demand and closes it 60 s after the last player left', () => {
        const session = fakeSession();
        lobby.join(session, 'freeroam');
        expect(session.room?.id).toBe('freeroam-1');
        lobby.leave(session);
        expect(session.room).toBeNull();

        clock.advance(59_000);
        lobby.sweep();
        expect(lobby.get('freeroam-1')).toBeDefined();
        clock.advance(1_000);
        lobby.sweep();
        expect(lobby.get('freeroam-1')).toBeUndefined();
        // party-1 stays, even empty
        clock.advance(120_000);
        lobby.sweep();
        expect(lobby.get('party-1')).toBeDefined();
    });

    it('keeps a room open while someone is in it', () => {
        const session = fakeSession();
        lobby.join(session, 'freeroam');
        clock.advance(600_000);
        lobby.sweep();
        expect(lobby.get('freeroam-1')?.size).toBe(1);
    });

    it('hands a slot out again only after the reuse delay', () => {
        const a = fakeSession(), b = fakeSession(), c = fakeSession();
        lobby.join(a, 'party');
        lobby.join(b, 'party');
        expect([a.member!.slot, b.member!.slot]).toEqual([0, 1]);
        lobby.leave(a);
        lobby.join(c, 'party');
        expect(c.member!.slot).toBe(2);
        lobby.leave(c);
        clock.advance(SLOT_REUSE_DELAY_MS);
        const d = fakeSession();
        lobby.join(d, 'party');
        expect(d.member!.slot).toBe(0);
    });

    it('ticks only rooms with members, in id order', () => {
        const a = fakeSession();
        lobby.join(a, 'freeroam');
        lobby.stepAll(0);
        lobby.stepAll(0);
        expect(lobby.get('freeroam-1')!.tick).toBe(2);
        expect(lobby.get('party-1')!.tick).toBe(0);
        // A room opened later is ticked too, and the order is by id:
        // freeroam-1, party-1, party-2
        for (const room of lobby.list()) room.dispose();
        lobby = makeLobby(1);
        const [p1, p2, f1] = [fakeSession(), fakeSession(), fakeSession()];
        lobby.join(p1, 'party');
        lobby.stepAll(0);
        lobby.join(p2, 'party');
        lobby.join(f1, 'freeroam');
        const order: string[] = [];
        for (const room of lobby.list()) {
            const step = room.step.bind(room);
            room.step = (nowMs?: number) => { order.push(room.id); step(nowMs); };
        }
        lobby.stepAll(0);
        expect(order).toEqual(['freeroam-1', 'party-1', 'party-2']);
    });
});

describe('joining', () => {
    it('sends the room state: the map by ID, version and hash, members with slots, items', () => {
        const alice = fakeSession('Alice');
        lobby.join(alice, 'party');
        const [state] = alice.transport.of('roomState');
        const map = mapFor();
        expect(state.room).toEqual({ id: 'party-1', kind: 'party', index: 1 });
        expect(state.world).toEqual({ mapId: 'bulli-bay', mapVersion: map.mapVersion, worldHash: map.worldHash });
        expect(state.members).toEqual([expect.objectContaining({ id: alice.id, slot: 0, name: 'Alice', ready: false })]);
        expect(state.items!.coins).toHaveLength(30 + 21);
        expect(state.items!.powerups).toHaveLength(25 + 8);
        expect(state.health[alice.id]).toBe(100);
        // The world itself is not sent (the client builds it from the same files)
        expect(JSON.stringify(state).length).toBeLessThan(4000);
    });

    it('spawns the car at the tick after ready and announces it', () => {
        const alice = fakeSession('Alice'), bob = fakeSession('Bob');
        lobby.join(alice, 'party');
        lobby.join(bob, 'party');
        ready(lobby, bob);
        bob.transport.clear();
        ready(lobby, alice);
        expect(bob.transport.of('playerJoined')).toEqual([{ type: 'playerJoined', member: expect.objectContaining({ id: alice.id, slot: 0, ready: true }) }]);
        const room = alice.room!;
        steps(room, 3);
        const spawn = bob.transport.events('spawn').find(e => e.id === alice.id)!;
        expect(spawn.tick).toBe(1);
        expect(alice.member!.car!.state.x).toBe(spawn.x);
        expect(alice.member!.car!.state.z).toBe(spawn.z);
        // The snapshot has Alice's car for Bob and her own self block for her
        expect(bob.transport.lastSnapshot!.cars.map(c => c.slot)).toContain(0);
        expect(alice.transport.lastSnapshot!.self!.slot).toBe(0);
    });
});

describe('leaving', () => {
    it('tells the room and drops the car from the scoreboard', () => {
        const alice = fakeSession('Alice'), bob = fakeSession('Bob');
        lobby.join(alice, 'party');
        lobby.join(bob, 'party');
        ready(lobby, alice);
        ready(lobby, bob);
        const room = bob.room!;
        steps(room, 3);
        bob.transport.clear();
        lobby.leave(alice);
        expect(bob.transport.of('playerLeft')).toEqual([{ type: 'playerLeft', id: alice.id, reason: 'disconnect' }]);
        steps(room, 3);
        expect(bob.transport.of('scoreboard').at(-1)!.scoreboard.map(e => e.name)).toEqual(['Bob']);
        expect(bob.transport.lastSnapshot!.cars).toEqual([]);
    });

    it('announces nobody who never got past the splash screen', () => {
        const alice = fakeSession(), bob = fakeSession();
        lobby.join(alice, 'party');
        lobby.join(bob, 'party');
        ready(lobby, bob);
        bob.transport.clear();
        lobby.leave(alice);
        expect(bob.transport.sent).toEqual([]);
    });
});

describe('a new page of the same session (rejoin)', () => {
    it('keeps the Party score from Party to Party only', () => {
        const alice = fakeSession('Alice'), bob = fakeSession('Bob');
        lobby.join(alice, 'party');
        lobby.join(bob, 'party');
        ready(lobby, alice);
        ready(lobby, bob);
        (lobby.get('party-1') as PartyRoom).partyState(alice.id)!.score = 70;
        bob.transport.clear();
        lobby.rejoin(alice, 'party');
        // The old membership left as a disconnect, the new one waits behind the splash screen
        expect(bob.transport.of('playerLeft')).toEqual([{ type: 'playerLeft', id: alice.id, reason: 'disconnect' }]);
        expect(alice.member!.ready).toBe(false);
        expect((lobby.get('party-1') as PartyRoom).partyState(alice.id)!.score).toBe(70);

        (lobby.get('party-1') as PartyRoom).partyState(alice.id)!.score = 50;
        lobby.rejoin(alice, 'freeroam');
        expect(alice.room!.id).toBe('freeroam-1');
        expect(alice.carryScore).toBe(0);
        lobby.rejoin(alice, 'party');
        expect((lobby.get('party-1') as PartyRoom).partyState(alice.id)!.score).toBe(0);
    });

    it('joins a room when the session had none', () => {
        const alice = fakeSession();
        lobby.rejoin(alice, 'freeroam');
        expect(alice.room!.id).toBe('freeroam-1');
        const bob = fakeSession();
        expect(lobby.switch(bob, 'freeroam')).toBe(bob.member);
        expect(bob.room!.id).toBe('freeroam-1');
    });
});

describe('switching rooms', () => {
    it('moves the player with joinRoom and keeps name, colour and car', () => {
        const alice = fakeSession('Alice'), bob = fakeSession('Bob'), carol = fakeSession('Carol');
        lobby.join(alice, 'party');
        lobby.join(bob, 'party');
        lobby.join(carol, 'freeroam');
        for (const s of [alice, bob, carol]) ready(lobby, s);
        handleClientMessage(lobby, alice, { type: 'setCar', carType: 'jeep', profile: 'touch' }, clock.now());
        (lobby.get('party-1') as PartyRoom).partyState(alice.id)!.score = 70;
        for (const s of [alice, bob, carol]) s.transport.clear();

        handleClientMessage(lobby, alice, { type: 'joinRoom', kind: 'freeroam' }, clock.now());

        expect(alice.room?.id).toBe('freeroam-1');
        expect(alice.member?.ready).toBe(true);
        expect([alice.name, alice.carType, alice.profile]).toEqual(['Alice', 'jeep', 'touch']);
        const [state] = alice.transport.of('roomState');
        expect(state.room).toEqual({ id: 'freeroam-1', kind: 'freeroam', index: 1 });
        expect(state.members.map(m => m.id).sort()).toEqual([alice.id, carol.id].sort());
        expect([state.items, state.scoreboard]).toEqual([null, []]);

        // The old room lost her, the new one sees her arrive and spawn
        expect(bob.transport.of('playerLeft')).toEqual([{ type: 'playerLeft', id: alice.id, reason: 'switch' }]);
        expect(carol.transport.of('playerJoined')).toEqual([
            { type: 'playerJoined', member: expect.objectContaining({ id: alice.id, name: 'Alice', carType: 'jeep', profile: 'touch' }) }
        ]);
        expect(lobby.get('party-1')!.members.has(alice.id)).toBe(false);
        steps(alice.room!, 3);
        expect(carol.transport.events('spawn').map(e => e.id)).toContain(alice.id);
        expect(alice.member!.car!.base.mass).toBe(1750);
    });

    it('drops the Party score and starts fresh on the way back', () => {
        const alice = fakeSession('Alice');
        lobby.join(alice, 'party');
        ready(lobby, alice);
        const party = lobby.get('party-1') as PartyRoom;
        party.partyState(alice.id)!.score = 120;
        handleClientMessage(lobby, alice, { type: 'joinRoom', kind: 'freeroam' }, clock.now());
        expect(party.partyState(alice.id)).toBeUndefined();
        clock.advance(2_000);
        handleClientMessage(lobby, alice, { type: 'joinRoom', kind: 'party' }, clock.now() + 2_000);
        expect(alice.room?.id).toBe('party-1');
        expect(party.partyState(alice.id)!.score).toBe(0);
        const state = alice.transport.of('roomState').at(-1)!;
        expect(state.items!.powerups).toHaveLength(25 + 8);
        expect(state.items!.coins).toHaveLength(30 + 21);
        expect(state.scoreboard.map(e => e.name)).toEqual(['Alice']);
    });

    it('allows one switch per two seconds and ignores a switch to the same kind', () => {
        const alice = fakeSession();
        lobby.join(alice, 'party');
        alice.transport.clear();
        handleClientMessage(lobby, alice, { type: 'joinRoom', kind: 'party' }, 10_000);
        expect(alice.transport.of('roomState')).toEqual([]);
        handleClientMessage(lobby, alice, { type: 'joinRoom', kind: 'freeroam' }, 12_000);
        handleClientMessage(lobby, alice, { type: 'joinRoom', kind: 'party' }, 13_000);
        expect(alice.room?.id).toBe('freeroam-1');
        handleClientMessage(lobby, alice, { type: 'joinRoom', kind: 'party' }, 14_000);
        expect(alice.room?.id).toBe('party-1');
    });

    it('switches before the splash screen without showing the car', () => {
        const alice = fakeSession(), bob = fakeSession();
        lobby.join(bob, 'freeroam');
        ready(lobby, bob);
        lobby.join(alice, 'party');
        bob.transport.clear();
        handleClientMessage(lobby, alice, { type: 'joinRoom', kind: 'freeroam' }, clock.now());
        expect(alice.member?.ready).toBe(false);
        expect(bob.transport.sent).toEqual([]);
        ready(lobby, alice);
        expect(bob.transport.of('playerJoined').map(m => m.member.id)).toEqual([alice.id]);
    });
});

describe('Free Roam', () => {
    it('ignores shots and has no items and no scoreboard', () => {
        const alice = fakeSession(), bob = fakeSession();
        lobby.join(alice, 'freeroam');
        lobby.join(bob, 'freeroam');
        ready(lobby, alice);
        ready(lobby, bob);
        const room = alice.room!;
        steps(room, 3);
        bob.transport.clear();
        handleClientMessage(lobby, alice, { type: 'shoot', targetId: bob.id }, clock.now());
        steps(room, 3);
        expect(bob.transport.of('events')).toEqual([]);
        expect(room.scoreboard()).toEqual([]);
        expect(room.roomStateItems()).toBeNull();
    });

    it('relays honking to the others only', () => {
        const alice = fakeSession(), bob = fakeSession();
        lobby.join(alice, 'freeroam');
        lobby.join(bob, 'freeroam');
        ready(lobby, alice);
        ready(lobby, bob);
        const room = alice.room!;
        steps(room, 3);
        alice.transport.clear();
        bob.transport.clear();
        handleClientMessage(lobby, alice, { type: 'honk' }, clock.now());
        steps(room, 3);
        expect(bob.transport.events('honk')).toEqual([{ type: 'honk', id: alice.id }]);
        expect(alice.transport.events('honk')).toEqual([]);
    });
});

describe('race and time trial instances (docs/phase-2-design.md, 6.5)', () => {
    const phaseOf = (room: unknown) => (room as RaceRoom).phase;

    it('puts a racer into a room in its lobby before a running one, the fuller lobby first', () => {
        const [a, b, c, d] = Array.from({ length: 4 }, () => fakeSession());
        lobby.join(a, 'race');
        const first = a.room as RaceRoom;
        expect(first.id).toBe('race-1');
        ready(lobby, a);
        steps(first, 1);
        handleClientMessage(lobby, a, { type: 'raceReady', ready: true }, clock.now());
        steps(first, 62);
        expect(phaseOf(first)).toBe('countdown');
        // race-1 runs: a new player watches it rather than open another
        lobby.join(b, 'race');
        expect(b.room).toBe(first);
        // A fresh one on request ("START OWN RACE"), which then takes the next racer
        lobby.join(c, 'race', { fresh: true, track: 'hill-sprint' });
        expect(c.room!.id).toBe('race-2');
        expect((c.room as RaceRoom).trackId).toBe('hill-sprint');
        lobby.join(d, 'race');
        expect(d.room!.id).toBe('race-2');
    });

    it('counts players only: bots neither fill a room nor keep it open', () => {
        const a = fakeSession();
        lobby.join(a, 'race');
        const room = a.room as RaceRoom;
        ready(lobby, a);
        steps(room, 1);
        handleClientMessage(lobby, a, { type: 'raceReady', ready: true }, clock.now());
        steps(room, 62);
        expect(room.members.size).toBe(6);
        expect(room.size).toBe(1);
        expect(lobby.playerCount()).toBe(1);
        lobby.leave(a);
        expect(room.members.size).toBe(0);
        expect(lobby.get('race-1')).toBeUndefined();
    });

    it('closes a race or time trial instance at once when its last player leaves, so switching opens no rooms', () => {
        const a = fakeSession(), b = fakeSession();
        lobby.join(a, 'party');
        // 20 switches, one every 2 s at most (dispatch): one room of theirs at a time
        for (let i = 0; i < 20; i++) {
            lobby.switch(a, i % 2 ? 'timetrial' : 'race', { fresh: true });
            expect(lobby.list().map(r => r.id).sort()).toEqual(['party-1', a.room!.id].sort());
        }
        // A room somebody is still in stays
        lobby.switch(a, 'race', { fresh: true });
        const shared = a.room!;
        lobby.join(b, 'race');
        expect(b.room).toBe(shared);
        lobby.switch(a, 'party');
        expect(lobby.get(shared.id)).toBe(shared);
        lobby.leave(b);
        expect(lobby.get(shared.id)).toBeUndefined();
        // Free Roam keeps its time to live
        lobby.switch(a, 'freeroam');
        lobby.switch(a, 'party');
        expect(lobby.get('freeroam-1')).toBeDefined();
    });

    it('opens a new private time trial for everyone, and a switch with fresh even within the kind', () => {
        const a = fakeSession(), b = fakeSession();
        lobby.join(a, 'timetrial', { track: 'hill-sprint' });
        lobby.join(b, 'timetrial');
        expect(a.room!.id).toBe('timetrial-1');
        expect(b.room!.id).toBe('timetrial-2');
        expect((a.room as RaceRoom).trackId).toBe('hill-sprint');
        expect((b.room as RaceRoom).trackId).toBe('downtown-loop');
        expect(lobby.switch(a, 'timetrial')).toBeNull();
        expect(a.room!.id).toBe('timetrial-1');
        const moved = lobby.switch(a, 'race', { fresh: true });
        expect(moved!.session.room!.id).toBe('race-1');
        expect(lobby.switch(a, 'race', { fresh: true })!.session.room!.id).toBe('race-2');
    });

    it('limits a race room to 16 players', () => {
        const sessions = Array.from({ length: 17 }, () => fakeSession());
        for (const s of sessions) lobby.join(s, 'race');
        expect(sessions.slice(0, 16).every(s => s.room!.id === 'race-1')).toBe(true);
        expect(sessions[16].room!.id).toBe('race-2');
    });

    it('takes joinRoom with fresh and a track from the client', () => {
        const a = fakeSession();
        lobby.join(a, 'party');
        expect(handleClientMessage(lobby, a, { type: 'joinRoom', kind: 'race', fresh: true, track: 'hill-sprint' }, clock.now())).toBe('ok');
        expect(a.room!.kind).toBe('race');
        expect((a.room as RaceRoom).trackId).toBe('hill-sprint');
    });
});
