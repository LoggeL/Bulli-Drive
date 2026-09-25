import { describe, expect, it } from 'vitest';
import {
    baseHeight, baseSample, bell, ellipseRadius, fbm, latticeValue, noiseAmplitude, parseBaseTerrain,
    nearestWithin, polylineNearest, regionSurface, RIDGE_STEPS, ridgedFbm, smoothRidgeLine, smoothstep, terrainNoise, valueNoise, WARP_SEED_X, WARP_SEED_Z, type BaseTerrain
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

describe('ridges and canyons', () => {
    const land = (x: number) => 4 + 0.02 * (x + 150);

    it('finds the nearest point of a line and interpolates its height', () => {
        const line: [number, number, number][] = [[0, 0, 10], [100, 0, 30], [100, 100, 30]];
        expect(polylineNearest(line, 50, 20)).toEqual({ distance: 20, value: 20 });
        expect(polylineNearest(line, 130, 50)).toEqual({ distance: 30, value: 30 });
        // Beyond the first vertex: its distance and height
        expect(polylineNearest(line, -30, 40)).toEqual({ distance: 50, value: 10 });
    });

    it('smooths a ridge line through its vertices, the height linear per segment', () => {
        const line: [number, number, number][] = [[0, 0, 10], [100, 0, 30], [100, 100, 50]];
        const dense = smoothRidgeLine(line);
        expect(dense).toHaveLength(1 + 2 * RIDGE_STEPS);
        expect(dense[0]).toEqual([0, 0, 10]);
        expect(dense[RIDGE_STEPS]).toEqual([100, 0, 30]);
        expect(dense.at(-1)).toEqual([100, 100, 50]);
        // Half-way along the first segment: height 20. It runs through the
        // corner with the tangent (1, 1)/√2, so it swings out of the chord
        // (z < 0) just before it instead of a sharp kink
        expect(dense[RIDGE_STEPS / 2][2]).toBe(20);
        expect(dense[RIDGE_STEPS * 3 / 4][1]).toBeLessThan(-1);
    });

    it('finds through its cell index the same nearest point as a search over all segments', () => {
        const dense = smoothRidgeLine([[0, 0, 10], [120, 40, 30], [150, 180, 60], [40, 260, 20]]);
        const reach = 45;
        let checked = 0;
        // Points on a 7 m lattice, offset so many lie near cell corners
        for (let x = -60; x <= 220; x += 7) {
            for (let z = -60; z <= 330; z += 7) {
                const all = polylineNearest(dense, x + 0.3, z - 0.2);
                const indexed = nearestWithin(dense, reach, x + 0.3, z - 0.2);
                if (all.distance <= reach) {
                    expect(indexed).toEqual(all);
                    checked++;
                } else {
                    expect(indexed).toBeNull();
                }
            }
        }
        expect(checked).toBeGreaterThan(300);
    });

    it('raises a ridge along its line with the bell profile, the highest of ridges and hills winning', () => {
        const base: BaseTerrain = {
            ...FLAT_COAST,
            ridges: [{ id: 'r', line: [[0, -100, 20], [0, 100, 60]], width: 40 }],
            hills: [{ id: 'h', x: 0, z: 0, radii: [30, 30], height: 50 }]
        };
        // On the crest at z = -50: 20 + 40 · 0.25 = 30 (the hill is 0 there)
        expect(baseHeight(base, 0, -50)).toBeCloseTo(land(0) + 30, 12);
        // 20 m beside it, half the width: bell(0.5) = half of that
        expect(baseHeight(base, 20, -50)).toBeCloseTo(land(20) + 30 * 0.5, 12);
        // 10 m: smoothstep(0.75) = 0.84375
        expect(baseHeight(base, 10, -50)).toBeCloseTo(land(10) + 30 * 0.84375, 12);
        // At the hill's centre the hill (50) beats the ridge (40)
        expect(baseHeight(base, 0, 0)).toBeCloseTo(land(0) + 50, 12);
        // At z = 50 the ridge (50) beats the hill (0 beyond its radius)
        expect(baseHeight(base, 0, 50)).toBeCloseTo(land(0) + 50, 12);
        expect(baseHeight(base, 45, 50)).toBeCloseTo(land(45), 12);
    });

    it('cuts a canyon along its line with the bell profile', () => {
        const base: BaseTerrain = { ...FLAT_COAST, canyons: [{ id: 'c', line: [[100, -100], [100, 100]], depth: 12, width: 30 }] };
        expect(baseHeight(base, 100, 0)).toBeCloseTo(land(100) - 12, 12);
        // Half the width: bell(0.5) = 0.5
        expect(baseHeight(base, 115, 0)).toBeCloseTo(land(115) - 6, 12);
        expect(baseHeight(base, 131, 0)).toBeCloseTo(land(131), 12);
    });
});

describe('noise mix, warp and regions', () => {
    const noise = FLAT_COAST.noise;

    it('keeps ridged noise in [-1, 1], sharp at the crests: 1 where the value noise is 0', () => {
        for (let i = 0; i < 300; i++) {
            const v = ridgedFbm(i * 13.7, i * -5.1, 9, 120, 3, 0.5);
            expect(Math.abs(v)).toBeLessThanOrEqual(1);
        }
        // One octave at a lattice point: r = (1 - |lattice value|)², mapped
        // to 2r - 1, from the same lattice as fbm
        const lattice = latticeValue(2, 3, 9);
        expect(ridgedFbm(2 * 50, 3 * 50, 9, 50, 1, 0.5)).toBeCloseTo(2 * (1 - Math.abs(lattice)) ** 2 - 1, 12);
    });

    it('mixes plain and ridged noise by `ridged` and warps the position', () => {
        const at = (x: number, z: number) => fbm(x, z, 4, 480, 4, 0.5);
        expect(terrainNoise({ ...noise, amplitude: 1 }, 4, 123, 456)).toBe(at(123, 456));
        const both = terrainNoise({ ...noise, amplitude: 1, ridged: 0.5 }, 4, 123, 456);
        expect(both).toBeCloseTo((at(123, 456) + ridgedFbm(123, 456, 4, 480, 4, 0.5)) / 2, 12);
        // A warp of 0 changes nothing; a real one moves the reading point
        expect(terrainNoise({ ...noise, warp: { amplitude: 0, wavelength: 200 } }, 4, 123, 456)).toBe(at(123, 456));
        // Moved by 80 m times two independent 2-octave noises, one per axis
        const dx = 80 * fbm(123, 456, 4 + WARP_SEED_X, 200, 2, 0.5), dz = 80 * fbm(123, 456, 4 + WARP_SEED_Z, 200, 2, 0.5);
        expect(Math.abs(dx - dz)).toBeGreaterThan(1);
        expect(terrainNoise({ ...noise, warp: { amplitude: 80, wavelength: 200 } }, 4, 123, 456)).toBe(at(123 + dx, 456 + dz));
    });

    it('blends the amplitude across a region\'s outline: half on it, all of it blend / 2 inside', () => {
        const regions = [{ id: 'hills', polygon: [[0, 0], [100, 0], [100, 100], [0, 100]] as [number, number][], amplitude: 12, blend: 40 }];
        const n = { ...noise, amplitude: 2, regions };
        expect(noiseAmplitude(n, 50, 50)).toBe(12);
        expect(noiseAmplitude(n, 100, 50)).toBe(7);
        expect(noiseAmplitude(n, 120, 50)).toBe(2);
        // 10 m outside: smoothstep(0.25) = 0.15625 of the way
        expect(noiseAmplitude(n, 110, 50)).toBeCloseTo(2 + 10 * 0.15625, 12);
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
