// Road corridors in the terrain (docs/phase-3-design.md, 6.4): the
// longitudinal height profile of a road and the cross section that fits the
// terrain to it: a flat zone at road height, then embankments of at most
// 1 : 1.5 back to the natural ground. Used by the bake tool (tools/map)
// only; the game reads the baked result (design E5). Pure and without
// Node or DOM, so the unit tests and the mutation run cover it.

import { pointInPolygon, polygonEdgeDistance, type Vec2 } from './geometry.js';
import type { RoadProfile } from './roadSchema.js';
import { SURFACE_PRIORITY } from './types.js';

// Horizontal run per metre of height of an embankment or cut (1 : 1.5)
export const EMBANKMENT_RUN = 1.5;
// The flat zone reaches at least this far beyond the drivable edge: two
// grid cells, so every cell the road touches has four corners at road
// height and the bilinear surface there is exactly the road
export const FLAT_MARGIN = 4;
export const DEFAULT_MAX_GRADE = 0.08;
// Moving average of the natural ground under the centre line (m)
export const PROFILE_SMOOTH_WINDOW = 60;
// Crests and sags are rounded to at least this vertical radius (m)
export const MIN_VERTICAL_RADIUS = 150;
// Two corridors whose height demands differ by more than this at a grid
// point are reported as a conflict (below: rounding noise at junctions)
export const CONFLICT_TOLERANCE = 0.05;

// Half widths of the flat zone left and right of the centre line: road,
// sidewalk and shoulder, but at least FLAT_MARGIN beyond the road edge
export function flatHalfWidths(profile: RoadProfile): { left: number; right: number } {
    const half = profile.width / 2;
    return {
        left: half + Math.max(profile.sidewalk.left + profile.shoulder, FLAT_MARGIN),
        right: half + Math.max(profile.sidewalk.right + profile.shoulder, FLAT_MARGIN)
    };
}

// ---- Longitudinal profile ----

// A height the profile must meet over the stations [from, to] (a point pin
// has from = to): node heights, junction plateaus, elevation pins
export interface ProfilePin { from: number; to: number; y: number }

// Mean over ±halfWindow samples; the window shrinks at the ends
export function movingAverage(values: ArrayLike<number>, halfWindow: number): Float64Array {
    const n = values.length;
    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + values[i];
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - halfWindow), b = Math.min(n - 1, i + halfWindow);
        out[i] = (prefix[b + 1] - prefix[a]) / (b - a + 1);
    }
    return out;
}

// Grade limit of the step from sample i to i + 1
type Grades = number | ArrayLike<number>;
function gradeOf(grades: Grades, i: number): number {
    return typeof grades === 'number' ? grades : grades[i];
}

// Limits the slope between neighbours to the grade (per step, at the given
// spacing) symmetrically: the mean of the largest limited profile below
// the values and the smallest one above them. A profile that already obeys
// the limit comes back unchanged; a spike is cut to half on both sides.
export function limitGrade(values: ArrayLike<number>, spacing: number, grades: Grades): Float64Array {
    const n = values.length;
    const below = Float64Array.from(values);
    const above = Float64Array.from(values);
    for (let i = 1; i < n; i++) {
        const step = gradeOf(grades, i - 1) * spacing;
        if (below[i] > below[i - 1] + step) below[i] = below[i - 1] + step;
        if (above[i] < above[i - 1] - step) above[i] = above[i - 1] - step;
    }
    for (let i = n - 2; i >= 0; i--) {
        const step = gradeOf(grades, i) * spacing;
        if (below[i] > below[i + 1] + step) below[i] = below[i + 1] + step;
        if (above[i] < above[i + 1] - step) above[i] = above[i + 1] - step;
    }
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = (below[i] + above[i]) / 2;
    return out;
}

// Lowest and highest profile through all pins that keeps the grade limit:
// lo[i] = max over pins (y - grade·distance), hi[i] = min (y + grade·distance)
export function pinEnvelope(n: number, spacing: number, grades: Grades, pins: readonly ProfilePin[]): { lo: Float64Array; hi: Float64Array } {
    const lo = new Float64Array(n).fill(-Infinity);
    const hi = new Float64Array(n).fill(Infinity);
    const last = (n - 1) * spacing;
    for (const pin of pins) {
        const from = Math.max(0, Math.min(last, pin.from));
        const to = Math.max(from, Math.min(last, pin.to));
        // Samples inside the pin range, or the two around a point between samples
        const i0 = Math.floor(from / spacing + 1e-9), i1 = Math.ceil(to / spacing - 1e-9);
        for (let i = i0; i <= i1; i++) {
            const s = i * spacing;
            const d = s < from ? from - s : s > to ? s - to : 0;
            const g = gradeOf(grades, Math.min(i, n - 2));
            if (pin.y - g * d > lo[i]) lo[i] = pin.y - g * d;
            if (pin.y + g * d < hi[i]) hi[i] = pin.y + g * d;
        }
    }
    for (let i = 1; i < n; i++) {
        const step = gradeOf(grades, i - 1) * spacing;
        if (lo[i - 1] - step > lo[i]) lo[i] = lo[i - 1] - step;
        if (hi[i - 1] + step < hi[i]) hi[i] = hi[i - 1] + step;
    }
    for (let i = n - 2; i >= 0; i--) {
        const step = gradeOf(grades, i) * spacing;
        if (lo[i + 1] - step > lo[i]) lo[i] = lo[i + 1] - step;
        if (hi[i + 1] + step < hi[i]) hi[i] = hi[i + 1] + step;
    }
    return { lo, hi };
}

// Linear interpolation of equally spaced values at station s
function valueAt(values: ArrayLike<number>, spacing: number, s: number): number {
    const n = values.length;
    const g = Math.max(0, Math.min(n - 1, s / spacing));
    const i = Math.min(n - 2, Math.floor(g));
    if (i < 0) return values[0];
    return values[i] + (values[i + 1] - values[i]) * (g - i);
}

// Moves the smoothed ground so it meets every pin: the offset (pin height
// minus ground) is interpolated linearly between the pins and held
// constant before the first and after the last one
function applyPins(smoothed: Float64Array, spacing: number, pins: readonly ProfilePin[]): Float64Array {
    const n = smoothed.length;
    if (pins.length === 0) return smoothed;
    const sorted = [...pins].sort((a, b) => a.from - b.from);
    // Offset at both ends of each pin
    const marks: { s: number; offset: number }[] = [];
    for (const pin of sorted) {
        marks.push({ s: pin.from, offset: pin.y - valueAt(smoothed, spacing, pin.from) });
        if (pin.to > pin.from) marks.push({ s: pin.to, offset: pin.y - valueAt(smoothed, spacing, pin.to) });
    }
    const out = new Float64Array(n);
    let m = 0;
    for (let i = 0; i < n; i++) {
        const s = i * spacing;
        while (m < marks.length - 1 && marks[m + 1].s <= s) m++;
        let offset: number;
        if (s <= marks[0].s) offset = marks[0].offset;
        else if (m >= marks.length - 1) offset = marks[marks.length - 1].offset;
        else {
            const a = marks[m], b = marks[m + 1];
            offset = b.s > a.s ? a.offset + (b.offset - a.offset) * (s - a.s) / (b.s - a.s) : b.offset;
        }
        out[i] = smoothed[i] + offset;
    }
    return out;
}

export interface ProfileResult {
    heights: Float64Array;
    // Largest amount by which the pins cannot be met within the grade
    // limit (0 when they can)
    infeasible: number;
    // Stretches between two pins where the grade limit and the vertical
    // radius cannot both be met (too short for the height difference);
    // they keep the grade-limited profile with its kinks
    unrounded: number;
}

// Rounding works on the slopes p[i] = h[i + 1] - h[i] (per step). A
// profile bends with a radius of at least R exactly when neighbouring
// slopes differ by at most spacing² / R, i.e. when the slope sequence is
// Lipschitz with that rate. roundSlopes maps target slopes to such a
// sequence:
//   1. shift all targets by `shift`,
//   2. the mean of the largest rate-limited sequence below them and the
//      smallest one above them (as limitGrade does for heights),
//   3. clamped into [lower, upper], bounds that are rate-limited
//      themselves (grade limit, cones around fixed neighbouring slopes).
// Each step keeps the rate limit, and the result grows monotonically and
// continuously with `shift`, so a bisection on the shift can make the
// slopes add up to a given height difference. Returns the sum.
function roundSlopes(target: Float64Array, shift: number, rate: number, lower: Float64Array, upper: Float64Array,
    below: Float64Array, above: Float64Array, out: Float64Array): number {
    const m = target.length;
    for (let k = 0; k < m; k++) below[k] = above[k] = target[k] + shift;
    for (let k = 1; k < m; k++) {
        if (below[k] > below[k - 1] + rate) below[k] = below[k - 1] + rate;
        if (above[k] < above[k - 1] - rate) above[k] = above[k - 1] - rate;
    }
    for (let k = m - 2; k >= 0; k--) {
        if (below[k] > below[k + 1] + rate) below[k] = below[k + 1] + rate;
        if (above[k] < above[k + 1] - rate) above[k] = above[k + 1] - rate;
    }
    let sum = 0;
    for (let k = 0; k < m; k++) {
        const v = (below[k] + above[k]) / 2;
        out[k] = v < lower[k] ? lower[k] : v > upper[k] ? upper[k] : v;
        sum += out[k];
    }
    return sum;
}

// Bisection steps on the slope shift: 200 halvings reach the resolution of
// a double from any starting interval used here
const SHIFT_BISECTIONS = 200;

// Height profile of a road along equally spaced stations (6.4, step 2):
// 1. the natural ground under the centre line, averaged over 60 m,
// 2. moved to meet the pins (a point pin counts at its nearest station),
// 3. limited to the grade and clamped between the lowest and highest
//    profile the pins allow. This profile meets every pin and the grade
//    limit, but kinks where the grade limit or a pin takes over.
// 4. Crests and sags are rounded to the radius R: between two fixed
//    stretches (pins) the slopes are rounded with roundSlopes, bounded by
//    the grade limit and by the slopes of the fixed neighbours, and shifted
//    by the bisection until they add up to the height difference of the
//    two pins. Stretches without a pin on one side are integrated from the
//    pin they have.
// Where two pins are further apart in height than the grade allows, the
// profile runs midway and infeasible reports the shortfall; where only the
// radius cannot be met, the stretch keeps the profile of step 3.
export function longitudinalProfile(natural: ArrayLike<number>, spacing: number, grades: Grades,
    pins: readonly ProfilePin[], radius = MIN_VERTICAL_RADIUS): ProfileResult {
    const n = natural.length;
    if (n === 0) return { heights: new Float64Array(0), infeasible: 0, unrounded: 0 };
    const snapped = pins.map(pin => {
        if (pin.to > pin.from) return pin;
        const s = Math.round(pin.from / spacing) * spacing;
        return { from: s, to: s, y: pin.y };
    });

    // Steps 1 to 3
    const smoothed = movingAverage(natural, Math.round(PROFILE_SMOOTH_WINDOW / 2 / spacing));
    const base = limitGrade(applyPins(smoothed, spacing, snapped), spacing, grades);
    const { lo, hi } = pinEnvelope(n, spacing, grades, snapped);
    let infeasible = 0;
    const fixed = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        if (lo[i] >= hi[i]) {
            fixed[i] = 1;
            infeasible = Math.max(infeasible, lo[i] - hi[i]);
            base[i] = (lo[i] + hi[i]) / 2;
        } else if (base[i] < lo[i]) base[i] = lo[i];
        else if (base[i] > hi[i]) base[i] = hi[i];
    }
    const heights = Float64Array.from(base);
    if (n < 3) return { heights, infeasible, unrounded: 0 };

    // Step 4. Grade limit per slope, itself rate-limited so that clamping
    // to it keeps the rate (a lower grade reaches out by the rate)
    const rate = spacing * spacing / radius;
    const steps = n - 1;
    const limit = new Float64Array(steps);
    for (let i = 0; i < steps; i++) limit[i] = gradeOf(grades, i) * spacing;
    for (let i = 1; i < steps; i++) if (limit[i] > limit[i - 1] + rate) limit[i] = limit[i - 1] + rate;
    for (let i = steps - 2; i >= 0; i--) if (limit[i] > limit[i + 1] + rate) limit[i] = limit[i + 1] + rate;

    const target = new Float64Array(steps), lower = new Float64Array(steps), upper = new Float64Array(steps);
    const below = new Float64Array(steps), above = new Float64Array(steps), slopes = new Float64Array(steps);
    let unrounded = 0;
    // Free stretches [a, b] of stations between fixed ones, left to right,
    // so the slope left of a stretch is final when it is rounded
    for (let a = 0; a < n; a++) {
        if (fixed[a]) continue;
        let b = a;
        while (b + 1 < n && !fixed[b + 1]) b++;
        const k0 = Math.max(0, a - 1), k1 = Math.min(steps - 1, b);
        const m = k1 - k0 + 1;
        const t = target.subarray(0, m), lw = lower.subarray(0, m), up = upper.subarray(0, m);
        let span = 1;
        for (let k = 0; k < m; k++) {
            t[k] = base[k0 + k + 1] - base[k0 + k];
            lw[k] = -limit[k0 + k];
            up[k] = limit[k0 + k];
            span = Math.max(span, Math.abs(t[k]), limit[k0 + k]);
        }
        // Cones around the known slopes next to the stretch
        const cone = (slope: number, at: number) => {
            for (let k = 0; k < m; k++) {
                const d = Math.abs(k0 + k - at) * rate;
                if (slope - d > lw[k]) lw[k] = slope - d;
                if (slope + d < up[k]) up[k] = slope + d;
            }
        };
        if (a >= 2) cone(heights[a - 1] - heights[a - 2], a - 2);
        if (b + 2 < n && fixed[b + 2]) cone(heights[b + 2] - heights[b + 1], b + 1);
        let possible = true;
        for (let k = 0; k < m; k++) if (lw[k] > up[k]) possible = false;

        const out = slopes.subarray(0, m);
        const left = a >= 1, right = b + 1 < n;
        if (possible && left && right) {
            // Both ends fixed: the slopes must add up to the height difference
            const want = heights[b + 1] - heights[a - 1];
            let lo2 = -2 * span, hi2 = 2 * span;
            const sumLo = roundSlopes(t, lo2, rate, lw, up, below, above, out);
            const sumHi = roundSlopes(t, hi2, rate, lw, up, below, above, out);
            const tolerance = 1e-9 * Math.max(1, Math.abs(want));
            if (want < sumLo - tolerance || want > sumHi + tolerance) possible = false;
            else {
                for (let i = 0; i < SHIFT_BISECTIONS; i++) {
                    const mid = (lo2 + hi2) / 2;
                    if (mid === lo2 || mid === hi2) break;
                    if (roundSlopes(t, mid, rate, lw, up, below, above, out) < want) lo2 = mid; else hi2 = mid;
                }
                const sum = roundSlopes(t, (lo2 + hi2) / 2, rate, lw, up, below, above, out);
                // What the bisection leaves (float resolution), spread evenly
                const rest = (want - sum) / m;
                let h = heights[a - 1];
                for (let k = 0; k < m - 1; k++) { h += out[k] + rest; heights[a + k] = h; }
            }
        } else if (possible && left) {
            roundSlopes(t, 0, rate, lw, up, below, above, out);
            for (let k = 0; k < m; k++) heights[a + k] = heights[a + k - 1] + out[k];
        } else if (possible && right) {
            roundSlopes(t, 0, rate, lw, up, below, above, out);
            for (let k = m - 1; k >= 0; k--) heights[k] = heights[k + 1] - out[k];
        } else if (possible) {
            // No pin at all: keep the mean height of the base profile
            roundSlopes(t, 0, rate, lw, up, below, above, out);
            let h = 0, offset = base[0];
            for (let k = 0; k < m; k++) { h += out[k]; offset += base[k + 1] - h; }
            offset /= n;
            heights[0] = offset;
            h = offset;
            for (let k = 0; k < m; k++) { h += out[k]; heights[k + 1] = h; }
        }
        if (!possible) unrounded++;
        a = b;
    }
    return { heights, infeasible, unrounded };
}

// ---- Cross section: shaping the terrain grid ----

export interface GridGeometry {
    cols: number;
    rows: number;
    cellSize: number;
    originX: number;
    originZ: number;
}

// A road as a polyline of its samples with the profile height and the flat
// half widths per vertex. wallLeft/wallRight = 1 marks a retaining wall at
// that vertex: beyond the flat zone the terrain keeps its natural height
// (a vertical step) instead of an embankment. The surface ID (-1: none) is
// stamped within surfaceHalf of the centre line. A whole chain of edges is
// one line, so a joint is an ordinary vertex and not a line end.
export interface CorridorLine {
    x: ArrayLike<number>;
    z: ArrayLike<number>;
    y: ArrayLike<number>;
    halfLeft: ArrayLike<number>;
    halfRight: ArrayLike<number>;
    wallLeft?: ArrayLike<number>;
    wallRight?: ArrayLike<number>;
    surface?: ArrayLike<number>;
    surfaceHalf?: ArrayLike<number>;
}

// A flat polygon (plaza, car park, pier). margin is the flat zone beyond
// the outline; with walls the outline drops vertically to the terrain.
export interface CorridorArea {
    polygon: readonly Vec2[];
    y: number;
    margin: number;
    walls: boolean;
    surface?: number;
}

export interface ConflictReport {
    // Grid points where two corridors demand heights more than
    // CONFLICT_TOLERANCE apart; they get the midpoint
    count: number;
    maxGap: number;
    worstX: number;
    worstZ: number;
}

// Vertices per piece of a polyline: each piece gets its own search box
const PIECE = 8;
// Natural height range is looked up in blocks of this many grid points
const BLOCK = 16;
// Upper limit of the search radius around a corridor (m)
const MAX_REACH = 240;

// Collects for every grid point the lowest and highest height the corridors
// allow and shapes the natural terrain into that range:
//   lo = max over corridors (road - d / 1.5), hi = min (road + d / 1.5)
// with d the distance beyond the flat zone (0 inside it). Each bound is a
// cone around the road, so the result never gets steeper than 1 : 1.5
// where a corridor shapes it, and it is continuous where corridors meet.
// Conflicts (lo > hi) are reported, not hidden (6.4, step 6).
export class TerrainShaper {
    readonly lo: Float64Array;
    readonly hi: Float64Array;
    // 1 where a flat zone (a road's, an area's) fixes the height
    readonly flat: Uint8Array;
    // Stamped surface ID per grid point, -1 = none
    readonly surface: Int16Array;
    private readonly blockMin: Float64Array;
    private readonly blockMax: Float64Array;
    private readonly blockCols: number;

    constructor(readonly grid: GridGeometry, readonly natural: Float64Array, readonly run = EMBANKMENT_RUN) {
        const n = grid.cols * grid.rows;
        this.lo = new Float64Array(n).fill(-Infinity);
        this.hi = new Float64Array(n).fill(Infinity);
        this.flat = new Uint8Array(n);
        this.surface = new Int16Array(n).fill(-1);
        this.blockCols = Math.ceil(grid.cols / BLOCK);
        const blockRows = Math.ceil(grid.rows / BLOCK);
        this.blockMin = new Float64Array(this.blockCols * blockRows).fill(Infinity);
        this.blockMax = new Float64Array(this.blockCols * blockRows).fill(-Infinity);
        for (let j = 0; j < grid.rows; j++) {
            for (let i = 0; i < grid.cols; i++) {
                const b = Math.floor(j / BLOCK) * this.blockCols + Math.floor(i / BLOCK);
                const h = natural[j * grid.cols + i];
                if (h < this.blockMin[b]) this.blockMin[b] = h;
                if (h > this.blockMax[b]) this.blockMax[b] = h;
            }
        }
    }

    // Grid index range covering [min, max] along one axis
    private span(min: number, max: number, origin: number, count: number): [number, number] {
        const cell = this.grid.cellSize;
        const a = Math.max(0, Math.ceil((min - origin) / cell));
        const b = Math.min(count - 1, Math.floor((max - origin) / cell));
        return [a, b];
    }

    // Search radius around a box of road heights [yMin, yMax]: far enough
    // that the cone from the road reaches every grid point whose natural
    // height it has to change. A block of the grid matters when its highest
    // point is above the cone's top or its lowest below the cone's bottom
    // at the block's nearest distance d: flat + run · (height difference)
    // ≥ d. Every block within MAX_REACH is checked (by its min and max, so
    // no grid point is missed), the radius is the farthest distance the
    // cone reaches into a block that matters.
    private reach(minX: number, minZ: number, maxX: number, maxZ: number, yMin: number, yMax: number, flat: number): number {
        const g = this.grid;
        let radius = flat + 2 * g.cellSize;
        const [i0, i1] = this.span(minX - MAX_REACH, maxX + MAX_REACH, g.originX, g.cols);
        const [j0, j1] = this.span(minZ - MAX_REACH, maxZ + MAX_REACH, g.originZ, g.rows);
        const extent = (BLOCK - 1) * g.cellSize;
        for (let bj = Math.floor(j0 / BLOCK); bj <= Math.floor(j1 / BLOCK); bj++) {
            const bz0 = g.originZ + bj * BLOCK * g.cellSize;
            const dz = Math.max(0, bz0 - maxZ, minZ - (bz0 + extent));
            for (let bi = Math.floor(i0 / BLOCK); bi <= Math.floor(i1 / BLOCK); bi++) {
                const bx0 = g.originX + bi * BLOCK * g.cellSize;
                const dx = Math.max(0, bx0 - maxX, minX - (bx0 + extent));
                const d = Math.sqrt(dx * dx + dz * dz);
                if (d > MAX_REACH) continue;
                const b = bj * this.blockCols + bi;
                const need = flat + this.run * Math.max(0, this.blockMax[b] - yMin, yMax - this.blockMin[b]);
                if (need >= d && need + g.cellSize > radius) radius = need + g.cellSize;
            }
        }
        return radius < MAX_REACH ? radius : MAX_REACH;
    }

    private bound(k: number, y: number, d: number): void {
        const lo = d > 0 ? y - d / this.run : y;
        const hi = d > 0 ? y + d / this.run : y;
        if (d <= 0) this.flat[k] = 1;
        if (lo > this.lo[k]) this.lo[k] = lo;
        if (hi < this.hi[k]) this.hi[k] = hi;
    }

    private stamp(k: number, surface: number): void {
        const current = this.surface[k];
        if (current < 0 || SURFACE_PRIORITY[surface] > SURFACE_PRIORITY[current]) this.surface[k] = surface;
    }

    addLine(line: CorridorLine): void {
        const n = line.x.length;
        const g = this.grid;
        for (let k0 = 0; k0 < Math.max(1, n - 1); k0 += PIECE) {
            const k1 = Math.min(n - 1, k0 + PIECE);
            let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
            let yMin = Infinity, yMax = -Infinity, flat = 0;
            for (let k = k0; k <= k1; k++) {
                if (line.surfaceHalf) flat = Math.max(flat, line.surfaceHalf[k]);
                minX = Math.min(minX, line.x[k]); maxX = Math.max(maxX, line.x[k]);
                minZ = Math.min(minZ, line.z[k]); maxZ = Math.max(maxZ, line.z[k]);
                yMin = Math.min(yMin, line.y[k]); yMax = Math.max(yMax, line.y[k]);
                flat = Math.max(flat, line.halfLeft[k], line.halfRight[k]);
            }
            const radius = this.reach(minX, minZ, maxX, maxZ, yMin, yMax, flat);
            const [i0, i1] = this.span(minX - radius, maxX + radius, g.originX, g.cols);
            const [j0, j1] = this.span(minZ - radius, maxZ + radius, g.originZ, g.rows);
            for (let j = j0; j <= j1; j++) {
                const pz = g.originZ + j * g.cellSize;
                for (let i = i0; i <= i1; i++) {
                    const px = g.originX + i * g.cellSize;
                    // Nearest point of the piece's segments plus one on each
                    // side. A point whose nearest segment is outside the
                    // piece belongs to the neighbouring piece: otherwise the
                    // piece's end would act as a round flat cap at a slightly
                    // different height than the road beside it.
                    let best = Infinity, bestK = k0, bestT = 0;
                    const first = Math.max(0, k0 - 1), last = Math.max(k0 + 1, Math.min(n - 1, k1 + 1));
                    for (let k = first; k < last; k++) {
                        const ax = line.x[k], az = line.z[k];
                        const ex = k + 1 < n ? line.x[k + 1] - ax : 0, ez = k + 1 < n ? line.z[k + 1] - az : 0;
                        const len2 = ex * ex + ez * ez;
                        let t = len2 > 0 ? ((px - ax) * ex + (pz - az) * ez) / len2 : 0;
                        if (t < 0) t = 0; else if (t > 1) t = 1;
                        const dx = px - (ax + t * ex), dz = pz - (az + t * ez);
                        const d2 = dx * dx + dz * dz;
                        if (d2 < best) { best = d2; bestK = k; bestT = t; }
                    }
                    if (bestK < k0 || bestK >= Math.max(k0 + 1, k1)) continue;
                    const dist = Math.sqrt(best);
                    if (dist > radius) continue;
                    const k = bestK, t = bestT, kn = Math.min(n - 1, k + 1);
                    const ex = line.x[kn] - line.x[k], ez = line.z[kn] - line.z[k];
                    const qx = line.x[k] + t * ex, qz = line.z[k] + t * ez;
                    // Left of the direction (ex, ez) is (ez, -ex)
                    const left = (px - qx) * ez - (pz - qz) * ex > 0;
                    const y = line.y[k] + (line.y[kn] - line.y[k]) * t;
                    const halfs = left ? line.halfLeft : line.halfRight;
                    const half = halfs[k] + (halfs[kn] - halfs[k]) * t;
                    const walls = left ? line.wallLeft : line.wallRight;
                    const cell = j * g.cols + i;
                    const d = dist - half;
                    const nearest = t < 0.5 ? k : kn;
                    if (d <= 0 || !(walls && walls[nearest])) this.bound(cell, y, d);
                    if (line.surface && line.surfaceHalf && line.surface[nearest] >= 0
                        && dist <= line.surfaceHalf[nearest]) this.stamp(cell, line.surface[nearest]);
                }
            }
        }
    }

    addArea(area: CorridorArea): void {
        const g = this.grid;
        let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
        for (const [x, z] of area.polygon) {
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
        }
        const margin = area.walls ? 0 : area.margin;
        const radius = area.walls ? margin + g.cellSize : this.reach(minX, minZ, maxX, maxZ, area.y, area.y, margin);
        const [i0, i1] = this.span(minX - radius, maxX + radius, g.originX, g.cols);
        const [j0, j1] = this.span(minZ - radius, maxZ + radius, g.originZ, g.rows);
        for (let j = j0; j <= j1; j++) {
            const pz = g.originZ + j * g.cellSize;
            for (let i = i0; i <= i1; i++) {
                const px = g.originX + i * g.cellSize;
                const inside = pointInPolygon(area.polygon, px, pz);
                const d = inside ? -1 : polygonEdgeDistance(area.polygon, px, pz) - margin;
                const cell = j * g.cols + i;
                if (d <= 0 || !area.walls) this.bound(cell, area.y, d);
                if (inside && area.surface !== undefined) this.stamp(cell, area.surface);
            }
        }
    }

    // The shaped terrain: the natural height clamped into [lo, hi], the
    // midpoint where the corridors disagree
    /**
     * The shaped heights. `noFill` (optional, per grid point): where it is
     * set, the embankments do not fill (a cliff face and the sea at its
     * foot: the fill of a road on the edge would spread down the face as one
     * smooth 1 : 1.5 slope); flat zones and cuts still apply.
     */
    finish(noFill?: Uint8Array): { heights: Float64Array; conflicts: ConflictReport; conflictMask: Uint8Array } {
        const g = this.grid;
        const heights = new Float64Array(this.natural.length);
        const conflictMask = new Uint8Array(this.natural.length);
        const conflicts: ConflictReport = { count: 0, maxGap: 0, worstX: 0, worstZ: 0 };
        for (let k = 0; k < heights.length; k++) {
            const hi = this.hi[k];
            const lo = noFill && noFill[k] && !this.flat[k] ? -Infinity : this.lo[k];
            if (lo > hi) {
                const gap = lo - hi;
                if (gap > CONFLICT_TOLERANCE) {
                    conflicts.count++;
                    conflictMask[k] = 1;
                }
                if (gap > conflicts.maxGap) {
                    conflicts.maxGap = gap;
                    conflicts.worstX = g.originX + (k % g.cols) * g.cellSize;
                    conflicts.worstZ = g.originZ + Math.floor(k / g.cols) * g.cellSize;
                }
                heights[k] = (lo + hi) / 2;
            } else {
                const h = this.natural[k];
                heights[k] = h < lo ? lo : h > hi ? hi : h;
            }
        }
        return { heights, conflicts, conflictMask };
    }
}
