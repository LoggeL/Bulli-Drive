import { describe, expect, it } from 'vitest';
import {
    cornerSpeed, driveAcceleration, speedProfile, surfaceGrip, weakestCornerSpeed, type CarModel, type ProfilePoint
} from '../../../src/shared/map/drivability.js';
import { SURFACE } from '../../../src/shared/map/types.js';

// Drivability estimates for building the map (docs/phase-3-design.md, 4 and
// 15). Expected values are worked out by hand from the formulas of the v2
// tyre model (g = 9.81, grip margin 0.75) and the surface table 8.1.

const G = 9.81;
const CAR: CarModel = {
    gripFront: 2.0, gripRear: 2.4, aeroGrip: 0, topSpeed: 50, accel: 8, brakeDecel: 10,
    offroadGrip: 0.8, offroadDrag: 0.5
};

describe('surfaceGrip', () => {
    it('takes the weaker axle, scaled by the surface and, off paved roads, by the class', () => {
        expect(surfaceGrip(CAR, SURFACE.asphalt)).toBe(2.0);
        expect(surfaceGrip(CAR, SURFACE.concrete)).toBeCloseTo(2.0 * 0.97, 12);
        expect(surfaceGrip(CAR, SURFACE.wood)).toBeCloseTo(2.0 * 0.9, 12);
        // Unpaved: gravel 0.80 · offroadGrip 0.8
        expect(surfaceGrip(CAR, SURFACE.gravel)).toBeCloseTo(2.0 * 0.8 * 0.8, 12);
        expect(surfaceGrip(CAR, SURFACE.sand)).toBeCloseTo(2.0 * 0.6 * 0.8, 12);
        expect(surfaceGrip({ ...CAR, gripFront: 2.6 }, SURFACE.asphalt)).toBe(2.4);
        expect(surfaceGrip(CAR, SURFACE.water)).toBe(0);
    });
});

describe('cornerSpeed', () => {
    it('solves v²·κ = 0.75·g·μ without downforce', () => {
        // R = 20 m: v² = 0.75 · 9.81 · 2 · 20 = 294.3
        expect(cornerSpeed(CAR, 1 / 20, SURFACE.asphalt)).toBeCloseTo(Math.sqrt(294.3), 9);
        // The sign of the curvature (left or right bend) does not matter
        expect(cornerSpeed(CAR, -1 / 20, SURFACE.asphalt)).toBeCloseTo(Math.sqrt(294.3), 9);
        // Another grip margin
        expect(cornerSpeed(CAR, 1 / 20, SURFACE.asphalt, 1)).toBeCloseTo(Math.sqrt(G * 2 * 20), 9);
    });

    it('adds the aero grip, which grows with (v / vtop)²', () => {
        // aeroGrip 0.25, vtop 50: v²·κ = a·(1 + 0.25·v²/2500), a = 14.715
        // → v² = a / (κ - a·0.0001) = 14.715 / 0.0485285
        const car = { ...CAR, aeroGrip: 0.25 };
        expect(cornerSpeed(car, 1 / 20, SURFACE.asphalt)).toBeCloseTo(Math.sqrt(14.715 / (0.05 - 0.0014715)), 9);
    });

    it('is capped at the top speed on straights and gentle bends', () => {
        expect(cornerSpeed(CAR, 0, SURFACE.asphalt)).toBe(50);
        // κ = 0.0005: v would be 171 m/s
        expect(cornerSpeed(CAR, 0.0005, SURFACE.asphalt)).toBe(50);
        // With aero the grip outgrows the bend below κ = a·aero/vtop²
        expect(cornerSpeed({ ...CAR, aeroGrip: 0.25 }, 0.001, SURFACE.asphalt)).toBe(50);
    });

    it('is 0 where there is no grip (water)', () => {
        expect(cornerSpeed(CAR, 0.01, SURFACE.water)).toBe(0);
    });
});

describe('weakestCornerSpeed', () => {
    it('finds the pickup the slowest class through a tarmac bend of R = 20 m', () => {
        // Pickup: weaker axle 2.0, aeroGrip 0.2, vtop 47 (vehicleClasses.ts):
        // a = 0.75 · 9.81 · 2.0 = 14.715, v² = a / (1/20 - a·0.2/47²).
        // The bulli (2.1, 0.25, 50) and the jeep (2.1, 0.2, 49) come out at
        // 17.86 and 17.81 m/s, the beetle and the sport car higher.
        const { speed, car } = weakestCornerSpeed(1 / 20, SURFACE.asphalt);
        expect(car).toBe('pickup');
        expect(speed).toBeCloseTo(Math.sqrt(14.715 / (0.05 - 14.715 * 0.2 / (47 * 47))), 9);
    });
});

describe('driveAcceleration', () => {
    it('falls with (v/vtop)^2.5, loses the rolling resistance off paved roads and fights the slope', () => {
        // v = 25 = vtop/2: 8 · (1 - 0.5^2.5) = 8 · 0.823223 = 6.58579
        expect(driveAcceleration(CAR, 25, SURFACE.asphalt, 0)).toBeCloseTo(8 * (1 - Math.pow(0.5, 2.5)), 12);
        // Gravel: d = 0.4 · offroadDrag 0.5 = 0.2
        expect(driveAcceleration(CAR, 25, SURFACE.gravel, 0)).toBeCloseTo(8 * (1 - Math.pow(0.5, 2.5)) - 0.2, 12);
        // 10 % climb: - 0.981; downhill helps
        expect(driveAcceleration(CAR, 25, SURFACE.asphalt, 0.1)).toBeCloseTo(8 * (1 - Math.pow(0.5, 2.5)) - 0.981, 12);
        expect(driveAcceleration(CAR, 25, SURFACE.asphalt, -0.1)).toBeCloseTo(8 * (1 - Math.pow(0.5, 2.5)) + 0.981, 12);
        // No drive at or above the top speed
        expect(driveAcceleration(CAR, 60, SURFACE.asphalt, 0)).toBe(0);
    });
});

// A straight, level line every metre; the last point optionally a bend
function line(length: number, lastCurvature = 0, grade = 0, surface: number = SURFACE.asphalt): ProfilePoint[] {
    const points: ProfilePoint[] = [];
    for (let s = 0; s <= length; s++) points.push({ s, curvature: s === length ? lastCurvature : 0, surface, y: grade * s });
    return points;
}

// Top speed so high that the drive stays at `accel` (x^2.5 below 1e-15)
const ROCKET: CarModel = { ...CAR, topSpeed: 1e6, accel: 5 };

describe('speedProfile', () => {
    it('accelerates evenly from a standing start: v = √(2as), t = √(2s/a)', () => {
        const profile = speedProfile(ROCKET, line(100));
        expect(profile.speeds[0]).toBe(0);
        expect(profile.speeds[50]).toBeCloseTo(Math.sqrt(2 * 5 * 50), 6);
        expect(profile.speeds[100]).toBeCloseTo(Math.sqrt(2 * 5 * 100), 6);
        // The mean speed per step is exact for constant acceleration
        expect(profile.time).toBeCloseTo(Math.sqrt(2 * 100 / 5), 6);
        expect(profile.stall).toBe(-1);
    });

    it('brakes with brakeDecel so it enters a bend at the bend speed', () => {
        // Bend R = 10 at s = 100: v² = 0.75 · 9.81 · 2 · 10 = 147.15; from
        // there back up at 10 m/s²: v(90)² = 147.15 + 2·10·10. The braking
        // line meets the acceleration line v² = 10·s at s = 2147.15 / 30.
        const profile = speedProfile(ROCKET, line(100, 1 / 10));
        expect(profile.speeds[100]).toBeCloseTo(Math.sqrt(147.15), 6);
        expect(profile.speeds[90]).toBeCloseTo(Math.sqrt(147.15 + 200), 6);
        expect(profile.speeds[60]).toBeCloseTo(Math.sqrt(600), 6);
        // From a standing start the slowest point is the first step; from a
        // flying start at 30 m/s it is the bend
        expect(profile.slowest).toBe(1);
        expect(speedProfile(ROCKET, line(100, 1 / 10), 30).slowest).toBe(100);
        const top = Math.max(...profile.speeds);
        expect(top).toBeLessThanOrEqual(Math.sqrt(2147.15 / 3) + 1e-9);
        expect(top).toBeGreaterThan(Math.sqrt(2147.15 / 3) - 0.5);
    });

    it('starts from the given speed and caps it at the first bend', () => {
        expect(speedProfile(ROCKET, line(10), 20).speeds[0]).toBe(20);
        const bend: ProfilePoint[] = [{ s: 0, curvature: 1 / 10, surface: SURFACE.asphalt }, ...line(10).slice(1)];
        expect(speedProfile(ROCKET, bend, 20).speeds[0]).toBeCloseTo(Math.sqrt(147.15), 6);
        // A bend 10 m ahead brakes a flying start: v(0)² = 147.15 + 2·10·10
        expect(speedProfile(ROCKET, line(10, 1 / 10), 30).speeds[0]).toBeCloseTo(Math.sqrt(147.15 + 200), 6);
    });

    it('takes the grade from the heights over any point spacing, uphill and when braking downhill', () => {
        // Points every 5 m, 10 % up: a = 5 - 0.981
        const up: ProfilePoint[] = [];
        for (let s = 0; s <= 100; s += 5) up.push({ s, curvature: 0, surface: SURFACE.asphalt, y: 0.1 * s });
        expect(speedProfile(ROCKET, up).speeds[20]).toBeCloseTo(Math.sqrt(2 * (5 - 0.981) * 100), 6);
        // 10 % down into a bend of R = 10 at s = 100: braking loses 0.981 m/s²,
        // v(90)² = 147.15 + 2 · (10 - 0.981) · 10
        const down: ProfilePoint[] = [];
        for (let s = 0; s <= 100; s += 5) down.push({ s, curvature: s === 100 ? 1 / 10 : 0, surface: SURFACE.asphalt, y: -0.1 * s });
        expect(speedProfile(ROCKET, down, 30).speeds[18]).toBeCloseTo(Math.sqrt(147.15 + 2 * (10 - 0.981) * 10), 6);
    });

    it('reports a climb the car cannot make', () => {
        // 30 % needs 2.943 m/s² more than an accel of 2 gives
        const weak = { ...ROCKET, accel: 2 };
        const profile = speedProfile(weak, line(50, 0, 0.3), 5);
        expect(profile.stall).toBeGreaterThan(0);
        // The same car manages 15 % (1.47 m/s² of slope)
        expect(speedProfile(weak, line(50, 0, 0.15), 5).stall).toBe(-1);
    });

    it('slows down on sand through the rolling resistance', () => {
        // Sand: d = 1.6 · offroadDrag 0.5 = 0.8, so 4.2 m/s² instead of 5
        const profile = speedProfile(ROCKET, line(100, 0, 0, SURFACE.sand));
        expect(profile.speeds[100]).toBeCloseTo(Math.sqrt(2 * 4.2 * 100), 6);
    });
});
