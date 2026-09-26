import { afterEach } from 'vitest';
import type { SimCar, VehicleInput } from '../../../src/shared/sim/types.js';
import { stepVehicle } from '../../../src/shared/sim/world.js';
import { createSimWorld, type ColliderInput, type SimWorld } from '../../../src/shared/world/colliders.js';
import { FLAT_TERRAIN } from '../../../src/shared/sim/scenarios.js';
import { resetTuning } from '../../../src/shared/sim/tuning.js';

export { forwardSpeed, slipAngle, spawnCar } from '../../../src/shared/sim/scenarios.js';

export const DEG = Math.PI / 180;

// Flat world large enough for 30 s at top speed without reaching the border
export function createLongWorld(colliders: ColliderInput[] = []): SimWorld {
    return createSimWorld({ ...FLAT_TERRAIN, size: 8000 }, colliders, []);
}

export function speedOf(car: SimCar): number {
    return Math.hypot(car.state.vx, car.state.vz);
}

// Steps one car for ticks with a fixed input or an input per tick
export function drive(
    car: SimCar,
    world: SimWorld,
    ticks: number,
    input: Partial<VehicleInput> | ((tick: number) => Partial<VehicleInput>),
    afterTick?: (tick: number) => void
): void {
    for (let tick = 0; tick < ticks; tick++) {
        const next = typeof input === 'function' ? input(tick) : input;
        car.input.steer = next.steer ?? 0;
        car.input.throttle = next.throttle ?? 0;
        car.input.brake = next.brake ?? 0;
        car.input.buttons = next.buttons ?? 0;
        stepVehicle(car, world);
        afterTick?.(tick);
    }
}

// Throws a car up with vertical speed vy (m/s), e.g. to get it over a low
// collider; the sim has no jump of its own (docs/phase-1a-design.md, 26).
// Apex vy²/(2·GRAVITY) above the take-off point.
export function launch(car: SimCar, vy: number): void {
    car.state.vy = Math.max(car.state.vy, 0) + vy;
    car.state.grounded = false;
    car.state.airTicks = 0;
}

// Tests that tweak the tuning (global, classes or assist profiles) call
// this so later tests see the defaults
export function restoreTuningAfterEach(): void {
    afterEach(() => {
        resetTuning();
    });
}
