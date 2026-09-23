import { describe, expect, it } from 'vitest';
import { BTN_BOOST, BTN_HANDBRAKE, DT, SIM_TUNING, V_ABS } from '../../../src/shared/sim/constants.js';
import type { AssistProfile, CarClassId, SimCar } from '../../../src/shared/sim/types.js';
import { createSimCar, placeVehicle } from '../../../src/shared/sim/vehicle.js';
import { CAR_CLASS_IDS, VEHICLE_CLASSES } from '../../../src/shared/sim/vehicleClasses.js';
import { createLongWorld, DEG, drive, forwardSpeed, restoreTuningAfterEach, slipAngle, speedOf } from './helpers.js';

// Section 14.2 of docs/phase-1a-design.md: ranges, not exact values, so
// tuning can move within them. The 0-100 references are the prototype
// measurements of section 1.2.

const ZERO_TO_100: Record<CarClassId, number> = { bulli: 3.52, pickup: 3.80, sport: 2.80, beetle: 2.75, jeep: 3.17 };

const world = createLongWorld();
// Starts at the south end, heading north (+z), with room for 30 s at vtop
function start(classId: CarClassId, speed = 0, profile: AssistProfile = 'standard', z = -3900): SimCar {
    const car = createSimCar('a', classId, profile);
    placeVehicle(car.state, world, 0, z, 0);
    car.state.vz = speed;
    return car;
}

describe('v2 longitudinal dynamics', () => {
    for (const classId of CAR_CLASS_IDS) {
        const vtop = VEHICLE_CLASSES[classId].topSpeed;

        describe(classId, () => {
            it('has a base top speed of 45-55 m/s', () => {
                expect(vtop).toBeGreaterThanOrEqual(45);
                expect(vtop).toBeLessThanOrEqual(55);
            });

            it('reaches 100 km/h within ±15 % of the reference and holds vtop ± 0.5 at full throttle', () => {
                const car = start(classId);
                let t100 = 0;
                drive(car, world, 30 * 60, { throttle: 255 }, tick => {
                    if (!t100 && speedOf(car) >= 100 / 3.6) t100 = (tick + 1) * DT;
                });
                expect(t100).toBeGreaterThan(ZERO_TO_100[classId] * 0.85);
                expect(t100).toBeLessThan(ZERO_TO_100[classId] * 1.15);
                expect(Math.abs(speedOf(car) - vtop)).toBeLessThanOrEqual(0.5);
            });

            it('stops from vtop within 45-65 m', () => {
                const car = start(classId, vtop);
                const z0 = car.state.z;
                let ticks = 0;
                while (speedOf(car) > 0.05 && ticks < 600) {
                    drive(car, world, 1, { brake: 255 });
                    ticks++;
                }
                const distance = car.state.z - z0;
                expect(distance).toBeGreaterThan(45);
                expect(distance).toBeLessThan(65);
                // Braking to a stop never rolls back
                expect(forwardSpeed(car.state)).toBeGreaterThanOrEqual(0);
            });

            it('boosts from vtop to at least vtop + 12 in 2.2 s and towards vtop + 20', () => {
                const car = start(classId, vtop);
                car.state.boostMeter = 1;
                drive(car, world, 132, { throttle: 255, buttons: BTN_BOOST });
                expect(speedOf(car)).toBeGreaterThanOrEqual(vtop + 12);
                // A full meter lasts 1/0.45 s; keep it topped up to see the target
                drive(car, world, 600, () => {
                    car.state.boostMeter = 1;
                    return { throttle: 255, buttons: BTN_BOOST };
                });
                expect(speedOf(car)).toBeGreaterThan(vtop + 19.5);
                expect(speedOf(car)).toBeLessThanOrEqual(vtop + 20);
            });

            it('never exceeds 85 m/s with Turbo and Boost', () => {
                const car = start(classId);
                car.mods.turbo = true;
                let max = 0;
                drive(car, world, 60 * 60, () => {
                    car.state.boostMeter = 1;
                    return { throttle: 255, buttons: BTN_BOOST };
                }, () => {
                    max = Math.max(max, speedOf(car));
                });
                expect(max).toBeLessThanOrEqual(V_ABS);
                expect(max).toBeGreaterThan(Math.min(vtop * 1.3 + 20, V_ABS) - 1);
            });

            it('Turbo alone reaches vtop · 1.3 and the overspeed decays after it ends', () => {
                const car = start(classId);
                car.mods.turbo = true;
                drive(car, world, 40 * 60, { throttle: 255 });
                expect(Math.abs(speedOf(car) - vtop * 1.3)).toBeLessThanOrEqual(0.5);
                car.mods.turbo = false;
                drive(car, world, 10 * 60, { throttle: 255 });
                expect(Math.abs(speedOf(car) - vtop)).toBeLessThanOrEqual(0.5);
            });
        });
    }

    it('only reverses after the brake was held for 8 ticks at a standstill', () => {
        const car = start('bulli', 0, 'standard', 0);
        drive(car, world, 7, { brake: 255 });
        expect(forwardSpeed(car.state)).toBe(0);
        drive(car, world, 60, { brake: 255 });
        expect(forwardSpeed(car.state)).toBeLessThan(-1);
        // Reverse is limited to 15 m/s
        drive(car, world, 20 * 60, { brake: 255 });
        expect(forwardSpeed(car.state)).toBeGreaterThan(-15.5);
        expect(forwardSpeed(car.state)).toBeLessThan(-14);
    });

    it('throttle while rolling backwards brakes before driving forward', () => {
        const car = start('bulli', -10);
        drive(car, world, 30, { throttle: 255 });
        expect(forwardSpeed(car.state)).toBeGreaterThan(-5);
    });

    it('coasts to a full stop without input', () => {
        const car = start('beetle', 10);
        drive(car, world, 20 * 60, {});
        expect(car.state.vx).toBe(0);
        expect(car.state.vz).toBe(0);
    });
});

describe('v2 lateral dynamics', () => {
    restoreTuningAfterEach();

    for (const gripScale of [1, 1.5]) {
        for (const profile of ['standard', 'touch'] as AssistProfile[]) {
            describe(`gripScale ${gripScale}, assists ${profile}`, () => {
                for (const classId of CAR_CLASS_IDS) {
                    it(`${classId}: corners, drifts and recovers without spinning`, () => {
                        SIM_TUNING.gripScale = gripScale;

                        // Full lock at 20 m/s: radius 15-25 m at grip 1 (tighter with more grip)
                        let car = start(classId, 20, profile);
                        drive(car, world, 360, () => ({ steer: 127, throttle: speedOf(car) < 20 ? 255 : 26 }));
                        const radius = speedOf(car) / Math.abs(car.state.yawRate);
                        if (gripScale === 1) {
                            expect(radius).toBeGreaterThan(15);
                            expect(radius).toBeLessThan(25);
                        } else {
                            expect(radius).toBeGreaterThan(9);
                            expect(radius).toBeLessThan(20);
                        }

                        // Handbrake kick at 25 m/s: β max 15-50°, never beyond 90°
                        car = start(classId, 25, profile);
                        let betaMax = 0;
                        drive(car, world, 240, tick => ({
                            throttle: tick < 24 ? 77 : 204,
                            steer: tick < 45 ? 127 : 0,
                            buttons: tick < 24 ? BTN_HANDBRAKE : 0
                        }), () => {
                            betaMax = Math.max(betaMax, Math.abs(slipAngle(car.state)));
                        });
                        expect(betaMax).toBeGreaterThan(15 * DEG);
                        expect(betaMax).toBeLessThan(50 * DEG);
                        // ...and settles again
                        expect(Math.abs(slipAngle(car.state))).toBeLessThan(5 * DEG);

                        // Held handbrake drift with throttle for 3 s: no spin
                        car = start(classId, 25, profile);
                        let driftMax = 0;
                        let drifted = false;
                        drive(car, world, 180, { throttle: 255, steer: 127, buttons: BTN_HANDBRAKE }, () => {
                            driftMax = Math.max(driftMax, Math.abs(slipAngle(car.state)));
                            drifted ||= car.events.drifting;
                        });
                        expect(driftMax).toBeLessThan(90 * DEG);
                        expect(drifted).toBe(true);

                        // Full-lock slalom at 40 m/s every 0.5 s: no spin
                        car = start(classId, 40, profile);
                        let slalomMax = 0;
                        drive(car, world, 360, tick => ({ throttle: 255, steer: Math.floor(tick / 30) % 2 ? 127 : -127 }), () => {
                            slalomMax = Math.max(slalomMax, Math.abs(slipAngle(car.state)));
                        });
                        expect(slalomMax).toBeLessThan(90 * DEG);

                        // Full braking in a full-lock corner at 35 m/s: β < 60°
                        car = start(classId, 35, profile);
                        let trailMax = 0;
                        drive(car, world, 120, tick => ({
                            brake: tick > 30 ? 255 : 0,
                            throttle: tick > 30 ? 0 : 255,
                            steer: 127
                        }), () => {
                            if (forwardSpeed(car.state) > 10) trailMax = Math.max(trailMax, Math.abs(slipAngle(car.state)));
                        });
                        expect(trailMax).toBeLessThan(60 * DEG);
                    });
                }
            });
        }
    }

    it('fills the boost meter while drifting, but not while scrubbing along a wall', () => {
        const car = start('bulli', 25);
        drive(car, world, 120, { throttle: 255, steer: 127, buttons: BTN_HANDBRAKE });
        expect(car.state.boostMeter).toBeGreaterThan(0.1);

        const scrubbing = start('bulli', 25);
        drive(scrubbing, world, 120, () => {
            scrubbing.state.wallTicks = 0;
            return { throttle: 255, steer: 127, buttons: BTN_HANDBRAKE };
        });
        expect(scrubbing.state.boostMeter).toBe(0);
    });

    it('starts a boost only from 15 % and drains 0.45 per second', () => {
        const car = start('bulli', 30);
        car.state.boostMeter = 0.14;
        drive(car, world, 5, { throttle: 255, buttons: BTN_BOOST });
        expect(car.state.boosting).toBe(false);
        car.state.boostMeter = 0.5;
        let started = 0;
        drive(car, world, 60, { throttle: 255, buttons: BTN_BOOST }, () => {
            if (car.events.boostStarted) started++;
        });
        expect(started).toBe(1);
        expect(car.state.boostMeter).toBeCloseTo(0.5 - 0.45, 6);
        drive(car, world, 120, { throttle: 255, buttons: BTN_BOOST });
        expect(car.state.boostMeter).toBe(0);
        expect(car.state.boosting).toBe(false);
    });

    it('holds a drift with hysteresis and ends it 10 ticks after β drops below 6°', () => {
        const car = start('sport', 28);
        drive(car, world, 40, { throttle: 255, steer: 127, buttons: BTN_HANDBRAKE });
        expect(car.state.driftTicks).toBeGreaterThan(0);
        // Turns the velocity to the slip angle beta before a tick
        const setSlip = (beta: number) => {
            const s = car.state, v = Math.hypot(s.vx, s.vz);
            s.vx = v * Math.sin(s.yaw + beta);
            s.vz = v * Math.cos(s.yaw + beta);
            s.yawRate = 0;
        };
        // Ticks 1-4 low, tick 5 back up: a dip shorter than 10 ticks keeps
        // the drift. From tick 20 on β stays low: it ends on the 10th low tick.
        let lowRun = 0, dipLow = 0, endTick = -1, lowAtEnd = -1;
        drive(car, world, 60, { throttle: 255 }, tick => {
            const low = Math.abs(slipAngle(car.state)) < 6 * DEG;
            lowRun = low ? lowRun + 1 : 0;
            if (tick >= 1 && tick <= 4 && low) dipLow++;
            if (tick < 20) expect(car.state.driftTicks, `tick ${tick}`).toBeGreaterThan(0);
            if (endTick < 0 && car.state.driftTicks === 0) {
                endTick = tick;
                lowAtEnd = lowRun;
            }
            if (tick < 4 || tick >= 19) setSlip(0);
            else if (tick === 4) setSlip(25 * DEG);
        });
        expect(dipLow).toBe(4);
        expect(endTick).toBeGreaterThan(20);
        expect(lowAtEnd).toBe(10);
        expect(car.state.driftLowTicks).toBe(0);
    });

    it('driftReleaseKick adds speed once after a long drift, at most up to vtop', () => {
        SIM_TUNING.driftReleaseKick = 3;
        const car = start('sport', 28);
        drive(car, world, 90, { throttle: 255, steer: 127, buttons: BTN_HANDBRAKE });
        const without = start('sport', 28);
        SIM_TUNING.driftReleaseKick = 0;
        drive(without, world, 90, { throttle: 255, steer: 127, buttons: BTN_HANDBRAKE });
        SIM_TUNING.driftReleaseKick = 3;
        drive(car, world, 120, { throttle: 255 });
        SIM_TUNING.driftReleaseKick = 0;
        drive(without, world, 120, { throttle: 255 });
        expect(speedOf(car)).toBeGreaterThan(speedOf(without) + 1);
        expect(speedOf(car)).toBeLessThanOrEqual(55 + 1e-9);
    });
});
