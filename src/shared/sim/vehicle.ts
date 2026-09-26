// Per-car part of the v2 driving tick (docs/phase-1a-design.md, sections
// 6.4, 6.6 and 6.7): a single-track (bicycle) model with a normalised tyre
// curve, longitudinal load transfer and three assists (counter-steer, spin
// guard, slip-angle damping), plus the vertical motion on a spring-damper
// suspension (section 26), drift and boost.
//
// Conventions: forward f = (sin yaw, cos yaw), left l = (cos yaw, -sin yaw);
// steer > 0 and yawRate > 0 mean left. u = v·f, w = v·l, β = atan2(w, u).

import { MEGA_SCALE } from '../constants.js';
import { isPaved, SURFACE_GRIP, SURFACE_ROLL } from '../map/types.js';
import type { SimWorld } from '../world/colliders.js';
import { pushOutOfColliders, supportHeight } from './collision.js';
import { DRAFT_FILL } from '../race/rules.js';
import { BTN_BOOST, BTN_HANDBRAKE, BTN_RESET, DEG, DT, SIM_TUNING as T, V_ABS, V_SAFE } from './constants.js';
import { createVehicleParams } from './vehicleClasses.js';
import { tireCurve } from './tire.js';
import {
    createStepEvents, createVehicleInput, createVehicleModifiers, createVehicleState,
    type AssistProfile, type CarClassId, type SimCar, type VehicleParams, type VehicleState
} from './types.js';

// Half the spacing of the central differences for the ground gradient (m)
const GRADIENT_STEP = 0.5;
const COUNTER_STEER_FROM = 5 * DEG;
const DRIFT_ENTER = 10 * DEG;
const DRIFT_HOLD = 6 * DEG;
const DRIFT_EXIT_TICKS = 10;
const DRIFT_KICK_MIN_TICKS = 72;
const DRIFT_MIN_SPEED = 8;
const WALL_FILL_BLOCK_TICKS = 20;
const AIR_FILL_AFTER_TICKS = 18;
const SCALE_RATE = 6;
const TICK_COUNTER_MAX = 255;
const DRIFT_TICKS_MAX = 65535;
// Water (docs/phase-3-design.md, 7): a car whose underside is this far
// below the water level is in the water: no drive, no boost and a
// strong drag (1/s); after WATER_RESET_TICKS there it is reset onto the
// road (the racing line in a race). Shallower water drives like sand.
export const WATER_DEPTH = 0.6;
export const WATER_DRAG = 2.5;
export const WATER_RESET_TICKS = 60;

// Grip factor and rolling resistance (m/s²) of a surface for a car
// (docs/phase-3-design.md, 8.1, as drivability.ts estimates them): paved
// surfaces with their grip factor and no rolling resistance, unpaved ones
// with the class's offroad grip and drag on top
export function surfaceGrip(surface: number, p: VehicleParams): number {
    const g = SURFACE_GRIP[surface] ?? 1;
    return isPaved(surface) ? g : g * p.offroadGrip;
}

export function surfaceRoll(surface: number, p: VehicleParams): number {
    return isPaved(surface) ? 0 : (SURFACE_ROLL[surface] ?? 0) * p.offroadDrag;
}

/** True while the car is in the water (section 7). */
export function inWater(s: VehicleState, world: SimWorld): boolean {
    return world.waterLevel - s.y >= WATER_DEPTH;
}

function clamp(value: number, min: number, max: number): number {
    return value < min ? min : value > max ? max : value;
}

// An input axis clamped to its range; NaN and non-numbers count as 0, so a
// broken input cannot poison the sim (and through contacts every other car)
function inputAxis(value: number, min: number, max: number): number {
    return Number.isFinite(value) ? clamp(value, min, max) : 0;
}

// Ground gradient at (x, z) (module scratch): the exact slope of the ramp
// under the point, else central differences of the terrain alone, so the
// vertical step at a ramp's edge never reads as a slope
let gradX = 0;
let gradZ = 0;
function groundGradient(world: SimWorld, x: number, z: number): void {
    const ramp = world.rampAt(x, z);
    if (ramp >= 0) {
        const r = world.ramps[ramp];
        const slope = r.height / r.length;
        gradX = slope * Math.sin(r.yaw);
        gradZ = slope * Math.cos(r.yaw);
        return;
    }
    const inv = 1 / (2 * GRADIENT_STEP);
    gradX = (world.terrainHeight(x + GRADIENT_STEP, z) - world.terrainHeight(x - GRADIENT_STEP, z)) * inv;
    gradZ = (world.terrainHeight(x, z + GRADIENT_STEP) - world.terrainHeight(x, z - GRADIENT_STEP)) * inv;
}

function clampHorizontalSpeed(s: VehicleState, max: number): void {
    const speed = Math.sqrt(s.vx * s.vx + s.vz * s.vz);
    if (speed > max) {
        s.vx *= max / speed;
        s.vz *= max / speed;
    }
}

// Speed the boost pushes towards: vtop + BOOST_ADD, never above V_ABS
function boostTarget(topSpeed: number): number {
    return Math.min(topSpeed + T.BOOST_ADD, V_ABS);
}

export function createSimCar(id: string, classId: CarClassId, profile: AssistProfile = 'standard'): SimCar {
    const base = createVehicleParams(classId, profile);
    return {
        id,
        state: createVehicleState(),
        input: createVehicleInput(),
        base,
        params: { ...base },
        mods: createVehicleModifiers(),
        kinematic: false,
        contactScale: 1,
        events: createStepEvents(),
        contactDv: 0,
        contactDw: 0
    };
}

// Puts a car at rest on the ground at (x, z), e.g. at spawn. Unlike
// resetVehicle it neither pushes out of colliders nor starts a contact ghost.
export function placeVehicle(s: VehicleState, world: SimWorld, x: number, z: number, yaw: number): void {
    s.x = x;
    s.z = z;
    s.yaw = yaw;
    s.vx = s.vy = s.vz = s.yawRate = 0;
    s.y = world.groundHeight(x, z);
    s.grounded = true;
    s.airTicks = 0;
    s.susp = 0;
}

const FRESH_STATE = createVehicleState();

/**
 * A fresh car at (x, z) facing yaw, at rest on the ground, as the server
 * spawns and respawns cars (docs/phase-1b-design.md, 5.5): every filter,
 * counter and the boost start over, the contact ghost of a reset keeps it
 * from knocking a car away that stands there. Client and server call it
 * for the same tick, so the prediction starts from the server's state.
 */
export function spawnVehicle(s: VehicleState, world: SimWorld, x: number, z: number, yaw: number): void {
    Object.assign(s, FRESH_STATE);
    placeVehicle(s, world, x, z, yaw);
    s.ghostTicks = T.RESET_GHOST_TICKS;
}

// Reset (section 6.7): stop, stand on the ground, get out of any building
// and ghost other cars for two seconds. The yaw stays.
export function resetVehicle(s: VehicleState, p: VehicleParams, world: SimWorld): void {
    s.waterTicks = 0;
    s.vx = s.vy = s.vz = s.yawRate = 0;
    s.steerAngle = 0;
    s.loadX = 0;
    s.rearGrip = 1;
    s.betaPrev = 0;
    s.driftTicks = s.driftLowTicks = 0;
    s.boosting = false;
    s.draft = 0;
    s.y = world.groundHeight(s.x, s.z);
    s.grounded = true;
    s.airTicks = 0;
    s.susp = 0;
    pushOutOfColliders(s, p, world, 8);
    s.y = world.groundHeight(s.x, s.z);
    s.ghostTicks = T.RESET_GHOST_TICKS;
    s.ghostExit = 0;
}

// Tick steps 0-3: input, tyre forces and integration of the horizontal
// velocity (the position and the vertical motion move in stepWorld's
// substeps)
export function integrateForces(car: SimCar, world: SimWorld): void {
    const s = car.state, P = car.params, input = car.input, ev = car.events;

    // 0 Input
    const st = inputAxis(input.steer, -127, 127) / 127;
    const th = inputAxis(input.throttle, 0, 255) / 255;
    const br = inputAxis(input.brake, 0, 255) / 255;
    const buttons = input.buttons | 0;
    const handbrake = (buttons & BTN_HANDBRAKE) !== 0;
    s.resetHold = (buttons & BTN_RESET) !== 0 ? Math.min(s.resetHold + 1, T.RESET_HOLD_TICKS + 1) : 0;
    // In the water for a second, or fallen out of the map: the same reset
    // as the player's (docs/phase-3-design.md, 7 and 8.3)
    const wet = inWater(s, world);
    s.waterTicks = wet ? Math.min(s.waterTicks + 1, TICK_COUNTER_MAX) : 0;
    if (s.resetHold === T.RESET_HOLD_TICKS || s.waterTicks >= WATER_RESET_TICKS || s.y < world.fallLimit) {
        // The player's reset goes back onto the road (in a race world onto
        // the racing line); teleports and respawns call resetVehicle directly
        if (world.resetPose) world.resetPose(s);
        resetVehicle(s, P, world);
        ev.reset = true;
        return;
    }

    const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
    const lx = fz, lz = -fx;
    const u = s.vx * fx + s.vz * fz;
    const w = s.vx * lx + s.vz * lz;
    const beta = u > 1 ? Math.atan2(w, u) : 0;

    // The handbrake blend also runs in the air, so a handbrake held through
    // a landing starts a drift
    s.rearGrip = handbrake
        ? Math.max(P.handbrakeGrip, s.rearGrip - DT / T.HB_DROP_TIME)
        : Math.min(1, s.rearGrip + DT / T.HB_RECOVER_TIME);

    if (!s.grounded) {
        // 3 Air (section 26): no tyre forces, so no drive, brake, boost or
        // steering; air drag. A landing assist eases the yaw rate towards
        // AIR_ALIGN·β, so the nose turns into the flight direction and the
        // car lands without a slide. Gravity acts in the substeps
        // (stepVertical).
        s.yawRate += (T.AIR_ALIGN * beta - s.yawRate) * Math.min(1, T.AIR_YAW_RESPONSE * DT);
        const speed = Math.sqrt(s.vx * s.vx + s.vz * s.vz);
        const drag = 1 - T.C_AIR * speed * DT;
        s.vx *= drag;
        s.vz *= drag;
        clampHorizontalSpeed(s, V_SAFE);
        s.betaPrev = beta;
        s.airTicks = Math.min(s.airTicks + 1, TICK_COUNTER_MAX);
        return;
    }

    // 2a Steering: the lock shrinks with speed so full lock stays near the
    // slip peak; the counter-steer assist catches slides
    const absU = Math.abs(u);
    const lock = P.steerLock;
    let target = st * lock / (1 + absU / P.steerFalloff);
    if (u > 5 && Math.abs(beta) > COUNTER_STEER_FROM) {
        target += P.counterSteer * beta * (1 - 0.5 * Math.max(0, -st * Math.sign(beta)));
    }
    target = clamp(target, -lock, lock);
    const rate = Math.abs(target) < Math.abs(s.steerAngle) ? T.STEER_RATE_OUT : T.STEER_RATE_IN;
    s.steerAngle += clamp(target - s.steerAngle, -rate * DT, rate * DT);
    const delta = s.steerAngle;

    // 2b Axle loads with longitudinal load transfer
    const m = P.mass, L = P.wheelbase;
    const a = L * P.cgFront, b = L - a;
    const Fz = m * T.G_TIRE;
    const dF = clamp(T.LOAD_GAIN * m * s.loadX * P.cgHeight / L, -T.LOAD_MAX_FRONT * Fz, T.LOAD_MAX_REAR * Fz);
    const FzF = Fz * b / L - dF;
    const FzR = Fz * a / L + dF;

    // 2c Longitudinal: the drive also covers the resistance below vtop, so
    // vtop is exact and half throttle cruises
    const vtop = P.topSpeed;
    const xs = absU / vtop;
    const dragAcc = T.ROLL + T.C_AIR * u * u;
    // In the water the engine does nothing
    let aDrive = th > 0 && u > -0.5 && !wet
        ? th * (P.accel * Math.max(0, 1 - Math.pow(Math.min(xs, 1), T.DRIVE_EXP)) + (xs < 1 ? dragAcc : 0))
        : 0;
    let aBrake = 0;
    if (br > 0) {
        if (u > 0.5) {
            aBrake = br * P.brakeDecel;
            s.reverseHold = 0;
        } else {
            s.reverseHold = Math.min(s.reverseHold + 1, TICK_COUNTER_MAX);
            if (s.reverseHold >= T.REVERSE_HOLD_TICKS) {
                aDrive -= br * (T.REV_ACCEL * (1 - Math.max(0, -u) / T.REV_TOP) + dragAcc);
            } else {
                aBrake = br * P.brakeDecel;
            }
        }
    } else {
        s.reverseHold = 0;
    }
    // Throttle while rolling backwards brakes, like the brake does forwards
    if (th > 0 && u < -0.5) aBrake += th * P.brakeDecel;
    const vRef = s.boosting ? boostTarget(vtop) : vtop;
    // Above vtop the boost takes over covering the drag, so the boost target
    // is reached like vtop is (approached from below, never above V_ABS)
    if (s.boosting && u > 0) {
        aDrive += T.BOOST_ACCEL * clamp((vRef - u) / 10, 0, 1) + (xs >= 1 && u < vRef ? dragAcc : 0);
    }
    // Surface under the axles (docs/phase-3-design.md, 8.1): grip factor
    // per axle, rolling resistance of both
    const cOff = P.colliderOffset;
    const surfaceF = world.surfaceAt(s.x + cOff * fx, s.z + cOff * fz);
    const surfaceR = world.surfaceAt(s.x - cOff * fx, s.z - cOff * fz);
    const roll = (surfaceRoll(surfaceF, P) + surfaceRoll(surfaceR, P)) * 0.5;
    const aResist = dragAcc + (th === 0 && br === 0 ? T.ENGINE_BRAKE : 0) + Math.max(0, absU - vRef) * T.OVERSPEED + roll;
    if (handbrake && th < 0.1) aBrake += T.HB_DECEL;
    const Fx = m * aDrive;
    const FxR = P.drive === 'rear' ? Fx : Fx / 2;
    const FxF = P.drive === 'rear' ? 0 : Fx / 2;
    // Brake and handbrake stay out of the grip circle; oversteer on braking
    // comes from the load transfer alone

    // 2d Lateral tyre forces
    const speed = Math.sqrt(u * u + w * w);
    const vtopBase = car.base.topSpeed;
    const aero = 1 + P.aeroGrip * Math.min(1, (speed / vtopBase) * (speed / vtopBase));
    const capF = T.gripScale * P.gripFront * aero * FzF * surfaceGrip(surfaceF, P);
    const capR = T.gripScale * P.gripRear * aero * s.rearGrip * FzR * surfaceGrip(surfaceR, P);
    const circF = Math.sqrt(Math.max(0.1, 1 - (T.GRIP_CIRCLE * FxF / capF) ** 2));
    const circR = Math.sqrt(Math.max(0.1, 1 - (T.GRIP_CIRCLE * FxR / capR) ** 2));
    const uu = Math.max(absU, T.V_LOW);
    const sgn = u < -0.5 ? -1 : 1;
    const r = s.yawRate;
    const alphaF = Math.atan2(w + a * r, uu) - delta * sgn;
    const alphaR = Math.atan2(w - b * r, uu);
    const FyF = -capF * circF * tireCurve(alphaF, P.slipPeakFront, P.slideFront);
    const FyR = -capR * circR * tireCurve(alphaR, P.slipPeakRear, P.slideRear);

    // 2e Body forces, torque and assists
    const cd = Math.cos(delta), sd = Math.sin(delta);
    const Fu = FxR + FxF * cd - FyF * sd;
    const Fw = FyR + FyF * cd + FxF * sd;
    const I = m * P.yawRadius * P.yawRadius;
    let tau = a * (FyF * cd + FxF * sd) - b * FyR;
    const absBeta = Math.abs(beta);
    // Spin guard: turns the nose back towards the travel direction
    if (absBeta > P.spinGuardAngle) tau += T.K_SPIN * I * Math.sign(beta) * (absBeta - P.spinGuardAngle);
    // Slip-angle damping: without it a drift swings between 11° and 78°
    if (u > 5 && absBeta > T.BETA_DAMP_FROM) tau += T.K_BD * I * (beta - s.betaPrev) / DT;
    if (T.yawDampHigh > 0 && u > 50) tau -= T.yawDampHigh * I * (r - u * Math.tan(delta) / L) * (u - 50) / 35;
    s.betaPrev = beta;
    // A car standing on a low collider (above the ground) stands on a flat top
    if (s.y > world.groundHeight(s.x, s.z)) gradX = gradZ = 0;
    else groundGradient(world, s.x, s.z);
    const auSlope = -T.G_SLOPE * (gradX * fx + gradZ * fz);
    const awSlope = -T.G_SLOPE * (gradX * lx + gradZ * lz);

    // 2f Semi-implicit integration in the car frame
    let nu = u + (Fu / m + auSlope) * DT;
    // Brakes and resistance slow down but never reverse
    nu -= Math.sign(nu) * Math.min(Math.abs(nu), (aBrake + aResist) * DT);
    let nw = w + (Fw / m + awSlope) * DT;
    s.loadX += ((nu - u) / DT - s.loadX) * (1 - Math.exp(-DT / T.LOAD_TAU));
    let nr = r + tau / I * DT;
    // Kinematic blend at low speed, where the slip angles are ill-defined.
    // It hangs on the total speed: a car sliding sideways (u ≈ 0) after a
    // hit from the side is slowed by its tyres, not stopped dead.
    const k = clamp(1 - Math.sqrt(nu * nu + nw * nw) / T.V_LOW, 0, 1);
    nr += (nu * Math.tan(delta) / L - nr) * k;
    nw -= nw * k * Math.min(1, 10 * DT);
    if (Math.abs(nu) < 0.05 && th === 0 && br === 0) {
        nu = 0;
        if (Math.abs(nw) < 0.05) nw = 0;
    }
    if (wet) {
        const keep = Math.exp(-WATER_DRAG * DT);
        nu *= keep;
        nw *= keep;
        nr *= keep;
    }
    s.yawRate = clamp(nr, -T.R_MAX, T.R_MAX);
    s.vx = fx * nu + lx * nw;
    s.vz = fz * nu + lz * nw;
    clampHorizontalSpeed(s, V_SAFE);
}

// Vertical motion for one substep of dt (section 26), after the car moved
// in the XZ plane: the body rides on a spring-damper suspension over the
// ground under the car (terrain, ramp or the top of a low collider it
// stands on or comes down onto, section 7.3). The wheels stay on the ground
// while the spring pushes (their force cannot pull), so the car leaves a
// crest by itself once v²·κ exceeds GRAVITY, and a landing is caught by the
// spring and the bump stop instead of a snap. s.y is the underside at the
// wheels: the ground height while they touch it.
export function stepVertical(car: SimCar, world: SimWorld, dt: number): void {
    const s = car.state, ev = car.events;
    let hN = world.groundHeight(s.x, s.z);
    const hTop = supportHeight(car, world);
    const onTop = hTop > hN;
    if (onTop) hN = hTop;
    const g = T.GRAVITY;
    const omega = 2 * Math.PI * T.SUSP_FREQ;
    const k = omega * omega;
    // The spring's full extension: its force is g at rest (susp = 0) and 0 here
    const extension = g / k;

    if (!s.grounded) {
        s.vy -= g * dt;
        s.y += s.vy * dt;
        if (s.y > hN) return;
        // Touch down: the wheels land on the ground, the body is still at the
        // full extension above them and the spring takes over
        if (onTop) gradX = gradZ = 0;
        else groundGradient(world, s.x, s.z);
        // Vertical speed relative to the surface
        const impact = gradX * s.vx + gradZ * s.vz - s.vy;
        if (impact > ev.landedImpact) ev.landedImpact = impact;
        if (impact > 10) {
            const keep = 1 - 0.15 * clamp((impact - 10) / 15, 0, 1);
            s.vx *= keep;
            s.vz *= keep;
        }
        s.susp = s.y + extension - hN;
        s.y = hN;
        s.grounded = true;
        s.airTicks = 0;
        return;
    } else {
        // The body keeps its height while the ground under the wheels changes
        s.susp += s.y - hN;
        s.y = hN;
    }

    // On the ground: vertical speed of the ground under the moving car
    if (onTop) gradX = gradZ = 0;
    else groundGradient(world, s.x, s.z);
    // Bump stop: the body moves with the ground (no bounce)
    if (s.susp < -T.SUSP_TRAVEL) {
        s.susp = -T.SUSP_TRAVEL;
        bumpStop(s);
    }
    // Spring and damper per unit mass; the wheels cannot pull the body down
    const vGround = gradX * s.vx + gradZ * s.vz;
    const force = g - k * s.susp + 2 * T.SUSP_DAMPING * omega * (vGround - s.vy);
    const dvy = ((force > 0 ? force : 0) - g) * dt;
    s.vy += dvy;
    // On a steep flank the push that speeds the body up (beyond holding it
    // against gravity) comes from the car's speed along the grade: it takes
    // (∇h·v̂)·Δvy off the speed, along the travel direction, exactly the
    // energy the push adds (vy ≈ ∇h·v), so a flank cannot add energy
    // (26.9). Along the travel only: a sideways share would make a car
    // crossing a bumpy bank drift down it. Faded in from FLANK_FROM to
    // FLANK_FULL grade: roads and ramps stay below it and drive as before.
    if (dvy > 0) {
        const share = clamp((Math.sqrt(gradX * gradX + gradZ * gradZ) - T.FLANK_FROM) / (T.FLANK_FULL - T.FLANK_FROM), 0, 1);
        const v2 = s.vx * s.vx + s.vz * s.vz;
        if (share > 0 && v2 > 1e-6) {
            const cut = (gradX * s.vx + gradZ * s.vz) / v2 * dvy * share;
            s.vx -= cut * s.vx;
            s.vz -= cut * s.vz;
        }
    }
    s.susp += s.vy * dt;
    if (s.susp < -T.SUSP_TRAVEL) {
        s.susp = -T.SUSP_TRAVEL;
        bumpStop(s);
    } else if (s.susp > extension + T.SUSP_LIFT) {
        // The body rose clearly above the full extension: the wheels leave
        // the ground. Up to SUSP_LIFT above it they still touch without load
        // (the spring cannot pull), so a washboard does not cut the drive
        // and the steering for single ticks (26.9).
        s.y += s.susp - extension;
        s.susp = extension;
        s.grounded = false;
        s.airTicks = 0;
    }
}

// The body on its bump stop is hit by the ground under the moving car
// (gradient in gradX/gradZ): an inelastic push along the ground's normal
// n = (-∇h, 1) takes away the velocity component into the ground, so the
// body moves along the surface afterwards (vy = ∇h·v). On a grade s the car
// keeps 1/(1 + s²) of its speed into the grade and turns the rest upwards
// (at 100 %: half and half), instead of gaining s·v upwards for free.
function bumpStop(s: VehicleState): void {
    const into = gradX * s.vx + gradZ * s.vz - s.vy;
    if (into <= 0) return;
    const lambda = into / (1 + gradX * gradX + gradZ * gradZ);
    s.vy += lambda;
    s.vx -= gradX * lambda;
    s.vz -= gradZ * lambda;
}

// Tick step 6 with the final position: drift, boost and timers
export function finishTick(car: SimCar): void {
    const s = car.state, P = car.params, ev = car.events;

    // 6 Drift (with hysteresis), boost meter, timers
    const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
    const u = s.vx * fx + s.vz * fz;
    const w = s.vx * fz - s.vz * fx;
    const absBeta = u > 1 ? Math.abs(Math.atan2(w, u)) : 0;
    if (s.grounded && u > DRIFT_MIN_SPEED && absBeta > DRIFT_ENTER) {
        s.driftTicks = Math.min(s.driftTicks + 1, DRIFT_TICKS_MAX);
        s.driftLowTicks = 0;
    } else if (s.driftTicks > 0) {
        if (absBeta >= DRIFT_HOLD) {
            s.driftLowTicks = 0;
        } else {
            s.driftLowTicks++;
        }
        if (s.driftLowTicks >= DRIFT_EXIT_TICKS) {
            // Optional mini turbo after a long drift, at most up to vtop
            if (T.driftReleaseKick > 0 && s.driftTicks >= DRIFT_KICK_MIN_TICKS) {
                const kick = Math.min(T.driftReleaseKick, Math.max(0, P.topSpeed - u));
                s.vx += fx * kick;
                s.vz += fz * kick;
            }
            s.driftTicks = 0;
            s.driftLowTicks = 0;
        } else {
            s.driftTicks = Math.min(s.driftTicks + 1, DRIFT_TICKS_MAX);
        }
    }
    ev.drifting = s.driftTicks > 0;

    let fill = s.grounded
        ? T.DRIFT_FILL * P.driftFill
            * clamp((absBeta - DRIFT_ENTER) / (15 * DEG), 0, 1)
            * clamp((u - DRIFT_MIN_SPEED) / 12, 0, 1)
        : 0;
    // Scrubbing along a wall does not count
    if (s.wallTicks < WALL_FILL_BLOCK_TICKS) fill = 0;
    if (!s.grounded && s.airTicks > AIR_FILL_AFTER_TICKS) fill += T.AIR_FILL;
    // The slipstream fills the meter too (docs/phase-2-design.md, 13)
    fill += DRAFT_FILL * s.draft;
    s.boostMeter = Math.min(1, s.boostMeter + fill * DT);
    const wasBoosting = s.boosting;
    // In the air the boost gives no thrust (26.3): it cannot start there and
    // drains nothing; one held through a flight carries on after the landing
    s.boosting = (car.input.buttons & BTN_BOOST) !== 0 && u > 0 && s.waterTicks === 0
        && (wasBoosting ? s.boostMeter > 0 : s.grounded && s.boostMeter >= T.BOOST_MIN);
    ev.boostStarted = s.boosting && !wasBoosting;
    if (s.boosting && s.grounded) s.boostMeter = Math.max(0, s.boostMeter - T.BOOST_DRAIN * DT);

    if (s.ghostTicks > 0) s.ghostTicks--;
    if (s.ghostExit > 0) s.ghostExit--;
    s.wallTicks = Math.min(TICK_COUNTER_MAX, s.wallTicks + 1);
    const targetScale = car.mods.mega ? MEGA_SCALE : 1;
    s.scale += (targetScale - s.scale) * (1 - Math.exp(-SCALE_RATE * DT));
    if (Math.abs(targetScale - s.scale) < 1e-4) s.scale = targetScale;
    s.wasGhost = car.mods.ghost;
}
