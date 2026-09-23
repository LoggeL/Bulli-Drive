import { describe, expect, it } from 'vitest';
import { DEFAULT_TERRAIN_CONFIG } from '../../src/shared/constants.js';
import { CITY_TERRAIN_AREA, getTerrainHeight } from '../../src/shared/world/terrain.js';
import { sha256OfFloats } from '../helpers.js';

// Golden heights were recorded from getTerrainHeight in the untouched
// src/client/world/environment.ts on main (1d39c07) with DEFAULT_TERRAIN_CONFIG.
// Math.sin/cos are not bit-identical across platforms (macOS arm64 vs Linux x64
// in CI), so heights are compared to 1e-9 and hashed after quantizing to 1 µm.

const config = DEFAULT_TERRAIN_CONFIG;

describe('getTerrainHeight', () => {
    it('matches golden heights at sample points', () => {
        const samples: [number, number, number][] = [
            [0, 0, 0],
            [6, 6, 0],
            [100, 100, 0],
            [150, 0, 0],
            [0, 175, 0.0334091616324985],
            [170, 30, 0.01731739252759269],
            [-190, 20, 0.5948250981374444],
            [200, -150, 11.969643203813538],
            [-300, 250, -7.307583925056373],
            [400, 400, 2.633672531957854],
            [-499.5, 12.25, 4.370726708950764],
            [500, -500, -5.303919302495025],
            [123.456, -321.987, 4.106825793349897]
        ];
        for (const [x, z, h] of samples) {
            expect(getTerrainHeight(config, x, z), `height at (${x}, ${z})`).toBeCloseTo(h, 9);
        }
    });

    it('matches the golden hash over the full vertex grid', () => {
        const { size, segments } = config;
        const heights: number[] = [];
        for (let iz = 0; iz <= segments; iz++) {
            for (let ix = 0; ix <= segments; ix++) {
                heights.push(Math.round(getTerrainHeight(config, -size / 2 + ix * size / segments, -size / 2 + iz * size / segments) * 1e6));
            }
        }
        expect(sha256OfFloats(heights)).toBe('72caa9afcbc2b602bfa09876a4225a2d7947cfc8d2ec02d0f9f0f94bf125b592');
    });

    it('keeps the golden city flattening area', () => {
        expect(CITY_TERRAIN_AREA.centerX).toBe(6);
        expect(CITY_TERRAIN_AREA.centerZ).toBe(6);
        expect(CITY_TERRAIN_AREA.flatRadius).toBe(164.04877323527904);
        expect(CITY_TERRAIN_AREA.halfExtent).toBe(116);
    });

    it('treats a missing third octave as zero', () => {
        const twoOctaves = { ...config, frequency3: undefined, amplitude3: undefined } as unknown as typeof config;
        const noThird = { ...config, amplitude3: 0 };
        expect(getTerrainHeight(twoOctaves, 300, -250)).toBe(getTerrainHeight(noThird, 300, -250));
    });
});
