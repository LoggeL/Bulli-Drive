// Clock sync (docs/phase-1b-design.md, 3.7): estimates the server tick at
// a local time from ping/pong samples. The sample with the smallest round
// trip has the least queueing in it and sets the offset; changes of the
// offset are eased in. A sample that the offset cannot explain at all (the
// server skipped ticks after a hang) is taken at once. Times are in ms on the client's own clock
// (performance.now() in the browser), ticks are server ticks with fraction.

import { CLOCK_SAMPLES, TICK_MS } from './constants.js';

interface Sample {
    rtt: number;
    // Server tick at local time 0 according to this sample
    offset: number;
}

const OFFSET_BLEND = 0.1;
const TIE_MS = 1;
// On top of the uncertainty of two samples: this far off, the server's
// clock moved (ticks)
const JUMP_MARGIN_TICKS = 1;

export class ClockSync {
    private readonly samples: Sample[] = [];
    private offset = 0;
    private synced = false;
    // Number of pongs seen since the last reset
    count = 0;
    // Times the server's clock was found moved and taken at once
    jumps = 0;

    reset(): void {
        this.samples.length = 0;
        this.synced = false;
        this.count = 0;
    }

    get ready(): boolean {
        return this.synced;
    }

    /** A pong for a ping sent at sentAt, received at now: the room was at tick + sub then. */
    addSample(sentAt: number, now: number, tick: number, sub: number): void {
        const rtt = Math.max(0, now - sentAt);
        // The server answered about half a round trip ago
        const serverTicksAtNow = tick + sub + (rtt / 2) / TICK_MS;
        const sample = { rtt, offset: serverTicksAtNow - now / TICK_MS };
        // The server answered somewhere within the round trip, so a sample
        // is right within half its round trip, and the offset within half
        // the smallest one it came from. Further apart than both, the
        // server's clock moved: after a hang it skips ticks for good
        // (server/tick.ts). Easing that in would take 20 s, with every
        // remote car extrapolated meanwhile; the samples from before say
        // nothing any more.
        if (this.synced) {
            const tolerance = (rtt / 2 + this.rtt / 2) / TICK_MS + JUMP_MARGIN_TICKS;
            if (Math.abs(sample.offset - this.offset) > tolerance) {
                this.samples.length = 0;
                this.samples.push(sample);
                this.count++;
                this.offset = sample.offset;
                this.jumps++;
                return;
            }
        }
        this.samples.push(sample);
        if (this.samples.length > CLOCK_SAMPLES) this.samples.shift();
        this.count++;
        // The newest of the samples within 1 ms of the smallest round trip:
        // equal round trips say nothing about which is better, and the
        // server's clock may have moved since an old one (a hang)
        let minRtt = Infinity;
        for (const s of this.samples) minRtt = Math.min(minRtt, s.rtt);
        let best = this.samples[this.samples.length - 1];
        for (let i = this.samples.length - 1; i >= 0; i--) {
            if (this.samples[i].rtt <= minRtt + TIE_MS) { best = this.samples[i]; break; }
        }
        if (!this.synced) {
            this.offset = best.offset;
            this.synced = true;
        } else {
            this.offset += (best.offset - this.offset) * OFFSET_BLEND;
        }
    }

    /** The server tick (with fraction) at local time now. */
    serverTickAt(now: number): number {
        return this.offset + now / TICK_MS;
    }

    /** Smallest round trip of the kept samples (ms). */
    get rtt(): number {
        if (this.samples.length === 0) return 0;
        let best = Infinity;
        for (const s of this.samples) best = Math.min(best, s.rtt);
        return best;
    }

    /** Spread of the round trips, p90 - p10 (ms). */
    get jitter(): number {
        if (this.samples.length < 2) return 0;
        const sorted = this.samples.map(s => s.rtt).sort((a, b) => a - b);
        const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1)))];
        return at(0.9) - at(0.1);
    }
}
