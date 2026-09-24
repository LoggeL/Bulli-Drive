import { describe, expect, it } from 'vitest';
import { setWorldColliders, setWorldOverride, simWorldFor } from '../../src/client/vehicle/simWorldClient.js';
import { state } from '../../src/client/state.js';
import { DEFAULT_TERRAIN_CONFIG } from '../../src/shared/constants.js';
import type { ColliderInput } from '../../src/shared/world/colliders.js';
import { getTerrainHeight } from '../../src/shared/world/terrain.js';
import { generateWorld } from '../../src/shared/world/worldGen.js';
import {
    collidersSha, GOLDEN_COLLIDER_COUNT, GOLDEN_COLLIDERS_SHA, GOLDEN_ROCK_COUNT, GOLDEN_ROCKS_SHA
} from '../shared/worldGolden.js';

describe('setWorldColliders', () => {
    it('uses the shared collider list of the world the server sent', () => {
        const world = generateWorld();
        setWorldColliders(world);
        // The golden list of the default world (tests/shared/colliderGen.test.ts)
        expect(state.worldColliders).toHaveLength(GOLDEN_COLLIDER_COUNT);
        expect(collidersSha(state.worldColliders)).toBe(GOLDEN_COLLIDERS_SHA);
    });

    it('offline (no city) keeps only the rocks', () => {
        setWorldColliders({ trees: [], city: null });
        expect(state.worldColliders).toHaveLength(GOLDEN_ROCK_COUNT);
        expect(state.worldColliders.every(c => c.kind === 'circle')).toBe(true);
        expect(collidersSha(state.worldColliders)).toBe(GOLDEN_ROCKS_SHA);
    });
});

describe('simWorldFor', () => {
    it('builds the world once and again when the colliders change', () => {
        const terrain = { ...DEFAULT_TERRAIN_CONFIG };
        const colliders: ColliderInput[] = [{ kind: 'circle', x: 30, z: 40, r: 1, top: 5.5 }];
        const world = simWorldFor(terrain, colliders);
        expect(simWorldFor(terrain, colliders)).toBe(world);
        expect(world.colliders[0].base).toBeCloseTo(getTerrainHeight(terrain, 30, 40), 9);
        expect(world.roads).not.toBeNull();

        const more: ColliderInput[] = [...colliders, { kind: 'box', x: 0, z: 0, hw: 5, hd: 5, top: Infinity }];
        const rebuilt = simWorldFor(terrain, more);
        expect(rebuilt).not.toBe(world);
        expect(rebuilt.colliders).toHaveLength(2);
    });

    it('hands out the race world of a race room instead, and the map world after it', () => {
        const terrain = { ...DEFAULT_TERRAIN_CONFIG };
        const colliders: ColliderInput[] = [{ kind: 'circle', x: 30, z: 40, r: 1, top: 5.5 }];
        const map = simWorldFor(terrain, colliders);
        const race = simWorldFor(terrain, []);
        setWorldOverride(race);
        expect(simWorldFor(terrain, colliders)).toBe(race);
        setWorldOverride(null);
        expect(simWorldFor(terrain, colliders)).not.toBe(race);
        expect(simWorldFor(terrain, colliders).colliders).toHaveLength(1);
        expect(map.colliders).toHaveLength(1);
    });
});
