import { DT } from '../../shared/sim/constants.js';

// Longest frame the loop catches up on; anything beyond is a hitch
const MAX_FRAME = 0.25;
// Ticks per frame at most, so a slow device cannot spiral into ever
// longer frames
export const MAX_TICKS_PER_FRAME = 8;

/**
 * Fixed-step accumulator (docs/phase-1a-design.md, 12.1): runs the sim in
 * ticks of exactly DT, however long the frames are, and returns how far the
 * next tick has progressed (alpha, 0..1) for the render interpolation.
 * No DOM, testable in Node.
 */
export class FixedStepLoop {
    acc = 0;

    // tick gets lag: how far (s) the moment the tick simulates lies before
    // the end of the frame. Inputs with a clock of their own (the remote
    // proxies) use it, so each tick sees its own time at any frame rate.
    advance(frameDt: number, tick: (lag: number) => void): number {
        this.acc += Math.min(Math.max(frameDt, 0), MAX_FRAME);
        // Count the ticks first (same arithmetic as ticking one by one)
        let rest = this.acc, n = 0;
        while (rest >= DT && n < MAX_TICKS_PER_FRAME) {
            rest -= DT;
            n++;
        }
        for (let i = 0; i < n; i++) tick((n - 1 - i) * DT + rest);
        this.acc = rest;
        // Drop the rest after a hitch instead of catching up over many frames
        if (n === MAX_TICKS_PER_FRAME && this.acc >= DT) this.acc = 0;
        return this.acc / DT;
    }

    reset(): void {
        this.acc = 0;
    }
}
