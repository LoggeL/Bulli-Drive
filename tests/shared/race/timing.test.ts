import { describe, expect, it } from 'vitest';
import { formatRaceTime, formatSplit, ticksToMs } from '../../../src/shared/race/timing.js';

// Race times on screen (docs/phase-2-design.md, 8): whole milliseconds,
// round(ticks · 1000 / 60), as m:ss.mmm.

describe('race time display', () => {
    it('converts ticks to milliseconds at 60 Hz, rounding half up', () => {
        expect(ticksToMs(60)).toBe(1000);
        expect(ticksToMs(1)).toBe(17);        // 16.67 ms
        expect(ticksToMs(0.03)).toBe(1);      // exactly 0.5 ms
        expect(ticksToMs(0.029)).toBe(0);     // 0.483 ms
    });

    it('shows m:ss.mmm', () => {
        // 83.456 s
        expect(formatRaceTime(83.456 * 60)).toBe('1:23.456');
        expect(formatRaceTime(0)).toBe('0:00.000');
        expect(formatRaceTime(59.9995 * 60)).toBe('1:00.000');
        expect(formatRaceTime(9.05 * 60)).toBe('0:09.050');
        expect(formatRaceTime(3600 * 60 + 60)).toBe('60:01.000');
    });

    it('shows splits with a sign', () => {
        expect(formatSplit(-0.312 * 60)).toBe('-0.312');
        expect(formatSplit(0.418 * 60)).toBe('+0.418');
        expect(formatSplit(0)).toBe('+0.000');
        // Rounds to zero: no minus zero
        expect(formatSplit(-0.01)).toBe('+0.000');
        expect(formatSplit(75.5 * 60)).toBe('+1:15.500');
    });
});
