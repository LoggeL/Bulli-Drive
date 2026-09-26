import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
    ClientMessage, HelloSchema, InputPacketSchema, isRoomKind, parseClientMessage, PROTOCOL_VERSION
} from '../../src/shared/protocol.js';

// Protocol v5 (docs/phase-1b-design.md, 3; docs/phase-2-design.md, 16;
// docs/phase-3-design.md, M3; docs/phase-1a-design.md, 26): the
// JSON messages of the client and the schema of the decoded binary input
// packet.

// What actually reaches the server: the object after a JSON round trip.
function overTheWire(message: unknown): unknown {
    return JSON.parse(JSON.stringify(message));
}

// One sample per client send site (src/client/**, all via sendToServer).
const REAL_CLIENT_MESSAGES: Record<string, ClientMessage> = {
    // network/websocket.ts on open
    hello: {
        type: 'hello', protocolVersion: PROTOCOL_VERSION, build: '0123456789abcdef', connId: 'k2x9q1',
        name: 'SurfKing42', carType: 'bulli', profile: 'standard', room: 'party'
    },
    // Vite dev server: no build stamp; a phone that played Free Roam last
    helloDev: {
        type: 'hello', protocolVersion: PROTOCOL_VERSION, build: null, connId: 'z',
        name: '', carType: 'jeep', profile: 'touch', room: 'freeroam'
    },
    // main.ts start
    ready: { type: 'ready' },
    // network/websocket.ts clock sync
    ping: { type: 'ping', t: 1234.5678 },
    // entities/Bulli.ts (F key / horn button)
    honk: { type: 'honk' },
    // main.ts start, ui/screens.ts rename form
    rename: { type: 'rename', name: 'SurfKing42' },
    renameUnicode: { type: 'rename', name: 'Jürgen 🚐' },
    // main.ts start
    setCar: { type: 'setCar', carType: 'beetle', profile: 'touch' },
    // world/projectiles.ts hits
    shoot: { type: 'shoot', targetId: '4f1c2c7e-3a5b-4a0e-9d8e-1b2c3d4e5f60' },
    // ui/roomMenu.ts (splash start and the in-game mode switch)
    joinRoom: { type: 'joinRoom', kind: 'freeroam' },
    joinParty: { type: 'joinRoom', kind: 'party' },
    // network/websocket.ts visibilitychange
    visibility: { type: 'visibility', hidden: true },
    // e2eHook.ts placeLocalCar (E2E server only)
    debugPlace: { type: 'debugPlace', x: 6, z: -98, yaw: 0 },
    // Race and time trial (docs/phase-2-design.md, 16.2): tools/bots/bot.ts
    // modes race and timetrial now, the race UI of the browser next
    joinRace: { type: 'joinRoom', kind: 'race' },
    joinOwnRace: { type: 'joinRoom', kind: 'race', fresh: true, track: 'hill-sprint' },
    joinTimeTrial: { type: 'joinRoom', kind: 'timetrial', track: 'downtown-loop' },
    raceReady: { type: 'raceReady', ready: true },
    raceConfig: { type: 'raceConfig', track: 'hill-sprint', botLevel: 'hard' },
    raceConfigLevel: { type: 'raceConfig', botLevel: 'easy' },
    raceVote: { type: 'raceVote', choice: 'rematch' },
    timeTrialRestart: { type: 'timeTrialRestart' }
};

describe('PROTOCOL_VERSION', () => {
    it('is 5 since the suspension replaced the jump in the self block and the compact record', () => {
        expect(PROTOCOL_VERSION).toBe(5);
    });
});

describe('isRoomKind', () => {
    // The room menu keeps a saved choice only if it is one of the kinds
    it('accepts party, freeroam, race and timetrial only', () => {
        expect(isRoomKind('party')).toBe(true);
        expect(isRoomKind('freeroam')).toBe(true);
        expect(isRoomKind('race')).toBe(true);
        expect(isRoomKind('timetrial')).toBe(true);
        for (const value of ['Party', 'free roam', 'free', '', 'party ', undefined, null, 1, ['party'], { kind: 'party' }]) {
            expect(isRoomKind(value), String(value)).toBe(false);
        }
    });
});

describe('parseClientMessage accepts every real client message', () => {
    for (const [name, message] of Object.entries(REAL_CLIENT_MESSAGES)) {
        it(name, () => {
            expect(parseClientMessage(overTheWire(message))).toEqual(message);
        });
    }

    it('covers every client message type', () => {
        const types = new Set(Object.values(REAL_CLIENT_MESSAGES).map(m => m.type));
        expect([...types].sort()).toEqual([
            'debugPlace', 'hello', 'honk', 'joinRoom', 'ping', 'raceConfig', 'raceReady', 'raceVote', 'ready', 'rename',
            'setCar', 'shoot', 'timeTrialRestart', 'visibility'
        ]);
    });

    it('accepts values the server clamps or cleans up itself', () => {
        expect(parseClientMessage({ type: 'rename', name: '   ' })).not.toBeNull();
        expect(parseClientMessage({ type: 'setCar', carType: 'tank', profile: 'standard' })).not.toBeNull();
        // An old or future version still parses as hello; the server rejects it by the number
        expect(v.safeParse(HelloSchema, { ...REAL_CLIENT_MESSAGES.hello, protocolVersion: 1 }).success).toBe(true);
    });

    it('strips unknown keys', () => {
        const parsed = parseClientMessage(overTheWire({ type: 'honk', damage: 9999, admin: true }));
        expect(parsed).toEqual({ type: 'honk' });
        const parsedProto = parseClientMessage(JSON.parse('{"type":"ready","__proto__":{"polluted":true}}'));
        expect(parsedProto).toEqual({ type: 'ready' });
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
});

describe('parseClientMessage rejects invalid messages', () => {
    const { hello, ping, debugPlace } = REAL_CLIENT_MESSAGES;
    const invalid: [string, unknown][] = [
        ['null', null],
        ['undefined', undefined],
        ['number', 42],
        ['string', 'honk'],
        ['array', [{ type: 'honk' }]],
        ['empty object', {}],
        ['unknown type', { type: 'teleport', x: 0, z: 0 }],
        ['non-string type', { type: 7 }],
        // v1 messages are gone: positions, client-side pickups, the old names
        ['v1 update', { type: 'update', x: 0, z: 0, angle: 0, flipAngle: 0, isFlipping: false }],
        ['v1 collectCoin', { type: 'collectCoin', coinId: 3 }],
        ['v1 collectPowerup', { type: 'collectPowerup', powerupId: 3 }],
        ['v1 playerReady', { type: 'playerReady' }],
        ['v1 setCarType', { type: 'setCarType', carType: 'jeep' }],
        ['v1 respawnShieldExpired', { type: 'respawnShieldExpired' }],
        ['removed scoreUpdate', { type: 'scoreUpdate', score: 1e6 }],
        ['hello without version', { ...hello, protocolVersion: undefined }],
        ['hello with fractional version', { ...hello, protocolVersion: 2.5 }],
        ['hello with unknown profile', { ...hello, profile: 'pro' }],
        ['hello with unknown room', { ...hello, room: 'rally' }],
        ['hello with a huge name', { ...hello, name: 'x'.repeat(201) }],
        ['ping with NaN (null on the wire)', overTheWire({ ...ping, t: NaN })],
        ['ping with Infinity', { ...ping, t: Infinity }],
        ['ping with a string', { ...ping, t: '1' }],
        ['debugPlace with NaN', overTheWire({ ...debugPlace, x: NaN })],
        ['rename with number', { type: 'rename', name: 5 }],
        ['setCar without profile', { type: 'setCar', carType: 'jeep' }],
        ['shoot without target', { type: 'shoot' }],
        ['shoot with object target', { type: 'shoot', targetId: { id: 'x' } }],
        ['visibility with a string', { type: 'visibility', hidden: 'yes' }],
        ['joinRoom without kind', { type: 'joinRoom' }],
        ['joinRoom to an unknown kind', { type: 'joinRoom', kind: 'rally' }],
        ['joinRoom to an unknown track', { type: 'joinRoom', kind: 'race', track: 'nordschleife' }],
        ['joinRoom with fresh as a string', { type: 'joinRoom', kind: 'race', fresh: 'yes' }],
        ['raceReady without ready', { type: 'raceReady' }],
        ['raceReady with a number', { type: 'raceReady', ready: 1 }],
        ['raceConfig with an unknown track', { type: 'raceConfig', track: 'nordschleife' }],
        ['raceConfig with an unknown level', { type: 'raceConfig', botLevel: 'insane' }],
        ['raceVote with an unknown choice', { type: 'raceVote', choice: 'quit' }],
        ['raceVote without a choice', { type: 'raceVote' }]
    ];

    for (const [name, value] of invalid) {
        it(name, () => {
            expect(parseClientMessage(value)).toBeNull();
        });
    }
});

describe('InputPacketSchema', () => {
    const packet = { flags: 0, seq: 12, tick: 900, inputs: [{ steer: -127, throttle: 255, brake: 0, buttons: 3 }] };

    it('accepts a decoded packet', () => {
        expect(v.safeParse(InputPacketSchema, packet).success).toBe(true);
        expect(v.safeParse(InputPacketSchema, { ...packet, seq: 0xffffffff }).success).toBe(true);
    });

    for (const [name, value] of [
        ['no inputs', { ...packet, inputs: [] }],
        ['nine inputs', { ...packet, inputs: Array(9).fill(packet.inputs[0]) }],
        ['fractional steer', { ...packet, inputs: [{ ...packet.inputs[0], steer: 0.5 }] }],
        ['NaN throttle', { ...packet, inputs: [{ ...packet.inputs[0], throttle: NaN }] }],
        ['negative tick', { ...packet, tick: -1 }],
        ['flags beyond a byte', { ...packet, flags: 256 }]
    ] as const) {
        it(`rejects ${name}`, () => {
            expect(v.safeParse(InputPacketSchema, value).success).toBe(false);
        });
    }
});
