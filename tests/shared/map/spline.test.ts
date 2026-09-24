import { describe, expect, it } from 'vitest';
import { buildRoadNetwork } from '../../../src/shared/map/roadNetwork.js';
import {
    catmullRomChain, catmullRomSegment, cubic, evalCubic, leftNormal, pointAt, sampleSegments,
    type CurvePoint
} from '../../../src/shared/map/spline.js';
import { edge, network, node } from './fixtures.js';

// Road centre lines (docs/phase-3-design.md, 5.3). Expected values come from
// geometry: straight lines, circles and a hand-worked Catmull-Rom segment.

const R = 100;
// Point at angle a (deg) on a circle of radius R that starts at the origin
// heading east (+x) and turns left towards north (-z)
function onCircle(a: number): [number, number] {
    const t = a * Math.PI / 180;
    return [R * Math.sin(t), -R * (1 - Math.cos(t))];
}

describe('leftNormal', () => {
    it('points west for a car looking north (design E2)', () => {
        const [x, z] = leftNormal(0, -1);
        expect(x).toBe(-1);
        expect(z === 0).toBe(true);
        // Looking east, north (-z) is on the left
        expect(leftNormal(1, 0)).toEqual([0, -1]);
    });
});

describe('catmullRomSegment (centripetal)', () => {
    it('has handles at a third and two thirds for evenly spaced collinear points', () => {
        const seg = catmullRomSegment([0, 0], [10, 0], [20, 0], [30, 0]);
        expect(seg.c1x).toBeCloseTo(10 + 10 / 3, 12);
        expect(seg.c2x).toBeCloseTo(20 - 10 / 3, 12);
        expect(seg.c1z).toBe(0);
        expect(seg.c2z).toBe(0);
    });

    it('passes through its two inner points', () => {
        const seg = catmullRomSegment([0, 0], [7, 3], [15, -4], [22, 9]);
        const p: CurvePoint = { x: 0, z: 0, dx: 0, dz: 0, ddx: 0, ddz: 0 };
        evalCubic(seg, 0, p);
        expect([p.x, p.z]).toEqual([7, 3]);
        evalCubic(seg, 1, p);
        expect(p.x).toBeCloseTo(15, 12);
        expect(p.z).toBeCloseTo(-4, 12);
    });
});

describe('evalCubic', () => {
    // p0 (1, 2), c1 (4, 6), c2 (7, 3), p1 (10, 8)
    const seg = cubic([1, 2], [4, 6], [7, 3], [10, 8]);
    const p: CurvePoint = { x: 0, z: 0, dx: 0, dz: 0, ddx: 0, ddz: 0 };

    it('gives position and derivatives at the start: B = p0, B\' = 3(c1 - p0), B\'\' = 6(c2 - 2c1 + p0)', () => {
        evalCubic(seg, 0, p);
        expect([p.x, p.z, p.dx, p.dz, p.ddx, p.ddz]).toEqual([1, 2, 9, 12, 0, -42]);
    });

    it('gives position and derivatives in the middle', () => {
        evalCubic(seg, 0.5, p);
        // B(½) = (p0 + 3c1 + 3c2 + p1)/8 = (44, 37)/8
        expect(p.x).toBe(5.5);
        expect(p.z).toBe(4.625);
        // B'(½) = ¾(c1 - p0) + 1½(c2 - c1) + ¾(p1 - c2) = (9, 2.25)
        expect(p.dx).toBe(9);
        expect(p.dz).toBe(2.25);
        // B''(½) = 3(c2 - 2c1 + p0) + 3(p1 - 2c2 + c1) = (0, 3·(-7) + 3·8)
        expect(p.ddx).toBe(0);
        expect(p.ddz).toBe(3);
    });
});

describe('sampleSegments', () => {
    it('follows a straight line through unevenly spaced points at exactly 1 m', () => {
        const { samples, length } = sampleSegments(catmullRomChain([[0, 0], [4, 0], [25, 0]]));
        expect(length).toBeCloseTo(25, 6);
        expect(samples).toHaveLength(26);
        samples.forEach((p, i) => {
            expect(p.s).toBe(i);
            expect(p.x).toBeCloseTo(i, 3);
            expect(p.z).toBe(0);
            expect(p.tx).toBeCloseTo(1, 12);
            expect(p.curvature).toBeCloseTo(0, 12);
        });
    });

    it('resamples to another step length', () => {
        const { samples } = sampleSegments(catmullRomChain([[0, 0], [2.25, 0]]), 0.5);
        expect(samples.map(p => p.s)).toEqual([0, 0.5, 1, 1.5, 2, 2.25]);
        expect(samples[3].x).toBeCloseTo(1.5, 9);
    });

    it('ends with a shorter last piece at the full length', () => {
        const { samples, length } = sampleSegments(catmullRomChain([[0, 0], [0, 7.5]]));
        expect(length).toBeCloseTo(7.5, 9);
        expect(samples.map(p => p.s)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, length]);
        expect(samples[8].z).toBeCloseTo(7.5, 9);
        // Heading south (+z)
        expect(samples[3].tz).toBeCloseTo(1, 12);
    });

    it('measures a Bézier quarter circle as π·R/2 with curvature 1/R, turning left', () => {
        const k = 0.5522847498;
        const { samples, length } = sampleSegments([cubic([0, 0], [k * R, 0], [R, -R + k * R], [R, -R])]);
        // The standard Bézier circle deviates by < 0.03 % in radius
        expect(Math.abs(length / (Math.PI * R / 2) - 1)).toBeLessThan(0.001);
        // Its curvature is not constant: at the ends, with B'(0) = 3kR·(1, 0)
        // and B''(0) = 6R·(1 - 2k, k - 1), κ = (x''z' - z''x')/|B'|³
        // = (2/3)(1 - k)/(k²R) ≈ 0.979/R; in between it stays within 1 % of 1/R
        expect(samples[0].curvature).toBeCloseTo((2 / 3) * (1 - k) / (k * k * R), 12);
        for (const p of samples) expect(p.curvature).toBeGreaterThan(0.97 / R);
        for (const p of samples) expect(p.curvature).toBeLessThan(1.01 / R);
        // Spacing along the curve: chords of 1 m arcs, 1 m within 1 mm
        for (let i = 1; i < samples.length - 1; i++) {
            const a = samples[i - 1], b = samples[i];
            expect(Math.abs(Math.hypot(b.x - a.x, b.z - a.z) - 1)).toBeLessThan(0.001);
        }
    });

    it('turns right with negative curvature', () => {
        const k = 0.5522847498;
        // Heading east, turning towards south (+z)
        const { samples } = sampleSegments([cubic([0, 0], [k * R, 0], [R, R - k * R], [R, R])]);
        expect(samples[40].curvature).toBeLessThan(-0.99 / R);
        expect(samples[40].curvature).toBeGreaterThan(-1.01 / R);
    });

    it('measures a Catmull-Rom quarter circle through 4 points as π·R/2 ± 0.5 % (neighbours on the circle)', () => {
        const points = [0, 30, 60, 90].map(onCircle);
        const { length } = sampleSegments(catmullRomChain(points, onCircle(-30), onCircle(120)));
        expect(Math.abs(length / (Math.PI * R / 2) - 1)).toBeLessThan(0.005);
    });

    it('measures a Catmull-Rom quarter circle through 7 points with mirrored ends as π·R/2 ± 0.1 %', () => {
        const points = [0, 15, 30, 45, 60, 75, 90].map(onCircle);
        const { length } = sampleSegments(catmullRomChain(points));
        expect(Math.abs(length / (Math.PI * R / 2) - 1)).toBeLessThan(0.001);
    });
});

describe('pointAt', () => {
    // Built inside each test, not while collecting them: Stryker only
    // activates a mutant while a test runs
    const line = () => {
        const { samples } = sampleSegments(catmullRomChain([[0, 0], [10, 0]]));
        return { samples };
    };

    it('interpolates tangent and curvature on a circle, the tangent of unit length', () => {
        const { samples } = line();
        const k = 0.5522847498;
        const arc = sampleSegments([cubic([0, 0], [k * R, 0], [R, -R + k * R], [R, -R])]).samples;
        const p = pointAt(arc, 10.5);
        const a = arc[10], b = arc[11];
        // Halfway between two samples of a circle: the chord's midpoint, and
        // the mean of the end tangents points along the chord
        expect(p.x).toBeCloseTo((a.x + b.x) / 2, 12);
        expect(p.z).toBeCloseTo((a.z + b.z) / 2, 12);
        const chord = Math.hypot(b.x - a.x, b.z - a.z);
        expect(p.tx).toBeCloseTo((b.x - a.x) / chord, 5);
        expect(p.tz).toBeCloseTo((b.z - a.z) / chord, 5);
        expect(Math.hypot(p.tx, p.tz)).toBeCloseTo(1, 12);
        // Heading turned left by about s/R = 0.105 rad from east (the Bézier
        // circle starts with 0.979/R, so about 1 % less)
        expect(Math.atan2(-p.tz, p.tx)).toBeCloseTo(10.5 / R, 2);
        expect(p.curvature).toBeGreaterThan(0.97 / R);
        expect(p.curvature).toBeLessThan(1.01 / R);
    });

    it('finds the shorter last piece', () => {
        const { samples } = line();
        const short = sampleSegments(catmullRomChain([[0, 0], [0, 7.5]])).samples;
        expect(pointAt(short, 7.25).z).toBeCloseTo(7.25, 9);
        expect(pointAt(short, 6.5).z).toBeCloseTo(6.5, 9);
    });

    it('interpolates between samples and clamps to the ends', () => {
        const { samples } = line();
        expect(pointAt(samples, 2.25).x).toBeCloseTo(2.25, 9);
        expect(pointAt(samples, 2.25).s).toBe(2.25);
        expect(pointAt(samples, -3).x).toBe(0);
        expect(pointAt(samples, 99).x).toBeCloseTo(10, 9);
    });
});

describe('joints (C1 continuity)', () => {
    // Two edges bending through the node m at (100, 0)
    const build = (kind: 'joint' | 'junction') => buildRoadNetwork(network(
        [node('a', 0, 0), node('m', 100, 0, kind), node('b', 180, 60)],
        [edge('left', 'a', 'm', [[50, -10]]), edge('right', 'm', 'b', [[140, 10]])]
    ));
    const angle = (net: ReturnType<typeof build>) => {
        const left = net.edgeById.get('left')!.samples;
        const right = net.edgeById.get('right')!.samples;
        const a = left[left.length - 1], b = right[0];
        return Math.acos(Math.min(1, a.tx * b.tx + a.tz * b.tz)) * 180 / Math.PI;
    };

    it('has the same tangent on both sides of a joint (< 0.1°)', () => {
        const net = build('joint');
        expect(angle(net)).toBeLessThan(0.1);
        expect(net.issues).toEqual([]);
    });

    it('kinks at a junction, where the ends run straight into the node', () => {
        // Guards the test above: the same geometry without phantom points
        // kinks by more than the 1° the network tolerates at a joint
        expect(angle(build('junction'))).toBeGreaterThan(1);
    });

    it('is also smooth when the neighbouring edge points the other way', () => {
        const net = buildRoadNetwork(network(
            [node('a', 0, 0), node('m', 100, 0, 'joint'), node('b', 180, 60)],
            [edge('left', 'a', 'm', [[50, -10]]), edge('back', 'b', 'm', [[140, 10]])]
        ));
        const left = net.edgeById.get('left')!.samples;
        const back = net.edgeById.get('back')!.samples;
        const a = left[left.length - 1], b = back[back.length - 1];
        // Arriving along both edges at m: opposite directions
        const deg = Math.acos(Math.max(-1, Math.min(1, -(a.tx * b.tx + a.tz * b.tz)))) * 180 / Math.PI;
        expect(deg).toBeLessThan(0.1);
    });

    it('is smooth next to an edge without support points (the phantom is its far node)', () => {
        const net = buildRoadNetwork(network(
            [node('a', 0, 0), node('m', 100, 0, 'joint'), node('b', 200, 40)],
            [edge('left', 'a', 'm', [[50, -10]]), edge('plain', 'm', 'b')]
        ));
        const left = net.edgeById.get('left')!.samples;
        const plain = net.edgeById.get('plain')!.samples;
        const a = left[left.length - 1], b = plain[0];
        expect(Math.acos(Math.min(1, a.tx * b.tx + a.tz * b.tz)) * 180 / Math.PI).toBeLessThan(0.1);
        expect(net.issues).toEqual([]);
    });

    it('reports a joint between Bézier edges whose handles are not collinear', () => {
        const net = buildRoadNetwork(network(
            [node('a', 0, 0), node('m', 100, 0, 'joint'), node('b', 200, 0)],
            [
                { ...edge('l', 'a', 'm'), curve: { type: 'bezier', segments: [{ c1: [30, 0], c2: [70, 0] }] } },
                { ...edge('r', 'm', 'b'), curve: { type: 'bezier', segments: [{ c1: [130, 20], c2: [170, 0] }] } }
            ]
        ));
        expect(net.issues).toHaveLength(1);
        expect(net.issues[0]).toMatch(/node m/);
    });
});
