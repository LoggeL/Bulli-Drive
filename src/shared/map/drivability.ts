// Drivability estimates for building the map (docs/phase-3-design.md, 4,
// 13.2 and 15): how fast the car classes of the v2 sim can take a bend and
// how long a route takes them. A quasi-static point-mass model made from
// the class values in sim/vehicleClasses.ts and the sim's tuning, not a run
// of the sim: it answers "is this bend drivable at race pace" while the
// map is built. The sim's own tests cover the sim.
//
// Lateral limit of the v2 tyre model (vehicle.ts, step 2d): an axle carries
// at most grip·aero·Fz sideways, aero = 1 + aeroGrip·min(1, (v/vtop)²). In
// a steady bend each axle needs a share of the lateral force equal to its
// share of the load, so the weaker axle's grip limits the car. Surfaces
// scale the grip with table 8.1 and, off the paved ones, with the class's
// offroadGrip.

import { SIM_TUNING_DEFAULTS as T } from '../sim/constants.js';
import type { CarClassId } from '../sim/types.js';
import { CAR_CLASS_IDS, VEHICLE_CLASSES, type ClassParams } from '../sim/vehicleClasses.js';
import { isPaved, SURFACE, SURFACE_GRIP, SURFACE_ROLL } from './types.js';

export type CarModel = Pick<ClassParams,
    'gripFront' | 'gripRear' | 'aeroGrip' | 'topSpeed' | 'accel' | 'brakeDecel' | 'offroadGrip' | 'offroadDrag'>;

// Share of the grip a bend may need for the check: nobody drives a whole
// lap on the limit, and the racing line of phase 2 is not the centre line
export const CORNER_GRIP_MARGIN = 0.75;
// Speed (km/h) every bend of a road must allow unless its profile sets
// designSpeed: walking pace plus a margin, the slowest roads are the
// hairpins and the downtown crossings
export const DEFAULT_DESIGN_SPEED = 30;
export const KMH_PER_MS = 3.6;

// Lateral friction coefficient (in g) of the car's weaker axle on a
// surface. Water counts as undrivable here: the sim lets a car wade
// through shallow water, but no road or track may lead through it.
export function surfaceGrip(car: CarModel, surface: number): number {
    if (surface === SURFACE.water) return 0;
    const grip = Math.min(car.gripFront, car.gripRear) * (SURFACE_GRIP[surface] ?? 0);
    return isPaved(surface) ? grip : grip * car.offroadGrip;
}

// Highest speed (m/s) through a bend of the given curvature (1/m) that
// needs at most `margin` of the grip, capped at the class top speed.
// Solves v²·κ = margin·g·μ·(1 + aeroGrip·v²/vtop²) for v below vtop.
export function cornerSpeed(car: CarModel, curvature: number, surface: number, margin = CORNER_GRIP_MARGIN): number {
    const k = Math.abs(curvature);
    const a = margin * T.G_TIRE * surfaceGrip(car, surface);
    if (a <= 0) return 0;
    const vt = car.topSpeed;
    const denominator = k - a * car.aeroGrip / (vt * vt);
    if (denominator <= 0) return vt;
    return Math.min(vt, Math.sqrt(a / denominator));
}

export interface ClassSpeed { speed: number; car: CarClassId }

// The slowest class through the bend (ties: the first in CAR_CLASS_IDS)
export function weakestCornerSpeed(curvature: number, surface: number, margin = CORNER_GRIP_MARGIN): ClassSpeed {
    let best: ClassSpeed = { speed: Infinity, car: CAR_CLASS_IDS[0] };
    for (const id of CAR_CLASS_IDS) {
        const speed = cornerSpeed(VEHICLE_CLASSES[id], curvature, surface, margin);
        if (speed < best.speed) best = { speed, car: id };
    }
    return best;
}

// Longitudinal acceleration (m/s²) at speed v with full throttle: the
// drive of the sim (it covers the air and rolling drag below vtop), minus
// the rolling resistance of an unpaved surface and the slope
export function driveAcceleration(car: CarModel, v: number, surface: number, grade: number): number {
    const x = Math.min(1, Math.max(0, v / car.topSpeed));
    const roll = isPaved(surface) ? 0 : (SURFACE_ROLL[surface] ?? 0) * car.offroadDrag;
    return car.accel * (1 - Math.pow(x, T.DRIVE_EXP)) - roll - T.G_SLOPE * grade;
}

export interface ProfilePoint {
    // Station along the route (m), increasing
    s: number;
    curvature: number;
    surface: number;
    // Height (m); the grade between points follows from it
    y?: number;
}

export interface SpeedProfile {
    // Speed (m/s) at each point
    speeds: Float64Array;
    // Time (s) from the first to the last point
    time: number;
    // Index of the slowest point after the first
    slowest: number;
    // A climb the car cannot make: the index where it would stop, else -1
    stall: number;
}

// Below this the forward pass counts the car as stalled on a climb
const STALL_SPEED = 0.5;

// Speed along a route from a standing start (or startSpeed): each point
// allows at most its corner speed, the forward pass accelerates with
// driveAcceleration, the backward pass brakes with the class's brakeDecel
// (helped or hindered by the slope). Time integrates ds / mean speed.
export function speedProfile(car: CarModel, points: readonly ProfilePoint[], startSpeed = 0, margin = CORNER_GRIP_MARGIN): SpeedProfile {
    const n = points.length;
    const limit = new Float64Array(n);
    const grade = new Float64Array(n);
    for (let i = 0; i < n; i++) limit[i] = cornerSpeed(car, points[i].curvature, points[i].surface, margin);
    // Grade of the step from point i to i + 1
    for (let i = 0; i < n - 1; i++) {
        const a = points[i], b = points[i + 1];
        grade[i] = a.y !== undefined && b.y !== undefined && b.s > a.s ? (b.y - a.y) / (b.s - a.s) : 0;
    }
    const v = new Float64Array(n);
    v[0] = Math.min(startSpeed, limit[0]);
    let stall = -1;
    for (let i = 0; i < n - 1; i++) {
        const ds = points[i + 1].s - points[i].s;
        const a = driveAcceleration(car, v[i], points[i].surface, grade[i]);
        const next = Math.sqrt(Math.max(0, v[i] * v[i] + 2 * a * ds));
        v[i + 1] = Math.min(limit[i + 1], next);
        if (v[i + 1] < STALL_SPEED && stall < 0 && a < 0) stall = i + 1;
    }
    for (let i = n - 2; i >= 0; i--) {
        const ds = points[i + 1].s - points[i].s;
        const decel = Math.max(0.5, car.brakeDecel + T.G_SLOPE * grade[i]);
        v[i] = Math.min(v[i], Math.sqrt(v[i + 1] * v[i + 1] + 2 * decel * ds));
    }
    let time = 0, slowest = n > 1 ? 1 : 0;
    for (let i = 0; i < n - 1; i++) {
        const ds = points[i + 1].s - points[i].s;
        time += ds / Math.max(STALL_SPEED, (v[i] + v[i + 1]) / 2);
        if (v[i + 1] < v[slowest]) slowest = i + 1;
    }
    return { speeds: v, time, slowest, stall };
}
