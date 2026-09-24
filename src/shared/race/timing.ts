// Race times as shown to the player (docs/phase-2-design.md, section 8):
// times are float ticks; the HUD shows whole milliseconds,
// round(ticks · 1000 / 60), as m:ss.mmm.

import { SIM_HZ } from '../sim/constants.js';

export function ticksToMs(ticks: number): number {
    return Math.round(ticks * 1000 / SIM_HZ);
}

function msParts(ms: number): { minutes: number; seconds: number; millis: number } {
    return { minutes: Math.floor(ms / 60000), seconds: Math.floor(ms / 1000) % 60, millis: ms % 1000 };
}

/** "1:23.456" */
export function formatRaceTime(ticks: number): string {
    const { minutes, seconds, millis } = msParts(Math.max(0, ticksToMs(ticks)));
    return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/** A split against the car ahead or the ghost: "-0.312" (ahead), "+0.418" (behind). */
export function formatSplit(ticks: number): string {
    const ms = ticksToMs(Math.abs(ticks));
    const sign = ticks < 0 && ms > 0 ? '-' : '+';
    const { minutes, seconds, millis } = msParts(ms);
    const whole = minutes > 0 ? `${minutes}:${String(seconds).padStart(2, '0')}` : String(seconds);
    return `${sign}${whole}.${String(millis).padStart(3, '0')}`;
}
