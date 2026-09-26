import { describe, expect, it } from 'vitest';
import { LOOK, SUN_DIRECTION } from '../../src/client/render/look.js';

// The client's sun is the map's (map.json lighting, docs/phase-3-design.md
// A38): the evening sun over the Pacific, west-north-west at 17°.

describe('the sun of the look', () => {
    it('stands where map.json puts it: compass 285°, 17° up', () => {
        expect(LOOK.sunElevation).toBe(17);
        // Compass 285° is look azimuth 180 - 285 = -105 = 255
        expect(LOOK.sunAzimuth).toBe(255);
        // By hand: (sin 285° cos 17°, sin 17°, -cos 285° cos 17°)
        // = (-0.96593 · 0.95630, 0.29237, -0.25882 · 0.95630)
        expect(SUN_DIRECTION.x).toBeCloseTo(-0.92372, 4);
        expect(SUN_DIRECTION.y).toBeCloseTo(0.29237, 4);
        expect(SUN_DIRECTION.z).toBeCloseTo(-0.24751, 4);
    });

    it('sets over the sea: west (-x) of the town, a little to the north', () => {
        expect(SUN_DIRECTION.x).toBeLessThan(0);
        expect(Math.abs(SUN_DIRECTION.x)).toBeGreaterThan(Math.abs(SUN_DIRECTION.z) * 3);
        expect(SUN_DIRECTION.z).toBeLessThan(0);
    });
});
