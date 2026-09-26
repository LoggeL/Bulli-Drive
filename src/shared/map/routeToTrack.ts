// routeToTrack (docs/phase-3-design.md, 13.2, steps 5 and 6): a resolved
// route (trackRoute.ts) as a TrackDef of the race mode (shared/race/types.ts),
// with barriers across the branches the route does not take, chevron boards
// outside the sharp bends, arrows before them and the route's ramps.
//
// Everything here goes into trackHash, which client and server compare, so
// it is computed with exactly rounded operations and rounded to whole
// millimetres (positions) and micro-radians (yaws, trackRoute.ts).

import { BARRIER_DEPTH } from '../race/raceWorld.js';
import type { GateDef, GridSlot, TrackDef, TrackHint, TrackRamp, Vec2 } from '../race/types.js';
import type { TrackRoute } from './mapFiles.js';
import { toMillimetres } from './rails.js';
import { junctionRadius, type RoadNetwork } from './roadNetwork.js';
import { leftNormal, pointAt } from './spline.js';
import { ROUTE_SPACING, routePointAt, yawOf, type ResolvedRoute, type RoutePoint } from './trackRoute.js';

// A TrackDef of a curated map. The ID is a string until the tracks join
// TRACK_IDS with the switch to the map (M5); the ramps belong to the race
// world (phase 2 adds its ramps from the map, 5.5).
export type MapTrackDef = Omit<TrackDef, 'id'> & { id: string; bonus: boolean };

// Yaws within this of an axis snap onto it: the phase 2 sim builds barrier
// rows and ramp walls as axis-aligned boxes only (trackColliders,
// rampEdgeColliders). Larger angles stay and need the obox collider (M3).
export const AXIS_SNAP = Math.PI / 180;
// Ramps may turn a little further against their road to reach an axis: 3°
// over a 10 m ramp shift its front corners by half a metre
export const RAMP_AXIS_SNAP = 3 * Math.PI / 180;
// Chevron boards: outside every bend sharper than the track's
// chevronCurvature that turns at least CHEVRON_MIN_TURN, this far beyond
// the road edge; in a junction straight on, this far past the trim radius
export const DEFAULT_CHEVRON_CURVATURE = 0.03;
export const CHEVRON_MIN_TURN = Math.PI / 6;
export const CHEVRON_EDGE_OFFSET = 2.5;
export const CHEVRON_JUNCTION_OFFSET = 3;
// A turn arrow this far before the bend
export const ARROW_BEFORE = 30;
// The minimap frame beyond the centre line
export const MINIMAP_MARGIN = 40;
// Ramp width when the track does not set one: the road less a metre each side, at most 8 m
export const MAX_DEFAULT_RAMP_WIDTH = 8;

const HALF_PI = Math.PI / 2;
const AXES = [-Math.PI, -HALF_PI, 0, HALF_PI, Math.PI];

// The yaw on the nearest axis if it is within `tolerance` of one (exact
// multiples of π/2, as the phase 2 checks want them), else unchanged
export function snapYaw(yaw: number, tolerance: number): number {
    for (const axis of AXES) if (Math.abs(yaw - axis) <= tolerance) return axis === -Math.PI ? Math.PI : axis;
    return yaw;
}

export function isAxisYaw(yaw: number): boolean {
    const quarter = yaw / HALF_PI;
    return Math.abs(quarter - Math.round(quarter)) <= 1e-9;
}

// Barrier rows (BARRIER_DEPTH deep, raceWorld.ts) keep its faces this far
// off the route's roadway; where the branch leaves at an acute angle, the
// row at the trim radius would reach into the route's roadway (on the
// inside of the turn), so it moves into the branch in steps until it is
// clear, at most BARRIER_MAX_PUSH beyond the trim radius.
export const BARRIER_ROUTE_CLEARANCE = 0.5;
export const BARRIER_PUSH_STEP = 0.5;
export const BARRIER_MAX_PUSH = 30;
// Probes along a row (m)
const BARRIER_PROBE_STEP = 0.25;

interface RouteSegment { ax: number; az: number; bx: number; bz: number; reach2: number }

// The route's centre line segments near (x, z), each with the squared
// distance within which a point lies on its roadway (plus the clearance)
function routeSegmentsNear(route: ResolvedRoute, x: number, z: number, radius: number): RouteSegment[] {
    const pts = route.points;
    const out: RouteSegment[] = [];
    const count = route.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < count; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        if (Math.min(Math.abs(a.x - x), Math.abs(b.x - x)) > radius || Math.min(Math.abs(a.z - z), Math.abs(b.z - z)) > radius) continue;
        const reach = Math.max(a.halfWidth, b.halfWidth) + BARRIER_ROUTE_CLEARANCE;
        out.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, reach2: reach * reach });
    }
    return out;
}

function onRoute(segments: readonly RouteSegment[], x: number, z: number): boolean {
    for (const seg of segments) {
        const ex = seg.bx - seg.ax, ez = seg.bz - seg.az;
        const len2 = ex * ex + ez * ez;
        let t = len2 > 0 ? ((x - seg.ax) * ex + (z - seg.az) * ez) / len2 : 0;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const dx = x - (seg.ax + t * ex), dz = z - (seg.az + t * ez);
        if (dx * dx + dz * dz < seg.reach2) return true;
    }
    return false;
}

// Whether a row centred at (x, z), across the direction (fx, fz), `length`
// long, keeps both faces off the route's roadway
function rowClear(segments: readonly RouteSegment[], x: number, z: number, fx: number, fz: number, length: number): boolean {
    const n = Math.ceil(length / BARRIER_PROBE_STEP);
    const half = BARRIER_DEPTH / 2;
    for (let k = 0; k <= n; k++) {
        const t = -length / 2 + length * k / n;
        // Along the row: the left axis (-fz, fx)
        const px = x - fz * t, pz = z + fx * t;
        if (onRoute(segments, px + fx * half, pz + fz * half) || onRoute(segments, px - fx * half, pz - fz * half)) return false;
    }
    return true;
}

// Barrier rows across every branch of a passed junction the route does not
// use, spanning the branch's road, sidewalks and verges: at the branch's
// trimmed end, or deeper in the branch where the row would stand on the
// route's roadway there
export function junctionBarriers(net: RoadNetwork, route: ResolvedRoute): TrackHint[] {
    const out: TrackHint[] = [];
    for (const pass of route.junctions) {
        const trim = junctionRadius(net, pass.node);
        for (const end of pass.others) {
            const edge = net.edges[end.edge];
            const profile = edge.profile;
            const length = profile.width + profile.sidewalk.left + profile.sidewalk.right + 2 * profile.shoulder;
            const segments = routeSegmentsNear(route, pass.node.x, pass.node.z, trim + BARRIER_MAX_PUSH + length);
            const sign = end.atStart ? 1 : -1;
            const deepest = Math.min(trim + BARRIER_MAX_PUSH, edge.length / 2);
            let at = trim;
            let p = pointAt(edge.samples, end.atStart ? at : edge.length - at);
            while (!rowClear(segments, p.x, p.z, p.tx * sign, p.tz * sign, length) && at + BARRIER_PUSH_STEP <= deepest) {
                at += BARRIER_PUSH_STEP;
                p = pointAt(edge.samples, end.atStart ? at : edge.length - at);
            }
            out.push({
                kind: 'barrier',
                x: toMillimetres(p.x), z: toMillimetres(p.z),
                // Into the branch; the row runs across it (phase 2: along the left axis)
                yaw: snapYaw(yawOf(p.tx * sign, p.tz * sign), AXIS_SNAP),
                length
            });
        }
    }
    return out;
}

export interface Bend {
    // Route stations where the curvature first and last exceeds the limit
    from: number;
    to: number;
    // Station of the sharpest point
    apex: number;
    // Signed turn over the bend (rad), positive to the left
    turn: number;
    // Inside a junction transition
    junction: boolean;
}

// Stretches of the route sharper than `curvature` and bending one way,
// with their total turn (the integral of the curvature over the bend)
export function routeBends(route: ResolvedRoute, curvature: number): Bend[] {
    const pts = route.points;
    const n = pts.length;
    const sharp = (p: RoutePoint) => Math.abs(p.curvature) > curvature;
    // A circuit may start inside a bend: begin the scan at a straight point
    let first = 0;
    if (route.closed) {
        while (first < n && sharp(pts[first])) first++;
        if (first === n) return [];
    }
    const bends: Bend[] = [];
    let current: Bend | null = null;
    let apexCurvature = 0;
    for (let i = 0; i < n; i++) {
        const k = (first + i) % n;
        const p = pts[k];
        // Length this point stands for: up to the next point
        const ds = k + 1 < n ? pts[k + 1].s - p.s : route.closed ? route.length - p.s : 0;
        if (current && (!sharp(p) || Math.sign(p.curvature) !== Math.sign(current.turn))) {
            bends.push(current);
            current = null;
        }
        if (!sharp(p)) continue;
        if (!current) {
            current = { from: p.s, to: p.s, apex: p.s, turn: 0, junction: false };
            apexCurvature = 0;
        }
        current.to = p.s;
        current.turn += p.curvature * ds;
        if (Math.abs(p.curvature) > apexCurvature) { apexCurvature = Math.abs(p.curvature); current.apex = p.s; }
        if (p.part < 0) current.junction = true;
    }
    if (current) bends.push(current);
    return bends;
}

function chevronsAndArrows(net: RoadNetwork, route: ResolvedRoute, track: TrackRoute): TrackHint[] {
    const out: TrackHint[] = [];
    const bends = routeBends(route, track.chevronCurvature ?? DEFAULT_CHEVRON_CURVATURE)
        .filter(bend => Math.abs(bend.turn) >= CHEVRON_MIN_TURN);
    for (const bend of bends) {
        const dir: 'left' | 'right' = bend.turn > 0 ? 'left' : 'right';
        // Directions into and out of the bend, one point beyond its sharp part
        const entryS = bend.from - ROUTE_SPACING;
        const entry = routePointAt(route, entryS);
        const exit = routePointAt(route, bend.to + ROUTE_SPACING);
        // Facing the approaching car
        const yaw = yawOf(-entry.tx, -entry.tz);
        let x: number, z: number;
        const pass = bend.junction ? route.junctions.find(j => near(route, bend.apex, j.entryS, j.exitS)) : undefined;
        if (pass) {
            // Straight on past the junction, in the mouth of the branch (or
            // the verge) behind its barrier
            const reach = junctionRadius(net, pass.node) + CHEVRON_JUNCTION_OFFSET;
            x = pass.node.x + entry.tx * reach;
            z = pass.node.z + entry.tz * reach;
        } else {
            const apex = routePointAt(route, bend.apex);
            // Outside the bend: away from the left normal in a left bend
            const [nx, nz] = leftNormal(apex.tx, apex.tz);
            const out2 = (bend.turn > 0 ? -1 : 1) * (apex.halfWidth + CHEVRON_EDGE_OFFSET);
            x = apex.x + nx * out2;
            z = apex.z + nz * out2;
        }
        out.push({ kind: 'chevron', x: toMillimetres(x), z: toMillimetres(z), yaw, dir });
        const S = entryS - ARROW_BEFORE;
        if (route.closed || S >= route.startS) {
            const at = routePointAt(route, S);
            out.push({ kind: 'arrow', x: toMillimetres(at.x), z: toMillimetres(at.z), yaw: yawOf(exit.tx, exit.tz) });
        }
    }
    return out;
}

// Station S lies within [a, b] (both ends included, wrapping on a circuit)
function near(route: ResolvedRoute, S: number, a: number, b: number): boolean {
    if (!route.closed || a <= b) return S >= a && S <= b;
    return S >= a || S <= b;
}

// The ramps of the track: centred at their station, facing the driving
// direction (snapped onto an axis within RAMP_AXIS_SNAP)
export function routeRamps(route: ResolvedRoute, track: TrackRoute): TrackRamp[] {
    return (track.ramps ?? []).flatMap(ramp => {
        const part = route.parts.find(p => p.edge.id === ramp.edge);
        if (!part) return [];
        const p = pointAt(part.edge.samples, ramp.s);
        const sign = part.reversed ? -1 : 1;
        return [{
            x: toMillimetres(p.x), z: toMillimetres(p.z),
            yaw: snapYaw(yawOf(p.tx * sign, p.tz * sign), RAMP_AXIS_SNAP),
            width: ramp.width ?? Math.min(MAX_DEFAULT_RAMP_WIDTH, part.edge.profile.width - 2),
            length: ramp.length,
            height: ramp.height,
            ...(ramp.look ? { look: ramp.look } : {})
        }];
    });
}

// A circuit's centre line begins at the last point at or before the
// start/finish gate, as in phase 2 (the Downtown Loop's first vertex is its
// start): the race code measures the gates along the line from its origin
// and expects them in order, the start/finish first (progress.ts,
// createCourse). A route begins at its first edge, wherever the start lies.
// A sprint keeps its points (they run from the first edge to the finish).
export function circuitFromStart(route: ResolvedRoute): readonly RoutePoint[] {
    const pts = route.points;
    if (!route.closed) return pts;
    let first = 0;
    while (first + 1 < pts.length && pts[first + 1].s <= route.startS) first++;
    return [...pts.slice(first), ...pts.slice(0, first)];
}

// 13.2, step 6: the TrackDef. The centre line is dense (every 2 m) and
// already rounded through the junctions (transitionCurve), so the racing
// line takes it as it is: lineOptions { radius: 0, apexShift: 0 } (the
// phase 2 rounding only acts on the corners of a sparse polyline, at most
// half a leg long).
export function routeToTrack(net: RoadNetwork, route: ResolvedRoute, mapVersion: number): MapTrackDef {
    const track = route.track;
    const centerline: Vec2[] = circuitFromStart(route).map(p => ({ x: toMillimetres(p.x), z: toMillimetres(p.z) }));
    const gates: GateDef[] = route.gates.map(g => ({
        x: toMillimetres(g.x), z: toMillimetres(g.z), yaw: g.yaw, width: g.width, visual: g.visual
    }));
    const grid: GridSlot[] = route.grid.map(slot => ({ x: toMillimetres(slot.x), z: toMillimetres(slot.z), yaw: slot.yaw }));
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of centerline) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
    }
    return {
        id: track.id,
        name: track.name,
        kind: track.kind,
        laps: track.laps,
        mapVersion,
        trackVersion: track.trackVersion,
        centerline,
        lineOptions: { radius: 0, apexShift: 0 },
        gates,
        grid,
        hints: [...junctionBarriers(net, route), ...chevronsAndArrows(net, route, track)],
        minimap: {
            minX: minX - MINIMAP_MARGIN, maxX: maxX + MINIMAP_MARGIN,
            minZ: minZ - MINIMAP_MARGIN, maxZ: maxZ + MINIMAP_MARGIN
        },
        ramps: routeRamps(route, track),
        bonus: track.bonus ?? false
    };
}
