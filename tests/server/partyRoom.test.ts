import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleClientMessage } from '../../src/server/dispatch.js';
import { mapFor } from '../../src/server/maps.js';
import { RoomManager } from '../../src/server/rooms/lobby.js';
import type { PartyRoom } from '../../src/server/rooms/PartyRoom.js';
import { roomOptions } from '../../src/server/rooms/Room.js';
import { CAR_IDLE, CAR_LAGGY, CAR_MEGA, CAR_RESPAWN_SHIELD, CAR_SHIELD, INPUT_FROZEN, INPUT_HIDDEN } from '../../src/shared/net/codec.js';
import { IDLE_AFTER_TICKS, IDLE_EXIT_GHOST_TICKS, LAGGY_RECOVER_TICKS, LAGGY_WINDOW_TICKS } from '../../src/shared/net/constants.js';
import {
    COIN_RESET_TICKS, POWERUP_TICKS, RAM_PAIR_COOLDOWN_TICKS, RESPAWN_SHIELD_DRIVE_TICKS, RESPAWN_SHIELD_MAX_TICKS,
    RESPAWN_TICKS, SHOT_COOLDOWN_TICKS, ramDamage
} from '../../src/shared/party/rules.js';
import { placeVehicle } from '../../src/shared/sim/vehicle.js';
import type { Session } from '../../src/server/session.js';
import { feed, fakeSession, ready, steps } from './helpers.js';

// The Party rules in the room tick (docs/phase-1b-design.md, 5.4, 5.5 and
// 15.1): pickups, powerup windows, shots, the Mega ram, respawns, the idle
// and lag ghost, all against the server's own cars.

let lobby: RoomManager;
let room: PartyRoom;

// A player past the splash screen whose car is in the sim, without the
// spawn shield and the spawn ghost
function player(name: string): Session & { transport: import('./helpers.js').FakeTransport } {
    const session = fakeSession(name);
    lobby.join(session, 'party');
    ready(lobby, session);
    steps(room, 1);
    room.partyState(session.id)!.respawnShield = false;
    session.member!.car!.state.ghostTicks = 0;
    return session;
}

function put(session: Session, x: number, z: number, yaw = 0, speed = 0): void {
    const s = session.member!.car!.state;
    placeVehicle(s, room.map.simWorld, x, z, yaw);
    s.vx = Math.sin(yaw) * speed;
    s.vz = Math.cos(yaw) * speed;
}

// n ticks in which every car of the room sends a neutral input (no idle)
function run(n: number, except: Session[] = []): void {
    for (let i = 0; i < n; i++) {
        for (const member of room.orderedMembers) {
            if (member.car && !except.includes(member.session)) feed(room, member.session, {});
        }
        steps(room, 1);
    }
}

function partyOf(session: Session) {
    return room.partyState(session.id)!;
}

beforeEach(() => {
    lobby = new RoomManager(mapFor(), { maxPlayersPerRoom: 32, emptyRoomTtlMs: 60_000 });
    room = lobby.get('party-1') as PartyRoom;
});

afterEach(() => {
    for (const r of lobby.list()) r.dispose();
    roomOptions.allowDebugPlace = false;
});

describe('message validation', () => {
    const invalid: unknown[] = [
        null, 42, 'honk', [], {}, { type: 'nope' },
        { type: 'update', x: 1, z: 2, angle: 0, flipAngle: 0, isFlipping: false },
        { type: 'collectCoin', coinId: 0 },
        { type: 'rename', name: { toString: 'x' } },
        { type: 'setCar', carType: ['bulli'], profile: 'standard' },
        { type: 'shoot', targetId: null },
        { type: 'joinRoom', kind: 'race' },
        { type: 'ping', t: null },
        { type: 'hello', protocolVersion: 2 }
    ];

    for (const message of invalid) {
        it(`counts ${JSON.stringify(message)} as invalid without side effects`, () => {
            const alice = player('Alice');
            const before = structuredClone({ ...partyOf(alice), rammedBy: undefined });
            expect(handleClientMessage(lobby, alice, message, 0)).toBe('invalid');
            expect({ ...partyOf(alice), rammedBy: undefined }).toEqual(before);
            expect(alice.room).toBe(room);
        });
    }

    it('takes debugPlace only on the e2e server', () => {
        const alice = player('Alice');
        expect(handleClientMessage(lobby, alice, { type: 'debugPlace', x: 6, z: -40, yaw: 0 }, 0)).toBe('invalid');
        roomOptions.allowDebugPlace = true;
        expect(handleClientMessage(lobby, alice, { type: 'debugPlace', x: 6, z: -40, yaw: 0 }, 0)).toBe('ok');
        steps(room, 1);
        expect([alice.member!.car!.state.x, alice.member!.car!.state.z]).toEqual([6, -40]);
    });
});

describe('session messages', () => {
    it('renames with the server-side cleanup and tells the room', () => {
        const alice = player('Tester');
        const other = player('Other');
        other.transport.clear();
        handleClientMessage(lobby, alice, { type: 'rename', name: '  Bulli\u0007Fan  ' }, 10_000);
        expect(alice.name).toBe('BulliFan');
        expect(other.transport.of('playerUpdated')).toEqual([{ type: 'playerUpdated', id: alice.id, name: 'BulliFan' }]);
        steps(room, 3);
        expect(other.transport.of('scoreboard').at(-1)!.scoreboard.map(e => e.name)).toContain('BulliFan');
    });

    it('changes the car at the next tick for known types only', () => {
        const alice = player('Alice');
        handleClientMessage(lobby, alice, { type: 'setCar', carType: 'tank', profile: 'touch' }, 0);
        expect(alice.carType).toBe('bulli');
        handleClientMessage(lobby, alice, { type: 'setCar', carType: 'pickup', profile: 'touch' }, 0);
        expect([alice.carType, alice.profile]).toEqual(['pickup', 'touch']);
        steps(room, 3);
        expect(alice.member!.car!.base.mass).toBe(2000);
        expect(alice.transport.events('carChanged')).toEqual([
            { type: 'carChanged', id: alice.id, carType: 'pickup', profile: 'touch', tick: room.tick - 2 }
        ]);
    });

    it('answers pings with the room tick', () => {
        const alice = player('Alice');
        steps(room, 5, 1000);
        handleClientMessage(lobby, alice, { type: 'ping', t: 42 }, 1008);
        const [pong] = alice.transport.of('pong');
        expect(pong.t).toBe(42);
        expect(pong.tick).toBe(room.tick);
        expect(pong.sub).toBeCloseTo(8 / (1000 / 60), 6);
    });
});

describe('items', () => {
    it('picks a coin up with the server car, scores and resets it later', () => {
        const alice = player('Alice');
        const coin = room.coins[0];
        put(alice, coin.x + 3.5, coin.z);
        steps(room, 1);
        expect(coin.collected).toBe(true);
        expect(partyOf(alice).score).toBe(10);
        steps(room, 2);
        expect(alice.transport.events('pickup')).toEqual([
            { type: 'pickup', kind: 'coin', itemId: coin.id, playerId: alice.id }
        ]);
        expect(alice.transport.of('scoreboard').at(-1)!.scoreboard[0].score).toBe(10);
        put(alice, 58, -80);
        steps(room, COIN_RESET_TICKS);
        expect(coin.collected).toBe(false);
        expect(alice.transport.events('itemReset')).toEqual([{ type: 'itemReset', kind: 'coin', itemId: coin.id }]);
    });

    it('needs 4 m, or 7 m with the magnet', () => {
        const alice = player('Alice');
        const coin = room.coins[1];
        put(alice, coin.x + 4.5, coin.z);
        steps(room, 1);
        expect(coin.collected).toBe(false);
        partyOf(alice).powerups.magnet = { start: 0, end: room.tick + 100 };
        steps(room, 1);
        expect(coin.collected).toBe(true);
    });

    it('opens a powerup window from the next tick and extends it on a second pickup', () => {
        const alice = player('Alice');
        const mega = room.powerups.find(p => p.type === 'size')!;
        put(alice, mega.x + 5, mega.z);
        steps(room, 1);
        const T = room.tick;
        expect(mega.collected).toBe(true);
        expect(partyOf(alice).powerups.size).toEqual({ start: T + 1, end: T + 1 + POWERUP_TICKS.size });
        steps(room, 1);
        expect(alice.member!.car!.mods.mega).toBe(true);
        steps(room, 1);
        expect(alice.transport.events('pickup')).toEqual([expect.objectContaining({
            kind: 'powerup', itemId: mega.id, powerupType: 'size', startTick: T + 1, endTick: T + 1 + POWERUP_TICKS.size
        })]);
        expect(alice.transport.lastSnapshot!.self!.flags & CAR_MEGA).toBe(CAR_MEGA);
        // A second Mega 100 ticks later extends the window, the start stays
        steps(room, 97);
        const other = room.powerups.find(p => p.type === 'size' && p !== mega)!;
        put(alice, other.x, other.z);
        steps(room, 1);
        expect(partyOf(alice).powerups.size).toEqual({ start: T + 1, end: room.tick + 1 + POWERUP_TICKS.size });
        put(alice, 58, -60);
        steps(room, POWERUP_TICKS.size + 1);
        expect(alice.member!.car!.mods.mega).toBe(false);
    });
});

describe('shooting', () => {
    function duel() {
        const shooter = player('Shooter');
        const target = player('Target');
        put(shooter, 58, -80);
        put(target, 58, -70);
        return { shooter, target };
    }

    it('hits a target in range for 25 and respects the 24-tick cooldown', () => {
        const { shooter, target } = duel();
        handleClientMessage(lobby, shooter, { type: 'shoot', targetId: target.id }, 0);
        expect(partyOf(target).health).toBe(75);
        steps(room, 3);
        expect(target.transport.events('hit')).toEqual([
            { type: 'hit', target: target.id, source: shooter.id, damage: 25, health: 75, cause: 'shot' }
        ]);
        steps(room, SHOT_COOLDOWN_TICKS - 4);
        handleClientMessage(lobby, shooter, { type: 'shoot', targetId: target.id }, 0);
        expect(partyOf(target).health).toBe(75);
        steps(room, 1);
        handleClientMessage(lobby, shooter, { type: 'shoot', targetId: target.id }, 0);
        expect(partyOf(target).health).toBe(50);
    });

    it('does not hurt a shielded, ghosted, idle or far target, and idle cars do not shoot', () => {
        const { shooter, target } = duel();
        const state = partyOf(target);
        // After the cooldown (both cars sending inputs), set up, shoot
        const shoot = (setUp: () => void) => {
            run(SHOT_COOLDOWN_TICKS);
            setUp();
            handleClientMessage(lobby, shooter, { type: 'shoot', targetId: target.id }, 0);
        };
        shoot(() => { state.respawnShield = true; });
        shoot(() => { state.respawnShield = false; state.powerups.shield = { start: 0, end: room.tick + 1000 }; });
        shoot(() => { state.powerups.shield = { start: 0, end: 0 }; state.powerups.ghost = { start: 0, end: room.tick + 1000 }; });
        shoot(() => { state.powerups.ghost = { start: 0, end: 0 }; target.member!.idle = true; });
        shoot(() => put(target, 58, 90));
        shoot(() => { put(target, 58, -70); shooter.member!.idle = true; });
        expect(state.health).toBe(100);
        shoot(() => { /* both fine again */ });
        expect(state.health).toBe(75);
    });

    it('takes less from a Mega car', () => {
        const { shooter, target } = duel();
        partyOf(target).powerups.size = { start: 0, end: room.tick + 1000 };
        run(1);
        handleClientMessage(lobby, shooter, { type: 'shoot', targetId: target.id }, 0);
        expect(partyOf(target).health).toBe(90);
    });

    it('kills, rewards the shooter, takes the car out and respawns it 180 ticks later', () => {
        const { shooter, target } = duel();
        partyOf(target).health = 25;
        handleClientMessage(lobby, shooter, { type: 'shoot', targetId: target.id }, 0);
        const killedAt = room.tick;
        expect(partyOf(target).health).toBe(0);
        expect(target.member!.alive).toBe(false);
        expect(partyOf(shooter).score).toBe(50);
        steps(room, 3);
        expect(target.transport.events('killed')).toEqual([expect.objectContaining({ target: target.id, killer: shooter.id, cause: 'shot' })]);
        // Out of the sim: no self block, not in the others' snapshots
        expect(target.transport.lastSnapshot!.self).toBeNull();
        expect(shooter.transport.lastSnapshot!.cars).toEqual([]);
        steps(room, RESPAWN_TICKS);
        const [respawn] = target.transport.events('respawn');
        expect(respawn).toEqual(expect.objectContaining({ id: target.id, tick: killedAt + RESPAWN_TICKS, health: 100 }));
        expect(partyOf(target).respawnShield).toBe(true);
        expect([target.member!.car!.state.x, target.member!.car!.state.z]).toEqual([respawn.x, respawn.z]);
    });

    it('cannot hit a player in another room', () => {
        const shooter = player('Shooter');
        const other = fakeSession('Elsewhere');
        lobby.join(other, 'freeroam');
        ready(lobby, other);
        steps(other.room!, 1);
        handleClientMessage(lobby, shooter, { type: 'shoot', targetId: other.id }, 0);
        steps(room, 3);
        expect(shooter.transport.events('hit')).toEqual([]);
    });
});

describe('Mega ram', () => {
    it('costs 25 HP at 10 m/s of impulse, nothing under 4 m/s, and never more than 60', () => {
        expect(ramDamage(3.9, false)).toBe(0);
        expect(ramDamage(4, false)).toBe(10);
        expect(ramDamage(10, false)).toBe(25);
        expect(ramDamage(10, true)).toBe(10);
        expect(ramDamage(40, false)).toBe(60);
        expect(ramDamage(NaN, false)).toBe(0);
    });

    it('damages the rammed car from the contact, once per pair within 60 ticks', () => {
        const ram = player('Ram');
        const victim = player('Victim');
        partyOf(ram).powerups.size = { start: 0, end: room.tick + 10_000 };
        // Mega grows over a few ticks
        run(60);
        partyOf(victim).respawnShield = false;
        put(ram, 58, -80, 0, 25);
        put(victim, 58, -72);
        let hitAt = -1;
        for (let i = 0; i < 60 && hitAt < 0; i++) {
            feed(room, ram, { throttle: 255 });
            run(1, [ram]);
            if (partyOf(victim).health < 100) hitAt = room.tick;
        }
        expect(hitAt).toBeGreaterThan(0);
        steps(room, 3);
        const [hit] = victim.transport.events('hit');
        expect(hit).toEqual(expect.objectContaining({ target: victim.id, source: ram.id, cause: 'ram' }));
        expect(hit.damage).toBeGreaterThanOrEqual(10);
        // The Mega car itself takes no ram damage
        expect(partyOf(ram).health).toBe(100);
        // Pushing on does not hurt again before the cooldown
        const health = partyOf(victim).health;
        for (let i = 0; i < RAM_PAIR_COOLDOWN_TICKS - 10; i++) {
            feed(room, ram, { throttle: 255 });
            run(1, [ram]);
        }
        expect(partyOf(victim).health).toBe(health);
    });

    it('does not hurt a car behind the respawn shield', () => {
        const ram = player('Ram');
        const victim = player('Victim');
        partyOf(ram).powerups.size = { start: 0, end: room.tick + 10_000 };
        run(60);
        partyOf(victim).respawnShield = true;
        partyOf(victim).spawnTick = room.tick;
        put(ram, 58, -80, 0, 25);
        put(victim, 58, -72);
        for (let i = 0; i < 40; i++) {
            feed(room, ram, { throttle: 255 });
            run(1, [ram]);
        }
        expect(partyOf(victim).health).toBe(100);
    });
});

describe('respawn shield', () => {
    it('ends 180 ticks after the car drives off, or 480 ticks after the spawn', () => {
        const alice = fakeSession('Alice');
        lobby.join(alice, 'party');
        ready(lobby, alice);
        steps(room, 1);
        const state = partyOf(alice);
        expect(state.respawnShield).toBe(true);
        steps(room, 1);
        expect(alice.member!.car!.mods.shield).toBe(true);
        steps(room, 4);
        expect(alice.transport.lastSnapshot!.self!.flags & CAR_RESPAWN_SHIELD).toBe(CAR_RESPAWN_SHIELD);
        expect(alice.transport.lastSnapshot!.self!.flags & CAR_SHIELD).toBe(0);
        // Standing still: the cap
        run(RESPAWN_SHIELD_MAX_TICKS - 6);
        expect(state.respawnShield).toBe(true);
        run(1);
        expect(state.respawnShield).toBe(false);

        const bob = fakeSession('Bob');
        lobby.join(bob, 'party');
        ready(lobby, bob);
        steps(room, 1);
        put(bob, 58, -80, 0, 0);
        let movedAt = -1;
        for (let i = 0; i < RESPAWN_SHIELD_DRIVE_TICKS + 60; i++) {
            feed(room, bob, { throttle: 255 });
            run(1, [bob]);
            if (movedAt < 0 && partyOf(bob).movedTick >= 0) movedAt = partyOf(bob).movedTick;
            if (!partyOf(bob).respawnShield) break;
        }
        expect(movedAt).toBeGreaterThan(0);
        expect(partyOf(bob).respawnShield).toBe(false);
        expect(room.tick - movedAt).toBe(RESPAWN_SHIELD_DRIVE_TICKS);
    });
});

describe('idle and lag ghost', () => {
    it('makes a frozen car an idle ghost and ends it with a longer ghost', () => {
        const alice = player('Alice');
        for (let i = 0; i < 3; i++) {
            feed(room, alice, {}, INPUT_FROZEN);
            steps(room, 1);
        }
        expect(alice.member!.idle).toBe(true);
        expect(alice.member!.car!.state.ghostTicks).toBeGreaterThanOrEqual(1);
        expect(alice.transport.lastSnapshot!.self!.flags & CAR_IDLE).toBe(CAR_IDLE);
        feed(room, alice, {});
        steps(room, 1);
        expect(alice.member!.idle).toBe(false);
        expect(alice.member!.car!.state.ghostTicks).toBe(IDLE_EXIT_GHOST_TICKS - 1);
    });

    it('goes idle after 60 ticks without input and in a background tab', () => {
        const alice = player('Alice');
        steps(room, IDLE_AFTER_TICKS - 1);
        expect(alice.member!.idle).toBe(false);
        steps(room, 1);
        expect(alice.member!.idle).toBe(true);
        const bob = player('Bob');
        feed(room, bob, {});
        steps(room, 1);
        expect(bob.member!.idle).toBe(false);
        // The tab went to the background: the message, and the packets carry HIDDEN
        handleClientMessage(lobby, bob, { type: 'visibility', hidden: true }, 0);
        steps(room, 1);
        expect(bob.member!.idle).toBe(true);
        feed(room, bob, {}, INPUT_HIDDEN);
        steps(room, 1);
        expect(bob.member!.idle).toBe(true);
        handleClientMessage(lobby, bob, { type: 'visibility', hidden: false }, 0);
        feed(room, bob, {});
        steps(room, 1);
        expect(bob.member!.idle).toBe(false);
    });

    it('keeps the ghost while the car still overlaps another one', () => {
        const alice = player('Alice');
        const bob = player('Bob');
        put(alice, 58, -80);
        put(bob, 58, -79);
        for (let i = 0; i < 3; i++) {
            feed(room, alice, {}, INPUT_FROZEN);
            feed(room, bob, {});
            steps(room, 1);
        }
        for (let i = 0; i < IDLE_EXIT_GHOST_TICKS + 30; i++) {
            feed(room, alice, {});
            feed(room, bob, {});
            steps(room, 1);
        }
        // Still on top of each other: never thrown apart, the hold stays on
        expect(alice.member!.ghostHold).toBe(true);
        const a = alice.member!.car!.state, b = bob.member!.car!.state;
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(1.5);
        expect(Math.hypot(a.vx, a.vz)).toBeLessThan(0.5);
    });

    it('marks a lagging car and lets it recover after 5 s of good input', () => {
        const alice = player('Alice');
        alice.noteRtt(400);
        feed(room, alice, {});
        steps(room, 1);
        expect(alice.member!.laggy).toBe(true);
        expect(alice.member!.car!.state.ghostTicks).toBeGreaterThanOrEqual(1);
        alice.noteRtt(20);
        alice.noteRtt(20);
        for (let i = 0; i < LAGGY_RECOVER_TICKS; i++) {
            feed(room, alice, {});
            steps(room, 1);
        }
        expect(alice.member!.laggy).toBe(false);
        steps(room, 2);
        expect(alice.transport.lastSnapshot!.self!.flags & CAR_LAGGY).toBe(0);

        // Every third input lost over the window: lagging
        const bob = player('Bob');
        for (let i = 0; i < LAGGY_WINDOW_TICKS; i++) {
            if (i % 3 !== 0) feed(room, bob, {});
            steps(room, 1);
        }
        expect(bob.member!.laggy).toBe(true);
    });
});

describe('contact events', () => {
    it('reports a bump to the cars nearby', () => {
        const alice = player('Alice');
        const bob = player('Bob');
        run(1);
        put(alice, 58, -80, 0, 20);
        put(bob, 58, -74);
        for (let i = 0; i < 30; i++) {
            feed(room, alice, { throttle: 255 });
            feed(room, bob, {});
            steps(room, 1);
        }
        const contacts = bob.transport.events('contact');
        expect(contacts.length).toBeGreaterThanOrEqual(1);
        expect(contacts[0]).toEqual(expect.objectContaining({ a: alice.id, b: bob.id }));
        expect(contacts[0].dv).toBeGreaterThanOrEqual(3);
        expect(bob.member!.car!.state.vz).toBeGreaterThan(3);
    });
});
