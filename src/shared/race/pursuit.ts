// The shared core of the bots' driving (docs/phase-2-design.md, 3 and 14):
// pure pursuit towards a point ahead, the steer input that asks the sim
// for a wheel angle, and the stuck logic (back off, then hold reset). The
// road bots of the load tests (tools/bots/driver.ts) and the race bots
// (lineDriver.ts) use the same code. Pure: no clock, no randomness.

import { BTN_RESET } from '../sim/constants.js';
import type { VehicleInput, VehicleParams, VehicleState } from '../sim/types.js';

const TWO_PI = Math.PI * 2;

// Stuck: throttle on but slower than this for STUCK_TICKS
export const STUCK_SPEED = 1.2;
export const STUCK_TICKS = 90;
// Backing off: reverse (brake held at a standstill) with the wheel turned
export const BACKOFF_TICKS = 70;
// After this many back-offs without getting going, the reset button
export const BACKOFFS_BEFORE_RESET = 2;
// Getting going: faster than 4 m/s for this long. A car that bounces off
// the wall it is wedged against touches 4 m/s for a moment and would
// otherwise back off for ever without the reset.
export const GOING_TICKS = 60;
// Held a little longer than the sim's RESET_HOLD_TICKS (30)
export const RESET_TICKS = 34;

export function wrapAngle(angle: number): number {
    return angle - TWO_PI * Math.floor((angle + Math.PI) / TWO_PI);
}

/** Forward speed of a car (m/s, negative when rolling backwards). */
export function forwardSpeed(s: VehicleState): number {
    return s.vx * Math.sin(s.yaw) + s.vz * Math.cos(s.yaw);
}

/**
 * The steer input (-127..127) that asks the sim for wheel angle delta at
 * forward speed u: the sim shrinks the lock with speed (vehicle.ts, 2a).
 */
export function steerForAngle(delta: number, u: number, p: VehicleParams): number {
    const axis = delta * (1 + Math.abs(u) / p.steerFalloff) / p.steerLock;
    return Math.round(Math.max(-1, Math.min(1, axis)) * 127);
}

/**
 * Pure pursuit: the steer input for the arc from the car through the
 * target point (tx, tz), with the look-ahead distance ld (at least 4 m).
 */
export function pursuitSteer(s: VehicleState, p: VehicleParams, u: number, tx: number, tz: number, ld: number): number {
    const heading = Math.atan2(tx - s.x, tz - s.z);
    const alpha = wrapAngle(heading - s.yaw);
    const reach = Math.max(4, ld);
    const delta = Math.atan2(2 * p.wheelbase * Math.sin(alpha), reach);
    return steerForAngle(delta, u, p);
}

/**
 * Stuck against something: after STUCK_TICKS of throttle without speed the
 * car backs off (reverse with the wheel the other way), and after
 * BACKOFFS_BEFORE_RESET back-offs (or when flipped) it holds the reset
 * button. Call override() first in a tick: while it returns something other
 * than 'drive' it has written the input. Call watch() after the normal
 * driving wrote its input.
 */
export class StuckWatch {
    private stuckTicks = 0;
    private backoffTicks = 0;
    private backoffs = 0;
    private resetTicks = 0;
    private backoffSteer = 0;
    private goingTicks = 0;
    // For tests and reports
    resets = 0;
    backoffCount = 0;

    restart(): void {
        this.stuckTicks = this.backoffTicks = this.backoffs = this.resetTicks = this.goingTicks = 0;
    }

    /** Holds the reset button from the next tick on (unless it already does). */
    forceReset(): void {
        if (this.resetTicks > 0) return;
        this.backoffTicks = 0;
        this.stuckTicks = 0;
        this.backoffs = 0;
        this.resets++;
        this.resetTicks = RESET_TICKS;
    }

    get resetting(): boolean {
        return this.resetTicks > 0;
    }

    /**
     * 'reset' / 'backoff': the input is written, the tick is done;
     * 'resetDone' / 'backoffDone': the same, and this was the last tick of it;
     * 'drive': drive normally.
     */
    override(out: VehicleInput): 'drive' | 'reset' | 'resetDone' | 'backoff' | 'backoffDone' {
        if (this.resetTicks > 0) {
            this.resetTicks--;
            out.steer = 0;
            out.throttle = 0;
            out.brake = 0;
            out.buttons = BTN_RESET;
            if (this.resetTicks === 0) {
                this.restart();
                return 'resetDone';
            }
            return 'reset';
        }
        if (this.backoffTicks > 0) {
            this.backoffTicks--;
            out.steer = this.backoffSteer;
            out.throttle = 0;
            out.brake = 255;
            if (this.backoffTicks === 0) {
                this.stuckTicks = 0;
                return 'backoffDone';
            }
            return 'backoff';
        }
        return 'drive';
    }

    /**
     * After the driving wrote its input. wantsToMove: the driver means the
     * car to go (default: a throttle above 100). A race bot always does
     * while it races, also where it asks for no speed: behind a car that
     * stands still (a crash) it would wait for it for ever, and two bots
     * wedged side by side each wait for the other.
     */
    watch(s: VehicleState, u: number, out: VehicleInput, wantsToMove = out.throttle > 100): void {
        if (Math.abs(u) > 4) this.goingTicks++;
        else this.goingTicks = 0;
        if (wantsToMove && Math.abs(u) < STUCK_SPEED) this.stuckTicks++;
        else if (Math.abs(u) > 4) {
            this.stuckTicks = 0;
            if (this.goingTicks >= GOING_TICKS) this.backoffs = 0;
        }
        if (this.stuckTicks < STUCK_TICKS) return;
        this.stuckTicks = 0;
        if (this.backoffs >= BACKOFFS_BEFORE_RESET || s.flipAngle !== 0) {
            this.backoffs = 0;
            this.resets++;
            this.resetTicks = RESET_TICKS;
            return;
        }
        this.backoffs++;
        this.backoffCount++;
        this.backoffTicks = BACKOFF_TICKS;
        this.backoffSteer = out.steer >= 0 ? -127 : 127;
    }
}
