import { describe, expect, it } from 'vitest';
import { positionHash } from '../../src/shared/math/rng.js';
import { generateWorld, WORLD_SEED } from '../../src/shared/world/worldGen.js';
import { sha256, sha256OfFloats, stableStringify } from '../helpers.js';

// Golden values were recorded by running initWorld() from the untouched
// src/server/world.ts on main (1d39c07). Any drift means the extracted
// generator no longer produces the world players have been driving in.

describe('generateWorld (seed 0xB0111D)', () => {
    const world = generateWorld();

    it('uses the server seed by default', () => {
        expect(WORLD_SEED).toBe(0xB0111D);
        expect(stableStringify(generateWorld(WORLD_SEED))).toBe(stableStringify(world));
    });

    it('produces the golden item counts', () => {
        expect({
            buildings: world.city.buildings.length,
            roads: world.city.roads.length,
            trees: world.trees.length,
            coins: world.coins.length,
            powerups: world.powerups.length
        }).toEqual({ buildings: 30, roads: 10, trees: 120, coins: 30, powerups: 25 });
    });

    it('matches the golden hash of the whole world payload', () => {
        expect(sha256(stableStringify(world.city))).toBe('8ccdc1213fc24c9db3dc48ccfb47390e6345ce264074ca3f8f1f589ce9f1ec6a');
        expect(sha256(stableStringify(world))).toBe('e2255cf50f1dbf97a3ecc33e9a47e1eaaddfbf5b6ff7590293080627723cbe20');
    });

    it('matches golden sample entries', () => {
        expect(world.city.buildings[0]).toEqual({
            x: -80.5,
            z: -80.5,
            width: 13.858557746978477,
            depth: 8.330562203424051,
            height: 22.00423071999103,
            color: 11060896
        });
        expect(world.trees[world.trees.length - 1]).toEqual({
            id: 119,
            x: 58.89272368513048,
            z: 212.8131320234388,
            height: 8.459782259073108
        });
        expect(world.powerups.map(p => p.type)).toEqual([
            'jump', 'jump', 'speed', 'shield', 'magnet', 'size', 'speed', 'size', 'jump', 'shield',
            'ghost', 'size', 'jump', 'size', 'speed', 'magnet', 'shield', 'size', 'shield', 'ghost',
            'ghost', 'jump', 'ghost', 'size', 'ghost'
        ]);
    });

    it('keeps the client building details stable', () => {
        // city.ts derives windows, awnings and roof props from these hashes.
        const values = world.city.buildings.flatMap(b => [0, 1, 2].map(salt => positionHash(b.x, b.z, salt)));
        expect(sha256OfFloats(values)).toBe('b076131e0b32b04c427e456ebf52f296bf6a8ad79936e0f682250356488dc080');
    });

    it('is deterministic and starts every item uncollected', () => {
        expect(stableStringify(generateWorld())).toBe(stableStringify(world));
        expect(world.coins.every(c => !c.collected)).toBe(true);
        expect(world.powerups.every(p => !p.collected)).toBe(true);
    });

    it('produces a different world for a different seed', () => {
        expect(stableStringify(generateWorld(1))).not.toBe(stableStringify(world));
    });
});
