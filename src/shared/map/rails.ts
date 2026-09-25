// Guard rails, railings and fences as chains of capsule colliders
// (docs/phase-3-design.md, 5.5 and 8.2, design E8). The collider shape is
// the new `segment` kind; the sim integration (M3) adds it to the sim's
// Collider union and uses circleVsSegment in its narrow phase.
//
// The colliders go into the sim and into worldHash, which client and server
// compare strictly. They are computed with exactly rounded operations only
// (spline.ts) and their coordinates are rounded to whole millimetres, so a
// stray last bit cannot reach the hash.

import type { Vec2 } from './geometry.js';
import { junctionRadius, type RoadEdgeData, type RoadNetwork } from './roadNetwork.js';
import type { AreaRail, RailKind, RailRange, RoadArea } from './roadSchema.js';
import { leftNormal, length2, pointAt } from './spline.js';

// Capsule around the segment a-b with radius r; top as for the other
// colliders (height of the upper edge above the ground at the collider)
export interface SegmentCollider {
    kind: 'segment';
    ax: number; az: number;
    bx: number; bz: number;
    r: number;
    top: number;
}

// Rail in the sim: top 0.8 m, capsule radius 0.15 m, pieces of at most
// 8 m (5.5). On a curve a piece is shorter, so the straight capsule stays
// within RAIL_MAX_SAGITTA of the curved rail the player sees.
export const RAIL_TOP = 0.8;
export const RAIL_RADIUS = 0.15;
export const RAIL_MAX_SEGMENT = 8;
export const RAIL_MAX_SAGITTA = 0.05;
export const DEFAULT_RAIL_OFFSET = 0.5;
// Fences (the arena, the pier railing) cannot be jumped over
export const RAIL_TOPS: Record<RailKind, number> = {
    wbeam: RAIL_TOP,
    concrete: RAIL_TOP,
    wood: RAIL_TOP,
    fence: Infinity
};

// A rail keeps out of a junction: it starts this far beyond the junction's
// trim radius plus half the road width, where a route turning through the
// junction has left the corner (its transition begins half a road width
// before the trim, trackRoute.ts)
export const RAIL_JUNCTION_GAP = 2;

// How far into the edge a junction at its start or end reaches for rails
export function junctionRailClip(net: RoadNetwork, edge: RoadEdgeData, atStart: boolean): number {
    const node = net.nodes[atStart ? edge.from : edge.to];
    if (node.def.kind !== 'junction') return 0;
    return junctionRadius(net, node) + edge.halfWidth + RAIL_JUNCTION_GAP;
}

// Station range of a rail on its edge (to = -1: up to the end). With the
// network, a rail stops short of the junctions at the edge's ends
// (junctionRailClip); a rail left without length is [to, to].
export function railRange(edge: RoadEdgeData, rail: Pick<RailRange, 'from' | 'to'>, net?: RoadNetwork): [number, number] {
    let to = rail.to < 0 ? edge.length : Math.min(rail.to, edge.length);
    let from = Math.min(rail.from, to);
    if (net) {
        from = Math.max(from, junctionRailClip(net, edge, true));
        to = Math.min(to, edge.length - junctionRailClip(net, edge, false));
        if (from > to) from = to;
    }
    return [from, to];
}

// The rail's line: the edge's samples between from and to, shifted to the
// side by half the road width plus the offset (with the network: clear of
// the junctions)
export function railLine(edge: RoadEdgeData, rail: RailRange, net?: RoadNetwork): Vec2[] {
    const [from, to] = railRange(edge, rail, net);
    const lateral = (rail.side === 'left' ? 1 : -1) * (edge.halfWidth + (rail.offset ?? DEFAULT_RAIL_OFFSET));
    const stations = [from];
    for (const sample of edge.samples) if (sample.s > from && sample.s < to) stations.push(sample.s);
    stations.push(to);
    return stations.map(s => {
        const p = pointAt(edge.samples, s);
        const [nx, nz] = leftNormal(p.tx, p.tz);
        return [p.x + nx * lateral, p.z + nz * lateral] as Vec2;
    });
}

// Distance of point p from the line through a and b (or from a if a = b)
function lineDistance(p: Vec2, a: Vec2, b: Vec2): number {
    const ex = b[0] - a[0], ez = b[1] - a[1];
    const len = length2(ex, ez);
    if (len === 0) return length2(p[0] - a[0], p[1] - a[1]);
    return Math.abs((p[0] - a[0]) * ez - (p[1] - a[1]) * ex) / len;
}

// Splits a polyline into straight pieces (index pairs into the points),
// greedily as long as possible: at most maxLength long and no point in
// between further than tolerance from the piece
export function simplifyPolyline(points: readonly Vec2[], maxLength: number, tolerance: number): [number, number][] {
    const pieces: [number, number][] = [];
    let a = 0;
    while (a < points.length - 1) {
        let b = a + 1;
        while (b + 1 < points.length) {
            const next = b + 1;
            if (length2(points[next][0] - points[a][0], points[next][1] - points[a][1]) > maxLength) break;
            let fits = true;
            for (let k = a + 1; k < next && fits; k++) fits = lineDistance(points[k], points[a], points[next]) <= tolerance;
            if (!fits) break;
            b = next;
        }
        pieces.push([a, b]);
        a = b;
    }
    return pieces;
}

// A collider coordinate rounded to whole millimetres. Math.round and the
// division are exact, so equal inputs give equal outputs in every engine.
export function toMillimetres(v: number): number {
    return Math.round(v * 1000) / 1000;
}

function segmentsAlong(line: readonly Vec2[], top: number): SegmentCollider[] {
    return simplifyPolyline(line, RAIL_MAX_SEGMENT, RAIL_MAX_SAGITTA).map(([a, b]) => ({
        kind: 'segment',
        ax: toMillimetres(line[a][0]), az: toMillimetres(line[a][1]),
        bx: toMillimetres(line[b][0]), bz: toMillimetres(line[b][1]),
        r: RAIL_RADIUS,
        top
    }));
}

export function railColliders(edge: RoadEdgeData, rail: RailRange, net?: RoadNetwork): SegmentCollider[] {
    const [from, to] = railRange(edge, rail, net);
    if (to <= from) return [];
    return segmentsAlong(railLine(edge, rail, net), RAIL_TOPS[rail.kind]);
}

// ---- Railings along areas (pier, lookouts, quays) ----

// A railing stands this far inside the area's outline by default: on the
// deck, not on its edge
export const DEFAULT_AREA_RAIL_OFFSET = 0.3;

// Twice the signed area in the x-z plane (positive: counter-clockwise when
// x points right and z up, i.e. clockwise on the map with north up)
function signedArea2(polygon: readonly Vec2[]): number {
    let sum = 0;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        sum += polygon[j][0] * polygon[i][1] - polygon[i][0] * polygon[j][1];
    }
    return sum;
}

// Sides of an area rail: indices of their first vertex, in order
export function areaRailSides(area: RoadArea, rail: Pick<AreaRail, 'from' | 'to'>): number[] {
    const n = area.polygon.length;
    const count = rail.to === rail.from ? n : ((rail.to - rail.from) % n + n) % n;
    const sides: number[] = [];
    for (let k = 0; k < count; k++) sides.push((rail.from + k) % n);
    return sides;
}

// The railing's line: the polygon's sides from vertex `from` to `to`,
// moved `offset` inwards; inner corners are mitred (the moved sides meet),
// the two ends move straight in. A rail round the whole outline is closed
// (its last point is its first).
export function areaRailLine(area: RoadArea, rail: AreaRail): Vec2[] {
    const polygon = area.polygon;
    const n = polygon.length;
    const offset = rail.offset ?? DEFAULT_AREA_RAIL_OFFSET;
    // Inward normal of side i: left of its direction for a polygon with
    // positive signed area (left is (dz, -dx) with z up... here: (-dz, dx))
    const inwardSign = signedArea2(polygon) > 0 ? 1 : -1;
    const normal = (i: number): [number, number] => {
        const a = polygon[i], b = polygon[(i + 1) % n];
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const len = length2(dx, dz);
        return [-dz / len * inwardSign, dx / len * inwardSign];
    };
    const sides = areaRailSides(area, rail);
    const closed = rail.from === rail.to;
    const points: Vec2[] = [];
    const moved = (i: number, vertex: number): [number, number] => {
        const [nx, nz] = normal(i);
        return [polygon[vertex][0] + nx * offset, polygon[vertex][1] + nz * offset];
    };
    for (let k = 0; k <= sides.length; k++) {
        const vertex = (rail.from + k) % n;
        const before = k > 0 ? sides[k - 1] : closed ? sides[sides.length - 1] : -1;
        const after = k < sides.length ? sides[k] : closed ? sides[0] : -1;
        if (before < 0) { points.push(moved(after, vertex)); continue; }
        if (after < 0) { points.push(moved(before, vertex)); continue; }
        // Mitre: the vertex moved along the sum of both normals, scaled so
        // that it lies `offset` from both sides
        const [ax, az] = normal(before), [bx, bz] = normal(after);
        const dot = ax * bx + az * bz;
        const scale = offset / (1 + dot > 1e-6 ? (1 + dot) : 1);
        points.push([polygon[vertex][0] + (ax + bx) * scale, polygon[vertex][1] + (az + bz) * scale]);
    }
    return points;
}

// The railing's straight sides cut into equal capsules of at most
// RAIL_MAX_SEGMENT (the sides are straight, no sagitta to bound)
export function areaRailColliders(area: RoadArea, rail: AreaRail): SegmentCollider[] {
    const line = areaRailLine(area, rail);
    const out: SegmentCollider[] = [];
    for (let i = 1; i < line.length; i++) {
        const [ax, az] = line[i - 1], [bx, bz] = line[i];
        const pieces = Math.max(1, Math.ceil(length2(bx - ax, bz - az) / RAIL_MAX_SEGMENT - 1e-9));
        for (let k = 0; k < pieces; k++) {
            out.push({
                kind: 'segment',
                ax: toMillimetres(ax + (bx - ax) * k / pieces), az: toMillimetres(az + (bz - az) * k / pieces),
                bx: toMillimetres(ax + (bx - ax) * (k + 1) / pieces), bz: toMillimetres(az + (bz - az) * (k + 1) / pieces),
                r: RAIL_RADIUS,
                top: RAIL_TOPS[rail.kind]
            });
        }
    }
    return out;
}

// All rails of the network: edge by edge in file order (clear of the
// junctions), then the areas'
export function networkRailColliders(net: RoadNetwork): SegmentCollider[] {
    const out: SegmentCollider[] = [];
    for (const edge of net.edges) {
        for (const rail of edge.def.rails ?? []) out.push(...railColliders(edge, rail, net));
    }
    for (const area of net.areas) {
        for (const rail of area.rails ?? []) out.push(...areaRailColliders(area, rail));
    }
    return out;
}

export interface SegmentContact {
    // Penetration depth (> 0) and the unit normal pointing out of the
    // capsule towards the circle
    pen: number;
    nx: number;
    nz: number;
}

// Circle (px, pz, r) against a capsule collider: nearest point on the
// segment, then as circle against circle. A centre exactly on the segment
// leaves along the segment's left normal.
export function circleVsSegment(px: number, pz: number, r: number, seg: SegmentCollider): SegmentContact | null {
    const ex = seg.bx - seg.ax, ez = seg.bz - seg.az;
    const len2 = ex * ex + ez * ez;
    let t = len2 > 0 ? ((px - seg.ax) * ex + (pz - seg.az) * ez) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const dx = px - (seg.ax + t * ex), dz = pz - (seg.az + t * ez);
    const reach = r + seg.r;
    const d2 = dx * dx + dz * dz;
    if (d2 >= reach * reach) return null;
    const d = Math.sqrt(d2);
    if (d > 1e-9) return { pen: reach - d, nx: dx / d, nz: dz / d };
    const len = Math.sqrt(len2);
    if (len === 0) return { pen: reach, nx: 1, nz: 0 };
    return { pen: reach, nx: ez / len, nz: -ex / len };
}
