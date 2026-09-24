// The one tick scheduler of the process (docs/phase-1b-design.md, 5.1): 60
// ticks a second for every room that has members, in a fixed order. The
// next tick time runs on absolutely, so the rate does not drift with the
// timer's inaccuracy; after a hang of more than 250 ms the lost ticks are
// dropped instead of caught up (the clients follow tick numbers, not the
// wall clock). Clock and timer are injectable for tests.

import { TICK_MS } from '../shared/net/constants.js';

const MAX_CATCH_UP = 4;
const HANG_MS = 250;
const HISTOGRAM_SIZE = 1024;

export interface SchedulerClock {
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

export const realClock: SchedulerClock = {
    now: () => performance.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export class TickMetrics {
    ticks = 0;
    overruns = 0;
    // Durations (ms) of the last HISTOGRAM_SIZE scheduler ticks
    private readonly durations = new Float64Array(HISTOGRAM_SIZE);
    private count = 0;

    record(ms: number): void {
        this.durations[this.count % HISTOGRAM_SIZE] = ms;
        this.count++;
        this.ticks++;
    }

    percentile(q: number): number {
        const n = Math.min(this.count, HISTOGRAM_SIZE);
        if (n === 0) return 0;
        const sorted = Array.from(this.durations.subarray(0, n)).sort((a, b) => a - b);
        return sorted[Math.min(n - 1, Math.floor(q * n))];
    }

    mean(): number {
        const n = Math.min(this.count, HISTOGRAM_SIZE);
        if (n === 0) return 0;
        let sum = 0;
        for (let i = 0; i < n; i++) sum += this.durations[i];
        return sum / n;
    }
}

export class TickScheduler {
    readonly metrics = new TickMetrics();
    // Clock time of the last scheduler tick (ms), -1 before the first
    lastTickAt = -1;
    private next = 0;
    private handle: unknown = null;
    private running = false;

    constructor(
        private readonly step: () => void,
        private readonly clock: SchedulerClock = realClock
    ) {}

    start(): void {
        if (this.running) return;
        this.running = true;
        this.next = this.clock.now();
        this.loop();
    }

    stop(): void {
        this.running = false;
        if (this.handle !== null) this.clock.clearTimeout(this.handle);
        this.handle = null;
    }

    get isRunning(): boolean {
        return this.running;
    }

    private loop = (): void => {
        this.handle = null;
        if (!this.running) return;
        const now = this.clock.now();
        let n = 0;
        while (now >= this.next && n < MAX_CATCH_UP) {
            const start = this.clock.now();
            this.lastTickAt = start;
            this.step();
            this.metrics.record(this.clock.now() - start);
            this.next += TICK_MS;
            n++;
        }
        if (now - this.next > HANG_MS) {
            this.next = now;
            this.metrics.overruns++;
        }
        if (!this.running) return;
        this.handle = this.clock.setTimeout(this.loop, Math.max(0, this.next - this.clock.now()));
    };
}
