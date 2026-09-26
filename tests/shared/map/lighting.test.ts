import { describe, expect, it } from 'vitest';
import { lookAzimuth, sunDirection } from '../../../src/shared/map/lighting.js';

// The map's sun (map.json `lighting`) in compass degrees, north = -z and
// east = +x (design E2), and its azimuth in the convention of the client's
// look.ts: direction (sin a · cos e, sin e, cos a · cos e).

describe('lighting', () => {
    it('points the sun west for azimuth 270, north for 0, east for 90', () => {
        const flat = (azimuth: number) => sunDirection({ sunAzimuth: azimuth, sunElevation: 0 }).map(v => +v.toFixed(12) + 0);
        expect(flat(270)).toEqual([-1, 0, 0]);
        expect(flat(0)).toEqual([0, 0, -1]);
        expect(flat(90)).toEqual([1, 0, 0]);
        expect(flat(180)).toEqual([0, 0, 1]);
    });

    it('lifts it by the elevation', () => {
        // 30°: sin = 0.5, cos = 0.866
        const [x, y, z] = sunDirection({ sunAzimuth: 270, sunElevation: 30 });
        expect(x).toBeCloseTo(-Math.sqrt(3) / 2, 12);
        expect(y).toBeCloseTo(0.5, 12);
        expect(z).toBeCloseTo(0, 12);
    });

    it('converts to the azimuth of look.ts (measured from +z towards +x)', () => {
        // Today's look: 28° = towards +x and +z, i.e. south-south-east = compass 152°
        expect(lookAzimuth(152)).toBe(28);
        // West-north-west, compass 285°: look 255°, sin 255° = -0.966 (west),
        // cos 255° = -0.259 (north, -z)
        expect(lookAzimuth(285)).toBe(255);
        expect(lookAzimuth(270)).toBe(270);
        expect(lookAzimuth(0)).toBe(180);
        const look = 255 * Math.PI / 180;
        const [x, , z] = sunDirection({ sunAzimuth: 285, sunElevation: 0 });
        expect(x).toBeCloseTo(Math.sin(look), 12);
        expect(z).toBeCloseTo(Math.cos(look), 12);
    });
});
