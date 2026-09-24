import { beforeEach, describe, expect, it } from 'vitest';
import {
    advanceProgress, createCourse, createRaceProgress, finishPassed, lapFor, nextGateIndex, passGate, trackLine,
    updateWrongWay, type Course, type RaceProgress
} from '../../../src/shared/race/progress.js';
import { buildRacingLine } from '../../../src/shared/race/racingLine.js';
import type { TrackDef } from '../../../src/shared/race/types.js';

// Progress of one racer (docs/phase-2-design.md, 5.1, 8, 9, 10) on two
// hand-made tracks whose racing line is the centre line itself (radius
// 1 mm): a 100 m square circuit and a straight sprint. Distances along the
// line are then plain sums of leg lengths.

const SQUARE: TrackDef = {
    id: 'downtown-loop', name: 'Square', kind: 'circuit', laps: 2, mapVersion: 3, trackVersion: 1,
    // Up x = 0, across z = 100, down x = 100, back along z = 0
    centerline: [{ x: 0, z: 0 }, { x: 0, z: 100 }, { x: 100, z: 100 }, { x: 100, z: 0 }],
    lineOptions: { radius: 0.001, apexShift: 0 },
    gates: [
        { x: 0, z: 50, yaw: 0, width: 20, visual: 'startFinish' },
        { x: 50, z: 100, yaw: Math.PI / 2, width: 20, visual: 'arch' },
        { x: 100, z: 50, yaw: Math.PI, width: 20, visual: 'arch' },
        { x: 50, z: 0, yaw: -Math.PI / 2, width: 20, visual: 'arch' }
    ],
    grid: [], hints: [], minimap: { minX: 0, maxX: 100, minZ: 0, maxZ: 100 }
};

const SPRINT: TrackDef = {
    ...SQUARE, id: 'hill-sprint', name: 'Straight', kind: 'sprint', laps: 1,
    centerline: [{ x: 0, z: -20 }, { x: 0, z: 200 }],
    gates: [
        { x: 0, z: 0, yaw: 0, width: 20, visual: 'start' },
        { x: 0, z: 100, yaw: 0, width: 20, visual: 'arch' },
        { x: 0, z: 180, yaw: 0, width: 20, visual: 'finish' }
    ]
};

const START = 100;

// A fresh course in every test (not the cached line), so the mutation run
// attributes the line and gate geometry to the tests that use it
function courseOf(track: TrackDef): Course {
    return createCourse(track, buildRacingLine(track));
}
const LINE_TOLERANCE = 0.01;   // the four 1 mm arcs

// Crosses gate k of the square from 1 m behind to 1 m past it in tick T;
// the fraction of the tick is 1/2
function crossSquareGate(p: RaceProgress, course: Course, k: number, tick: number): number {
    const g = SQUARE.gates[k];
    const fx = Math.sin(g.yaw), fz = Math.cos(g.yaw);
    return passGate(p, course, tick, START, g.x - fx, g.z - fz, g.x + fx, g.z + fz);
}

describe('laps and gate order', () => {
    it('counts laps from the crossings: circuit min(laps, floor((passed - 1)/n) + 1), sprint 1', () => {
        // n = 4, 2 laps
        expect([0, 1, 4, 5, 8, 9].map(passed => lapFor(SQUARE, passed))).toEqual([1, 1, 1, 2, 2, 2]);
        expect([0, 1, 2, 3].map(passed => lapFor(SPRINT, passed))).toEqual([1, 1, 1, 1]);
    });

    it('finishes after laps·n + 1 crossings on a circuit (the first starts lap 1) and n on a sprint', () => {
        expect(finishPassed(SQUARE)).toBe(9);
        expect(finishPassed(SPRINT)).toBe(3);
        expect([0, 3, 4, 5, 8, 9].map(passed => nextGateIndex(SQUARE, passed))).toEqual([0, 3, 0, 1, 0, -1]);
        expect([0, 2, 3].map(passed => nextGateIndex(SPRINT, passed))).toEqual([0, 2, -1]);
    });
});

describe('passGate', () => {
    let course = courseOf(SQUARE);
    beforeEach(() => { course = courseOf(SQUARE); });

    it('times the crossings, laps from start to the second start/finish crossing, then between them', () => {
        const p = createRaceProgress();
        // 1st crossing of G0 in tick 110 at t = 1/2: 110 - 1 + 0.5 - 100 = 9.5
        expect(crossSquareGate(p, course, 0, 110)).toBe(9.5);
        expect(p.lapTimes).toEqual([]);
        crossSquareGate(p, course, 1, 300);
        crossSquareGate(p, course, 2, 500);
        crossSquareGate(p, course, 3, 700);
        expect(p.lap).toBe(1);
        // Lap 1 counts from the start: 809.5
        expect(crossSquareGate(p, course, 0, 910)).toBe(809.5);
        expect(p.lapTimes).toEqual([809.5]);
        expect(p.lap).toBe(2);
        for (const [k, tick] of [[1, 1100], [2, 1300], [3, 1500]]) crossSquareGate(p, course, k, tick);
        expect(p.status).toBe('racing');
        // Lap 2: 1709.5 - 809.5 = 900, slower: the best lap stays lap 1
        expect(crossSquareGate(p, course, 0, 1810)).toBe(1709.5);
        expect(p.lapTimes).toEqual([809.5, 900]);
        expect(p.bestLap).toBe(809.5);
        expect(p.finishTicks).toBe(1709.5);
        expect(p.status).toBe('finished');
        expect(p.passed).toBe(9);
        expect(p.gateTimes).toHaveLength(9);
        // Nothing counts after the finish
        expect(crossSquareGate(p, course, 1, 1900)).toBe(-1);
    });

    it('keeps the faster of two laps as the best lap', () => {
        const p = createRaceProgress();
        for (const [k, tick] of [[0, 110], [1, 300], [2, 500], [3, 700], [0, 910], [1, 1000], [2, 1100], [3, 1200], [0, 1310]]) {
            crossSquareGate(p, course, k, tick);
        }
        // 809.5, then 1209.5 - 809.5 = 400
        expect(p.lapTimes).toEqual([809.5, 400]);
        expect(p.bestLap).toBe(400);
    });

    it('counts only the next gate: skipping one, or reversing over the line and back, gains nothing', () => {
        const p = createRaceProgress();
        crossSquareGate(p, course, 0, 110);
        expect(crossSquareGate(p, course, 2, 120)).toBe(-1);
        // Back over G0 and forwards again: G1 is next, not G0
        expect(passGate(p, course, 130, START, 0, 51, 0, 49)).toBe(-1);
        expect(crossSquareGate(p, course, 0, 140)).toBe(-1);
        expect(p.passed).toBe(1);
    });

    it('counts nothing for a racer out of the race (DNF, left)', () => {
        for (const status of ['dnf', 'left'] as const) {
            const p = { ...createRaceProgress(), status };
            expect(crossSquareGate(p, course, 0, 110)).toBe(-1);
            expect(p.passed).toBe(0);
        }
    });

    it('ends a sprint with the lap at the last gate', () => {
        const sprint = courseOf(SPRINT);
        const p = createRaceProgress();
        for (const [z, tick] of [[0, 150], [100, 400], [180, 700]]) passGate(p, sprint, tick, START, 0, z - 1, 0, z + 3);
        // t = 1/4 each: 700 - 1 + 0.25 - 100
        expect(p.finishTicks).toBe(599.25);
        expect(p.lapTimes).toEqual([599.25]);
        expect(p.status).toBe('finished');
    });

    it('skips the gate test in a tick with a teleport', () => {
        const p = createRaceProgress();
        expect(advanceProgress(p, course, 110, START, 0, 49, 0, 51, 0, 60, true)).toBe(-1);
        expect(p.passed).toBe(0);
        expect(advanceProgress(p, course, 111, START, 0, 49, 0, 51, 0, 60, false)).toBe(10.5);
        expect(p.passed).toBe(1);
    });
});

describe('trackLine', () => {
    let course = courseOf(SQUARE);
    beforeEach(() => { course = courseOf(SQUARE); });

    it('places the gates on the line: 50, 150, 250, 350 m; legs from the gate before', () => {
        course.gateS.forEach((s, k) => expect(s).toBeCloseTo(50 + 100 * k, 1));
        // Gate 0's leg comes round from gate 3 on a circuit
        course.legLength.forEach(leg => expect(leg).toBeCloseTo(100, 1));
        // A sprint's first leg starts where the line does, 20 m before the start
        const sprint = courseOf(SPRINT);
        expect(sprint.gateS).toEqual([20, 120, 200]);
        expect(sprint.legLength).toEqual([20, 100, 80]);
    });

    it('measures the remaining distance along the line, negative past the gate', () => {
        const p = createRaceProgress();
        trackLine(p, course, 0, 30, false);
        expect(p.remaining).toBeCloseTo(20, 1);
        // The windowed projection follows a car tick by tick (at most 80 m
        // from the last index); these jumps count as teleports
        crossSquareGate(p, course, 0, 110);
        // Round the corner: 50 m across to G1 from x = 0, 30 from x = 20
        trackLine(p, course, 20, 99, true);
        expect(p.remaining).toBeCloseTo(30, 1);
        expect(Math.abs(p.lineDist - 1)).toBeLessThan(LINE_TOLERANCE);
        // 20 m past G1 without crossing it: -20, not yet missed
        trackLine(p, course, 70, 100, false);
        expect(p.remaining).toBeCloseTo(-20, 1);
        expect(p.missedGate).toBe(false);
        // More than 30 m past it the gate counts as missed
        trackLine(p, course, 79, 100, false);
        expect(p.remaining).toBeCloseTo(-29, 1);
        expect(p.missedGate).toBe(false);
        trackLine(p, course, 81, 100, false);
        expect(p.remaining).toBeCloseTo(-31, 1);
        expect(p.missedGate).toBe(true);
        trackLine(p, course, 100, 90, false);
        expect(p.remaining).toBeCloseTo(-60, 1);
        expect(p.missedGate).toBe(true);
    });

    it('reads a car just behind the start/finish line on a later lap across the seam', () => {
        const p = createRaceProgress();
        for (const k of [0, 1, 2, 3]) crossSquareGate(p, course, k, 110 + k);
        // Next is G0 again; the car is on the last leg, 10 m before the corner (0,0)
        trackLine(p, course, 10, 0, false);
        expect(p.remaining).toBeCloseTo(60, 1);
    });

    it('measures the remaining distance on a sprint', () => {
        const sprint = courseOf(SPRINT);
        const p = createRaceProgress();
        // The line starts at z = -20: (0, 50) is at s = 70, gate 1 at s = 120
        passGate(p, sprint, 110, START, 0, -1, 0, 1);
        trackLine(p, sprint, 0, 50, false);
        expect(p.remaining).toBeCloseTo(50, 9);
        // (0, 130): s = 150, 30 m past gate 1
        trackLine(p, sprint, 0, 130, true);
        expect(p.remaining).toBeCloseTo(-30, 9);
    });

    it('takes the straight distance to the gate off the line (> 25 m)', () => {
        const p = createRaceProgress();
        trackLine(p, course, 30, 50, false);
        expect(p.lineDist).toBeCloseTo(30, 1);
        expect(p.remaining).toBe(30);
        expect(p.missedGate).toBe(false);
        // Off the line 40 m past the gate's place on it: no missed gate
        // (the projection says little that far out)
        trackLine(p, course, -30, 90, true);
        expect(p.lineDist).toBeCloseTo(30, 1);
        expect(p.sLine).toBeCloseTo(90, 1);
        expect(p.missedGate).toBe(false);
        // Next gate G1 at (50, 100): 40 m from (50, 60)
        crossSquareGate(p, course, 0, 110);
        trackLine(p, course, 50, 60, true);
        expect(p.remaining).toBeCloseTo(40, 12);
    });

    it('after a teleport finds the leg nearest the last progress, not the nearest leg', () => {
        const u: TrackDef = {
            ...SPRINT, centerline: [{ x: 0, z: 0 }, { x: 0, z: 100 }, { x: 40, z: 100 }, { x: 40, z: 0 }],
            gates: [{ x: 0, z: 10, yaw: 0, width: 20, visual: 'start' }, { x: 40, z: 10, yaw: Math.PI, width: 20, visual: 'finish' }]
        };
        const uCourse = courseOf(u);
        const p = createRaceProgress();
        trackLine(p, uCourse, 40, 40, false);
        expect(p.sLine).toBeCloseTo(200, 1);
        // Teleported to 18 m from the left leg, 22 m from the right one
        trackLine(p, uCourse, 18, 50, true);
        expect(p.sLine).toBeCloseTo(190, 1);
        // Without a last position the nearest leg wins
        const fresh = createRaceProgress();
        trackLine(fresh, uCourse, 18, 50, false);
        expect(fresh.sLine).toBeCloseTo(50, 1);
    });
});

describe('wrong way (10.1)', () => {
    let course = courseOf(SQUARE);
    beforeEach(() => { course = courseOf(SQUARE); });
    // A car on the first leg (tangent +z), next gate G0 50 m up
    function step(p: RaceProgress, z: number, vz: number, reset = false): void {
        advanceProgress(p, course, 1000, START, 0, z, 0, z, 0, vz, reset);
    }

    it('turns on after 60 ticks of driving against the line, and off after 30 the right way', () => {
        const p = createRaceProgress();
        for (let tick = 1; tick <= 59; tick++) step(p, 30, -10);
        expect(p.wrongWay).toBe(false);
        step(p, 30, -10);
        expect(p.wrongWay).toBe(true);
        // Rolling the right way below 4 m/s does not end it, nor driving
        // mostly across the line (v̂ · t̂ = 0.28 < 0.3)
        for (let tick = 1; tick <= 100; tick++) step(p, 30, 3.9);
        expect(p.wrongWay).toBe(true);
        for (let tick = 1; tick <= 100; tick++) advanceProgress(p, course, 1000, START, 0, 30, 0, 30, 9.6, 2.8, false);
        expect(p.wrongWay).toBe(true);
        for (let tick = 1; tick <= 29; tick++) step(p, 30, 10);
        expect(p.wrongWay).toBe(true);
        step(p, 30, 10);
        expect(p.wrongWay).toBe(false);
    });

    it('needs more than about 120° against the line (v̂ · t̂ < -0.5)', () => {
        const p = createRaceProgress();
        // v̂ · t̂ = -0.48
        for (let tick = 1; tick <= 100; tick++) advanceProgress(p, course, 1000, START, 0, 30, 0, 30, 8.772, -4.8, false);
        expect(p.wrongWay).toBe(false);
        // v̂ · t̂ = -0.52
        for (let tick = 1; tick <= 60; tick++) advanceProgress(p, course, 1000, START, 0, 30, 0, 30, 8.542, -5.2, false);
        expect(p.wrongWay).toBe(true);
    });

    it('needs the ticks in a row and ignores sideways driving (v̂ · t̂ = 0)', () => {
        const p = createRaceProgress();
        for (let tick = 1; tick <= 50; tick++) step(p, 30, -10);
        step(p, 30, 10);
        for (let tick = 1; tick <= 50; tick++) step(p, 30, -10);
        expect(p.wrongWay).toBe(false);
        for (let tick = 1; tick <= 100; tick++) advanceProgress(p, course, 1000, START, 0, 30, 0, 30, 10, 0, false);
        expect(p.wrongWay).toBe(false);
    });

    it('never below 4 m/s against the line', () => {
        const p = createRaceProgress();
        for (let tick = 1; tick <= 300; tick++) step(p, 30, -3.9);
        expect(p.wrongWay).toBe(false);
        for (let tick = 1; tick <= 60; tick++) step(p, 30, -4);
        expect(p.wrongWay).toBe(true);
    });

    it('turns on after falling back more than 25 m since the last gate, even without turning', () => {
        const p = createRaceProgress();
        step(p, 40, 0);
        // Pushed back 0.5 m per tick at speed 0: 25.5 m back at tick 51,
        // then 60 ticks in a row
        let tick = 0;
        for (tick = 1; tick <= 109; tick++) step(p, Math.max(10, 40 - 0.5 * tick), 0);
        expect(p.wrongWay).toBe(false);
        step(p, 10, 0);
        expect(p.wrongWay).toBe(true);
    });

    it('does not catch a car again that turned round behind its farthest point', () => {
        const p = createRaceProgress();
        step(p, 40, 0);
        for (let tick = 1; tick <= 200; tick++) step(p, 10, 0);
        expect(p.wrongWay).toBe(true);
        // Driving the right way again, still 30 m behind where it was
        for (let tick = 1; tick <= 30; tick++) step(p, 10, 5);
        expect(p.wrongWay).toBe(false);
        let caught = 0;
        for (let tick = 1; tick <= 200; tick++) {
            step(p, 10, 5);
            if (p.wrongWay) caught++;
        }
        expect(caught).toBe(0);
    });

    it('starts the backtrack measure afresh at every gate', () => {
        const p = createRaceProgress();
        // Up the first leg past G0 (z = 50) at 0.5 m per tick, then on to z = 90
        for (let tick = 0; tick <= 180; tick++) {
            const z = 5 + 0.5 * tick;
            advanceProgress(p, course, 200 + tick, START, 0, z - 0.5, 0, z, 0, 30, false);
            expect(p.wrongWay).toBe(false);
        }
        expect(p.passed).toBe(1);
    });

    it('ignores the distance fallen back while off the line', () => {
        const p = createRaceProgress();
        step(p, 40, 0);
        // In the middle of the square, 40 m from every leg: the straight
        // distance to G0 (40 m) would read as 30 m lost since z = 40
        for (let tick = 0; tick < 120; tick++) advanceProgress(p, course, 1000, START, 40, 50, 40, 50, 0, 0, false);
        expect(p.lineDist).toBeCloseTo(40, 1);
        expect(p.wrongWay).toBe(false);
    });

    it('ends with a reset', () => {
        const p = createRaceProgress();
        for (let tick = 1; tick <= 60; tick++) step(p, 30, -10);
        expect(p.wrongWay).toBe(true);
        step(p, 30, -10, true);
        expect(p.wrongWay).toBe(false);
        expect(p.wrongWayTicks).toBe(0);
        // A reset also forgets how far the car had got: standing 30 m behind
        // that point afterwards is no backtracking
        const q = createRaceProgress();
        step(q, 40, 0);
        for (let tick = 0; tick < 200; tick++) step(q, 10, 0);
        expect(q.wrongWay).toBe(true);
        step(q, 10, 0, true);
        for (let tick = 0; tick < 100; tick++) {
            step(q, 10, 0);
            expect(q.wrongWay).toBe(false);
        }
        updateWrongWay(p, course, 0, 1, 0, -10, false);
        expect(p.wrongWayTicks).toBe(1);
    });

    it('stops for a finished racer', () => {
        const p = createRaceProgress();
        for (let tick = 1; tick <= 60; tick++) step(p, 30, -10);
        p.status = 'finished';
        updateWrongWay(p, course, 0, 1, 0, -10, false);
        expect(p.wrongWay).toBe(false);
    });
});
