import { describe, expect, it } from 'vitest';
import { blurChannel, splatTexel } from '../../src/client/world/terrainSplat.js';
import { SURFACE, ZONE } from '../../src/shared/map/types.js';

// The terrain's blend weights from the baked surfaces
// (src/client/world/terrainSplat.ts, docs/phase-3-design.md 8.1)

function texel(surface: number, zone: number = ZONE.wild): { a: number[]; b: number[] } {
    const a = new Uint8Array(4), b = new Uint8Array(4);
    splatTexel(surface, zone, a, b, 0);
    return { a: [...a], b: [...b] };
}

describe('splat weights', () => {
    it('give each surface its layer', () => {
        expect(texel(SURFACE.sand)).toEqual({ a: [255, 0, 0, 0], b: [0, 0, 0, 0] });
        expect(texel(SURFACE.wetSand)).toEqual({ a: [255, 255, 0, 0], b: [0, 0, 0, 0] });
        expect(texel(SURFACE.water)).toEqual({ a: [255, 255, 0, 0], b: [0, 0, 0, 0] });
        expect(texel(SURFACE.dirt)).toEqual({ a: [0, 0, 255, 0], b: [0, 0, 0, 0] });
        expect(texel(SURFACE.gravel)).toEqual({ a: [0, 0, 0, 255], b: [0, 0, 0, 0] });
        expect(texel(SURFACE.rock)).toEqual({ a: [0, 0, 0, 0], b: [255, 0, 0, 0] });
        // Under roads and lots packed earth
        for (const s of [SURFACE.asphalt, SURFACE.concrete, SURFACE.wood]) expect(texel(s).b[2]).toBe(255);
    });

    it('turn grass into lawns in the residential streets and the park only', () => {
        expect(texel(SURFACE.grass, ZONE.residential).b[1]).toBe(255);
        expect(texel(SURFACE.grass, ZONE.park).b[1]).toBe(255);
        expect(texel(SURFACE.grass, ZONE.hills)).toEqual({ a: [0, 0, 0, 0], b: [0, 0, 0, 0] });
        // Sand in a residential street stays sand
        expect(texel(SURFACE.sand, ZONE.residential).b[1]).toBe(0);
    });

    it('blur a channel with a box of 2r + 1, rows then columns', () => {
        // A single 255 in the middle of 5 × 5, radius 1: 85 on its row, then
        // 85 / 3 = 28.3 on the 3 × 3 around it
        const data = new Uint8Array(25 * 4);
        data[12 * 4 + 1] = 255;
        data[12 * 4] = 7;
        blurChannel(data, 5, 5, 1, 1);
        for (let j = 0; j < 5; j++) {
            for (let i = 0; i < 5; i++) {
                const inside = Math.abs(i - 2) <= 1 && Math.abs(j - 2) <= 1;
                expect(data[(j * 5 + i) * 4 + 1], `${i}, ${j}`).toBe(inside ? 28 : 0);
            }
        }
        // The other channels stay
        expect(data[12 * 4]).toBe(7);
    });
});
