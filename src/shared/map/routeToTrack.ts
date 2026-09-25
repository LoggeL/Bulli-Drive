// routeToTrack (docs/phase-3-design.md, 13.2, steps 5 and 6): a resolved
// route (trackRoute.ts) as a TrackDef of the race mode (shared/race/types.ts),
// with barriers across the branches the route does not take, chevron boards
// outside the sharp bends, arrows before them and the route's ramps.
//
// Everything here goes into trackHash, which client and server compare, so
// it is computed with exactly rounded operations and rounded to whole
// millimetres (positions) and micro-radians (yaws, trackRoute.ts).

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

// Barrier rows across every branch of a passed junction the route does not
// use, at the branch's trimmed end, spanning its road, sidewalks and verges
export function junctionBarriers(net: RoadNetwork, route: ResolvedRoute): TrackHint[] {
    const out: TrackHint[] = [];
    for (const pass of route.junctions) {
        const trim = junctionRadius(net, pass.node);
        for (const end of pass.others) {
            const edge = net.edges[end.edge];
            const p = pointAt(edge.samples, end.atStart ? trim : edge.length - trim);
            const sign = end.atStart ? 1 : -1;
            const profile = edge.profile;
            out.push({
                kind: 'barrier',
                x: toMillimetres(p.x), z: toMillimetres(p.z),
                // Into the branch; the row runs across it (phase 2: along the left axis)
                yaw: snapYaw(yawOf(p.tx * sign, p.tz * sign), AXIS_SNAP),
                length: profile.width + profile.sidewalk.left + profile.sidewalk.right + 2 * profile.shoulder
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

// 13.2, step 6: the TrackDef. The centre line is dense (every 2 m) and
// already rounded through the junctions (transitionCurve), so the racing
// line takes it as it is: lineOptions { radius: 0, apexShift: 0 } (the
// phase 2 rounding only acts on the corners of a sparse polyline, at most
// half a leg long).
export function routeToTrack(net: RoadNetwork, route: ResolvedRoute, mapVersion: number): MapTrackDef {
    const track = route.track;
    const centerline: Vec2[] = route.points.map(p => ({ x: toMillimetres(p.x), z: toMillimetres(p.z) }));
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
