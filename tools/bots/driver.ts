// How a bot drives (docs/phase-1b-design.md, 15.2): pure pursuit over the
// city's road grid. The bot picks a random route from crossing to crossing
// (straight on more often than a turn, never back), keeps to the right lane,
// steers towards a point 12 m + 0.4 s · v ahead on that route, cruises at
// 20-35 m/s and slows to 12 m/s before a 90° turn. Mode ram chases the
// nearest car instead for a few seconds. A car that stops making progress
// backs off, and after a few tries holds the reset button (back on the road).
// Pure: no socket, no clock; the Node tests drive it against the sim alone.
// Pure pursuit, the steer input and the stuck logic are shared with the
// race bots (src/shared/race/pursuit.ts).

import type { RandomSource } from '../../src/shared/math/rng.js';
import { forwardSpeed, pursuitSteer, StuckWatch } from '../../src/shared/race/pursuit.js';
import type { VehicleInput, VehicleParams, VehicleState } from '../../src/shared/sim/types.js';
import type { RoadGrid } from '../../src/shared/world/colliders.js';

export { forwardSpeed, steerForAngle, wrapAngle } from '../../src/shared/race/pursuit.js';

export interface DriverOptions {
    // Cruise speed range (m/s); each route leg draws one
    cruiseMin: number;
    cruiseMax: number;
    // Speed through a 90° turn (m/s) and the braking the approach assumes (m/s²)
    cornerSpeed: number;
    cornerDecel: number;
    // Offset of the driving line to the right of the road centre (m)
    lane: number;
    // Look-ahead distance: base + time · speed (m, s)
    lookaheadBase: number;
    lookaheadTime: number;
    // Share of crossings where the route goes straight on (when it can)
    straightBias: number;
}

export const DEFAULT_DRIVER_OPTIONS: DriverOptions = {
    cruiseMin: 20,
    cruiseMax: 35,
    cornerSpeed: 12,
    cornerDecel: 7,
    lane: 3,
    lookaheadBase: 12,
    lookaheadTime: 0.4,
    straightBias: 0.5
};

// A car to chase (ram mode): position and velocity (m, m/s)
export interface ChaseTarget {
    x: number;
    z: number;
    vx: number;
    vz: number;
}

interface Node { i: number; j: number }
interface Point { x: number; z: number }

// Farther than this from the planned line, the route starts over, at most
// once per REPLAN_HOLD_TICKS (a car that slid far wide steers back first)
const OFF_ROUTE = 18;
const REPLAN_HOLD_TICKS = 60;
// Route length kept ahead (crossings)
const ROUTE_AHEAD = 5;
// A chase ends after this long, or when the target is farther away
const CHASE_MAX_TICKS = 240;
const CHASE_LEAD_S = 0.3;

export class RoadDriver {
    // Crossings: route[0] is the one the car comes from, route[1] the next
    private route: Node[] = [];
    private readonly waypoints: Point[] = [];
    private cruise = 25;
    private readonly stuck = new StuckWatch();
    private chaseTicks = 0;
    private replanHold = 0;
    private lastX = NaN;
    private lastZ = NaN;
    // For tests and reports
    distance = 0;
    replans = 0;
    readonly lookahead: Point = { x: 0, z: 0 };
    readonly options: DriverOptions;

    constructor(readonly grid: RoadGrid, private readonly random: RandomSource, options: Partial<DriverOptions> = {}) {
        this.options = { ...DEFAULT_DRIVER_OPTIONS, ...options };
    }

    get resets(): number {
        return this.stuck.resets;
    }

    get backoffCount(): number {
        return this.stuck.backoffCount;
    }

    /** Forgets the route (after a spawn, a respawn or a teleport). */
    restart(): void {
        this.route.length = 0;
        this.stuck.restart();
        this.chaseTicks = this.replanHold = 0;
        this.lastX = this.lastZ = NaN;
    }

    /**
     * One tick of driving: writes the input for car state s. chase: a car
     * to ram (mode ram), null to follow the roads.
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
        else if (stuck === 'backoffDone') this.route.length = 0;
        if (stuck !== 'drive') return out;

        if (chase && this.chaseTicks < CHASE_MAX_TICKS) {
            this.chaseTicks++;
            this.route.length = 0;
            this.lookahead.x = chase.x + chase.vx * CHASE_LEAD_S;
            this.lookahead.z = chase.z + chase.vz * CHASE_LEAD_S;
            this.pursue(s, p, u, out, this.lookahead, Math.hypot(this.lookahead.x - s.x, this.lookahead.z - s.z));
            out.throttle = 255;
            out.brake = 0;
        } else {
            if (!chase) this.chaseTicks = 0;
            this.followRoads(s, p, u, out);
        }
        this.stuck.watch(s, u, out);
        return out;
    }

    /** True while the last chase ran out and the target is still there (ram cooldown). */
    get chaseSpent(): boolean {
        return this.chaseTicks >= CHASE_MAX_TICKS;
    }

    private followRoads(s: VehicleState, p: VehicleParams, u: number, out: VehicleInput): void {
        if (this.route.length < 2) this.plan(s);
        this.buildWaypoints();
        // Where along the route the car is: advance past crossings it passed
        // (a crossing counts as passed once the car is past it or already
        // nearer the next leg, which pure pursuit reaches by cutting the corner)
        let seg = this.project(0, s.x, s.z);
        for (let n = 0; n < 4 && this.route.length > 2; n++) {
            if (seg.t < seg.length - 0.5 && this.project(1, s.x, s.z).distance > seg.distance) break;
            this.route.shift();
            this.extend();
            this.buildWaypoints();
            seg = this.project(0, s.x, s.z);
        }
        if (this.replanHold > 0) this.replanHold--;
        else if (seg.distance > OFF_ROUTE) {
            // Pushed away (a bump, a wall): plan again from where the car is
            this.replans++;
            this.replanHold = REPLAN_HOLD_TICKS;
            this.plan(s);
            this.buildWaypoints();
            seg = this.project(0, s.x, s.z);
        }
        const o = this.options;
        const ld = o.lookaheadBase + o.lookaheadTime * Math.max(0, u);
        this.pointAlong(seg.t + ld, this.lookahead);
        this.pursue(s, p, u, out, this.lookahead, ld);

        // Speed: cruise, slower before a turn
        const remaining = seg.length - seg.t;
        let limit = this.cruise;
        let ahead = remaining;
        for (let k = 1; k + 1 < this.route.length && ahead < 150; k++) {
            if (this.turnsAt(k)) {
                const room = Math.max(0, ahead - 6);
                limit = Math.min(limit, Math.sqrt(o.cornerSpeed * o.cornerSpeed + 2 * o.cornerDecel * room));
                break;
            }
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

    // Pure pursuit: the wheel angle of the arc through the target point
    private pursue(s: VehicleState, p: VehicleParams, u: number, out: VehicleInput, target: Point, ld: number): void {
        out.steer = pursuitSteer(s, p, u, target.x, target.z, ld);
    }

    // ---- Route ----

    private nodePoint(n: Node): Point {
        return { x: this.grid.xLines[n.i], z: this.grid.zLines[n.j] };
    }

    // The road segment the car is on (or nearest to), heading the way the car faces
    private plan(s: VehicleState): void {
        const g = this.grid;
        const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
        const clampIndex = (value: number, lines: number[]) => {
            let k = 0;
            while (k + 1 < lines.length - 1 && value > lines[k + 1]) k++;
            return k;
        };
        let best = Infinity;
        let from: Node = { i: 0, j: 0 }, to: Node = { i: 0, j: 1 };
        for (let i = 0; i < g.xLines.length; i++) {
            const along = Math.max(g.zLines[0], Math.min(g.zLines[g.zLines.length - 1], s.z));
            const d = Math.hypot(s.x - g.xLines[i], s.z - along);
            if (d < best) {
                best = d;
                const j = clampIndex(along, g.zLines);
                [from, to] = fz >= 0 ? [{ i, j }, { i, j: j + 1 }] : [{ i, j: j + 1 }, { i, j }];
            }
        }
        for (let j = 0; j < g.zLines.length; j++) {
            const along = Math.max(g.xLines[0], Math.min(g.xLines[g.xLines.length - 1], s.x));
            const d = Math.hypot(s.x - along, s.z - g.zLines[j]);
            if (d < best) {
                best = d;
                const i = clampIndex(along, g.xLines);
                [from, to] = fx >= 0 ? [{ i, j }, { i: i + 1, j }] : [{ i: i + 1, j }, { i, j }];
            }
        }
        this.route = [from, to];
        this.cruise = this.drawCruise();
        while (this.route.length < ROUTE_AHEAD + 1) this.extend();
    }

    private drawCruise(): number {
        const o = this.options;
        return o.cruiseMin + this.random() * (o.cruiseMax - o.cruiseMin);
    }

    private neighbours(n: Node): Node[] {
        const g = this.grid;
        const list: Node[] = [];
        if (n.i > 0) list.push({ i: n.i - 1, j: n.j });
        if (n.i + 1 < g.xLines.length) list.push({ i: n.i + 1, j: n.j });
        if (n.j > 0) list.push({ i: n.i, j: n.j - 1 });
        if (n.j + 1 < g.zLines.length) list.push({ i: n.i, j: n.j + 1 });
        return list;
    }

    // One more crossing: straight on with straightBias, else a random turn, never back
    private extend(): void {
        const r = this.route;
        const a = r[r.length - 2], b = r[r.length - 1];
        const options = this.neighbours(b).filter(n => n.i !== a.i || n.j !== a.j);
        const straight = options.find(n => n.i - b.i === b.i - a.i && n.j - b.j === b.j - a.j);
        let next: Node;
        if (straight && (options.length === 1 || this.random() < this.options.straightBias)) next = straight;
        else {
            const turns = options.filter(n => n !== straight);
            next = turns.length > 0 ? turns[Math.floor(this.random() * turns.length)] : options[0];
        }
        r.push(next);
        if (r.length === 3) this.cruise = this.drawCruise();
    }

    private turnsAt(k: number): boolean {
        const r = this.route;
        const a = r[k - 1], b = r[k], c = r[k + 1];
        return (b.i - a.i) !== (c.i - b.i) || (b.j - a.j) !== (c.j - b.j);
    }

    // Driving line: the crossings shifted into the right lane; at a turn the
    // corner where both lanes meet
    private buildWaypoints(): void {
        const r = this.route, lane = this.options.lane;
        this.waypoints.length = 0;
        for (let k = 0; k < r.length; k++) {
            const p = this.nodePoint(r[k]);
            let ox = 0, oz = 0;
            const addRight = (from: Node, to: Node) => {
                const a = this.nodePoint(from), b = this.nodePoint(to);
                const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
                const dx = (b.x - a.x) / len, dz = (b.z - a.z) / len;
                // Right of the heading (dx, dz): (-dz, dx)
                return { x: -dz * lane, z: dx * lane };
            };
            const inRight = k > 0 ? addRight(r[k - 1], r[k]) : null;
            const outRight = k + 1 < r.length ? addRight(r[k], r[k + 1]) : null;
            if (inRight && outRight && (inRight.x !== outRight.x || inRight.z !== outRight.z)) {
                ox = inRight.x + outRight.x;
                oz = inRight.z + outRight.z;
            } else {
                const right = outRight ?? inRight!;
                ox = right.x;
                oz = right.z;
            }
            this.waypoints.push({ x: p.x + ox, z: p.z + oz });
        }
    }

    private segmentLength(k: number): number {
        const a = this.waypoints[k], b = this.waypoints[k + 1];
        return Math.hypot(b.x - a.x, b.z - a.z);
    }

    // The car's position against segment k: distance along it, its length
    // and the distance to the segment itself
    private project(k: number, x: number, z: number): { t: number; length: number; distance: number } {
        const a = this.waypoints[k], b = this.waypoints[k + 1];
        const length = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        const dx = (b.x - a.x) / length, dz = (b.z - a.z) / length;
        const t = (x - a.x) * dx + (z - a.z) * dz;
        const along = Math.max(0, Math.min(length, t));
        const distance = Math.hypot(x - (a.x + dx * along), z - (a.z + dz * along));
        return { t, length, distance };
    }

    // The point at distance d along the route from its first waypoint
    private pointAlong(d: number, out: Point): Point {
        const w = this.waypoints;
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
