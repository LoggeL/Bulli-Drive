// One fixed tick for all cars of a session (docs/phase-1a-design.md, 6.3):
// forces per car, then SUBSTEPS rounds of movement, world collision,
// car-car contact and the vertical motion over the ground (section 26),
// then drift and boost per car. The order depends
// only on the car ids, never on the order the cars arrived in.

import type { SimWorld } from '../world/colliders.js';
import { overlapsColliders, resolveWorld } from './collision.js';
import { DT, GHOST_EXIT_TICKS, SUBSTEPS } from './constants.js';
import { resolveContact } from './contact.js';
import { applyModifiers } from './modifiers.js';
import { updateDrafts } from './slipstream.js';
import { resetStepEvents, type SimCar, type VehicleState } from './types.js';
import { finishTick, integrateForces, resetVehicle, stepVertical } from './vehicle.js';

const CONTACT_ITERATIONS = 2;
const SUB_DT = DT / SUBSTEPS;

// Insertion sort by id with < (not localeCompare, which depends on the
// locale). In place and allocation-free; already sorted lists cost O(n).
export function sortCarsById(cars: SimCar[]): void {
    for (let i = 1; i < cars.length; i++) {
        const car = cars[i];
        let j = i - 1;
        while (j >= 0 && cars[j].id > car.id) {
            cars[j + 1] = cars[j];
            j--;
        }
        cars[j + 1] = car;
    }
}

// Advances every car by one tick of DT. Sorts cars by id in place first.
// Kinematic cars (1a remote proxies) only move along their velocity and
// take part in contacts; everything else about them is set from outside.
export function stepWorld(cars: SimCar[], world: SimWorld): void {
    sortCarsById(cars);
    const count = cars.length;
    // Slipstream targets from the positions at the start of the tick
    if (world.slipstream) updateDrafts(cars);

    for (let i = 0; i < count; i++) {
        const car = cars[i];
        resetStepEvents(car.events);
        car.contactDv = 0;
        car.contactDw = 0;
        applyModifiers(car.base, car.mods, car.state.scale, car.params, car.state.draft);
        if (car.kinematic) continue;
        // A Party ghost that ends inside a collider keeps the world
        // collision off until the car is free again (section 7.3, step 5)
        const s = car.state;
        if (!car.mods.ghost && s.wasGhost && overlapsColliders(s, car.params, world)) {
            s.ghostExit = GHOST_EXIT_TICKS;
        }
        integrateForces(car, world);
    }

    for (let k = 0; k < SUBSTEPS; k++) {
        for (let i = 0; i < count; i++) {
            const s = cars[i].state;
            s.x += s.vx * SUB_DT;
            s.z += s.vz * SUB_DT;
            s.yaw += s.yawRate * SUB_DT;
        }
        for (let i = 0; i < count; i++) {
            if (!cars[i].kinematic) resolveWorld(cars[i], world);
        }
        for (let iteration = 0; iteration < CONTACT_ITERATIONS; iteration++) {
            for (let i = 0; i < count; i++) {
                for (let j = i + 1; j < count; j++) resolveContact(cars[i], cars[j]);
            }
        }
        for (let i = 0; i < count; i++) {
            if (!cars[i].kinematic) stepVertical(cars[i], world, SUB_DT);
        }
    }

    for (let i = 0; i < count; i++) {
        const car = cars[i];
        if (car.kinematic) continue;
        finishTick(car);
        if (!stateIsFinite(car.state)) recoverCar(car, world);
    }
}

function stateIsFinite(s: VehicleState): boolean {
    return Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.z) && Number.isFinite(s.yaw)
        && Number.isFinite(s.vx) && Number.isFinite(s.vy) && Number.isFinite(s.vz) && Number.isFinite(s.yawRate)
        && Number.isFinite(s.steerAngle) && Number.isFinite(s.loadX) && Number.isFinite(s.rearGrip)
        && Number.isFinite(s.betaPrev) && Number.isFinite(s.boostMeter) && Number.isFinite(s.susp)
        && Number.isFinite(s.scale) && Number.isFinite(s.draft);
}

// A car whose state went NaN or infinite (a degenerate case or a broken
// input) is reset where it was, or at the origin if its position is gone,
// instead of carrying the NaN into every later tick and contact
function recoverCar(car: SimCar, world: SimWorld): void {
    const s = car.state;
    if (!Number.isFinite(s.x) || !Number.isFinite(s.z)) s.x = s.z = 0;
    if (!Number.isFinite(s.yaw)) s.yaw = 0;
    if (!Number.isFinite(s.boostMeter)) s.boostMeter = 0;
    if (!Number.isFinite(s.scale)) s.scale = 1;
    resetVehicle(s, car.params, world);
    car.events.reset = true;
}

// A single car without partners, e.g. for tests and the sandbox
const single: SimCar[] = [];
export function stepVehicle(car: SimCar, world: SimWorld): void {
    single[0] = car;
    stepWorld(single, world);
}
