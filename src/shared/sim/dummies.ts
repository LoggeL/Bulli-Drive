// Dummy cars of the sandbox (docs/phase-1a-design.md, 8.5 and 12.7): full
// dynamic sim cars (kinematic = false) with a scripted driver, stepped in
// the same stepWorld as the player's car. A parked dummy gets no input at
// all and just rolls when it is hit; a lapping dummy follows its circle
// with a pure-pursuit steering and a speed controller. Both depend only on
// the car's state, so a run replays exactly.

import type { DummySpec } from '../world/sandbox.js';
import type { SimWorld } from '../world/colliders.js';
import { copyVehicleState, createVehicleState, type SimCar } from './types.js';
import { createSimCar, placeVehicle } from './vehicle.js';

// Pure pursuit: aim at the point this far ahead on the circle (m)
const LOOKAHEAD = 14;
// Full lock at this heading error (rad)
const STEER_FULL_AT = 0.4;
// Throttle per m/s below the target speed; brake from this much above it
const SPEED_GAIN = 0.25;
const BRAKE_ABOVE = 3;

const blankState = createVehicleState();

export function createDummy(spec: DummySpec, world: SimWorld): SimCar {
    const car = createSimCar(spec.id, spec.classId);
    placeVehicle(car.state, world, spec.x, spec.z, spec.yaw);
    return car;
}

// Back to the spawn at rest, with a fresh state (boost, drift, flip gone)
export function resetDummy(car: SimCar, spec: DummySpec, world: SimWorld): void {
    copyVehicleState(car.state, blankState);
    placeVehicle(car.state, world, spec.x, spec.z, spec.yaw);
}

function clamp(value: number, min: number, max: number): number {
    return value < min ? min : value > max ? max : value;
}

// Sets the dummy's input for the next tick
export function driveDummy(car: SimCar, spec: DummySpec): void {
    const input = car.input;
    input.steer = input.throttle = input.brake = input.buttons = 0;
    const behaviour = spec.behaviour;
    if (behaviour.kind === 'parked') return;

    const s = car.state;
    // Angle of the car on the circle, then the target a bit further on
    const phi = Math.atan2(s.z - behaviour.cz, s.x - behaviour.cx) + LOOKAHEAD / behaviour.radius;
    const dx = behaviour.cx + behaviour.radius * Math.cos(phi) - s.x;
    const dz = behaviour.cz + behaviour.radius * Math.sin(phi) - s.z;
    // Heading error, + = target to the left (left = (cos yaw, -sin yaw))
    const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
    const error = Math.atan2(dx * fz - dz * fx, dx * fx + dz * fz);
    input.steer = Math.round(clamp(error / STEER_FULL_AT, -1, 1) * 127) + 0;

    const u = s.vx * fx + s.vz * fz;
    const shortfall = behaviour.speed - u;
    input.throttle = Math.round(clamp(shortfall * SPEED_GAIN, 0, 1) * 255);
    if (-shortfall > BRAKE_ABOVE) input.brake = Math.round(clamp((-shortfall - BRAKE_ABOVE) * SPEED_GAIN, 0, 1) * 255);
}
