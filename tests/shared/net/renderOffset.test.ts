import { describe, expect, it } from 'vitest';
import {
    CONTACT_SMOOTH_MAX_MS, SMOOTH_TAU_MAX_MS, SMOOTH_TAU_MIN_MS, SNAP_DISTANCE, SNAP_YAW
} from '../../../src/shared/net/constants.js';
import { createPose, interpolatePose, RenderOffset, type Pose } from '../../../src/shared/net/renderOffset.js';
import { createVehicleState } from '../../../src/shared/sim/types.js';

// The render offset of a correction (8.4): the picture stays where it was
// and the difference fades out over 100-200 ms, 300 ms at most after a
// contact; too large a difference jumps.

function pose(x: number, z: number, yaw = 0, y = 0): Pose {
    return { x, y, z, yaw };
}

describe('RenderOffset', () => {
    it('keeps the shown pose where it was at the moment of the correction', () => {
        const offset = new RenderOffset();
        const shown = pose(10, 20, 0.3, 1);
        const after = pose(10.4, 19.7, 0.25, 1.1);
        expect(offset.correct(shown, after, false, 0)).toBe(true);
        const again = offset.applyTo({ ...after });
        for (const key of ['x', 'y', 'z', 'yaw'] as const) expect(again[key]).toBeCloseTo(shown[key], 12);
    });

    it('adds up: a second correction starts from what is on screen with the old offset', () => {
        const offset = new RenderOffset();
        offset.correct(pose(0, 0), pose(1, 0), false, 0);
        offset.decay(50, 50);
        const shown = offset.applyTo(pose(1, 0));
        offset.correct(shown, pose(1.5, 0), false, 50);
        expect(offset.applyTo(pose(1.5, 0)).x).toBeCloseTo(shown.x, 12);
    });

    it('fades with tau 100 ms for small offsets and 200 ms from 2 m on', () => {
        const small = new RenderOffset();
        small.correct(pose(0.1, 0), pose(0, 0), false, 0);
        small.decay(SMOOTH_TAU_MIN_MS, 0);
        // tau = 100 ms + 100 ms · 0.1 m / 2 m
        const tau = SMOOTH_TAU_MIN_MS + (SMOOTH_TAU_MAX_MS - SMOOTH_TAU_MIN_MS) * 0.05;
        expect(small.tauMs).toBeCloseTo(tau, 12);
        expect(small.x).toBeCloseTo(0.1 * Math.exp(-SMOOTH_TAU_MIN_MS / tau), 12);
        const large = new RenderOffset();
        large.correct(pose(3, 0), pose(0, 0), false, 0);
        large.decay(10, 0);
        expect(large.tauMs).toBe(SMOOTH_TAU_MAX_MS);
        expect(large.x).toBeCloseTo(3 * Math.exp(-10 / SMOOTH_TAU_MAX_MS), 12);
    });

    it('is gone below 1 mm, within 1.5 s of 60 fps frames even from 3.9 m', () => {
        const offset = new RenderOffset();
        offset.correct(pose(3.9, 0), pose(0, 0), false, 0);
        let t = 0;
        let last = offset.size;
        while (offset.active && t < 2000) {
            t += 1000 / 60;
            offset.decay(1000 / 60, t);
            // Never more than one frame's decay at the shortest tau: no jump
            // (the last step below 1 mm clears the rest)
            expect(last - offset.size).toBeLessThanOrEqual(last * (1 - Math.exp(-(1000 / 60) / SMOOTH_TAU_MIN_MS)) + 1e-3);
            last = offset.size;
        }
        expect(offset.x).toBe(0);
        expect(t).toBeLessThan(1500);
    });

    it('is gone at the latest 300 ms after a contact correction began', () => {
        const offset = new RenderOffset();
        offset.correct(pose(2, 0), pose(0, 0), true, 1000);
        // Another contact correction on the way does not extend the window
        offset.decay(100, 1100);
        offset.correct(offset.applyTo(pose(0, 0)), pose(-1, 0), true, 1100);
        offset.decay(100, 1200);
        expect(offset.active).toBe(true);
        offset.decay(CONTACT_SMOOTH_MAX_MS - 200, 1000 + CONTACT_SMOOTH_MAX_MS);
        expect(offset.active).toBe(false);
        expect(offset.size).toBe(0);
        // A new contact correction opens a new window
        offset.correct(pose(1, 0), pose(0, 0), true, 2000);
        offset.decay(16, 2016);
        expect(offset.active).toBe(true);
    });

    it('jumps (clears) at 4 m, at 45° and on non-finite poses', () => {
        const offset = new RenderOffset();
        expect(offset.correct(pose(SNAP_DISTANCE, 0), pose(0, 0), false, 0)).toBe(false);
        expect(offset.size).toBe(0);
        expect(offset.correct(pose(0, 0, SNAP_YAW + 0.01), pose(0, 0, 0), false, 0)).toBe(false);
        expect(offset.correct(pose(Number.NaN, 0), pose(0, 0), false, 0)).toBe(false);
        expect(offset.correct(pose(SNAP_DISTANCE - 0.01, 0), pose(0, 0), false, 0)).toBe(true);
        expect(offset.size).toBeCloseTo(SNAP_DISTANCE - 0.01, 12);
    });

    it('takes yaw the short way across ±π', () => {
        const offset = new RenderOffset();
        expect(offset.correct(pose(0, 0, Math.PI - 0.05), pose(0, 0, -Math.PI + 0.05), false, 0)).toBe(true);
        expect(offset.yaw).toBeCloseTo(-0.1, 12);
    });
});

describe('interpolatePose', () => {
    it('interpolates position linearly and yaw the short way', () => {
        const a = createVehicleState(), b = createVehicleState();
        a.x = 0; b.x = 1; a.yaw = Math.PI - 0.1; b.yaw = -Math.PI + 0.1;
        const out = interpolatePose(a, b, 0.5, createPose());
        expect(out.x).toBe(0.5);
        expect(Math.abs(Math.abs(out.yaw) - Math.PI)).toBeLessThan(1e-12);
    });
});
