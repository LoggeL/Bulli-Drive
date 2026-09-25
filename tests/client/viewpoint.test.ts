import { describe, expect, it } from 'vitest';
import { crestSpots } from '../../src/client/world/viewpoint.js';

// The lookout's coin telescopes stand on the crest towards the view
// (src/client/world/viewpoint.ts, docs/phase-3-design.md 3.3 and A66).
// A made-up ground, expected values by hand.

// A cone 20 m high at (0, 40), falling 0.5 m per metre, and a higher one
// (40 m) at (0, 150), beyond the search
const ground = (x: number, z: number) => Math.max(
    20 - 0.5 * Math.hypot(x, z - 40),
    40 - 0.5 * Math.hypot(x, z - 150),
    0
);

describe('the crest spots', () => {
    it('stand on the highest ground between near and far on the way to the target, across the view', () => {
        // Looking north along +z from (0, 0): the crest at 40 m; two spots
        // 2 m apart across the view, (-dz, dx) = (-1, 0)
        const spots = crestSpots(ground, [0, 0], [0, 1000], 10, 80, 2, 2);
        expect(spots.map(s => [s.x, s.z])).toEqual([[1, 40], [-1, 40]]);
        // Facing the target: rotation.y = atan2(dx, dz)
        expect(spots[0].yaw).toBeCloseTo(Math.atan2(-1, 960), 12);
    });

    it('keep to the search range and follow a diagonal view', () => {
        // From (30, -40) along (-0.6, 0.8): the ray comes closest to the
        // cone's top 82 m out ((0 - 30) · -0.6 + (40 + 40) · 0.8), so the
        // ground still rises at far = 80 m, where the search stops; the
        // higher cone lies far outside the range
        const spots = crestSpots(ground, [30, -40], [-570, 760], 10, 80, 1, 2);
        expect(spots[0].x).toBeCloseTo(30 - 0.6 * 80, 9);
        expect(spots[0].z).toBeCloseTo(-40 + 0.8 * 80, 9);
    });
});
