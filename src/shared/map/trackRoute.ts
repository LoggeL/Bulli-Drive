// Race routes over the road network (docs/phase-3-design.md, 13.1 and 13.2,
// steps 1 to 4): checks a route of tracks.json, builds its centre line
// through the junctions, places the gates and the starting grid.
// routeToTrack (13.2, steps 5 and 6) turns the result into a TrackDef of
// phase 2 with barriers and chevrons; the map validation uses it to check
// that every track is closed, reachable and drivable.

import type { TrackRoute } from './mapFiles.js';
import {
    junctionRadius, type EdgeEnd, type RoadEdgeData, type RoadNetwork, type RoadNodeData
} from './roadNetwork.js';
import { cubic, leftNormal, length2, pointAt, sampleSegments } from './spline.js';
import { SURFACE } from './types.js';

// Spacing of the centre line (13.2, step 2: fits the projection window of
// phase 2)
export const ROUTE_SPACING = 2;
// No gate within this distance after a junction (13.2, step 3) ...
export const GATE_AFTER_JUNCTION = 25;
// ... nor this close before one, where its line would reach into the
// junction area
export const GATE_BEFORE_JUNCTION = 10;
// Nor in a bend sharper than this (hairpins), checked ±GATE_BEND_WINDOW
export const GATE_MAX_CURVATURE = 1 / 30;
const GATE_BEND_WINDOW = 4;
// Gates closer than this to an earlier one are dropped
export const GATE_MIN_GAP = 20;
// Gate width beyond the road (13.2: road width + 2 m)
export const GATE_EXTRA_WIDTH = 2;
// Starting grid (13.2, step 4, and phase 2): 8 slots staggered in two
// lanes, the pole 6 m behind the start gate, every further slot 4 m back,
// so a lane has a car every 8 m
export const GRID_SLOTS = 8;
export const GRID_FIRST = 6;
export const GRID_STEP = 4;

export type GateVisual = 'startFinish' | 'start' | 'finish' | 'arch';

export interface RoutePart {
    edge: RoadEdgeData;
    reversed: boolean;
    entry: RoadNodeData;
    exit: RoadNodeData;
    // Kept stretch of the edge in driving direction (after junction trims),
    // as distances from the entry node
    keepFrom: number;
    keepTo: number;
    // Route station of keepFrom
    routeStart: number;
}

export interface JunctionPass {
    node: RoadNodeData;
    // Route stations where the transition through the junction begins and
    // ends (the trimmed ends of the two parts)
    entryS: number;
    exitS: number;
    from: number;
    to: number;
    // Edge ends at the node the route does not use
    others: EdgeEnd[];
}

export interface RoutePoint {
    x: number;
    z: number;
    // Unit tangent in driving direction
    tx: number;
    tz: number;
    s: number;
    // Signed curvature (1/m), positive when the route turns left
    curvature: number;
    halfWidth: number;
    surface: number;
    // Index of the route part, -1 inside a junction transition
    part: number;
}

export interface RouteGate {
    x: number;
    z: number;
    yaw: number;
    width: number;
    s: number;
    visual: GateVisual;
}

export interface RouteGridSlot { x: number; z: number; yaw: number; s: number; lateral: number }

export interface ResolvedRoute {
    track: TrackRoute;
    parts: RoutePart[];
    junctions: JunctionPass[];
    // Centre line every ROUTE_SPACING m. A circuit is closed (the last point
    // is not the first); a sprint ends at the route's last node.
    points: RoutePoint[];
    length: number;
    closed: boolean;
    startS: number;
    // Circuit: startS + length (one lap)
    finishS: number;
    gates: RouteGate[];
    grid: RouteGridSlot[];
}

export type RouteResult = { ok: true; route: ResolvedRoute } | { ok: false; errors: string[] };

// Driving direction yaw of the sim: forward = (sin yaw, cos yaw). Math.atan2
// is only approximated by the engines, and the yaw goes into the TrackDef
// that client and server hash (trackHash). Rounded to a micro-radian, the
// last-bit differences of atan2 vanish (only a value within one ulp of a
// rounding boundary could still differ).
export const YAW_RESOLUTION = 1e6;
export function yawOf(tx: number, tz: number): number {
    return Math.round(Math.atan2(tx, tz) * YAW_RESOLUTION) / YAW_RESOLUTION; // determinism: rounded
}

interface Step { edge: RoadEdgeData; reversed: boolean }

// 13.2, step 1: the edges exist, follow each other through shared nodes,
// close a circuit, appear once, pass no node twice, respect one-way roads
function checkSteps(net: RoadNetwork, track: TrackRoute): { steps: Step[]; errors: string[] } {
    const errors: string[] = [];
    const steps: Step[] = [];
    const seen = new Set<string>();
    for (const entry of track.route) {
        const reversed = entry.startsWith('-');
        const id = reversed ? entry.slice(1) : entry;
        const edge = net.edgeById.get(id);
        if (!edge) { errors.push(`unknown edge ${id}`); continue; }
        if (seen.has(id)) errors.push(`edge ${id} appears twice`);
        seen.add(id);
        if (reversed && edge.def.oneWay) errors.push(`edge ${id} is one-way and cannot be driven backwards`);
        steps.push({ edge, reversed });
    }
    if (errors.length) return { steps, errors };
    const entry = (step: Step) => step.reversed ? step.edge.to : step.edge.from;
    const exit = (step: Step) => step.reversed ? step.edge.from : step.edge.to;
    for (let i = 1; i < steps.length; i++) {
        if (exit(steps[i - 1]) !== entry(steps[i])) {
            errors.push(`gap between ${steps[i - 1].edge.id} (ends at ${net.nodes[exit(steps[i - 1])].id}) `
                + `and ${steps[i].edge.id} (starts at ${net.nodes[entry(steps[i])].id})`);
        }
    }
    const closed = track.kind === 'circuit';
    const last = steps[steps.length - 1];
    if (closed && exit(last) !== entry(steps[0])) {
        errors.push(`circuit is not closed: ends at ${net.nodes[exit(last)].id}, starts at ${net.nodes[entry(steps[0])].id}`);
    }
    // A node passed twice is a crossing of the route with itself
    const visits = new Map<number, number>();
    const nodes = steps.map(entry);
    if (!closed) nodes.push(exit(last));
    for (const node of nodes) visits.set(node, (visits.get(node) ?? 0) + 1);
    for (const [node, count] of visits) {
        if (count > 1) errors.push(`passes node ${net.nodes[node].id} ${count} times (the route crosses itself)`);
    }
    return { steps, errors };
}

interface DensePoint { x: number; z: number; tx: number; tz: number; curvature: number; halfWidth: number; surface: number; part: number }

function partPoint(part: RoutePart, d: number, index: number): DensePoint {
    const edge = part.edge;
    const p = pointAt(edge.samples, part.reversed ? edge.length - d : d);
    const sign = part.reversed ? -1 : 1;
    return {
        x: p.x, z: p.z, tx: p.tx * sign, tz: p.tz * sign, curvature: p.curvature * sign,
        halfWidth: edge.halfWidth, surface: SURFACE[edge.profile.surface], part: index
    };
}

// Resolves a route: 13.2, steps 1 to 4
export function resolveRoute(net: RoadNetwork, track: TrackRoute): RouteResult {
    const { steps, errors } = checkSteps(net, track);
    if (errors.length) return { ok: false, errors };
    const closed = track.kind === 'circuit';
    const n = steps.length;

    // Junction trims: only where the route passes through a junction
    const parts: RoutePart[] = steps.map(step => {
        const entry = net.nodes[step.reversed ? step.edge.to : step.edge.from];
        const exit = net.nodes[step.reversed ? step.edge.from : step.edge.to];
        return { edge: step.edge, reversed: step.reversed, entry, exit, keepFrom: 0, keepTo: step.edge.length, routeStart: 0 };
    });
    parts.forEach((part, i) => {
        if (i > 0 || closed) part.keepFrom = junctionRadius(net, part.entry);
        if (i < n - 1 || closed) part.keepTo = part.edge.length - junctionRadius(net, part.exit);
        if (part.keepTo - part.keepFrom < 1) {
            errors.push(`edge ${part.edge.id} is shorter than the junctions at its ends take`);
        }
    });
    if (errors.length) return { ok: false, errors };

    // Dense centre line: the kept stretches at 1 m, joined through each
    // junction by a cubic Hermite curve between the trimmed ends (C1)
    const dense: DensePoint[] = [];
    const denseS: number[] = [];
    const junctions: JunctionPass[] = [];
    let s = 0;
    const push = (p: DensePoint) => {
        if (dense.length) {
            const q = dense[dense.length - 1];
            const d = length2(p.x - q.x, p.z - q.z);
            if (d < 1e-6) return;
            s += d;
        }
        dense.push(p);
        denseS.push(s);
    };
    parts.forEach((part, i) => {
        const first = partPoint(part, part.keepFrom, i);
        const last = dense[dense.length - 1];
        part.routeStart = last ? s + length2(first.x - last.x, first.z - last.z) : 0;
        const kept = part.keepTo - part.keepFrom;
        const count = Math.ceil(kept);
        for (let k = 0; k <= count; k++) push(partPoint(part, part.keepFrom + Math.min(kept, k), i));
        if (i === n - 1 && !closed) return;
        const next = parts[(i + 1) % n];
        const a = partPoint(part, part.keepTo, i);
        const b = partPoint(next, next.keepFrom, (i + 1) % n);
        const node = part.exit;
        const entryS = s;
        if (node.def.kind === 'junction') {
            const m = length2(b.x - a.x, b.z - a.z) / 3;
            const curve = sampleSegments([cubic([a.x, a.z], [a.x + a.tx * m, a.z + a.tz * m],
                [b.x - b.tx * m, b.z - b.tz * m], [b.x, b.z])]).samples;
            for (let k = 1; k < curve.length - 1; k++) {
                const c = curve[k];
                push({
                    x: c.x, z: c.z, tx: c.tx, tz: c.tz, curvature: c.curvature,
                    halfWidth: Math.max(a.halfWidth, b.halfWidth), surface: a.surface, part: -1
                });
            }
            const exitS = s + length2(b.x - dense[dense.length - 1].x, b.z - dense[dense.length - 1].z);
            const used = [
                { edge: part.edge.index, atStart: part.reversed },
                { edge: next.edge.index, atStart: !next.reversed }
            ];
            const others = node.ends.filter(end => !used.some(u => u.edge === end.edge && u.atStart === end.atStart));
            junctions.push({ node, entryS, exitS, from: i, to: (i + 1) % n, others });
        }
    });
    let length = s;
    if (closed) {
        // Back to the first point, which closes the line
        const first = dense[0], last = dense[dense.length - 1];
        length += length2(first.x - last.x, first.z - last.z);
        dense.push(first);
        denseS.push(length);
    }
    // The pass through the closing junction of a circuit ends at station 0
    // of the next lap
    for (const pass of junctions) if (pass.exitS >= length) pass.exitS -= length;

    const points = resample(dense, denseS, length, closed);

    // Stations of start and finish
    const station = (edgeId: string, sEdge: number, what: string): number | null => {
        const index = parts.findIndex(p => p.edge.id === edgeId);
        if (index < 0) { errors.push(`${what} on edge ${edgeId}, which is not on the route`); return null; }
        const part = parts[index];
        const d = part.reversed ? part.edge.length - sEdge : sEdge;
        if (sEdge > part.edge.length || d < part.keepFrom || d > part.keepTo) {
            errors.push(`${what} at s = ${sEdge} on ${edgeId} lies in a junction or beyond the edge`);
            return null;
        }
        return part.routeStart + d - part.keepFrom;
    };
    const startS = station(track.start.edge, track.start.s, 'start');
    const finishS = closed ? (startS ?? 0) + length
        : track.finish ? station(track.finish.edge, track.finish.s, 'finish') : null;
    if (startS === null || finishS === null) return { ok: false, errors };
    if (!closed && finishS <= startS) errors.push(`finish (${finishS.toFixed(0)} m) is not after the start (${startS.toFixed(0)} m)`);

    const route: ResolvedRoute = {
        track, parts, junctions, points, length, closed, startS, finishS, gates: [], grid: []
    };
    if (!gateAllowed(route, startS)) errors.push(`start at ${startS.toFixed(0)} m is in or next to a junction or in a hairpin`);
    if (!closed && !gateAllowed(route, finishS, true)) errors.push(`finish at ${finishS.toFixed(0)} m is in a junction or a hairpin`);
    route.grid = startingGrid(route, errors);
    if (errors.length) return { ok: false, errors };
    route.gates = placeGates(route);
    return { ok: true, route };
}

function resample(dense: readonly DensePoint[], denseS: readonly number[], length: number, closed: boolean): RoutePoint[] {
    const points: RoutePoint[] = [];
    const count = closed ? Math.max(1, Math.round(length / ROUTE_SPACING)) : Math.floor(length / ROUTE_SPACING + 1e-9);
    const step = closed ? length / count : ROUTE_SPACING;
    const stations: number[] = [];
    for (let i = 0; i < count; i++) stations.push(i * step);
    if (!closed) stations.push(length);
    let j = 0;
    for (const S of stations) {
        while (j < dense.length - 2 && denseS[j + 1] <= S) j++;
        const a = dense[j], b = dense[Math.min(dense.length - 1, j + 1)];
        const span = denseS[Math.min(dense.length - 1, j + 1)] - denseS[j];
        const t = span > 0 ? Math.min(1, Math.max(0, (S - denseS[j]) / span)) : 0;
        let tx = a.tx + (b.tx - a.tx) * t, tz = a.tz + (b.tz - a.tz) * t;
        const len = length2(tx, tz) || 1;
        tx /= len; tz /= len;
        const near = t < 0.5 ? a : b;
        points.push({
            x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, tx, tz, s: S,
            curvature: a.curvature + (b.curvature - a.curvature) * t,
            halfWidth: near.halfWidth, surface: near.surface, part: near.part
        });
    }
    return points;
}

// Wraps a station of a circuit into [0, length)
function wrap(route: ResolvedRoute, S: number): number {
    if (!route.closed) return S;
    const L = route.length;
    return ((S % L) + L) % L;
}

// The centre-line point at station S (interpolated)
export function routePointAt(route: ResolvedRoute, S: number): RoutePoint {
    const pts = route.points;
    const s = wrap(route, S);
    if (!route.closed && s <= 0) return pts[0];
    if (!route.closed && s >= route.length) return pts[pts.length - 1];
    let i = Math.min(pts.length - 1, Math.max(0, Math.floor(s / (route.closed ? route.length / pts.length : ROUTE_SPACING))));
    while (i > 0 && pts[i].s > s) i--;
    while (i < pts.length - 1 && pts[i + 1].s <= s) i++;
    const a = pts[i];
    const b = i + 1 < pts.length ? pts[i + 1] : pts[0];
    const bs = i + 1 < pts.length ? b.s : route.length;
    const t = bs > a.s ? (s - a.s) / (bs - a.s) : 0;
    let tx = a.tx + (b.tx - a.tx) * t, tz = a.tz + (b.tz - a.tz) * t;
    const len = length2(tx, tz) || 1;
    tx /= len; tz /= len;
    return {
        x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, tx, tz, s,
        curvature: a.curvature + (b.curvature - a.curvature) * t,
        halfWidth: t < 0.5 ? a.halfWidth : b.halfWidth, surface: t < 0.5 ? a.surface : b.surface,
        part: t < 0.5 ? a.part : b.part
    };
}

// Distance from a to b going forward along the route (circuits wrap)
function forward(route: ResolvedRoute, a: number, b: number): number {
    return route.closed ? wrap(route, b - a) : b - a;
}

// The junction whose transition (plus the margins before and after it)
// contains station S, or null
export function junctionAt(route: ResolvedRoute, S: number, before = 0, after = 0): JunctionPass | null {
    for (const pass of route.junctions) {
        const span = forward(route, pass.entryS, pass.exitS);
        const into = forward(route, pass.entryS - before, S);
        if (into >= 0 && into <= before + span + after) return pass;
    }
    return null;
}

// A gate may stand at S: clear of junctions (GATE_BEFORE_JUNCTION before,
// GATE_AFTER_JUNCTION after) and not in a hairpin. The finish of a sprint
// may follow a junction closely (the last stretch is the run to the line).
export function gateAllowed(route: ResolvedRoute, S: number, finish = false): boolean {
    if (!route.closed && (S < 0 || S > route.length)) return false;
    if (junctionAt(route, S, GATE_BEFORE_JUNCTION, finish ? 0 : GATE_AFTER_JUNCTION)) return false;
    for (let d = -GATE_BEND_WINDOW; d <= GATE_BEND_WINDOW; d += ROUTE_SPACING) {
        if (Math.abs(routePointAt(route, S + d).curvature) > GATE_MAX_CURVATURE) return false;
    }
    return true;
}

function gateAt(route: ResolvedRoute, S: number, visual: GateVisual): RouteGate {
    const p = routePointAt(route, S);
    return {
        x: p.x, z: p.z, yaw: yawOf(p.tx, p.tz), width: 2 * p.halfWidth + GATE_EXTRA_WIDTH,
        s: route.closed ? wrap(route, S) : S, visual
    };
}

// The nearest allowed station to S within [lo, hi] (relative offsets from
// the lap start), searching forward first; null if there is none
function nearestAllowed(route: ResolvedRoute, S: number, lo: number, hi: number): number | null {
    for (let d = 0; d <= hi - lo; d += ROUTE_SPACING) {
        if (S + d <= hi && gateAllowed(route, S + d)) return S + d;
        if (S - d >= lo && d > 0 && gateAllowed(route, S - d)) return S - d;
    }
    return null;
}

// 13.2, step 3. Stations are handled relative to the start (0 .. span).
function placeGates(route: ResolvedRoute): RouteGate[] {
    const start = route.startS;
    const span = route.finishS - start;
    const rel: number[] = [];
    // After every junction where the route could turn
    const passes = route.junctions
        .filter(pass => pass.others.length > 0)
        .map(pass => forward(route, start, pass.exitS))
        .filter(d => d > 0 && d < span)
        .sort((a, b) => a - b);
    for (const exit of passes) {
        const next = passes.find(d => d > exit) ?? span;
        const S = nearestAllowed(route, start + exit + GATE_AFTER_JUNCTION, start + exit, start + Math.max(exit, next - GATE_BEFORE_JUNCTION));
        if (S !== null) rel.push(S - start);
    }
    // Drop gates too close to the start, the finish or an earlier gate
    const kept: number[] = [];
    for (const d of rel.sort((a, b) => a - b)) {
        const prev = kept.length ? kept[kept.length - 1] : 0;
        if (d - prev >= GATE_MIN_GAP && span - d >= GATE_MIN_GAP) kept.push(d);
    }
    // Fill gaps longer than gateSpacing
    const marks = [0, ...kept, span];
    const filled: number[] = [];
    for (let i = 0; i + 1 < marks.length; i++) {
        const a = marks[i], b = marks[i + 1];
        const extra = Math.ceil((b - a) / route.track.gateSpacing) - 1;
        for (let k = 1; k <= extra; k++) {
            const target = a + (b - a) * k / (extra + 1);
            const S = nearestAllowed(route, start + target, start + a + GATE_MIN_GAP, start + b - GATE_MIN_GAP);
            if (S !== null) filled.push(S - start);
        }
    }
    const all = [...kept, ...filled].sort((a, b) => a - b);
    const gates: RouteGate[] = [gateAt(route, start, route.closed ? 'startFinish' : 'start')];
    for (const d of all) gates.push(gateAt(route, start + d, 'arch'));
    if (!route.closed) gates.push(gateAt(route, route.finishS, 'finish'));
    return gates;
}

// 13.2, step 4: GRID_SLOTS slots behind the start, the pole on the right
// lane, then alternating, each on its lane centre (±width / 4)
function startingGrid(route: ResolvedRoute, errors: string[]): RouteGridSlot[] {
    const grid: RouteGridSlot[] = [];
    for (let k = 0; k < GRID_SLOTS; k++) {
        const S = route.startS - GRID_FIRST - GRID_STEP * k;
        if (!route.closed && S < 0) {
            errors.push(`grid slot ${k + 1} needs ${(-S).toFixed(0)} m more route before the start`);
            continue;
        }
        const pass = junctionAt(route, S);
        if (pass) errors.push(`grid slot ${k + 1} lies in junction ${pass.node.id}`);
        const p = routePointAt(route, S);
        const lateral = (k % 2 === 0 ? -1 : 1) * p.halfWidth / 2;
        const [nx, nz] = leftNormal(p.tx, p.tz);
        grid.push({ x: p.x + nx * lateral, z: p.z + nz * lateral, yaw: yawOf(p.tx, p.tz), s: wrap(route, S), lateral });
    }
    return grid;
}
