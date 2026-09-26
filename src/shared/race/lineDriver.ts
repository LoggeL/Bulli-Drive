// The race bots' driver (docs/phase-2-design.md, 14): pure pursuit along
// the racing line, the speed from the class's speed profile, a seeded
// slowly drifting lane offset (so the bots do not drive like a train),
// evasion of slower cars ahead (bots never ram on purpose), the slipstream
// of the car ahead, boost on straights, the stuck logic of the road bots
// and the throttle timing of the start. Three levels. Pure: the caller
// supplies the car, the tick and the other cars; the randomness comes from
// a seeded RandomSource. The server runs it for its bots, the WebSocket
// bots of the tests on their own prediction.

import type { RandomSource } from '../math/rng.js';
import { BTN_BOOST } from '../sim/constants.js';
import type { VehicleInput, VehicleParams, VehicleState } from '../sim/types.js';
import { createProjection, pointAt, projectGlobal, projectNear, type Projection } from './geometry.js';
import type { Course } from './progress.js';
import { forwardSpeed, pursuitSteer, StuckWatch, wrapAngle } from './pursuit.js';
import { speedProfile } from './racingLine.js';
import { DRAFT_MIN_SPEED, LAUNCH_WINDOW_TICKS } from './rules.js';
import type { BotLevel } from './types.js';

export interface BotSkill {
    // Share of the class's speed profile the bot drives
    speedScale: number;
    // Look-ahead time of the pursuit point (s)
    lookaheadTime: number;
    // Amplitude of the drifting lane offset (m)
    noise: number;
    // Reaction delay of the steering and the pedals (ticks)
    delayTicks: number;
    boost: boolean;
    // Seeks the slipstream of the car ahead on straights
    draft: boolean;
    // Chance of a perfect start
    launchPerfect: number;
    // Share of the grip the bot plans its corners with on unpaved ground
    // (on top of the profile's margin): a car sliding on dirt or gravel
    // answers the wheel late, and the easy bots' reaction delay (12 ticks)
    // made them weave out of a 180 m bend of the Dune Rally at 39 m/s and
    // miss its gate. Swept over 900 races on Bulli Bay (6 tracks × 3 levels
    // × 5 classes × 10 seeds, tools/map/driveTrack.ts): missed gates 14 → 5
    // (the easy bots' on unpaved ground 10 → 0), resets 20 → 10, the easy
    // Dune Rally 3 s slower. The medium and hard bots keep the full grip:
    // with less, five medium bots jammed in the Dune Rally's beach slalom
    // (tests/integration/trackRaces.test.ts).
    unpavedGrip: number;
}

// Start values (14)
export const BOT_SKILLS: Readonly<Record<BotLevel, BotSkill>> = {
    easy: { speedScale: 0.82, lookaheadTime: 0.55, noise: 1.5, delayTicks: 12, boost: false, draft: false, launchPerfect: 0.1, unpavedGrip: 0.7 },
    medium: { speedScale: 0.92, lookaheadTime: 0.45, noise: 0.8, delayTicks: 6, boost: true, draft: true, launchPerfect: 0.4, unpavedGrip: 1 },
    hard: { speedScale: 0.98, lookaheadTime: 0.4, noise: 0.3, delayTicks: 2, boost: true, draft: true, launchPerfect: 0.8, unpavedGrip: 1 }
};

// Pursuit point: LOOKAHEAD_BASE + lookaheadTime · speed ahead on the line (m)
export const LOOKAHEAD_BASE = 6;
// The speed target looks this far ahead: SPEED_PREVIEW_BASE + time · speed (m, s)
const SPEED_PREVIEW_BASE = 2;
const SPEED_PREVIEW_TIME = 0.3;
// Lane offset: knots every NOISE_PERIOD_TICKS (3 s), smoothly blended
export const NOISE_PERIOD_TICKS = 180;
// Traffic: a car in the corridor this far ahead (m) and this wide either side (m)
export const TRAFFIC_AHEAD = 14;
export const TRAFFIC_HALF_WIDTH = 2.6;
// Slower by this much (m/s) counts as in the way; closer than
// TRAFFIC_CLOSE (m) any car in the corridor does
const TRAFFIC_SLOWER = 1;
const TRAFFIC_CLOSE = 8;
// Evasion offset (m) and how fast the offset may move (m/s)
export const EVADE_OFFSET = 3;
const OFFSET_RATE = 6;
// Closing in fast, the corridor reaches this many seconds of the closing
// speed ahead: at 25 m/s on a standing car the lane change needs about 2 s
const TRAFFIC_TIME = 2;
// Curvature (1/m) above which a stretch counts as a corner: evasion only outwards
const CORNER_CURVATURE = 1 / 150;
// Slipstream: a car ahead within this range (m), on a straight of STRAIGHT_AHEAD m
const DRAFT_SEEK_RANGE = 25;
const STRAIGHT_AHEAD = 60;
// Boost when the profile stays at top speed for STRAIGHT_AHEAD m and the meter is this full
const BOOST_METER = 0.5;
// A jump farther than this between two ticks is a reset or a teleport (m)
const TELEPORT_DISTANCE = 10;
// Traction control: no throttle while the velocity points more than this
// (rad, about 7°) away from the nose, above TRACTION_MIN_SPEED (m/s). On
// Bulli Bay five medium bots per race spun about half as often with it
// (192 against 92 resets in 120 races, tests/integration/trackRaces.test.ts)
// and were 1-2 % slower.
export const TRACTION_SLIP = 0.12;
export const TRACTION_MIN_SPEED = 5;
// Farther off the line than this (m) for OFF_LINE_RESET_TICKS: reset
const OFF_LINE_RESET = 25;
const OFF_LINE_RESET_TICKS = 120;

const DT = 1 / 60;

// Another car as the bot sees it: position and velocity (m, m/s)
export interface TrafficCar {
    x: number;
    z: number;
    vx: number;
    vz: number;
}

export interface LaunchPlan {
    // The tick the bot presses the throttle in the countdown (held from then on)
    pressTick: number;
}

export class LineDriver {
    readonly skill: BotSkill;
    readonly profile: Float64Array;
    readonly stuck = new StuckWatch();
    private readonly projection: Projection = createProjection();
    private readonly ahead: Projection = createProjection();
    private lineIndex = -1;
    private sLine = 0;
    private lastX = NaN;
    private lastZ = NaN;
    private offset = 0;
    private knotIndex = -1;
    private knotA = 0;
    private knotB = 0;
    private pressTick = Infinity;
    private readonly delaySteer: Int16Array;
    private readonly delayThrottle: Int16Array;
    private readonly delayBrake: Int16Array;
    private delayAt = 0;
    private offLineTicks = 0;
    // For tests and reports
    readonly target = { x: 0, z: 0 };
    maxLineDistance = 0;

    constructor(
        readonly course: Course,
        params: VehicleParams,
        readonly level: BotLevel,
        private readonly random: RandomSource
    ) {
        this.skill = BOT_SKILLS[level];
        this.profile = speedProfile(course.line, params, course.surfaces, this.skill.unpavedGrip);
        const size = this.skill.delayTicks + 1;
        this.delaySteer = new Int16Array(size);
        this.delayThrottle = new Int16Array(size);
        this.delayBrake = new Int16Array(size);
    }

    /**
     * A new race: draws when the bot presses the throttle in the countdown.
     * A perfect start with the level's chance (an edge within the launch
     * window), otherwise half the time too early (held from well before the
     * window: a bogged start) and half the time a tick after green.
     */
    startRace(startTick: number): LaunchPlan {
        const r = this.random();
        if (r < this.skill.launchPerfect) {
            this.pressTick = startTick - 2 - Math.floor(this.random() * (LAUNCH_WINDOW_TICKS - 4));
        } else if (this.random() < 0.5) {
            this.pressTick = startTick - LAUNCH_WINDOW_TICKS - 10 - Math.floor(this.random() * 25);
        } else {
            this.pressTick = startTick + 1;
        }
        this.restart();
        return { pressTick: this.pressTick };
    }

    /** The lane offset from the racing line (m, + = left): noise, evasion, slipstream. */
    get laneOffset(): number {
        return this.offset;
    }

    /**
     * Holds reset (a missed gate: the race's reset puts the car back before
     * it, 10.3). Ignored while a reset is already held.
     */
    requestReset(): void {
        this.stuck.forceReset();
    }

    /** Forgets the place on the line (after a spawn or a teleport). */
    restart(): void {
        this.lineIndex = -1;
        this.offLineTicks = 0;
        this.lastX = this.lastZ = NaN;
        this.offset = 0;
        this.stuck.restart();
        this.delaySteer.fill(0);
        this.delayThrottle.fill(0);
        this.delayBrake.fill(0);
    }

    /**
     * One tick: writes the input for the car state s at tick (the race
     * starts at startTick; null = no race running, the car stands). traffic:
     * the other cars of the race.
     */
    drive(s: VehicleState, p: VehicleParams, tick: number, startTick: number | null, traffic: readonly TrafficCar[], out: VehicleInput): VehicleInput {
        out.buttons = 0;
        if (startTick === null || tick < startTick) {
            // Countdown: standing, throttle from the planned tick on; the
            // reaction delay holds the same, so the pedal stays down at green
            out.steer = 0;
            out.brake = 0;
            out.throttle = startTick !== null && tick >= this.pressTick ? 255 : 0;
            this.delaySteer.fill(0);
            this.delayThrottle.fill(out.throttle);
            this.delayBrake.fill(0);
            this.lastX = s.x;
            this.lastZ = s.z;
            return out;
        }
        const u = forwardSpeed(s);

        // Where on the line: windowed around the last index, globally after a jump
        const jumped = !Number.isFinite(this.lastX) || Math.hypot(s.x - this.lastX, s.z - this.lastZ) > TELEPORT_DISTANCE;
        this.lastX = s.x;
        this.lastZ = s.z;
        const line = this.course.line;
        const hit = this.lineIndex < 0 || jumped
            ? projectGlobal(line, s.x, s.z, this.projection, this.lineIndex < 0 ? undefined : this.sLine)
            : projectNear(line, s.x, s.z, this.lineIndex, this.projection);
        this.lineIndex = hit.index;
        this.sLine = hit.s;
        this.maxLineDistance = Math.max(this.maxLineDistance, hit.dist);
        // Spun far off the line (a crash), also while backing off: back onto it
        this.offLineTicks = hit.dist > OFF_LINE_RESET ? this.offLineTicks + 1 : 0;
        if (this.offLineTicks >= OFF_LINE_RESET_TICKS) {
            this.offLineTicks = 0;
            this.stuck.forceReset();
        }

        const stuck = this.stuck.override(out);
        if (stuck === 'resetDone') this.lineIndex = -1;
        if (stuck !== 'drive') return out;

        const curvature = line.points[hit.index].curvature;
        const lx = hit.tz, lz = -hit.tx;

        // Speed target from the profile a little ahead
        const preview = SPEED_PREVIEW_BASE + SPEED_PREVIEW_TIME * Math.max(0, u);
        let limit = this.profileMin(hit.s, hit.s + preview) * this.skill.speedScale;

        // Lane: drifting noise, then traffic and slipstream
        let wanted = this.noise(tick) * this.skill.noise;
        let blocked = false;
        let draftLat = NaN;
        let straight = false;
        if (traffic.length > 0) {
            straight = this.maxCurvature(hit.s, hit.s + STRAIGHT_AHEAD) < CORNER_CURVATURE;
            let nearest = Infinity;
            const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
            // The car's own place across the line (+ = left)
            const carLat = (s.x - hit.x) * lx + (s.z - hit.z) * lz;
            for (const o of traffic) {
                const dx = o.x - s.x, dz = o.z - s.z;
                const along = dx * fx + dz * fz;
                if (along <= 0) continue;
                const lat = dx * lx + dz * lz;
                const uo = o.vx * fx + o.vz * fz;
                const inTheWay = uo < u - TRAFFIC_SLOWER || along < TRAFFIC_CLOSE;
                const corridor = Math.max(TRAFFIC_AHEAD, TRAFFIC_TIME * (u - uo));
                if (along <= corridor && Math.abs(lat) < TRAFFIC_HALF_WIDTH && inTheWay && along < nearest) {
                    nearest = along;
                    blocked = true;
                    // Out of its way: to the side with more room; in a
                    // corner only to the outside
                    let side = lat > 0 ? -1 : 1;
                    if (Math.abs(curvature) > CORNER_CURVATURE) side = curvature > 0 ? -1 : 1;
                    wanted = side * EVADE_OFFSET;
                    // The other car is on that side too: brake behind it
                    if (Math.sign(lat) === side && Math.abs(lat) > 0.5) limit = Math.min(limit, Math.max(0, uo));
                } else if (this.skill.draft && straight && uo >= DRAFT_MIN_SPEED && along <= DRAFT_SEEK_RANGE && Math.abs(lat) < 2 * EVADE_OFFSET) {
                    // Its lane: where it is across the line
                    draftLat = carLat + lat;
                }
            }
            if (!blocked && !Number.isNaN(draftLat)) wanted = Math.max(-EVADE_OFFSET, Math.min(EVADE_OFFSET, draftLat));
        }
        const step = OFFSET_RATE * DT;
        this.offset += Math.max(-step, Math.min(step, wanted - this.offset));

        // Pure pursuit on the shifted line
        const ld = LOOKAHEAD_BASE + this.skill.lookaheadTime * Math.max(0, u);
        const at = pointAt(line, hit.s + ld, this.ahead);
        this.target.x = at.x + this.offset * at.tz;
        this.target.z = at.z - this.offset * at.tx;
        let steer = pursuitSteer(s, p, u, this.target.x, this.target.z, ld);
        // Facing against the line with the target behind (spun, or backed
        // off the wrong way): full lock towards it, where the pursuit arc
        // would drive on straight, away from the course
        const dx = this.target.x - s.x, dz = this.target.z - s.z;
        const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
        if (fx * hit.tx + fz * hit.tz < 0 && dx * fx + dz * fz < 0) steer = dx * fz - dz * fx > 0 ? 127 : -127;

        // Pedals like the road bots
        let throttle: number, brake: number;
        const error = limit - u;
        if (error >= 0) {
            throttle = Math.round(255 * Math.max(0, Math.min(1, 0.35 + error / 5)));
            brake = 0;
        } else if (error < -1.5 && u > 2) {
            throttle = 0;
            brake = Math.round(255 * Math.max(0, Math.min(1, -error / 6)));
        } else {
            throttle = 60;
            brake = 0;
        }
        this.delayed(steer, throttle, brake, out);
        // Traction control: off the throttle while the car slides (the
        // delayed pedal would otherwise spin a Beetle out of a corner exit)
        if (u > TRACTION_MIN_SPEED && Math.abs(wrapAngle(Math.atan2(s.vx, s.vz) - s.yaw)) > TRACTION_SLIP) out.throttle = 0;
        if (this.skill.boost && s.boostMeter >= BOOST_METER && !blocked && out.brake === 0
            && this.profileMin(hit.s, hit.s + STRAIGHT_AHEAD) >= p.topSpeed * 0.98) {
            out.buttons |= BTN_BOOST;
        }
        // Racing, the bot never means to stand: stuck is stuck, whatever it asks for
        this.stuck.watch(s, u, out, true);
        return out;
    }

    // The outputs of delayTicks ticks ago (reaction delay)
    private delayed(steer: number, throttle: number, brake: number, out: VehicleInput): void {
        const n = this.delaySteer.length;
        this.delaySteer[this.delayAt] = steer;
        this.delayThrottle[this.delayAt] = throttle;
        this.delayBrake[this.delayAt] = brake;
        const read = (this.delayAt + 1) % n;
        this.delayAt = read;
        out.steer = this.delaySteer[read];
        out.throttle = this.delayThrottle[read];
        out.brake = this.delayBrake[read];
    }

    // Smooth value noise in [-1, 1], one knot every NOISE_PERIOD_TICKS
    private noise(tick: number): number {
        const k = Math.floor(tick / NOISE_PERIOD_TICKS);
        if (k !== this.knotIndex) {
            this.knotA = k === this.knotIndex + 1 ? this.knotB : this.random() * 2 - 1;
            this.knotB = this.random() * 2 - 1;
            this.knotIndex = k;
        }
        const f = tick / NOISE_PERIOD_TICKS - k;
        const w = (1 - Math.cos(Math.PI * f)) / 2;
        return this.knotA + (this.knotB - this.knotA) * w;
    }

    private indexAt(s: number): number {
        return pointAt(this.course.line, s, this.ahead).index;
    }

    // Lowest profile speed on the line from s0 to s1
    private profileMin(s0: number, s1: number): number {
        const n = this.profile.length;
        const i0 = this.indexAt(s0), i1 = this.indexAt(s1);
        let min = this.profile[i0];
        for (let i = i0; i !== i1; i = (i + 1) % n) if (this.profile[i] < min) min = this.profile[i];
        return Math.min(min, this.profile[i1]);
    }

    private maxCurvature(s0: number, s1: number): number {
        const pts = this.course.line.points;
        const n = pts.length;
        const i0 = this.indexAt(s0), i1 = this.indexAt(s1);
        let max = 0;
        for (let i = i0; ; i = (i + 1) % n) {
            max = Math.max(max, Math.abs(pts[i].curvature));
            if (i === i1) break;
        }
        return max;
    }
}
