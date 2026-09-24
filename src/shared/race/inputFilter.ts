// Countdown freeze and start ghost (docs/phase-2-design.md, 11 and 12.1).
// Server and client prediction apply exactly these rules, or the prediction
// would drive off in the countdown and be pulled back.

import { BTN_HANDBRAKE, BTN_JUMP } from '../sim/constants.js';
import { applyContactGhostFloor } from '../sim/inputs.js';
import type { SimCar, VehicleInput } from '../sim/types.js';
import { START_GHOST_TICKS } from './rules.js';
import type { RacePhase } from './types.js';

/** True while the cars stand frozen on the grid: lobby, countdown, or any tick before startTick. */
export function raceFrozen(phase: RacePhase, tick: number, startTick: number | null): boolean {
    return phase === 'lobby' || phase === 'countdown' || startTick === null || tick < startTick;
}

/**
 * Frozen: no throttle and no brake (a brake held at a standstill would
 * start reversing after 8 ticks), of the buttons only the handbrake (looks
 * only; no boost, reset or jump). No steering either, unlike the spec's
 * 12.1: the sim's tyres push a standing car with the wheels turned, it
 * creeps about 1.5 m in a 4 s countdown (docs/phase-2-design.md, 25).
 * Racing: everything but the jump (E4).
 */
export function raceInputFilter(phase: RacePhase, tick: number, startTick: number | null, input: VehicleInput): VehicleInput {
    if (raceFrozen(phase, tick, startTick)) {
        input.steer = 0;
        input.throttle = 0;
        input.brake = 0;
        input.buttons &= BTN_HANDBRAKE;
    } else {
        input.buttons &= ~BTN_JUMP;
    }
    return input;
}

/** True in the start ghost: from startTick for START_GHOST_TICKS ticks. */
export function inStartGhost(tick: number, startTick: number | null): boolean {
    return startTick !== null && tick >= startTick && tick < startTick + START_GHOST_TICKS;
}

/**
 * Applies the contact ghost floor of the start phase to a racer's car (own
 * car and the cars in the contact set in the prediction). Returns whether
 * it applied.
 */
export function raceGhostFloor(phase: RacePhase, tick: number, startTick: number | null, car: SimCar): boolean {
    if ((phase !== 'racing' && phase !== 'finished') || !inStartGhost(tick, startTick)) return false;
    applyContactGhostFloor(car);
    return true;
}
