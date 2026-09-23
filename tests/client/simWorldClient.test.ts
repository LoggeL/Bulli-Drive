import { describe, expect, it } from 'vitest';
import { collidersToObstacles, setWorldColliders, simWorldFor } from '../../src/client/vehicle/simWorldClient.js';
import { state } from '../../src/client/state.js';
import { DEFAULT_TERRAIN_CONFIG } from '../../src/shared/constants.js';
import { buildWorldColliders } from '../../src/shared/world/colliderGen.js';
import type { ColliderInput } from '../../src/shared/world/colliders.js';
import { getTerrainHeight } from '../../src/shared/world/terrain.js';
import { generateWorld } from '../../src/shared/world/worldGen.js';

describe('collidersToObstacles', () => {
    it('turns boxes into rects and circles into circles for the legacy physics', () => {
        const colliders: ColliderInput[] = [
            { kind: 'box', x: 10, z: 20, hw: 6, hd: 4, top: Infinity },
            { kind: 'circle', x: 1, z: 2, r: 0.35, top: 3.3 }
        ];
        expect(collidersToObstacles(colliders)).toEqual([
            { type: 'rect', x: 10, z: 20, halfWidth: 6, halfDepth: 4, top: Infinity },
            { x: 1, z: 2, radius: 0.35, top: 3.3 }
        ]);
    });
});

describe('setWorldColliders', () => {
    it('uses the shared collider list of the world the server sent', () => {
        const world = generateWorld();
        setWorldColliders(world);
        expect(state.worldColliders).toEqual(buildWorldColliders(world));
        expect(state.obstacles).toHaveLength(state.worldColliders.length);
    });

    it('offline (no city) keeps only the rocks', () => {
        setWorldColliders({ trees: [], city: null });
        expect(state.worldColliders.length).toBeGreaterThan(0);
        expect(state.worldColliders.every(c => c.kind === 'circle')).toBe(true);
        expect(state.worldColliders).toEqual(buildWorldColliders({ trees: [], city: null }));
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
});
