// The road network at runtime (docs/phase-3-design.md, 5.3 and 5.4): edges
// evaluated and resampled to 1 m, phantom points at joints, junction trim
// radii, chains of edges through joints, a spatial index over all samples
// and the corridor queries "nearest road" and "surface at a position".

import { pointInPolygon } from './geometry.js';
import type { RoadArea, RoadEdge, RoadNetworkFile, RoadNode, RoadProfile } from './roadSchema.js';
import { validateRoadNetwork } from './roadSchema.js';
import { catmullRomChain, cubic, sampleSegments, type CubicSegment, type Point2 } from './spline.js';
import { SURFACE, SURFACE_PRIORITY, type RoadSample, type SurfaceName } from './types.js';

export interface EdgeEnd { edge: number; atStart: boolean }

export interface RoadNodeData {
    index: number;
    id: string;
    def: RoadNode;
    x: number;
    z: number;
    ends: EdgeEnd[];
}

export interface RoadEdgeData {
    index: number;
    id: string;
    def: RoadEdge;
    from: number;
    to: number;
    profile: RoadProfile;
    // Half the drivable width
    halfWidth: number;
    segments: CubicSegment[];
    samples: RoadSample[];
    length: number;
}

export interface RoadNetwork {
    mapId: string;
    nodes: RoadNodeData[];
    edges: RoadEdgeData[];
    areas: RoadArea[];
    nodeById: Map<string, RoadNodeData>;
    edgeById: Map<string, RoadEdgeData>;
    index: SampleIndex;
    // Bounding box of each area: minX, minZ, maxX, maxZ
    areaBounds: Float64Array;
    // Largest half width of any edge (search radius of the surface query)
    maxHalfWidth: number;
    // Largest corridor half width: drivable half width plus the wider
    // sidewalk and the shoulder (search radius of insideCorridor)
    maxCorridor: number;
    // Findings that do not stop the build (joints that are not C1)
    issues: string[];
}

// Tangent kink at a joint above which the network reports an issue (1°)
export const JOINT_TOLERANCE_RAD = Math.PI / 180;
// Junction trim radius: half the widest incident road plus this (5.4)
export const JUNCTION_TRIM_EXTRA = 2;
export const DEFAULT_ROUNDABOUT_RADIUS = 18;

export function resolveProfile(file: RoadNetworkFile, edge: RoadEdge): RoadProfile {
    const base = file.profiles[edge.profile];
    return edge.overrides ? { ...base, ...edge.overrides } : base;
}

// The first point after the node along the edge end (for Catmull-Rom the
// next support point, for Bézier the handle), used as the phantom point of
// the neighbouring edge at a joint.
function neighbourPoint(edge: RoadEdge, atStart: boolean, from: RoadNode, to: RoadNode): Point2 {
    const curve = edge.curve;
    if (curve.type === 'catmullRom') {
        if (curve.points.length === 0) return atStart ? [to.x, to.z] : [from.x, from.z];
        return atStart ? curve.points[0] : curve.points[curve.points.length - 1];
    }
    const segments = curve.segments;
    return atStart ? segments[0].c1 : segments[segments.length - 1].c2;
}

function edgeSegments(selfIndex: number, nodes: Map<string, RoadNodeData>, edgeDefs: readonly RoadEdge[]): CubicSegment[] {
    const edge = edgeDefs[selfIndex];
    const from = nodes.get(edge.from)!, to = nodes.get(edge.to)!;
    const start: Point2 = [from.x, from.z];
    const end: Point2 = [to.x, to.z];
    if (edge.curve.type === 'bezier') {
        const segments: CubicSegment[] = [];
        let p0 = start;
        for (const segment of edge.curve.segments) {
            const p1 = segment.to ?? end;
            segments.push(cubic(p0, segment.c1, segment.c2, p1));
            p0 = p1;
        }
        return segments;
    }
    // Phantom point at a joint: the neighbouring edge's first point after
    // the node, so both sides share the tangent there (C1)
    const phantom = (node: RoadNodeData, self: EdgeEnd): Point2 | undefined => {
        if (node.def.kind !== 'joint') return undefined;
        const other = node.ends.find(end => end.edge !== self.edge || end.atStart !== self.atStart);
        if (!other) return undefined;
        const def = edgeDefs[other.edge];
        return neighbourPoint(def, other.atStart, nodes.get(def.from)!.def, nodes.get(def.to)!.def);
    };
    return catmullRomChain(
        [start, ...edge.curve.points, end],
        phantom(from, { edge: selfIndex, atStart: true }),
        phantom(to, { edge: selfIndex, atStart: false })
    );
}

// Builds the network from a file that passed the schema. Throws with all
// problems of validateRoadNetwork.
export function buildRoadNetwork(file: RoadNetworkFile): RoadNetwork {
    const errors = validateRoadNetwork(file);
    if (errors.length) throw new Error(`invalid road network:\n  ${errors.join('\n  ')}`);

    const nodes: RoadNodeData[] = file.nodes.map((def, index) => ({ index, id: def.id, def, x: def.x, z: def.z, ends: [] }));
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    file.edges.forEach((edge, index) => {
        nodeById.get(edge.from)!.ends.push({ edge: index, atStart: true });
        nodeById.get(edge.to)!.ends.push({ edge: index, atStart: false });
    });

    const edges: RoadEdgeData[] = file.edges.map((def, index) => {
        const profile = resolveProfile(file, def);
        const segments = edgeSegments(index, nodeById, file.edges);
        const { samples, length } = sampleSegments(segments);
        return {
            index, id: def.id, def,
            from: nodeById.get(def.from)!.index,
            to: nodeById.get(def.to)!.index,
            profile, halfWidth: profile.width / 2,
            segments, samples, length
        };
    });
    const edgeById = new Map(edges.map(edge => [edge.id, edge]));

    const issues: string[] = [];
    for (const node of nodes) {
        if (node.def.kind !== 'joint' || node.ends.length !== 2) continue;
        // Direction leaving the node along each end
        const [a, b] = node.ends.map(end => {
            const samples = edges[end.edge].samples;
            const sample = end.atStart ? samples[0] : samples[samples.length - 1];
            return end.atStart ? [sample.tx, sample.tz] : [-sample.tx, -sample.tz];
        });
        // Leaving directions of a smooth joint are opposite
        const cos = -(a[0] * b[0] + a[1] * b[1]);
        const angle = Math.acos(Math.min(1, Math.max(-1, cos))); // determinism: report only
        if (angle > JOINT_TOLERANCE_RAD) {
            issues.push(`node ${node.id}: joint is not tangent-continuous (${(angle * 180 / Math.PI).toFixed(2)}°)`);
        }
    }

    let maxHalfWidth = 0, maxCorridor = 0;
    for (const edge of edges) {
        maxHalfWidth = Math.max(maxHalfWidth, edge.halfWidth);
        const p = edge.profile;
        maxCorridor = Math.max(maxCorridor, edge.halfWidth + Math.max(p.sidewalk.left, p.sidewalk.right) + p.shoulder);
    }
    const areaBounds = new Float64Array(4 * file.areas.length);
    file.areas.forEach((area, i) => {
        let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
        for (const [x, z] of area.polygon) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
        }
        areaBounds.set([minX, minZ, maxX, maxZ], 4 * i);
    });
    return {
        mapId: file.mapId, nodes, edges, areas: file.areas, nodeById, edgeById,
        index: new SampleIndex(edges), areaBounds, maxHalfWidth, maxCorridor, issues
    };
}

// Trim radius of a junction (5.4): explicit radius, the roundabout radius,
// or half the widest incident road + 2 m. 0 for joints and ends.
export function junctionRadius(net: RoadNetwork, node: RoadNodeData): number {
    if (node.def.kind !== 'junction') return 0;
    const junction = node.def.junction;
    if (junction?.radius !== undefined) return junction.radius;
    if (junction?.shape === 'roundabout') return DEFAULT_ROUNDABOUT_RADIUS;
    let half = 0;
    for (const end of node.ends) half = Math.max(half, net.edges[end.edge].halfWidth);
    return half + JUNCTION_TRIM_EXTRA;
}

// ---- Chains: edges joined through joints ----

export interface ChainPart { edge: number; reversed: boolean }
export interface RoadChain {
    parts: ChainPart[];
    // Node indices at the chain's ends (the same node for a closed chain)
    startNode: number;
    endNode: number;
    closed: boolean;
    length: number;
}

// Splits the network into maximal chains of edges that pass through joint
// nodes: the longitudinal profile of a road runs along a chain, so a joint
// has no kink in height either. Every edge belongs to exactly one chain.
export function roadChains(net: RoadNetwork): RoadChain[] {
    const used = new Uint8Array(net.edges.length);
    const chains: RoadChain[] = [];
    // The part that continues through the joint at `node`, arriving via `end`
    const continueAt = (node: RoadNodeData, end: EdgeEnd): ChainPart | null => {
        if (node.def.kind !== 'joint') return null;
        const other = node.ends.find(e => e.edge !== end.edge || e.atStart !== end.atStart);
        if (!other) return null;
        return { edge: other.edge, reversed: !other.atStart };
    };
    const exitNode = (part: ChainPart) => net.edges[part.edge][part.reversed ? 'from' : 'to'];
    const entryNode = (part: ChainPart) => net.edges[part.edge][part.reversed ? 'to' : 'from'];

    for (let e = 0; e < net.edges.length; e++) {
        if (used[e]) continue;
        const parts: ChainPart[] = [{ edge: e, reversed: false }];
        used[e] = 1;
        let closed = false;
        // Forward
        for (;;) {
            const last = parts[parts.length - 1];
            const node = net.nodes[exitNode(last)];
            const next = continueAt(node, { edge: last.edge, atStart: last.reversed });
            if (!next) break;
            if (used[next.edge]) { closed = next.edge === parts[0].edge; break; }
            used[next.edge] = 1;
            parts.push(next);
        }
        // Backward
        while (!closed) {
            const first = parts[0];
            const node = net.nodes[entryNode(first)];
            const prev = continueAt(node, { edge: first.edge, atStart: !first.reversed });
            if (!prev || used[prev.edge]) break;
            used[prev.edge] = 1;
            // prev leaves the node; walked backwards it arrives there
            parts.unshift({ edge: prev.edge, reversed: !prev.reversed });
        }
        let length = 0;
        for (const part of parts) length += net.edges[part.edge].length;
        chains.push({
            parts,
            startNode: entryNode(parts[0]),
            endNode: exitNode(parts[parts.length - 1]),
            closed, length
        });
    }
    return chains;
}

// ---- Spatial index and corridor queries ----

export const INDEX_CELL = 16;

// Uniform grid (16 m cells, CSR layout) over all samples of all edges.
// Each entry is a sample; the segment from it to the next sample is found
// through it, so the cell of a sample covers the start of its segment.
export class SampleIndex {
    readonly originX: number;
    readonly originZ: number;
    readonly cols: number;
    readonly rows: number;
    readonly cellStart: Int32Array;
    readonly edgeOf: Int32Array;
    readonly sampleOf: Int32Array;

    constructor(edges: readonly RoadEdgeData[]) {
        let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, total = 0;
        for (const edge of edges) {
            for (const p of edge.samples) {
                if (p.x < minX) minX = p.x;
                if (p.x > maxX) maxX = p.x;
                if (p.z < minZ) minZ = p.z;
                if (p.z > maxZ) maxZ = p.z;
            }
            total += edge.samples.length;
        }
        if (total === 0) { minX = minZ = 0; maxX = maxZ = 0; }
        this.originX = minX;
        this.originZ = minZ;
        this.cols = Math.floor((maxX - minX) / INDEX_CELL) + 1;
        this.rows = Math.floor((maxZ - minZ) / INDEX_CELL) + 1;
        const counts = new Int32Array(this.cols * this.rows + 1);
        for (const edge of edges) for (const p of edge.samples) counts[this.cellOf(p.x, p.z) + 1]++;
        for (let c = 0; c < this.cols * this.rows; c++) counts[c + 1] += counts[c];
        this.cellStart = counts;
        this.edgeOf = new Int32Array(total);
        this.sampleOf = new Int32Array(total);
        const fill = counts.slice(0, this.cols * this.rows);
        for (const edge of edges) {
            edge.samples.forEach((p, k) => {
                const slot = fill[this.cellOf(p.x, p.z)]++;
                this.edgeOf[slot] = edge.index;
                this.sampleOf[slot] = k;
            });
        }
    }

    cellX(x: number): number {
        const c = Math.floor((x - this.originX) / INDEX_CELL);
        return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
    }

    cellZ(z: number): number {
        const c = Math.floor((z - this.originZ) / INDEX_CELL);
        return c < 0 ? 0 : c >= this.rows ? this.rows - 1 : c;
    }

    cellOf(x: number, z: number): number {
        return this.cellZ(z) * this.cols + this.cellX(x);
    }
}

// The closest point of a road's centre line to a query position
export interface RoadHit {
    edge: RoadEdgeData;
    // Arc length along the edge
    s: number;
    x: number;
    z: number;
    // Unit tangent in edge direction at the hit
    tx: number;
    tz: number;
    distance: number;
    // Signed offset from the centre line, positive to the left of the edge
    // direction
    lateral: number;
}

// Projection of a query point onto one centre-line segment; scratch state
// of the queries below, reused so they allocate nothing per segment
interface Projection { t: number; qx: number; qz: number; dx: number; dz: number; distance: number }

// Projects (x, z) onto the centre-line segment from sample k to k + 1
function projectSegment(edge: RoadEdgeData, k: number, x: number, z: number, out: Projection): void {
    const a = edge.samples[k], b = edge.samples[k + 1];
    const ex = b.x - a.x, ez = b.z - a.z;
    const len2 = ex * ex + ez * ez;
    let t = len2 > 0 ? ((x - a.x) * ex + (z - a.z) * ez) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    out.t = t;
    out.qx = a.x + ex * t;
    out.qz = a.z + ez * t;
    out.dx = x - out.qx;
    out.dz = z - out.qz;
    out.distance = Math.sqrt(out.dx * out.dx + out.dz * out.dz);
}

function newProjection(): Projection {
    return { t: 0, qx: 0, qz: 0, dx: 0, dz: 0, distance: 0 };
}

// Cell ranges of the index covering the square of half size `radius`
// around (x, z). Each segment is registered once, in the cell of its first
// sample; a segment is at most one sample spacing (1 m) long, so a search
// radius one metre larger than the distance of interest finds it.
function cellRange(index: SampleIndex, x: number, z: number, radius: number, out: Int32Array): void {
    out[0] = index.cellX(x - radius); out[1] = index.cellX(x + radius);
    out[2] = index.cellZ(z - radius); out[3] = index.cellZ(z + radius);
}

/**
 * Nearest point on any road's centre line within maxDistance, or null.
 * Ties go to the lower edge index, then the lower station. Writes into
 * `out` when given (no allocation), else returns a new hit.
 *
 * Not for the sim tick: a search over the index costs a few microseconds.
 * Use it for resets, the minimap and tools; the tick reads surfaceAt,
 * heightAt and waterDepth from the heightfield (design 8.3).
 */
export function nearestRoad(net: RoadNetwork, x: number, z: number, maxDistance = 50, out?: RoadHit): RoadHit | null {
    const index = net.index;
    const range = scratchRange;
    const probe = scratchProjection;
    cellRange(index, x, z, maxDistance + 1, range);
    let bestEdge = -1, bestK = 0, bestT = 0, bestDistance = Infinity, bestS = Infinity;
    let bestDx = 0, bestDz = 0, bestQx = 0, bestQz = 0;
    for (let cz = range[2]; cz <= range[3]; cz++) {
        for (let cx = range[0]; cx <= range[1]; cx++) {
            const cell = cz * index.cols + cx;
            for (let slot = index.cellStart[cell]; slot < index.cellStart[cell + 1]; slot++) {
                const edge = net.edges[index.edgeOf[slot]];
                const k = index.sampleOf[slot];
                if (k + 1 >= edge.samples.length) continue;
                projectSegment(edge, k, x, z, probe);
                const d = probe.distance;
                if (d > maxDistance || d > bestDistance) continue;
                const s = edge.samples[k].s + (edge.samples[k + 1].s - edge.samples[k].s) * probe.t;
                if (d === bestDistance && (edge.index > bestEdge || (edge.index === bestEdge && s >= bestS))) continue;
                bestEdge = edge.index; bestK = k; bestT = probe.t; bestDistance = d; bestS = s;
                bestDx = probe.dx; bestDz = probe.dz; bestQx = probe.qx; bestQz = probe.qz;
            }
        }
    }
    if (bestEdge < 0) return null;
    const edge = net.edges[bestEdge];
    const a = edge.samples[bestK], b = edge.samples[bestK + 1];
    let tx = a.tx + (b.tx - a.tx) * bestT, tz = a.tz + (b.tz - a.tz) * bestT;
    const tl = Math.sqrt(tx * tx + tz * tz);
    tx /= tl; tz /= tl;
    const hit = out ?? { edge, s: 0, x: 0, z: 0, tx: 0, tz: 0, distance: 0, lateral: 0 };
    hit.edge = edge;
    hit.s = bestS;
    hit.x = bestQx; hit.z = bestQz;
    hit.tx = tx; hit.tz = tz;
    hit.distance = bestDistance;
    // Left normal (tz, -tx)
    hit.lateral = bestDx * tz - bestDz * tx;
    return hit;
}

export interface SurfaceHit {
    surface: SurfaceName;
    // What provides it: an area or an edge
    area?: string;
    edge?: string;
}

const SURFACE_NAMES = Object.keys(SURFACE) as SurfaceName[];

// Scratch state of the queries (single-threaded JavaScript: never shared
// between two running queries)
const scratchProjection = newProjection();
const scratchRange = new Int32Array(4);
let lastArea = -1;
let lastEdge = -1;

/**
 * Surface ID of the road or area at a position (SURFACE in types.ts), or
 * -1 offroad (the terrain decides). Inside an area its surface, on a road's
 * drivable width that road's surface. Where several claim the point, the
 * higher priority of table 8.1 wins; on a tie areas before edges, then the
 * lower index. Allocates nothing.
 *
 * Not for the sim tick either: the tick reads the baked surface layer
 * (surfaceAt in heightfield.ts, O(1)); this query is for the tools and the
 * map validation.
 */
export function roadSurfaceIdAt(net: RoadNetwork, x: number, z: number): number {
    let best = -1, bestPriority = -1;
    lastArea = lastEdge = -1;
    const bounds = net.areaBounds;
    for (let i = 0; i < net.areas.length; i++) {
        const b = 4 * i;
        if (x < bounds[b] || x > bounds[b + 2] || z < bounds[b + 1] || z > bounds[b + 3]) continue;
        const area = net.areas[i];
        if (!pointInPolygon(area.polygon, x, z)) continue;
        const id = SURFACE[area.surface];
        // Areas come in index order, so only a higher priority replaces one
        if (SURFACE_PRIORITY[id] > bestPriority) { best = id; bestPriority = SURFACE_PRIORITY[id]; lastArea = i; }
    }
    if (net.edges.length === 0) return best;
    const index = net.index;
    const range = scratchRange;
    const probe = scratchProjection;
    cellRange(index, x, z, net.maxHalfWidth + 1, range);
    let bestEdge = Infinity;
    for (let cz = range[2]; cz <= range[3]; cz++) {
        for (let cx = range[0]; cx <= range[1]; cx++) {
            const cell = cz * index.cols + cx;
            for (let slot = index.cellStart[cell]; slot < index.cellStart[cell + 1]; slot++) {
                const edge = net.edges[index.edgeOf[slot]];
                const k = index.sampleOf[slot];
                if (k + 1 >= edge.samples.length) continue;
                const id = SURFACE[edge.profile.surface];
                const priority = SURFACE_PRIORITY[id];
                // Cannot win: lower priority, or equal and an area or a lower edge holds it
                if (priority < bestPriority || (priority === bestPriority && (lastArea >= 0 || edge.index >= bestEdge))) continue;
                projectSegment(edge, k, x, z, probe);
                if (probe.distance > edge.halfWidth) continue;
                best = id; bestPriority = priority; bestEdge = edge.index;
                lastArea = -1; lastEdge = edge.index;
            }
        }
    }
    return best;
}

// Road surface at a position as a name with its source, or null offroad
// (roadSurfaceIdAt with the result spelled out; for tools and tests)
export function roadSurfaceAt(net: RoadNetwork, x: number, z: number): SurfaceHit | null {
    const id = roadSurfaceIdAt(net, x, z);
    if (id < 0) return null;
    if (lastArea >= 0) return { surface: SURFACE_NAMES[id], area: net.areas[lastArea].id };
    return { surface: SURFACE_NAMES[id], edge: net.edges[lastEdge].id };
}

/**
 * True when (x, z) lies within `margin` of a road's corridor: its drivable
 * width, the sidewalk on that side and the shoulder (5.2). For placing
 * buildings and plants beside the roads (buildings.ts, plants.ts); not for
 * the sim tick. Allocates nothing.
 */
export function insideCorridor(net: RoadNetwork, x: number, z: number, margin: number): boolean {
    if (net.edges.length === 0) return false;
    const index = net.index;
    const range = scratchRange;
    const probe = scratchProjection;
    cellRange(index, x, z, net.maxCorridor + margin + 1, range);
    for (let cz = range[2]; cz <= range[3]; cz++) {
        for (let cx = range[0]; cx <= range[1]; cx++) {
            const cell = cz * index.cols + cx;
            for (let slot = index.cellStart[cell]; slot < index.cellStart[cell + 1]; slot++) {
                const edge = net.edges[index.edgeOf[slot]];
                const k = index.sampleOf[slot];
                if (k + 1 >= edge.samples.length) continue;
                projectSegment(edge, k, x, z, probe);
                const p = edge.profile;
                if (probe.distance >= edge.halfWidth + Math.max(p.sidewalk.left, p.sidewalk.right) + p.shoulder + margin) continue;
                // Left of the edge direction: the left sidewalk
                const a = edge.samples[k];
                const left = probe.dx * a.tz - probe.dz * a.tx > 0;
                const reach = edge.halfWidth + (left ? p.sidewalk.left : p.sidewalk.right) + p.shoulder + margin;
                if (probe.distance < reach) return true;
            }
        }
    }
    return false;
}

export function isOnRoad(net: RoadNetwork, x: number, z: number): boolean {
    return roadSurfaceAt(net, x, z) !== null;
}
