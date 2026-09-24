// The bake (docs/phase-3-design.md, 6.4): base terrain + road network + map
// zones → heightfield with road corridors, surface and zone layers. Pure
// apart from the time measurements; bake.ts does the file handling.
//
//  1. natural ground from base.json on the grid,
//  2. a height profile per chain of edges (roads through joints) with node
//     heights, junction plateaus and elevation pins,
//  3. corridors and areas shape the terrain (flat zone, 1 : 1.5 slopes),
//  4. surfaces: roads and areas over the natural classification,
//  5. zones from map.json, then quantise.

import {
    DEFAULT_MAX_GRADE, FLAT_MARGIN, flatHalfWidths, longitudinalProfile, movingAverage,
    PROFILE_SMOOTH_WINDOW, TerrainShaper, type ConflictReport, type CorridorLine, type ProfilePin
} from '../../src/shared/map/corridor.js';
import { pointInPolygon } from '../../src/shared/map/geometry.js';
import {
    encodeHeightfield, quantizeHeight, zoneCols, zoneRows, type GridSpec, type Heightfield
} from '../../src/shared/map/heightfield.js';
import {
    buildRoadNetwork, junctionRadius, roadChains, type RoadChain, type RoadEdgeData, type RoadNetwork
} from '../../src/shared/map/roadNetwork.js';
import type { MapFile, RoadNetworkFile } from '../../src/shared/map/roadSchema.js';
import { pointAt } from '../../src/shared/map/spline.js';
import { SURFACE, ZONE } from '../../src/shared/map/types.js';
import { baseSample, regionSurface, type BaseTerrain } from './baseTerrain.js';

// Bumped whenever the bake's algorithm changes its output; part of the
// sourceHash, so a stale terrain.bhf is detected
export const BAKE_VERSION = 1;

// Natural ground below the water line by more than this is sea floor
const WATER_SURFACE_DEPTH = 0.05;
// Wet sand: the strip of beach up to this height above the water
const WET_SAND_HEIGHT = 0.5;
// Beach sand up to this much above the beach top (cliffs are rock or grass)
const BEACH_SAND_MARGIN = 1.5;
// Slope from which open ground is rock (1 = 45°)
const ROCK_SLOPE = 1;

export interface BakeInput {
    roads: RoadNetworkFile;
    base: BaseTerrain;
    map: MapFile;
    spec: GridSpec;
    sourceHash: Uint8Array;
}

export interface ChainReport {
    edges: string[];
    length: number;
    // Shortfall of the pins against the grade limit (m), 0 = fine
    infeasible: number;
}

export interface BakeReport {
    edges: number;
    nodes: number;
    areas: number;
    roadLength: number;
    minHeight: number;
    maxHeight: number;
    conflicts: ConflictReport;
    infeasibleChains: ChainReport[];
    // Steepest grade between neighbouring samples of any edge, measured on
    // the baked heightfield
    maxBakedGrade: { edge: string; grade: number };
    networkIssues: string[];
    surfaceCounts: Record<string, number>;
    timings: Record<string, number>;
}

export interface BakeResult {
    heightfield: Heightfield;
    bytes: Uint8Array;
    network: RoadNetwork;
    // Profile height per sample, by edge id
    edgeHeights: Map<string, Float64Array>;
    // Heights before quantising (for tests and the preview)
    heights: Float64Array;
    // 1 where corridors conflict (preview)
    conflictMask: Uint8Array;
    report: BakeReport;
}

// Bilinear interpolation on a double grid laid out like the heightfield
export function sampleGrid(spec: GridSpec, values: Float64Array, x: number, z: number): number {
    let gx = (x - spec.originX) / spec.cellSize;
    let gz = (z - spec.originZ) / spec.cellSize;
    gx = Math.max(0, Math.min(spec.cols - 1, gx));
    gz = Math.max(0, Math.min(spec.rows - 1, gz));
    const i = Math.min(spec.cols - 2, Math.floor(gx)), j = Math.min(spec.rows - 2, Math.floor(gz));
    const fx = gx - i, fz = gz - j, k = j * spec.cols + i;
    const top = values[k] + (values[k + 1] - values[k]) * fx;
    const bottom = values[k + spec.cols] + (values[k + spec.cols + 1] - values[k + spec.cols]) * fx;
    return top + (bottom - top) * fz;
}

// Stations of a chain: equally spaced, at most 1 m apart, both ends included
interface ChainStations {
    chain: RoadChain;
    spacing: number;
    count: number;
    // Chain station where each part starts
    offsets: number[];
    natural: Float64Array;
    smoothed: Float64Array;
}

function partStation(net: RoadNetwork, stations: ChainStations, part: number, s: number): number {
    const p = stations.chain.parts[part];
    const edge = net.edges[p.edge];
    return stations.offsets[part] + (p.reversed ? edge.length - s : s);
}

function chainStations(net: RoadNetwork, spec: GridSpec, natural: Float64Array, chain: RoadChain): ChainStations {
    const count = Math.max(2, Math.ceil(chain.length) + 1);
    const spacing = chain.length / (count - 1);
    const offsets: number[] = [];
    let offset = 0;
    for (const part of chain.parts) { offsets.push(offset); offset += net.edges[part.edge].length; }
    const values = new Float64Array(count);
    let part = 0;
    for (let i = 0; i < count; i++) {
        const S = i * spacing;
        while (part < chain.parts.length - 1 && offsets[part + 1] <= S) part++;
        const p = chain.parts[part];
        const edge = net.edges[p.edge];
        const local = S - offsets[part];
        const point = pointAt(edge.samples, p.reversed ? edge.length - local : local);
        values[i] = sampleGrid(spec, natural, point.x, point.z);
    }
    return {
        chain, spacing, count, offsets, natural: values,
        smoothed: movingAverage(values, Math.round(PROFILE_SMOOTH_WINDOW / 2 / spacing))
    };
}

function maxFlatHalf(edge: RoadEdgeData): number {
    const w = flatHalfWidths(edge.profile);
    return Math.max(w.left, w.right);
}

// Flat plateau at a chain end, measured along the chain from the node:
// - at a junction the trim radius, but at least the widest flat zone of an
//   incident road, so crossing roads meet at one height;
// - at a node an area connects to, the road runs level until its flat
//   zone and the area's flat margin are clear of the area.
function plateauLength(net: RoadNetwork, nodeIndex: number, edge: RoadEdgeData, fromStart: boolean): number {
    const node = net.nodes[nodeIndex];
    let plateau = 0;
    if (node.def.kind === 'junction') {
        let flat = 0;
        for (const end of node.ends) flat = Math.max(flat, maxFlatHalf(net.edges[end.edge]));
        plateau = Math.max(junctionRadius(net, node), flat);
    }
    for (const area of net.areas) {
        if (!area.connects.includes(node.id)) continue;
        // Station where the edge leaves the area, walking from the node
        const samples = edge.samples;
        let exit = 0;
        for (let i = 0; i < samples.length; i++) {
            const sample = samples[fromStart ? i : samples.length - 1 - i];
            if (!pointInPolygon(area.polygon, sample.x, sample.z)) break;
            exit = fromStart ? sample.s : edge.length - sample.s;
        }
        plateau = Math.max(plateau, exit + maxFlatHalf(edge) + FLAT_MARGIN);
    }
    return plateau;
}

function edgeGrade(edge: RoadEdgeData): number {
    return edge.def.maxGrade ?? DEFAULT_MAX_GRADE;
}

// Height profile of every edge, sample by sample
export function roadProfiles(net: RoadNetwork, spec: GridSpec, natural: Float64Array,
    areaHeights: readonly number[] = []): { heights: Map<string, Float64Array>; chains: RoadChain[]; reports: ChainReport[] } {
    const chains = roadChains(net);
    const stations = chains.map(chain => chainStations(net, spec, natural, chain));

    // Node heights: fixed y, else the height of an area the node connects
    // to (roads end level with their plaza, pier or car park), else the
    // mean of the smoothed ground at the chain ends meeting there
    const areaOfNode = new Map<string, number>();
    net.areas.forEach((area, i) => {
        for (const id of area.connects) if (!areaOfNode.has(id)) areaOfNode.set(id, areaHeights[i]);
    });
    const sums = new Float64Array(net.nodes.length);
    const counts = new Float64Array(net.nodes.length);
    for (const st of stations) {
        if (st.chain.closed) continue;
        sums[st.chain.startNode] += st.smoothed[0];
        counts[st.chain.startNode]++;
        sums[st.chain.endNode] += st.smoothed[st.count - 1];
        counts[st.chain.endNode]++;
    }
    const nodeHeight = (index: number) => {
        const node = net.nodes[index];
        return node.def.y ?? areaOfNode.get(node.id) ?? sums[index] / counts[index];
    };

    const heights = new Map<string, Float64Array>();
    const reports: ChainReport[] = [];
    for (const st of stations) {
        const { chain, spacing, count } = st;
        const length = chain.length;
        const pins: ProfilePin[] = [];
        if (chain.closed) {
            const node = net.nodes[chain.startNode];
            const y = node.def.y ?? (st.smoothed[0] + st.smoothed[count - 1]) / 2;
            pins.push({ from: 0, to: 0, y }, { from: length, to: length, y });
        } else {
            const first = chain.parts[0], last = chain.parts[chain.parts.length - 1];
            const startPlateau = Math.min(plateauLength(net, chain.startNode, net.edges[first.edge], !first.reversed), length / 2);
            const endPlateau = Math.min(plateauLength(net, chain.endNode, net.edges[last.edge], last.reversed), length / 2);
            pins.push({ from: 0, to: startPlateau, y: nodeHeight(chain.startNode) });
            pins.push({ from: length - endPlateau, to: length, y: nodeHeight(chain.endNode) });
        }
        chain.parts.forEach((part, i) => {
            const edge = net.edges[part.edge];
            // Joint nodes with a fixed height inside the chain
            if (i > 0) {
                const joint = net.nodes[part.reversed ? edge.to : edge.from];
                if (joint.def.y !== undefined) pins.push({ from: st.offsets[i], to: st.offsets[i], y: joint.def.y });
            }
            for (const pin of edge.def.elevation ?? []) {
                const S = partStation(net, st, i, Math.min(pin.s, edge.length));
                pins.push({ from: S, to: S, y: pin.y });
            }
        });
        // Grade limit per step: that of the edge the step lies on
        const grades = new Float64Array(Math.max(1, count - 1));
        let part = 0;
        for (let i = 0; i < count - 1; i++) {
            const mid = (i + 0.5) * spacing;
            while (part < chain.parts.length - 1 && st.offsets[part + 1] <= mid) part++;
            grades[i] = edgeGrade(net.edges[chain.parts[part].edge]);
        }
        const profile = longitudinalProfile(st.natural, spacing, grades, pins);
        chain.parts.forEach((p, i) => {
            const edge = net.edges[p.edge];
            const values = new Float64Array(edge.samples.length);
            edge.samples.forEach((sample, k) => {
                const S = partStation(net, st, i, sample.s);
                const g = Math.max(0, Math.min(count - 1, S / spacing));
                const j = Math.min(count - 2, Math.floor(g));
                values[k] = profile.heights[j] + (profile.heights[j + 1] - profile.heights[j]) * (g - j);
            });
            heights.set(edge.id, values);
        });
        reports.push({ edges: chain.parts.map(p => net.edges[p.edge].id), length, infeasible: profile.infeasible });
    }
    return { heights, chains, reports };
}

function inRanges(ranges: readonly { from: number; to: number }[], edge: RoadEdgeData, s: number): boolean {
    for (const range of ranges) {
        const to = range.to < 0 ? edge.length : range.to;
        if (s >= range.from && s <= to) return true;
    }
    return false;
}

// One corridor polyline per chain: the samples of its edges in chain order
// (the joint sample once), with per-vertex height, flat half widths, walls
// and surface. Left and right swap on edges walked against their direction.
export function corridorLine(net: RoadNetwork, chain: RoadChain, heights: Map<string, Float64Array>): CorridorLine {
    const x: number[] = [], z: number[] = [], y: number[] = [];
    const halfLeft: number[] = [], halfRight: number[] = [];
    const wallLeft: number[] = [], wallRight: number[] = [];
    const surface: number[] = [], surfaceHalf: number[] = [];
    chain.parts.forEach((part, p) => {
        const edge = net.edges[part.edge];
        const ys = heights.get(edge.id)!;
        const flat = flatHalfWidths(edge.profile);
        const walls = edge.def.walls ?? [];
        const leftWalls = walls.filter(w => w.side === (part.reversed ? 'right' : 'left'));
        const rightWalls = walls.filter(w => w.side === (part.reversed ? 'left' : 'right'));
        const n = edge.samples.length;
        for (let i = p === 0 ? 0 : 1; i < n; i++) {
            const k = part.reversed ? n - 1 - i : i;
            const sample = edge.samples[k];
            x.push(sample.x); z.push(sample.z); y.push(ys[k]);
            halfLeft.push(part.reversed ? flat.right : flat.left);
            halfRight.push(part.reversed ? flat.left : flat.right);
            wallLeft.push(inRanges(leftWalls, edge, sample.s) ? 1 : 0);
            wallRight.push(inRanges(rightWalls, edge, sample.s) ? 1 : 0);
            surface.push(SURFACE[edge.profile.surface]);
            // Drivable width + 1 m (8.1)
            surfaceHalf.push(edge.halfWidth + 1);
        }
    });
    return { x, z, y, halfLeft, halfRight, wallLeft, wallRight, surface, surfaceHalf };
}

// Mean natural height over the grid points inside a polygon (its first
// vertex when it covers none)
export function areaMeanHeight(spec: GridSpec, natural: Float64Array, polygon: readonly (readonly [number, number])[]): number {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const [x, z] of polygon) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    let sum = 0, count = 0;
    const i0 = Math.max(0, Math.ceil((minX - spec.originX) / spec.cellSize));
    const i1 = Math.min(spec.cols - 1, Math.floor((maxX - spec.originX) / spec.cellSize));
    const j0 = Math.max(0, Math.ceil((minZ - spec.originZ) / spec.cellSize));
    const j1 = Math.min(spec.rows - 1, Math.floor((maxZ - spec.originZ) / spec.cellSize));
    for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
            if (pointInPolygon(polygon, spec.originX + i * spec.cellSize, spec.originZ + j * spec.cellSize)) {
                sum += natural[j * spec.cols + i];
                count++;
            }
        }
    }
    return count ? sum / count : sampleGrid(spec, natural, polygon[0][0], polygon[0][1]);
}

export function bakeTerrain(input: BakeInput): BakeResult {
    const { spec, base, map } = input;
    const timings: Record<string, number> = {};
    let t0 = performance.now();
    const lap = (name: string) => { const t = performance.now(); timings[name] = Math.round(t - t0); t0 = t; };

    const net = buildRoadNetwork(input.roads);
    lap('network');

    // 1. Natural ground
    const n = spec.cols * spec.rows;
    const natural = new Float64Array(n);
    const coast = new Float64Array(n);
    for (let j = 0; j < spec.rows; j++) {
        const z = spec.originZ + j * spec.cellSize;
        for (let i = 0; i < spec.cols; i++) {
            const sample = baseSample(base, spec.originX + i * spec.cellSize, z);
            natural[j * spec.cols + i] = sample.height;
            coast[j * spec.cols + i] = sample.coast;
        }
    }
    lap('natural');

    // 2. Area heights (fixed, or the mean natural ground inside) and road
    // profiles
    const areaHeights = net.areas.map(area => area.y ?? areaMeanHeight(spec, natural, area.polygon));
    const { heights: edgeHeights, chains, reports } = roadProfiles(net, spec, natural, areaHeights);
    lap('profiles');

    // 3. Corridors and areas
    const shaper = new TerrainShaper(spec, natural);
    for (const chain of chains) shaper.addLine(corridorLine(net, chain, edgeHeights));
    net.areas.forEach((area, i) => shaper.addArea({
        polygon: area.polygon, y: areaHeights[i], margin: FLAT_MARGIN,
        walls: area.walls ?? false, surface: SURFACE[area.surface]
    }));
    const { heights, conflicts, conflictMask } = shaper.finish();
    lap('corridors');

    // 4. Surfaces
    const surface = new Uint8Array(n);
    const surfaceCounts: Record<string, number> = {};
    const names = Object.keys(SURFACE) as (keyof typeof SURFACE)[];
    for (let j = 0; j < spec.rows; j++) {
        for (let i = 0; i < spec.cols; i++) {
            const k = j * spec.cols + i;
            let id = shaper.surface[k];
            if (id < 0) {
                const x = spec.originX + i * spec.cellSize, z = spec.originZ + j * spec.cellSize;
                const h = heights[k];
                const i0 = Math.max(0, i - 1), i1 = Math.min(spec.cols - 1, i + 1);
                const j0 = Math.max(0, j - 1), j1 = Math.min(spec.rows - 1, j + 1);
                const gx = (heights[j * spec.cols + i1] - heights[j * spec.cols + i0]) / ((i1 - i0) * spec.cellSize);
                const gz = (heights[j1 * spec.cols + i] - heights[j0 * spec.cols + i]) / ((j1 - j0) * spec.cellSize);
                const region = regionSurface(base, x, z);
                if (h < spec.waterLevel - WATER_SURFACE_DEPTH) id = SURFACE.water;
                else if (coast[k] < base.beach.width && h < spec.waterLevel + WET_SAND_HEIGHT) id = SURFACE.wetSand;
                else if (region) id = SURFACE[region];
                else if (Math.hypot(gx, gz) > ROCK_SLOPE) id = SURFACE.rock;
                else if (coast[k] < base.beach.width && h < base.beach.top + BEACH_SAND_MARGIN) id = SURFACE.sand;
                else id = SURFACE.grass;
            }
            surface[k] = id;
            surfaceCounts[names[id]] = (surfaceCounts[names[id]] ?? 0) + 1;
        }
    }
    lap('surfaces');

    // 5. Zones (8 m cells, sampled at the cell centre; later polygons win)
    const zc = zoneCols(spec), zr = zoneRows(spec);
    const zones = new Uint8Array(zc * zr).fill(ZONE.wild);
    for (let j = 0; j < zr; j++) {
        const z = spec.originZ + (j + 0.5) * spec.zoneCell;
        for (let i = 0; i < zc; i++) {
            const x = spec.originX + (i + 0.5) * spec.zoneCell;
            for (const zone of map.zones) if (pointInPolygon(zone.polygon, x, z)) zones[j * zc + i] = ZONE[zone.zone];
        }
    }
    lap('zones');

    const q = new Uint16Array(n);
    let minHeight = Infinity, maxHeight = -Infinity;
    for (let k = 0; k < n; k++) {
        q[k] = quantizeHeight(spec, heights[k]);
        minHeight = Math.min(minHeight, heights[k]);
        maxHeight = Math.max(maxHeight, heights[k]);
    }
    const heightfield: Heightfield = {
        spec, q, surface, zones, mapVersion: map.mapVersion, sourceHash: input.sourceHash
    };
    const bytes = encodeHeightfield(heightfield);
    lap('encode');

    // Steepest baked grade along the roads (checks profile and flattening)
    const maxBakedGrade = { edge: '', grade: 0 };
    for (const edge of net.edges) {
        let prev = sampleGrid(spec, heights, edge.samples[0].x, edge.samples[0].z);
        for (let k = 1; k < edge.samples.length; k++) {
            const h = sampleGrid(spec, heights, edge.samples[k].x, edge.samples[k].z);
            const grade = Math.abs(h - prev) / (edge.samples[k].s - edge.samples[k - 1].s);
            if (grade > maxBakedGrade.grade) { maxBakedGrade.grade = grade; maxBakedGrade.edge = edge.id; }
            prev = h;
        }
    }

    let roadLength = 0;
    for (const edge of net.edges) roadLength += edge.length;
    return {
        heightfield, bytes, network: net, edgeHeights, heights, conflictMask,
        report: {
            edges: net.edges.length,
            nodes: net.nodes.length,
            areas: net.areas.length,
            roadLength,
            minHeight, maxHeight,
            conflicts,
            infeasibleChains: reports.filter(c => c.infeasible > 0.01),
            maxBakedGrade,
            networkIssues: net.issues,
            surfaceCounts,
            timings
        }
    };
}
