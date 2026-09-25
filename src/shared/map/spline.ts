// Road centre lines (docs/phase-3-design.md, 5.3): centripetal Catmull-Rom
// and cubic Bézier curves, both evaluated as cubic Bézier segments, and the
// resampling to exactly 1 m of arc length that bake, road meshes, resets
// and routeToTrack share.
//
// Determinism: the samples feed the guard-rail colliders, which go into the
// sim and into worldHash, which client and server compare strictly. So this
// module uses only +, -, ×, ÷ and Math.sqrt, which IEEE-754 and ECMAScript
// round exactly, never Math.hypot or trigonometry, which engines only
// approximate (tests/shared/map/determinism.test.ts).

import type { RoadSample } from './types.js';

export type Point2 = readonly [number, number];

// A cubic Bézier segment p0 → p1 with the handles c1 (at p0) and c2 (at p1)
export interface CubicSegment {
    p0x: number; p0z: number;
    c1x: number; c1z: number;
    c2x: number; c2z: number;
    p1x: number; p1z: number;
}

export function cubic(p0: Point2, c1: Point2, c2: Point2, p1: Point2): CubicSegment {
    return {
        p0x: p0[0], p0z: p0[1], c1x: c1[0], c1z: c1[1],
        c2x: c2[0], c2z: c2[1], p1x: p1[0], p1z: p1[1]
    };
}

// Left of the direction (tx, tz): with y up, north = -z and east = +x, a car
// looking north (0, -1) has west (-1, 0) on its left (design E2).
export function leftNormal(tx: number, tz: number): [number, number] {
    return [tz, -tx];
}

// Knot interval of the centripetal parameterisation: |b - a|^0.5
function knot(ax: number, az: number, bx: number, bz: number): number {
    const dx = bx - ax, dz = bz - az;
    return Math.sqrt(Math.sqrt(dx * dx + dz * dz));
}

// The Catmull-Rom segment between p1 and p2 (with the neighbours p0 and p3)
// as a Bézier segment. Centripetal (alpha = 0.5), so unevenly spaced points
// give neither loops nor cusps. The tangents are those of the non-uniform
// Catmull-Rom spline for the unit parameter of the segment; the Bézier
// handles are then p1 + m1/3 and p2 - m2/3.
export function catmullRomSegment(p0: Point2, p1: Point2, p2: Point2, p3: Point2): CubicSegment {
    const t01 = knot(p0[0], p0[1], p1[0], p1[1]);
    const t12 = knot(p1[0], p1[1], p2[0], p2[1]);
    const t23 = knot(p2[0], p2[1], p3[0], p3[1]);
    const m1x = p2[0] - p1[0] + t12 * ((p1[0] - p0[0]) / t01 - (p2[0] - p0[0]) / (t01 + t12));
    const m1z = p2[1] - p1[1] + t12 * ((p1[1] - p0[1]) / t01 - (p2[1] - p0[1]) / (t01 + t12));
    const m2x = p2[0] - p1[0] + t12 * ((p3[0] - p2[0]) / t23 - (p3[0] - p1[0]) / (t12 + t23));
    const m2z = p2[1] - p1[1] + t12 * ((p3[1] - p2[1]) / t23 - (p3[1] - p1[1]) / (t12 + t23));
    return cubic(p1, [p1[0] + m1x / 3, p1[1] + m1z / 3], [p2[0] - m2x / 3, p2[1] - m2z / 3], p2);
}

// Mirrored phantom point: 2·p - q, so the curve runs straight into p
export function mirror(p: Point2, q: Point2): [number, number] {
    return [2 * p[0] - q[0], 2 * p[1] - q[1]];
}

// Catmull-Rom through all points. before/after are the phantom neighbours
// of the first and last point (the neighbouring edge's point at a joint,
// otherwise the mirrored second or second to last point).
export function catmullRomChain(points: readonly Point2[], before?: Point2, after?: Point2): CubicSegment[] {
    const n = points.length;
    if (n < 2) throw new Error('a curve needs at least two points');
    const first = before ?? mirror(points[0], points[1]);
    const last = after ?? mirror(points[n - 1], points[n - 2]);
    const segments: CubicSegment[] = [];
    for (let i = 0; i < n - 1; i++) {
        segments.push(catmullRomSegment(
            i === 0 ? first : points[i - 1], points[i], points[i + 1], i + 2 < n ? points[i + 2] : last
        ));
    }
    return segments;
}

// Position, first and second derivative of a segment at u in [0, 1]
export interface CurvePoint { x: number; z: number; dx: number; dz: number; ddx: number; ddz: number }

export function evalCubic(seg: CubicSegment, u: number, out: CurvePoint): CurvePoint {
    const v = 1 - u;
    const b0 = v * v * v, b1 = 3 * v * v * u, b2 = 3 * v * u * u, b3 = u * u * u;
    out.x = b0 * seg.p0x + b1 * seg.c1x + b2 * seg.c2x + b3 * seg.p1x;
    out.z = b0 * seg.p0z + b1 * seg.c1z + b2 * seg.c2z + b3 * seg.p1z;
    // B'(u) = 3[(1-u)²(c1-p0) + 2(1-u)u(c2-c1) + u²(p1-c2)]
    const d0 = 3 * v * v, d1 = 6 * v * u, d2 = 3 * u * u;
    out.dx = d0 * (seg.c1x - seg.p0x) + d1 * (seg.c2x - seg.c1x) + d2 * (seg.p1x - seg.c2x);
    out.dz = d0 * (seg.c1z - seg.p0z) + d1 * (seg.c2z - seg.c1z) + d2 * (seg.p1z - seg.c2z);
    // B''(u) = 6[(1-u)(c2 - 2c1 + p0) + u(p1 - 2c2 + c1)]
    out.ddx = 6 * (v * (seg.c2x - 2 * seg.c1x + seg.p0x) + u * (seg.p1x - 2 * seg.c2x + seg.c1x));
    out.ddz = 6 * (v * (seg.c2z - 2 * seg.c1z + seg.p0z) + u * (seg.p1z - 2 * seg.c2z + seg.c1z));
    return out;
}

// Minimum steps of the arc-length table per segment (design: 64); long
// segments get one step per LENGTH_TABLE_STEP metres, so the linear
// parameter interpolation stays well under a millimetre.
const MIN_TABLE_STEPS = 64;
const LENGTH_TABLE_STEP = 0.25;

// Length of (dx, dz) with exactly rounded operations only (see the header)
export function length2(dx: number, dz: number): number {
    return Math.sqrt(dx * dx + dz * dz);
}

function controlPolygonLength(seg: CubicSegment): number {
    return length2(seg.c1x - seg.p0x, seg.c1z - seg.p0z)
        + length2(seg.c2x - seg.c1x, seg.c2z - seg.c1z)
        + length2(seg.p1x - seg.c2x, seg.p1z - seg.c2z);
}

// Resamples a chain of segments to points spaced `step` metres of arc
// length apart, from s = 0 to the full length (the last piece is shorter).
export function sampleSegments(segments: readonly CubicSegment[], step = 1): { samples: RoadSample[]; length: number } {
    // Arc-length table over all segments: (segment, u) → cumulative chord length
    const segIndex: number[] = [];
    const params: number[] = [];
    const lengths: number[] = [];
    const p: CurvePoint = { x: 0, z: 0, dx: 0, dz: 0, ddx: 0, ddz: 0 };
    let total = 0;
    let prevX = segments[0].p0x, prevZ = segments[0].p0z;
    segIndex.push(0); params.push(0); lengths.push(0);
    segments.forEach((seg, k) => {
        const steps = Math.max(MIN_TABLE_STEPS, Math.ceil(controlPolygonLength(seg) / LENGTH_TABLE_STEP));
        for (let i = 1; i <= steps; i++) {
            const u = i / steps;
            evalCubic(seg, u, p);
            total += length2(p.x - prevX, p.z - prevZ);
            prevX = p.x; prevZ = p.z;
            segIndex.push(k); params.push(u); lengths.push(total);
        }
    });

    const samples: RoadSample[] = [];
    let row = 1;
    const count = Math.floor(total / step + 1e-9);
    const stations: number[] = [];
    for (let i = 0; i <= count; i++) stations.push(i * step);
    if (total - count * step > 1e-6) stations.push(total);
    for (const s of stations) {
        while (row < lengths.length - 1 && lengths[row] < s) row++;
        let k = segIndex[row];
        let u: number;
        const l0 = lengths[row - 1], l1 = lengths[row];
        const u0 = segIndex[row - 1] === k ? params[row - 1] : 0;
        u = l1 > l0 ? u0 + (params[row] - u0) * (s - l0) / (l1 - l0) : params[row];
        if (s <= 0) { k = 0; u = 0; }
        evalCubic(segments[k], u, p);
        const speed = length2(p.dx, p.dz);
        const tx = speed > 0 ? p.dx / speed : 1, tz = speed > 0 ? p.dz / speed : 0;
        // Signed curvature, positive towards the left normal (tz, -tx):
        // κ = (x''·z' - z''·x') / |r'|³
        const curvature = speed > 0 ? (p.ddx * p.dz - p.ddz * p.dx) / (speed * speed * speed) : 0;
        samples.push({ x: p.x, z: p.z, tx, tz, s, curvature });
    }
    return { samples, length: total };
}

// Linear interpolation between the samples at arc length s (clamped to the
// ends). The tangent is interpolated and renormalised.
export function pointAt(samples: readonly RoadSample[], s: number): RoadSample {
    const n = samples.length;
    if (s <= samples[0].s) return { ...samples[0], s: samples[0].s };
    if (s >= samples[n - 1].s) return { ...samples[n - 1] };
    // Samples are 1 m apart except the last piece
    let i = Math.min(n - 2, Math.floor(s - samples[0].s));
    while (i > 0 && samples[i].s > s) i--;
    while (i < n - 2 && samples[i + 1].s <= s) i++;
    const a = samples[i], b = samples[i + 1];
    const t = (s - a.s) / (b.s - a.s);
    let tx = a.tx + (b.tx - a.tx) * t, tz = a.tz + (b.tz - a.tz) * t;
    const len = length2(tx, tz);
    if (len > 0) { tx /= len; tz /= len; }
    return {
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
        tx, tz, s,
        curvature: a.curvature + (b.curvature - a.curvature) * t
    };
}
