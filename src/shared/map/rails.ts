// Guard rails, railings and fences as chains of capsule colliders
// (docs/phase-3-design.md, 5.5 and 8.2, design E8). The collider shape is
// the new `segment` kind; the sim integration (M3) adds it to the sim's
// Collider union and uses circleVsSegment in its narrow phase.

import type { Vec2 } from './geometry.js';
import type { RoadEdgeData, RoadNetwork } from './roadNetwork.js';
import type { RailKind, RailRange } from './roadSchema.js';
import { leftNormal, pointAt } from './spline.js';

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

// Station range of a rail on its edge (to = -1: up to the end)
export function railRange(edge: RoadEdgeData, rail: Pick<RailRange, 'from' | 'to'>): [number, number] {
    const to = rail.to < 0 ? edge.length : Math.min(rail.to, edge.length);
    return [Math.min(rail.from, to), to];
}

// The rail's line: the edge's samples between from and to, shifted to the
// side by half the road width plus the offset
export function railLine(edge: RoadEdgeData, rail: RailRange): Vec2[] {
    const [from, to] = railRange(edge, rail);
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
    const len = Math.hypot(ex, ez);
    if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
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
            if (Math.hypot(points[next][0] - points[a][0], points[next][1] - points[a][1]) > maxLength) break;
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

export function railColliders(edge: RoadEdgeData, rail: RailRange): SegmentCollider[] {
    const line = railLine(edge, rail);
    return simplifyPolyline(line, RAIL_MAX_SEGMENT, RAIL_MAX_SAGITTA).map(([a, b]) => ({
        kind: 'segment',
        ax: line[a][0], az: line[a][1],
        bx: line[b][0], bz: line[b][1],
        r: RAIL_RADIUS,
        top: RAIL_TOPS[rail.kind]
    }));
}

// All rails of the network, edge by edge in file order
export function networkRailColliders(net: RoadNetwork): SegmentCollider[] {
    const out: SegmentCollider[] = [];
    for (const edge of net.edges) {
        for (const rail of edge.def.rails ?? []) out.push(...railColliders(edge, rail));
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
