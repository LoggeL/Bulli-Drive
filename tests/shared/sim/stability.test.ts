import { describe, expect, it } from 'vitest';
import { DEFAULT_TERRAIN_CONFIG } from '../../../src/shared/constants.js';
import { mulberry32 } from '../../../src/shared/math/rng.js';
import { BTN_BOOST, BTN_HANDBRAKE, BTN_JUMP, BTN_RESET } from '../../../src/shared/sim/constants.js';
import { findScenario, runScenario, spawnCar } from '../../../src/shared/sim/scenarios.js';
import { copyVehicleState, createVehicleState, type AssistProfile, type SimCar, type VehicleInput, type VehicleState } from '../../../src/shared/sim/types.js';
import { createSimCar, placeVehicle } from '../../../src/shared/sim/vehicle.js';
import { CAR_CLASS_IDS } from '../../../src/shared/sim/vehicleClasses.js';
import { stepVehicle, stepWorld } from '../../../src/shared/sim/world.js';
import { createSimWorld, type ColliderInput } from '../../../src/shared/world/colliders.js';
import { createLongWorld, DEG, drive } from './helpers.js';

// Numerical stability, determinism and replay (docs/phase-1a-design.md, 14.3, 14.9)

function expectFinite(s: VehicleState): void {
    for (const [key, value] of Object.entries(s)) {
        if (typeof value === 'number') expect(Number.isFinite(value), key).toBe(true);
    }
}

describe('v2 stability', () => {
    it('stays finite over 10 000 ticks of random input among colliders and other cars', () => {
        const random = mulberry32(0x5eed);
        const colliders: ColliderInput[] = [];
        for (let i = 0; i < 80; i++) {
            const x = (random() - 0.5) * 200, z = (random() - 0.5) * 200;
            colliders.push(random() < 0.5
                ? { kind: 'circle', x, z, r: 0.35 + random() * 3, top: random() < 0.5 ? Infinity : 1 + random() * 4 }
                : { kind: 'box', x, z, hw: 0.25 + random() * 10, hd: 0.25 + random() * 10, top: Infinity });
        }
        const world = createSimWorld(DEFAULT_TERRAIN_CONFIG, colliders, []);
        const cars = CAR_CLASS_IDS.map((classId, i) => spawnCar(world, `car${i}`, classId, i * 8 - 16, -150, 0));
        const buttons = [0, BTN_HANDBRAKE, BTN_BOOST, BTN_JUMP, BTN_RESET, BTN_HANDBRAKE | BTN_BOOST];
        for (let tick = 0; tick < 10000; tick++) {
            for (const car of cars) {
                if (tick % 20 === 0) {
                    car.input.steer = Math.round((random() * 2 - 1) * 127);
                    car.input.throttle = Math.round(random() * 255);
                    car.input.brake = random() < 0.2 ? Math.round(random() * 255) : 0;
                    car.input.buttons = buttons[Math.floor(random() * buttons.length)];
                    car.mods.turbo = random() < 0.2;
                    car.mods.mega = random() < 0.1;
                    car.mods.ghost = random() < 0.1;
                    car.state.boostMeter = random() < 0.1 ? 1 : car.state.boostMeter;
                }
            }
            stepWorld(cars, world);
            for (const car of cars) {
                expectFinite(car.state);
                expect(Math.hypot(car.state.vx, car.state.vz)).toBeLessThanOrEqual(90 + 30);
                expect(Math.abs(car.state.yawRate)).toBeLessThanOrEqual(6);
            }
        }
    });

    for (const profile of ['standard', 'touch'] as AssistProfile[]) {
        it(`damps a push (1 m/s sideways, 0.8 rad/s) at 10-85 m/s, assists ${profile}`, () => {
            const world = createLongWorld();
            for (const classId of CAR_CLASS_IDS) {
                for (const speed of [10, 50, 70, 85]) {
                    const car = createSimCar('a', classId, profile);
                    placeVehicle(car.state, world, 0, -3900, 0);
                    car.state.vz = speed;
                    car.state.vx = 1;
                    car.state.yawRate = 0.8;
                    car.mods.turbo = speed > 72;
                    const boost = speed > car.base.topSpeed * (car.mods.turbo ? 1.3 : 1) + 1;
                    let peakEarly = 0, peakLate = 0;
                    drive(car, world, 180, () => {
                        if (boost) {
                            car.state.boostMeter = 1;
                            car.state.boosting = true;
                        }
                        return { throttle: speed < 20 ? 60 : 255, buttons: boost ? BTN_BOOST : 0 };
                    }, tick => {
                        const r = Math.abs(car.state.yawRate);
                        if (tick >= 30 && tick < 90) peakEarly = Math.max(peakEarly, r);
                        if (tick >= 120) peakLate = Math.max(peakLate, r);
                    });
                    const label = `${classId} at ${speed} m/s`;
                    expect(Math.abs(car.state.yawRate), label).toBeLessThan(0.05);
                    // No growing oscillation
                    expect(peakLate, label).toBeLessThanOrEqual(peakEarly + 1e-9);
                }
            }
        });
    }

    it('keeps a 0.1° yaw plus 5 cm/s sideways error below 15 cm after 120 ticks', () => {
        const world = createLongWorld();
        const scripts: Record<string, (tick: number) => Partial<VehicleInput>> = {
            grip: () => ({ throttle: 255, steer: 76 }),
            drift: tick => ({ throttle: 255, steer: 127, buttons: tick < 60 ? BTN_HANDBRAKE : 0 }),
            slalom: tick => ({ throttle: 255, steer: Math.floor(tick / 20) % 2 ? 127 : -127 }),
            trail: tick => ({ brake: tick > 20 ? 255 : 0, throttle: tick > 20 ? 0 : 255, steer: 127 })
        };
        for (const classId of CAR_CLASS_IDS) {
            for (const [name, script] of Object.entries(scripts)) {
                const run = (error: boolean) => {
                    const car = createSimCar('a', classId);
                    placeVehicle(car.state, world, 0, -3900, error ? 0.1 * DEG : 0);
                    car.state.vz = 30;
                    if (error) car.state.vx += 0.05;
                    drive(car, world, 120, script);
                    return car.state;
                };
                const a = run(false), b = run(true);
                expect(Math.hypot(a.x - b.x, a.z - b.z), `${classId} ${name}`).toBeLessThan(0.15);
            }
        }
    });
});

describe('v2 determinism', () => {
    it('repeats every golden scenario bit for bit', () => {
        for (const name of ['handbrake-drift-sport', 'contact-chain-three', 'contact-pit', 'ghost-through-car-and-building']) {
            const first = runScenario(findScenario(name)).cars.map(car => car.state);
            const second = runScenario(findScenario(name)).cars.map(car => car.state);
            expect(second).toStrictEqual(first);
        }
    });

    it('replays bit for bit from a copied state (all filter states live in VehicleState)', () => {
        const world = createSimWorld(DEFAULT_TERRAIN_CONFIG, [{ kind: 'box', x: 30, z: 60, hw: 5, hd: 5, top: Infinity }], []);
        const script = (tick: number): Partial<VehicleInput> => ({
            throttle: 255,
            steer: Math.round(Math.sin(tick / 9) * 127),
            buttons: (tick % 40 < 15 ? BTN_HANDBRAKE : 0) | (tick === 70 ? BTN_JUMP : 0) | (tick > 90 ? BTN_BOOST : 0)
        });
        const car = spawnCar(world, 'a', 'beetle', 0, 20, 0.2, 25);
        car.state.boostMeter = 0.8;
        let snapshot: VehicleState | null = null;
        drive(car, world, 120, script, tick => {
            if (tick === 59) snapshot = copyVehicleState(createVehicleState(), car.state);
        });
        const replay: SimCar = spawnCar(world, 'a', 'beetle', 0, 0, 0);
        copyVehicleState(replay.state, snapshot!);
        drive(replay, world, 60, tick => script(tick + 60));
        expect(replay.state).toStrictEqual(car.state);
    });

    it('triggers exactly one jump for a held key and ignores key repeat', () => {
        const world = createLongWorld();
        const car = spawnCar(world, 'a', 'bulli', 0, 0, 0);
        let jumps = 0;
        for (let tick = 0; tick < 60; tick++) {
            car.input.buttons = BTN_JUMP;
            stepVehicle(car, world);
            if (car.events.jumped) jumps++;
        }
        expect(jumps).toBe(1);
    });
});

describe('v2 performance', () => {
    it('steps 32 cars for 60 ticks well within budget', () => {
        const world = createSimWorld(DEFAULT_TERRAIN_CONFIG, [], []);
        const cars = Array.from({ length: 32 }, (_, i) =>
            spawnCar(world, `car${String(i).padStart(2, '0')}`, CAR_CLASS_IDS[i % 5], (i % 8) * 6 - 21, Math.floor(i / 8) * 8 - 12, 0, 20));
        for (const car of cars) {
            car.input.throttle = 255;
            car.input.steer = 40;
        }
        // Warm up the JIT, then measure
        for (let tick = 0; tick < 60; tick++) stepWorld(cars, world);
        const start = performance.now();
        for (let tick = 0; tick < 60; tick++) stepWorld(cars, world);
        const elapsed = performance.now() - start;
        console.log(`stepWorld, 32 cars: ${(elapsed / 60).toFixed(3)} ms per tick`);
        expect(elapsed).toBeLessThan(120);
    });
});
