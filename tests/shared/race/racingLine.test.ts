import { describe, expect, it } from 'vitest';
import { roundCorners, samplePath } from '../../../src/shared/race/geometry.js';
import { buildRacingLine, racingLine, speedProfile } from '../../../src/shared/race/racingLine.js';
import { DOWNTOWN_LOOP, HILL_SPRINT } from '../../../src/shared/race/tracks/index.js';
import { CAR_CLASS_IDS, createVehicleParams } from '../../../src/shared/sim/vehicleClasses.js';

// Speed profile of the racing line (docs/phase-2-design.md, 5.4), checked
// against the physics it encodes: in a bend of radius R the lateral
// acceleration v²/R stays within μ_eff·g = 0.85·gripFront·9.81, between
// two points the car never has to brake harder than 0.8·brakeDecel, and on
// a straight far from any bend it runs at vtop.

const G = 9.81;

describe('speedProfile', () => {
    // 300 m straight, a left bend of R = 20, 300 m straight; bulli: vtop 50,
    // gripFront 2.1, brakeDecel 20. Built inside each test, so the mutation
    // run attributes it to the test (tests/mutation/strykerSetup.ts)
    function bend() {
        const line = samplePath(roundCorners([{ x: 0, z: 0 }, { x: 0, z: 300 }, { x: 300, z: 300 }], false, 20));
        return { line, v: speedProfile(line, createVehicleParams('bulli')) };
    }
    const bendLimit = Math.sqrt(0.85 * 2.1 * G * 20);   // 18.71 m/s

    it('drives the bend at sqrt(μ_eff·g·R)', () => {
        const { line, v } = bend();
        // Points whose neighbours are on the arc too (s = 282 .. 309)
        const inBend = line.points.map((p, i) => ({ p, v: v[i] })).filter(({ p }) => p.s >= 282 && p.s <= 309);
        expect(inBend.length).toBeGreaterThan(10);
        for (const { v: speed } of inBend) expect(speed).toBeCloseTo(bendLimit, 6);
    });

    it('brakes into the bend with at most 0.8·brakeDecel', () => {
        const { line, v } = bend();
        const decel = 0.8 * 20;
        let binding = 0;
        for (let i = 0; i + 1 < line.points.length; i++) {
            const ds = line.points[i + 1].s - line.points[i].s;
            // v_i² - v_{i+1}² <= 2·a·ds
            expect(v[i] * v[i] - v[i + 1] * v[i + 1]).toBeLessThanOrEqual(2 * decel * ds + 1e-9);
            if (Math.abs(v[i] * v[i] - v[i + 1] * v[i + 1] - 2 * decel * ds) < 1e-6) binding++;
        }
        // The braking zone before the bend: (50² - 18.71²)/(2·16) = 67 m, 2 m steps
        expect(binding).toBeGreaterThan(25);
    });

    it('runs at vtop on the straights away from the bend', () => {
        const { line, v } = bend();
        const straight = line.points.map((p, i) => ({ p, v: v[i] })).filter(({ p }) => p.s < 200 || p.s > 330);
        for (const { v: speed } of straight) expect(speed).toBe(50);
    });

    it('never exceeds vtop, and the bend limit in every bend of the Downtown Loop (R = 19)', () => {
        const loop = buildRacingLine(DOWNTOWN_LOOP);
        for (const classId of CAR_CLASS_IDS) {
            const params = createVehicleParams(classId);
            const profile = speedProfile(loop, params);
            const limit = Math.sqrt(0.85 * params.gripFront * G * 19);
            loop.points.forEach((p, i) => {
                expect(profile[i]).toBeLessThanOrEqual(params.topSpeed);
                if (Math.abs(p.curvature - 1 / 19) < 1e-6 || Math.abs(p.curvature + 1 / 19) < 1e-6) {
                    expect(profile[i]).toBeLessThanOrEqual(limit + 1e-9);
                }
            });
            // Braking wraps round the closed loop: the last point brakes for the first bend too
            const n = loop.points.length;
            const ds = loop.length - loop.points[n - 1].s;
            expect(profile[n - 1] ** 2 - profile[0] ** 2).toBeLessThanOrEqual(2 * 0.8 * params.brakeDecel * ds + 1e-9);
        }
    });

    it('caches one line per track', () => {
        expect(racingLine(HILL_SPRINT)).toBe(racingLine(HILL_SPRINT));
        expect(racingLine(HILL_SPRINT).closed).toBe(false);
        expect(racingLine(DOWNTOWN_LOOP).closed).toBe(true);
    });
});
