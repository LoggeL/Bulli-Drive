// Per-car part of the v2 driving tick (docs/phase-1a-design.md, sections
// 6.4, 6.6 and 6.7): a single-track (bicycle) model with a normalised tyre
// curve, longitudinal load transfer and three assists (counter-steer, spin
// guard, slip-angle damping), plus ground contact, jump, drift and boost.
//
// Conventions: forward f = (sin yaw, cos yaw), left l = (cos yaw, -sin yaw);
// steer > 0 and yawRate > 0 mean left. u = v·f, w = v·l, β = atan2(w, u).

import { MEGA_SCALE } from '../constants.js';
import type { RoadGrid, SimWorld } from '../world/colliders.js';
import { pushOutOfColliders, supportHeight } from './collision.js';
import { BTN_BOOST, BTN_HANDBRAKE, BTN_JUMP, BTN_RESET, DEG, DT, SIM_TUNING as T, V_ABS, V_SAFE } from './constants.js';
import { createVehicleParams } from './vehicleClasses.js';
import { tireCurve } from './tire.js';
import {
    createStepEvents, createVehicleInput, createVehicleModifiers, createVehicleState,
    type AssistProfile, type CarClassId, type SimCar, type VehicleParams, type VehicleState
} from './types.js';

const TWO_PI = Math.PI * 2;
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
// From terrain onto terrain the car takes off with at most the ground's
// vertical speed ahead plus this (m/s), so a kink in the heightfield (the
// edge of the city's blend ring) does not launch it; ramps keep their speed
const TERRAIN_LAUNCH_MARGIN = 2;

function clamp(value: number, min: number, max: number): number {
    return value < min ? min : value > max ? max : value;
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
}

// Moves a car that is reset near the road grid onto the nearest road
// centre line, facing along the road in the direction closest to its yaw
export function moveToRoad(s: VehicleState, roads: RoadGrid): boolean {
    let best = roads.snapRange * roads.snapRange;
    let found = false, bx = 0, bz = 0, northSouth = true;
    const alongZ = clamp(s.z, roads.minZ, roads.maxZ);
    for (const lineX of roads.xLines) {
        const d2 = (s.x - lineX) ** 2 + (s.z - alongZ) ** 2;
        if (d2 < best) { best = d2; found = true; bx = lineX; bz = alongZ; northSouth = true; }
    }
    const alongX = clamp(s.x, roads.minX, roads.maxX);
    for (const lineZ of roads.zLines) {
        const d2 = (s.x - alongX) ** 2 + (s.z - lineZ) ** 2;
        if (d2 < best) { best = d2; found = true; bx = alongX; bz = lineZ; northSouth = false; }
    }
    if (!found) return false;
    s.x = bx;
    s.z = bz;
    // Forward is (sin yaw, cos yaw): 0/π run along z, ±π/2 along x
    s.yaw = northSouth
        ? (Math.cos(s.yaw) >= 0 ? 0 : Math.PI)
        : (Math.sin(s.yaw) >= 0 ? Math.PI / 2 : -Math.PI / 2);
    return true;
}

// Reset (section 6.7): stop, stand on the ground, get out of any building
// and ghost other cars for two seconds. The yaw stays.
export function resetVehicle(s: VehicleState, p: VehicleParams, world: SimWorld): void {
    s.vx = s.vy = s.vz = s.yawRate = 0;
    s.steerAngle = 0;
    s.loadX = 0;
    s.rearGrip = 1;
    s.betaPrev = 0;
    s.flipAngle = s.flipRate = 0;
    s.driftTicks = s.driftLowTicks = 0;
    s.boosting = false;
    s.y = world.groundHeight(s.x, s.z);
    s.grounded = true;
    s.airTicks = 0;
    pushOutOfColliders(s, p, world, 8);
    s.y = world.groundHeight(s.x, s.z);
    s.ghostTicks = T.RESET_GHOST_TICKS;
    s.ghostExit = 0;
}

// Tick steps 0-3: input, jump, tyre forces and integration of the velocity
// (the position moves in stepWorld's substeps)
export function integrateForces(car: SimCar, world: SimWorld): void {
    const s = car.state, P = car.params, input = car.input, ev = car.events;

    // 0 Input
    const st = clamp(input.steer, -127, 127) / 127;
    const th = clamp(input.throttle, 0, 255) / 255;
    const br = clamp(input.brake, 0, 255) / 255;
    const buttons = input.buttons | 0;
    const pressed = buttons & ~s.prevButtons;
    s.prevButtons = buttons;
    const handbrake = (buttons & BTN_HANDBRAKE) !== 0;
    s.resetHold = (buttons & BTN_RESET) !== 0 ? Math.min(s.resetHold + 1, T.RESET_HOLD_TICKS + 1) : 0;
    if (s.resetHold === T.RESET_HOLD_TICKS) {
        // The player's reset goes back onto the road; teleports and
        // respawns call resetVehicle directly
        if (world.roads) moveToRoad(s, world.roads);
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

    // 1 Jump (edge-triggered, with coyote time after leaving the ground)
    if ((pressed & BTN_JUMP) !== 0 && s.jumpCooldown === 0 && (s.grounded || s.airTicks <= T.COYOTE_TICKS)) {
        s.vy = Math.max(s.vy, 0) + P.jumpSpeed;
        s.grounded = false;
        s.jumpCooldown = T.JUMP_COOLDOWN;
        // One full flip over the flight time
        s.flipRate = TWO_PI / (2 * P.jumpSpeed / T.G_AIR);
        s.flipAngle = 1e-6;
        ev.jumped = true;
    }

    if (!s.grounded) {
        // 3 Air: gravity, gentle yaw control, air drag, half the boost
        s.vy -= T.G_AIR * DT;
        s.yawRate += (st * T.AIR_YAW - s.yawRate) * Math.min(1, 3 * DT);
        const speed = Math.sqrt(s.vx * s.vx + s.vz * s.vz);
        const drag = 1 - T.C_AIR * speed * DT;
        s.vx *= drag;
        s.vz *= drag;
        if (s.boosting) {
            const push = T.BOOST_ACCEL * 0.5 * DT * clamp((boostTarget(P.topSpeed) - u) / 10, 0, 1);
            s.vx += fx * push;
            s.vz += fz * push;
        }
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
    let aDrive = th > 0 && u > -0.5
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
    const aResist = dragAcc + (th === 0 && br === 0 ? T.ENGINE_BRAKE : 0) + Math.max(0, absU - vRef) * T.OVERSPEED;
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
    const capF = T.gripScale * P.gripFront * aero * FzF;
    const capR = T.gripScale * P.gripRear * aero * s.rearGrip * FzR;
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
    // Kinematic blend at low speed, where the slip angles are ill-defined
    const k = clamp(1 - Math.abs(nu) / T.V_LOW, 0, 1);
    nr += (nu * Math.tan(delta) / L - nr) * k;
    nw -= nw * k * Math.min(1, 10 * DT);
    if (Math.abs(nu) < 0.05 && th === 0 && br === 0) {
        nu = 0;
        if (Math.abs(nw) < 0.05) nw = 0;
    }
    s.yawRate = clamp(nr, -T.R_MAX, T.R_MAX);
    s.vx = fx * nu + lx * nw;
    s.vz = fz * nu + lz * nw;
    clampHorizontalSpeed(s, V_SAFE);
}

// Tick steps 5-6 with the final position: ground and vertical motion,
// drift, boost and timers
export function finishTick(car: SimCar, world: SimWorld): void {
    const s = car.state, P = car.params, ev = car.events;

    // 5 Ground: terrain or ramp, or the top of a low collider the car
    // stands on or comes down onto (section 7.3)
    let hN = world.groundHeight(s.x, s.z);
    const hTop = supportHeight(car, world);
    const onTop = hTop > hN;
    if (onTop) hN = hTop;
    if (s.grounded) {
        let yBall = s.y + s.vy * DT - 0.5 * (T.G_AIR + T.STICK) * DT * DT;
        if (yBall > hN + T.AIR_GAP && !onTop
            && world.rampAt(s.x, s.z) < 0 && world.rampAt(s.x - s.vx * DT, s.z - s.vz * DT) < 0) {
            // Terrain onto terrain: keep at most the vertical speed of the
            // ground ahead, so only a real crest lifts the car
            const vyAhead = (world.terrainHeight(s.x + s.vx * DT, s.z + s.vz * DT) - hN) / DT;
            if (s.vy > vyAhead + TERRAIN_LAUNCH_MARGIN) {
                s.vy = vyAhead + TERRAIN_LAUNCH_MARGIN;
                yBall = s.y + s.vy * DT - 0.5 * (T.G_AIR + T.STICK) * DT * DT;
            }
        }
        if (yBall > hN + T.AIR_GAP) {
            // Ramp edge or crest: the car takes off with its vertical speed
            s.grounded = false;
            s.airTicks = 0;
            s.y += s.vy * DT - 0.5 * T.G_AIR * DT * DT;
            s.vy -= T.G_AIR * DT;
        } else {
            s.vy = clamp((hN - s.y) / DT, -30, 25);
            s.y = hN;
        }
    } else {
        // vy was integrated in step 3 already
        s.y += s.vy * DT;
        if (s.y <= hN) {
            if (onTop) gradX = gradZ = 0;
            else groundGradient(world, s.x, s.z);
            // Vertical speed relative to the surface
            const impact = -(s.vy - (gradX * s.vx + gradZ * s.vz));
            ev.landedImpact = impact;
            s.y = hN;
            s.grounded = true;
            s.airTicks = 0;
            if (impact > 10) {
                const keep = 1 - 0.15 * clamp((impact - 10) / 15, 0, 1);
                s.vx *= keep;
                s.vz *= keep;
            }
            s.vy = 0;
            // The renderer turns the rest of an unfinished flip within 6 frames
            s.flipAngle = 0;
        }
    }
    if (s.flipAngle > 0) {
        s.flipAngle += s.flipRate * DT;
        if (s.flipAngle >= TWO_PI) s.flipAngle = 0;
    }

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
    s.boostMeter = Math.min(1, s.boostMeter + fill * DT);
    const wasBoosting = s.boosting;
    s.boosting = (car.input.buttons & BTN_BOOST) !== 0 && u > 0
        && (wasBoosting ? s.boostMeter > 0 : s.boostMeter >= T.BOOST_MIN);
    ev.boostStarted = s.boosting && !wasBoosting;
    if (s.boosting) s.boostMeter = Math.max(0, s.boostMeter - T.BOOST_DRAIN * DT);

    if (s.jumpCooldown > 0) s.jumpCooldown--;
    if (s.ghostTicks > 0) s.ghostTicks--;
    if (s.ghostExit > 0) s.ghostExit--;
    s.wallTicks = Math.min(TICK_COUNTER_MAX, s.wallTicks + 1);
    const targetScale = car.mods.mega ? MEGA_SCALE : 1;
    s.scale += (targetScale - s.scale) * (1 - Math.exp(-SCALE_RATE * DT));
    if (Math.abs(targetScale - s.scale) < 1e-4) s.scale = targetScale;
    s.wasGhost = car.mods.ghost;
}
