import { describe, expect, it } from 'vitest';
import { BTN_HANDBRAKE, BTN_RESET, DT, SIM_TUNING } from '../../../src/shared/sim/constants.js';
import { cosineBump, createFlatWorld, createGroundWorld, FLAT_TERRAIN } from '../../../src/shared/sim/scenarios.js';
import type { CarClassId, SimCar } from '../../../src/shared/sim/types.js';
import { CAR_CLASS_IDS } from '../../../src/shared/sim/vehicleClasses.js';
import { stepVehicle } from '../../../src/shared/sim/world.js';
import { stepVertical } from '../../../src/shared/sim/vehicle.js';
import { resetTuning } from '../../../src/shared/sim/tuning.js';
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

    it('rides over a grade kink of 3.4 % at 45 m/s but leaves one of 6.5 %', () => {
        // A convex kink drops the ground away at V = v·Δs. The spring cannot
        // pull, so the body decelerates at most with g and at least as a
        // clamped spring (F = g − k·s ≥ 0, the damper only lowers F): it
        // stays on the ground while V/ω ≤ g/ω² (the spring alone catches it:
        // Δs ≤ g/(ω·v) = 3.5 %) and leaves for sure once even the ballistic
        // rise clears the full extension plus SUSP_LIFT: (V − g·1 m/v)²/(2g)
        // > 12.7 + 2 cm (the gradient's ±0.5 m spreads the kink over 1 m,
        // 22 ms in which the body keeps up with the ground at g), from
        // Δs = 6.4 %. Lift-off at 1.5 times the extension, or a damper that
        // may pull (no clamp), keeps the car on the ground at 6.5 %.
        const kink = (ds: number) => createGroundWorld((_x, z) => z < 0 ? 0 : -ds * z);
        const air = (ds: number) => {
            let ticks = 0;
            holdSpeed(kink(ds), 45, -30, 90, car => { if (!car.state.grounded) ticks++; });
            return ticks;
        };
        expect(air(0.034)).toBe(0);
        expect(air(0.065)).toBeGreaterThan(0);
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

describe('v2 vertical motion: steep flanks, touchdown and the lift-off margin', () => {
    // Flat ground, then a flank of the grade up to height H, then a plateau
    const flank = (grade: number, H: number) => createGroundWorld((_x, z) => Math.min(H, Math.max(0, z * grade)));
    const energy = (car: SimCar) => (car.state.vx ** 2 + car.state.vy ** 2 + car.state.vz ** 2) / 2;

    it('turns its speed up a steep flank instead of gaining energy: apex at most (v/2)²/2g over the top', () => {
        // Coasting at 20 m/s into a flank 3 m high (26.9). The ground pushes
        // along its normal and inelastically: at 100 % it leaves (v/2, v/2)
        // of (v, 0), half the kinetic energy, and the climb costs more. So
        // ½|v|² never exceeds its start, and the car leaves the top at
        // about vy ≤ v/2 (the compressed spring gives a little back): apex
        // under (v/2)²/(2g) = 2.5 m over the plateau (measured 1.4 m at
        // 100 %, 0.7 m at 300 %). Before, vy was raised to ∇h·v without any
        // cost: at 100 % 1.9 times the energy and 8.8 m over the plateau, at
        // 300 % 8.2 times and 72 m.
        for (const grade of [1, 3]) {
            const v = 20, world = flank(grade, 3);
            const car = spawnCar(world, 'a', 'bulli', 0, -5, 0, v);
            let most = 0, apex = 0;
            drive(car, world, 180, {}, () => {
                most = Math.max(most, energy(car));
                apex = Math.max(apex, car.state.y - 3);
            });
            expect(most, `${grade * 100} %`).toBeLessThanOrEqual(v * v / 2);
            expect(apex, `${grade * 100} %`).toBeLessThan((v / 2) ** 2 / (2 * G));
        }
    });

    it('hits a flank on its bump stop inelastically: keeps 1/(1 + s²) of its speed into a grade s', () => {
        // A 100 % flank rising towards (0.6, 0.8), the car at 20 m/s up it,
        // v = (12, 16), the body on the bump stop and not yet moving up
        // (vy = 0). The ground pushes along its normal (-0.6, 1, -0.8) and
        // takes the velocity component into it: λ = ∇h·v/(1 + |∇h|²) =
        // 20/2 = 10, leaving v = (12, 16) − 10·(0.6, 0.8) = (6, 8) and
        // vy = 10 (= ∇h·v, along the ground). In a substep of 1 µs the
        // spring adds nothing measurable. Before, vy jumped to 20 and the
        // car kept its 20 m/s.
        const world = createGroundWorld((x, z) => 0.6 * x + 0.8 * z);
        const car = spawnCar(world, 'a', 'bulli', 0, 0, Math.atan2(0.6, 0.8), 20);
        const onStop = -SIM_TUNING.SUSP_TRAVEL - 0.01;
        Object.assign(car.state, { y: 0, vy: 0, susp: onStop, grounded: true });
        stepVertical(car, world, 1e-6);
        expect(car.state.vx).toBeCloseTo(6, 3);
        expect(car.state.vz).toBeCloseTo(8, 3);
        expect(car.state.vy).toBeCloseTo(10, 3);
        // A body already rising faster than the ground is not pulled back
        const rising = spawnCar(world, 'b', 'bulli', 0, 0, Math.atan2(0.6, 0.8), 20);
        Object.assign(rising.state, { y: 0, vy: 25, susp: onStop, grounded: true });
        stepVertical(rising, world, 1e-6);
        expect(rising.state.vy).toBeCloseTo(25, 3);
        expect(rising.state.vz).toBeCloseTo(16, 3);
    });

    it('takes the bump stop before the spring acts, and catches the body on it after', () => {
        // Before: up a 20 % grade at 20 m/s along z, on the bump stop,
        // vy = 0. The stop leaves vz = 20 − 0.2·λ with λ = 4/1.04 = 3.846:
        // 19.231, vy = 3.846 = ∇h·v. Then the spring on the stop (k·0.25 =
        // 39.48 above g; the damper sees vy = ∇h·v) adds 39.48/180 = 0.219
        // upwards and, below FLANK_FROM, nothing to vz. Without the first
        // stop the damper would take the push, vz stays 19.36.
        const grade = createGroundWorld((_x, z) => 0.2 * z);
        const up = spawnCar(grade, 'a', 'bulli', 0, 0, 0, 20);
        Object.assign(up.state, { y: 0, vy: 0, susp: -SIM_TUNING.SUSP_TRAVEL - 0.01, grounded: true });
        stepVertical(up, grade, 1 / 180);
        const lambda = 4 / 1.04, k = (4 * Math.PI) ** 2;
        expect(up.state.vz).toBeCloseTo(20 - 0.2 * lambda, 9);
        expect(up.state.vy).toBeCloseTo(lambda + k * 0.25 / 180, 9);
        // After: on flat ground 24 cm compressed and sinking at 5 m/s, the
        // spring and damper (20 + 37.9 + 100.5 m/s²) slow it to 4.23 m/s in
        // the substep, which still takes it 2.35 cm down, past the stop:
        // there it stops dead (inelastic, vy = 0), no deeper than 25 cm.
        const flat = createFlatWorld();
        const down = spawnCar(flat, 'b', 'bulli', 0, 0, 0, 0);
        Object.assign(down.state, { y: 0, vy: -5, susp: -0.24, grounded: true });
        stepVertical(down, flat, 1 / 180);
        expect(down.state.susp).toBe(-SIM_TUNING.SUSP_TRAVEL);
        expect(down.state.vy).toBe(0);
    });

    it('pays for the push up a steep flank with speed along its travel, never sideways', () => {
        // A 100 % flank rising towards +x. Diagonally up it at (10, 10) m/s,
        // the body moving with the ground (vy = ∇h·v = 10) and 20 cm
        // compressed: the spring alone speeds it up by
        // Δvy = k·0.2·Δt = (4π)²·0.2/180 = 0.1755 m/s. That costs
        // (∇h·v̂)·Δvy along the travel: v shrinks by (∇h·v)/|v|²·Δvy = Δvy/20,
        // both components alike (a push along the normal would also take
        // Δvy off vx alone). Along the contour (∇h·v = 0) nothing is taken,
        // so a car crossing a bumpy bank is not pushed down it.
        const world = createGroundWorld(x => x);
        const dt = 1 / 180, dvy = (4 * Math.PI) ** 2 * 0.2 * dt;
        const up = spawnCar(world, 'a', 'bulli', 5, 0, Math.PI / 4, 0);
        Object.assign(up.state, { y: 5, vx: 10, vz: 10, vy: 10, susp: -0.2, grounded: true });
        stepVertical(up, world, dt);
        expect(up.state.vx).toBeCloseTo(10 * (1 - dvy / 20), 9);
        expect(up.state.vz).toBeCloseTo(10 * (1 - dvy / 20), 9);
        const across = spawnCar(world, 'b', 'bulli', 5, 0, 0, 0);
        Object.assign(across.state, { y: 5, vx: 0, vz: 20, vy: 0, susp: -0.2, grounded: true });
        stepVertical(across, world, dt);
        expect(across.state.vx).toBe(0);
        expect(across.state.vz).toBe(20);
        expect(across.state.vy).toBeGreaterThan(0);
        // Halfway between FLANK_FROM (25 %) and FLANK_FULL (50 %) half the
        // share: straight up a 37.5 % grade at 10 m/s, v shrinks by
        // 0.375·10/100 · Δvy · 0.5
        const mid = createGroundWorld(x => 0.375 * x);
        const half = spawnCar(mid, 'c', 'bulli', 5, 0, Math.PI / 2, 0);
        Object.assign(half.state, { y: 1.875, vx: 10, vz: 0, vy: 3.75, susp: -0.2, grounded: true });
        stepVertical(half, mid, dt);
        expect(half.state.vx).toBeCloseTo(10 * (1 - 0.0375 * dvy * 0.5), 9);
        // A body the spring lets sink (above its rest, F < g) costs nothing
        // and gives nothing back
        const light = spawnCar(world, 'd', 'bulli', 5, 0, Math.PI / 4, 0);
        Object.assign(light.state, { y: 5, vx: 10, vz: 10, vy: 10, susp: 0.1, grounded: true });
        stepVertical(light, world, dt);
        expect(light.state.vx).toBe(10);
        expect(light.state.vz).toBe(10);
    });

    it('drives up the steepest road grade (20 %) as before: the flank rule starts at 25 %', () => {
        // Regression lock: roads (maxGrade at most 20 %) and ramps (at most
        // 2.2 m on 12 m, 18 %) keep their speeds. Coasting at 25 m/s into a
        // 20 % grade the push of the suspension costs no horizontal speed,
        // the car loses only what G_SLOPE · 0.2 and the resistances take;
        // with the flank rule at every grade it loses 0.9 m/s more at the
        // foot.
        const run = (flankFrom: number) => {
            SIM_TUNING.FLANK_FROM = flankFrom;
            SIM_TUNING.FLANK_FULL = flankFrom + 0.2;
            const world = flank(0.2, 5);
            const car = spawnCar(world, 'a', 'bulli', 0, -10, 0, 25);
            drive(car, world, 40, {});
            return car.state.vz;
        };
        const speed = run(0.2);
        const always = run(0);
        resetTuning();
        expect(speed - always).toBeGreaterThan(0.2);
    });

    it('touches down with the body at full extension over the wheels: the spring takes over from there', () => {
        // One substep of 1/180 s from 1 cm above flat ground at -6 m/s: the
        // underside ends 3.395 cm lower, 2.395 cm "below" the ground. The
        // wheels land on the ground and the body keeps its height: 2.395 cm
        // under the full extension g/k = 20/(4π)² = 12.665 cm.
        const world = createFlatWorld();
        const car = spawnCar(world, 'a', 'bulli', 0, 0, 0, 20);
        Object.assign(car.state, { y: 0.01, vy: -6, grounded: false, susp: 0 });
        const dt = 1 / 180;
        stepVertical(car, world, dt);
        const extension = G / (4 * Math.PI) ** 2;
        const below = -(0.01 + (-6 - G * dt) * dt);
        expect(car.state.grounded).toBe(true);
        expect(car.state.y).toBe(0);
        expect(car.state.susp).toBeCloseTo(extension - below, 12);
        expect(car.events.landedImpact).toBeCloseTo(6 + G * dt, 12);
    });

    it('lands on a grade with the impact of its speed across the ground, ∇h·v − vy', () => {
        // Flying level at 20 m/s along +z, 0.3 m above a 20 % uphill and
        // falling at 3 m/s: the gap closes at 4 + 3 m/s + g·t, so it lands
        // after t = (−7 + √(49 + 4·10·0.3))/20 = 40.5 ms at vy = −3.81 m/s,
        // impact 4 + 3.81 = 7.81 m/s. Over a 20 % downhill falling at 5 m/s
        // the ground drops away at 4: t = (−1 + √13)/20 = 130 ms, impact
        // 1 + 2.61 = 3.61 m/s. The substeps land up to g/180 s later.
        for (const [grade, fall] of [[0.2, 3], [-0.2, 5]]) {
            const world = createGroundWorld((_x, z) => grade * z);
            const car = spawnCar(world, 'a', 'bulli', 0, 0, 0, 20);
            Object.assign(car.state, { y: 0.3, vy: -fall, grounded: false, airTicks: 5 });
            const closing = grade * 20 + fall;
            const t = (-closing + Math.sqrt(closing * closing + 4 * (G / 2) * 0.3)) / G;
            const impact = closing + G * t;
            let first = 0;
            drive(car, world, 20, {}, () => {
                if (!first && car.events.landedImpact > 0) first = car.events.landedImpact;
            });
            expect(first, `grade ${grade}`).toBeGreaterThan(impact - 0.05);
            expect(first, `grade ${grade}`).toBeLessThan(impact + G / 180 + 0.05);
        }
    });

    it('keeps its wheels on the ground while the body rises less than SUSP_LIFT over the full extension', () => {
        // Flat ground, the body 1.5 cm above the full extension, still
        // rising. The spring cannot pull, the body flies ballistically
        // relative to the wheels: at 0.3 m/s it rises 0.3²/40 = 0.23 cm more,
        // 1.73 cm in all, under the 2 cm margin: the wheels keep touching
        // (drive and steering stay on). At 1 m/s it rises 2.5 cm more: off.
        const world = createFlatWorld();
        const extension = G / (4 * Math.PI) ** 2;
        const hop = (vy: number) => {
            const car = spawnCar(world, 'a', 'bulli', 0, 0, 0, 20);
            Object.assign(car.state, { susp: extension + 0.015, vy });
            let air = 0;
            drive(car, world, 20, { throttle: 255 }, () => { if (!car.state.grounded) air++; });
            return air;
        };
        expect(hop(0.3)).toBe(0);
        expect(hop(1)).toBeGreaterThan(0);
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
