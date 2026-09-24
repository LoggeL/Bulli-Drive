import { describe, expect, it } from 'vitest';
import { TickScheduler, type SchedulerClock } from '../../src/server/tick.js';
import { TICK_MS } from '../../src/shared/net/constants.js';

// The 60 Hz scheduler (docs/phase-1b-design.md, 5.1 and 15.1) with a fake
// clock whose timers fire late by a random bit, like setTimeout.

class FakeClock implements SchedulerClock {
    time = 0;
    private timers: { at: number; fn: () => void; id: number }[] = [];
    private nextId = 1;
    lateBy: () => number = () => 0;
    // Extra time one step() call costs (a hang when large)
    stepCost = 0;

    now(): number {
        return this.time;
    }

    setTimeout(fn: () => void, ms: number): unknown {
        const id = this.nextId++;
        this.timers.push({ at: this.time + ms + this.lateBy(), fn, id });
        return id;
    }

    clearTimeout(handle: unknown): void {
        this.timers = this.timers.filter(t => t.id !== handle);
    }

    // Runs only the earliest pending timer (one scheduler wake-up)
    fireNext(): void {
        this.timers.sort((a, b) => a.at - b.at);
        const next = this.timers.shift();
        if (!next) throw new Error('no timer pending');
        this.time = Math.max(this.time, next.at);
        next.fn();
    }

    runUntil(end: number): void {
        while (this.timers.length) {
            this.timers.sort((a, b) => a.at - b.at);
            const next = this.timers[0];
            if (next.at > end) break;
            this.timers.shift();
            this.time = Math.max(this.time, next.at);
            next.fn();
        }
        this.time = end;
    }
}

describe('TickScheduler', () => {
    it('runs 60 ticks a second over 10 minutes without drift', () => {
        const clock = new FakeClock();
        let seed = 1;
        clock.lateBy = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647) * 2; };
        let ticks = 0;
        const scheduler = new TickScheduler(() => { ticks++; }, clock);
        scheduler.start();
        clock.runUntil(10 * 60_000);
        scheduler.stop();
        expect(Math.abs(ticks - 10 * 60 * 60)).toBeLessThanOrEqual(1);
        expect(scheduler.metrics.overruns).toBe(0);
    });

    it('catches up at most 4 ticks per wake-up', () => {
        const clock = new FakeClock();
        let count = 0;
        const scheduler = new TickScheduler(() => { count++; }, clock);
        // The first timer comes 110 ms late: it wakes at 126.7 ms, when the
        // ticks at 16.7, 33.3, ... 116.7 ms (7) are due
        clock.lateBy = () => 110;
        scheduler.start();
        expect(count).toBe(1); // the tick at 0 ms, run by start()
        clock.lateBy = () => 0;
        clock.fireNext();
        expect(clock.time).toBeCloseTo(1000 / 60 + 110, 9);
        expect(count).toBe(1 + 4);
        // The next wake-up follows at once and runs the remaining 3
        clock.fireNext();
        expect(clock.time).toBeCloseTo(1000 / 60 + 110, 9);
        expect(count).toBe(1 + 7);
        // Then back on the grid: 60 per second (ticks at 0, 16.7, ... 983.3 ms)
        clock.runUntil(999);
        expect(count).toBe(60);
        expect(scheduler.metrics.overruns).toBe(0);
        scheduler.stop();
    });

    it('skips the ticks of a hang over 250 ms instead of catching up', () => {
        const clock = new FakeClock();
        let count = 0;
        const scheduler = new TickScheduler(() => {
            count++;
            if (count === 10) clock.time += 1000;
        }, clock);
        scheduler.start();
        clock.runUntil(2000);
        scheduler.stop();
        expect(scheduler.metrics.overruns).toBe(1);
        // 2 s of time, 1 s of it lost in the hang
        expect(count).toBeLessThan(2000 / TICK_MS - 40);
        expect(count).toBeGreaterThan(1000 / TICK_MS - 5);
        expect(scheduler.metrics.percentile(1)).toBeGreaterThanOrEqual(1000);
    });

    it('records the tick durations', () => {
        const clock = new FakeClock();
        const scheduler = new TickScheduler(() => { clock.time += 0.5; }, clock);
        scheduler.start();
        clock.runUntil(500);
        scheduler.stop();
        expect(scheduler.metrics.mean()).toBeCloseTo(0.5, 9);
        expect(scheduler.lastTickAt).toBeGreaterThan(400);
    });
});
