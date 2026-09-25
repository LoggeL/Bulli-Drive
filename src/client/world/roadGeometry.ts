import { ShapeUtils, Vector2 } from 'three';
import { pointInPolygon, type Vec2 } from '../../shared/map/geometry.js';
import { junctionRadius, type RoadEdgeData, type RoadNetwork, type RoadNodeData } from '../../shared/map/roadNetwork.js';
import type { RoadArea, RoadProfile, RoadSurfaceName } from '../../shared/map/roadSchema.js';
import { leftNormal, pointAt } from '../../shared/map/spline.js';

// Road meshes of a curated map (docs/phase-3-design.md 5.4, 5.5 and 9) as
// plain arrays: ribbons along the edges' samples, the junction fills, the
// areas (lots, the plaza), sidewalks with their curbs. Pure: no scene, no
// DOM (three.js only for its triangulation); the unit tests check these
// arrays.
//
// Every vertex takes the ground's height where it stands (plus a lift), so
// a ribbon follows the baked corridor, which is flat across the road
// (design 6.4). The markings are drawn by the road shader from the vertex
// attributes (roads.ts):
//   uv     (across, along): metres left of the centre line, station on the edge
//   roadA  (centre line, lanes forward, lanes backward, flags)
//   roadB  (half width, start code + 4 · end code, first station, last station)
// Areas carry their own frame in uv (along the longest side, inwards) and
// roadB = (depth, 0, 0, length).

export type HeightFn = (x: number, z: number) => number;

export type RoadLayer = 'asphalt' | 'concrete' | 'dirt' | 'gravel' | 'sand' | 'walk' | 'pavers';
export const ROAD_LAYERS: readonly RoadLayer[] = ['asphalt', 'concrete', 'dirt', 'gravel', 'sand', 'walk', 'pavers'];

// Centre line codes of roadA.x (-1: no line markings at all)
export const CENTRE_CODE: Record<RoadProfile['markings']['center'], number> = {
    none: 0, dashedWhite: 1, dashedYellow: 2, solidYellow: 3, doubleYellow: 4
};
// Flags of roadA.w
export const ROAD_FLAG = { edges: 1, parallelParking: 2, angledParking: 4, parkingLot: 8 } as const;
// Codes at an edge end (start and end of roadB.y): stop line, crosswalk
export const END_CODE = { stop: 1, crosswalk: 2 } as const;

// Heights above the ground (m): ribbons and junctions, lots
export const ROAD_LIFT = 0.02;
export const AREA_LIFT = 0.015;
// A curb without a sidewalk (a kerb stone along the road edge)
export const KERB_WIDTH = 0.3;
// Lot curbs stand round areas without connecting roads (the plaza)
const CORNER_STEPS = 8;

export class MeshArrays {
    positions: number[] = [];
    normals: number[] = [];
    uvs: number[] = [];
    roadA: number[] = [];
    roadB: number[] = [];
    index: number[] = [];

    get vertexCount(): number {
        return this.positions.length / 3;
    }

    vertex(x: number, y: number, z: number, n: readonly number[], u: number, v: number, a: readonly number[], b: readonly number[]): number {
        this.positions.push(x, y, z);
        this.normals.push(n[0], n[1], n[2]);
        this.uvs.push(u, v);
        this.roadA.push(a[0], a[1], a[2], a[3]);
        this.roadB.push(b[0], b[1], b[2], b[3]);
        return this.positions.length / 3 - 1;
    }

    // Triangle facing `want` (flipped if its winding says otherwise)
    tri(a: number, b: number, c: number, want: readonly number[] = UP): void {
        const P = this.positions;
        const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
        const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az;
        const vx = P[c * 3] - ax, vy = P[c * 3 + 1] - ay, vz = P[c * 3 + 2] - az;
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        if (nx * want[0] + ny * want[1] + nz * want[2] < 0) this.index.push(a, c, b);
        else this.index.push(a, b, c);
    }

    quad(a: number, b: number, c: number, d: number, want: readonly number[] = UP): void {
        // a-b-c-d around the quad
        this.tri(a, b, c, want);
        this.tri(a, c, d, want);
    }
}

const UP = [0, 1, 0] as const;
const NONE = [0, 0, 0, 0] as const;

/** Ground normal at (x, z) from central differences over 1 m. */
export function groundNormal(height: HeightFn, x: number, z: number): [number, number, number] {
    const gx = (height(x + 1, z) - height(x - 1, z)) / 2;
    const gz = (height(x, z + 1) - height(x, z - 1)) / 2;
    const l = Math.sqrt(gx * gx + 1 + gz * gz);
    return [-gx / l, 1 / l, -gz / l];
}

function layerOf(surface: RoadSurfaceName): RoadLayer | null {
    return surface === 'wood' ? null : surface;
}

// ---- Edges ----

interface EdgeRun {
    from: number;
    to: number;
}

// Stations of the ribbon: from the trimmed start to the trimmed end, the
// stretches inside a connected area left out (the lot draws itself there)
export function edgeRuns(net: RoadNetwork, edge: RoadEdgeData): { runs: EdgeRun[]; start: number; end: number } {
    const start = junctionRadius(net, net.nodes[edge.from]);
    const end = edge.length - junctionRadius(net, net.nodes[edge.to]);
    const areas = net.areas.filter(area => area.connects.includes(net.nodes[edge.from].id) || area.connects.includes(net.nodes[edge.to].id));
    const runs: EdgeRun[] = [];
    let open = -1;
    const inside = (s: number) => {
        const p = pointAt(edge.samples, s);
        return areas.some(area => pointInPolygon(area.polygon, p.x, p.z));
    };
    const stations = edgeStations(edge, start, end);
    for (let k = 0; k < stations.length; k++) {
        const s = stations[k];
        const covered = inside(s);
        if (!covered && open < 0) open = k > 0 ? stations[k - 1] : s;
        if (covered && open >= 0) {
            runs.push({ from: open, to: s });
            open = -1;
        }
    }
    if (open >= 0) runs.push({ from: open, to: end });
    return { runs: runs.filter(run => run.to - run.from > 0.05), start, end };
}

// Longest step between two stations of a ribbon on a straight road (m),
// and the turn (cosine of the angle) after which a station is kept anyway
export const MAX_STATION_STEP = 4;
const MIN_TURN_COS = Math.cos(1.5 * Math.PI / 180);

// The sample stations between from and to, both ends included: every
// sample in curves, every MAX_STATION_STEP m on straights (the corridor's
// vertical curves are at least 150 m in radius, so 4 m chords stay within
// 1.3 cm of it)
export function edgeStations(edge: RoadEdgeData, from: number, to: number): number[] {
    if (to <= from) return [];
    const stations = [from];
    let last = pointAt(edge.samples, from);
    for (const sample of edge.samples) {
        if (sample.s <= from + 0.05 || sample.s >= to - 0.05) continue;
        const turned = sample.tx * last.tx + sample.tz * last.tz < MIN_TURN_COS;
        if (sample.s - last.s >= MAX_STATION_STEP - 1e-6 || turned) {
            stations.push(sample.s);
            last = sample;
        }
    }
    stations.push(to);
    return stations;
}

function endCode(node: RoadNodeData): number {
    const junction = node.def.junction;
    if (node.def.kind !== 'junction' || !junction) return 0;
    let code = 0;
    if (junction.control === 'stop' || junction.control === 'signal') code |= END_CODE.stop;
    if (junction.crosswalks) code |= END_CODE.crosswalk;
    return code;
}

function edgeAttributes(net: RoadNetwork, edge: RoadEdgeData, start: number, end: number): { a: number[]; b: number[] } {
    const p = edge.profile;
    const m = p.markings;
    let flags = 0;
    if (m.edges) flags |= ROAD_FLAG.edges;
    if (m.parking === 'parallel') flags |= ROAD_FLAG.parallelParking;
    if (m.parking === 'angled') flags |= ROAD_FLAG.angledParking;
    const lanes = m.lanes === 'dashed' ? p.lanes : [1, 1];
    const paved = p.surface === 'asphalt' || p.surface === 'concrete';
    return {
        a: [paved ? CENTRE_CODE[m.center] : -1, lanes[0], lanes[1], paved ? flags : 0],
        b: [edge.halfWidth, endCode(net.nodes[edge.from]) + 4 * endCode(net.nodes[edge.to]), start, end]
    };
}

function addRibbon(out: MeshArrays, edge: RoadEdgeData, stations: readonly number[], height: HeightFn,
    inner: number, outer: number, lift: (across: number) => number, a: readonly number[], b: readonly number[]): void {
    let prev: [number, number] | null = null;
    for (const s of stations) {
        const p = pointAt(edge.samples, s);
        const [nx, nz] = leftNormal(p.tx, p.tz);
        const row: number[] = [];
        for (const across of [outer, inner]) {
            const x = p.x + nx * across, z = p.z + nz * across;
            row.push(out.vertex(x, height(x, z) + lift(across), z, groundNormal(height, x, z), across, s, a, b));
        }
        if (prev) out.quad(prev[0], prev[1], row[1], row[0]);
        prev = [row[0], row[1]];
    }
}

// A vertical face along the stations at `across`, from the road (or the
// ground) up to the top, facing `facing` (+1 left, -1 right of the edge)
function addFace(out: MeshArrays, edge: RoadEdgeData, stations: readonly number[], height: HeightFn,
    across: number, bottom: number, top: number, facing: number): void {
    let prev: [number, number] | null = null;
    for (const s of stations) {
        const p = pointAt(edge.samples, s);
        const [nx, nz] = leftNormal(p.tx, p.tz);
        const x = p.x + nx * across, z = p.z + nz * across;
        const y = height(x, z);
        const n = [nx * facing, 0, nz * facing];
        const lo = out.vertex(x, y + bottom, z, n, 0, s, NONE, NONE);
        const hi = out.vertex(x, y + top, z, n, top - bottom, s, NONE, NONE);
        if (prev) out.quad(prev[0], lo, hi, prev[1], n);
        prev = [lo, hi];
    }
}

// Sidewalk (or kerb) on one side (+1 left, -1 right): the curb face at the
// road edge, the top, the outer face down to the ground
function addSidewalk(out: MeshArrays, edge: RoadEdgeData, stations: readonly number[], height: HeightFn, side: 1 | -1): void {
    const p = edge.profile;
    const width = side > 0 ? p.sidewalk.left : p.sidewalk.right;
    const curb = side > 0 ? p.curb.left : p.curb.right;
    if (width <= 0 && !curb) return;
    const w = width > 0 ? width : KERB_WIDTH;
    const top = curb ? p.curb.height : 0.04;
    const hw = edge.halfWidth;
    addRibbon(out, edge, stations, height, side * hw, side * (hw + w), () => top, [side * hw, 0, 0, 0], [w, 0, 0, 0]);
    // The sidewalk's own coordinates: across from the curb
    const first = out.vertexCount - stations.length * 2;
    for (let v = first; v < out.vertexCount; v++) out.uvs[v * 2] = Math.abs(out.uvs[v * 2]) - hw;
    if (curb) addFace(out, edge, stations, height, side * hw, ROAD_LIFT, top, -side);
    addFace(out, edge, stations, height, side * (hw + w), -0.05, top, side);
}

// ---- Junctions ----

interface JunctionEnd {
    edge: RoadEdgeData;
    // Trimmed end point and the direction away from the junction
    x: number;
    z: number;
    ox: number;
    oz: number;
    angle: number;
    // Sidewalk widths left and right of the outward direction
    walkLeft: number;
    walkRight: number;
    curbLeft: boolean;
    curbRight: boolean;
}

function junctionEnds(net: RoadNetwork, node: RoadNodeData): JunctionEnd[] {
    const trim = junctionRadius(net, node);
    return node.ends.map(end => {
        const edge = net.edges[end.edge];
        const s = end.atStart ? Math.min(trim, edge.length) : Math.max(0, edge.length - trim);
        const p = pointAt(edge.samples, s);
        const sign = end.atStart ? 1 : -1;
        const ox = p.tx * sign, oz = p.tz * sign;
        const w = edge.profile.sidewalk, c = edge.profile.curb;
        return {
            edge, x: p.x, z: p.z, ox, oz,
            angle: Math.atan2(oz, ox),
            // Outward left is the edge's left at its start, its right at its end
            walkLeft: end.atStart ? w.left : w.right,
            walkRight: end.atStart ? w.right : w.left,
            curbLeft: end.atStart ? c.left : c.right,
            curbRight: end.atStart ? c.right : c.left
        };
    }).sort((a, b) => a.angle - b.angle);
}

// Corner between the right road edge of one end and the left road edge of
// the next: a quadratic curve whose control point is where the two road
// edges meet (their straight continuation into the junction)
export function cornerCurve(r: Vec2, rDir: Vec2, l: Vec2, lDir: Vec2, steps = CORNER_STEPS): Vec2[] {
    // r + a·rDir = l + b·lDir
    const det = rDir[0] * -lDir[1] - rDir[1] * -lDir[0];
    let control: Vec2 = [(r[0] + l[0]) / 2, (r[1] + l[1]) / 2];
    if (Math.abs(det) > 1e-6) {
        const dx = l[0] - r[0], dz = l[1] - r[1];
        const a = (dx * -lDir[1] - dz * -lDir[0]) / det;
        const b = (rDir[0] * dz - rDir[1] * dx) / det;
        const gap = Math.sqrt(dx * dx + dz * dz);
        if (a > 0 && b > 0 && a < 3 * gap + 10 && b < 3 * gap + 10) control = [r[0] + rDir[0] * a, r[1] + rDir[1] * a];
    }
    const points: Vec2[] = [];
    for (let k = 0; k <= steps; k++) {
        const t = k / steps, u = 1 - t;
        points.push([u * u * r[0] + 2 * u * t * control[0] + t * t * l[0], u * u * r[1] + 2 * u * t * control[1] + t * t * l[1]]);
    }
    return points;
}

const SURFACE_RANK: Record<RoadSurfaceName, number> = { asphalt: 5, concrete: 4, gravel: 3, dirt: 2, sand: 1, wood: 0 };

function addJunction(layers: Record<RoadLayer, MeshArrays>, net: RoadNetwork, node: RoadNodeData, height: HeightFn): void {
    const ends = junctionEnds(net, node);
    if (ends.length < 2) return;
    let surface: RoadSurfaceName = ends[0].edge.profile.surface;
    for (const end of ends) if (SURFACE_RANK[end.edge.profile.surface] > SURFACE_RANK[surface]) surface = end.edge.profile.surface;
    const layer = layerOf(surface);
    if (!layer) return;
    const out = layers[layer];
    // The outline: per end its left and right road corner, then the curve
    // to the next end's left corner
    const ring: Vec2[] = [];
    const corners: { points: Vec2[]; from: JunctionEnd; to: JunctionEnd }[] = [];
    ends.forEach((end, i) => {
        const next = ends[(i + 1) % ends.length];
        const hw = end.edge.halfWidth, nhw = next.edge.halfWidth;
        const [lx, lz] = leftNormal(end.ox, end.oz);
        const [nlx, nlz] = leftNormal(next.ox, next.oz);
        const left: Vec2 = [end.x + lx * hw, end.z + lz * hw];
        const right: Vec2 = [end.x - lx * hw, end.z - lz * hw];
        const nextLeft: Vec2 = [next.x + nlx * nhw, next.z + nlz * nhw];
        ring.push(left, right);
        const curve = cornerCurve(right, [-end.ox, -end.oz], nextLeft, [-next.ox, -next.oz]);
        ring.push(...curve.slice(1, -1));
        corners.push({ points: curve, from: end, to: next });
    });
    const a = [-1, 0, 0, 0], b = [0, 0, 0, 0];
    const centre = out.vertex(node.x, height(node.x, node.z) + ROAD_LIFT, node.z, groundNormal(height, node.x, node.z), 99, 0, a, b);
    const first = out.vertexCount;
    for (const [x, z] of ring) out.vertex(x, height(x, z) + ROAD_LIFT, z, groundNormal(height, x, z), 99, 0, a, b);
    for (let i = 0; i < ring.length; i++) out.tri(centre, first + i, first + (i + 1) % ring.length);
    // Sidewalks round the corners
    for (const corner of corners) addCornerWalk(layers.walk, corner.points, corner.from, corner.to, node, height);
}

function addCornerWalk(out: MeshArrays, curve: readonly Vec2[], from: JunctionEnd, to: JunctionEnd, node: RoadNodeData, height: HeightFn): void {
    const w0 = from.walkRight, w1 = to.walkLeft;
    const curb = from.curbRight || to.curbLeft;
    if (w0 <= 0 && w1 <= 0 && !curb) return;
    const top = curb ? Math.max(from.edge.profile.curb.height, to.edge.profile.curb.height) : 0.04;
    const n = curve.length;
    let prev: { inner: number; outer: number; lo: number; hi: number; olo: number; ohi: number } | null = null;
    for (let k = 0; k < n; k++) {
        const t = k / (n - 1);
        const w = Math.max(KERB_WIDTH, w0 * (1 - t) + w1 * t);
        const [x, z] = curve[k];
        // Away from the junction: perpendicular to the curve, on the far side from the node
        const [ax, az] = curve[Math.max(0, k - 1)], [bx, bz] = curve[Math.min(n - 1, k + 1)];
        let dx = bz - az, dz = -(bx - ax);
        const len = Math.sqrt(dx * dx + dz * dz) || 1;
        dx /= len; dz /= len;
        if (dx * (x - node.x) + dz * (z - node.z) < 0) { dx = -dx; dz = -dz; }
        const ox = x + dx * w, oz = z + dz * w;
        const y = height(x, z), oy = height(ox, oz);
        const inner = out.vertex(x, y + top, z, UP, 0, k, NONE, NONE);
        const outer = out.vertex(ox, oy + top, oz, UP, w, k, NONE, NONE);
        const faceIn = [-dx, 0, -dz], faceOut = [dx, 0, dz];
        const lo = out.vertex(x, y + ROAD_LIFT, z, faceIn, 0, k, NONE, NONE);
        const hi = out.vertex(x, y + top, z, faceIn, top, k, NONE, NONE);
        const olo = out.vertex(ox, oy - 0.05, oz, faceOut, 0, k, NONE, NONE);
        const ohi = out.vertex(ox, oy + top, oz, faceOut, top, k, NONE, NONE);
        if (prev) {
            out.quad(prev.inner, inner, outer, prev.outer);
            if (curb) out.quad(prev.lo, lo, hi, prev.hi, faceIn);
            out.quad(prev.olo, olo, ohi, prev.ohi, faceOut);
        }
        prev = { inner, outer, lo, hi, olo, ohi };
    }
}

// ---- Areas ----

// The frame of a lot's markings: along its longest side, inwards
export function areaFrame(polygon: readonly Vec2[]): { ox: number; oz: number; ux: number; uz: number; vx: number; vz: number; length: number; depth: number } {
    let best = 0, bestLength = -1;
    for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i], b = polygon[(i + 1) % polygon.length];
        const l = Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
        if (l > bestLength) { bestLength = l; best = i; }
    }
    const a = polygon[best], b = polygon[(best + 1) % polygon.length];
    const ux = (b[0] - a[0]) / bestLength, uz = (b[1] - a[1]) / bestLength;
    // Inwards: the side of the polygon's centroid
    let cx = 0, cz = 0;
    for (const [x, z] of polygon) { cx += x; cz += z; }
    cx /= polygon.length; cz /= polygon.length;
    let vx = -uz, vz = ux;
    if (vx * (cx - a[0]) + vz * (cz - a[1]) < 0) { vx = -vx; vz = -vz; }
    let depth = 0;
    for (const [x, z] of polygon) depth = Math.max(depth, (x - a[0]) * vx + (z - a[1]) * vz);
    return { ox: a[0], oz: a[1], ux, uz, vx, vz, length: bestLength, depth };
}

// Triangles of a simple polygon (earcut, robust with the collinear points
// the lots' sides get every 8 m)
export function triangulatePolygon(polygon: readonly Vec2[]): [number, number, number][] {
    const contour = polygon.map(([x, z]) => new Vector2(x, z));
    return ShapeUtils.triangulateShape(contour, []) as [number, number, number][];
}

function addArea(layers: Record<RoadLayer, MeshArrays>, area: RoadArea, height: HeightFn): void {
    const base = layerOf(area.surface);
    if (!base) return;
    const layer: RoadLayer = area.markings === 'plazaPavers' ? 'pavers' : base;
    const out = layers[layer];
    const frame = areaFrame(area.polygon);
    const flags = area.markings === 'parking' ? ROAD_FLAG.parkingLot : 0;
    const a = [-1, 0, 0, flags], b = [frame.depth, 0, 0, frame.length];
    // Corners plus points every 8 m along the sides, so large lots follow
    // the ground (it is flat there, but not to the millimetre)
    const outline: Vec2[] = [];
    const polygon = area.polygon;
    for (let i = 0; i < polygon.length; i++) {
        const p = polygon[i], q = polygon[(i + 1) % polygon.length];
        const l = Math.sqrt((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2);
        const steps = Math.max(1, Math.ceil(l / 8));
        for (let k = 0; k < steps; k++) outline.push([p[0] + (q[0] - p[0]) * k / steps, p[1] + (q[1] - p[1]) * k / steps]);
    }
    const first = out.vertexCount;
    for (const [x, z] of outline) {
        const u = (x - frame.ox) * frame.ux + (z - frame.oz) * frame.uz;
        const v = (x - frame.ox) * frame.vx + (z - frame.oz) * frame.vz;
        out.vertex(x, height(x, z) + AREA_LIFT, z, groundNormal(height, x, z), u, v, a, b);
    }
    for (const [i, j, k] of triangulatePolygon(outline)) out.tri(first + i, first + j, first + k);
    // A curb round a lot without roads (the plaza)
    if (area.curb && area.connects.length === 0) addAreaCurb(layers.walk, area.polygon, height);
}

function addAreaCurb(out: MeshArrays, polygon: readonly Vec2[], height: HeightFn): void {
    const top = 0.15;
    let cx = 0, cz = 0;
    for (const [x, z] of polygon) { cx += x; cz += z; }
    cx /= polygon.length; cz /= polygon.length;
    for (let i = 0; i < polygon.length; i++) {
        const p = polygon[i], q = polygon[(i + 1) % polygon.length];
        const l = Math.sqrt((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2);
        let nx = (q[1] - p[1]) / l, nz = -(q[0] - p[0]) / l;
        if (nx * (cx - p[0]) + nz * (cz - p[1]) > 0) { nx = -nx; nz = -nz; }
        // Outward face and a kerb stone on the lot's rim
        const corners = [p, q].map(([x, z]) => {
            const y = height(x, z);
            return [
                out.vertex(x, y - 0.05, z, [nx, 0, nz], 0, 0, NONE, NONE),
                out.vertex(x, y + top, z, [nx, 0, nz], top, 0, NONE, NONE),
                out.vertex(x, y + top, z, UP, 0, 0, NONE, NONE),
                out.vertex(x - nx * KERB_WIDTH, y + top, z - nz * KERB_WIDTH, UP, KERB_WIDTH, 0, NONE, NONE)
            ];
        });
        out.quad(corners[0][0], corners[1][0], corners[1][1], corners[0][1], [nx, 0, nz]);
        out.quad(corners[0][2], corners[1][2], corners[1][3], corners[0][3]);
    }
}

// ---- The whole network ----

export function buildRoadGeometry(net: RoadNetwork, height: HeightFn): Record<RoadLayer, MeshArrays> {
    const layers = Object.fromEntries(ROAD_LAYERS.map(layer => [layer, new MeshArrays()])) as Record<RoadLayer, MeshArrays>;
    for (const edge of net.edges) {
        const layer = layerOf(edge.profile.surface);
        if (!layer) continue;
        const { runs, start, end } = edgeRuns(net, edge);
        const { a, b } = edgeAttributes(net, edge, start, end);
        for (const run of runs) {
            const stations = edgeStations(edge, run.from, run.to);
            addRibbon(layers[layer], edge, stations, height, -edge.halfWidth, edge.halfWidth, () => ROAD_LIFT, a, b);
            addSidewalk(layers.walk, edge, stations, height, 1);
            addSidewalk(layers.walk, edge, stations, height, -1);
        }
    }
    for (const node of net.nodes) if (node.def.kind === 'junction') addJunction(layers, net, node, height);
    for (const area of net.areas) addArea(layers, area, height);
    return layers;
}
