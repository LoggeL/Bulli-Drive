import { describe, expect, it } from 'vitest';
import { SURFACE } from '../../../src/shared/map/types.js';
import {
    BTN_BOOST, BTN_HANDBRAKE, BTN_RESET, DEG, DT, SIM_TUNING as T, SUBSTEPS, V_ABS
} from '../../../src/shared/sim/constants.js';
import {
    SIM_SURFACE_ICE, SIM_SURFACE_SNOW, surfaceDriftFill, surfaceGrip, surfacePhysics, surfaceRoll, surfaceYawDamp
} from '../../../src/shared/sim/surfaces.js';
import { copyVehicleState, createVehicleState, type CarClassId } from '../../../src/shared/sim/types.js';
import {
    DRIFT_TIER1_TICKS, DRIFT_TIER2_TICKS, DRIFT_TIER3_TICKS,
    driftKickSpeed, driftKickTier, effectiveSuspension, stepVertical
} from '../../../src/shared/sim/vehicle.js';
import { CAR_CLASS_IDS, VEHICLE_CLASSES } from '../../../src/shared/sim/vehicleClasses.js';
import { stepVehicle } from '../../../src/shared/sim/world.js';
import {
    createSimWorld, insideBoostPad, type BoostPadVolume, type GroundModel, type SimWorld
} from '../../../src/shared/world/colliders.js';
import { createLongWorld, drive, forwardSpeed, launch, restoreTuningAfterEach, slipAngle, spawnCar, speedOf } from './helpers.js';

// Non-tautological physics & handling tests covering:
//  1. Per-class suspension & progressive rubber bump-stop landing cushion
//  2. Tiered drift release mini-turbo & steering/drift feel
//  3. Snow (10) & Ice (11) surface physics and StepEvents surface telemetry
//  4. Deterministic boost pads (geometry, impulse, cap, cooldown, rewind)

interface SurfaceWorldOpts {
    height?: (x: number, z: number) => number;
    surface?: (x: number, z: number) => number;
    waterLevel?: number;
    boostPads?: readonly BoostPadVolume[];
}

function surfaceWorld(opts: SurfaceWorldOpts = {}): SimWorld {
    const ground: GroundModel = {
        height: opts.height ?? (() => 0),
        surface: opts.surface ?? (() => SURFACE.asphalt),
        waterLevel: opts.waterLevel ?? -Infinity,
        fallLimit: -Infinity,
        bound: 4000,
        grid: { origin: -4000, cellSize: 64, cells: 125 }
    };
    return createSimWorld(ground, [], [], opts.boostPads ?? []);
}

describe('per-class suspension and landing cushion', () => {
    restoreTuningAfterEach();

    it('gives each vehicle class distinct spring frequency, travel, and chassis roll/pitch character', () => {
        const { bulli, pickup, sport, beetle, jeep } = VEHICLE_CLASSES;
        // Stiffness ordering: Sport stiffest -> nimble Beetle -> Pickup -> plush Bulli -> soft Jeep
        expect(sport.suspFreq).toBeGreaterThan(beetle.suspFreq);
        expect(beetle.suspFreq).toBeGreaterThan(pickup.suspFreq);
        expect(pickup.suspFreq).toBeGreaterThan(bulli.suspFreq);
        expect(bulli.suspFreq).toBeGreaterThan(jeep.suspFreq);
        // Travel ordering: Sport shortest -> Beetle -> Pickup -> Bulli -> Jeep longest
        expect(sport.suspTravel).toBeLessThan(beetle.suspTravel);
        expect(beetle.suspTravel).toBeLessThan(pickup.suspTravel);
        expect(pickup.suspTravel).toBeLessThan(bulli.suspTravel);
        expect(bulli.suspTravel).toBeLessThan(jeep.suspTravel);
        // Iconic lean ordering: planted Porsche 356 Sport leans least, plush Bulli leans most
        expect(sport.rollGain).toBeLessThan(pickup.rollGain);
        expect(pickup.rollGain).toBeLessThan(jeep.rollGain);
        expect(jeep.rollGain).toBeLessThan(bulli.rollGain);
        expect(sport.pitchGain).toBeLessThan(pickup.pitchGain);
        expect(pickup.pitchGain).toBeLessThan(bulli.pitchGain);
    });

    it('accelerates compressed cars by their hand-calculated per-class spring stiffness (2πf)²·|susp|', () => {
        // -0.10 m is inside the linear 60 % travel zone for every class (0.6 · 0.18 = 0.108 m).
        // With vy = 0 on flat ground, Hooke's law gives Δvy = (2πf)² · 0.10 · dt.
        const world = createLongWorld();
        const subDt = DT / SUBSTEPS;
        const singleStepVy = (classId: CarClassId) => {
            const car = spawnCar(world, classId, classId, 0, 0, 0);
            car.state.susp = -0.10;
            car.state.vy = 0;
            stepVertical(car, world, subDt);
            return car.state.vy;
        };

        const sportVy = singleStepVy('sport');
        const bulliVy = singleStepVy('bulli');
        const jeepVy = singleStepVy('jeep');

        expect(sportVy).toBeCloseTo((2 * Math.PI * 2.55) ** 2 * 0.10 * subDt, 10);
        expect(bulliVy).toBeCloseTo((2 * Math.PI * 1.85) ** 2 * 0.10 * subDt, 10);
        expect(jeepVy).toBeCloseTo((2 * Math.PI * 1.70) ** 2 * 0.10 * subDt, 10);
        // Exact analytical ratio (2.55 / 1.70)² = 2.25
        expect(sportVy / jeepVy).toBeCloseTo((2.55 / 1.70) ** 2, 10);
    });

    it('ramps up stiffness and compression-only damping progressively past 60 % travel', () => {
        // Sport travel = 0.18 m -> cushion begins at -0.108 m (60 %).
        // At -0.162 m (90 % travel): u = (0.162 - 0.108) / (0.4 · 0.18) = 0.75.
        // Hand-calculated: kEff = k · (1 + 1.5 · 0.75²) = 1.84375 · k;
        // compression damping (vy < 0 => vRel > 0) scales by (1 + 0.5 · 0.75) = 1.375,
        // while rebound (vy > 0 => vRel < 0) keeps base damping.
        const world = createLongWorld();
        const subDt = DT / SUBSTEPS;
        const omega = 2 * Math.PI * 2.55;
        const k = omega * omega;
        const zeta = 0.92;

        // Static deep compression (vy = 0): stiffness alone
        const staticDeep = spawnCar(world, 's1', 'sport', 0, 0, 0);
        staticDeep.state.susp = -0.162;
        staticDeep.state.vy = 0;
        stepVertical(staticDeep, world, subDt);
        const expectedStaticDvy = (1.84375 * k * 0.162) * subDt;
        const linearStaticDvy = (k * 0.162) * subDt;
        expect(staticDeep.state.vy).toBeCloseTo(expectedStaticDvy, 10);
        expect(staticDeep.state.vy).toBeGreaterThan(linearStaticDvy * 1.8);

        // Compressing downward (vy = -4 m/s, vRel = +4): extra compression damping applies
        const compressing = spawnCar(world, 's2', 'sport', 0, 0, 0);
        compressing.state.susp = -0.162;
        compressing.state.vy = -4;
        stepVertical(compressing, world, subDt);
        const expectedCompDvy = (1.84375 * k * 0.162 + 2 * (1.375 * zeta) * omega * 4) * subDt;
        expect(compressing.state.vy - (-4)).toBeCloseTo(expectedCompDvy, 10);

        // Rebounding upward (vy = +4 m/s, vRel = -4): base damping only (no rebound stickiness)
        const rebounding = spawnCar(world, 's3', 'sport', 0, 0, 0);
        rebounding.state.susp = -0.162;
        rebounding.state.vy = 4;
        stepVertical(rebounding, world, subDt);
        const forceReb = Math.max(0, T.GRAVITY + 1.84375 * k * 0.162 + 2 * zeta * omega * (-4));
        const expectedRebDvy = (forceReb - T.GRAVITY) * subDt;
        expect(rebounding.state.vy - 4).toBeCloseTo(expectedRebDvy, 10);
    });

    it('lands cleanly without bounce-back from 3 m and 10 m drops across all 5 classes', () => {
        const world = createLongWorld();
        for (const dropHeight of [3, 10]) {
            const minSuspByClass: Record<string, number> = {};
            for (const classId of CAR_CLASS_IDS) {
                const car = spawnCar(world, classId, classId, 0, 0, 0, 20);
                car.state.y = dropHeight;
                car.state.grounded = false;
                let landed = false;
                let bouncedAfterLanding = false;
                let minSusp = 0;
                drive(car, world, 240, { throttle: 128 }, () => {
                    if (car.events.landedImpact > 0) landed = true;
                    if (landed) {
                        if (!car.state.grounded) bouncedAfterLanding = true;
                        if (car.state.susp < minSusp) minSusp = car.state.susp;
                    }
                });
                expect(landed, `${classId} from ${dropHeight}m`).toBe(true);
                expect(bouncedAfterLanding, `${classId} must stay planted after ${dropHeight}m drop`).toBe(false);
                expect(Math.abs(car.state.susp), `${classId} settled after ${dropHeight}m drop`).toBeLessThan(0.005);
                minSuspByClass[classId] = minSusp;
            }
            // Long-travel Jeep compresses further than short-travel Sport on a 3 m drop
            expect(minSuspByClass.jeep).toBeLessThan(minSuspByClass.sport - 0.04);
        }
    });

    it('scales per-class suspension proportionally when global SIM_TUNING multipliers change', () => {
        const world = createLongWorld();
        const subDt = DT / SUBSTEPS;
        const baseline = spawnCar(world, 'b1', 'sport', 0, 0, 0);
        baseline.state.susp = -0.10;
        stepVertical(baseline, world, subDt);

        T.SUSP_FREQ = 4; // 2× default -> 4× spring stiffness
        expect(effectiveSuspension(baseline.params).freq).toBeCloseTo(2.55 * 2, 10);
        const doubled = spawnCar(world, 'b2', 'sport', 0, 0, 0);
        doubled.state.susp = -0.10;
        stepVertical(doubled, world, subDt);

        expect(doubled.state.vy / baseline.state.vy).toBeCloseTo(4, 10);
    });
});

describe('tiered drift release mini-turbo and handling feel', () => {
    restoreTuningAfterEach();

    it('computes exact piecewise-linear mini-turbo tiers and speeds', () => {
        expect(driftKickTier(0)).toBe(0);
        expect(driftKickTier(DRIFT_TIER1_TICKS - 1)).toBe(0);
        expect(driftKickTier(DRIFT_TIER1_TICKS)).toBe(1);
        expect(driftKickTier(DRIFT_TIER2_TICKS - 1)).toBe(1);
        expect(driftKickTier(DRIFT_TIER2_TICKS)).toBe(2);
        expect(driftKickTier(DRIFT_TIER3_TICKS - 1)).toBe(2);
        expect(driftKickTier(DRIFT_TIER3_TICKS)).toBe(3);
        expect(driftKickTier(500)).toBe(3);

        const maxKick = 10;
        expect(driftKickSpeed(0, maxKick)).toBe(0);
        expect(driftKickSpeed(DRIFT_TIER1_TICKS - 1, maxKick)).toBe(0);
        expect(driftKickSpeed(DRIFT_TIER1_TICKS, maxKick)).toBeCloseTo(3.5, 10);
        expect(driftKickSpeed((DRIFT_TIER1_TICKS + DRIFT_TIER2_TICKS) / 2, maxKick)).toBeCloseTo(5.0, 10);
        expect(driftKickSpeed(DRIFT_TIER2_TICKS, maxKick)).toBeCloseTo(6.5, 10);
        expect(driftKickSpeed((DRIFT_TIER2_TICKS + DRIFT_TIER3_TICKS) / 2, maxKick)).toBeCloseTo(8.25, 10);
        expect(driftKickSpeed(DRIFT_TIER3_TICKS, maxKick)).toBeCloseTo(10.0, 10);
        expect(driftKickSpeed(300, maxKick)).toBeCloseTo(10.0, 10);
        expect(driftKickSpeed(DRIFT_TIER3_TICKS, 0)).toBe(0);
    });

    it('rewards sustained clean drifts with progressively stronger exit mini-turbo kicks', () => {
        const world = createLongWorld();
        const runDrift = (holdTicks: number, kickEnabled = true) => {
            T.driftReleaseKick = kickEnabled ? 5.5 : 0;
            const car = spawnCar(world, 'd', 'sport', 0, 0, 0, 34);
            let maxTier = 0;
            let releaseKick = 0;
            let releaseTier = 0;
            let releaseTick = -1;
            let speedBeforeRelease = 0;
            let speedAtRelease = 0;
            const speeds: number[] = [];
            // Initiate slide with brief handbrake + full steer, hold drift, then straighten out
            const hbEnd = holdTicks === 0 ? 5 : 16;
            const steerEnd = hbEnd + holdTicks;
            drive(car, world, steerEnd + 90, tick => {
                if (tick < hbEnd) return { throttle: 255, steer: 127, buttons: BTN_HANDBRAKE };
                if (tick < steerEnd) return { throttle: 255, steer: 127 };
                return { throttle: 255, steer: 0 };
            }, tick => {
                const u = forwardSpeed(car.state);
                speeds.push(u);
                if (car.events.drifting && car.events.driftTier > maxTier) {
                    maxTier = car.events.driftTier;
                }
                if (car.events.driftKick > 0) {
                    releaseKick = car.events.driftKick;
                    releaseTier = car.events.driftTier;
                    releaseTick = tick;
                    speedAtRelease = u;
                } else if (releaseKick === 0) {
                    speedBeforeRelease = u;
                }
            });
            return { maxTier, releaseKick, releaseTier, releaseTick, speedBeforeRelease, speedAtRelease, speeds };
        };

        const shortDrift = runDrift(0);
        const mediumDrift = runDrift(45);
        const longDrift = runDrift(130);
        const disabledLong = runDrift(130, false);

        expect(shortDrift.releaseKick).toBe(0);
        expect(mediumDrift.releaseTier).toBeGreaterThanOrEqual(1);
        expect(mediumDrift.releaseKick).toBeGreaterThan(1.5);
        expect(longDrift.releaseTier).toBe(3);
        expect(longDrift.releaseKick).toBeGreaterThan(mediumDrift.releaseKick);
        expect(longDrift.releaseKick).toBeCloseTo(5.5, 4);
        expect(longDrift.speedAtRelease - longDrift.speedBeforeRelease).toBeGreaterThan(4.5);
        expect(disabledLong.releaseKick).toBe(0);
        // At the exact same tick, the mini-turbo run is ~5.5 m/s faster than the no-kick control
        expect(longDrift.speedAtRelease - disabledLong.speeds[longDrift.releaseTick]).toBeGreaterThan(5.0);
    });

    it('caps drift exit kick at topSpeed (or boostTarget while boosting), requires powering out, and blocks after wall contact', () => {
        const world = createLongWorld();

        const triggerRelease = (opts: { speed: number; wallTicks: number; boosting?: boolean; throttle?: number; brake?: number; steer?: number }) => {
            const car = spawnCar(world, 'cap', 'bulli', 0, 0, 0, opts.speed);
            car.state.driftTicks = 130; // Tier 3
            car.state.driftLowTicks = 9; // exits on this tick (DRIFT_EXIT_TICKS = 10)
            car.state.wallTicks = opts.wallTicks;
            car.state.boostMeter = 0.5;
            if (opts.boosting) {
                car.state.boosting = true;
                car.input.buttons = BTN_BOOST;
            }
            car.input.throttle = opts.throttle ?? 255;
            car.input.brake = opts.brake ?? 0;
            car.input.steer = opts.steer ?? 0;
            stepVehicle(car, world);
            return {
                kick: car.events.driftKick,
                tier: car.events.driftTier,
                drifting: car.events.drifting,
                u: forwardSpeed(car.state),
                meter: car.state.boostMeter
            };
        };

        // Well below topSpeed (50 m/s): gets full 5.5 m/s kick + 0.12 Tier-3 boost bonus
        const open = triggerRelease({ speed: 35, wallTicks: 255 });
        expect(open.kick).toBeCloseTo(5.5, 6);
        expect(open.tier).toBe(3);
        expect(open.drifting).toBe(false);
        expect(open.meter).toBeCloseTo(0.62, 5);

        // Near topSpeed (49 m/s): kick capped so car never exceeds 50 m/s without boost
        const capped = triggerRelease({ speed: 49, wallTicks: 255 });
        expect(capped.kick).toBeGreaterThan(0);
        expect(capped.kick).toBeLessThanOrEqual(1.0 + 1e-6);
        expect(capped.u).toBeLessThanOrEqual(VEHICLE_CLASSES.bulli.topSpeed + 1e-6);

        // While actively boosting above topSpeed (55 m/s < boostTarget 70 m/s): full 5.5 m/s kick applies
        const boosted = triggerRelease({ speed: 55, wallTicks: 255, boosting: true });
        expect(boosted.kick).toBeCloseTo(5.5, 6);
        expect(boosted.u).toBeLessThanOrEqual(70);

        // Braking or still cranked at near-full lock mid-apex does NOT lunge forward
        const braking = triggerRelease({ speed: 35, wallTicks: 255, brake: 200 });
        expect(braking.kick).toBe(0);
        const midCornerLock = triggerRelease({ speed: 35, wallTicks: 255, steer: 110 });
        expect(midCornerLock.kick).toBe(0);

        // Recent wall scrub (wallTicks = 5 < 20): zero kick and zero bonus fill
        const walled = triggerRelease({ speed: 35, wallTicks: 5 });
        expect(walled.kick).toBe(0);
        expect(walled.tier).toBe(0);
        expect(walled.meter).toBeCloseTo(0.5, 6);
    });

    it('turns into full low-speed lock crisply and recovers cleanly from deep handbrake slides', () => {
        const world = createLongWorld();
        // Bulli steerLock = 32° = 0.5585 rad; at STEER_RATE_IN = 4.8 rad/s -> 7 ticks (0.117 s)
        const car = spawnCar(world, 'steer', 'bulli', 0, 0, 0, 0);
        drive(car, world, 7, { steer: 127 });
        expect(car.state.steerAngle).toBeCloseTo(VEHICLE_CLASSES.bulli.steerLock, 5);
        // Releasing returns even faster (STEER_RATE_OUT = 6.8 rad/s -> 5 ticks)
        drive(car, world, 5, { steer: 0 });
        expect(car.state.steerAngle).toBeCloseTo(0, 5);

        // Deep handbrake slide recovery on both standard and touch assist profiles
        for (const profile of ['standard', 'touch'] as const) {
            const slider = spawnCar(world, profile, 'bulli', 0, 0, 0, 35, profile);
            let maxBeta = 0;
            drive(slider, world, 150, tick => {
                if (tick < 25) return { throttle: 255, steer: 127, buttons: BTN_HANDBRAKE };
                if (tick < 60) return { throttle: 255, steer: 127 };
                return { throttle: 255, steer: 0 };
            }, () => {
                maxBeta = Math.max(maxBeta, Math.abs(slipAngle(slider.state)));
            });
            expect(maxBeta).toBeGreaterThan(15 * DEG);
            expect(maxBeta).toBeLessThan(80 * DEG);
            expect(Math.abs(slipAngle(slider.state))).toBeLessThan(5 * DEG);
        }
    });
});

describe('snow and ice surface physics', () => {
    it('defines snow (10) and ice (11) surface physics with expected grip, roll, yaw-damp and drift-fill', () => {
        expect(SIM_SURFACE_SNOW).toBe(10);
        expect(SIM_SURFACE_ICE).toBe(11);
        expect(surfacePhysics(SIM_SURFACE_SNOW)).toStrictEqual({
            grip: 0.65, roll: 1.1, yawDampScale: 0.85, driftFillScale: 1.15, paved: false
        });
        expect(surfacePhysics(SIM_SURFACE_ICE)).toStrictEqual({
            grip: 0.35, roll: 0.15, yawDampScale: 0.45, driftFillScale: 1.25, paved: false
        });
        expect(surfaceYawDamp(SURFACE.asphalt)).toBe(1.0);
        expect(surfaceYawDamp(SIM_SURFACE_SNOW)).toBe(0.85);
        expect(surfaceYawDamp(SIM_SURFACE_ICE)).toBe(0.45);
        expect(surfaceDriftFill(SURFACE.asphalt)).toBe(1.0);
        expect(surfaceDriftFill(SIM_SURFACE_SNOW)).toBe(1.15);
        expect(surfaceDriftFill(SIM_SURFACE_ICE)).toBe(1.25);
        expect(surfaceGrip(SIM_SURFACE_SNOW, spawnCar(createLongWorld(), 'x', 'bulli', 0, 0, 0).params)).toBeCloseTo(0.65 * 0.9, 10);
        expect(surfaceRoll(SIM_SURFACE_ICE, spawnCar(createLongWorld(), 'x', 'bulli', 0, 0, 0).params)).toBeCloseTo(0.15 * 0.8, 10);
    });

    it('applies hand-calculated rolling resistance on snow (1.1) and ice (0.15)', () => {
        const firstTick = (surface: number, classId: CarClassId) => {
            const world = surfaceWorld({ surface: () => surface });
            const car = spawnCar(world, 'r', classId, 0, 0, 0);
            drive(car, world, 1, { throttle: 255 });
            return car.state.vz;
        };
        // Bulli: accel 8.5, offroadDrag 0.8
        expect(firstTick(SIM_SURFACE_SNOW, 'bulli')).toBeCloseTo((8.5 - 1.1 * 0.8) * DT, 12);
        expect(firstTick(SIM_SURFACE_ICE, 'bulli')).toBeCloseTo((8.5 - 0.15 * 0.8) * DT, 12);
        // Ice rolls much freer than snow
        expect(firstTick(SIM_SURFACE_ICE, 'bulli')).toBeGreaterThan(firstTick(SIM_SURFACE_SNOW, 'bulli'));
        // Jeep: accel 9.5, offroadDrag 0.2 (barely slowed by snow)
        expect(firstTick(SIM_SURFACE_SNOW, 'jeep')).toBeCloseTo((9.5 - 1.1 * 0.2) * DT, 12);
    });

    it('scales lateral tyre forces by 0.65 on snow and 0.35 on ice (times offroadGrip)', () => {
        const lateralChange = (surface: number, classId: CarClassId) => {
            const world = surfaceWorld({ surface: () => surface });
            const car = spawnCar(world, 'g', classId, 0, 0, 0);
            car.state.vz = 20;
            car.state.vx = 8;
            stepVehicle(car, world);
            return car.state.vx - 8;
        };
        const bulliAsphalt = lateralChange(SURFACE.asphalt, 'bulli');
        expect(lateralChange(SIM_SURFACE_SNOW, 'bulli') / bulliAsphalt).toBeCloseTo(0.65 * 0.90, 9);
        expect(lateralChange(SIM_SURFACE_ICE, 'bulli') / bulliAsphalt).toBeCloseTo(0.35 * 0.90, 9);

        const jeepAsphalt = lateralChange(SURFACE.asphalt, 'jeep');
        expect(lateralChange(SIM_SURFACE_SNOW, 'jeep') / jeepAsphalt).toBeCloseTo(0.65 * 1.00, 9);
        expect(lateralChange(SIM_SURFACE_ICE, 'jeep') / jeepAsphalt).toBeCloseTo(0.35 * 1.00, 9);
    });

    it('produces wider controllable slides on ice than snow than asphalt via lower grip & yaw damping', () => {
        const slidePeak = (surface: number) => {
            const world = surfaceWorld({ surface: () => surface });
            const car = spawnCar(world, 's', 'bulli', 0, 0, 0, 26);
            let peakBeta = 0;
            drive(car, world, 90, tick => (
                tick < 15
                    ? { throttle: 255, steer: 127, buttons: BTN_HANDBRAKE }
                    : tick < 55
                        ? { throttle: 255, steer: 127 }
                        : { throttle: 255, steer: 0 }
            ), () => {
                peakBeta = Math.max(peakBeta, Math.abs(slipAngle(car.state)));
            });
            return peakBeta;
        };

        const asphaltPeak = slidePeak(SURFACE.asphalt);
        const snowPeak = slidePeak(SIM_SURFACE_SNOW);
        const icePeak = slidePeak(SIM_SURFACE_ICE);

        expect(snowPeak).toBeGreaterThan(asphaltPeak + 2 * DEG);
        expect(icePeak).toBeGreaterThan(snowPeak + 5 * DEG);
        // Even on ice the reduced spin-guard keeps the car from spinning past 90°
        expect(icePeak).toBeLessThan(88 * DEG);

        // Verify lower ice yaw-assist damping directly at 45° slip (beyond 35° spinGuardAngle):
        // Put car at beta = 45° with zero tyre asymmetry effect isolated by comparing yawRate step
        const yawGuardStep = (surface: number) => {
            const world = surfaceWorld({ surface: () => surface });
            const car = spawnCar(world, 'y', 'bulli', 0, 0, 0);
            car.state.vz = 20;
            car.state.vx = 20; // beta = 45°
            car.state.betaPrev = Math.PI / 4;
            stepVehicle(car, world);
            return car.state.yawRate;
        };
        // Spin guard applies positive yawRate to align nose (+z) toward +x/+z travel (left = +x)
        expect(yawGuardStep(SIM_SURFACE_ICE)).toBeGreaterThan(0);
        expect(yawGuardStep(SIM_SURFACE_ICE)).toBeLessThan(yawGuardStep(SIM_SURFACE_SNOW));
        expect(yawGuardStep(SIM_SURFACE_SNOW)).toBeLessThan(yawGuardStep(SURFACE.asphalt));
    });

    it('fills boost meter faster on snow (1.15×) and ice (1.25×) at identical slip angle', () => {
        const oneTickFill = (surface: number) => {
            const world = surfaceWorld({ surface: () => surface });
            const car = spawnCar(world, 'f', 'bulli', 0, 0, 0);
            // Set speed and large slip angle so clamp((absBeta - 10°)/15°) = 1 and clamp((u - 8)/12) = 1
            // even after 1 tick of lateral grip slows w slightly
            car.state.vz = 25;
            car.state.vx = 18;
            car.state.boostMeter = 0;
            stepVehicle(car, world);
            return car.state.boostMeter;
        };
        const asphalt = oneTickFill(SURFACE.asphalt);
        expect(asphalt).toBeGreaterThan(0);
        expect(oneTickFill(SIM_SURFACE_SNOW) / asphalt).toBeCloseTo(1.15, 6);
        expect(oneTickFill(SIM_SURFACE_ICE) / asphalt).toBeCloseTo(1.25, 6);
    });

    it('reports centre, front-axle, and rear-axle surface IDs in StepEvents and -1 while airborne', () => {
        const cOff = VEHICLE_CLASSES.bulli.colliderOffset;
        const world = surfaceWorld({ surface: (_x, z) => z > 0 ? SIM_SURFACE_SNOW : SURFACE.asphalt });
        // Centre at -0.3 c (asphalt), front axle at +0.7 c (snow), rear axle at -1.3 c (asphalt)
        const car = spawnCar(world, 'ev', 'bulli', 0, -0.3 * cOff, 0);
        stepVehicle(car, world);
        expect(car.events.surface).toBe(SURFACE.asphalt);
        expect(car.events.surfaceFront).toBe(SIM_SURFACE_SNOW);
        expect(car.events.surfaceRear).toBe(SURFACE.asphalt);

        // Airborne: all three surface readings report -1
        launch(car, 8);
        stepVehicle(car, world);
        expect(car.state.grounded).toBe(false);
        expect(car.events.surface).toBe(-1);
        expect(car.events.surfaceFront).toBe(-1);
        expect(car.events.surfaceRear).toBe(-1);
    });
});

describe('deterministic boost pads', () => {
    it('evaluates oriented boost pad footprints accurately at 0°, 90°, and 45° yaw', () => {
        const pad0: BoostPadVolume = { id: 'p0', x: 10, z: 20, yaw: 0, width: 6, length: 10, impulseSpeed: 45, boostFill: 0.3 };
        expect(insideBoostPad(pad0, 10, 20)).toBe(true);
        expect(insideBoostPad(pad0, 13, 25)).toBe(true);
        expect(insideBoostPad(pad0, 13.01, 20)).toBe(false);
        expect(insideBoostPad(pad0, 10, 25.01)).toBe(false);

        // 90° yaw: forward is +x (length 10 -> ±5 in x), across is ±3 in z
        const pad90: BoostPadVolume = { ...pad0, id: 'p90', yaw: Math.PI / 2 };
        expect(insideBoostPad(pad90, 14.9, 20)).toBe(true);
        expect(insideBoostPad(pad90, 10, 23.1)).toBe(false);

        // 45° yaw: point 4.5 m along (sin 45°, cos 45°) is inside (half-length 5),
        // point 3.5 m across (cos 45°, -sin 45°) is outside (half-width 3)
        const pad45: BoostPadVolume = { ...pad0, id: 'p45', yaw: Math.PI / 4 };
        const s = Math.SQRT1_2;
        expect(insideBoostPad(pad45, 10 + 4.5 * s, 20 + 4.5 * s)).toBe(true);
        expect(insideBoostPad(pad45, 10 + 5.2 * s, 20 + 5.2 * s)).toBe(false);
        expect(insideBoostPad(pad45, 10 + 2.9 * s, 20 - 2.9 * s)).toBe(true);
        expect(insideBoostPad(pad45, 10 + 3.2 * s, 20 - 3.2 * s)).toBe(false);
    });

    it('boosts velocity along pad heading up to impulseSpeed, refills boostMeter, and emits events', () => {
        const pad: BoostPadVolume = {
            id: 'strip-1', x: 0, z: 10, yaw: 0, width: 6, length: 10, impulseSpeed: 42, boostFill: 0.4
        };
        const world = surfaceWorld({ boostPads: [pad] });
        const car = spawnCar(world, 'b', 'bulli', 0, 10, 0, 15);
        car.state.boostMeter = 0.2;
        stepVehicle(car, world);

        expect(car.events.boostPadTriggered).toBe(true);
        expect(car.events.boostPadId).toBe('strip-1');
        expect(car.state.vz).toBeCloseTo(42, 6);
        expect(car.state.boostMeter).toBeCloseTo(0.6, 6);

        // Angled 45° pad projects velocity onto pad heading and boosts that component to 40 m/s
        const diagPad: BoostPadVolume = {
            id: 'diag-1', x: 0, z: 0, yaw: Math.PI / 4, width: 8, length: 8, impulseSpeed: 40, boostFill: 0.25
        };
        const diagWorld = surfaceWorld({ boostPads: [diagPad] });
        const car2 = spawnCar(diagWorld, 'd', 'sport', 0, 0, Math.PI / 4, 10);
        stepVehicle(car2, diagWorld);
        const px = Math.sin(Math.PI / 4), pz = Math.cos(Math.PI / 4);
        expect(car2.state.vx * px + car2.state.vz * pz).toBeCloseTo(40, 6);
        expect(car2.events.boostPadId).toBe('diag-1');
    });

    it('never slows a faster car, clamps boostFill to 1, and clamps impulseSpeed to V_ABS', () => {
        const slowPad: BoostPadVolume = {
            id: 'slow', x: 0, z: 0, yaw: 0, width: 8, length: 8, impulseSpeed: 35, boostFill: 0.5
        };
        const world = surfaceWorld({ boostPads: [slowPad] });
        const fastCar = spawnCar(world, 'f', 'sport', 0, 0, 0, 48);
        fastCar.state.boostMeter = 0.8;
        drive(fastCar, world, 1, { throttle: 255 });

        expect(fastCar.events.boostPadTriggered).toBe(true);
        expect(fastCar.state.vz).toBeGreaterThan(47.5);
        expect(fastCar.state.boostMeter).toBe(1);

        // Absurd pad speed clamps to V_ABS (85 m/s)
        const hyperPad: BoostPadVolume = {
            id: 'hyper', x: 0, z: 0, yaw: 0, width: 8, length: 8, impulseSpeed: 150, boostFill: 0.2
        };
        const hyperWorld = surfaceWorld({ boostPads: [hyperPad] });
        const rocket = spawnCar(hyperWorld, 'r', 'sport', 0, 0, 0, 10);
        stepVehicle(rocket, hyperWorld);
        expect(speedOf(rocket)).toBeCloseTo(V_ABS, 6);
    });

    it('enforces per-pad cooldown while crossing, re-arms after cooldown, and chains distinct pads immediately', () => {
        const longPad: BoostPadVolume = {
            id: 'long', x: 0, z: 50, yaw: 0, width: 8, length: 120, impulseSpeed: 30, boostFill: 0.25, cooldownTicks: 15
        };
        const world = surfaceWorld({ boostPads: [longPad] });
        const car = spawnCar(world, 'c', 'bulli', 0, 0, 0, 20);
        const triggeredTicks: number[] = [];
        drive(car, world, 30, { throttle: 255 }, tick => {
            if (car.events.boostPadTriggered) triggeredTicks.push(tick);
        });
        expect(triggeredTicks).toEqual([0, 15]);

        // Chaining two distinct pads triggers both back-to-back without waiting for pad A's cooldown
        const padA: BoostPadVolume = {
            id: 'chain-a', x: 0, z: 4, yaw: 0, width: 8, length: 8, impulseSpeed: 36, boostFill: 0.2, cooldownTicks: 30
        };
        const padB: BoostPadVolume = {
            id: 'chain-b', x: 0, z: 14, yaw: 0, width: 8, length: 8, impulseSpeed: 48, boostFill: 0.2, cooldownTicks: 30
        };
        const chainWorld = surfaceWorld({ boostPads: [padA, padB] });
        const runner = spawnCar(chainWorld, 'chain', 'sport', 0, 4, 0, 20);
        const hits: string[] = [];
        drive(runner, chainWorld, 20, { throttle: 255 }, () => {
            if (runner.events.boostPadTriggered) hits.push(runner.events.boostPadId);
        });
        expect(hits).toEqual(['chain-a', 'chain-b']);
        expect(runner.state.vz).toBeGreaterThan(45);
    });

    it('clears boost-pad cooldown on reconciliation rewind and on reset for replay determinism', () => {
        const pad: BoostPadVolume = {
            id: 'rewind-pad', x: 0, z: 10, yaw: 0, width: 8, length: 8, impulseSpeed: 40, boostFill: 0.3, cooldownTicks: 30
        };
        const world = surfaceWorld({ boostPads: [pad] });
        const car = spawnCar(world, 'rw', 'bulli', 0, 5, 0, 30);
        const saved = copyVehicleState(createVehicleState(), car.state);

        // First run: approaches from z = 5 and triggers pad
        let firstHitTick = -1;
        drive(car, world, 15, { throttle: 255 }, tick => {
            if (car.events.boostPadTriggered && firstHitTick < 0) firstHitTick = tick;
        });
        expect(firstHitTick).toBeGreaterThan(0);
        expect(car.boostPadCooldown).toBeGreaterThan(0);

        // Simulate client reconciliation rewind back to saved pose (> 2.5 m jump)
        copyVehicleState(car.state, saved);
        let replayHitTick = -1;
        drive(car, world, 15, { throttle: 255 }, tick => {
            if (car.events.boostPadTriggered && replayHitTick < 0) replayHitTick = tick;
        });
        expect(replayHitTick).toBe(firstHitTick);

        // Reset also clears cooldown
        car.boostPadCooldown = 25;
        car.lastBoostPadId = 'rewind-pad';
        car.state.resetHold = T.RESET_HOLD_TICKS - 1;
        drive(car, world, 1, { buttons: BTN_RESET });
        expect(car.events.reset).toBe(true);
        expect(car.boostPadCooldown).toBe(0);
        expect(car.lastBoostPadId).toBe('');
    });

    it('ignores boost pads underwater or high in the air, and supports post-hoc world.boostPads assignment', () => {
        const pad: BoostPadVolume = {
            id: 'env-pad', x: 0, z: 0, yaw: 0, width: 8, length: 8, impulseSpeed: 40, boostFill: 0.3
        };
        // Deep water skips boost pad
        const wetWorld = surfaceWorld({ height: () => -1, waterLevel: 0, boostPads: [pad] });
        const wetCar = spawnCar(wetWorld, 'w', 'bulli', 0, 0, 0, 10);
        stepVehicle(wetCar, wetWorld);
        expect(wetCar.events.boostPadTriggered).toBe(false);

        // High altitude (> 1.5 m above ground) skips boost pad
        const airWorld = surfaceWorld({ boostPads: [pad] });
        const highCar = spawnCar(airWorld, 'h', 'bulli', 0, 0, 0, 10);
        highCar.state.y = 3.0;
        highCar.state.grounded = false;
        stepVehicle(highCar, airWorld);
        expect(highCar.events.boostPadTriggered).toBe(false);

        // Low skim (<= 1.5 m above ground) triggers boost pad
        const lowCar = spawnCar(airWorld, 'l', 'bulli', 0, 0, 0, 10);
        lowCar.state.y = 1.0;
        lowCar.state.grounded = false;
        stepVehicle(lowCar, airWorld);
        expect(lowCar.events.boostPadTriggered).toBe(true);

        // Post-hoc assignment and swap on an existing world work without stale boostPadAt cache
        const dynamicWorld = surfaceWorld();
        dynamicWorld.boostPads = [pad];
        const dynCar = spawnCar(dynamicWorld, 'dyn', 'bulli', 0, 0, 0, 10);
        stepVehicle(dynCar, dynamicWorld);
        expect(dynCar.events.boostPadTriggered).toBe(true);
        expect(dynCar.events.boostPadId).toBe('env-pad');

        const swappedWorld = surfaceWorld({ boostPads: [pad] });
        swappedWorld.boostPads = [{ ...pad, id: 'swapped-pad', x: 30 }];
        const swapCar = spawnCar(swappedWorld, 'sw', 'bulli', 30, 0, 0, 10);
        stepVehicle(swapCar, swappedWorld);
        expect(swapCar.events.boostPadTriggered).toBe(true);
        expect(swapCar.events.boostPadId).toBe('swapped-pad');
    });
});
