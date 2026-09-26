import { describe, expect, it } from 'vitest';
import { railSpots } from '../../src/client/world/viewpoint.js';

// The lookout's coin telescopes stand at its lot's railing, in the corner
// towards the view (src/client/world/viewpoint.ts, docs/phase-3-design.md
// 3.3 and A66). Made-up railings, expected values by hand.

// A lot from (0, 0) to (40, 20) (centre (20, 10)), railed along the north
// side (z = 0) from west to east, then down the east side
const RAIL: [number, number][] = [[0, 0], [40, 0], [40, 20]];

describe('the rail spots', () => {
    it('start in the railing\'s corner towards the target and step along it, inside, facing the target', () => {
        // Looking north-west (towards (-1000, -1000)): the furthest railing
        // point is its west end (0, 0), reach (20 + 10) / √2; the spots go
        // east along the north side (its longer part) 2 and 4 m, then 1 m
        // towards the centre
        const spots = railSpots(RAIL, [20, 10], [-1000, -1000], 2, 2, 1);
        const at = (x: number, z: number) => {
            const l = Math.hypot(20 - x, 10 - z);
            return [x + (20 - x) / l, z + (10 - z) / l];
        };
        expect(spots[0].x).toBeCloseTo(at(2, 0)[0], 9);
        expect(spots[0].z).toBeCloseTo(at(2, 0)[1], 9);
        expect(spots[1].x).toBeCloseTo(at(4, 0)[0], 9);
        expect(spots[1].z).toBeCloseTo(at(4, 0)[1], 9);
        // Facing the target: rotation.y = atan2(dx, dz)
        expect(spots[0].yaw).toBeCloseTo(Math.atan2(-1000 - spots[0].x, -1000 - spots[0].z), 12);
    });

    it('walk back along the railing from a corner at its far end', () => {
        // Looking south-east: the furthest point is the east side's end
        // (40, 20); the spots go back up the east side, 3 m apart
        const spots = railSpots(RAIL, [20, 10], [1000, 1000], 2, 3, 0);
        expect(spots.map(s => [s.x, s.z])).toEqual([[40, 17], [40, 14]]);
    });
});
