import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { cleanupPlayerTimers, handleClientMessage } from '../../src/server/handlers.js';
import { players } from '../../src/server/state.js';
import { coinsById, initWorld } from '../../src/server/world.js';
import type { Player } from '../../src/server/types.js';

const ID = 'player-1';

function createPlayer(overrides: Partial<Player> = {}): Player {
    return {
        id: ID,
        ws: { readyState: 1, send() { /* no-op */ } } as unknown as WebSocket,
        ready: true,
        color: 0xff0000,
        name: 'Tester',
        carType: 'bulli',
        x: 10,
        y: 0,
        z: 20,
        angle: 0,
        flipAngle: 0,
        isFlipping: false,
        score: 0,
        health: 100,
        shieldActive: false,
        ghostActive: false,
        megaActive: false,
        lastActivity: Date.now(),
        lastUpdateAt: 0,
        lastHonkAt: 0,
        lastRenameAt: 0,
        lastShotAt: 0,
        respawnShield: false,
        ...overrides
    };
}

// Everything except the socket, for before/after comparisons.
function snapshot(player: Player) {
    const { ws: _ws, ...rest } = player;
    return structuredClone(rest);
}

beforeEach(() => {
    initWorld();
    players[ID] = createPlayer();
});

afterEach(() => {
    for (const id of Object.keys(players)) {
        cleanupPlayerTimers(players[id]);
        delete players[id];
    }
});

describe('handleClientMessage validation', () => {
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
        { type: 'shoot', targetId: null }
    ];

    for (const message of invalid) {
        it(`drops ${JSON.stringify(message)} without side effects`, () => {
            const before = snapshot(players[ID]);
            expect(() => handleClientMessage(ID, message)).not.toThrow();
            expect(snapshot(players[ID])).toEqual(before);
        });
    }

    it('ignores messages for unknown players', () => {
        expect(() => handleClientMessage('ghost', { type: 'honk' })).not.toThrow();
    });
});

describe('handleClientMessage with valid messages', () => {
    it('applies a real client update', () => {
        handleClientMessage(ID, {
            type: 'update', x: 55.5, z: -12.25, y: 0.04, angle: 1.2, flipAngle: 0.3,
            isFlipping: true, scale: 1, ghostActive: false, shieldActive: false, megaActive: false
        });
        const p = players[ID];
        expect([p.x, p.z, p.y, p.angle, p.flipAngle, p.isFlipping]).toEqual([55.5, -12.25, 0.04, 1.2, 0.3, true]);
    });

    it('falls back to y = 0 when y is missing or null', () => {
        handleClientMessage(ID, { type: 'update', x: 1, z: 2, y: null, angle: 0, flipAngle: 0, isFlipping: false });
        expect(players[ID].y).toBe(0);
        expect(players[ID].x).toBe(1);
    });

    it('clamps positions to the world bound', () => {
        handleClientMessage(ID, { type: 'update', x: 1e9, z: -1e9, angle: 0, flipAngle: 0, isFlipping: false });
        expect(players[ID].x).toBe(550);
        expect(players[ID].z).toBe(-550);
    });

    it('renames with the server-side cleanup', () => {
        handleClientMessage(ID, { type: 'rename', name: '  Bulli\u0007Fan  ' });
        expect(players[ID].name).toBe('BulliFan');
    });

    it('accepts known car types only', () => {
        handleClientMessage(ID, { type: 'setCarType', carType: 'jeep' });
        expect(players[ID].carType).toBe('jeep');
        handleClientMessage(ID, { type: 'setCarType', carType: 'tank' });
        expect(players[ID].carType).toBe('jeep');
    });

    it('marks a player ready once', () => {
        players[ID].ready = false;
        handleClientMessage(ID, { type: 'playerReady' });
        expect(players[ID].ready).toBe(true);
    });

    it('collects a coin in range and resets it later', () => {
        vi.useFakeTimers();
        try {
            const coin = coinsById.get(0)!;
            players[ID].x = coin.x;
            players[ID].z = coin.z;
            handleClientMessage(ID, { type: 'collectCoin', coinId: 0 });
            expect(coin.collected).toBe(true);
            expect(players[ID].score).toBe(10);
            vi.runAllTimers();
            expect(coin.collected).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});
