import { beforeEach, describe, expect, it } from 'vitest';
import { FLAT_TERRAIN } from '../../src/shared/sim/scenarios.js';
import type { TerrainConfig } from '../../src/shared/protocol.js';
import { createSimWorld, rampEdgeColliders, rampSurfaceNear, type RampDef } from '../../src/shared/world/colliders.js';
import { getTerrainHeight } from '../../src/shared/world/terrain.js';

// A ramp's base is the terrain at the middle of its rear edge
// (docs/phase-2-design.md, 5.5), so on a slope it starts flush with the
// ground behind it; its edge walls reach the ramp's surface above the
// terrain at each wall. Expected heights come from the terrain function
// (an independent reference) plus the ramp's linear rise.

// One wave along x only, far from the flattened city: 5·sin(0.01·x) + 5
const SLOPE: TerrainConfig = { ...FLAT_TERRAIN, frequency1: 0.01, amplitude1: 5 };
const terrain = (x: number, z: number) => getTerrainHeight(SLOPE, x, z);

// Facing +x, rear edge at x = 394, front edge at x = 406; the ground falls
// towards +x there (5·sin(3.94) = -3.57, 5·sin(4.06) = -3.96)
const ramp: RampDef = { x: 400, z: 0, yaw: Math.PI / 2, width: 8, length: 12, height: 2 };

describe('ramp base on a slope', () => {
    const build = () => createSimWorld(SLOPE, rampEdgeColliders(ramp, 0, true, terrain), [ramp]);
    let world = build();
    beforeEach(() => { world = build(); });
    const base = terrain(394, 0);

    it('starts flush with the terrain at the middle of the rear edge', () => {
        expect(terrain(394, 0)).not.toBeCloseTo(terrain(400, 0), 1);
        expect(world.rampBases).toEqual([base]);
        expect(world.groundHeight(394 + 1e-9, 0)).toBeCloseTo(base, 6);
        // Halfway up: base + 1 m, not the terrain under the centre + 1 m
        expect(world.groundHeight(400, 0)).toBeCloseTo(base + 1, 12);
        expect(world.groundHeight(406 - 1e-9, 0)).toBeCloseTo(base + 2, 6);
        expect(rampSurfaceNear(world, 0, 300, 0)).toBeCloseTo(base, 12);
        expect(rampSurfaceNear(world, 0, 500, 0)).toBeCloseTo(base + 2, 12);
    });

    it('raises every edge wall to the ramp surface above the terrain at the wall', () => {
        // Front wall across the full width at the top, side pieces of 4 m at
        // 1/3, 2/3 and 3/3 of the height, one each side
        expect(world.colliders).toHaveLength(7);
        const [front, ...sides] = world.colliders;
        expect(front.base).toBeCloseTo(terrain(front.x, front.z), 12);
        expect(front.base + front.top).toBeCloseTo(base + 2, 12);
        for (const wall of sides) {
            const piece = Math.round((wall.x - 394 + 2) / 4);   // 1, 2, 3 from the rear
            expect(wall.base).toBeCloseTo(terrain(wall.x, wall.z), 12);
            expect(wall.base + wall.top, `piece ${piece}`).toBeCloseTo(base + 2 * piece / 3, 12);
        }
    });
});

describe('ramp base on flat ground', () => {
    it('is unchanged: the walls are as high as the ramp and the base is 0', () => {
        const flatRamp: RampDef = { x: 10, z: 20, yaw: 0, width: 4, length: 8, height: 2 };
        expect(rampEdgeColliders(flatRamp, 3)).toEqual(rampEdgeColliders(flatRamp, 3, true, () => 0));
        expect(rampEdgeColliders(flatRamp, 3).map(w => w.top)).toEqual([2, 1, 1, 2, 2]);
        expect(createSimWorld(FLAT_TERRAIN, [], [flatRamp]).rampBases).toEqual([0]);
    });
});
