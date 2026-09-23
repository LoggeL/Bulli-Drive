import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleClientMessage } from '../../src/server/dispatch.js';
import { mapFor } from '../../src/server/maps.js';
import { RoomManager } from '../../src/server/rooms/lobby.js';
import type { PartyRoom } from '../../src/server/rooms/PartyRoom.js';
import type { RoomMember } from '../../src/server/rooms/Room.js';
import { fakeClock, fakeSession } from './helpers.js';

// The Party rules of the former server/handlers.ts, now per room instance
// (docs/phase-1b-design.md, 2 and 15.1).

let clock: ReturnType<typeof fakeClock>;
let lobby: RoomManager;
let room: PartyRoom;

function joinReady(name: string) {
    const session = fakeSession(name);
    const member = lobby.join(session, 'party');
    handleClientMessage(lobby, session, { type: 'playerReady' }, clock.now());
    return { session, member };
}

// Everything the messages may change, for before/after comparisons
function snapshot(member: RoomMember) {
    const { session, ...rest } = member;
    return structuredClone({
        member: rest,
        name: session.name,
        carType: session.carType,
        party: { ...room.partyState(member.id)!, effectTimers: undefined, respawnShieldTimer: undefined }
    });
}

beforeEach(() => {
    clock = fakeClock();
    lobby = new RoomManager(mapFor(), { maxPlayersPerRoom: 32, emptyRoomTtlMs: 60_000, now: clock.now });
    room = lobby.get('party-1') as PartyRoom;
});

afterEach(() => {
    for (const r of lobby.list()) r.dispose();
    vi.useRealTimers();
});

describe('message validation', () => {
    const invalid: unknown[] = [
        null,
        42,
        'update',
        [],
        {},
        { type: 'nope' },
        { type: 'update', x: 'far away', z: 0, angle: 0, flipAngle: 0, isFlipping: false },
        { type: 'update', x: 1, z: 2 },
        { type: 'collectCoin', coinId: '0' },
        { type: 'rename', name: { toString: 'x' } },
        { type: 'setCarType', carType: ['bulli'] },
        { type: 'shoot', targetId: null },
        { type: 'joinRoom', kind: 'race' },
        { type: 'joinRoom' }
    ];

    for (const message of invalid) {
        it(`drops ${JSON.stringify(message)} without side effects`, () => {
            const { session, member } = joinReady('Tester');
            const before = snapshot(member);
            expect(() => handleClientMessage(lobby, session, message, clock.now())).not.toThrow();
            expect(snapshot(member)).toEqual(before);
            expect(session.room).toBe(room);
        });
    }
});

describe('driving messages', () => {
    it('applies a real client update and relays it to the room only', () => {
        const alice = joinReady('Alice');
        const bob = joinReady('Bob');
        bob.session.transport.clear();
        handleClientMessage(lobby, alice.session, {
            type: 'update', x: 55.5, z: -12.25, y: 0.04, angle: 1.2, flipAngle: 0.3,
            isFlipping: true, scale: 1, ghostActive: false, shieldActive: false, megaActive: false
        }, clock.now());
        const m = alice.member;
        expect([m.x, m.z, m.y, m.angle, m.flipAngle, m.isFlipping]).toEqual([55.5, -12.25, 0.04, 1.2, 0.3, true]);
        expect(bob.session.transport.of('update')).toEqual([expect.objectContaining({ id: m.id, x: 55.5, scale: 1 })]);
        expect(alice.session.transport.of('update')).toEqual([]);
    });

    it('falls back to y = 0 when y is missing or null', () => {
        const { session, member } = joinReady('Tester');
        handleClientMessage(lobby, session, { type: 'update', x: 1, z: 2, y: null, angle: 0, flipAngle: 0, isFlipping: false }, clock.now());
        expect(member.y).toBe(0);
        expect(member.x).toBe(1);
    });

    it('still applies the position when the other update fields are off', () => {
        const { session, member } = joinReady('Tester');
        handleClientMessage(lobby, session, {
            type: 'update', x: 3, z: 4, y: '3', angle: 0.5, flipAngle: 0, isFlipping: 1,
            scale: null, ghostActive: 'yes', megaActive: null
        }, clock.now());
        expect([member.x, member.z, member.y, member.angle, member.isFlipping]).toEqual([3, 4, 0, 0.5, true]);
    });

    it('clamps positions to the world bound and limits the update rate', () => {
        const { session, member } = joinReady('Tester');
        handleClientMessage(lobby, session, { type: 'update', x: 1e9, z: -1e9, angle: 0, flipAngle: 0, isFlipping: false }, clock.now());
        expect([member.x, member.z]).toEqual([550, -550]);
        handleClientMessage(lobby, session, { type: 'update', x: 1, z: 1, angle: 0, flipAngle: 0, isFlipping: false }, clock.now() + 10);
        expect(member.x).toBe(550);
    });

    it('ignores updates before the player is ready', () => {
        const session = fakeSession();
        const member = lobby.join(session, 'party');
        const x = member.x;
        handleClientMessage(lobby, session, { type: 'update', x: x + 5, z: 0, angle: 0, flipAngle: 0, isFlipping: false }, clock.now());
        expect(member.x).toBe(x);
    });
});

describe('session messages', () => {
    it('renames with the server-side cleanup and tells the room', () => {
        const { session } = joinReady('Tester');
        const other = joinReady('Other');
        handleClientMessage(lobby, session, { type: 'rename', name: '  Bulli\u0007Fan  ' }, clock.now());
        expect(session.name).toBe('BulliFan');
        expect(other.session.transport.of('playerRenamed')).toEqual([{ type: 'playerRenamed', id: session.id, name: 'BulliFan' }]);
        expect(other.session.transport.of('scoreboard').at(-1)!.scoreboard.map(e => e.name)).toContain('BulliFan');
    });

    it('accepts known car types only', () => {
        const { session } = joinReady('Tester');
        handleClientMessage(lobby, session, { type: 'setCarType', carType: 'jeep' }, clock.now());
        expect(session.carType).toBe('jeep');
        handleClientMessage(lobby, session, { type: 'setCarType', carType: 'tank' }, clock.now());
        expect(session.carType).toBe('jeep');
    });

    it('marks a player ready once and shows the car to the others', () => {
        const alice = joinReady('Alice');
        const session = fakeSession('Late');
        const member = lobby.join(session, 'party');
        expect(member.ready).toBe(false);
        handleClientMessage(lobby, session, { type: 'playerReady' }, clock.now());
        handleClientMessage(lobby, session, { type: 'playerReady' }, clock.now());
        expect(member.ready).toBe(true);
        expect(alice.session.transport.of('newPlayer').map(m => m.player.id)).toEqual([member.id]);
    });
});

describe('items', () => {
    it('collects a coin in range, scores and resets it later', () => {
        vi.useFakeTimers();
        const { session, member } = joinReady('Tester');
        const coin = room.coins[0];
        member.x = coin.x;
        member.z = coin.z;
        handleClientMessage(lobby, session, { type: 'collectCoin', coinId: 0 }, clock.now());
        expect(coin.collected).toBe(true);
        expect(room.partyState(member.id)!.score).toBe(10);
        // A second collect of the same coin is refused
        handleClientMessage(lobby, session, { type: 'collectCoin', coinId: 0 }, clock.now());
        expect(room.partyState(member.id)!.score).toBe(10);
        vi.runAllTimers();
        expect(coin.collected).toBe(false);
        expect(session.transport.of('coinReset')).toEqual([{ type: 'coinReset', coinId: 0 }]);
    });

    it('refuses a coin out of range', () => {
        const { session, member } = joinReady('Tester');
        const coin = room.coins[1];
        member.x = coin.x + 100;
        member.z = coin.z;
        handleClientMessage(lobby, session, { type: 'collectCoin', coinId: 1 }, clock.now());
        expect(coin.collected).toBe(false);
    });

    it('activates a server-tracked powerup and ends it after its duration', () => {
        vi.useFakeTimers();
        const { session, member } = joinReady('Tester');
        const mega = room.powerups.find(p => p.type === 'size')!;
        member.x = mega.x;
        member.z = mega.z;
        handleClientMessage(lobby, session, { type: 'collectPowerup', powerupId: mega.id }, clock.now());
        expect(room.partyState(member.id)!.megaActive).toBe(true);
        expect(room.publicPlayer(member).scale).toBe(2.5);
        vi.advanceTimersByTime(5000);
        expect(room.partyState(member.id)!.megaActive).toBe(false);
    });
});

describe('shooting', () => {
    function duel() {
        const shooter = joinReady('Shooter');
        const target = joinReady('Target');
        // Past the spawn shield, side by side
        room.partyState(target.member.id)!.respawnShield = false;
        shooter.member.x = 0; shooter.member.z = 0;
        target.member.x = 10; target.member.z = 0;
        return { shooter, target };
    }

    it('hits a target in range for 25 and respects the cooldown', () => {
        const { shooter, target } = duel();
        handleClientMessage(lobby, shooter.session, { type: 'shoot', targetId: target.member.id }, clock.now());
        expect(room.partyState(target.member.id)!.health).toBe(75);
        expect(target.session.transport.of('playerHit')).toEqual([
            { type: 'playerHit', targetId: target.member.id, shooterId: shooter.member.id, newHealth: 75, damage: 25 }
        ]);
        handleClientMessage(lobby, shooter.session, { type: 'shoot', targetId: target.member.id }, clock.now() + 100);
        expect(room.partyState(target.member.id)!.health).toBe(75);
    });

    it('does not hurt a target behind the respawn shield, out of range or AFK', () => {
        const { shooter, target } = duel();
        const state = room.partyState(target.member.id)!;
        state.respawnShield = true;
        handleClientMessage(lobby, shooter.session, { type: 'shoot', targetId: target.member.id }, clock.now());
        expect(state.health).toBe(100);

        state.respawnShield = false;
        target.member.x = 500;
        clock.advance(1000);
        handleClientMessage(lobby, shooter.session, { type: 'shoot', targetId: target.member.id }, clock.now());
        expect(state.health).toBe(100);

        target.member.x = 10;
        shooter.member.lastActivity = clock.now();
        clock.advance(1000);
        target.member.lastActivity = clock.now() - 5000;
        handleClientMessage(lobby, shooter.session, { type: 'shoot', targetId: target.member.id }, clock.now());
        expect(state.health).toBe(100);
    });

    it('kills, rewards the shooter and respawns the target', () => {
        vi.useFakeTimers();
        const { shooter, target } = duel();
        const state = room.partyState(target.member.id)!;
        state.health = 25;
        handleClientMessage(lobby, shooter.session, { type: 'shoot', targetId: target.member.id }, clock.now());
        expect(state.health).toBe(0);
        expect(room.partyState(shooter.member.id)!.score).toBe(50);
        expect(target.session.transport.of('playerKilled')).toHaveLength(1);
        vi.advanceTimersByTime(3000);
        expect(state.health).toBe(100);
        expect(state.respawnShield).toBe(true);
        expect(target.session.transport.of('playerRespawn')).toEqual([
            expect.objectContaining({ playerId: target.member.id, health: 100 })
        ]);
    });

    it('cannot hit a player in another room', () => {
        const shooter = joinReady('Shooter');
        const other = fakeSession('Elsewhere');
        lobby.join(other, 'freeroam');
        handleClientMessage(lobby, shooter.session, { type: 'shoot', targetId: other.id }, clock.now());
        expect(other.transport.of('playerHit')).toEqual([]);
        expect(shooter.session.transport.of('playerHit')).toEqual([]);
    });
});
