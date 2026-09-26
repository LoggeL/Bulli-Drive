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

    it('varies a cliff\'s face along the coast only within its plain width: headlands, bays and gullies', () => {
        // Face 10 m: the edge comes up to 35 % closer to the sea (6.5 .. 10 m
        // from the coast), the foot up to 4 m inland; the coast is x = -150
        const vary = { face: 0.35, wavelength: 90, gullies: 4, gullyWavelength: 40 };
        const base: BaseTerrain = {
            ...FLAT_COAST,
            cliffs: [{ id: 'c', line: [[-150, -300], [-150, 300]], height: 30, face: 10, plateau: 20, fade: 20, vary }]
        };
        const edges: number[] = [], feet: number[] = [];
        for (let z = -250; z <= 250; z += 5) {
            // Metres from the coast where the face reaches the top and leaves the foot
            let edge = -1, foot = -1, last = -Infinity;
            for (let d = 0; d <= 12; d += 0.1) {
                const h = baseHeight(base, -150 + d, z);
                expect(h).toBeGreaterThanOrEqual(last - 1e-9);
                last = h;
                if (h <= 1e-9) foot = d;
                if (edge < 0 && h >= 30 - 1e-9) edge = d;
            }
            edges.push(edge);
            feet.push(foot);
            // At and beyond the plain face width the plateau is untouched
            expect(baseHeight(base, -140, z)).toBeCloseTo(30, 9);
            expect(baseHeight(base, -130, z)).toBeCloseTo(30, 9);
        }
        for (const edge of edges) expect(edge).toBeGreaterThanOrEqual(6.5 - 0.1);
        for (const edge of edges) expect(edge).toBeLessThanOrEqual(10 + 1e-9);
        for (const foot of feet) expect(foot).toBeLessThanOrEqual(4 + 1e-9);
        // It does vary: headlands and bays more than a metre apart, gullies
        expect(Math.max(...edges) - Math.min(...edges)).toBeGreaterThan(1);
        expect(Math.max(...feet) - Math.min(...feet)).toBeGreaterThan(1);
    });
});

describe('the irregular cliff: headlands, height, the face weight', () => {
    // Coast x = -150, cliff 30 m high over a 10 m face, 20 m plateau
    const cliff = (vary: NonNullable<BaseTerrain['cliffs'][number]['vary']>): BaseTerrain => ({
        ...FLAT_COAST,
        cliffs: [{ id: 'c', line: [[-150, -300], [-150, 300]], height: 30, face: 10, plateau: 20, fade: 20, vary }]
    });
    const plain = { face: 0.35, wavelength: 90, gullies: 0, gullyWavelength: 40 };

    it('lets the foot reach up to `headlands` m into the sea where the edge comes out, the sea floor elsewhere', () => {
        const base = cliff({ ...plain, headlands: 8 });
        let headland = 0, open = 0;
        for (let z = -250; z <= 250; z += 5) {
            // 4 m out into the sea: land on a headland, the sea floor else
            const h = baseHeight(base, -154, z);
            if (h > 0) headland++;
            else { expect(h).toBe(baseHeight(FLAT_COAST, -154, z)); open++; }
            // Never beyond the headlands' reach
            expect(baseHeight(base, -158.5, z)).toBe(baseHeight(FLAT_COAST, -158.5, z));
        }
        expect(headland).toBeGreaterThan(5);
        expect(open).toBeGreaterThan(5);
        // Without headlands the sea stays sea
        for (let z = -250; z <= 250; z += 5) expect(baseHeight(cliff(plain), -154, z)).toBe(baseHeight(FLAT_COAST, -154, z));
    });

    it('varies the height by up to its share on the face and the edge, back to the plain height `heightReach` m inland', () => {
        const base = cliff({ ...plain, height: 0.4, heightWavelength: 60, heightReach: 15 });
        const tops: number[] = [];
        for (let z = -250; z <= 250; z += 5) {
            // 12 m inland: beyond every edge (at most 10 m), within the reach
            const h = baseHeight(base, -138, z);
            expect(h).toBeGreaterThanOrEqual(30 * 0.6 - 1e-9);
            expect(h).toBeLessThanOrEqual(30 * 1.4 + 1e-9);
            tops.push(h);
            // From face (10) + reach (15) = 25 m inland on: the plain cliff
            expect(baseHeight(base, -125, z)).toBe(baseHeight(cliff(plain), -125, z));
            expect(baseHeight(base, -115, z)).toBe(baseHeight(cliff(plain), -115, z));
        }
        expect(Math.max(...tops) - Math.min(...tops)).toBeGreaterThan(6);
    });

    it('keeps the height where the bake\'s keep weight is 0 (roads), half of it at 0.5', () => {
        const base = cliff({ ...plain, height: 0.4, heightWavelength: 60, heightReach: 15 });
        for (let z = -250; z <= 250; z += 25) {
            expect(baseSample(base, -138, z, () => 0).height).toBeCloseTo(30, 9);
            const full = baseSample(base, -138, z).height - 30;
            expect(baseSample(base, -138, z, () => 0.5).height - 30).toBeCloseTo(full / 2, 9);
        }
    });

    it('weighs a point as cliff face (no embankment fill) on the face and at its foot, not on the plateau', () => {
        const base = cliff(plain);
        // At the foot (coast 0) and in the sea beside the line: 1
        expect(baseSample(base, -150, 0).cliff).toBe(1);
        expect(baseSample(base, -170, 0).cliff).toBe(1);
        // On the plateau beyond the face: 0
        expect(baseSample(base, -130, 0).cliff).toBe(0);
        // Far from the line (60 m beyond its 20 m plateau, 40 m fade): 0
        expect(baseSample(base, -150, 0).cliff).toBe(1);
        expect(baseSample(FLAT_COAST, -150, 0).cliff).toBe(0);
        expect(baseSample({ ...base, cliffs: [{ ...base.cliffs[0], line: [[-150, -300], [-150, -100]] }] }, -150, 20).cliff).toBe(0);
    });
});

describe('views kept open, slanting and away from the origin', () => {
    it('measure along and across the wedge from its start', () => {
        // From (100, 50) towards (700, 850): along (0.6, 0.8), left (-0.8, 0.6)
        const view = { id: 'v', from: [100, 50] as [number, number], to: [700, 850] as [number, number], height: 20, slope: 0.1, spread: 0.5, length: 200 };
        const base: BaseTerrain = { ...FLAT_COAST, land: { base: 34, tilt: [0, 0], tiltOrigin: [0, 0] }, views: [view] };
        const at = (along: number, across: number) => baseHeight(base, 100 + 0.6 * along - 0.8 * across, 50 + 0.8 * along + 0.6 * across);
        expect(at(50, 0)).toBeCloseTo(15, 9);
        // 20 m aside at 50 m (half width 25): still the full cap, on both sides
        expect(at(50, 20)).toBeCloseTo(15, 9);
        expect(at(50, -20)).toBeCloseTo(15, 9);
        // Behind the start
        expect(at(-5, 0)).toBeCloseTo(34, 9);
    });
});

describe('the cliff face weight and headlands away from the cliff line', () => {
    const cliff: BaseTerrain = {
        ...FLAT_COAST,
        cliffs: [{ id: 'c', line: [[-150, -300], [-150, 300]], height: 30, face: 10, plateau: 20, fade: 20, vary: { face: 0.35, wavelength: 90, gullies: 0, gullyWavelength: 40, headlands: 8 } }]
    };

    it('fades the face weight out over 40 m beyond the plateau', () => {
        // In the sea 40 m from the line (20 m beyond its plateau): halfway
        expect(baseSample(cliff, -190, 0).cliff).toBeCloseTo(0.5, 12);
        expect(baseSample(cliff, -220, 0).cliff).toBe(0);
    });

    it('lets a headland beyond the plateau fade with the cliff (near < 1)', () => {
        // The same coast, the line 25 m inland: at the shore the cliff's
        // share 2 m out to sea (27 m from the line) is 1 - S(7/20); on a headland the height is that share of
        // the full one over the sea floor
        const inland: BaseTerrain = { ...cliff, cliffs: [{ ...cliff.cliffs[0], line: [[-125, -300], [-125, 300]] }] };
        const near = 1 - smoothstep(7 / 20);
        let checked = 0;
        for (let z = -250; z <= 250; z += 5) {
            const full = baseHeight(cliff, -152, z), floor = baseHeight(FLAT_COAST, -152, z);
            if (full <= floor) continue;
            // Full in the plain cliff (near 1 there), faded here
            expect(baseHeight(inland, -152, z)).toBeCloseTo(floor + (full - floor) * near, 9);
            checked++;
        }
        expect(checked).toBeGreaterThan(3);
    });
});

describe('breakwaters', () => {
    it('raise a spit over the sea floor along their line: the crest at `height`, down to the floor over `width` m', () => {
        // A mole from the coast (x = -150) 40 m out along z = 0, crest 1.5 m, 6 m wide
        const base: BaseTerrain = { ...FLAT_COAST, moles: [{ id: 'm', line: [[-150, 0], [-190, 0]], height: 1.5, width: 6 }] };
        const floor = (x: number) => baseHeight(FLAT_COAST, x, 0);
        expect(baseHeight(base, -170, 0)).toBeCloseTo(1.5, 12);
        // 3 m aside: halfway between the floor there and the crest (bell 0.5)
        expect(baseHeight(base, -170, 3)).toBeCloseTo(baseHeight(FLAT_COAST, -170, 3) + (1.5 - baseHeight(FLAT_COAST, -170, 3)) * 0.5, 12);
        expect(baseHeight(base, -170, 6)).toBe(baseHeight(FLAT_COAST, -170, 6));
        // Beyond its end the sea floor
        expect(baseHeight(base, -200, 0)).toBe(floor(-200));
        // Never below the ground: on the beach higher than the crest it stays
        const high: BaseTerrain = { ...base, moles: [{ id: 'm', line: [[-150, 0], [-100, 0]], height: 0.5, width: 6 }] };
        expect(baseHeight(high, -110, 0)).toBe(baseHeight(FLAT_COAST, -110, 0));
    });
});

describe('views kept open', () => {
    // From (0, 0) towards +x: the ground below 20 - 0.1 · along in a wedge of
    // half width 0.5 · along, out to 200 m
    const view = { id: 'v', from: [0, 0] as [number, number], to: [1000, 0] as [number, number], height: 20, slope: 0.1, spread: 0.5, length: 200 };
    // Land at 34 m, level: the base 4 m plus a 30 m hill all round
    const high: BaseTerrain = { ...FLAT_COAST, land: { base: 34, tilt: [0, 0], tiltOrigin: [0, 0] } };
    const base: BaseTerrain = { ...high, views: [view] };

    it('caps the ground on the wedge\'s axis at height - slope · along, leaves it behind and beyond', () => {
        expect(baseHeight(base, 50, 0)).toBeCloseTo(15, 9);
        expect(baseHeight(base, 100, 0)).toBeCloseTo(10, 9);
        // Behind the start and past the length: untouched
        expect(baseHeight(base, -10, 0)).toBeCloseTo(34, 9);
        expect(baseHeight(base, 210, 0)).toBeCloseTo(34, 9);
        // In the last 30 % the cap eases out: at 170 m halfway
        expect(baseHeight(base, 170, 0)).toBeCloseTo(34 - (34 - 3) * 0.5, 9);
    });

    it('keeps its full cap within the half width, eases out over half width + 20 m beside it, and leaves lower ground alone', () => {
        // along 100: half width 50, the cap 10
        expect(baseHeight(base, 100, 49)).toBeCloseTo(10, 9);
        // 50 + (50 + 20) / 2 = 85 m across: halfway
        expect(baseHeight(base, 100, -85)).toBeCloseTo(34 - 24 * 0.5, 9);
        expect(baseHeight(base, 100, 121)).toBeCloseTo(34, 9);
        // Ground already below the cap stays
        const low: BaseTerrain = { ...FLAT_COAST, land: { base: 6, tilt: [0, 0], tiltOrigin: [0, 0] }, views: [view] };
        expect(baseHeight(low, 50, 0)).toBeCloseTo(6, 9);
        // Not on a road: the keep weight
        expect(baseSample(base, 50, 0, () => 0).height).toBeCloseTo(34, 9);
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
