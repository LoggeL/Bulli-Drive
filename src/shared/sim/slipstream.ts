// Slipstream (docs/phase-2-design.md, section 13). Only in a world with
// slipstream on (the race world). Per tick, before the forces, every car A
// gets a target strength from the cars ahead of it: a car B counts when
// both drive at DRAFT_MIN_SPEED or more, neither is a ghost, B's heading is
// within DRAFT_HEADING of A's and B lies in the cone ahead of A,
// DRAFT_MIN <= along <= DRAFT_RANGE and lat <= 1.2 + 0.05 · along.
// VehicleState.draft follows the strongest target, rate limited; it is
// part of the state, so a reconciliation starts from the server's value.

import {
    DRAFT_FALL, DRAFT_HALF_WIDTH, DRAFT_HALF_WIDTH_GROWTH, DRAFT_HEADING, DRAFT_MIN, DRAFT_MIN_SPEED, DRAFT_RANGE,
    DRAFT_RISE
} from '../race/rules.js';
import { DT } from './constants.js';
import type { SimCar } from './types.js';

function isGhost(car: SimCar): boolean {
    return car.mods.ghost || car.state.ghostTicks > 0;
}

function forward(car: SimCar): number {
    const s = car.state;
    return s.vx * Math.sin(s.yaw) + s.vz * Math.cos(s.yaw);
}

/** Strength (0..1) of the slipstream car b gives car a, from their current states. */
export function draftStrength(a: SimCar, b: SimCar): number {
    if (isGhost(a) || isGhost(b)) return 0;
    if (!(forward(a) >= DRAFT_MIN_SPEED) || !(forward(b) >= DRAFT_MIN_SPEED)) return 0;
    const sa = a.state, sb = b.state;
    let dyaw = (sb.yaw - sa.yaw) % (2 * Math.PI);
    if (dyaw > Math.PI) dyaw -= 2 * Math.PI;
    else if (dyaw < -Math.PI) dyaw += 2 * Math.PI;
    if (!(Math.abs(dyaw) <= DRAFT_HEADING)) return 0;
    const fx = Math.sin(sa.yaw), fz = Math.cos(sa.yaw);
    const dx = sb.x - sa.x, dz = sb.z - sa.z;
    const along = dx * fx + dz * fz;
    if (!(along >= DRAFT_MIN && along <= DRAFT_RANGE)) return 0;
    // Left axis (cos yaw, -sin yaw) = (fz, -fx)
    const lat = Math.abs(dx * fz - dz * fx);
    const halfWidth = DRAFT_HALF_WIDTH + DRAFT_HALF_WIDTH_GROWTH * along;
    if (!(lat <= halfWidth)) return 0;
    return (1 - along / DRAFT_RANGE) * (1 - lat / halfWidth);
}

let targets = new Float64Array(8);

/**
 * Moves every non-kinematic car's draft towards its strongest target,
 * by at most DRAFT_RISE·DT up and DRAFT_FALL·DT down. All targets come from
 * the states at the start of the tick, before any car's draft changes.
 */
export function updateDrafts(cars: readonly SimCar[]): void {
    const count = cars.length;
    if (targets.length < count) targets = new Float64Array(count * 2);
    for (let i = 0; i < count; i++) {
        // A car gives itself nothing (along 0 < DRAFT_MIN)
        let best = 0;
        for (let j = 0; j < count; j++) {
            const strength = draftStrength(cars[i], cars[j]);
            if (strength > best) best = strength;
        }
        targets[i] = best;
    }
    for (let i = 0; i < count; i++) {
        const s = cars[i].state;
        if (cars[i].kinematic) continue;
        const change = targets[i] - s.draft;
        s.draft += change > DRAFT_RISE * DT ? DRAFT_RISE * DT : change < -DRAFT_FALL * DT ? -DRAFT_FALL * DT : change;
    }
}
