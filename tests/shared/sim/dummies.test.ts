import { describe, expect, it } from 'vitest';
import { driveDummy } from '../../../src/shared/sim/dummies.js';
import { createFlatWorld, spawnCar } from '../../../src/shared/sim/scenarios.js';
import type { DummySpec } from '../../../src/shared/world/sandbox.js';

// The scripted drivers of the sandbox dummies (docs/phase-1a-design.md,
// 8.5): pure pursuit 14 m ahead on the circle, full lock at 0.4 rad of
// heading error, 0.25 of throttle per m/s below the target speed, braking
// from 3 m/s above it with the same gain.

const circle: DummySpec = {
    id: 'd', classId: 'bulli', x: 0, z: 0, yaw: 0,
    behaviour: { kind: 'circle', cx: 100, cz: 200, radius: 40, speed: 14 }
};

function dummyAt(x: number, z: number, yaw: number, speed: number) {
    const car = spawnCar(createFlatWorld(), 'd', 'bulli', x, z, yaw, speed);
    car.input.steer = 99;
    car.input.buttons = 15;
    return car;
}

describe('driveDummy', () => {
    it('leaves a parked dummy without any input', () => {
        const car = dummyAt(0, 0, 0, 5);
        car.input.throttle = 200;
        driveDummy(car, { ...circle, behaviour: { kind: 'parked' } });
        expect(car.input).toEqual({ steer: 0, throttle: 0, brake: 0, buttons: 0 });
    });

    it('steers towards the point 14 m ahead on its circle', () => {
        // On the circle at angle 0, heading +z (its tangent): the target
        // lies 14/40 = 0.35 rad further on; the chord to it turns away from
        // the tangent by half that, 0.175 rad, to the right:
        // -0.175 / 0.4 · 127 = -55.56 -> -56
        const car = dummyAt(140, 200, 0, 14);
        driveDummy(car, circle);
        expect(car.input.steer).toBe(-56);
        expect(car.input.buttons).toBe(0);
        // Heading the other way round the circle: full lock
        const back = dummyAt(140, 200, Math.PI, 14);
        driveDummy(back, circle);
        expect(Math.abs(back.input.steer)).toBe(127);
    });

    it('holds its speed: throttle below it, brake from 3 m/s above it', () => {
        const pedals = (speed: number) => {
            const car = dummyAt(140, 200, 0, speed);
            driveDummy(car, circle);
            return [car.input.throttle, car.input.brake];
        };
        expect(pedals(10)).toEqual([255, 0]);    // 4 m/s short: 4 · 0.25 = full
        expect(pedals(12)).toEqual([128, 0]);    // 2 m/s short: half
        expect(pedals(16.5)).toEqual([0, 0]);    // 2.5 m/s over: coast
        expect(pedals(18)).toEqual([0, 64]);     // 4 m/s over: (4 - 3) · 0.25
        expect(pedals(40)).toEqual([0, 255]);
    });
});
