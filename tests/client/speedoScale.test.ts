import { describe, expect, it } from 'vitest';
import {
    carSpeedToKmh,
    speedoFill,
    SPEEDO_SCALE_MAX_KMH,
    SPEEDO_SCALE_MAX_KMH_V2,
    TOP_SPEED_KMH,
    TURBO_TOP_SPEED_KMH
} from '../../src/client/ui/speedoScale.js';
import { METERS_PER_UNIT, MS_TO_KMH } from '../../src/shared/constants.js';
import { SIM_TUNING, V_ABS } from '../../src/shared/sim/constants.js';
import { CAR_CLASS_IDS, VEHICLE_CLASSES } from '../../src/shared/sim/vehicleClasses.js';

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

describe('v2 speedometer', () => {
    it('shows the sim speed through the legacy adapter (u/60 per tick)', () => {
        expect(carSpeedToKmh(50 / 60)).toBeCloseTo(180, 9);
    });

    it('keeps every top speed, boost and the hard cap on the 320 km/h dial', () => {
        expect(SPEEDO_SCALE_MAX_KMH_V2).toBe(320);
        const capKmh = V_ABS * MS_TO_KMH;
        expect(capKmh).toBeCloseTo(306, 9);
        expect(speedoFill(capKmh, SPEEDO_SCALE_MAX_KMH_V2)).toBeLessThan(1);
        expect(speedoFill(capKmh, SPEEDO_SCALE_MAX_KMH_V2)).toBeGreaterThan(0.9);
        for (const id of CAR_CLASS_IDS) {
            const boostKmh = Math.min(VEHICLE_CLASSES[id].topSpeed + SIM_TUNING.BOOST_ADD, V_ABS) * MS_TO_KMH;
            expect(speedoFill(boostKmh, SPEEDO_SCALE_MAX_KMH_V2)).toBeLessThan(1);
            expect(speedoFill(VEHICLE_CLASSES[id].topSpeed * MS_TO_KMH, SPEEDO_SCALE_MAX_KMH_V2)).toBeGreaterThan(0.5);
        }
    });
});
