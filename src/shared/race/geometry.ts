// Polylines of the race mode (docs/phase-2-design.md, 5.4): corners
// rounded with circular arcs, an optional out-in-out shift through each
// corner, resampling every LINE_STEP metres and a projection onto the line
// that searches only a window around the last index, so it never jumps to
// a parallel leg one block away.
//
// Conventions as in the sim: forward (sin yaw, cos yaw), left
// (cos yaw, -sin yaw). For a unit tangent (tx, tz) the left normal is
// (tz, -tx). Signed curvature is + for a left turn.

import { LINE_STEP, LINE_WINDOW, OFF_LINE_DISTANCE } from './rules.js';
import type { Vec2 } from './types.js';

export interface LinePoint {
    x: number; z: number;
    s: number;             // arc length from the first point (m)
    tx: number; tz: number; // unit tangent
    curvature: number;     // 1/m, + = left turn
}

export interface Polyline {
    points: LinePoint[];
    length: number;        // closed: including the segment back to the first point
    closed: boolean;
}

// ---- Rounded path ----

export type PathPiece =
    | { kind: 'line'; x0: number; z0: number; x1: number; z1: number; length: number }
    // Arc around (cx, cz) with radius r from angle a0 (atan2(z - cz, x - cx)),
    // turning by sweep (rad, counter-clockwise in the x-z plane for sweep > 0)
    | { kind: 'arc'; cx: number; cz: number; r: number; a0: number; sweep: number; length: number };

// One rounded corner: where its arc's middle lies along the path, half the
// arc's length and the side of the inside (+1 left, -1 right)
export interface CornerMark { s: number; halfLength: number; inside: number }

export interface RoundedPath {
    pieces: PathPiece[];
    corners: CornerMark[];
    length: number;
    closed: boolean;
}

/**
 * Rounds every corner of the polyline with a circular arc of the given
 * radius. The arc's tangent length R·tan(θ/2) is limited to half of the
 * shorter adjacent leg, so neighbouring arcs never overlap (the radius
 * shrinks accordingly). A closed path rounds every vertex, an open one only
 * the inner vertices.
 */
export function roundCorners(points: readonly Vec2[], closed: boolean, radius: number): RoundedPath {
    const n = points.length;
    if (n < 2 || (closed && n < 3)) throw new Error('a path needs at least 2 points (3 when closed)');
    const legCount = closed ? n : n - 1;
    const leg = (i: number) => {
        const a = points[i], b = points[(i + 1) % n];
        const length = Math.hypot(b.x - a.x, b.z - a.z);
        if (!(length > 0)) throw new Error(`path leg ${i} has no length`);
        return { dx: (b.x - a.x) / length, dz: (b.z - a.z) / length, length };
    };
    const legs = Array.from({ length: legCount }, (_, i) => leg(i));

    // Per vertex: the tangent points where its arc starts and ends
    interface Fillet { ex: number; ez: number; xx: number; xz: number; arc: PathPiece | null; inside: number }
    const fillets: Fillet[] = [];
    for (let i = 0; i < n; i++) {
        const v = points[i];
        const hasCorner = closed || (i > 0 && i < n - 1);
        if (!hasCorner) {
            fillets.push({ ex: v.x, ez: v.z, xx: v.x, xz: v.z, arc: null, inside: 0 });
            continue;
        }
        const d1 = legs[(i - 1 + legCount) % legCount], d2 = legs[i % legCount];
        const cross = d1.dx * d2.dz - d1.dz * d2.dx;
        const dot = d1.dx * d2.dx + d1.dz * d2.dz;
        const theta = Math.atan2(cross, dot);   // counter-clockwise in the x-z plane
        const half = Math.abs(theta) / 2;
        if (half < 1e-9) {
            fillets.push({ ex: v.x, ez: v.z, xx: v.x, xz: v.z, arc: null, inside: 0 });
            continue;
        }
        const tangent = Math.min(radius * Math.tan(half), d1.length / 2, d2.length / 2);
        const r = tangent / Math.tan(half);
        const ex = v.x - d1.dx * tangent, ez = v.z - d1.dz * tangent;
        // Normal towards the inside: d1 turned by 90° towards the turn
        const sign = Math.sign(theta);
        const cx = ex - sign * d1.dz * r, cz = ez + sign * d1.dx * r;
        const arc: PathPiece = {
            kind: 'arc', cx, cz, r, a0: Math.atan2(ez - cz, ex - cx), sweep: theta, length: r * Math.abs(theta)
        };
        // Counter-clockwise in x-z is a right turn for the car (left is -cross)
        fillets.push({ ex, ez, xx: v.x + d2.dx * tangent, xz: v.z + d2.dz * tangent, arc, inside: -sign });
    }

    const pieces: PathPiece[] = [];
    const corners: CornerMark[] = [];
    let s = 0;
    const pushLine = (x0: number, z0: number, x1: number, z1: number) => {
        const length = Math.hypot(x1 - x0, z1 - z0);
        if (length > 1e-12) {
            pieces.push({ kind: 'line', x0, z0, x1, z1, length });
            s += length;
        }
    };
    const pushArc = (fillet: Fillet) => {
        if (!fillet.arc) return;
        corners.push({ s: s + fillet.arc.length / 2, halfLength: fillet.arc.length / 2, inside: fillet.inside });
        pieces.push(fillet.arc);
        s += fillet.arc.length;
    };
    if (closed) {
        // Starts at the first vertex's arc end, so s = 0 lies on its exit
        for (let i = 1; i <= n; i++) {
            const prev = fillets[i - 1], cur = fillets[i % n];
            pushLine(prev.xx, prev.xz, cur.ex, cur.ez);
            pushArc(cur);
        }
    } else {
        for (let i = 0; i < n - 1; i++) {
            const prev = fillets[i], cur = fillets[i + 1];
            pushLine(prev.xx, prev.xz, cur.ex, cur.ez);
            // The end point has no arc
            pushArc(cur);
        }
    }
    return { pieces, corners, length: s, closed };
}

// Point and unit tangent of a path piece at distance u from its start
function pieceAt(piece: PathPiece, u: number, out: { x: number; z: number; tx: number; tz: number }): void {
    if (piece.kind === 'line') {
        const tx = (piece.x1 - piece.x0) / piece.length, tz = (piece.z1 - piece.z0) / piece.length;
        out.x = piece.x0 + tx * u;
        out.z = piece.z0 + tz * u;
        out.tx = tx;
        out.tz = tz;
        return;
    }
    const sign = Math.sign(piece.sweep);
    const a = piece.a0 + sign * u / piece.r;
    out.x = piece.cx + piece.r * Math.cos(a);
    out.z = piece.cz + piece.r * Math.sin(a);
    out.tx = -sign * Math.sin(a);
    out.tz = sign * Math.cos(a);
}

// Out-in-out shape of one corner at distance d from its apex: +1 (inside)
// at the apex, -1 (outside) where the arc starts and ends, back to 0 one
// more half arc length out; smooth throughout
function apexShape(d: number, halfLength: number): number {
    const a = Math.abs(d);
    if (a <= halfLength) return Math.cos(Math.PI * a / halfLength);
    if (a <= 2 * halfLength) {
        const c = Math.cos(Math.PI * (a - halfLength) / (2 * halfLength));
        return -c * c;
    }
    return 0;
}

// Signed distance from a to b along a path of the given length (closed: the
// shorter way round)
function pathDelta(a: number, b: number, length: number, closed: boolean): number {
    let d = b - a;
    if (closed) {
        d = ((d % length) + length) % length;
        if (d >= length / 2) d -= length;
    }
    return d;
}

/**
 * Samples a rounded path every step metres (closed: s < length; open: plus
 * the end point) and shifts each sample sideways by the out-in-out offset
 * of the corners (at most apexShift towards the inside at the apex). Then
 * arc length, tangent (central differences) and curvature (circle through
 * three neighbours) come from the final points.
 */
export function samplePath(path: RoundedPath, step: number = LINE_STEP, apexShift = 0): Polyline {
    const raw: { x: number; z: number }[] = [];
    const scratch = { x: 0, z: 0, tx: 0, tz: 0 };
    let pieceIndex = 0, pieceStart = 0;
    const count = path.closed ? Math.ceil(path.length / step - 1e-9) : Math.floor(path.length / step + 1e-9) + 1;
    for (let k = 0; k < count; k++) {
        const s = Math.min(k * step, path.length);
        while (pieceIndex < path.pieces.length - 1 && s > pieceStart + path.pieces[pieceIndex].length) {
            pieceStart += path.pieces[pieceIndex].length;
            pieceIndex++;
        }
        pieceAt(path.pieces[pieceIndex], Math.min(s - pieceStart, path.pieces[pieceIndex].length), scratch);
        let offset = 0;
        if (apexShift !== 0) {
            for (const corner of path.corners) {
                offset += corner.inside * apexShift * apexShape(pathDelta(corner.s, s, path.length, path.closed), corner.halfLength);
            }
            offset = Math.max(-apexShift, Math.min(apexShift, offset));
        }
        // Left normal of the tangent
        raw.push({ x: scratch.x + offset * scratch.tz, z: scratch.z - offset * scratch.tx });
    }
    if (!path.closed && path.length - (count - 1) * step > 1e-9) {
        const last = path.pieces[path.pieces.length - 1];
        pieceAt(last, last.length, scratch);
        raw.push({ x: scratch.x, z: scratch.z });
    }
    return polylineFromPoints(raw, path.closed);
}

/** Arc length, tangents and signed curvature of a point list. */
export function polylineFromPoints(raw: readonly { x: number; z: number }[], closed: boolean): Polyline {
    const n = raw.length;
    const points: LinePoint[] = [];
    let s = 0;
    for (let i = 0; i < n; i++) {
        if (i > 0) s += Math.hypot(raw[i].x - raw[i - 1].x, raw[i].z - raw[i - 1].z);
        points.push({ x: raw[i].x, z: raw[i].z, s, tx: 0, tz: 1, curvature: 0 });
    }
    const length = closed ? s + Math.hypot(raw[0].x - raw[n - 1].x, raw[0].z - raw[n - 1].z) : s;
    for (let i = 0; i < n; i++) {
        const hasPrev = closed || i > 0, hasNext = closed || i < n - 1;
        const a = raw[hasPrev ? (i - 1 + n) % n : i];
        const b = raw[i];
        const c = raw[hasNext ? (i + 1) % n : i];
        const dx = c.x - a.x, dz = c.z - a.z;
        const d = Math.hypot(dx, dz);
        if (d > 0) {
            points[i].tx = dx / d;
            points[i].tz = dz / d;
        }
        // Circle through the neighbours; an end point of an open line has
        // itself as one neighbour, so no circle and curvature 0
        const abx = b.x - a.x, abz = b.z - a.z, bcx = c.x - b.x, bcz = c.z - b.z;
        // Left is -cross in the x-z plane (see the header)
        const cross = abx * bcz - abz * bcx;
        const denominator = Math.hypot(abx, abz) * Math.hypot(bcx, bcz) * d;
        points[i].curvature = denominator > 0 ? -2 * cross / denominator : 0;
    }
    return { points, length, closed };
}

// ---- Projection ----

export interface Projection {
    index: number;     // start point of the nearest segment
    s: number;         // arc length of the projected point
    x: number; z: number;
    dist: number;      // distance from the line (m)
    tx: number; tz: number;  // unit direction of that segment
}

export function createProjection(): Projection {
    return { index: 0, s: 0, x: 0, z: 0, dist: 0, tx: 0, tz: 1 };
}

function segmentCount(line: Polyline): number {
    return line.closed ? line.points.length : line.points.length - 1;
}

// Projects (x, z) onto segment i; writes into out when it is nearer than
// out.dist already is. Returns the squared distance.
function projectSegment(line: Polyline, i: number, x: number, z: number): { t: number; d2: number } {
    const pts = line.points;
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const abx = b.x - a.x, abz = b.z - a.z;
    const len2 = abx * abx + abz * abz;
    let t = len2 > 0 ? ((x - a.x) * abx + (z - a.z) * abz) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a.x + abx * t, pz = a.z + abz * t;
    segmentScratch.t = t;
    segmentScratch.d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
    return segmentScratch;
}
const segmentScratch = { t: 0, d2: 0 };

function writeProjection(line: Polyline, i: number, t: number, d2: number, out: Projection): Projection {
    const pts = line.points;
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const abx = b.x - a.x, abz = b.z - a.z;
    const len = Math.sqrt(abx * abx + abz * abz);
    out.index = i;
    out.x = a.x + abx * t;
    out.z = a.z + abz * t;
    out.s = a.s + len * t;
    // The end of a closed line's last segment is its start
    if (line.closed && out.s >= line.length) out.s -= line.length;
    out.dist = Math.sqrt(d2);
    if (len > 0) {
        out.tx = abx / len;
        out.tz = abz / len;
    }
    return out;
}

/**
 * Nearest point of the line to (x, z), searching only the segments within
 * `window` of hint (wrapping on a closed line, clamped on an open one).
 */
export function projectNear(line: Polyline, x: number, z: number, hint: number, out: Projection, window: number = LINE_WINDOW): Projection {
    const segments = segmentCount(line);
    let bestI = -1, bestT = 0, bestD2 = Infinity;
    const span = Math.min(window, Math.floor((segments - 1) / 2));
    for (let k = -span; k <= span; k++) {
        let i = hint + k;
        if (line.closed) i = ((i % segments) + segments) % segments;
        else if (i < 0 || i >= segments) continue;
        const hit = projectSegment(line, i, x, z);
        if (hit.d2 < bestD2) { bestD2 = hit.d2; bestI = i; bestT = hit.t; }
    }
    if (bestI < 0) return projectGlobal(line, x, z, out);
    return writeProjection(line, bestI, bestT, bestD2, out);
}

/**
 * Nearest point of the whole line. With expectedS (the car's progress),
 * the nearest point of each stretch of line within OFF_LINE_DISTANCE is a
 * candidate (a local minimum of the distance), and the one closest to
 * expectedS along the line wins, so a car between two parallel legs lands
 * on the one it drives.
 */
export function projectGlobal(line: Polyline, x: number, z: number, out: Projection, expectedS?: number): Projection {
    const segments = segmentCount(line);
    if (distances.length < segments) distances = new Float64Array(segments * 2);
    const params = segmentParams.length < segments ? (segmentParams = new Float64Array(segments * 2)) : segmentParams;
    let bestI = 0, bestD2 = Infinity;
    for (let i = 0; i < segments; i++) {
        const hit = projectSegment(line, i, x, z);
        distances[i] = hit.d2;
        params[i] = hit.t;
        if (hit.d2 < bestD2) { bestD2 = hit.d2; bestI = i; }
    }
    if (expectedS !== undefined && bestD2 <= OFF_LINE_DISTANCE * OFF_LINE_DISTANCE) {
        // Candidates: local minima of the distance along the line (one per
        // leg the point is near), within OFF_LINE_DISTANCE
        let bestGap = Infinity;
        for (let i = 0; i < segments; i++) {
            const d2 = distances[i];
            if (d2 > OFF_LINE_DISTANCE * OFF_LINE_DISTANCE) continue;
            const prev = line.closed ? (i - 1 + segments) % segments : i - 1;
            const next = line.closed ? (i + 1) % segments : i + 1;
            if (prev >= 0 && distances[prev] < d2) continue;
            if (next < segments && distances[next] < d2) continue;
            const a = line.points[i];
            const b = line.points[(i + 1) % line.points.length];
            const s = a.s + Math.hypot(b.x - a.x, b.z - a.z) * params[i];
            const gap = Math.abs(pathDelta(expectedS, s, line.length, line.closed));
            if (gap < bestGap) { bestGap = gap; bestI = i; }
        }
    }
    return writeProjection(line, bestI, params[bestI], distances[bestI], out);
}
let distances = new Float64Array(0);
let segmentParams = new Float64Array(0);

/** Signed distance from s0 forward to s1 along the line (closed: into [-L/2, L/2)). */
export function lineDelta(line: Polyline, s0: number, s1: number): number {
    return pathDelta(s0, s1, line.length, line.closed);
}

/**
 * The point at arc length s on the line (closed: s wraps; open: clamped to
 * the ends), with the direction of its segment. dist is 0.
 */
export function pointAt(line: Polyline, s: number, out: Projection): Projection {
    const pts = line.points;
    const n = pts.length;
    const segments = segmentCount(line);
    let at = s;
    if (line.closed) at = ((at % line.length) + line.length) % line.length;
    else at = at < 0 ? 0 : at > line.length ? line.length : at;
    // Last point with pts[i].s <= at, among the segment starts
    let lo = 0, hi = segments - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (pts[mid].s <= at) lo = mid;
        else hi = mid - 1;
    }
    const a = pts[lo], b = pts[(lo + 1) % n];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const t = len > 0 ? Math.min(1, (at - a.s) / len) : 0;
    writeProjection(line, lo, t, 0, out);
    return out;
}
