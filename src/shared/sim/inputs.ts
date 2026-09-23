// Inputs the sim gets when the player gives none (docs/phase-1b-design.md,
// 5.3 and 5.4). The same on server and client, so the prediction of a
// frozen or silent car matches the server.

import type { SimCar, VehicleInput, VehicleState } from './types.js';

const STOP_SPEED = 0.5;

/**
 * Neutral steering and buttons plus the pedal that stops the car: brake
 * while rolling forwards, throttle while rolling backwards (it brakes a
 * reversing car, phase-1a-design.md 19.2). At a standstill both are 0, so
 * the car never starts reversing on its own.
 */
export function stopInput(s: VehicleState, out: VehicleInput): VehicleInput {
    const u = s.vx * Math.sin(s.yaw) + s.vz * Math.cos(s.yaw);
    out.steer = 0;
    out.buttons = 0;
    out.throttle = u < -STOP_SPEED ? 255 : 0;
    out.brake = u > STOP_SPEED ? 255 : 0;
    return out;
}

/**
 * Idle and lag ghost (5.4): the car takes no part in car contacts this
 * tick. Called right before stepWorld; finishTick counts ghostTicks down
 * again, so the floor has to be applied every tick it should hold.
 */
export function applyContactGhostFloor(car: SimCar): void {
    if (car.state.ghostTicks < 2) car.state.ghostTicks = 2;
}

export function copyInput(dst: VehicleInput, src: VehicleInput): VehicleInput {
    dst.steer = src.steer;
    dst.throttle = src.throttle;
    dst.brake = src.brake;
    dst.buttons = src.buttons;
    return dst;
}

// Quantised input ranges; the protocol clamps to these
export function clampInput(input: VehicleInput): VehicleInput {
    const clampInt = (value: number, min: number, max: number) =>
        Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : 0;
    input.steer = clampInt(input.steer, -127, 127);
    input.throttle = clampInt(input.throttle, 0, 255);
    input.brake = clampInt(input.brake, 0, 255);
    input.buttons = clampInt(input.buttons, 0, 255) & 0x0f;
    return input;
}
