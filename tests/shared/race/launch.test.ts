import { describe, expect, it } from 'vitest';
import { applyLaunchMods, LaunchRecorder, launchResult } from '../../../src/shared/race/launch.js';
import { createVehicleModifiers } from '../../../src/shared/sim/types.js';

// Launch at S = startTick (docs/phase-2-design.md, 12.2): the last rising
// edge of the raw throttle (< 128 -> >= 128), held through S. Within
// [S - 20, S] a perfect start, earlier a bogged one, no throttle at S normal.

const S = 1000;

// Raw throttle 255 from tick `from` up to and including `to`, else 0
function held(from: number, to = S): (tick: number) => number {
    return tick => (tick >= from && tick <= to ? 255 : 0);
}

describe('launchResult', () => {
    it('perfect from an edge at S - 20 up to S, early from S - 21', () => {
        expect(launchResult(held(S - 20), S)).toBe('perfect');
        expect(launchResult(held(S - 5), S)).toBe('perfect');
        expect(launchResult(held(S), S)).toBe('perfect');
        expect(launchResult(held(S - 21), S)).toBe('early');
        expect(launchResult(held(S - 200), S)).toBe('early');
        // Held forever: looks back at most LAUNCH_HISTORY_TICKS (64)
        expect(launchResult(() => 255, S)).toBe('early');
    });

    it('normal without throttle at S, also after holding it until just before', () => {
        expect(launchResult(() => 0, S)).toBe('normal');
        expect(launchResult(held(S - 30, S - 1), S)).toBe('normal');
        expect(launchResult(held(S + 1, S + 10), S)).toBe('normal');
    });

    it('takes the last edge: letting go in between starts a new one', () => {
        // Pressed early, released at S - 10, pressed again at S - 8
        const throttle = (tick: number) => (tick >= S - 60 && tick <= S - 11) || (tick >= S - 8 && tick <= S) ? 255 : 0;
        expect(launchResult(throttle, S)).toBe('perfect');
    });

    it('counts the pedal from 128 on', () => {
        expect(launchResult(tick => (tick >= S - 10 ? 128 : 127), S)).toBe('perfect');
        expect(launchResult(tick => (tick >= S - 10 ? 127 : 0), S)).toBe('normal');
        // 127 before the edge is still "not pressed", 128 held from S - 30 is
        expect(launchResult(tick => (tick >= S - 30 ? 255 : 127), S)).toBe('early');
        expect(launchResult(tick => (tick >= S - 30 ? 128 : 0), S)).toBe('early');
    });
});

describe('LaunchRecorder', () => {
    it('keeps the raw throttle of the last 64 ticks; missing ticks count as released', () => {
        const recorder = new LaunchRecorder();
        for (let tick = S - 100; tick <= S; tick++) recorder.record(tick, tick >= S - 15 ? 200 : 0);
        expect(recorder.result(S)).toBe('perfect');
        expect(recorder.throttleAt(S - 15)).toBe(200);
        expect(recorder.throttleAt(S - 16)).toBe(0);
        // Overwritten by the ring: tick S - 64 shares a slot with S
        expect(recorder.throttleAt(S - 64)).toBe(0);
        // A gap in the record (lost input) breaks the held pedal: early becomes perfect
        const gap = new LaunchRecorder();
        for (let tick = S - 50; tick <= S; tick++) if (tick !== S - 12) gap.record(tick, 255);
        expect(gap.result(S)).toBe('perfect');
        const early = new LaunchRecorder();
        for (let tick = S - 50; tick <= S; tick++) early.record(tick, 255);
        expect(early.result(S)).toBe('early');
        early.clear();
        expect(early.result(S)).toBe('normal');
    });

    it('holding through the whole ring is early', () => {
        const recorder = new LaunchRecorder();
        for (let tick = 0; tick <= S; tick++) recorder.record(tick, 255);
        expect(recorder.result(S)).toBe('early');
    });

    it('treats a broken value as no throttle', () => {
        const recorder = new LaunchRecorder();
        recorder.record(S, Number.NaN);
        expect(recorder.throttleAt(S)).toBe(0);
        recorder.record(S - 1, Infinity);
        expect(recorder.throttleAt(S - 1)).toBe(0);
    });
});

describe('applyLaunchMods', () => {
    it('perfect: launch for [S, S + 60); early: bogged for [S, S + 30); never before S', () => {
        const mods = createVehicleModifiers();
        const at = (result: 'perfect' | 'early' | 'normal', tick: number) => {
            applyLaunchMods(result, tick, S, mods);
            return [mods.launch, mods.bogged];
        };
        expect(at('perfect', S - 1)).toEqual([false, false]);
        expect(at('perfect', S)).toEqual([true, false]);
        expect(at('perfect', S + 59)).toEqual([true, false]);
        expect(at('perfect', S + 60)).toEqual([false, false]);
        expect(at('early', S - 1)).toEqual([false, false]);
        expect(at('early', S)).toEqual([false, true]);
        expect(at('early', S + 29)).toEqual([false, true]);
        expect(at('early', S + 30)).toEqual([false, false]);
        expect(at('normal', S)).toEqual([false, false]);
    });
});
