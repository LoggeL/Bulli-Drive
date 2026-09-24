// Lead control (docs/phase-1b-design.md, 8.3): the client ticks ahead of
// the server by about half a round trip plus the input buffer. The server
// reports how early this client's inputs arrived (inputSlack) and how early
// they should (bufferTarget); the client moves its lead by at most 5 % of
// the elapsed time until both match, and jumps when they are far apart.
//
// The lead is a number of ticks on top of the estimated server tick, so
// the client's tick C follows the server clock itself: frames that come
// late or a device that falls behind cannot make C drift.
//
// Asymmetric: inputs that came too late raise the lead at once (by as much
// as they were late), inputs that come too early lower it only at the ±5 %
// pace. A client whose page stalls now and then keeps the margin it needed
// instead of swinging back after every stall (20.2). The margin such raises
// added counts as expected earliness, not as a clock jump (20.5).

import { SNAPSHOT_EVERY, TICK_MS } from './constants.js';

const AVERAGE_OF = 4;
const GAIN = 0.1;
// At most 5 % of the ticks between two snapshots per snapshot
const MAX_STEP = 0.05 * SNAPSHOT_EVERY;
export const RESYNC_TICKS = 8;
// Too early by more than this (beyond the margin late inputs added): the
// clock jumped, the lead follows at once
export const EARLY_JUMP_TICKS = 16;
// Late inputs raise the lead by as much as they were late, every time: a
// page that sends its inputs in bursts, or a clock offset that was off at
// the start, must never leave them late (20.5). The margin such raises
// added widens the range of early reports that count as the lead slowly
// coming down rather than as a clock jump, up to this much: with the
// buffer and EARLY_JUMP_TICKS the inputs then stay below INPUT_MAX_AHEAD
export const MAX_LATE_MARGIN_TICKS = 40;
// Without any input arriving for this long the lead restarts
const SILENT_RESYNC_MS = 1000;
// Time after a jump before the reports show its effect: a round trip plus
// the snapshot interval and the buffer
const JUMP_SETTLE_MS = 250;
// Stalls of the client up to this long are left to the lead: a page that
// hangs this long again and again (a weak device drawing a few frames a
// second) needs the lead to cover them, or its inputs stay late and the
// car an idle ghost for good. Longer ones (loading next to another page)
// are not covered; their late reports are ignored (20.5, 20.7)
export const COVERED_STALL_MS = 600;

export class LeadControl {
    // Ticks ahead of the estimated server tick
    lead = 0;
    // Tick-time factor the last step amounts to (> 1: ticking faster), for the debug overlay
    rate = 1;
    private readonly errors: number[] = [];
    private silentSince = -1;
    // After a jump the reports still describe inputs sent before it: they
    // are ignored until then (the dead time of the loop)
    private ignoreUntil = -1;
    resyncs = 0;
    lastError = 0;
    // Lead that late inputs added and the slow steps have not taken back yet
    margin = 0;

    /** The start: the way there (half a round trip) plus the buffer. */
    start(rttMs: number, bufferTarget: number): void {
        this.lead = (rttMs / 2) / TICK_MS + bufferTarget;
        this.margin = 0;
        this.rate = 1;
        this.errors.length = 0;
        this.silentSince = -1;
        this.ignoreUntil = -1;
    }

    /**
     * The client itself stalled for stallMs (no pump, no message): its
     * inputs arrive late for a while now, which no lead would have covered
     * (a page that does not run does not send, and with ?netsim it does not
     * even deliver what it sent before). Those reports do not move the lead.
     */
    holdAfterStall(now: number, rttMs: number, stallMs: number): void {
        if (stallMs <= COVERED_STALL_MS) return;
        this.ignoreUntil = Math.max(this.ignoreUntil, now + 2 * rttMs + JUMP_SETTLE_MS + stallMs);
    }

    /** The first client tick for the estimated server tick now. */
    static startTick(serverTickNow: number, rttMs: number, bufferTarget: number): number {
        return Math.ceil(serverTickNow + (rttMs / 2) / TICK_MS + bufferTarget);
    }

    /**
     * One snapshot's report. Returns true when the lead jumped (resync)
     * instead of moving smoothly.
     */
    onSnapshot(inputSlack: number | null, bufferTarget: number, now: number, rttMs: number): boolean {
        if (now < this.ignoreUntil) return false;
        if (inputSlack === null) {
            if (this.silentSince < 0) this.silentSince = now;
            if (now - this.silentSince > SILENT_RESYNC_MS) {
                this.start(rttMs, bufferTarget);
                this.resyncs++;
                this.ignoreUntil = now + rttMs + JUMP_SETTLE_MS;
                return true;
            }
            return false;
        }
        this.silentSince = -1;
        const error = inputSlack - bufferTarget;
        if (error < -1 || error > EARLY_JUMP_TICKS + this.margin) {
            // Late (a stall, loss, a burst) or far too early (a clock jump):
            // move the lead in one go
            this.lead -= error;
            this.margin = error < 0 ? Math.min(MAX_LATE_MARGIN_TICKS, this.margin - error) : 0;
            this.errors.length = 0;
            this.rate = 1;
            if (Math.abs(error) > RESYNC_TICKS) this.resyncs++;
            this.lastError = error;
            this.ignoreUntil = now + rttMs + JUMP_SETTLE_MS + Math.max(0, error) * TICK_MS;
            return Math.abs(error) > RESYNC_TICKS;
        }
        this.errors.push(error);
        if (this.errors.length > AVERAGE_OF) this.errors.shift();
        let mean = 0;
        for (const e of this.errors) mean += e;
        mean /= this.errors.length;
        this.lastError = mean;
        // Too early (error > 0): less lead, the client ticks slower
        const step = Math.max(-MAX_STEP, Math.min(MAX_STEP, -GAIN * mean));
        this.lead += step;
        if (step < 0) this.margin = Math.max(0, this.margin + step);
        this.rate = 1 + step / SNAPSHOT_EVERY;
        return false;
    }
}
