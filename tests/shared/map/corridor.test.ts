import { describe, expect, it } from 'vitest';
import {
    CONFLICT_TOLERANCE, EMBANKMENT_RUN, flatHalfWidths, limitGrade, longitudinalProfile, movingAverage,
    pinEnvelope, TerrainShaper, type CorridorLine, type GridGeometry
} from '../../../src/shared/map/corridor.js';
import { heightAt, quantizeHeight, type GridSpec } from '../../../src/shared/map/heightfield.js';
import { SURFACE } from '../../../src/shared/map/types.js';
import { PROFILE } from './fixtures.js';

// Longitudinal profile and cross section of a road corridor
// (docs/phase-3-design.md, 6.4). Expected values from hand calculation on
// planes and straight roads; slopes are measured on every grid point.

const SLOPE = 1 / EMBANKMENT_RUN;

describe('flatHalfWidths', () => {
    it('reaches at least 4 m beyond the road edge, further with sidewalk and shoulder', () => {
        expect(flatHalfWidths(PROFILE)).toEqual({ left: 9, right: 9 });
        expect(flatHalfWidths({ ...PROFILE, sidewalk: { left: 3, right: 5 }, shoulder: 0.5 })).toEqual({ left: 9, right: 10.5 });
        // Sidewalk and shoulder add up: 4 + 1 = 5 > 4
        expect(flatHalfWidths({ ...PROFILE, sidewalk: { left: 4, right: 0 }, shoulder: 1 })).toEqual({ left: 10, right: 9 });
    });
});

describe('longitudinal profile helpers', () => {
    it('averages over a window that shrinks at the ends', () => {
        expect(Array.from(movingAverage([0, 3, 6, 9, 30], 1))).toEqual([1.5, 3, 6, 15, 19.5]);
    });

    it('limits the grade symmetrically: a spike is cut from both sides', () => {
        // Below: 0 0 1 0 0; above: 8 9 10 9 8; mean:
        expect(Array.from(limitGrade([0, 0, 10, 0, 0], 1, 1))).toEqual([4, 4.5, 5.5, 4.5, 4]);
    });

    it('leaves a profile that keeps the limit unchanged', () => {
        const ok = [0, 0.5, 1, 0.75, 0.25];
        expect(Array.from(limitGrade(ok, 1, 0.5))).toEqual(ok);
    });

    it('bounds the profile between the pins within the grade', () => {
        // Pins y = 0 at s = 0 and y = 1 at s = 4, grade 0.5:
        // lo = max(-0.5 s, 1 - 0.5 (4 - s)), hi = min(0.5 s, 1 + 0.5 (4 - s))
        const { lo, hi } = pinEnvelope(5, 1, 0.5, [{ from: 0, to: 0, y: 0 }, { from: 4, to: 4, y: 1 }]);
        expect(Array.from(lo)).toEqual([0, -0.5, 0, 0.5, 1]);
        expect(Array.from(hi)).toEqual([0, 0.5, 1, 1.5, 1]);
    });

    it('holds a pin range flat and spreads a point pin between samples', () => {
        const { lo, hi } = pinEnvelope(6, 1, 0.1, [{ from: 1, to: 2.5, y: 3 }]);
        // Samples 1 and 2 inside the range, sample 3 is 0.5 m past it
        expect(lo[1]).toBe(3);
        expect(hi[2]).toBe(3);
        expect(hi[3]).toBeCloseTo(3.05, 12);
        expect(lo[5]).toBeCloseTo(3 - 0.25, 12);
    });
});

describe('longitudinal profile helpers at 2 m spacing and a grade per step', () => {
    it('limits a one-sided rise with the step length and each step\'s own grade', () => {
        // Steps of 2 m at grade 1 (2 m per step): below 0 0 0 2, above 4 6 8 10
        expect(Array.from(limitGrade([0, 0, 0, 10], 2, 1))).toEqual([2, 3, 4, 6]);
        // The last step only 0.5 (1 m): below 0 0 0 1, above 5 7 9 10
        expect(Array.from(limitGrade([0, 0, 0, 10], 2, [1, 1, 0.5]))).toEqual([2.5, 3.5, 4.5, 5.5]);
        // A drop: mirrored
        expect(Array.from(limitGrade([10, 0, 0, 0], 2, [0.5, 1, 1]))).toEqual([5.5, 4.5, 3.5, 2.5]);
    });

    it('bounds the profile around a pin range and a pin between stations at 2 m spacing', () => {
        // Range 2 .. 4 at y = 1 (stations 1 and 2), grade 0.5: 1 m per step
        const { lo, hi } = pinEnvelope(5, 2, 0.5, [{ from: 2, to: 4, y: 1 }]);
        expect(Array.from(lo)).toEqual([0, 1, 1, 0, -1]);
        expect(Array.from(hi)).toEqual([2, 1, 1, 2, 3]);
        // A point pin at s = 3 (between stations 1 and 2, 1 m from each)
        const between = pinEnvelope(5, 2, 0.5, [{ from: 3, to: 3, y: 1 }]);
        expect(Array.from(between.lo)).toEqual([-0.5, 0.5, 0.5, -0.5, -1.5]);
        expect(Array.from(between.hi)).toEqual([2.5, 1.5, 1.5, 2.5, 3.5]);
        // The grade of the last step also serves the last station
        const graded = pinEnvelope(3, 2, [0.5, 0.25], [{ from: 4, to: 4, y: 0 }]);
        expect(Array.from(graded.hi)).toEqual([1.5, 0.5, 0]);
    });
});

describe('longitudinalProfile: rounding and pins at 2 m spacing', () => {
    // Largest change of slope between neighbouring steps: a vertical radius
    // R at spacing Δs allows Δs² / R
    const bendPerStep = (h: ArrayLike<number>) => {
        let max = 0;
        for (let i = 1; i + 1 < h.length; i++) max = Math.max(max, Math.abs(h[i + 1] - 2 * h[i] + h[i - 1]));
        return max;
    };

    it('rounds a crest between two pins to the radius and meets both pins', () => {
        // A 10 m high tent over 200 m, stations every 2 m, pins at both ends
        const natural = Array.from({ length: 101 }, (_, i) => 10 - Math.abs(i * 2 - 100) / 10);
        const { heights, infeasible, unrounded } = longitudinalProfile(natural, 2, 0.12, [{ from: 0, to: 0, y: 0 }, { from: 200, to: 200, y: 0 }], 150);
        expect(infeasible).toBe(0);
        expect(unrounded).toBe(0);
        expect(heights[0]).toBeCloseTo(0, 9);
        expect(heights[100]).toBeCloseTo(0, 9);
        expect(bendPerStep(heights)).toBeLessThanOrEqual(4 / 150 + 1e-9);
        // The crest is still there, a little lower
        expect(heights[50]).toBeGreaterThan(5);
        expect(heights[50]).toBeLessThan(10.01);
    });

    it('rounds towards a single pin at the start and at the end', () => {
        const natural = Array.from({ length: 61 }, (_, i) => (i < 30 ? 0 : (i - 30) * 0.2));
        for (const pins of [[{ from: 0, to: 0, y: 0 }], [{ from: 120, to: 120, y: 6 }]]) {
            const { heights } = longitudinalProfile(natural, 2, 0.12, pins, 100);
            expect(bendPerStep(heights)).toBeLessThanOrEqual(4 / 100 + 1e-9);
            const pin = pins[0];
            expect(heights[pin.from / 2]).toBeCloseTo(pin.y, 9);
        }
    });

    it('keeps the mean height of the smoothed ground when there is no pin at all', () => {
        // A sag that the grade limit does not touch: the rounding only
        // bends it; the offset keeps the mean of the base profile
        const natural = Array.from({ length: 81 }, (_, i) => Math.abs(i - 40) * 0.1);
        const { heights } = longitudinalProfile(natural, 2, 0.12, [], 150);
        const mean = (v: ArrayLike<number>) => Array.from(v).reduce((a, b) => a + b, 0) / v.length;
        const smoothed = movingAverage(natural, 15);
        expect(mean(heights)).toBeCloseTo(mean(smoothed), 9);
        expect(bendPerStep(heights)).toBeLessThanOrEqual(4 / 150 + 1e-9);
    });

    it('returns nothing for no stations and the pinned base for one or two', () => {
        expect(longitudinalProfile([], 1, 0.1, []).heights).toHaveLength(0);
        const two = longitudinalProfile([0, 5], 1, 0.5, [{ from: 0, to: 0, y: 1 }]);
        // The 60 m average makes both 2.5 m, the pin moves them by -1.5
        expect(Array.from(two.heights)).toEqual([1, 1]);
        expect(two.unrounded).toBe(0);
    });

    it('sorts its pins: the order in the list does not matter', () => {
        const natural = Array.from({ length: 51 }, (_, i) => i * 0.05);
        const a = longitudinalProfile(natural, 2, 0.12, [{ from: 20, to: 20, y: 1 }, { from: 80, to: 80, y: 6 }]);
        const b = longitudinalProfile(natural, 2, 0.12, [{ from: 80, to: 80, y: 6 }, { from: 20, to: 20, y: 1 }]);
        expect(Array.from(b.heights)).toEqual(Array.from(a.heights));
        expect(a.heights[10]).toBeCloseTo(1, 9);
        expect(a.heights[40]).toBeCloseTo(6, 9);
    });
});

describe('longitudinalProfile', () => {
    it('keeps the grade limit on ground four times as steep', () => {
        const natural = Array.from({ length: 301 }, (_, i) => 0.3 * i);
        const { heights } = longitudinalProfile(natural, 1, 0.08, []);
        let max = 0;
        for (let i = 1; i < heights.length; i++) max = Math.max(max, Math.abs(heights[i] - heights[i - 1]));
        expect(max).toBeLessThanOrEqual(0.08 + 1e-12);
    });

    it('meets its pins exactly, a plateau over its whole range', () => {
        const natural = Array.from({ length: 201 }, (_, i) => 5 + 0.02 * i);
        const { heights, infeasible } = longitudinalProfile(natural, 1, 0.08, [
            { from: 0, to: 12, y: 4 }, { from: 200, to: 200, y: 10 }
        ]);
        for (let i = 0; i <= 12; i++) expect(heights[i]).toBe(4);
        expect(heights[200]).toBe(10);
        expect(infeasible).toBe(0);
    });

    it('rounds a valley to the minimum vertical radius of 150 m', () => {
        // A steep V: after the grade limit the two 8 % flanks meet in a kink
        const natural = Array.from({ length: 401 }, (_, i) => 0.3 * Math.abs(i - 200));
        const { heights } = longitudinalProfile(natural, 1, 0.08, []);
        let maxBend = 0;
        for (let i = 1; i < heights.length - 1; i++) {
            maxBend = Math.max(maxBend, Math.abs(heights[i + 1] - 2 * heights[i] + heights[i - 1]));
        }
        // Curvature = second difference over 1 m² ≤ 1/150 (+ float noise)
        expect(maxBend).toBeLessThanOrEqual(1 / 150 + 1e-9);
    });

    it('leaves a flat plateau with a rounded start, not a kink', () => {
        // Ground rising at 30 % right after a plateau pinned at 0 over the
        // first 20 m: the road has to start climbing at s = 20
        const natural = Array.from({ length: 201 }, (_, i) => 0.3 * i);
        const { heights } = longitudinalProfile(natural, 1, 0.08, [{ from: 0, to: 20, y: 0 }]);
        for (let i = 0; i <= 20; i++) expect(heights[i]).toBe(0);
        let maxBend = 0, maxGrade = 0;
        for (let i = 1; i < heights.length - 1; i++) {
            maxBend = Math.max(maxBend, Math.abs(heights[i + 1] - 2 * heights[i] + heights[i - 1]));
            maxGrade = Math.max(maxGrade, Math.abs(heights[i] - heights[i - 1]));
        }
        expect(maxBend).toBeLessThanOrEqual(1 / 150 + 1e-6);
        expect(maxGrade).toBeLessThanOrEqual(0.08 + 1e-12);
        // Rounding from 0 to 8 % at 1/150 per metre takes 12 m: well up by then
        expect(heights[40]).toBeGreaterThan(0.08 * (40 - 20 - 12));
    });

    it('rounds a stretch between two pins and still meets both exactly', () => {
        // Flat ground, 0 m over the first 20 m and 6 m over the last 20 m:
        // 6 m over 160 m is 3.75 % on average, reached and left again with
        // at least 150 m of vertical radius
        const natural = new Array(201).fill(0);
        const { heights, infeasible, unrounded } = longitudinalProfile(natural, 1, 0.08, [
            { from: 0, to: 20, y: 0 }, { from: 180, to: 200, y: 6 }
        ]);
        expect(infeasible).toBe(0);
        expect(unrounded).toBe(0);
        for (let i = 0; i <= 20; i++) expect(heights[i]).toBe(0);
        for (let i = 180; i <= 200; i++) expect(heights[i]).toBe(6);
        const { bend, grade } = bendAndGrade(heights);
        expect(bend).toBeLessThanOrEqual(1 / 150 + 1e-9);
        expect(grade).toBeLessThanOrEqual(0.08 + 1e-12);
        // Symmetric problem: halfway up in the middle
        expect(heights[100]).toBeCloseTo(3, 6);
    });

    it('rounds towards a pin at the end only', () => {
        // Mirror of the plateau test: ground falling at 30 % towards a
        // plateau pinned at 0 over the last 20 m
        const natural = Array.from({ length: 201 }, (_, i) => 0.3 * (200 - i));
        const { heights } = longitudinalProfile(natural, 1, 0.08, [{ from: 180, to: 200, y: 0 }]);
        for (let i = 180; i <= 200; i++) expect(heights[i]).toBe(0);
        const { bend, grade } = bendAndGrade(heights);
        expect(bend).toBeLessThanOrEqual(1 / 150 + 1e-6);
        expect(grade).toBeLessThanOrEqual(0.08 + 1e-12);
        // 12 m of rounding, then 8 %: well up 40 m before the plateau
        expect(heights[140]).toBeGreaterThan(0.08 * (40 - 12));
    });

    it('keeps the kinks and counts the stretch where the radius does not fit between two pins', () => {
        // 1.6 m over 20 m is exactly the 8 % limit: no room to round into it
        const natural = new Array(61).fill(0);
        const { heights, infeasible, unrounded } = longitudinalProfile(natural, 1, 0.08, [
            { from: 0, to: 10, y: 0 }, { from: 30, to: 60, y: 1.6 }
        ]);
        expect(infeasible).toBeCloseTo(0, 9);
        expect(unrounded).toBe(1);
        expect(heights[10]).toBe(0);
        expect(heights[20]).toBeCloseTo(0.8, 9);
        expect(heights[30]).toBe(1.6);
    });

    it('snaps a point pin to the nearest station of the spacing', () => {
        // Stations every 2 m: a pin at s = 40.6 holds station 20 (s = 40);
        // a second pin at the end keeps the profile from just shifting
        const natural = new Array(51).fill(3);
        const { heights } = longitudinalProfile(natural, 2, 0.08, [
            { from: 40.6, to: 40.6, y: 5 }, { from: 100, to: 100, y: 3 }
        ]);
        expect(heights[20]).toBe(5);
        expect(heights[50]).toBe(3);
        expect(heights[25]).toBeLessThan(5);
    });

    it('reports pins the grade cannot connect and runs midway', () => {
        // 20 m up over 100 m at most 8 %: 12 m short, split evenly
        const natural = new Array(101).fill(0);
        const { heights, infeasible } = longitudinalProfile(natural, 1, 0.08, [
            { from: 0, to: 0, y: 0 }, { from: 100, to: 100, y: 20 }
        ]);
        expect(infeasible).toBeCloseTo(12, 9);
        expect(heights[50]).toBeCloseTo(10, 9);
    });

    it('uses the grade of each step', () => {
        const natural = Array.from({ length: 201 }, (_, i) => 0.3 * i);
        const grades = Array.from({ length: 200 }, (_, i) => (i < 100 ? 0.05 : 0.12));
        const { heights } = longitudinalProfile(natural, 1, grades, []);
        for (let i = 1; i < 90; i++) expect(Math.abs(heights[i] - heights[i - 1])).toBeLessThanOrEqual(0.05 + 1e-12);
        let steepest = 0;
        for (let i = 110; i < 200; i++) steepest = Math.max(steepest, Math.abs(heights[i] - heights[i - 1]));
        expect(steepest).toBeGreaterThan(0.11);
        expect(steepest).toBeLessThanOrEqual(0.12 + 1e-12);
    });
});

// Largest second difference (bend per step²) and largest step of a profile
// sampled every metre
function bendAndGrade(heights: ArrayLike<number>): { bend: number; grade: number } {
    let bend = 0, grade = 0;
    for (let i = 1; i < heights.length; i++) {
        grade = Math.max(grade, Math.abs(heights[i] - heights[i - 1]));
        if (i + 1 < heights.length) bend = Math.max(bend, Math.abs(heights[i + 1] - 2 * heights[i] + heights[i - 1]));
    }
    return { bend, grade };
}

// 201 × 201 points, 2 m, centred on the origin
const GRID: GridGeometry = { cols: 201, rows: 201, cellSize: 2, originX: -200, originZ: -200 };
const SPEC: GridSpec = { ...GRID, heightOffset: -20, heightScale: 0.01, waterLevel: 0, zoneCell: 8 };

function plane(f: (x: number, z: number) => number): Float64Array {
    const out = new Float64Array(GRID.cols * GRID.rows);
    for (let j = 0; j < GRID.rows; j++) {
        for (let i = 0; i < GRID.cols; i++) out[j * GRID.cols + i] = f(GRID.originX + i * 2, GRID.originZ + j * 2);
    }
    return out;
}

function at(heights: Float64Array, x: number, z: number): number {
    return heights[((z - GRID.originZ) / 2) * GRID.cols + (x - GRID.originX) / 2];
}

// Straight line from (x0, z0) to (x1, z1) with 1 m vertices
function straight(x0: number, z0: number, x1: number, z1: number, y: (s: number) => number, half = 9): CorridorLine {
    const length = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.round(length) + 1;
    const xs: number[] = [], zs: number[] = [], ys: number[] = [];
    for (let k = 0; k < n; k++) {
        const t = k / (n - 1);
        xs.push(x0 + (x1 - x0) * t);
        zs.push(z0 + (z1 - z0) * t);
        ys.push(y(t * length));
    }
    return { x: xs, z: zs, y: ys, halfLeft: new Array(n).fill(half), halfRight: new Array(n).fill(half) };
}

// Steepest slope between neighbouring grid points whose height the
// corridor changed (the untouched natural ground may be steeper)
function steepestShapedSlope(heights: Float64Array, natural: Float64Array): number {
    let max = 0;
    for (let j = 0; j < GRID.rows; j++) {
        for (let i = 0; i < GRID.cols; i++) {
            const k = j * GRID.cols + i;
            for (const n of [i + 1 < GRID.cols ? k + 1 : -1, j + 1 < GRID.rows ? k + GRID.cols : -1]) {
                if (n < 0) continue;
                const shaped = heights[k] !== natural[k] || heights[n] !== natural[n];
                if (shaped) max = Math.max(max, Math.abs(heights[n] - heights[k]) / 2);
            }
        }
    }
    return max;
}

describe('TerrainShaper: a level road across a 20 % slope', () => {
    // Ground rises 0.2 m per m towards +z; the road runs along x at z = 0, y = 0
    // Built inside each test, not while collecting them: Stryker only
    // activates a mutant while a test runs
    const shape = () => {
        const natural = plane((_, z) => 0.2 * z);
        const shaper = new TerrainShaper(GRID, natural);
        shaper.addLine(straight(-200, 0, 200, 0, () => 0));
        const { heights, conflicts } = shaper.finish();
        return { natural, heights, conflicts };
    };

    it('is flat at road height over the flat zone (road + 4 m)', () => {
        const { heights, conflicts } = shape();
        for (const z of [-8, -4, 0, 4, 8]) expect(at(heights, 20, z)).toBe(0);
        expect(conflicts.count).toBe(0);
    });

    it('cuts into the slope at 1 : 1.5 until it meets the ground', () => {
        const { heights } = shape();
        // Uphill: 1 m beyond the flat zone (half 9) the cut is 1/1.5 high
        expect(at(heights, 20, 10)).toBeCloseTo(1 / 1.5, 12);
        expect(at(heights, 20, 12)).toBeCloseTo(3 / 1.5, 12);
        // The cut meets the ground where (z - 9)/1.5 = 0.2 z: z ≈ 12.86
        expect(at(heights, 20, 14)).toBeCloseTo(0.2 * 14, 12);
        expect(at(heights, 20, 40)).toBeCloseTo(0.2 * 40, 12);
    });

    it('fills downhill at 1 : 1.5', () => {
        const { heights } = shape();
        expect(at(heights, 20, -10)).toBeCloseTo(-1 / 1.5, 12);
        expect(at(heights, 20, -14)).toBeCloseTo(-0.2 * 14, 12);
    });

    it('never gets steeper than 1 : 1.5 where it shapes the ground', () => {
        const { natural, heights } = shape();
        expect(steepestShapedSlope(heights, natural)).toBeLessThanOrEqual(SLOPE + 1e-12);
    });

    it('gives every cell under the road four corners at road height', () => {
        const { heights } = shape();
        const hf = {
            spec: SPEC,
            q: Uint16Array.from(heights, h => quantizeHeight(SPEC, h)),
            surface: new Uint8Array(0), zones: new Uint8Array(0), mapVersion: 1, sourceHash: new Uint8Array(16)
        };
        // Across the drivable width (± 5 m) and a bit beyond, anywhere in a cell
        for (let x = -150; x <= 150; x += 0.73) {
            for (const z of [-5.9, -5, -2.3, 0, 1.1, 5, 5.9]) expect(heightAt(hf, x, z)).toBeCloseTo(0, 9);
        }
    });
});

describe('TerrainShaper: no fill on a cliff face', () => {
    // A level road (y = 0) along x at z = 0 on a plateau, the ground dropping
    // 2 m per m beyond z = -12 (a face steeper than the 1 : 1.5 fill); the
    // face from z = -14 on is marked no-fill
    const shape = (mark: boolean) => {
        const natural = plane((_, z) => (z < -12 ? 2 * (z + 12) : 0));
        const noFill = Uint8Array.from(plane((_, z) => (z <= -14 ? 1 : 0)));
        const shaper = new TerrainShaper(GRID, natural);
        shaper.addLine(straight(-200, 0, 200, 0, () => 0));
        return { natural, ...shaper.finish(mark ? noFill : undefined) };
    };

    it('leaves the face as it is where marked, fills at 1 : 1.5 elsewhere', () => {
        const filled = shape(false), kept = shape(true);
        // The fill at 1 : 1.5 from the flat zone (half 9): at z = -16, 7 m
        // out, -7/1.5 instead of the face's -8
        expect(at(filled.heights, 20, -16)).toBeCloseTo(-7 / 1.5, 12);
        expect(at(kept.heights, 20, -16)).toBe(-8);
        expect(at(kept.heights, 20, -30)).toBe(-36);
        // Unmarked ground next to it still takes the fill; the flat zone stays
        expect(at(kept.heights, 20, -12)).toBe(at(filled.heights, 20, -12));
        for (const z of [-8, 0, 8]) expect(at(kept.heights, 20, z)).toBeCloseTo(0, 12);
    });

    it('still keeps a flat zone on marked ground', () => {
        // Everything marked: the road's flat zone stays level, the fill goes
        const natural = plane((_, z) => -0.5 * Math.abs(z));
        const shaper = new TerrainShaper(GRID, natural);
        shaper.addLine(straight(-200, 0, 200, 0, () => 0));
        const { heights } = shaper.finish(new Uint8Array(GRID.cols * GRID.rows).fill(1));
        for (const z of [-8, 0, 8]) expect(at(heights, 20, z)).toBeCloseTo(0, 12);
        expect(at(heights, 20, 12)).toBe(-6);
    });
});

describe('TerrainShaper: a road climbing a 20 % slope', () => {
    // Built inside each test, not while collecting them: Stryker only
    // activates a mutant while a test runs
    const shape = () => {
        const natural = plane((x) => 0.2 * x);
        // Profile along the road (x from -200 to 200) limited to 8 %
        const nat = Array.from({ length: 401 }, (_, s) => 0.2 * (s - 200));
        const { heights: profile } = longitudinalProfile(nat, 1, 0.08, []);
        const shaper = new TerrainShaper(GRID, natural);
        shaper.addLine(straight(-200, 0, 200, 0, s => profile[Math.round(s)]));
        const { heights, conflicts } = shaper.finish();
        return { natural, profile, heights, conflicts };
    };

    it('follows the profile along the road, within the grade limit', () => {
        const { profile, heights } = shape();
        for (let x = -200; x < 200; x += 2) {
            expect(at(heights, x, 0)).toBeCloseTo(profile[x + 200], 12);
            expect(Math.abs(at(heights, x + 2, 0) - at(heights, x, 0)) / 2).toBeLessThanOrEqual(0.08 + 1e-12);
        }
    });

    it('stays within 1 : 1.5 across its cuts and fills and has no conflicts along itself', () => {
        const { natural, heights, conflicts } = shape();
        expect(steepestShapedSlope(heights, natural)).toBeLessThanOrEqual(SLOPE + 1e-12);
        // Pieces of 8 m each own their part of the flat zone: no false
        // conflicts along a graded road
        expect(conflicts.count).toBe(0);
    });
});

describe('TerrainShaper: two corridors', () => {
    it('reports roads too close for their difference in height', () => {
        // Flat zones end 2 m apart: 2 m of 1 : 1.5 allow 1.33 m, not 10 m
        const shaper = new TerrainShaper(GRID, plane(() => 0));
        shaper.addLine(straight(-100, 0, 100, 0, () => 0));
        shaper.addLine(straight(-100, 20, 100, 20, () => 10));
        const { heights, conflicts } = shaper.finish();
        expect(conflicts.count).toBeGreaterThan(0);
        expect(conflicts.maxGap).toBeGreaterThan(CONFLICT_TOLERANCE);
        // Worst at the edge of a flat zone (z = 9): hi = 0 from the lower
        // road, lo = 10 - 2/1.5 from the upper road's slope
        expect(conflicts.maxGap).toBeCloseTo(10 - 2 / 1.5, 9);
        // z = 8: lo = 10 - 3/1.5 = 8, hi = 0, midway
        expect(at(heights, 0, 8)).toBeCloseTo(4, 12);
    });

    it('joins roads far enough apart with slopes, without conflict', () => {
        // Flat zones 22 m apart: room for 14.7 m at 1 : 1.5
        const natural = plane(() => 0);
        const shaper = new TerrainShaper(GRID, natural);
        shaper.addLine(straight(-100, 0, 100, 0, () => 0));
        shaper.addLine(straight(-100, 40, 100, 40, () => 10));
        const { heights, conflicts } = shaper.finish();
        expect(conflicts.count).toBe(0);
        // The upper road's fill: 1 m past its flat zone (z = 30) 10 - 1/1.5
        expect(at(heights, 0, 30)).toBeCloseTo(10 - 1 / 1.5, 12);
        expect(steepestShapedSlope(heights, natural)).toBeLessThanOrEqual(SLOPE + 1e-12);
    });
});

describe('TerrainShaper: search radius', () => {
    it('reaches far enough to cut a 40 m high block 30 m beside the road down to 1 : 1.5', () => {
        // Level road along z = 0 at y = 0 (flat zone 9 m); the ground is 0
        // south of z = 30 and 40 m from there on. The cone of the road
        // allows (z - 9) / 1.5 m: 14 m at z = 30, 34 m at z = 60, and
        // reaches the 40 m first at z = 69.
        const natural = plane((_, z) => (z >= 30 ? 40 : 0));
        const shaper = new TerrainShaper(GRID, natural);
        shaper.addLine(straight(-100, 0, 100, 0, () => 0));
        const { heights } = shaper.finish();
        expect(at(heights, 0, 30)).toBeCloseTo(14, 9);
        expect(at(heights, 0, 60)).toBeCloseTo(34, 9);
        expect(at(heights, 0, 68)).toBeCloseTo(59 / 1.5, 9);
        expect(at(heights, 0, 70)).toBe(40);
        // A lower block needs a shorter reach: the same road, 10 m block
        const low = new TerrainShaper(GRID, plane((_, z) => (z >= 30 ? 10 : 0)));
        low.addLine(straight(-100, 0, 100, 0, () => 0));
        const lowHeights = low.finish().heights;
        expect(at(lowHeights, 0, 30)).toBe(10);
        expect(at(lowHeights, 0, 20)).toBe(0);
    });

    it('stops at 240 m however high the ground around is', () => {
        // A 300 m wall: the cone would need 9 + 1.5 · 300 = 459 m
        const natural = plane((_, z) => (z >= 20 ? 300 : 0));
        const shaper = new TerrainShaper(GRID, natural);
        shaper.addLine(straight(-10, -150, 10, -150, () => 0));
        const { heights } = shaper.finish();
        // 170 m north of the wall's foot (z = 20) is 170 m from the road:
        // (170 - 9) / 1.5 = 107.3 m instead of 300 m
        expect(at(heights, 0, 20)).toBeCloseTo(161 / 1.5, 6);
        expect(at(heights, 0, 100)).toBe(300);
    });
});

describe('TerrainShaper: walls, areas and surfaces', () => {
    it('drops vertically at a retaining wall instead of cutting a slope', () => {
        const natural = plane(() => 6);
        const line = straight(-100, 0, 100, 0, () => 0);
        const n = line.x.length;
        // Road heading east: left is north (-z)
        line.wallLeft = new Array(n).fill(1);
        const shaper = new TerrainShaper(GRID, natural);
        shaper.addLine(line);
        const { heights } = shaper.finish();
        expect(at(heights, 0, -8)).toBe(0);    // flat zone
        expect(at(heights, 0, -10)).toBe(6);   // natural right behind the wall
        expect(at(heights, 0, 10)).toBeCloseTo(1 / 1.5, 12);  // cut on the right
    });

    it('holds an area at its height with a flat margin and slopes beyond', () => {
        const shaper = new TerrainShaper(GRID, plane(() => 0));
        shaper.addArea({ polygon: [[-20, -20], [20, -20], [20, 20], [-20, 20]], y: 5, margin: 4, walls: false, surface: SURFACE.concrete });
        const { heights } = shaper.finish();
        expect(at(heights, 0, 0)).toBe(5);
        expect(at(heights, 24, 0)).toBe(5);                  // margin
        expect(at(heights, 26, 0)).toBeCloseTo(5 - 2 / 1.5, 12);
        expect(at(heights, 40, 0)).toBe(0);                  // 16 m past the margin: > 7.5 m of fill needed
        expect(shaper.surface[((0 + 200) / 2) * GRID.cols + (0 + 200) / 2]).toBe(SURFACE.concrete);
        expect(shaper.surface[((0 + 200) / 2) * GRID.cols + (24 + 200) / 2]).toBe(-1);
    });

    it('raises a walled area (the pier) only inside its outline', () => {
        const shaper = new TerrainShaper(GRID, plane(() => -8));
        shaper.addArea({ polygon: [[-50, -5], [50, -5], [50, 5], [-50, 5]], y: 5, margin: 4, walls: true });
        const { heights, conflicts } = shaper.finish();
        expect(at(heights, 0, 4)).toBe(5);
        expect(at(heights, 0, 6)).toBe(-8);
        expect(conflicts.count).toBe(0);
    });

    it('stamps road surfaces by priority: wood over asphalt over dirt', () => {
        const shaper = new TerrainShaper(GRID, plane(() => 0));
        const road = straight(-100, 0, 100, 0, () => 0);
        const n = road.x.length;
        road.surface = new Array(n).fill(SURFACE.asphalt);
        road.surfaceHalf = new Array(n).fill(6);
        const track = straight(0, -50, 0, 50, () => 0, 7);
        track.surface = new Array(track.x.length).fill(SURFACE.dirt);
        track.surfaceHalf = new Array(track.x.length).fill(4);
        shaper.addLine(track);
        shaper.addLine(road);
        shaper.addArea({ polygon: [[40, -3], [60, -3], [60, 3], [40, 3]], y: 0, margin: 0, walls: true, surface: SURFACE.wood });
        const cell = (x: number, z: number) => shaper.surface[((z + 200) / 2) * GRID.cols + (x + 200) / 2];
        expect(cell(20, 6)).toBe(SURFACE.asphalt);
        expect(cell(20, 8)).toBe(-1);
        expect(cell(0, 0)).toBe(SURFACE.asphalt);
        expect(cell(2, 30)).toBe(SURFACE.dirt);
        expect(cell(50, 0)).toBe(SURFACE.wood);
    });
});

describe('pinEnvelope: several pins on one station, pins past the end, a grade per step', () => {
    it('keeps the stronger bound where a weaker pin covers the same station, in either order', () => {
        // A range pin at y = 3 over the whole road and a point pin at y = 1
        // on station 2 (grade 0.5, 1 m steps): lo stays 3 everywhere; hi
        // drops to 1 at station 2 and climbs 0.5 per step from there
        const range = { from: 0, to: 4, y: 3 }, point = { from: 2, to: 2, y: 1 };
        for (const pins of [[range, point], [point, range]]) {
            const { lo, hi } = pinEnvelope(5, 1, 0.5, pins);
            expect(Array.from(lo)).toEqual([3, 3, 3, 3, 3]);
            expect(Array.from(hi)).toEqual([2, 1.5, 1, 1.5, 2]);
        }
    });

    it('does not loosen a pin on a station with a weaker pin between stations', () => {
        // Station 1 (s = 2) pinned at 1.2 for lo and 0.8 for hi; a point pin
        // at s = 3, 1 m from stations 1 and 2 (grade 0.5), allows 1 ± 0.5
        // there: lo 1.2 and hi 0.8 stay
        const lo = pinEnvelope(5, 2, 0.5, [{ from: 2, to: 2, y: 1.2 }, { from: 3, to: 3, y: 1 }]).lo;
        expect(lo[1]).toBe(1.2);
        const hi = pinEnvelope(5, 2, 0.5, [{ from: 2, to: 2, y: 0.8 }, { from: 3, to: 3, y: 1 }]).hi;
        expect(hi[1]).toBe(0.8);
    });

    it('holds a pin beyond the last station at the last station', () => {
        // Stations 0 .. 8 m (spacing 2); a pin at s = 11 counts at s = 8
        const { lo, hi } = pinEnvelope(5, 2, 0.5, [{ from: 11, to: 11, y: 4 }]);
        expect(lo[4]).toBe(4);
        expect(hi[4]).toBe(4);
        expect(lo[0]).toBe(0);         // 8 m back at 0.5
        expect(hi[0]).toBe(8);
    });

    it('spreads a pin forward with the grade of each step', () => {
        // Grades 0.5, 0.25, 1 at 2 m: steps of 1, 0.5 and 2 m
        const { lo, hi } = pinEnvelope(4, 2, [0.5, 0.25, 1], [{ from: 0, to: 0, y: 0 }]);
        expect(Array.from(hi)).toEqual([0, 1, 1.5, 3.5]);
        expect(Array.from(lo)).toEqual([0, -1, -1.5, -3.5]);
    });
});

describe('longitudinalProfile: a grade limit that changes along the road', () => {
    it('rounds into a stretch with a lower or a higher grade limit without a kink', () => {
        // 12 % for the first 100 m and 2 % after, or the other way round:
        // the ground climbs 10 % all along, so the grade limit binds on
        // both parts. The slope must turn with at most spacing² / R per step
        // and never exceed the limit of its own step.
        const n = 101, spacing = 2, radius = 150;
        const natural = Array.from({ length: n }, (_, i) => 0.1 * i * spacing);
        for (const [early, late] of [[0.12, 0.02], [0.02, 0.12]]) {
            const grades = Float64Array.from({ length: n - 1 }, (_, i) => (i < 50 ? early : late));
            const { heights, unrounded } = longitudinalProfile(natural, spacing, grades, [{ from: 0, to: 0, y: 0 }], radius);
            expect(unrounded).toBe(0);
            let worstBend = 0;
            for (let i = 0; i + 1 < n; i++) {
                expect(Math.abs(heights[i + 1] - heights[i]), `${early} step ${i}`).toBeLessThanOrEqual(grades[i] * spacing + 1e-9);
                if (i > 0) worstBend = Math.max(worstBend, Math.abs(heights[i + 1] - 2 * heights[i] + heights[i - 1]));
            }
            expect(worstBend, `${early}`).toBeLessThanOrEqual(spacing * spacing / radius + 1e-9);
            // The 2 % part lags behind the ground, so the profile runs at the
            // limit on both parts, away from the bend between them
            expect(heights[20] - heights[19]).toBeCloseTo(early * spacing, 6);
            expect(heights[99] - heights[98]).toBeCloseTo(late * spacing, 6);
        }
    });
});

describe('TerrainShaper: sides, widths, flags per vertex and the conflict report', () => {
    const cellOf = (x: number, z: number) => ((z - GRID.originZ) / 2) * GRID.cols + (x - GRID.originX) / 2;

    it('uses the left and right half widths of a road that does not run through the origin', () => {
        // Eastbound along z = 20: left is north (-z). Flat 12 m left, 5 m right
        for (const [x0, z0, x1, z1, leftAt, rightAt] of [
            [-100, 20, 100, 20, (d: number) => [0, 20 - d], (d: number) => [0, 20 + d]],
            // Northbound along x = 30 (towards -z): left is west (-x)
            [30, 100, 30, -100, (d: number) => [30 - d, 0], (d: number) => [30 + d, 0]]
        ] as const) {
            const line = straight(x0, z0, x1, z1, () => 0);
            line.halfLeft = new Array(line.x.length).fill(12);
            line.halfRight = new Array(line.x.length).fill(5);
            const shaper = new TerrainShaper(GRID, plane(() => 6));
            shaper.addLine(line);
            const { heights } = shaper.finish();
            const h = (p: readonly number[]) => heights[cellOf(p[0], p[1])];
            expect(h(leftAt(12))).toBe(0);
            expect(h(leftAt(14))).toBeCloseTo(2 / 1.5, 12);
            expect(h(rightAt(4))).toBe(0);
            expect(h(rightAt(6))).toBeCloseTo(1 / 1.5, 12);
            // The cut (d - 5) / 1.5 meets the ground at d = 14
            expect(h(rightAt(16))).toBe(6);
        }
    });

    it('interpolates a half width that grows along the road', () => {
        // Flat half 9 m at x = -100 growing to 29 m at x = 100: 19 m at x = 0
        const line = straight(-100, 0, 100, 0, () => 0);
        const n = line.x.length;
        line.halfLeft = line.halfRight = Array.from({ length: n }, (_, k) => 9 + 20 * k / (n - 1));
        const shaper = new TerrainShaper(GRID, plane(() => 6));
        shaper.addLine(line);
        const { heights } = shaper.finish();
        expect(at(heights, 0, 18)).toBe(0);
        expect(at(heights, 0, 20)).toBeCloseTo(1 / 1.5, 12);
    });

    it('takes the wall and surface flags of the nearer vertex of a segment', () => {
        // Vertices every 3 m from x = -100: ..., -1, 2, ... The grid point x = 0
        // lies a third along the segment -1 .. 2, so it belongs to vertex -1.
        const xs: number[] = [];
        for (let x = -100; x <= 101; x += 3) xs.push(x);
        const n = xs.length;
        const flag = (from: number) => xs.map(x => (x >= from ? 1 : 0));
        const line: CorridorLine = {
            x: xs, z: new Array(n).fill(0), y: new Array(n).fill(0),
            halfLeft: new Array(n).fill(9), halfRight: new Array(n).fill(9),
            wallLeft: flag(2),
            surface: xs.map(x => (x >= 2 ? SURFACE.asphalt : SURFACE.dirt)), surfaceHalf: new Array(n).fill(6)
        };
        const shaper = new TerrainShaper(GRID, plane(() => 6));
        shaper.addLine(line);
        const { heights } = shaper.finish();
        // x = 0: vertex -1 (no wall, dirt); x = 2: vertex 2 (wall, asphalt)
        expect(at(heights, 0, -10)).toBeCloseTo(1 / 1.5, 12);
        expect(at(heights, 2, -10)).toBe(6);
        expect(shaper.surface[cellOf(0, 0)]).toBe(SURFACE.dirt);
        expect(shaper.surface[cellOf(2, 0)]).toBe(SURFACE.asphalt);
    });

    it('keeps the higher priority surface whichever line comes last, and stamps beyond the flat zone', () => {
        const road = straight(-100, 0, 100, 0, () => 0);
        road.surface = new Array(road.x.length).fill(SURFACE.asphalt);
        road.surfaceHalf = new Array(road.x.length).fill(6);
        // A sand strip 20 m wide each side of a narrow (flat 9 m) line
        const beach = straight(0, -60, 0, 60, () => 0);
        beach.surface = new Array(beach.x.length).fill(SURFACE.sand);
        beach.surfaceHalf = new Array(beach.x.length).fill(20);
        const shaper = new TerrainShaper(GRID, plane(() => 0));
        shaper.addLine(road);
        shaper.addLine(beach);
        expect(shaper.surface[cellOf(0, 0)]).toBe(SURFACE.asphalt);
        expect(shaper.surface[cellOf(18, 30)]).toBe(SURFACE.sand);
        expect(shaper.surface[cellOf(22, 30)]).toBe(-1);
    });

    it('shapes an area on every side and leaves the surface of an area without one alone', () => {
        const shaper = new TerrainShaper(GRID, plane(() => 0));
        shaper.addArea({ polygon: [[-20, -20], [20, -20], [20, 20], [-20, 20]], y: 5, margin: 4, walls: false });
        const { heights } = shaper.finish();
        for (const [x, z] of [[24, 0], [-24, 0], [0, 24], [0, -24]]) expect(at(heights, x, z), `${x} ${z}`).toBe(5);
        for (const [x, z] of [[26, 0], [-26, 0], [0, 26], [0, -26]]) expect(at(heights, x, z), `${x} ${z}`).toBeCloseTo(5 - 2 / 1.5, 12);
        expect(shaper.surface[cellOf(0, 0)]).toBe(-1);
    });

    it('reports where the worst conflict is', () => {
        // Two parallel roads 20 m apart, 10 m apart in height, from x = -40
        // to 40: at z = 10 the lower road allows at most 1/1.5 and the upper
        // one at least 10 - 1/1.5, the largest gap; the first such grid
        // point in row order is at the west end
        const shaper = new TerrainShaper(GRID, plane(() => 0));
        shaper.addLine(straight(-40, 0, 40, 0, () => 0));
        shaper.addLine(straight(-40, 20, 40, 20, () => 10));
        const { conflicts } = shaper.finish();
        expect(conflicts.worstZ).toBe(10);
        expect(conflicts.maxGap).toBeCloseTo(10 - 2 / 1.5, 12);
        expect(conflicts.worstX).toBeGreaterThanOrEqual(-40);
        expect(conflicts.worstX).toBeLessThanOrEqual(-30);
        expect(Math.abs(conflicts.worstX % 2)).toBe(0);
    });
});
