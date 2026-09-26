import { describe, expect, it } from 'vitest';
import { BTN_HANDBRAKE, BTN_RESET, DT, SIM_TUNING } from '../../../src/shared/sim/constants.js';
import { cosineBump, createFlatWorld, createGroundWorld, FLAT_TERRAIN } from '../../../src/shared/sim/scenarios.js';
import type { CarClassId, SimCar } from '../../../src/shared/sim/types.js';
import { CAR_CLASS_IDS } from '../../../src/shared/sim/vehicleClasses.js';
import { stepVehicle } from '../../../src/shared/sim/world.js';
import { createSimWorld, rampEdgeColliders, type RampDef, type SimWorld } from '../../../src/shared/world/colliders.js';
import { getTerrainHeight } from '../../../src/shared/world/terrain.js';
import { DEFAULT_TERRAIN_CONFIG } from '../../../src/shared/constants.js';
import { DEG, drive, forwardSpeed, launch, spawnCar, speedOf } from './helpers.js';

// Vertical motion (suspension, crests, flight, landing), ramps, slopes and
// reset (docs/phase-1a-design.md, 6.4-6.7 and 26). GRAVITY is 20 m/s², the
// suspension 2 Hz with a damping ratio of 0.8 and 0.25 m to the bump stop.

const G = 20;

// A parabolic crest y = -z²/(2R) around z = 0 between straight grades of
// ±grade: its vertical curvature y'' = -1/R is the same all over the crest,
// so a car at horizontal speed v needs v²/R downwards to follow it
function parabolicCrest(R: number, grade: number) {
    const half = R * grade;
    return createGroundWorld((_x, z) => Math.abs(z) < half ? -z * z / (2 * R) : -(Math.abs(z) - half / 2) * grade);
}

// Drives a car along +z from z0 at a horizontal speed held at v (the
// vertical motion alone is measured); after(tick) runs after every tick
function holdSpeed(world: SimWorld, v: number, z0: number, ticks: number, after: (car: SimCar, tick: number) => void, classId: CarClassId = 'bulli'): SimCar {
    const car = spawnCar(world, 'a', classId, 0, z0, 0, v);
    for (let tick = 0; tick < ticks; tick++) {
        car.state.vx = 0;
        car.state.vz = v;
        car.state.yawRate = 0;
        stepVehicle(car, world);
        after(car, tick);
    }
    return car;
}

describe('v2 vertical motion: crests', () => {
    it('leaves a crest from v²/R > GRAVITY on, and stays on it below (threshold ±10 %)', () => {
        // R = 60 m: v* = √(20 · 60) = 34.64 m/s
        const R = 60, world = parabolicCrest(R, 0.25);
        const vStar = Math.sqrt(G * R);
        const flight = (v: number) => {
            let air = 0, gap = 0;
            holdSpeed(world, v, -40, Math.ceil(80 / v * 60), car => {
                if (!car.state.grounded) air++;
                gap = Math.max(gap, car.state.y - world.groundHeight(car.state.x, car.state.z));
            });
            return { air, gap };
        };
        for (const v of [0.5 * vStar, 0.9 * vStar]) {
            expect(flight(v), `${v.toFixed(1)} m/s`).toEqual({ air: 0, gap: 0 });
        }
        const over = flight(1.1 * vStar);
        expect(over.air).toBeGreaterThan(10);
        expect(over.gap).toBeGreaterThan(0.1);
    });

    it('takes a crest with the body: it rises on its springs by v²/R / ω² before the wheels leave', () => {
        // At 0.7 v* the body needs 0.49 g downwards: the spring unloads by
        // that, the body rides 0.49 · 20 / (2π · 2)² = 6.2 cm above rest
        const R = 60, world = parabolicCrest(R, 0.25);
        const v = 0.7 * Math.sqrt(G * R);
        let atTop = NaN;
        holdSpeed(world, v, -40, Math.ceil(50 / v * 60), car => {
            if (Number.isNaN(atTop) && car.state.z > 0) atTop = car.state.susp;
        });
        const omega = 2 * Math.PI * 2;
        expect(atTop).toBeGreaterThan(0.8 * (v * v / R) / (omega * omega));
        expect(atTop).toBeLessThan(1.2 * (v * v / R) / (omega * omega));
    });

    it('rides over a grade kink of 2 % at 45 m/s but leaves one of 8 %', () => {
        // A convex kink drops the ground away at v·Δs; the body falls at most
        // with g, so the wheels leave once (v·Δs)²/(2g) exceeds the spring's
        // extension g/ω² (12.7 cm): from Δs = 5 % at 45 m/s
        const kink = (ds: number) => createGroundWorld((_x, z) => z < 0 ? 0 : -ds * z);
        const air = (ds: number) => {
            let ticks = 0;
            holdSpeed(kink(ds), 45, -30, 90, car => { if (!car.state.grounded) ticks++; });
            return ticks;
        };
        expect(air(0.02)).toBe(0);
        expect(air(0.08)).toBeGreaterThan(0);
    });

    it('never goes below the ground, even at 85 m/s over bumps and into a steep hill', () => {
        // Three cosine bumps 0.4 m high and 12 m long, then a hill at 60 %
        // the flying car runs into
        const height = (_x: number, z: number) => {
            if (z > 0 && z < 60) {
                const k = z % 20;
                return k < 12 ? 0.2 * (1 - Math.cos(2 * Math.PI * k / 12)) : 0;
            }
            return z > 100 ? 0.6 * (z - 100) : 0;
        };
        const world = createGroundWorld(height);
        let lowest = Infinity, landings = 0;
        holdSpeed(world, 85, -40, 150, car => {
            const s = car.state;
            lowest = Math.min(lowest, s.y - world.groundHeight(s.x, s.z));
            if (car.events.landedImpact > 0) landings++;
            expect(Number.isFinite(s.y) && Number.isFinite(s.vy) && Number.isFinite(s.susp)).toBe(true);
        });
        expect(lowest).toBeGreaterThanOrEqual(0);
        expect(landings).toBeGreaterThan(0);
    });
});

describe('v2 vertical motion: flight and landing', () => {
    it('flies a projectile parabola: apex vy²/2g and time 2vy/g', () => {
        // Thrown up at 8 m/s from flat ground at 20 m/s: apex 64/40 = 1.6 m,
        // 0.8 s in the air, 16 m far less the air drag (under 1 %)
        const world = createFlatWorld();
        const car = spawnCar(world, 'a', 'bulli', 0, 0, 0, 20);
        car.state.vy = 8;
        car.state.grounded = false;
        let apex = 0, air = 0, landZ = NaN;
        drive(car, world, 120, {}, () => {
            apex = Math.max(apex, car.state.y);
            if (!car.state.grounded) air++;
            else if (Number.isNaN(landZ)) landZ = car.state.z;
        });
        // Semi-implicit Euler in 1/180 s substeps tops out vy·Δt/2 = 2.2 cm
        // below the exact apex
        expect(apex).toBeGreaterThan(64 / 40 - 0.03);
        expect(apex).toBeLessThanOrEqual(64 / 40);
        expect(air / 60).toBeGreaterThan(0.8 - 2 / 60);
        expect(air / 60).toBeLessThan(0.8 + 2 / 60);
        expect(landZ).toBeGreaterThan(0.97 * 20 * 0.8);
        expect(landZ).toBeLessThan(20 * 0.8 + 20 / 60);
    });

    it('lands without a bounce or a shake, from 3 m and from 10 m', () => {
        for (const drop of [3, 10]) {
            const world = createFlatWorld();
            const car = spawnCar(world, 'a', 'bulli', 0, 0, 0, 20);
            car.state.y = drop;
            car.state.grounded = false;
            let touched = -1, liftedAfter = 0, susp = 0, vy = 0;
            drive(car, world, 240, {}, tick => {
                if (touched < 0 && car.state.grounded) touched = tick;
                if (touched >= 0 && !car.state.grounded) liftedAfter++;
                if (touched >= 0 && tick === touched + 60) ({ susp, vy } = car.state);
            });
            expect(touched, `${drop} m`).toBeGreaterThan(0);
            // The wheels never leave the ground again: no bounce at all
            expect(liftedAfter, `${drop} m`).toBe(0);
            expect(car.state.y).toBe(0);
            // One second after touching down the body has settled
            expect(Math.abs(susp), `${drop} m`).toBeLessThan(0.005);
            expect(Math.abs(vy), `${drop} m`).toBeLessThan(0.02);
            expect(Math.abs(car.state.susp)).toBeLessThan(1e-4);
        }
    });

    it('flies off a ramp as far as its lip speed and GRAVITY say (±10 %)', () => {
        // 12 m long, 2 m high (1/6) at 30 m/s: vy = 5 m/s at the lip, 2 m
        // above the ground: t = (5 + √(25 + 2 · 20 · 2)) / 20 = 0.762 s, 22.9 m
        const ramp = { x: 0, z: 0, yaw: 0, width: 8, length: 12, height: 2 };
        const world = createFlatWorld([], [ramp]);
        let takeOff = NaN, landZ = NaN, lipVy = NaN;
        holdSpeed(world, 30, -60, 240, car => {
            if (Number.isNaN(takeOff) && !car.state.grounded) {
                takeOff = car.state.z;
                lipVy = car.state.vy;
            }
            if (!Number.isNaN(takeOff) && Number.isNaN(landZ) && car.state.grounded) landZ = car.state.z;
        });
        expect(takeOff).toBeGreaterThan(5.5);
        expect(takeOff).toBeLessThan(6.6);
        expect(lipVy).toBeGreaterThan(0.9 * 5);
        expect(lipVy).toBeLessThan(1.1 * 5);
        expect(landZ - 6).toBeGreaterThan(0.9 * 22.87);
        expect(landZ - 6).toBeLessThan(1.1 * 22.87);
    });

    it('is deterministic over crests, flights and landings', () => {
        const run = () => {
            const world = createGroundWorld(cosineBump(1.5, 12, 0));
            const car = spawnCar(world, 'a', 'jeep', 0, -40, 0, 30);
            drive(car, world, 180, tick => ({ throttle: 255, steer: tick > 50 && tick < 90 ? 60 : 0 }));
            return car.state;
        };
        expect(run()).toStrictEqual(run());
    });
});

describe('v2 ramps and terrain', () => {
    it('takes off at a ramp edge, flies and lands further on', () => {
        const ramp = { x: 0, z: -300, yaw: 0, width: 8, length: 16, height: 3 };
        const world = createFlatWorld([], [ramp]);
        expect(world.groundHeight(0, -308)).toBeCloseTo(0, 12);
        expect(world.groundHeight(0, -300)).toBeCloseTo(1.5, 12);
        expect(world.groundHeight(3.9, -292.01)).toBeCloseTo(3, 2);
        expect(world.groundHeight(4.1, -300)).toBe(0);
        const car = spawnCar(world, 'a', 'beetle', 0, -340, 0, 25);
        let takeOffZ = 0, landZ = 0, apex = 0;
        drive(car, world, 180, { throttle: 255 }, () => {
            if (!takeOffZ && !car.state.grounded) takeOffZ = car.state.z;
            if (takeOffZ && !landZ && car.state.grounded) landZ = car.state.z;
            apex = Math.max(apex, car.state.y);
        });
        expect(takeOffZ).toBeGreaterThan(-293);
        expect(takeOffZ).toBeLessThan(-290);
        expect(apex).toBeGreaterThan(3.5);
        expect(landZ - takeOffZ).toBeGreaterThan(15);
        expect(car.state.grounded).toBe(true);
    });

    it('follows the default terrain on the ground at speed', () => {
        const world = createSimWorld(DEFAULT_TERRAIN_CONFIG, [], []);
        const car = spawnCar(world, 'a', 'bulli', 250, -450, 0, 30);
        let groundedTicks = 0;
        drive(car, world, 600, { throttle: 180 }, () => {
            if (car.state.grounded) {
                groundedTicks++;
                expect(car.state.y).toBe(getTerrainHeight(DEFAULT_TERRAIN_CONFIG, car.state.x, car.state.z));
            }
        });
        expect(groundedTicks).toBeGreaterThan(560);
    });

    it('keeps rolling downhill on a steep slope without input and holds with the handbrake', () => {
        // h = 30·sin(0.01·x) + 30·cos(0.01·z), far from the flattened city
        const terrain = { ...FLAT_TERRAIN, size: 4000, frequency1: 0.01, amplitude1: 30 };
        const world = createSimWorld(terrain, [], []);
        // At x = 300π, z = 0 the slope is -0.3 along +x (downhill towards +x)
        const x = 300 * Math.PI;
        expect(world.groundHeight(x + 0.5, 0) - world.groundHeight(x - 0.5, 0)).toBeCloseTo(-0.3, 3);
        // A car standing still stays put (standstill snap), a rolling one
        // gains speed: 0.3·9.81 m/s² beat the 1.9 m/s² of rolling and engine drag
        const rolling = spawnCar(world, 'a', 'bulli', x, 0, Math.PI / 2, 2);
        drive(rolling, world, 60, {});
        expect(forwardSpeed(rolling.state)).toBeGreaterThan(2.8);
        const braking = spawnCar(world, 'a', 'bulli', x, 0, Math.PI / 2);
        // (The brake would start reversing after 8 ticks at a standstill)
        drive(braking, world, 60, { buttons: BTN_HANDBRAKE });
        expect(speedOf(braking)).toBeLessThan(0.1);
    });
});

describe('v2 ramp edges', () => {
    // The 20° kicker of the sandbox, 8 m wide and 12 m long, with its walls
    const kicker: RampDef = { x: 0, z: 0, yaw: 0, width: 8, length: 12, height: 12 * Math.tan(20 * DEG) };
    const withWalls = () => createFlatWorld(rampEdgeColliders(kicker, 0).map(wall => ({ ...wall })), [kicker]);

    it('reads the ramp slope, not the step at its edge: no push before take-off', () => {
        const world = createFlatWorld([], [kicker]);
        const car = spawnCar(world, 'a', 'beetle', 0, -20, 0, 20);
        let prevU = forwardSpeed(car.state), maxGain = -Infinity;
        drive(car, world, 90, {}, () => {
            if (car.state.grounded && car.state.z > -6) maxGain = Math.max(maxGain, forwardSpeed(car.state) - prevU);
            prevU = forwardSpeed(car.state);
        });
        // Coasting uphill only ever loses speed
        expect(maxGain).toBeLessThan(0);
    });

    it('lands beside or on the edge of a ramp with the impact of its vertical speed', () => {
        for (const x0 of [4.2, 4.6, 5.5]) {
            const world = createFlatWorld([], [kicker]);
            const car = spawnCar(world, 'a', 'beetle', x0, -3, -Math.PI / 2);
            const onRamp = x0 < 4;
            car.state.vx = -20;
            car.state.vy = -5;
            car.state.y = world.groundHeight(x0 - 0.5, -3) + 0.1;
            car.state.grounded = false;
            let impact = 0;
            drive(car, world, 30, {}, () => {
                if (!impact && car.events.landedImpact > 0) impact = car.events.landedImpact;
            });
            expect(impact, `x0 ${x0}${onRamp ? ' on the ramp' : ''}`).toBeGreaterThan(4);
            expect(impact, `x0 ${x0}`).toBeLessThan(7);
        }
    });

    it('the walls stop a car flying at the front or side of the ramp below its top', () => {
        const runs = [
            { x: 0, z: 30, yaw: Math.PI },          // towards the high front face
            { x: 25, z: 3, yaw: -Math.PI / 2 },     // towards a side, high part
            { x: -25, z: 4, yaw: Math.PI / 2 }
        ];
        for (const run of runs) {
            for (let jumpTick = 0; jumpTick <= 30; jumpTick += 5) {
                const world = withWalls();
                const car = spawnCar(world, 'a', 'beetle', run.x, run.z, run.yaw, 15);
                let prevY = car.state.y, maxY = 0;
                // Thrown up at 10.5 m/s: apex 110 / 40 = 2.76 m, clear of the
                // 0.35 m landing step below the ramp's side (3.3 m at z = 3)
                drive(car, world, 120, tick => {
                    if (tick === jumpTick) launch(car, 10.5);
                    return { throttle: 255 };
                }, () => {
                    // The underside never pops up by more than the flight allows
                    expect(car.state.y - prevY, `${run.x}/${run.z} jump at ${jumpTick}`)
                        .toBeLessThanOrEqual(Math.max(0, car.state.vy) * DT + 0.2);
                    prevY = car.state.y;
                    maxY = Math.max(maxY, car.state.y);
                });
                // It never got onto the ramp: the throw alone reaches 2.76 m
                expect(maxY).toBeLessThan(2.8);
                expect(car.state.y).toBe(0);
            }
        }
    });

    it('rolls off a side of the ramp without a sideways jump', () => {
        for (const classId of CAR_CLASS_IDS) {
            for (const [speed, yawDeg] of [[8, 80], [20, 80], [8, 100], [20, 90]]) {
                const low: RampDef = { x: 0, z: 0, yaw: 0, width: 8, length: 16, height: 16 * Math.tan(10 * DEG) };
                const world = createFlatWorld(rampEdgeColliders(low, 0).map(wall => ({ ...wall })), [low]);
                const car = spawnCar(world, 'a', classId, 0, -6.5, yawDeg * DEG, speed);
                car.state.y = world.groundHeight(0, -6.5);
                let { x, z } = car.state;
                drive(car, world, 60, { throttle: 128 }, () => {
                    const moved = Math.hypot(car.state.x - x, car.state.z - z);
                    expect(moved, `${classId} ${speed} m/s ${yawDeg}°`).toBeLessThanOrEqual(speedOf(car) * DT + 0.05);
                    ({ x, z } = car.state);
                });
                expect(car.state.x).toBeGreaterThan(4 + 1);
            }
        }
    });
});

describe('v2 reset', () => {
    it('resets after holding R for 30 ticks: stops, stands on the ground and ghosts cars', () => {
        const world = createFlatWorld([{ kind: 'box', x: 0, z: 0, hw: 5, hd: 5, top: Infinity }]);
        const car = spawnCar(world, 'a', 'bulli', 0, -8, 0, 0);
        // Wedged half into the building
        car.state.z = -5.5;
        car.state.vz = 3;
        let resets = 0, resetTick = -1;
        drive(car, world, 60, { buttons: BTN_RESET, throttle: 255 }, tick => {
            if (car.events.reset) { resets++; resetTick = tick; }
        });
        expect(resets).toBe(1);
        expect(resetTick).toBe(29);
        expect(car.state.ghostTicks).toBe(SIM_TUNING.RESET_GHOST_TICKS - 31);
        // Free of the building (front circle radius 1.3 at +0.7)
        expect(car.state.z + 0.7 + 1.3).toBeLessThanOrEqual(-5 + 1e-6);
    });

    it('does not reset on a short press', () => {
        const world = createFlatWorld();
        const car = spawnCar(world, 'a', 'bulli', 0, 0, 0, 10);
        drive(car, world, 29, { buttons: BTN_RESET });
        drive(car, world, 5, {});
        expect(car.state.ghostTicks).toBe(0);
        expect(speedOf(car)).toBeGreaterThan(5);
    });
});
