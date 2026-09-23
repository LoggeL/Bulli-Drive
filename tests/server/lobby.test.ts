import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleClientMessage } from '../../src/server/dispatch.js';
import { mapFor } from '../../src/server/maps.js';
import { RoomManager } from '../../src/server/rooms/lobby.js';
import { PartyRoom } from '../../src/server/rooms/PartyRoom.js';
import { SLOT_REUSE_DELAY_MS } from '../../src/server/rooms/Room.js';
import { generateWorld } from '../../src/shared/world/worldGen.js';
import { sha256, stableStringify } from '../helpers.js';
import { fakeClock, fakeSession } from './helpers.js';

// Rooms, instances, joining, leaving and switching
// (docs/phase-1b-design.md, 2.3 and 15.1).

let clock: ReturnType<typeof fakeClock>;
let lobby: RoomManager;

function makeLobby(maxPlayersPerRoom = 32) {
    return new RoomManager(mapFor(), { maxPlayersPerRoom, emptyRoomTtlMs: 60_000, now: clock.now });
}

function ready(session: ReturnType<typeof fakeSession>) {
    handleClientMessage(lobby, session, { type: 'playerReady' }, clock.now());
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

    it('holds the golden world the server always generated', () => {
        const map = mapFor();
        expect(sha256(stableStringify(map.world))).toBe('e2255cf50f1dbf97a3ecc33e9a47e1eaaddfbf5b6ff7590293080627723cbe20');
        expect(stableStringify(map.world)).toBe(stableStringify(generateWorld()));
    });

    it('gives every Party room its own items and never touches the map', () => {
        const party1 = lobby.get('party-1') as PartyRoom;
        const party2 = new PartyRoom(2, mapFor(), clock.now);
        party1.coins[0].collected = true;
        party1.powerups[3].collected = true;
        expect(party2.coins[0].collected).toBe(false);
        expect(party2.powerups[3].collected).toBe(false);
        expect(mapFor().world.coins.some(c => c.collected) || mapFor().world.powerups.some(p => p.collected)).toBe(false);
        expect(party2.coins).toHaveLength(30);
        expect(party2.powerups).toHaveLength(25);
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
});

describe('leaving', () => {
    it('tells the room and drops the car from the scoreboard', () => {
        const alice = fakeSession('Alice'), bob = fakeSession('Bob');
        lobby.join(alice, 'party');
        lobby.join(bob, 'party');
        ready(alice);
        ready(bob);
        bob.transport.clear();
        lobby.leave(alice);
        expect(bob.transport.of('removePlayer')).toEqual([{ type: 'removePlayer', id: alice.id }]);
        expect(bob.transport.of('scoreboard').at(-1)!.scoreboard.map(e => e.name)).toEqual(['Bob']);
    });

    it('announces nobody who never got past the splash screen', () => {
        const alice = fakeSession(), bob = fakeSession();
        lobby.join(alice, 'party');
        lobby.join(bob, 'party');
        ready(bob);
        bob.transport.clear();
        lobby.leave(alice);
        expect(bob.transport.sent).toEqual([]);
    });
});

describe('switching rooms', () => {
    it('moves the player with joinRoom and keeps name, colour and car', () => {
        const alice = fakeSession('Alice'), bob = fakeSession('Bob'), carol = fakeSession('Carol');
        lobby.join(alice, 'party');
        lobby.join(bob, 'party');
        lobby.join(carol, 'freeroam');
        for (const s of [alice, bob, carol]) ready(s);
        handleClientMessage(lobby, alice, { type: 'setCarType', carType: 'jeep' }, clock.now());
        (lobby.get('party-1') as PartyRoom).partyState(alice.id)!.score = 70;
        bob.transport.clear();
        carol.transport.clear();
        alice.transport.clear();

        handleClientMessage(lobby, alice, { type: 'joinRoom', kind: 'freeroam' }, clock.now());

        expect(alice.room?.id).toBe('freeroam-1');
        expect(alice.member?.ready).toBe(true);
        expect([alice.name, alice.carType]).toEqual(['Alice', 'jeep']);
        const joined = alice.transport.of('roomJoined');
        expect(joined).toHaveLength(1);
        expect(joined[0].room).toEqual({ id: 'freeroam-1', kind: 'freeroam', index: 1 });
        expect(Object.keys(joined[0].players).sort()).toEqual([alice.id, carol.id].sort());
        expect([joined[0].powerups, joined[0].coins, joined[0].scoreboard]).toEqual([[], [], []]);
        expect(joined[0].spawn).toEqual({ x: alice.member!.x, z: alice.member!.z });

        // The old room lost her, the new one sees her arrive
        expect(bob.transport.of('removePlayer')).toEqual([{ type: 'removePlayer', id: alice.id }]);
        expect(carol.transport.of('newPlayer')).toEqual([
            { type: 'newPlayer', player: expect.objectContaining({ id: alice.id, name: 'Alice', carType: 'jeep', score: 0, health: 100 }) }
        ]);
        expect(lobby.get('party-1')!.members.has(alice.id)).toBe(false);
    });

    it('drops the Party score and starts fresh on the way back', () => {
        const alice = fakeSession('Alice');
        lobby.join(alice, 'party');
        ready(alice);
        const party = lobby.get('party-1') as PartyRoom;
        party.partyState(alice.id)!.score = 120;
        handleClientMessage(lobby, alice, { type: 'joinRoom', kind: 'freeroam' }, clock.now());
        expect(party.partyState(alice.id)).toBeUndefined();
        clock.advance(2_000);
        handleClientMessage(lobby, alice, { type: 'joinRoom', kind: 'party' }, clock.now());
        expect(alice.room?.id).toBe('party-1');
        expect(party.partyState(alice.id)!.score).toBe(0);
        const joined = alice.transport.of('roomJoined').at(-1)!;
        expect(joined.powerups).toHaveLength(25);
        expect(joined.coins).toHaveLength(30);
        expect(joined.scoreboard.map(e => e.name)).toEqual(['Alice']);
    });

    it('allows one switch per two seconds and ignores a switch to the same kind', () => {
        const alice = fakeSession();
        lobby.join(alice, 'party');
        handleClientMessage(lobby, alice, { type: 'joinRoom', kind: 'party' }, clock.now());
        expect(alice.transport.of('roomJoined')).toEqual([]);
        clock.advance(2_000);
        handleClientMessage(lobby, alice, { type: 'joinRoom', kind: 'freeroam' }, clock.now());
        clock.advance(1_000);
        handleClientMessage(lobby, alice, { type: 'joinRoom', kind: 'party' }, clock.now());
        expect(alice.room?.id).toBe('freeroam-1');
        clock.advance(1_000);
        handleClientMessage(lobby, alice, { type: 'joinRoom', kind: 'party' }, clock.now());
        expect(alice.room?.id).toBe('party-1');
    });

    it('switches before the splash screen without showing the car', () => {
        const alice = fakeSession(), bob = fakeSession();
        lobby.join(bob, 'freeroam');
        ready(bob);
        lobby.join(alice, 'party');
        bob.transport.clear();
        handleClientMessage(lobby, alice, { type: 'joinRoom', kind: 'freeroam' }, clock.now());
        expect(alice.member?.ready).toBe(false);
        expect(bob.transport.sent).toEqual([]);
        ready(alice);
        expect(bob.transport.of('newPlayer').map(m => m.player.id)).toEqual([alice.id]);
    });
});

describe('Free Roam', () => {
    it('ignores items and shots and has no scoreboard', () => {
        const alice = fakeSession(), bob = fakeSession();
        lobby.join(alice, 'freeroam');
        lobby.join(bob, 'freeroam');
        ready(alice);
        ready(bob);
        const room = alice.room!;
        alice.member!.x = bob.member!.x + 5;
        alice.member!.z = bob.member!.z;
        bob.transport.clear();
        handleClientMessage(lobby, alice, { type: 'shoot', targetId: bob.id }, clock.now());
        handleClientMessage(lobby, alice, { type: 'collectCoin', coinId: 0 }, clock.now());
        handleClientMessage(lobby, alice, { type: 'collectPowerup', powerupId: 0 }, clock.now());
        expect(bob.transport.sent).toEqual([]);
        expect(room.scoreboard()).toEqual([]);
        expect(room.publicPlayer(bob.member!)).toEqual(expect.objectContaining({ health: 100, score: 0, scale: 1 }));
    });

    it('relays driving and honking', () => {
        const alice = fakeSession(), bob = fakeSession();
        lobby.join(alice, 'freeroam');
        lobby.join(bob, 'freeroam');
        ready(alice);
        ready(bob);
        bob.transport.clear();
        handleClientMessage(lobby, alice, { type: 'update', x: 5, z: 6, angle: 0, flipAngle: 0, isFlipping: false }, clock.now());
        handleClientMessage(lobby, alice, { type: 'honk' }, clock.now());
        expect(bob.transport.sent.map(m => m.type)).toEqual(['update', 'honk']);
    });
});
