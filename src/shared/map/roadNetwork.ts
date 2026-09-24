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
    // Largest half width of any edge (search radius of the surface query)
    maxHalfWidth: number;
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
        const angle = Math.acos(Math.min(1, Math.max(-1, cos)));
        if (angle > JOINT_TOLERANCE_RAD) {
            issues.push(`node ${node.id}: joint is not tangent-continuous (${(angle * 180 / Math.PI).toFixed(2)}°)`);
        }
    }

    let maxHalfWidth = 0;
    for (const edge of edges) maxHalfWidth = Math.max(maxHalfWidth, edge.halfWidth);
    return {
        mapId: file.mapId, nodes, edges, areas: file.areas, nodeById, edgeById,
        index: new SampleIndex(edges), maxHalfWidth, issues
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

// Projects (x, z) onto the centre-line segment from sample k to k + 1
function projectSegment(edge: RoadEdgeData, k: number, x: number, z: number, out: RoadHit): number {
    const a = edge.samples[k], b = edge.samples[k + 1];
    const ex = b.x - a.x, ez = b.z - a.z;
    const len2 = ex * ex + ez * ez;
    let t = len2 > 0 ? ((x - a.x) * ex + (z - a.z) * ez) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const qx = a.x + ex * t, qz = a.z + ez * t;
    const dx = x - qx, dz = z - qz;
    const distance = Math.sqrt(dx * dx + dz * dz);
    let tx = a.tx + (b.tx - a.tx) * t, tz = a.tz + (b.tz - a.tz) * t;
    const tl = Math.sqrt(tx * tx + tz * tz);
    tx /= tl; tz /= tl;
    out.edge = edge;
    out.s = a.s + (b.s - a.s) * t;
    out.x = qx; out.z = qz;
    out.tx = tx; out.tz = tz;
    out.distance = distance;
    // Left normal (tz, -tx)
    out.lateral = dx * tz - dz * tx;
    return distance;
}

// Visits every centre-line segment registered in the cells that overlap the
// square of half size `radius` around (x, z)
function forEachCandidate(net: RoadNetwork, x: number, z: number, radius: number,
    visit: (edge: RoadEdgeData, k: number) => void): void {
    const index = net.index;
    const x0 = index.cellX(x - radius), x1 = index.cellX(x + radius);
    const z0 = index.cellZ(z - radius), z1 = index.cellZ(z + radius);
    for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) {
            const cell = cz * index.cols + cx;
            for (let slot = index.cellStart[cell]; slot < index.cellStart[cell + 1]; slot++) {
                const edge = net.edges[index.edgeOf[slot]];
                const k = index.sampleOf[slot];
                if (k + 1 < edge.samples.length) visit(edge, k);
                if (k > 0) visit(edge, k - 1);
            }
        }
    }
}

// Nearest point on any road's centre line within maxDistance, or null.
// Ties go to the lower edge index, then the lower station.
export function nearestRoad(net: RoadNetwork, x: number, z: number, maxDistance = 50): RoadHit | null {
    let best: RoadHit | null = null;
    const probe = { edge: net.edges[0], s: 0, x: 0, z: 0, tx: 0, tz: 0, distance: 0, lateral: 0 } as RoadHit;
    // The segment of a sample can reach up to one sample spacing (1 m)
    // beyond the cells searched for it
    forEachCandidate(net, x, z, maxDistance + 1, (edge, k) => {
        const d = projectSegment(edge, k, x, z, probe);
        if (d > maxDistance) return;
        if (!best || d < best.distance || (d === best.distance
            && (edge.index < best.edge.index || (edge.index === best.edge.index && probe.s < best.s)))) {
            best = { ...probe };
        }
    });
    return best;
}

export interface SurfaceHit {
    surface: SurfaceName;
    // What provides it: an area or an edge
    area?: string;
    edge?: string;
}

// Road surface at a position: inside an area its surface, on a road's
// drivable width that road's surface, otherwise null (offroad: the terrain
// decides). Where several claim the point, the higher priority of table 8.1
// wins; on a tie areas before edges, then the lower index.
export function roadSurfaceAt(net: RoadNetwork, x: number, z: number): SurfaceHit | null {
    let best: SurfaceHit | null = null;
    // Rank: priority first, then areas (by index) before edges (by index)
    let bestPriority = -1, bestOrder = Infinity;
    const consider = (surface: SurfaceName, order: number, hit: Omit<SurfaceHit, 'surface'>) => {
        const priority = SURFACE_PRIORITY[SURFACE[surface]];
        if (priority > bestPriority || (priority === bestPriority && order < bestOrder)) {
            bestPriority = priority;
            bestOrder = order;
            best = { surface, ...hit };
        }
    };
    net.areas.forEach((area, i) => {
        if (pointInPolygon(area.polygon, x, z)) consider(area.surface, i, { area: area.id });
    });
    const probe = { edge: net.edges[0], s: 0, x: 0, z: 0, tx: 0, tz: 0, distance: 0, lateral: 0 } as RoadHit;
    if (net.edges.length) {
        forEachCandidate(net, x, z, net.maxHalfWidth + 1, (edge, k) => {
            projectSegment(edge, k, x, z, probe);
            if (probe.distance <= edge.halfWidth) {
                consider(edge.profile.surface, net.areas.length + edge.index, { edge: edge.id });
            }
        });
    }
    return best;
}

export function isOnRoad(net: RoadNetwork, x: number, z: number): boolean {
    return roadSurfaceAt(net, x, z) !== null;
}
