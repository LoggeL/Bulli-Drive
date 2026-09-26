import { describe, expect, it } from 'vitest';
import { MEGA_SCALE } from '../../../src/shared/constants.js';
import { BTN_BOOST, BTN_RESET, DT } from '../../../src/shared/sim/constants.js';
import { createFlatWorld, FLAT_TERRAIN } from '../../../src/shared/sim/scenarios.js';
import { stepVehicle } from '../../../src/shared/sim/world.js';
import { createSimWorld } from '../../../src/shared/world/colliders.js';
import { drive, forwardSpeed, spawnCar, speedOf } from './helpers.js';

// Edges of the vehicle step (docs/phase-1a-design.md, 6.4-6.7 and 26) the
// golden runs on flat ground do not reach: no drive, boost or steering in
// the air, the landing assist, the speed clamp in the air, landing, the
// drift event, the Mega scale rate, the reset and a slope along z. Values:
// gravity 20 m/s², the yaw rate eases at 3/s towards 2/s times the slip
// angle, |v| at most 90 m/s, landings above 10 m/s lose up to 15 % of
// their speed.

// A car in the air, 20 m above the flat ground, heading +z at speed
function flying(speed: number) {
    const world = createFlatWorld();
    const car = spawnCar(world, 'a', 'bulli', 0, 0, 0, speed);
    car.state.y = 20;
    car.state.grounded = false;
    car.state.airTicks = 30;
    return { world, car };
}

describe('in the air', () => {
    it('neither drives, brakes nor boosts: only the air drag acts', () => {
        const plain = flying(30), pushed = flying(30), braked = flying(30);
        pushed.car.state.boosting = true;
        pushed.car.state.boostMeter = 1;
        stepVehicle(plain.car, plain.world);
        drive(pushed.car, pushed.world, 1, { throttle: 255, buttons: BTN_BOOST });
        drive(braked.car, braked.world, 1, { brake: 255 });
        // Air drag C_AIR·|v|·DT = 0.0006 · 30 / 60 of the speed
        expect(plain.car.state.vz).toBeCloseTo(30 * (1 - 0.0006 * 30 / 60), 12);
        expect(pushed.car.state.vz).toBe(plain.car.state.vz);
        expect(braked.car.state.vz).toBe(plain.car.state.vz);
        // Falling with GRAVITY: 20 m/s² for one tick
        expect(plain.car.state.vy).toBeCloseTo(-20 / 60, 12);
    });

    it('does not steer, and eases the yaw rate towards 2/s times the slip angle at 3/s', () => {
        // Heading and flight direction the same (β = 0): a yaw rate of 0.4
        // loses 3 · DT = 5 % a tick, whatever the steering
        const coasting = flying(30), steered = flying(30);
        coasting.car.state.yawRate = steered.car.state.yawRate = 0.4;
        stepVehicle(coasting.car, coasting.world);
        drive(steered.car, steered.world, 1, { steer: 127 });
        expect(coasting.car.state.yawRate).toBeCloseTo(0.4 * 0.95, 12);
        expect(steered.car.state).toStrictEqual(coasting.car.state);
        // Flying 0.1 rad to the left of the nose: the yaw rate turns left,
        // 2 · 0.1 · 5 % = 0.01 rad/s after one tick
        const skewed = flying(0);
        skewed.car.state.vx = 30 * Math.sin(0.1);
        skewed.car.state.vz = 30 * Math.cos(0.1);
        stepVehicle(skewed.car, skewed.world);
        expect(skewed.car.state.yawRate).toBeCloseTo(0.01, 12);
    });

    it('never flies faster than 90 m/s horizontally', () => {
        const { world, car } = flying(0);
        car.state.vx = 72;
        car.state.vz = 96;   // 120 m/s
        stepVehicle(car, world);
        expect(speedOf(car)).toBeCloseTo(90, 9);
        // The direction stays
        expect(car.state.vz / car.state.vx).toBeCloseTo(96 / 72, 9);
        const ground = createFlatWorld();
        const driving = spawnCar(ground, 'b', 'bulli', 0, 0, 0, 120);
        stepVehicle(driving, ground);
        expect(speedOf(driving)).toBeLessThanOrEqual(90 + 1e-9);
    });
});

describe('landing', () => {
    // 4 cm above the ground, falling at vy: lands in the first substep
    function landing(vy: number) {
        const { world, car } = flying(20);
        car.state.y = 0.04;
        car.state.vy = vy;
        stepVehicle(car, world);
        return car;
    }

    it('keeps the speed up to an impact of 10 m/s, and loses 15 % · (impact - 10) / 15 above', () => {
        const soft = landing(-9);
        const hard = landing(-12);
        expect(soft.state.grounded).toBe(true);
        expect(hard.state.grounded).toBe(true);
        // Impact 12 m/s plus the gravity of one substep (20 m/s² · DT / 3)
        const impact = 12 + 20 * DT / 3;
        expect(hard.events.landedImpact).toBeCloseTo(impact, 9);
        expect(hard.state.vz / soft.state.vz).toBeCloseTo(1 - 0.15 * (impact - 10) / 15, 9);
        expect(soft.events.landedImpact).toBeCloseTo(9 + 20 * DT / 3, 9);
        // The wheels are on the ground, the spring catches the body
        expect(soft.state.y).toBe(0);
        expect(soft.state.vy).toBeGreaterThan(-9);
    });
});

describe('drift event and Mega scale', () => {
    it('reports drifting while the drift counter runs', () => {
        const world = createFlatWorld();
        const car = spawnCar(world, 'a', 'bulli', 0, 0, 0, 20);
        stepVehicle(car, world);
        expect(car.events.drifting).toBe(false);
        // A drift under way, still in its hold time
        car.state.driftTicks = 5;
        stepVehicle(car, world);
        expect(car.state.driftTicks).toBe(6);
        expect(car.events.drifting).toBe(true);
    });

    it('grows by 1 - e^(-6 · DT) of the way per tick and snaps within 1e-4', () => {
        const world = createFlatWorld();
        const car = spawnCar(world, 'a', 'bulli', 0, 0, 0);
        car.mods.mega = true;
        stepVehicle(car, world);
        expect(car.state.scale).toBeCloseTo(1 + (MEGA_SCALE - 1) * (1 - Math.exp(-6 / 60)), 12);
        car.state.scale = MEGA_SCALE - 1.05e-4 / Math.exp(-6 / 60);
        stepVehicle(car, world);
        expect(car.state.scale).not.toBe(MEGA_SCALE);
        stepVehicle(car, world);
        expect(car.state.scale).toBe(MEGA_SCALE);
    });
});

describe('reset', () => {
    // (Its push-out and boost stop are backed up within the same tick by the
    // world collision and the boost rule, so only the outcome is checked)
    it('lands a car in the air, not boosting, out of the building it is in', () => {
        const world = createFlatWorld([{ kind: 'box', x: 0, z: 0, hw: 5, hd: 5, top: Infinity }]);
        const car = spawnCar(world, 'a', 'bulli', 0, -5.5, 0, 0);
        car.state.boosting = true;
        car.state.boostMeter = 1;
        drive(car, world, 29, { buttons: BTN_RESET });
        // In the air over the building's edge when the reset comes
        car.state.y = 4;
        car.state.grounded = false;
        car.state.airTicks = 40;
        drive(car, world, 1, { buttons: BTN_RESET | BTN_BOOST });
        expect(car.events.reset).toBe(true);
        expect(car.state.grounded).toBe(true);
        expect(car.state.y).toBe(0);
        expect(car.state.boosting).toBe(false);
        // Pushed out: the front circle (1.3 m at +0.7 m) ends before z = -5
        expect(car.state.z + 0.7 + 1.3).toBeLessThanOrEqual(-5 + 1e-6);
    });
});

describe('slopes', () => {
    it('rolls downhill along z as well as along x', () => {
        // h = 30·sin(0.01·x) + 30·cos(0.01·z); at (50π, 50π) the slope is
        // 0 along x and -0.3 along z (downhill towards +z)
        const terrain = { ...FLAT_TERRAIN, size: 4000, frequency1: 0.01, amplitude1: 30 };
        const world = createSimWorld(terrain, [], []);
        const at = 50 * Math.PI;
        expect(world.groundHeight(at, at + 0.5) - world.groundHeight(at, at - 0.5)).toBeCloseTo(-0.3, 3);
        const down = spawnCar(world, 'a', 'bulli', at, at, 0, 2);
        drive(down, world, 60, {});
        expect(forwardSpeed(down.state)).toBeGreaterThan(2.8);
        expect(down.state.x).toBeCloseTo(at, 1);
        // Facing uphill it slows down faster than on the flat (0.3 · 9.81
        // m/s² on top of about 1.9 m/s² of drag): below 1.5 m/s in 10 ticks
        const up = spawnCar(world, 'b', 'bulli', at, at, Math.PI, 2);
        drive(up, world, 10, {});
        expect(forwardSpeed(up.state)).toBeLessThan(1.5);
        const flat = createFlatWorld();
        const level = spawnCar(flat, 'c', 'bulli', 0, 0, Math.PI, 2);
        drive(level, flat, 10, {});
        expect(forwardSpeed(level.state)).toBeGreaterThan(1.6);
    });
});
