import { afterEach } from 'vitest';
import { SIM_TUNING, SIM_TUNING_DEFAULTS } from '../../../src/shared/sim/constants.js';
import type { SimCar, VehicleInput } from '../../../src/shared/sim/types.js';
import { stepVehicle } from '../../../src/shared/sim/world.js';
import { createSimWorld, type ColliderInput, type SimWorld } from '../../../src/shared/world/colliders.js';
import { FLAT_TERRAIN } from '../../../src/shared/sim/scenarios.js';

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

// Tests that tweak SIM_TUNING call this so later tests see the defaults
export function restoreTuningAfterEach(): void {
    afterEach(() => {
        Object.assign(SIM_TUNING, SIM_TUNING_DEFAULTS);
    });
}
