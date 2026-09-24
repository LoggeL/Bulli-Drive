import { describe, expect, it } from 'vitest';
import { createFlatWorld } from '../../src/shared/sim/scenarios.js';
import { insideRamp, rampEdgeColliders, rampSurfaceNear, type RampDef } from '../../src/shared/world/colliders.js';

// Ramp geometry (docs/phase-1a-design.md, 7.2): forward f = (sin yaw,
// cos yaw) runs up the ramp, left l = (cos yaw, -sin yaw) across it; the
// surface rises linearly from 0 at the back edge to the height at the
// front edge.

// A ramp turned by 30°, 4 m wide, 8 m long, 2 m high
const ramp: RampDef = { x: 10, z: 20, yaw: Math.PI / 6, width: 4, length: 8, height: 2 };
const f = { x: Math.sin(ramp.yaw), z: Math.cos(ramp.yaw) };
const l = { x: Math.cos(ramp.yaw), z: -Math.sin(ramp.yaw) };
const at = (along: number, across: number) => ({ x: ramp.x + f.x * along + l.x * across, z: ramp.z + f.z * along + l.z * across });

describe('ramp surface', () => {
    it('covers its footprint in the ramp frame, at any heading', () => {
        const world = createFlatWorld([], [ramp]);
        for (const [along, across, inside] of [
            [2, 1.5, true], [2, -1.5, true], [-3.9, 1.9, true], [2, 2.1, false], [2, -2.1, false], [4.1, 0, false], [-4.1, 0, false]
        ] as const) {
            const p = at(along, across);
            expect(insideRamp(ramp, p.x, p.z), `${along}, ${across}`).toBe(inside);
            expect(world.rampAt(p.x, p.z), `${along}, ${across}`).toBe(inside ? 0 : -1);
        }
        // 2 m up the 8 m ramp from its centre: 2 · (2/8 + 1/2) = 1.5 m
        const p = at(2, 1.5);
        expect(world.groundHeight(p.x, p.z)).toBeCloseTo(1.5, 12);
    });

    it('gives the surface height at the nearest point of the footprint', () => {
        const world = createFlatWorld([], [ramp]);
        const behind = at(-20, 0), ahead = at(20, 5), mid = at(2, 9);
        expect(rampSurfaceNear(world, 0, behind.x, behind.z)).toBeCloseTo(0, 12);
        expect(rampSurfaceNear(world, 0, ahead.x, ahead.z)).toBeCloseTo(2, 12);
        expect(rampSurfaceNear(world, 0, mid.x, mid.z)).toBeCloseTo(1.5, 12);
    });
});

describe('ramp edge walls', () => {
    it('leaves out side pieces below 0.3 m, keeps one of exactly 0.3 m', () => {
        // 8 m long: two side pieces per side, as high as the ramp at their
        // upper end: 0.3 and 0.6 m
        const walls = rampEdgeColliders({ x: 0, z: 0, yaw: 0, width: 4, length: 8, height: 0.6 }, 0, false);
        expect(walls.map(w => w.top).sort()).toEqual([0.3, 0.3, 0.6, 0.6]);
        const lower = rampEdgeColliders({ x: 0, z: 0, yaw: 0, width: 4, length: 8, height: 0.58 }, 0, false);
        expect(lower.map(w => w.top)).toEqual([0.58, 0.58]);
    });

    it('puts the side walls on both sides and the front wall ahead, for a ramp facing +x', () => {
        const walls = rampEdgeColliders({ x: 10, z: 20, yaw: Math.PI / 2, width: 4, length: 8, height: 2 }, 5);
        const front = walls[0];
        expect(front).toEqual(expect.objectContaining({ x: 10 + 4 + 0.25, z: 20, hw: 0.25, hd: 2 + 0.5, top: 2, ramp: 5 }));
        const sides = walls.slice(1);
        expect(new Set(sides.map(w => w.z))).toEqual(new Set([20 + 2.25, 20 - 2.25]));
        expect(sides.every(w => w.hd === 0.25 && w.hw === 2)).toBe(true);
    });
});
