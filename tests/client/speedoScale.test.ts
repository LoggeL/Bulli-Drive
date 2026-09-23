import { describe, expect, it } from 'vitest';
import {
    carSpeedToKmh,
    speedoFill,
    SPEEDO_SCALE_MAX_KMH,
    TOP_SPEED_KMH,
    TURBO_TOP_SPEED_KMH
} from '../../src/client/ui/speedoScale.js';
import { METERS_PER_UNIT, MS_TO_KMH } from '../../src/shared/constants.js';

describe('scale', () => {
    it('is one metre per world unit', () => {
        expect(METERS_PER_UNIT).toBe(1);
        expect(MS_TO_KMH).toBe(3.6);
    });
});

describe('speedometer', () => {
    it('shows the real speed in km/h', () => {
        // 1 u per 1/60 s tick = 60 m/s
        expect(carSpeedToKmh(1)).toBeCloseTo(216, 9);
        expect(carSpeedToKmh(-0.5)).toBeCloseTo(108, 9);
        expect(carSpeedToKmh(0)).toBe(0);
    });

    it('matches the legacy top speeds', () => {
        expect(TOP_SPEED_KMH).toBeCloseTo(216, 9);
        expect(TURBO_TOP_SPEED_KMH).toBeCloseTo(388.8, 9);
    });

    it('keeps the Turbo top speed on the dial', () => {
        expect(SPEEDO_SCALE_MAX_KMH).toBe(400);
        expect(speedoFill(Math.round(TURBO_TOP_SPEED_KMH))).toBeLessThan(1);
        expect(speedoFill(Math.round(TURBO_TOP_SPEED_KMH))).toBeGreaterThan(0.9);
        expect(speedoFill(Math.round(TOP_SPEED_KMH))).toBeCloseTo(0.54, 9);
        expect(speedoFill(0)).toBe(0);
        expect(speedoFill(1000)).toBe(1);
    });
});
