// Launch boost (docs/phase-2-design.md, 12.2). During the countdown the raw
// throttle of every racer is kept (before the freeze filter). At S =
// startTick: no throttle at S is a normal start; otherwise the last rising
// edge (< 128 -> >= 128) of the throttle held through S decides: within
// [S - LAUNCH_WINDOW_TICKS, S] a perfect start (acceleration × 1.6 for
// LAUNCH_TICKS), earlier a bogged one (× 0.5 for BOGGED_TICKS).

import type { VehicleModifiers } from '../sim/types.js';
import { BOGGED_TICKS, LAUNCH_HISTORY_TICKS, LAUNCH_THROTTLE, LAUNCH_TICKS, LAUNCH_WINDOW_TICKS } from './rules.js';

export type LaunchResult = 'perfect' | 'early' | 'normal';

/** Ring buffer of the raw throttle of the last LAUNCH_HISTORY_TICKS ticks. */
export class LaunchRecorder {
    private readonly throttle = new Int16Array(LAUNCH_HISTORY_TICKS);
    private readonly ticks = new Float64Array(LAUNCH_HISTORY_TICKS).fill(-Infinity);

    record(tick: number, throttle: number): void {
        const at = ((tick % LAUNCH_HISTORY_TICKS) + LAUNCH_HISTORY_TICKS) % LAUNCH_HISTORY_TICKS;
        this.ticks[at] = tick;
        // Int16Array stores NaN and ±Infinity as 0 (no throttle)
        this.throttle[at] = throttle;
    }

    // Raw throttle at tick; ticks never recorded (or overwritten) count as 0
    throttleAt(tick: number): number {
        const at = ((tick % LAUNCH_HISTORY_TICKS) + LAUNCH_HISTORY_TICKS) % LAUNCH_HISTORY_TICKS;
        return this.ticks[at] === tick ? this.throttle[at] : 0;
    }

    clear(): void {
        this.ticks.fill(-Infinity);
    }

    result(startTick: number): LaunchResult {
        return launchResult(tick => this.throttleAt(tick), startTick);
    }
}

/** The launch for the raw throttle per tick (see the header). */
export function launchResult(throttleAt: (tick: number) => number, startTick: number): LaunchResult {
    if (throttleAt(startTick) < LAUNCH_THROTTLE) return 'normal';
    // Walk back to the tick of the rising edge of the held throttle
    let edge = startTick;
    while (edge > startTick - LAUNCH_HISTORY_TICKS && throttleAt(edge - 1) >= LAUNCH_THROTTLE) edge--;
    return edge >= startTick - LAUNCH_WINDOW_TICKS ? 'perfect' : 'early';
}

/** Sets mods.launch / mods.bogged for tick from the launch result. */
export function applyLaunchMods(result: LaunchResult, tick: number, startTick: number, mods: VehicleModifiers): VehicleModifiers {
    const since = tick - startTick;
    mods.launch = result === 'perfect' && since >= 0 && since < LAUNCH_TICKS;
    mods.bogged = result === 'early' && since >= 0 && since < BOGGED_TICKS;
    return mods;
}
