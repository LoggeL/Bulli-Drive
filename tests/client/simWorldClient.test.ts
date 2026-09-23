import { describe, expect, it } from 'vitest';
import { obstaclesToColliders, simWorldFor } from '../../src/client/vehicle/simWorldClient.js';
import type { Obstacle } from '../../src/client/types.js';
import { DEFAULT_TERRAIN_CONFIG } from '../../src/shared/constants.js';
import { getTerrainHeight } from '../../src/shared/world/terrain.js';

describe('obstaclesToColliders', () => {
    it('turns buildings into boxes and everything else into circles', () => {
        const obstacles: Obstacle[] = [
            { type: 'rect', x: 10, z: 20, halfWidth: 6, halfDepth: 4, top: Infinity },
            { x: 1, z: 2, radius: 0.35, top: 3.3 },
            { type: 'circle', x: -5, z: 7, radius: 1.5 }
        ];
        expect(obstaclesToColliders(obstacles)).toEqual([
            { kind: 'box', x: 10, z: 20, hw: 6, hd: 4, top: Infinity },
            { kind: 'circle', x: 1, z: 2, r: 0.35, top: 3.3 },
            // Without a top it cannot be jumped over
            { kind: 'circle', x: -5, z: 7, r: 1.5, top: Infinity }
        ]);
    });
});

describe('simWorldFor', () => {
    it('builds the world once and again when the obstacles change', () => {
        const terrain = { ...DEFAULT_TERRAIN_CONFIG };
        const obstacles: Obstacle[] = [{ x: 30, z: 40, radius: 1, top: 5.5 }];
        const world = simWorldFor(terrain, obstacles);
        expect(simWorldFor(terrain, obstacles)).toBe(world);
        expect(world.colliders[0].base).toBeCloseTo(getTerrainHeight(terrain, 30, 40), 9);
        expect(world.roads).not.toBeNull();

        obstacles.push({ type: 'rect', x: 0, z: 0, halfWidth: 5, halfDepth: 5 });
        const rebuilt = simWorldFor(terrain, obstacles);
        expect(rebuilt).not.toBe(world);
        expect(rebuilt.colliders).toHaveLength(2);
    });
});
