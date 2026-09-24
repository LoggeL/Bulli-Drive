import { describe, expect, it } from 'vitest';
import {
    baseHeight, baseSample, bell, ellipseRadius, fbm, latticeValue, parseBaseTerrain, regionSurface,
    smoothstep, valueNoise, type BaseTerrain
} from '../../../tools/map/baseTerrain.js';
import { FLAT_COAST } from './fixtures.js';

// Base terrain of the bake (docs/phase-3-design.md, 6.4 step 1). Without
// noise every height below follows from the formulas by hand.

describe('smoothstep and bell', () => {
    it('eases from 0 to 1 with a flat start and end', () => {
        expect(smoothstep(-1)).toBe(0);
        expect(smoothstep(0)).toBe(0);
        expect(smoothstep(0.5)).toBe(0.5);
        expect(smoothstep(0.25)).toBe(0.15625);   // 0.0625·(3 - 0.5)
        expect(smoothstep(1)).toBe(1);
        expect(smoothstep(7)).toBe(1);
        expect(bell(0)).toBe(1);
        expect(bell(0.5)).toBe(0.5);
        expect(bell(1)).toBe(0);
        expect(bell(3)).toBe(0);
    });

    it('measures the elliptic radius along the axis and across it', () => {
        const e = { x: 100, z: 100, radii: [100, 20] as [number, number], axis: [0, 1] as [number, number] };
        expect(ellipseRadius(e, 100, 150)).toBeCloseTo(0.5, 12);
        expect(ellipseRadius(e, 150, 100)).toBeCloseTo(2.5, 12);
        expect(ellipseRadius({ ...e, axis: undefined }, 150, 100)).toBeCloseTo(0.5, 12);
    });
});

describe('noise', () => {
    it('hashes lattice points into [-1, 1)', () => {
        // All-zero input: every mixing step keeps 0, so the value is -1
        expect(latticeValue(0, 0, 0)).toBe(-1);
        let sum = 0;
        for (let i = -50; i < 50; i++) {
            for (let j = -50; j < 50; j++) {
                const v = latticeValue(i, j, 7);
                expect(v).toBeGreaterThanOrEqual(-1);
                expect(v).toBeLessThan(1);
                sum += v;
            }
        }
        // 10 000 values of a uniform hash: mean within ±0.03 (≈ 5 σ)
        expect(Math.abs(sum / 10000)).toBeLessThan(0.03);
        expect(latticeValue(3, 4, 7)).not.toBe(latticeValue(4, 3, 7));
    });

    it('takes the lattice values at integer points and blends between them', () => {
        expect(valueNoise(3, -2, 5)).toBe(latticeValue(3, -2, 5));
        const a = latticeValue(3, -2, 5), b = latticeValue(4, -2, 5);
        expect(valueNoise(3.5, -2, 5)).toBeCloseTo((a + b) / 2, 12);
    });

    it('normalises the octave sum to [-1, 1]', () => {
        for (let i = 0; i < 200; i++) {
            const v = fbm(i * 37.3, i * -11.9, 3, 480, 4, 0.5);
            expect(Math.abs(v)).toBeLessThanOrEqual(1);
        }
    });
});

describe('baseHeight', () => {
    it('drops from the water line to the sea floor over the shelf', () => {
        expect(baseHeight(FLAT_COAST, -150, 0) === 0).toBe(true);
        expect(baseHeight(FLAT_COAST, -175, 0)).toBe(-5);     // halfway: -10·S(0.5)
        expect(baseHeight(FLAT_COAST, -400, 0)).toBe(-10);
        expect(baseSample(FLAT_COAST, -175, 0).coast).toBe(-25);
    });

    it('rises over the beach, then blends into the tilted land', () => {
        expect(baseHeight(FLAT_COAST, -135, 0)).toBe(1);      // beach 2·S(0.5)
        // 150 m inland: land 4 + 0.02·150 = 7, fully blended in
        expect(baseHeight(FLAT_COAST, 0, 0)).toBeCloseTo(7, 12);
        // 40 m inland: beach 2, land 4.8, blend S((40 - 30)/20) = 0.5
        expect(baseHeight(FLAT_COAST, -110, 0)).toBeCloseTo(2 + (4.8 - 2) * 0.5, 12);
    });

    it('lets the highest hill win and a flat pull the land to its height', () => {
        const base: BaseTerrain = {
            ...FLAT_COAST,
            hills: [
                { id: 'h', x: 100, z: 100, radii: [50, 50], height: 20 },
                { id: 'low', x: 100, z: 100, radii: [60, 60], height: 5 }
            ],
            flats: [{ id: 'f', x: 400, z: 0, radii: [50, 50], height: 1, strength: 1 }]
        };
        const land = (x: number) => 4 + 0.02 * (x + 150);
        expect(baseHeight(base, 100, 100)).toBeCloseTo(land(100) + 20, 12);
        expect(baseHeight(base, 125, 100)).toBeCloseTo(land(125) + 10, 12);
        expect(baseHeight(base, 400, 0)).toBeCloseTo(1, 12);
        // Halfway out of the flat: halfway between land and 1
        expect(baseHeight(base, 425, 0)).toBeCloseTo(land(425) + (1 - land(425)) * 0.5, 12);
    });

    it('builds a cliff at the coast along its line', () => {
        const base: BaseTerrain = {
            ...FLAT_COAST,
            cliffs: [{ id: 'c', line: [[-150, -100], [-150, 100]], height: 30, face: 10, plateau: 20, fade: 20 }]
        };
        // 5 m inland on the line: the face, 30·S(0.5)
        expect(baseHeight(base, -145, 0)).toBeCloseTo(15, 12);
        expect(baseHeight(base, -135, 0)).toBeCloseTo(30, 12);
        // Past plateau + fade: plain beach again
        expect(baseHeight(base, -135, 200)).toBe(baseHeight(FLAT_COAST, -135, 200));
        // Still sea in front of the cliff
        expect(baseHeight(base, -175, 0)).toBe(-5);
    });
});

describe('base.json', () => {
    it('rejects unknown keys and reports the path', () => {
        expect(() => parseBaseTerrain({ ...FLAT_COAST, hils: [] })).toThrow(/invalid base terrain/);
        expect(() => parseBaseTerrain({ ...FLAT_COAST, sea: { floor: 3, shelf: 50 } })).toThrow(/sea\.floor/);
        expect(parseBaseTerrain(JSON.parse(JSON.stringify(FLAT_COAST)))).toEqual(FLAT_COAST);
    });

    it('overrides the surface inside regions, the last one winning', () => {
        const base: BaseTerrain = {
            ...FLAT_COAST,
            regions: [
                { id: 'a', surface: 'sand', polygon: [[0, 0], [10, 0], [10, 10], [0, 10]] },
                { id: 'b', surface: 'dirt', polygon: [[5, 5], [20, 5], [20, 20], [5, 20]] }
            ]
        };
        expect(regionSurface(base, 2, 2)).toBe('sand');
        expect(regionSurface(base, 7, 7)).toBe('dirt');
        expect(regionSurface(base, 50, 50)).toBeNull();
    });
});
