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

    advance(frameDt: number, tick: () => void): number {
        this.acc += Math.min(Math.max(frameDt, 0), MAX_FRAME);
        let n = 0;
        while (this.acc >= DT && n < MAX_TICKS_PER_FRAME) {
            tick();
            this.acc -= DT;
            n++;
        }
        // Drop the rest after a hitch instead of catching up over many frames
        if (n === MAX_TICKS_PER_FRAME && this.acc >= DT) this.acc = 0;
        return this.acc / DT;
    }

    reset(): void {
        this.acc = 0;
    }
}
