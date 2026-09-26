import { beforeEach, describe, expect, it } from 'vitest';
import {
    createProjection, lineDelta, pointAt, polylineFromPoints, projectGlobal, projectNear, roundCorners, samplePath
} from '../../../src/shared/race/geometry.js';

// Polylines of the race mode (docs/phase-2-design.md, 5.4). Expected values
// from plane geometry: a 90° corner rounded with radius R replaces two
// tangent pieces of length R by a quarter circle πR/2.

// Heading +z, then a left turn to +x (left of yaw 0 is +x)
const L_PATH = [{ x: 0, z: 0 }, { x: 0, z: 100 }, { x: 100, z: 100 }];

describe('roundCorners', () => {
    it('rounds a 90° corner with a quarter circle: arc πR/2, the path (2 - π/2)·R shorter', () => {
        const R = 24;
        const path = roundCorners(L_PATH, false, R);
        expect(path.pieces.map(p => p.kind)).toEqual(['line', 'arc', 'line']);
        const arc = path.pieces[1];
        expect(arc.length).toBeCloseTo(Math.PI * R / 2, 12);
        expect(path.length).toBeCloseTo(200 - (2 - Math.PI / 2) * R, 12);
        // Tangent points R before and after the vertex, centre R inside both legs
        const [first, , last] = path.pieces;
        if (first.kind !== 'line' || last.kind !== 'line' || arc.kind !== 'arc') throw new Error('line, arc, line');
        expect(first.x1).toBe(0);
        expect(first.z1).toBeCloseTo(76, 12);
        expect(last.x0).toBeCloseTo(24, 12);
        expect(last.z0).toBe(100);
        expect(arc.r).toBeCloseTo(R, 12);
        {
            expect(arc.cx).toBeCloseTo(24, 12);
            expect(arc.cz).toBeCloseTo(76, 12);
        }
        // A left turn for the car: the inside is on its left, the apex at
        // the arc's middle
        expect(path.corners).toEqual([{ s: 76 + Math.PI * R / 4, halfLength: Math.PI * R / 4, inside: 1 }]);
    });

    it('keeps a right turn on the right', () => {
        // Heading +z, then to -x: the right of yaw 0 is -x
        const path = roundCorners([{ x: 0, z: 0 }, { x: 0, z: 100 }, { x: -100, z: 100 }], false, 10);
        expect(path.corners[0].inside).toBe(-1);
        const arc = path.pieces[1];
        if (arc.kind !== 'arc') throw new Error('arc expected');
        expect(arc.cx).toBeCloseTo(-10, 12);
        expect(arc.cz).toBeCloseTo(90, 12);
    });

    it('limits the tangent length to half the shorter leg', () => {
        // Legs of 20 and 100 m (either way round): at most 10 m of each, so R = 10 at 90°
        for (const points of [
            [{ x: 0, z: 0 }, { x: 0, z: 20 }, { x: 100, z: 20 }],
            [{ x: 0, z: 0 }, { x: 0, z: 100 }, { x: 20, z: 100 }]
        ]) {
            const path = roundCorners(points, false, 24);
            const arc = path.pieces[1];
            expect(arc.kind === 'arc' && arc.r).toBeCloseTo(10, 12);
            expect(path.length).toBeCloseTo(120 - (2 - Math.PI / 2) * 10, 12);
        }
    });

    it('rejects paths that are too short or have a leg of no length', () => {
        expect(() => roundCorners([{ x: 0, z: 0 }], false, 5)).toThrow();
        expect(() => roundCorners([{ x: 0, z: 0 }, { x: 0, z: 10 }], true, 5)).toThrow();
        expect(() => roundCorners([{ x: 0, z: 0 }, { x: 0, z: 10 }, { x: 0, z: 10 }], false, 5)).toThrow();
        expect(roundCorners([{ x: 0, z: 0 }, { x: 0, z: 10 }], false, 5).length).toBe(10);
        expect(roundCorners([{ x: 0, z: 0 }, { x: 0, z: 10 }, { x: 10, z: 10 }], true, 5).corners).toHaveLength(3);
    });

    it('rounds every vertex of a closed path and starts at the first vertex\'s arc end', () => {
        // 100 m square: four quarter circles of R = 10
        const square = [{ x: 0, z: 0 }, { x: 0, z: 100 }, { x: 100, z: 100 }, { x: 100, z: 0 }];
        const path = roundCorners(square, true, 10);
        expect(path.corners).toHaveLength(4);
        expect(path.length).toBeCloseTo(400 - 4 * (2 - Math.PI / 2) * 10, 12);
        // The first piece leaves the first corner's arc, 10 m up the first leg
        const first = path.pieces[0];
        if (first.kind !== 'line') throw new Error('line expected');
        expect([first.x0, first.x1]).toEqual([0, 0]);
        expect(first.z0).toBeCloseTo(10, 12);
        expect(first.z1).toBeCloseTo(90, 12);
        // A straight vertex gets no arc
        expect(roundCorners([{ x: 0, z: 0 }, { x: 0, z: 50 }, { x: 0, z: 100 }], false, 10).pieces).toHaveLength(2);
    });
});

describe('samplePath', () => {
    it('resamples every 2 m and ends exactly at the end of an open path', () => {
        const line = samplePath(roundCorners([{ x: 0, z: 0 }, { x: 0, z: 101 }], false, 10));
        expect(line.points).toHaveLength(52);
        for (let i = 1; i < 51; i++) {
            expect(Math.abs(line.points[i].z - line.points[i - 1].z - 2)).toBeLessThan(1e-9);
        }
        expect(line.points[51].z).toBe(101);
        expect(line.length).toBeCloseTo(101, 12);
        expect(line.points.every(p => p.tx === 0 && p.tz === 1 && p.curvature === 0)).toBe(true);
    });

    it('puts the samples of an arc on the circle, with the curvature 1/R, + for a left turn', () => {
        const line = samplePath(roundCorners(L_PATH, false, 24));
        // Samples well inside the arc (s from 80 to 110)
        const inArc = line.points.filter(p => p.s > 80 && p.s < 110);
        expect(inArc.length).toBeGreaterThan(10);
        for (const p of inArc) {
            expect(Math.hypot(p.x - 24, p.z - 76)).toBeCloseTo(24, 9);
            expect(p.curvature).toBeCloseTo(1 / 24, 6);
        }
        const right = samplePath(roundCorners([{ x: 0, z: 0 }, { x: 0, z: 100 }, { x: -100, z: 100 }], false, 24));
        expect(right.points.find(p => p.s > 90)!.curvature).toBeCloseTo(-1 / 24, 6);
    });

    it('closes a loop: arc lengths rise, the last gap back to the start is at most 2 m', () => {
        const square = [{ x: 50, z: 0 }, { x: 50, z: 100 }, { x: 150, z: 100 }, { x: 150, z: 0 }];
        const path = roundCorners(square, true, 10);
        const line = samplePath(path);
        expect(line.closed).toBe(true);
        for (let i = 1; i < line.points.length; i++) expect(line.points[i].s).toBeGreaterThan(line.points[i - 1].s);
        // 382.83 m: samples at 0, 2, ..., 382, then 0.83 m back to the start
        expect(line.points).toHaveLength(192);
        const last = line.points[line.points.length - 1];
        const gap = Math.hypot(last.x - line.points[0].x, last.z - line.points[0].z);
        // (a chord of the last arc: 0.24 mm short of its 0.83 m arc length)
        expect(gap).toBeCloseTo(path.length - 382, 3);
        expect(line.points[0]).toMatchObject({ x: 50, s: 0 });
        expect(line.length).toBeCloseTo(last.s + gap, 12);
        // Chords cut the arcs a little: 2 - 2R·sin(1/R) = 3.3 mm per 2 m chord
        // at R = 10, about 31 chords on the four arcs
        const shortfall = 400 - 4 * (2 - Math.PI / 2) * 10 - line.length;
        expect(shortfall).toBeGreaterThan(0);
        expect(shortfall).toBeLessThan(0.12);
    });

    it('bends the samples out of a corner by the out-in-out shape over two half arcs', () => {
        const R = 24, A = 2, W = 6 * Math.PI;
        const line = samplePath(roundCorners(L_PATH, false, R), 0.5, A);
        // Sample 133 (s = 66.5) lies 1.5 half arcs before the apex: on the
        // straight, A·cos²(π·(d - W)/2W) to the outside (the car's right, -x)
        const d = 76 + W - 66.5;
        const c = Math.cos(Math.PI * (d - W) / (2 * W));
        expect(line.points[133].x).toBeCloseTo(-A * c * c, 12);
        expect(line.points[133].z).toBe(66.5);
    });

    it('shifts out-in-out: apexShift inside at the apex, outside where the arc starts, none far away', () => {
        const R = 24, A = 2;
        const line = samplePath(roundCorners(L_PATH, false, R), 0.5, A);
        const at = (s: number) => line.points.find(p => Math.abs(p.s - s) < 0.3)!;
        // Arc start at s = 76 (index 152 at 0.5 m): A to the outside, i.e.
        // R + A from the arc's centre (24, 76)
        const start = line.points[152];
        expect(Math.hypot(start.x - 24, start.z - 76)).toBeCloseTo(R + A, 9);
        // Sample k lies at 0.5·k along the rounded path. Near the apex (arc
        // middle at 76 + 6π ≈ 94.85, sample 190): A·cos(π·d/6π) inside
        const R_A = (k: number) => Math.hypot(line.points[k].x - 24, line.points[k].z - 76);
        expect(R_A(190)).toBeCloseTo(R - A * Math.cos(Math.PI * (95 - 76 - 6 * Math.PI) / (6 * Math.PI)), 9);
        // Near the arc's end (76 + 12π ≈ 113.70, sample 227): outside again
        expect(R_A(227)).toBeCloseTo(R - A * Math.cos(Math.PI * (113.5 - 76 - 6 * Math.PI) / (6 * Math.PI)), 9);
        let nearest = Infinity;
        for (const p of line.points) nearest = Math.min(nearest, Math.hypot(p.x - 24, p.z - 76));
        expect(nearest).toBeGreaterThan(R - A - 1e-9);
        // More than two half arcs (2 · 6π ≈ 37.7 m) before the apex: on the centre line
        expect(at(50).x).toBe(0);
    });
});

describe('projection', () => {
    // A U: up x = 0, across, down x = 40. Two parallel legs 40 m apart
    // Built inside each test (see racingLine.test.ts)
    const makeU = () => samplePath(roundCorners([{ x: 0, z: 0 }, { x: 0, z: 100 }, { x: 40, z: 100 }, { x: 40, z: 0 }], false, 5));
    let U = makeU();
    beforeEach(() => { U = makeU(); });
    const nearestIndex = (x: number, z: number) => {
        let best = -1, bestD = Infinity;
        U.points.forEach((p, i) => {
            const d = Math.hypot(p.x - x, p.z - z);
            if (d < bestD) { bestD = d; best = i; }
        });
        return best;
    };
    const onLeftLeg = (z: number) => nearestIndex(0, z);
    const onRightLeg = (z: number) => nearestIndex(40, z);

    it('stays on the leg of the hint, even when the other leg is nearer', () => {
        const out = createProjection();
        // 18 m from the left leg, 22 m from the right one
        projectNear(U, 18, 50, onRightLeg(50), out);
        expect(out.x).toBeCloseTo(40, 12);
        expect(out.z).toBeCloseTo(50, 12);
        expect(out.dist).toBeCloseTo(22, 12);
        // The right leg runs towards -z
        expect([out.tx, out.tz]).toEqual([0, -1]);
        projectNear(U, 18, 50, onLeftLeg(50), out);
        expect(out.x).toBe(0);
        expect(out.dist).toBeCloseTo(18, 12);
        expect(out.s).toBeCloseTo(50, 12);
    });

    it('searches globally for the nearest point, or for the one nearest the expected progress', () => {
        const out = createProjection();
        projectGlobal(U, 18, 50, out);
        expect(out.x).toBe(0);
        const sRight = U.points[onRightLeg(50)].s;
        projectGlobal(U, 18, 50, out, sRight + 3);
        expect(out.x).toBeCloseTo(40, 12);
        expect(out.z).toBeCloseTo(50, 9);
        // Within one 2 m sample of the nearest sample's arc length
        expect(Math.abs(out.s - sRight)).toBeLessThan(1);
        // The other way round: nearer the right leg, expected on the left one
        projectGlobal(U, 22, 50, out, U.points[onLeftLeg(50)].s - 3);
        expect(out.x).toBe(0);
        expect(out.z).toBeCloseTo(50, 9);
        // Beyond OFF_LINE_DISTANCE (25 m) of both legs the expectation plays no part
        projectGlobal(U, 20, -30, out, sRight);
        expect(out.x).toBe(0);
    });

    it('takes the nearest point of the expected leg on a closed line too, not any point near the expectation', () => {
        // 40 × 100 loop: up x = 0 (s 0..100), across, down x = 40 (s 140..240), back
        const loop = polylineFromPoints(
            Array.from({ length: 50 }, (_, i) => ({ x: 0, z: 2 * i }))
                .concat(Array.from({ length: 20 }, (_, i) => ({ x: 2 * i, z: 100 })))
                .concat(Array.from({ length: 50 }, (_, i) => ({ x: 40, z: 100 - 2 * i })))
                .concat(Array.from({ length: 20 }, (_, i) => ({ x: 40 - 2 * i, z: 0 }))),
            true
        );
        expect(loop.length).toBe(280);
        const out = createProjection();
        // Expected 20 m further down the right leg than the point: still its
        // nearest point on that leg
        projectGlobal(loop, 18, 50, out, 210);
        expect([out.x, out.z, out.s]).toEqual([40, 50, 190]);
        projectGlobal(loop, 18, 50, out, 170);
        expect([out.x, out.z, out.s]).toEqual([40, 50, 190]);
        projectGlobal(loop, 22, 50, out, 70);
        expect([out.x, out.z, out.s]).toEqual([0, 50, 50]);
        // Ahead (the next gate): the first leg forward from 250 m, across the
        // seam at 280 m, is the left one (80 m on), not the right one 60 m
        // back that the plain expectation takes
        projectGlobal(loop, 22, 50, out, 250);
        expect([out.x, out.z, out.s]).toEqual([40, 50, 190]);
        projectGlobal(loop, 22, 50, out, 250, true);
        expect([out.x, out.z, out.s]).toEqual([0, 50, 50]);
        // From 170 m the right leg's point (190 m) is next; from 200 m on it
        // lies behind, and the left one comes 130 m on
        projectGlobal(loop, 22, 50, out, 170, true);
        expect([out.x, out.z, out.s]).toEqual([40, 50, 190]);
        projectGlobal(loop, 22, 50, out, 200, true);
        expect([out.x, out.z, out.s]).toEqual([0, 50, 50]);
    });

    it('takes the first leg ahead of the expectation on an open line, never one behind', () => {
        // Up x = 0 (s 0..100), across (100..120), down x = 20 (120..220).
        // The point (9.5 | 50) is 9.5 m from the up leg (s = 50) and 10.5 m
        // from the down leg (s = 170): the nearest leg is behind an
        // expectation of 60, so ahead takes the down leg
        const hairpin = polylineFromPoints([{ x: 0, z: 0 }, { x: 0, z: 100 }, { x: 20, z: 100 }, { x: 20, z: 0 }], false);
        const out = createProjection();
        projectGlobal(hairpin, 9.5, 50, out, 60, true);
        expect([out.x, out.z, out.s]).toEqual([20, 50, 170]);
        // Without ahead the expectation takes the leg 10 m back
        projectGlobal(hairpin, 9.5, 50, out, 60);
        expect([out.x, out.z, out.s]).toEqual([0, 50, 50]);
        // From 40 the up leg itself lies 10 m ahead
        projectGlobal(hairpin, 9.5, 50, out, 40, true);
        expect([out.x, out.z, out.s]).toEqual([0, 50, 50]);
    });

    it('never wraps the window of an open line round to its other end', () => {
        const out = createProjection();
        // At the bottom of the right leg, hint at the very start of the left
        // leg: the window reaches 80 m up the left leg only
        projectNear(U, 40, 5, 0, out);
        expect(out.x).toBe(0);
        expect(out.z).toBeCloseTo(5, 12);
        // A hint beyond the line's end falls back to the global search
        projectNear(U, 40, 5, 10_000, out);
        expect(out.x).toBeCloseTo(40, 12);
        expect(out.dist).toBeCloseTo(0, 12);
    });

    it('clamps to the ends of an open line', () => {
        const out = createProjection();
        projectGlobal(U, 0, -10, out);
        expect([out.x, out.z, out.s, out.dist]).toEqual([0, 0, 0, 10]);
    });

    it('measures signed distances along a closed line the short way round', () => {
        const loop = polylineFromPoints([{ x: 0, z: 0 }, { x: 0, z: 10 }, { x: 10, z: 10 }, { x: 10, z: 0 }], true);
        expect(loop.length).toBe(40);
        expect(lineDelta(loop, 35, 5)).toBe(10);
        expect(lineDelta(loop, 5, 35)).toBe(-10);
        expect(lineDelta(loop, 0, 20)).toBe(-20);
        const open = polylineFromPoints([{ x: 0, z: 0 }, { x: 0, z: 10 }], false);
        expect(lineDelta(open, 8, 2)).toBe(-6);
    });

    it('finds the nearest segment of a closed line across the seam', () => {
        const loop = polylineFromPoints([{ x: 0, z: 0 }, { x: 0, z: 10 }, { x: 10, z: 10 }, { x: 10, z: 0 }], true);
        const out = createProjection();
        // On the closing segment (10, 0) -> (0, 0), 4 m from its start
        projectNear(loop, 6, -1, 0, out, 1);
        expect([out.index, out.x, out.z, out.dist]).toEqual([3, 6, 0, 1]);
        expect(out.s).toBe(34);
        // The end of the closing segment is the start: s = 0, not 40
        projectNear(loop, -0.5, -1, 3, out, 0);
        expect([out.index, out.x, out.z, out.s]).toEqual([3, 0, 0, 0]);
    });
});

describe('pointAt', () => {
    // Legs of 10, 10 and 10 m (open), plus the 10 m back (closed)
    const corners = [{ x: 0, z: 0 }, { x: 0, z: 10 }, { x: 10, z: 10 }, { x: 10, z: 0 }];

    it('walks the arc length along an open line and clamps at its ends', () => {
        const line = polylineFromPoints(corners, false);
        const out = createProjection();
        pointAt(line, 4, out);
        expect([out.index, out.x, out.z, out.s, out.tx, out.tz, out.dist]).toEqual([0, 0, 4, 4, 0, 1, 0]);
        pointAt(line, 15, out);
        expect([out.index, out.x, out.z, out.tx, out.tz]).toEqual([1, 5, 10, 1, 0]);
        // Exactly on a corner: the start of the next segment
        pointAt(line, 20, out);
        expect([out.index, out.x, out.z]).toEqual([2, 10, 10]);
        pointAt(line, -3, out);
        expect([out.x, out.z, out.s]).toEqual([0, 0, 0]);
        pointAt(line, 99, out);
        expect([out.index, out.x, out.z, out.s]).toEqual([2, 10, 0, 30]);
    });

    it('wraps round a closed line, onto its closing segment', () => {
        const loop = polylineFromPoints(corners, true);
        const out = createProjection();
        pointAt(loop, 34, out);
        expect([out.index, out.x, out.z, out.tx, out.tz]).toEqual([3, 6, 0, -1, 0]);
        pointAt(loop, 44, out);
        expect([out.x, out.z, out.s]).toEqual([0, 4, 4]);
        // 6 m before the start: 4 m along the closing segment from (10, 0)
        pointAt(loop, -6, out);
        expect([out.x, out.z]).toEqual([6, 0]);
    });
});
