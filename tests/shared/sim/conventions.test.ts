import { describe, expect, it } from 'vitest';
import { BTN_HANDBRAKE, DT } from '../../../src/shared/sim/constants.js';
import { resolveContact } from '../../../src/shared/sim/contact.js';
import { tireCurve } from '../../../src/shared/sim/tire.js';
import { createFlatWorld } from '../../../src/shared/sim/scenarios.js';
import { DEG, drive, slipAngle, spawnCar } from './helpers.js';

// Section 3 of docs/phase-1a-design.md: these conventions carry every
// formula of the sim, so they are pinned before anything else.

describe('sim conventions', () => {
    it('steering left at 20 m/s turns the yaw up and moves the car towards l', () => {
        const world = createFlatWorld();
        const car = spawnCar(world, 'a', 'bulli', 0, 0, 0, 20);
        drive(car, world, 60, { steer: 127, throttle: 128 });
        expect(car.state.yaw).toBeGreaterThan(0.3);
        expect(car.state.yawRate).toBeGreaterThan(0);
        // l = (cos 0, -sin 0) = +x at the start heading
        expect(car.state.x).toBeGreaterThan(1);
    });

    it('a push to the left on the nose turns the car left', () => {
        const world = createFlatWorld();
        const car = spawnCar(world, 'a', 'bulli', 0, 0, 0);
        // A beetle on the right of the nose, closing in along +x (= l)
        const pusher = spawnCar(world, 'b', 'beetle', -2.3, car.params.colliderOffset, Math.PI / 2, 5);
        resolveContact(car, pusher);
        expect(car.state.yawRate).toBeGreaterThan(0);
        expect(car.state.vx).toBeGreaterThan(0);
    });

    it('handbrake plus left at 25 m/s swings the tail out (β < 0)', () => {
        const world = createFlatWorld();
        const car = spawnCar(world, 'a', 'bulli', 0, 0, 0, 25);
        let minBeta = 0;
        drive(car, world, 40, { steer: 127, throttle: 77, buttons: BTN_HANDBRAKE }, () => {
            minBeta = Math.min(minBeta, slipAngle(car.state));
        });
        expect(minBeta).toBeLessThan(-5 * DEG);
    });

    it('ω × r and r × J match the hand calculation', () => {
        // Same set-up: the front circles (0, 0.7) and (-1.65, 0.7) overlap by
        // 0.75 m, n = +x, contact point (-0.925, 0.7).
        const world = createFlatWorld();
        const car = spawnCar(world, 'a', 'bulli', 0, 0, 0);
        const pusher = spawnCar(world, 'b', 'beetle', -2.3, 0.7, Math.PI / 2, 5);
        resolveContact(car, pusher);
        const rA = { x: -0.925, z: 0.7 };
        const Ia = 1500 * 1.35 * 1.35;
        // r × n = r_z·n_x - r_x·n_z; the beetle's lever is parallel to n
        const rAn = rA.z * 1 - rA.x * 0;
        const K = 1 / 1500 + 1 / 900 + rAn * rAn / Ia;
        const jn = (5 + 0.25 * 5) / K;
        expect(car.state.vx).toBeCloseTo(jn / 1500, 12);
        expect(car.state.vz).toBe(0);
        // Δω = (r × J)/I with J = (jn, 0)
        expect(car.state.yawRate).toBeCloseTo((rA.z * jn - rA.x * 0) / Ia, 12);
        expect(pusher.state.yawRate).toBeCloseTo(0, 12);
        expect(pusher.state.vx).toBeCloseTo(5 - jn / 900, 12);
    });

    it('integrates one tick of DT = 1/60 s in three substeps', () => {
        const world = createFlatWorld();
        const car = spawnCar(world, 'a', 'bulli', 0, 0, 0, 30);
        drive(car, world, 1, { throttle: 255 });
        expect(DT).toBe(1 / 60);
        expect(car.state.z).toBeCloseTo(30 * DT, 2);
    });
});

describe('tireCurve', () => {
    const peak = 6 * DEG;

    it('is linear up to the peak, falls to the slide grip at 2·peak and stays there', () => {
        expect(tireCurve(0, peak, 0.8)).toBe(0);
        expect(tireCurve(peak / 2, peak, 0.8)).toBeCloseTo(0.5, 12);
        expect(tireCurve(peak, peak, 0.8)).toBeCloseTo(1, 12);
        expect(tireCurve(1.5 * peak, peak, 0.8)).toBeCloseTo(0.9, 12);
        expect(tireCurve(2 * peak, peak, 0.8)).toBeCloseTo(0.8, 12);
        expect(tireCurve(80 * DEG, peak, 0.8)).toBeCloseTo(0.8, 12);
    });

    it('is odd and never changes sign', () => {
        for (let alpha = -1.5; alpha <= 1.5; alpha += 0.01) {
            const f = tireCurve(alpha, peak, 0.75);
            expect(tireCurve(-alpha, peak, 0.75)).toBeCloseTo(-f, 12);
            if (alpha > 1e-9) expect(f).toBeGreaterThan(0);
        }
    });
});
