// How a bot drives (docs/phase-1b-design.md, 15.2; docs/phase-3-design.md,
// 14 M3): pure pursuit along a route. In Free Roam the route runs over the
// map's road network from junction to junction (straight on more often
// than a turn, back only out of a dead end), in the right-hand lane; in the
// Party it wanders from point to point across the arena. In the harbour
// yards round the arena (the rest of the Party's zone) no arena target has
// a clear way, and the freest way out leads along their roads and alleys. The bot steers
// towards a point 12 m + 0.4 s · v ahead, cruises at 20-35 m/s (the arena:
// 12-20) and slows for the bends ahead. Mode ram chases the nearest car
// instead for a few seconds (and gives up once it had to back off). In
// the arena a car turns round in three moves for a point behind it, and
// when every way is blocked takes the freest one out. A car that stops
// making progress backs off, and after a few tries holds the reset button
// (back onto the road).
// Pure: no socket, no clock; the Node tests drive it against the sim alone.
// Pure pursuit, the steer input and the stuck logic are shared with the
// race bots (src/shared/race/pursuit.ts).

import type { MapData } from '../../src/shared/map/mapData.js';
import { colliderBounds, type SimWorld } from '../../src/shared/world/colliders.js';
import type { RandomSource } from '../../src/shared/math/rng.js';
import { nearestRoad, type RoadEdgeData, type RoadNetwork } from '../../src/shared/map/roadNetwork.js';
import { isPaved, SURFACE, SURFACE_GRIP } from '../../src/shared/map/types.js';
import { forwardSpeed, pursuitSteer, STUCK_TICKS, StuckWatch, wrapAngle } from '../../src/shared/race/pursuit.js';
import type { VehicleInput, VehicleParams, VehicleState } from '../../src/shared/sim/types.js';

export { forwardSpeed, steerForAngle, wrapAngle } from '../../src/shared/race/pursuit.js';

export interface DriverOptions {
    // Cruise speed range (m/s); each route leg draws one
    cruiseMin: number;
    cruiseMax: number;
    // Lateral acceleration the bot allows itself in a bend (m/s²) and the
    // braking it plans with (m/s²)
    cornerAccel: number;
    cornerDecel: number;
    // Lowest speed through a bend (m/s)
    cornerMin: number;
    // Look-ahead distance: base + time · speed (m, s)
    lookaheadBase: number;
    lookaheadTime: number;
    // Share of junctions where the route goes straight on (when it can)
    straightBias: number;
}

export const DEFAULT_DRIVER_OPTIONS: DriverOptions = {
    cruiseMin: 20,
    cruiseMax: 35,
    cornerAccel: 7,
    cornerDecel: 7,
    cornerMin: 8,
    lookaheadBase: 12,
    lookaheadTime: 0.4,
    straightBias: 0.5
};

// In the arena
const ARENA_CRUISE_MIN = 12;
const ARENA_CRUISE_MAX = 20;
// On dirt, gravel and sand the bot cruises at most this fast (m/s), and
// plans its bends with the surface's grip (docs/phase-3-design.md, 8.1)
const UNPAVED_CRUISE = 18;
const OFFROAD_GRIP = 0.9;
// Arena targets keep this far from the fence; the way to the next one keeps
// this far from containers, masts and ramps (else another target is drawn,
// at most ARENA_TRIES times)
const ARENA_INSET = 15;
const ARENA_CLEARANCE = 3;
const ARENA_TRIES = 16;
// The next target lies 25-60 m ahead within ±60° of the way so far (the
// cone widens by 15° with every try that is blocked), so the bot drives on
// in wide curves instead of turning round at every target
const ARENA_REACH_MIN = 25;
const ARENA_REACH_MAX = 60;
const ARENA_CONE = Math.PI / 3;
// Directions tried for the way out when every target is blocked
const ESCAPE_WAYS = 24;
// In the arena a point behind the car (after a bump, a back-off, at the
// fence) is reached by a turn in three moves: slower than TURN_SPEED (m/s)
// and more than TURN_START off the nose, the car reverses with the wheel
// the other way (the nose swings round) until the point lies within
// TURN_DONE of it, for at most TURN_MAX_TICKS, then drives on. The next
// turn waits TURN_COOLDOWN_TICKS. A turn that does not get going (still
// slower than TURN_STALLED after TURN_STALL_TICKS: something behind the
// car) stops, and the next one waits longer than the stuck logic, which
// then backs off and resets as before.
const TURN_SPEED = 4;
const TURN_START = 1.75;
const TURN_DONE = 1.05;
const TURN_MAX_TICKS = 120;
const TURN_COOLDOWN_TICKS = 60;
const TURN_STALL_TICKS = 30;
const TURN_STALLED = 0.5;

// A car to chase (ram mode): position and velocity (m, m/s)
export interface ChaseTarget {
    x: number;
    z: number;
    vx: number;
    vz: number;
}

interface Point { x: number; z: number }
// A route point with the grip of its road (1 on asphalt)
interface RoutePoint extends Point { grip: number }
// An edge driven one way
interface Leg { edge: RoadEdgeData; reversed: boolean }

// Farther than this from the planned line, the route starts over, at most
// once per REPLAN_HOLD_TICKS (a car that slid far wide steers back first)
const OFF_ROUTE = 18;
const REPLAN_HOLD_TICKS = 60;
// Route kept ahead of the car (m) and the spacing of its points (m)
const ROUTE_AHEAD = 260;
const POINT_SPACING = 3;
// How far ahead the speed looks for bends (m)
const SPEED_HORIZON = 150;
// A chase ends after this long, or when the target is farther away
const CHASE_MAX_TICKS = 240;
const CHASE_LEAD_S = 0.3;

export class RoadDriver {
    private net: RoadNetwork | null = null;
    // The arena polygon's box (Party), null on the roads
    private arena: { minX: number; minZ: number; maxX: number; maxZ: number } | null = null;
    private arenaWorld: SimWorld | null = null;
    // The heading of the way so far in the arena (sim yaw)
    private heading = 0;
    // Scratch of the grid queries in the arena
    private found: Int32Array | null = null;
    private legs: Leg[] = [];
    // The route's points, and the distance of point 0 from the first leg's start
    private readonly points: RoutePoint[] = [];
    private cruise = 25;
    private readonly stuck = new StuckWatch();
    private chaseTicks = 0;
    private replanHold = 0;
    // Three-point turn in the arena: ticks reversed so far, then the pause
    private turnTicks = 0;
    private turnCooldown = 0;
    private lastX = NaN;
    private lastZ = NaN;
    // For tests and reports
    distance = 0;
    replans = 0;
    readonly lookahead: Point = { x: 0, z: 0 };
    readonly options: DriverOptions;

    constructor(private readonly random: RandomSource, options: Partial<DriverOptions> = {}) {
        this.options = { ...DEFAULT_DRIVER_OPTIONS, ...options };
    }

    get resets(): number {
        return this.stuck.resets;
    }

    get backoffCount(): number {
        return this.stuck.backoffCount;
    }

    /** Drive on this map: the roads (Free Roam) or the arena (Party). */
    setMap(map: MapData, arena: boolean): void {
        this.net = map.net;
        this.arena = null;
        this.arenaWorld = arena ? map.partyWorld : null;
        this.found = null;
        if (arena) {
            const area = map.net.areas.find(a => a.id === map.sources.pois.arena.area);
            if (area) {
                const xs = area.polygon.map(p => p[0]), zs = area.polygon.map(p => p[1]);
                this.arena = {
                    minX: Math.min(...xs) + ARENA_INSET, maxX: Math.max(...xs) - ARENA_INSET,
                    minZ: Math.min(...zs) + ARENA_INSET, maxZ: Math.max(...zs) - ARENA_INSET
                };
            }
        }
        this.restart();
    }

    /** Forgets the route (after a spawn, a respawn or a teleport). */
    restart(): void {
        this.legs.length = 0;
        this.points.length = 0;
        this.stuck.restart();
        this.chaseTicks = this.replanHold = this.turnTicks = this.turnCooldown = 0;
        this.lastX = this.lastZ = NaN;
    }

    /**
     * One tick of driving: writes the input for car state s. chase: a car
     * to ram (mode ram), null to follow the route.
     */
    drive(s: VehicleState, p: VehicleParams, out: VehicleInput, chase: ChaseTarget | null = null): VehicleInput {
        if (Number.isFinite(this.lastX)) this.distance += Math.hypot(s.x - this.lastX, s.z - this.lastZ);
        this.lastX = s.x;
        this.lastZ = s.z;
        out.buttons = 0;
        const u = forwardSpeed(s);

        // Holding the reset button: back on the road, then a new route;
        // backing off an obstacle: reverse with the wheel the other way
        const stuck = this.stuck.override(out);
        if (stuck === 'resetDone') this.restart();
        else if (stuck === 'backoffDone') {
            this.points.length = 0;
            // A chase that ended against something (a car wedged at a
            // container, the fence) is over: the bump happened or never will
            if (this.chaseTicks > 0) this.chaseTicks = CHASE_MAX_TICKS;
        }
        if (stuck !== 'drive') return out;

        // In the arena a car behind a container is no target: the chase would
        // push into the container until the stuck logic gives up
        if (chase && this.arenaWorld && !this.clearWay(s, chase, 1)) chase = null;
        if (chase && this.chaseTicks < CHASE_MAX_TICKS) {
            this.chaseTicks++;
            this.points.length = 0;
            this.lookahead.x = chase.x + chase.vx * CHASE_LEAD_S;
            this.lookahead.z = chase.z + chase.vz * CHASE_LEAD_S;
            out.steer = pursuitSteer(s, p, u, this.lookahead.x, this.lookahead.z, Math.hypot(this.lookahead.x - s.x, this.lookahead.z - s.z));
            out.throttle = 255;
            out.brake = 0;
        } else {
            if (!chase) this.chaseTicks = 0;
            this.follow(s, p, u, out);
        }
        if (this.arena) this.turnRound(s, u, out);
        this.stuck.watch(s, u, out);
        return out;
    }

    // The three-point turn for a look-ahead point behind the car (arena)
    private turnRound(s: VehicleState, u: number, out: VehicleInput): void {
        const alpha = wrapAngle(Math.atan2(this.lookahead.x - s.x, this.lookahead.z - s.z) - s.yaw);
        const off = Math.abs(alpha);
        if (this.turnTicks > 0) {
            if (this.turnTicks >= TURN_STALL_TICKS && Math.abs(u) < TURN_STALLED) {
                this.turnTicks = 0;
                this.turnCooldown = 2 * STUCK_TICKS;
            } else if (off < TURN_DONE || this.turnTicks >= TURN_MAX_TICKS) {
                this.turnTicks = 0;
                this.turnCooldown = TURN_COOLDOWN_TICKS;
            } else {
                this.turnTicks++;
            }
        } else if (this.turnCooldown > 0) {
            this.turnCooldown--;
        } else if (off > TURN_START && u < TURN_SPEED) {
            this.turnTicks = 1;
        }
        if (this.turnTicks > 0) {
            // Reversing: the wheel the other way swings the nose towards the point
            out.steer = alpha > 0 ? -127 : 127;
            out.throttle = 0;
            out.brake = 255;
        }
    }

    /** True while the last chase ran out and the target is still there (ram cooldown). */
    get chaseSpent(): boolean {
        return this.chaseTicks >= CHASE_MAX_TICKS;
    }

    private follow(s: VehicleState, p: VehicleParams, u: number, out: VehicleInput): void {
        if (this.points.length < 2) this.plan(s);
        if (this.points.length < 2) {
            out.steer = 0;
            out.throttle = 0;
            out.brake = 255;
            return;
        }
        // Drop the points the car has passed: it is nearer the segment after
        let seg = this.project(0, s.x, s.z);
        while (this.points.length > 2 && (seg.t >= seg.length || this.project(1, s.x, s.z).distance <= seg.distance)) {
            this.points.shift();
            seg = this.project(0, s.x, s.z);
        }
        this.extend();
        if (this.replanHold > 0) this.replanHold--;
        else if (seg.distance > OFF_ROUTE) {
            // Pushed away (a bump, a wall): plan again from where the car is
            this.replans++;
            this.replanHold = REPLAN_HOLD_TICKS;
            this.plan(s);
            if (this.points.length < 2) return;
            seg = this.project(0, s.x, s.z);
        }
        const o = this.options;
        const ld = o.lookaheadBase + o.lookaheadTime * Math.max(0, u);
        this.pointAlong(Math.max(0, seg.t) + ld, this.lookahead);
        out.steer = pursuitSteer(s, p, u, this.lookahead.x, this.lookahead.z, ld);

        // Speed: cruise (slower off the tarmac), slower for the bends ahead
        // (from the turn at every route point: v² = a_lat · grip / κ,
        // reachable with the planned braking)
        let limit = this.points[1].grip < 0.9 ? Math.min(this.cruise, UNPAVED_CRUISE) : this.cruise;
        let ahead = seg.length - Math.max(0, seg.t);
        for (let k = 1; k + 1 < this.points.length && ahead < SPEED_HORIZON; k++) {
            const point = this.points[k];
            const bend = Math.max(o.cornerMin, Math.sqrt(o.cornerAccel * point.grip / Math.max(1e-6, this.curvatureAt(k))));
            const cap = point.grip < 0.9 ? Math.min(bend, UNPAVED_CRUISE) : bend;
            limit = Math.min(limit, Math.sqrt(cap * cap + 2 * o.cornerDecel * Math.max(0, ahead - 4)));
            ahead += this.segmentLength(k);
        }
        const error = limit - u;
        if (error >= 0) {
            out.throttle = Math.round(255 * Math.max(0, Math.min(1, 0.35 + error / 5)));
            out.brake = 0;
        } else if (error < -1.5 && u > 2) {
            out.throttle = 0;
            out.brake = Math.round(255 * Math.max(0, Math.min(1, -error / 6)));
        } else {
            out.throttle = 60;
            out.brake = 0;
        }
    }

    // ---- Route ----

    private drawCruise(): number {
        const o = this.options;
        const [min, max] = this.arena ? [ARENA_CRUISE_MIN, ARENA_CRUISE_MAX] : [o.cruiseMin, o.cruiseMax];
        return min + this.random() * (max - min);
    }

    // A new route from where the car is, heading the way it faces
    private plan(s: VehicleState): void {
        this.legs.length = 0;
        this.points.length = 0;
        this.cruise = this.drawCruise();
        if (this.arena) {
            this.points.push({ x: s.x, z: s.z, grip: 0.97 });
            this.heading = s.yaw;
            this.extend();
            return;
        }
        if (!this.net) return;
        const hit = nearestRoad(this.net, s.x, s.z, 80) ?? nearestRoad(this.net, s.x, s.z, 3000);
        if (!hit) return;
        const forward = hit.tx * Math.sin(s.yaw) + hit.tz * Math.cos(s.yaw) >= 0;
        const reversed = hit.edge.def.oneWay ? false : !forward;
        this.legs.push({ edge: hit.edge, reversed });
        // The first leg from the car's station on
        this.appendLeg(this.legs[0], hit.s);
        this.extend();
    }

    // Right-hand lane offset of an edge (none on a one-lane or one-way road)
    private laneOffset(edge: RoadEdgeData): number {
        const lanes = edge.profile.lanes;
        return lanes[0] > 0 && lanes[1] > 0 ? edge.halfWidth / 2 : 0;
    }

    // The points of a leg from station `from` (along the driving direction)
    private appendLeg(leg: Leg, from = -1): void {
        const { edge, reversed } = leg;
        const samples = edge.samples;
        const offset = this.laneOffset(edge);
        const surface = SURFACE[edge.profile.surface];
        const grip = SURFACE_GRIP[surface] * (isPaved(surface) ? 1 : OFFROAD_GRIP);
        const n = samples.length;
        for (let k = 0; k < n; k += POINT_SPACING) {
            const i = reversed ? n - 1 - k : k;
            const a = samples[i];
            if (from >= 0 && (reversed ? a.s > from : a.s < from)) continue;
            const tx = reversed ? -a.tx : a.tx, tz = reversed ? -a.tz : a.tz;
            // Right of the driving direction (tx, tz) is (-tz, tx)
            this.points.push({ x: a.x - tz * offset, z: a.z + tx * offset, grip });
        }
    }

    // Grows the route until it reaches ROUTE_AHEAD
    private extend(): void {
        while (this.routeLength() < ROUTE_AHEAD) {
            if (this.arena) {
                const a = this.arena;
                const from = this.points[this.points.length - 1];
                let target: RoutePoint | null = null;
                for (let k = 0; k < ARENA_TRIES && !target; k++) {
                    const cone = Math.min(Math.PI, ARENA_CONE + k * Math.PI / 12);
                    const yaw = this.heading + (this.random() * 2 - 1) * cone;
                    const reach = ARENA_REACH_MIN + this.random() * (ARENA_REACH_MAX - ARENA_REACH_MIN);
                    const candidate = { x: from.x + Math.sin(yaw) * reach, z: from.z + Math.cos(yaw) * reach, grip: 0.97 };
                    const inside = candidate.x > a.minX && candidate.x < a.maxX && candidate.z > a.minZ && candidate.z < a.maxZ;
                    if (inside && this.clearWay(from, candidate)) target = candidate;
                }
                // Hemmed in: the freest way out, else anywhere in the arena
                target ??= this.escape(from) ?? { x: a.minX + this.random() * (a.maxX - a.minX), z: a.minZ + this.random() * (a.maxZ - a.minZ), grip: 0.97 };
                this.heading = Math.atan2(target.x - from.x, target.z - from.z);
                this.points.push(target);
                continue;
            }
            const last = this.legs[this.legs.length - 1];
            if (!last || !this.net) return;
            const next = this.nextLeg(last);
            this.legs.push(next);
            if (this.legs.length > 8) this.legs.shift();
            this.appendLeg(next);
            this.cruise = this.drawCruise();
        }
    }

    // One more edge at the end node of `last`: straight on with
    // straightBias, else a random other way, back only from a dead end.
    // Paved roads before tracks, and no road into a dead end while there is
    // another way (the load-test bots stay in town and seldom turn round)
    private nextLeg(last: Leg): Leg {
        const net = this.net!;
        const nodeIndex = last.reversed ? last.edge.from : last.edge.to;
        const node = net.nodes[nodeIndex];
        const samples = last.edge.samples;
        const end = last.reversed ? samples[0] : samples[samples.length - 1];
        const inX = last.reversed ? -end.tx : end.tx, inZ = last.reversed ? -end.tz : end.tz;
        const options: { leg: Leg; turn: number }[] = [];
        for (const e of node.ends) {
            if (e.edge === last.edge.index) continue;
            const edge = net.edges[e.edge];
            const reversed = !e.atStart;
            if (edge.def.oneWay && reversed) continue;
            const first = reversed ? edge.samples[edge.samples.length - 1] : edge.samples[0];
            const ox = reversed ? -first.tx : first.tx, oz = reversed ? -first.tz : first.tz;
            options.push({ leg: { edge, reversed }, turn: 1 - (inX * ox + inZ * oz) });
        }
        if (options.length === 0) return { edge: last.edge, reversed: !last.reversed };
        const through = (o: { leg: Leg }) => net.nodes[o.leg.reversed ? o.leg.edge.from : o.leg.edge.to].def.kind !== 'end';
        const paved = (o: { leg: Leg }) => isPaved(SURFACE[o.leg.edge.profile.surface]);
        let preferred = options.filter(o => through(o) && paved(o));
        if (preferred.length === 0) preferred = options.filter(through);
        if (preferred.length > 0) options.splice(0, options.length, ...preferred);
        options.sort((a, b) => a.turn - b.turn);
        if (options.length === 1 || this.random() < this.options.straightBias) return options[0].leg;
        return options[1 + Math.floor(this.random() * (options.length - 1))].leg;
    }

    // True when the straight way from a to b keeps `clearance` from every
    // collider's bounding box in the arena
    private clearWay(a: Point, b: Point, clearance = ARENA_CLEARANCE): boolean {
        const length = Math.hypot(b.x - a.x, b.z - a.z);
        return this.freeLength(a, b.x - a.x, b.z - a.z, length, clearance) >= length;
    }

    // How far (m, up to `length`) the straight way from a along (dx, dz)
    // keeps `clearance` from every collider's bounding box in the arena,
    // checked in steps of at most 2 m. Within the first 4 m a box only counts
    // when the way comes nearer to it than the car stands: a car right next
    // to a container it just backed off from may drive away from it, not
    // into it.
    private freeLength(a: Point, dx: number, dz: number, length: number, clearance: number): number {
        const world = this.arenaWorld;
        if (!world || length <= 0) return length;
        const norm = Math.hypot(dx, dz) || 1;
        const ux = dx / norm, uz = dz / norm;
        const steps = Math.max(1, Math.ceil(length / 2));
        const step = length / steps;
        const found = this.found ??= new Int32Array(world.colliders.length);
        const r = clearance;
        for (let i = 1; i <= steps; i++) {
            const x = a.x + ux * step * i, z = a.z + uz * step * i;
            const count = world.grid.query(x - r, z - r, x + r, z + r, found);
            for (let k = 0; k < count; k++) {
                const [minX, minZ, maxX, maxZ] = colliderBounds(world.colliders[found[k]]);
                if (!(x > minX - r && x < maxX + r && z > minZ - r && z < maxZ + r)) continue;
                if (step * i > 4) return step * (i - 1);
                const gap = (px: number, pz: number) => Math.hypot(Math.max(minX - px, 0, px - maxX), Math.max(minZ - pz, 0, pz - maxZ));
                if (gap(x, z) < gap(a.x, a.z)) return step * (i - 1);
            }
        }
        return length;
    }

    // Hemmed in (no target clear of everything by ARENA_CLEARANCE): the way
    // out that runs freest, with 1 m to spare, in one of ESCAPE_WAYS
    // directions; null when every one is blocked at once
    private escape(from: Point): RoutePoint | null {
        let best = 0, bestYaw = 0;
        for (let k = 0; k < ESCAPE_WAYS; k++) {
            const yaw = this.heading + k * 2 * Math.PI / ESCAPE_WAYS;
            const free = this.freeLength(from, Math.sin(yaw), Math.cos(yaw), ARENA_REACH_MAX, 1);
            if (free > best) {
                best = free;
                bestYaw = yaw;
            }
        }
        if (best < 2) return null;
        return { x: from.x + Math.sin(bestYaw) * best, z: from.z + Math.cos(bestYaw) * best, grip: 0.97 };
    }

    private routeLength(): number {
        let length = 0;
        for (let k = 0; k + 1 < this.points.length; k++) length += this.segmentLength(k);
        return length;
    }

    private segmentLength(k: number): number {
        const a = this.points[k], b = this.points[k + 1];
        return Math.hypot(b.x - a.x, b.z - a.z);
    }

    // Turn per metre at point k: the angle between the segments before and after it
    private curvatureAt(k: number): number {
        const a = this.points[k - 1], b = this.points[k], c = this.points[k + 1];
        const ux = b.x - a.x, uz = b.z - a.z, vx = c.x - b.x, vz = c.z - b.z;
        const lu = Math.hypot(ux, uz), lv = Math.hypot(vx, vz);
        if (lu < 1e-6 || lv < 1e-6) return 0;
        const angle = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uz * vz) / (lu * lv))));
        return angle / ((lu + lv) / 2);
    }

    // The car's position against segment k: distance along it, its length
    // and the distance to the segment itself
    private project(k: number, x: number, z: number): { t: number; length: number; distance: number } {
        const a = this.points[k], b = this.points[k + 1];
        const length = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        const dx = (b.x - a.x) / length, dz = (b.z - a.z) / length;
        const t = (x - a.x) * dx + (z - a.z) * dz;
        const along = Math.max(0, Math.min(length, t));
        const distance = Math.hypot(x - (a.x + dx * along), z - (a.z + dz * along));
        return { t, length, distance };
    }

    // The point at distance d along the route from its first point
    private pointAlong(d: number, out: Point): Point {
        const w = this.points;
        let rest = Math.max(0, d);
        for (let k = 0; k + 1 < w.length; k++) {
            const len = this.segmentLength(k);
            if (rest <= len || k + 2 === w.length) {
                const f = len > 0 ? Math.min(1, rest / len) : 0;
                out.x = w[k].x + (w[k + 1].x - w[k].x) * f;
                out.z = w[k].z + (w[k + 1].z - w[k].z) * f;
                return out;
            }
            rest -= len;
        }
        out.x = w[w.length - 1].x;
        out.z = w[w.length - 1].z;
        return out;
    }
}
