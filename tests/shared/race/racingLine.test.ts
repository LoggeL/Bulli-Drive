import { describe, expect, it } from 'vitest';
import { roundCorners, samplePath } from '../../../src/shared/race/geometry.js';
import { buildRacingLine, crestCurvature, racingLine, speedProfile } from '../../../src/shared/race/racingLine.js';
import type { TrackDef } from '../../../src/shared/race/types.js';
import { SURFACE } from '../../../src/shared/map/types.js';
import { CAR_CLASS_IDS, createVehicleParams } from '../../../src/shared/sim/vehicleClasses.js';

// Speed profile of the racing line (docs/phase-2-design.md, 5.4), checked
// against the physics it encodes: in a bend of radius R the lateral
// acceleration v²/R stays within μ_eff·g = 0.85·gripFront·9.81, between
// two points the car never has to brake harder than 0.8·brakeDecel, and on
// a straight far from any bend it runs at vtop.

const G = 9.81;

// The Downtown Loop of phase 2: a closed city block round, every corner
// rounded to R = 19 m
const LOOP_CORNERS = [
    { x: 6, z: -10 }, { x: 6, z: 58 }, { x: 58, z: 58 }, { x: 58, z: 110 }, { x: -98, z: 110 },
    { x: -98, z: -98 }, { x: 58, z: -98 }, { x: 58, z: -46 }, { x: 6, z: -46 }
];

function track(kind: 'circuit' | 'sprint'): TrackDef {
    return {
        id: kind === 'circuit' ? 'downtown-loop' : 'hill-sprint', name: '', kind, laps: kind === 'circuit' ? 3 : 1,
        mapVersion: 1, trackVersion: 1, centerline: LOOP_CORNERS, lineOptions: { radius: 19, apexShift: 0 },
        gates: [], grid: [], hints: [], minimap: { minX: 0, maxX: 1, minZ: 0, maxZ: 1 }, ramps: []
    };
}

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

    it('takes the bend slower by the grip of the surface under the line (sand: 0.6 · the offroad grip 0.9)', () => {
        const line = samplePath(roundCorners([{ x: 0, z: 0 }, { x: 0, z: 300 }, { x: 300, z: 300 }], false, 20));
        const sand = new Uint8Array(line.points.length).fill(SURFACE.sand);
        const v = speedProfile(line, createVehicleParams('bulli'), sand);
        const inBend = line.points.map((p, i) => ({ p, v: v[i] })).filter(({ p }) => p.s >= 282 && p.s <= 309);
        for (const { v: speed } of inBend) expect(speed).toBeCloseTo(Math.sqrt(0.85 * 2.1 * G * 20 * 0.6 * 0.9), 6);
        // Tarmac under the line changes nothing
        const tarmac = speedProfile(line, createVehicleParams('bulli'), new Uint8Array(line.points.length).fill(SURFACE.asphalt));
        expect(Array.from(tarmac)).toEqual(Array.from(speedProfile(line, createVehicleParams('bulli'))));
    });

    it('takes a bot\'s own grip share on unpaved ground only (the easy bot: 0.7)', () => {
        const line = samplePath(roundCorners([{ x: 0, z: 0 }, { x: 0, z: 300 }, { x: 300, z: 300 }], false, 20));
        const inBend = (v: Float64Array) => line.points.map((p, i) => ({ p, v: v[i] })).filter(({ p }) => p.s >= 282 && p.s <= 309);
        const sand = new Uint8Array(line.points.length).fill(SURFACE.sand);
        for (const { v } of inBend(speedProfile(line, createVehicleParams('bulli'), sand, 0.7))) {
            expect(v).toBeCloseTo(Math.sqrt(0.85 * 2.1 * G * 20 * 0.6 * 0.9 * 0.7), 6);
        }
        // On tarmac the share changes nothing, nor on the straights (vtop)
        const tarmac = new Uint8Array(line.points.length).fill(SURFACE.asphalt);
        for (const { v } of inBend(speedProfile(line, createVehicleParams('bulli'), tarmac, 0.7))) expect(v).toBeCloseTo(bendLimit, 6);
        expect(speedProfile(line, createVehicleParams('bulli'), sand, 0.7)[0]).toBe(50);
    });

    it('runs at vtop on the straights away from the bend', () => {
        const { line, v } = bend();
        const straight = line.points.map((p, i) => ({ p, v: v[i] })).filter(({ p }) => p.s < 200 || p.s > 330);
        for (const { v: speed } of straight) expect(speed).toBe(50);
    });

    it('never exceeds vtop, and the bend limit in every bend of a closed loop (R = 19)', () => {
        const loop = buildRacingLine(track('circuit'));
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
        const sprint = track('sprint'), circuit = track('circuit');
        expect(racingLine(sprint)).toBe(racingLine(sprint));
        expect(racingLine(sprint)).not.toBe(racingLine(track('sprint')));
        expect(racingLine(sprint).closed).toBe(false);
        expect(racingLine(circuit).closed).toBe(true);
    });
});

describe('speedProfile at crests (docs/phase-1a-design.md, 27)', () => {
    // 600 m north, a left bend of R = 60 (the arc from s = 540 to 634),
    // then east. A crest of vertical radius 40 m (y = -(s - c)²/80 within
    // 20 m of c, the grades ±0.5 beyond). Bulli: vtop 50 m/s.
    function crestLine(c: number) {
        const line = samplePath(roundCorners([{ x: 0, z: 0 }, { x: 0, z: 600 }, { x: 600, z: 600 }], false, 60));
        const heights = Float64Array.from(line.points, p => {
            const d = p.s - c;
            return Math.abs(d) <= 20 ? -d * d / 80 : -(Math.abs(d) - 10) * 0.5;
        });
        return { line, heights, at: line.points.findIndex(p => p.s === c) };
    }

    it('measures the vertical curvature over ±6 m: 1/R on the parabola, convex > 0', () => {
        const { line, heights, at } = crestLine(200);
        const kappa = crestCurvature(line, heights);
        // Second differences of a parabola are exact
        for (let i = at - 7; i <= at + 7; i++) expect(kappa[i]).toBeCloseTo(1 / 40, 9);
        // On the straight grade beyond it: none
        expect(kappa[at + 20]).toBeCloseTo(0, 9);
        // A sag is negative
        expect(crestCurvature(line, heights.map(h => -h))[at]).toBeCloseTo(-1 / 40, 9);
    });

    it('takes a crest before a bend below lift-off: √(0.8 · GRAVITY / κ) = √(0.8 · 15 · 40) = 21.9 m/s', () => {
        // At 50 m/s the flight (0.6 s) reaches 30 m: from s = 530, 20 m of
        // the R 60 arc, a turn of 0.33 rad
        const { line, heights, at } = crestLine(530);
        const v = speedProfile(line, createVehicleParams('bulli'), null, 1, heights);
        expect(v[at]).toBeCloseTo(Math.sqrt(0.8 * 15 * 40), 6);
        // Without the heights the crest does not count: only the braking
        // for the bend, √(32.4² + 2 · 16 · 10) = 37 m/s
        expect(speedProfile(line, createVehicleParams('bulli'))[at]).toBeGreaterThan(35);
    });

    it('wraps a circuit: the window reaches across the lap\'s start, the flight into the next lap', () => {
        // A square circuit, 400 m sides, corners R 60; the lap starts where
        // the first corner ends, so it ends inside that corner
        const line = samplePath(roundCorners([{ x: 0, z: 0 }, { x: 0, z: 400 }, { x: 400, z: 400 }, { x: 400, z: 0 }], true, 60));
        const n = line.points.length, L = line.length;
        // A parabola (R 40) around station c, distances taken round the lap
        const crest = (c: number) => Float64Array.from(line.points, p => {
            let d = p.s - c;
            if (d < -L / 2) d += L;
            if (d > L / 2) d -= L;
            return Math.abs(d) <= 20 ? -d * d / 80 : -(Math.abs(d) - 10) * 0.5;
        });
        // Around the start: the window takes the last points of the lap
        const atStart = crestCurvature(line, crest(2));
        for (const i of [n - 2, n - 1, 0, 1, 2, 3]) expect(atStart[i], `point ${i}`).toBeCloseTo(1 / 40, 9);
        // In the corner that ends the lap: capped (the corner turns 0.17 rad
        // within 10 m, and the flight runs on into the next lap)
        const c = line.points[n - 5].s;
        const v = speedProfile(line, createVehicleParams('bulli'), null, 1, crest(c));
        expect(v[n - 5]).toBeCloseTo(Math.sqrt(0.8 * 15 * 40), 6);
        // On the lap's last point the corner has 1 m left (1/60 rad), the
        // next lap starts straight: the flight turns about 0.03 rad, no cap;
        // the corner's own limit √(0.85 · 2.1 · 9.81 · 60) = 32.4 m/s holds
        const last = speedProfile(line, createVehicleParams('bulli'), null, 1, crest(line.points[n - 1].s));
        expect(last[n - 1]).toBeCloseTo(Math.sqrt(0.85 * 2.1 * G * 60), 3);
    });

    it('does not wrap a sprint: a crest at its end sees no bend from its start', () => {
        // The sprint starts 3 m before a bend (R 20, 45°) and ends straight;
        // a crest about 14 m before its end has nothing ahead of it (read
        // round from the start, its 30 m of flight would reach 13 m into
        // that bend: 0.65 rad)
        const line = samplePath(roundCorners([{ x: 8, z: -8 }, { x: 0, z: 0 }, { x: 0, z: 400 }], false, 20));
        const n = line.points.length;
        const c = line.points[n - 8].s;
        const heights = Float64Array.from(line.points, p => {
            const d = p.s - c;
            return Math.abs(d) <= 20 ? -d * d / 80 : -(Math.abs(d) - 10) * 0.5;
        });
        expect(crestCurvature(line, heights)[n - 8]).toBeCloseTo(1 / 40, 9);
        expect(speedProfile(line, createVehicleParams('bulli'), null, 1, heights)[n - 8]).toBe(50);
        // A line shorter than the window (±6 m) has no curvature at all
        const short = samplePath(roundCorners([{ x: 0, z: 0 }, { x: 0, z: 10 }], false, 0));
        expect(Array.from(crestCurvature(short, Float64Array.from(short.points, p => -p.s * p.s)))).toEqual(short.points.map(() => 0));
    });

    it('lets the car fly over a crest on a straight: no bend within the flight', () => {
        // From s = 200 the next 30 m and more are straight
        const { line, heights, at } = crestLine(200);
        const v = speedProfile(line, createVehicleParams('bulli'), null, 1, heights);
        expect(v[at]).toBe(50);
        // A crest whose convex stretch (±14 m: the ±6 m window over the
        // ±20 m parabola) ends more than a flight (30 m) before the bend at
        // 540: from s = 480 the last crest point 494 reaches 524. The
        // braking for the bend starts later (√(32.4² + 2 · 16 · 60) > 50)
        const early = crestLine(480);
        expect(speedProfile(early.line, createVehicleParams('bulli'), null, 1, early.heights)[early.at]).toBe(50);
    });
});
