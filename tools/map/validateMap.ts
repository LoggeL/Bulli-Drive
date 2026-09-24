// Validation of a curated map (docs/phase-3-design.md, 15, "Datentests auf
// der echten Karte", and deviation A14): the checks a JSON schema cannot
// express, over the road network, the baked heightfield, the POIs and the
// tracks. Pure (no file access); tools/map/validate.ts is the command line
// and tests/tools/map/bulliBay.test.ts runs it on the real map.
//
// Every check returns findings with the object it concerns and, where it
// makes sense, a position. "error" findings fail the data test; "warning"
// findings are printed for the author.

import {
    CORNER_GRIP_MARGIN, DEFAULT_DESIGN_SPEED, driveAcceleration, KMH_PER_MS, speedProfile,
    weakestCornerSpeed, type ProfilePoint
} from '../../src/shared/map/drivability.js';
import { pointInPolygon, polygonEdgeDistance, segmentDistanceSq, type Vec2 } from '../../src/shared/map/geometry.js';
import { flatHalfWidths } from '../../src/shared/map/corridor.js';
import { heightAt, waterDepth, type Heightfield } from '../../src/shared/map/heightfield.js';
import type { MapFile, PoisFile, TracksFile, ZonesFile } from '../../src/shared/map/mapFiles.js';
import {
    junctionRadius, roadSurfaceAt, type RoadEdgeData, type RoadNetwork
} from '../../src/shared/map/roadNetwork.js';
import { leftNormal, pointAt } from '../../src/shared/map/spline.js';
import { resolveRoute, type ResolvedRoute } from '../../src/shared/map/trackRoute.js';
import { SURFACE } from '../../src/shared/map/types.js';
import { CAR_CLASS_IDS, VEHICLE_CLASSES } from '../../src/shared/sim/vehicleClasses.js';

export type Severity = 'error' | 'warning';

export interface Finding {
    check: string;
    severity: Severity;
    message: string;
    x?: number;
    z?: number;
}

export interface MapBundle {
    net: RoadNetwork;
    map: MapFile;
    zones: ZonesFile;
    pois: PoisFile;
    tracks: TracksFile;
    hf: Heightfield;
}

// ---- Limits (start values, docs/phase-3-design.md 3.4, 5.5, 6.4, 12) ----

// Free space between the drivable surfaces of two roads that do not meet
export const ROAD_CLEARANCE = 1;
// Steepest maxGrade per surface: paved roads 12 % (the Ridge Road), gravel
// and dirt 18 %, sand 20 % (dune tracks), the pier's wood 8 %
export const MAX_GRADE_BY_SURFACE: Record<string, number> = {
    asphalt: 0.12, concrete: 0.12, wood: 0.08, gravel: 0.18, dirt: 0.18, sand: 0.2
};
// The baked grade may exceed maxGrade by this: 1 cm of quantisation per
// metre plus the bilinear surface in the tightest hairpins (A11)
export const GRADE_TOLERANCE = 0.01;
// Guard-rail duty (5.5): a drop of more than RAIL_DROP within RAIL_PROBE
// beyond the edge of the flat zone needs a rail or a wall on that side. The
// bake keeps the ground level for at least FLAT_MARGIN beyond the road edge,
// so the drop is measured from there (deviation A16): with embankments of
// 1 : 1.5 every fill higher than 2 m, a cliff or a quay edge counts.
export const RAIL_PROBE = 4;
export const RAIL_DROP = 2;
// Stretches of a required rail shorter than this are ignored (the flat
// zone of a crossing road ends there)
export const RAIL_MIN_STRETCH = 6;
// Half width of the widest car (pickup: collider radius 1.4 m)
export const CAR_HALF_WIDTH = 1.4;
// Spawn slots at least this far apart (a car length and a bit)
export const SPAWN_SPACING = 6;
// Party spawns this far inside the arena's outline, looking to its middle
// within PARTY_YAW_TOLERANCE
export const PARTY_RIM_CLEARANCE = 3;
export const PARTY_YAW_TOLERANCE = Math.PI / 4;
// Design counts (3.5, 12)
export const FREE_ROAM_GROUPS = 4;
export const FREE_ROAM_SLOTS_PER_GROUP = 4;
export const PARTY_SPAWNS = 16;
export const ARENA_COINS = 30;
export const ARENA_POWERUPS = 25;
export const ARENA_CONTAINERS = 12;
export const CONTAINER_LENGTH = 12.2;
export const CONTAINER_WIDTH = 2.44;
// Items keep this distance from containers and ramps (reachable)
export const ITEM_CLEARANCE = 2;

function finding(check: string, message: string, at?: { x: number; z: number }, severity: Severity = 'error'): Finding {
    return at ? { check, severity, message, x: round(at.x), z: round(at.z) } : { check, severity, message };
}

function round(v: number): number {
    return Math.round(v * 10) / 10;
}

function sampleAt(edge: RoadEdgeData, s: number) {
    return pointAt(edge.samples, s);
}

// ---- Network ----

// One connected network: every edge reachable from every other, areas
// either connected through their nodes or touching a road
export function checkConnectivity(net: RoadNetwork): Finding[] {
    const findings: Finding[] = [];
    const parent = net.nodes.map((_, i) => i);
    const find = (i: number): number => {
        while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
        return i;
    };
    const union = (a: number, b: number) => { parent[find(a)] = find(b); };
    for (const edge of net.edges) union(edge.from, edge.to);
    for (const area of net.areas) {
        const ids = area.connects.map(id => net.nodeById.get(id)!.index);
        for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);
    }
    const sizes = new Map<number, number>();
    for (const edge of net.edges) sizes.set(find(edge.from), (sizes.get(find(edge.from)) ?? 0) + edge.length);
    let main = -1;
    for (const [root, size] of sizes) if (main < 0 || size > sizes.get(main)!) main = root;
    const others = new Map<number, string[]>();
    for (const edge of net.edges) {
        const root = find(edge.from);
        if (root !== main) others.set(root, [...(others.get(root) ?? []), edge.id]);
    }
    for (const ids of others.values()) {
        findings.push(finding('connectivity', `edges ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ', …' : ''} are not connected to the network`));
    }
    for (const area of net.areas) {
        if (area.connects.length) {
            if (main >= 0 && find(net.nodeById.get(area.connects[0])!.index) !== main) {
                findings.push(finding('connectivity', `area ${area.id} connects to a separate part of the network`));
            }
            continue;
        }
        // A pedestrian plaza (paved, 'plazaPavers') is not part of the
        // driving network: it lies inside a block behind the sidewalks
        if (area.markings === 'plazaPavers') continue;
        // Without connects the area must touch a road or its sidewalk: some
        // sample within the road's half width plus sidewalk (and 1 m) of the
        // outline or inside
        let touches = false;
        for (const edge of net.edges) {
            const reach = edge.halfWidth + Math.max(edge.profile.sidewalk.left, edge.profile.sidewalk.right) + 1;
            for (const p of edge.samples) {
                if (pointInPolygon(area.polygon, p.x, p.z) || polygonEdgeDistance(area.polygon, p.x, p.z) <= reach) {
                    touches = true;
                    break;
                }
            }
            if (touches) break;
        }
        if (!touches) findings.push(finding('connectivity', `area ${area.id} neither connects to a node nor touches a road`, { x: area.polygon[0][0], z: area.polygon[0][1] }));
    }
    for (const issue of net.issues) findings.push(finding('connectivity', issue));
    return findings;
}

// Distance between the segments a-b and c-d
export function segmentSegmentDistance(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
    if (segmentsIntersect(a, b, c, d)) return 0;
    return Math.sqrt(Math.min(
        segmentDistanceSq(a[0], a[1], c[0], c[1], d[0], d[1]),
        segmentDistanceSq(b[0], b[1], c[0], c[1], d[0], d[1]),
        segmentDistanceSq(c[0], c[1], a[0], a[1], b[0], b[1]),
        segmentDistanceSq(d[0], d[1], a[0], a[1], b[0], b[1])
    ));
}

function cross(o: Vec2, a: Vec2, b: Vec2): number {
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

// Proper or touching intersection of two segments
export function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
    const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
    const on = (p: Vec2, q: Vec2, r: Vec2) => Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0])
        && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
    return (d1 === 0 && on(c, d, a)) || (d2 === 0 && on(c, d, b)) || (d3 === 0 && on(a, b, c)) || (d4 === 0 && on(a, b, d));
}

// Arc length along which a road may bend back towards itself before its
// surfaces meet: half a circle around the gap
function bendAllowance(gap: number): number {
    return gap * Math.PI / 2 * 1.05;
}

// No two roads cross or touch except where they meet in a junction, and no
// road overlaps itself (design E9: no bridges, every crossing is a junction)
export function checkCrossings(net: RoadNetwork, clearance = ROAD_CLEARANCE): Finding[] {
    const findings: Finding[] = [];
    const reported = new Set<string>();
    const index = net.index;
    const reach = 2 * net.maxHalfWidth + clearance + 2;
    for (const a of net.edges) {
        for (let k = 0; k + 1 < a.samples.length; k++) {
            const p = a.samples[k], q = a.samples[k + 1];
            const x0 = index.cellX(Math.min(p.x, q.x) - reach), x1 = index.cellX(Math.max(p.x, q.x) + reach);
            const z0 = index.cellZ(Math.min(p.z, q.z) - reach), z1 = index.cellZ(Math.max(p.z, q.z) + reach);
            for (let cz = z0; cz <= z1; cz++) {
                for (let cx = x0; cx <= x1; cx++) {
                    const cell = cz * index.cols + cx;
                    for (let slot = index.cellStart[cell]; slot < index.cellStart[cell + 1]; slot++) {
                        const b = net.edges[index.edgeOf[slot]];
                        const j = index.sampleOf[slot];
                        if (j + 1 >= b.samples.length || b.index < a.index || (b === a && j <= k)) continue;
                        const key = `${a.id}|${b.id}`;
                        if (reported.has(key)) continue;
                        const gap = a.halfWidth + b.halfWidth + clearance;
                        const r = b.samples[j], t = b.samples[j + 1];
                        const d = segmentSegmentDistance([p.x, p.z], [q.x, q.z], [r.x, r.z], [t.x, t.z]);
                        if (d >= gap) continue;
                        if (b === a) {
                            if (Math.abs(r.s - p.s) < bendAllowance(gap)) continue;
                        } else if (sharedNodeExempt(net, a, k, b, j, gap)) {
                            continue;
                        }
                        reported.add(key);
                        const what = a === b ? `edge ${a.id} overlaps itself` : `edges ${a.id} and ${b.id} overlap`;
                        findings.push(finding('crossings', `${what} without a junction (${d.toFixed(1)} m apart, need ${gap.toFixed(1)} m)`, p));
                    }
                }
            }
        }
    }
    return findings;
}

// Near a shared node two roads may touch: within a junction's trim radius
// (plus the other road's half width) of the node, or at a joint within the
// arc length a single bending road would need
function sharedNodeExempt(net: RoadNetwork, a: RoadEdgeData, k: number, b: RoadEdgeData, j: number, gap: number): boolean {
    for (const nodeIndex of [a.from, a.to]) {
        if (nodeIndex !== b.from && nodeIndex !== b.to) continue;
        const node = net.nodes[nodeIndex];
        const da = nodeIndex === a.from ? a.samples[k].s : a.length - a.samples[k + 1].s;
        const db = nodeIndex === b.from ? b.samples[j].s : b.length - b.samples[j + 1].s;
        if (node.def.kind === 'joint') {
            if (da + db < bendAllowance(gap)) return true;
        } else {
            const radius = junctionRadius(net, node) + Math.max(a.halfWidth, b.halfWidth);
            const pa = a.samples[nodeIndex === a.from ? k : k + 1], pb = b.samples[nodeIndex === b.from ? j : j + 1];
            if (Math.hypot(pa.x - node.x, pa.z - node.z) <= radius && Math.hypot(pb.x - node.x, pb.z - node.z) <= radius) return true;
        }
    }
    return false;
}

// Longitudinal grade: the limit fits the surface, the baked ground keeps
// the limit, and the weakest class still accelerates on the steepest step
export function checkGrades(net: RoadNetwork, hf: Heightfield): Finding[] {
    const findings: Finding[] = [];
    for (const edge of net.edges) {
        const surface = edge.profile.surface;
        const limit = edge.def.maxGrade ?? 0.08;
        if (limit > MAX_GRADE_BY_SURFACE[surface] + 1e-9) {
            findings.push(finding('grades', `edge ${edge.id}: maxGrade ${limit} is steeper than ${surface} allows (${MAX_GRADE_BY_SURFACE[surface]})`));
        }
        let worst = 0, at = edge.samples[0];
        for (let k = 1; k < edge.samples.length; k++) {
            const a = edge.samples[k - 1], b = edge.samples[k];
            const grade = Math.abs(heightAt(hf, b.x, b.z) - heightAt(hf, a.x, a.z)) / (b.s - a.s);
            if (grade > worst) { worst = grade; at = b; }
        }
        if (worst > limit + GRADE_TOLERANCE) {
            findings.push(finding('grades', `edge ${edge.id}: baked grade ${(worst * 100).toFixed(1)} % at s = ${at.s.toFixed(0)} exceeds ${(limit * 100).toFixed(0)} %`, at));
        }
        const id = SURFACE[surface];
        for (const cls of CAR_CLASS_IDS) {
            if (driveAcceleration(VEHICLE_CLASSES[cls], 10, id, worst) <= 0) {
                findings.push(finding('grades', `edge ${edge.id}: ${cls} cannot climb ${(worst * 100).toFixed(1)} % on ${surface}`, at));
                break;
            }
        }
    }
    return findings;
}

// Every bend of a road allows its design speed for the weakest class, and
// no bend is so tight that the inner road edge folds over
export function checkCurves(net: RoadNetwork): Finding[] {
    const findings: Finding[] = [];
    for (const edge of net.edges) {
        const kmh = edge.profile.designSpeed ?? DEFAULT_DESIGN_SPEED;
        const surface = SURFACE[edge.profile.surface];
        let worst = { speed: Infinity, s: 0, k: 0 };
        for (const p of edge.samples) {
            const speed = weakestCornerSpeed(p.curvature, surface).speed * KMH_PER_MS;
            if (speed < worst.speed) worst = { speed, s: p.s, k: Math.abs(p.curvature) };
        }
        const at = sampleAt(edge, worst.s);
        if (worst.speed < kmh) {
            findings.push(finding('curves', `edge ${edge.id}: bend with R = ${(1 / worst.k).toFixed(1)} m at s = ${worst.s.toFixed(0)} allows ${worst.speed.toFixed(0)} km/h, design speed ${kmh} km/h`, at));
        }
        if (worst.k > 0 && 1 / worst.k < edge.halfWidth + 2) {
            findings.push(finding('curves', `edge ${edge.id}: radius ${(1 / worst.k).toFixed(1)} m at s = ${worst.s.toFixed(0)} is too tight for a ${edge.profile.width} m road`, at));
        }
    }
    return findings;
}

function inRanges(ranges: readonly { side: string; from: number; to: number }[], side: string, s: number, length: number): boolean {
    for (const range of ranges) {
        if (range.side !== side) continue;
        const to = range.to < 0 ? length : range.to;
        if (s >= range.from - 1 && s <= to + 1) return true;
    }
    return false;
}

// Guard-rail duty (5.5): where the ground drops more than RAIL_DROP within
// RAIL_PROBE beyond the flat zone, the edge needs a rail or a wall on that
// side (or the tag noRail). Crossing roads, areas and junctions are exempt.
export function checkRails(net: RoadNetwork, hf: Heightfield): Finding[] {
    const findings: Finding[] = [];
    for (const edge of net.edges) {
        if (edge.def.tags?.includes('noRail')) continue;
        const guards = [...(edge.def.rails ?? []), ...(edge.def.walls ?? [])];
        const flat = flatHalfWidths(edge.profile);
        const trimFrom = junctionRadius(net, net.nodes[edge.from]) + edge.halfWidth;
        const trimTo = edge.length - junctionRadius(net, net.nodes[edge.to]) - edge.halfWidth;
        for (const side of ['left', 'right'] as const) {
            let run: { from: number; to: number; drop: number; x: number; z: number } | null = null;
            const flush = () => {
                if (run && run.to - run.from >= RAIL_MIN_STRETCH) {
                    findings.push(finding('rails', `edge ${edge.id}, ${side} side, s ${run.from.toFixed(0)}–${run.to.toFixed(0)}: ground drops ${run.drop.toFixed(1)} m beside the road without a rail or wall`, run));
                }
                run = null;
            };
            for (let s = 0; s <= edge.length; s += 2) {
                const p = sampleAt(edge, s);
                const [nx, nz] = leftNormal(p.tx, p.tz);
                const sign = side === 'left' ? 1 : -1;
                const reach = side === 'left' ? flat.left : flat.right;
                const ex = p.x + sign * nx * reach, ez = p.z + sign * nz * reach;
                const ox = p.x + sign * nx * (reach + RAIL_PROBE), oz = p.z + sign * nz * (reach + RAIL_PROBE);
                const drop = heightAt(hf, ex, ez) - heightAt(hf, ox, oz);
                const exempt = s < trimFrom || s > trimTo || inRanges(guards, side, s, edge.length)
                    || roadSurfaceAt(net, ox, oz) !== null;
                if (drop > RAIL_DROP && !exempt) {
                    if (!run) run = { from: s, to: s, drop, x: ex, z: ez };
                    run.to = s;
                    run.drop = Math.max(run.drop, drop);
                } else {
                    flush();
                }
            }
            flush();
        }
    }
    return findings;
}

// Every road and area lies inside the drivable boundary of map.json
export function checkBoundary(net: RoadNetwork, map: MapFile): Finding[] {
    const findings: Finding[] = [];
    for (const edge of net.edges) {
        for (const p of edge.samples) {
            if (!pointInPolygon(map.boundary, p.x, p.z) || polygonEdgeDistance(map.boundary, p.x, p.z) < edge.halfWidth) {
                findings.push(finding('boundary', `edge ${edge.id} leaves the drivable boundary at s = ${p.s.toFixed(0)}`, p));
                break;
            }
        }
    }
    for (const area of net.areas) {
        for (const [x, z] of area.polygon) {
            if (!pointInPolygon(map.boundary, x, z)) {
                findings.push(finding('boundary', `area ${area.id} reaches beyond the drivable boundary`, { x, z }));
                break;
            }
        }
    }
    return findings;
}

// ---- Tracks ----

export interface TrackStats {
    id: string;
    length: number;
    gates: number;
    // Height gained and lost along the route (m)
    climb: number;
    descent: number;
    // Estimated race time (s) of the slowest and the fastest class, from a
    // standing start over all laps, with CORNER_GRIP_MARGIN of the grip
    slowest: { car: string; time: number };
    fastest: { car: string; time: number };
    minCornerSpeed: number;
}

// A route's centre line as profile points (lap repeated for circuits)
function profilePoints(route: ResolvedRoute, hf: Heightfield, laps: number): ProfilePoint[] {
    const points: ProfilePoint[] = [];
    const pts = route.points;
    for (let lap = 0; lap < laps; lap++) {
        for (const p of pts) {
            points.push({ s: lap * route.length + p.s, curvature: p.curvature, surface: p.surface, y: heightAt(hf, p.x, p.z) });
        }
    }
    if (route.closed) {
        const p = pts[0];
        points.push({ s: laps * route.length, curvature: p.curvature, surface: p.surface, y: heightAt(hf, p.x, p.z) });
    }
    return points;
}

// The route passes close to itself: two points further apart along the
// route than a bend allows are closer than two road widths, or the centre
// line crosses itself
function selfApproach(route: ResolvedRoute): { x: number; z: number; gap: number } | null {
    const pts = route.points;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
        const a = pts[i];
        for (let j = i + 2; j < n; j++) {
            const b = pts[j];
            let along = b.s - a.s;
            if (route.closed) along = Math.min(along, route.length - along);
            const gap = a.halfWidth + b.halfWidth + ROAD_CLEARANCE;
            if (along < bendAllowance(gap) + 2) continue;
            const d = Math.hypot(a.x - b.x, a.z - b.z);
            if (d < gap) return { x: a.x, z: a.z, gap: d };
        }
    }
    return null;
}

export function checkTrack(net: RoadNetwork, hf: Heightfield, track: TracksFile['tracks'][number]): { findings: Finding[]; stats: TrackStats | null; route: ResolvedRoute | null } {
    const check = 'tracks';
    const resolved = resolveRoute(net, track);
    if (!resolved.ok) return { findings: resolved.errors.map(e => finding(check, `track ${track.id}: ${e}`)), stats: null, route: null };
    const route = resolved.route;
    const findings: Finding[] = [];
    const near = selfApproach(route);
    if (near) findings.push(finding(check, `track ${track.id} passes within ${near.gap.toFixed(1)} m of itself`, near));

    // Corner speeds along the centre line (junction transitions included)
    let worst = { speed: Infinity, x: 0, z: 0, k: 0 };
    for (const p of route.points) {
        const speed = weakestCornerSpeed(p.curvature, p.surface).speed * KMH_PER_MS;
        if (speed < worst.speed) worst = { speed, x: p.x, z: p.z, k: Math.abs(p.curvature) };
    }
    if (worst.speed < track.minCornerSpeed) {
        findings.push(finding(check, `track ${track.id}: bend with R = ${(1 / worst.k).toFixed(1)} m allows ${worst.speed.toFixed(0)} km/h, minCornerSpeed ${track.minCornerSpeed}`, worst));
    }
    // Grid and gates on the road
    route.grid.forEach((slot, k) => {
        const p = route.points.reduce((best, q) => Math.hypot(q.x - slot.x, q.z - slot.z) < Math.hypot(best.x - slot.x, best.z - slot.z) ? q : best);
        if (roadSurfaceAt(net, slot.x, slot.z) === null || Math.abs(slot.lateral) + CAR_HALF_WIDTH > p.halfWidth) {
            findings.push(finding(check, `track ${track.id}: grid slot ${k + 1} is not on the road`, slot));
        }
    });
    for (const gate of route.gates) {
        if (roadSurfaceAt(net, gate.x, gate.z) === null) findings.push(finding(check, `track ${track.id}: ${gate.visual} gate is not on the road`, gate));
    }
    if (route.gates.length < (route.closed ? 3 : 2)) findings.push(finding(check, `track ${track.id}: only ${route.gates.length} gates`));
    for (const ramp of track.ramps ?? []) {
        const part = route.parts.find(p => p.edge.id === ramp.edge);
        const edge = net.edgeById.get(ramp.edge);
        if (!part || !edge) { findings.push(finding(check, `track ${track.id}: ramp on edge ${ramp.edge}, which is not on the route`)); continue; }
        const d = part.reversed ? edge.length - ramp.s : ramp.s;
        const at = sampleAt(edge, ramp.s);
        if (d - ramp.length / 2 < part.keepFrom || d + ramp.length / 2 > part.keepTo) {
            findings.push(finding(check, `track ${track.id}: ramp at s = ${ramp.s} on ${ramp.edge} reaches into a junction or beyond the edge`, at));
        }
        if ((ramp.width ?? edge.profile.width) > edge.profile.width) {
            findings.push(finding(check, `track ${track.id}: ramp at s = ${ramp.s} on ${ramp.edge} is wider than the road`, at));
        }
    }

    // Estimated times and the climb
    const points = profilePoints(route, hf, route.closed ? track.laps : 1);
    const from = route.closed ? 0 : points.findIndex(p => p.s >= route.startS);
    const to = route.closed ? points.length : points.findIndex(p => p.s >= route.finishS) + 1;
    const run = points.slice(Math.max(0, from), to > 0 ? to : points.length);
    let climb = 0, descent = 0;
    for (let i = 1; i < run.length; i++) {
        const dy = run[i].y! - run[i - 1].y!;
        if (dy > 0) climb += dy; else descent -= dy;
    }
    if (route.closed) { climb /= track.laps; descent /= track.laps; }
    let slowest = { car: '', time: -Infinity }, fastest = { car: '', time: Infinity };
    for (const id of CAR_CLASS_IDS) {
        const profile = speedProfile(VEHICLE_CLASSES[id], run, 0, CORNER_GRIP_MARGIN);
        if (profile.stall >= 0) {
            const p = run[profile.stall];
            findings.push(finding(check, `track ${track.id}: ${id} stalls on the climb at ${p.s.toFixed(0)} m`));
        }
        if (profile.time > slowest.time) slowest = { car: id, time: profile.time };
        if (profile.time < fastest.time) fastest = { car: id, time: profile.time };
    }
    return {
        findings,
        route,
        stats: {
            id: track.id,
            length: route.closed ? route.length : route.finishS - route.startS,
            gates: route.gates.length,
            climb, descent, slowest, fastest,
            minCornerSpeed: worst.speed
        }
    };
}

// ---- POIs ----

function arenaPolygon(net: RoadNetwork, pois: PoisFile): readonly Vec2[] | null {
    return net.areas.find(a => a.id === pois.arena.area)?.polygon ?? null;
}

// Corners of a box of length l (along yaw) and width w around (x, z)
export function boxCorners(x: number, z: number, yaw: number, l: number, w: number): Vec2[] {
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const lx = fz, lz = -fx;
    const corners: Vec2[] = [];
    for (const [a, b] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) {
        corners.push([x + fx * a * l / 2 + lx * b * w / 2, z + fz * a * l / 2 + lz * b * w / 2]);
    }
    return corners;
}

// Distance from (x, z) to a box of length l along yaw and width w (0 inside)
export function boxDistance(px: number, pz: number, x: number, z: number, yaw: number, l: number, w: number): number {
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const dx = px - x, dz = pz - z;
    const u = Math.abs(dx * fx + dz * fz) - l / 2;
    const v = Math.abs(dx * fz - dz * fx) - w / 2;
    return Math.hypot(Math.max(0, u), Math.max(0, v));
}

function angleDiff(a: number, b: number): number {
    const d = ((a - b) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
    return Math.abs(d);
}

export function checkPois(net: RoadNetwork, hf: Heightfield, map: MapFile, pois: PoisFile): Finding[] {
    const check = 'pois';
    const findings: Finding[] = [];
    // Free-roam spawns: on a road or area, dry, inside the boundary, apart
    const free = pois.spawns.freeRoam;
    const groups = new Map<string, number>();
    for (const slot of free) groups.set(slot.group, (groups.get(slot.group) ?? 0) + 1);
    if (groups.size < FREE_ROAM_GROUPS) findings.push(finding(check, `only ${groups.size} free-roam spawn groups, the design has ${FREE_ROAM_GROUPS}`));
    for (const [group, count] of groups) {
        if (count < FREE_ROAM_SLOTS_PER_GROUP) findings.push(finding(check, `spawn group ${group} has ${count} slots, the design has ${FREE_ROAM_SLOTS_PER_GROUP}`));
    }
    const spawnOk = (label: string, p: { x: number; z: number }) => {
        if (!pointInPolygon(map.boundary, p.x, p.z)) findings.push(finding(check, `${label} is outside the boundary`, p));
        if (roadSurfaceAt(net, p.x, p.z) === null) findings.push(finding(check, `${label} is not on a road or area`, p));
        if (waterDepth(hf, p.x, p.z) > -0.1) findings.push(finding(check, `${label} is in the water`, p));
    };
    free.forEach((slot, i) => spawnOk(`free-roam spawn ${i + 1} (${slot.group})`, slot));
    const tooClose = (list: readonly { x: number; z: number }[], label: string) => {
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                if (Math.hypot(list[i].x - list[j].x, list[i].z - list[j].z) < SPAWN_SPACING) {
                    findings.push(finding(check, `${label} ${i + 1} and ${j + 1} are closer than ${SPAWN_SPACING} m`, list[i]));
                }
            }
        }
    };
    tooClose(free, 'free-roam spawns');

    // Party arena
    const arena = arenaPolygon(net, pois);
    if (!arena) {
        findings.push(finding(check, `arena area ${pois.arena.area} is not in roads.json`));
        return findings;
    }
    const inArena = (x: number, z: number, margin: number) => pointInPolygon(arena, x, z) && polygonEdgeDistance(arena, x, z) >= margin;
    let cx = 0, cz = 0;
    for (const [x, z] of arena) { cx += x; cz += z; }
    cx /= arena.length; cz /= arena.length;
    const party = pois.spawns.party;
    if (party.length !== PARTY_SPAWNS) findings.push(finding(check, `${party.length} party spawns, the design has ${PARTY_SPAWNS}`));
    party.forEach((pose, i) => {
        if (!inArena(pose.x, pose.z, PARTY_RIM_CLEARANCE)) findings.push(finding(check, `party spawn ${i + 1} is not inside the arena`, pose));
        if (angleDiff(pose.yaw, Math.atan2(cx - pose.x, cz - pose.z)) > PARTY_YAW_TOLERANCE) {
            findings.push(finding(check, `party spawn ${i + 1} does not face the arena's middle`, pose));
        }
    });
    tooClose(party, 'party spawns');
    const { containers, ramps, coins, powerups } = pois.arena;
    if (containers.length !== ARENA_CONTAINERS) findings.push(finding(check, `${containers.length} containers, the design has ${ARENA_CONTAINERS}`));
    containers.forEach((c, i) => {
        if (boxCorners(c.x, c.z, c.yaw, CONTAINER_LENGTH, CONTAINER_WIDTH).some(([x, z]) => !inArena(x, z, 1))) {
            findings.push(finding(check, `container ${i + 1} is not inside the arena`, c));
        }
    });
    ramps.forEach((r, i) => {
        if (boxCorners(r.x, r.z, r.yaw, r.length, r.width).some(([x, z]) => !inArena(x, z, 1))) {
            findings.push(finding(check, `arena ramp ${i + 1} is not inside the arena`, r));
        }
    });
    const blocked = (x: number, z: number) =>
        containers.some(c => boxDistance(x, z, c.x, c.z, c.yaw, CONTAINER_LENGTH, CONTAINER_WIDTH) < ITEM_CLEARANCE)
        || ramps.some(r => boxDistance(x, z, r.x, r.z, r.yaw, r.length, r.width) < ITEM_CLEARANCE);
    const items = (list: readonly (readonly [number, number])[], label: string, count: number) => {
        if (list.length !== count) findings.push(finding(check, `${list.length} ${label} points, the design has ${count}`));
        list.forEach(([x, z], i) => {
            if (!inArena(x, z, 1)) findings.push(finding(check, `${label} point ${i + 1} is not inside the arena`, { x, z }));
            else if (blocked(x, z)) findings.push(finding(check, `${label} point ${i + 1} is inside or next to a container or ramp`, { x, z }));
        });
    };
    items(coins, 'coin', ARENA_COINS);
    items(powerups, 'power-up', ARENA_POWERUPS);
    party.forEach((pose, i) => {
        if (blocked(pose.x, pose.z)) findings.push(finding(check, `party spawn ${i + 1} is inside or next to a container or ramp`, pose));
    });
    const gate = pois.arena.gate;
    if (polygonEdgeDistance(arena, gate.x, gate.z) > gate.width) {
        findings.push(finding(check, 'the arena gate is not on the arena\'s outline', gate));
    }

    // Landmarks on the map, on their area if they name one
    for (const mark of pois.landmarks) {
        if (!pointInPolygon(map.boundary, mark.x, mark.z)) findings.push(finding(check, `landmark ${mark.id} is outside the boundary`, mark));
        if (mark.area) {
            const area = net.areas.find(a => a.id === mark.area);
            if (!area) findings.push(finding(check, `landmark ${mark.id}: unknown area ${mark.area}`));
            else if (!pointInPolygon(area.polygon, mark.x, mark.z)) findings.push(finding(check, `landmark ${mark.id} is not on area ${mark.area}`, mark));
        }
    }
    return findings;
}

// Zone polygons lie within the heightfield and cover a non-empty area
export function checkZones(zones: ZonesFile, hf: Heightfield): Finding[] {
    const findings: Finding[] = [];
    const spec = hf.spec;
    const maxX = spec.originX + (spec.cols - 1) * spec.cellSize, maxZ = spec.originZ + (spec.rows - 1) * spec.cellSize;
    for (const zone of zones.zones) {
        let area = 0;
        const poly = zone.polygon;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) area += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
        if (Math.abs(area) < 1) findings.push(finding('zones', `zone ${zone.id} has no area`));
        if (poly.some(([x, z]) => x < spec.originX || x > maxX || z < spec.originZ || z > maxZ)) {
            findings.push(finding('zones', `zone ${zone.id} reaches beyond the heightfield`, { x: poly[0][0], z: poly[0][1] }, 'warning'));
        }
    }
    return findings;
}

export interface ValidationResult {
    findings: Finding[];
    tracks: TrackStats[];
    routes: ResolvedRoute[];
    roads: { km: number; pavedKm: number; bySurface: Record<string, number> };
}

export function validateMap(bundle: MapBundle): ValidationResult {
    const { net, hf } = bundle;
    const findings: Finding[] = [
        ...checkConnectivity(net),
        ...checkCrossings(net),
        ...checkGrades(net, hf),
        ...checkCurves(net),
        ...checkRails(net, hf),
        ...checkBoundary(net, bundle.map),
        ...checkPois(net, hf, bundle.map, bundle.pois),
        ...checkZones(bundle.zones, hf)
    ];
    const tracks: TrackStats[] = [];
    const routes: ResolvedRoute[] = [];
    for (const track of bundle.tracks.tracks) {
        const result = checkTrack(net, hf, track);
        findings.push(...result.findings);
        if (result.stats) tracks.push(result.stats);
        if (result.route) routes.push(result.route);
    }
    const bySurface: Record<string, number> = {};
    let km = 0, pavedKm = 0;
    for (const edge of net.edges) {
        const surface = edge.profile.surface;
        bySurface[surface] = (bySurface[surface] ?? 0) + edge.length / 1000;
        km += edge.length / 1000;
        if (surface === 'asphalt' || surface === 'concrete' || surface === 'wood') pavedKm += edge.length / 1000;
    }
    return { findings, tracks, routes, roads: { km, pavedKm, bySurface } };
}

