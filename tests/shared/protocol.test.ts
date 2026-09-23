import { describe, expect, it } from 'vitest';
import { ClientMessage, parseClientMessage, PROTOCOL_VERSION } from '../../src/shared/protocol.js';

// What actually reaches the server: the object after a JSON round trip.
function overTheWire(message: unknown): unknown {
    return JSON.parse(JSON.stringify(message));
}

// One sample per client send site (src/client/**, all via sendToServer).
const REAL_CLIENT_MESSAGES: Record<string, ClientMessage> = {
    // entities/Bulli.ts sendMovementSnapshot
    update: {
        type: 'update',
        x: 12.345,
        z: -67.89,
        y: 0.031,
        angle: 1.5707963267948966,
        flipAngle: 0,
        isFlipping: false,
        scale: 1,
        ghostActive: false,
        shieldActive: true,
        megaActive: false
    },
    // entities/Bulli.ts mid-flip with Mega active
    updateFlipping: {
        type: 'update',
        x: -499,
        z: 550,
        y: 23.9,
        angle: -12.5,
        flipAngle: 4.2,
        isFlipping: true,
        scale: 2.5,
        ghostActive: true,
        shieldActive: false,
        megaActive: true
    },
    // world/powerups.ts
    collectPowerup: { type: 'collectPowerup', powerupId: 7 },
    // world/coins.ts
    collectCoin: { type: 'collectCoin', coinId: 0 },
    // entities/Bulli.ts (F key / horn button)
    honk: { type: 'honk' },
    // main.ts start, network/websocket.ts init, ui/screens.ts rename form
    rename: { type: 'rename', name: 'SurfKing42' },
    renameUnicode: { type: 'rename', name: 'Jürgen 🚐' },
    // main.ts start
    setCarType: { type: 'setCarType', carType: 'beetle' },
    playerReady: { type: 'playerReady' },
    // main.ts respawn shield decay
    respawnShieldExpired: { type: 'respawnShieldExpired' },
    // main.ts Mega ram and world/projectiles.ts hits
    shoot: { type: 'shoot', targetId: '4f1c2c7e-3a5b-4a0e-9d8e-1b2c3d4e5f60' }
};

describe('PROTOCOL_VERSION', () => {
    it('is a positive integer', () => {
        expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
        expect(PROTOCOL_VERSION).toBeGreaterThan(0);
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
            'collectCoin', 'collectPowerup', 'honk', 'playerReady', 'rename',
            'respawnShieldExpired', 'setCarType', 'shoot', 'update'
        ]);
    });

    it('accepts an update without the optional fields', () => {
        const minimal = { type: 'update', x: 0, z: 0, angle: 0, flipAngle: 0, isFlipping: false };
        expect(parseClientMessage(minimal)).toEqual(minimal);
    });

    it('accepts an update whose y became null (NaN on the wire)', () => {
        const message = { ...REAL_CLIENT_MESSAGES.update, y: NaN };
        expect(parseClientMessage(overTheWire(message))).toMatchObject({ type: 'update', y: null });
    });

    it('accepts values the server clamps or cleans up itself', () => {
        expect(parseClientMessage({ type: 'rename', name: '   ' })).not.toBeNull();
        expect(parseClientMessage({ type: 'rename', name: 'x'.repeat(500) })).not.toBeNull();
        expect(parseClientMessage({ type: 'setCarType', carType: 'tank' })).not.toBeNull();
        expect(parseClientMessage({ ...REAL_CLIENT_MESSAGES.update, x: 1e9 })).not.toBeNull();
    });

    it('strips unknown keys', () => {
        const parsed = parseClientMessage(overTheWire({ type: 'honk', damage: 9999, admin: true }));
        expect(parsed).toEqual({ type: 'honk' });
        const parsedProto = parseClientMessage(JSON.parse('{"type":"playerReady","__proto__":{"polluted":true}}'));
        expect(parsedProto).toEqual({ type: 'playerReady' });
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
});

describe('parseClientMessage rejects invalid messages', () => {
    const { update } = REAL_CLIENT_MESSAGES;
    const invalid: [string, unknown][] = [
        ['null', null],
        ['undefined', undefined],
        ['number', 42],
        ['string', 'honk'],
        ['array', [{ type: 'honk' }]],
        ['empty object', {}],
        ['unknown type', { type: 'teleport', x: 0, z: 0 }],
        ['non-string type', { type: 7 }],
        ['removed scoreUpdate', { type: 'scoreUpdate', score: 1e6 }],
        ['update without x', { ...update, x: undefined }],
        ['update with string x', { ...update, x: '12' }],
        ['update with null z (NaN on the wire)', overTheWire({ ...update, z: NaN })],
        ['update with Infinity angle', { ...update, angle: Infinity }],
        ['update without flipAngle', { ...update, flipAngle: undefined }],
        ['update without isFlipping', { ...update, isFlipping: undefined }],
        ['update with numeric isFlipping', { ...update, isFlipping: 1 }],
        ['update with string y', { ...update, y: '3' }],
        ['update with string scale', { ...update, scale: '2.5' }],
        ['update with string ghostActive', { ...update, ghostActive: 'yes' }],
        ['collectPowerup without id', { type: 'collectPowerup' }],
        ['collectPowerup with string id', { type: 'collectPowerup', powerupId: '3' }],
        ['collectCoin with null id', { type: 'collectCoin', coinId: null }],
        ['rename with number', { type: 'rename', name: 5 }],
        ['rename without name', { type: 'rename' }],
        ['setCarType with null', { type: 'setCarType', carType: null }],
        ['shoot without target', { type: 'shoot' }],
        ['shoot with object target', { type: 'shoot', targetId: { id: 'x' } }]
    ];

    for (const [name, value] of invalid) {
        it(name, () => {
            expect(parseClientMessage(value)).toBeNull();
        });
    }
});
