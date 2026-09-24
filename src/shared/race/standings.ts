// Race positions (docs/phase-2-design.md, section 9). Sort key, ascending
// and stable: status (finished, racing, dnf, left), then finishers by
// finish time, everyone else by gates passed (more first) and the remaining
// distance to the next gate (less first), then the slot.

import type { RaceProgress } from './progress.js';
import type { RacerStatus } from './types.js';

export interface StandingEntry {
    slot: number;
    progress: RaceProgress;
}

const STATUS_RANK: Record<RacerStatus, number> = { finished: 0, racing: 1, dnf: 2, left: 3 };

export function compareStandings(a: StandingEntry, b: StandingEntry): number {
    const pa = a.progress, pb = b.progress;
    const rank = STATUS_RANK[pa.status] - STATUS_RANK[pb.status];
    if (rank !== 0) return rank;
    if (pa.status === 'finished') {
        const time = (pa.finishTicks ?? Infinity) - (pb.finishTicks ?? Infinity);
        if (time !== 0 && !Number.isNaN(time)) return time;
    } else if (pa.status !== 'left') {
        if (pa.passed !== pb.passed) return pb.passed - pa.passed;
        if (pa.remaining !== pb.remaining) return pa.remaining - pb.remaining;
    }
    return a.slot - b.slot;
}

/** The entries in race order (a sorted copy; ties by slot). */
export function computeStandings<T extends StandingEntry>(entries: readonly T[]): T[] {
    return [...entries].sort(compareStandings);
}

/**
 * Split against the car directly ahead (9): for crossing k (0-based) of
 * racer X at tX and of the racer ahead Y at tY, tX - tY in float ticks
 * (positive = behind). null when Y has not made crossing k.
 */
export function gapAhead(x: RaceProgress, ahead: RaceProgress, k: number): number | null {
    if (k < 0 || k >= x.gateTimes.length || k >= ahead.gateTimes.length) return null;
    return x.gateTimes[k] - ahead.gateTimes[k];
}
