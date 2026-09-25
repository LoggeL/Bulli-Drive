import { describe, expect, it } from 'vitest';
import {
    circleVsSegment, networkRailColliders, RAIL_MAX_SAGITTA, RAIL_RADIUS, RAIL_TOP, railColliders,
    railLine, simplifyPolyline, type SegmentCollider
} from '../../../src/shared/map/rails.js';
import { buildRoadNetwork } from '../../../src/shared/map/roadNetwork.js';
import type { RailRange } from '../../../src/shared/map/roadSchema.js';
import { edge, network, node } from './fixtures.js';

// Guard rails as capsule chains (docs/phase-3-design.md, 5.5 and 8.2)

// 100 m road heading east, 10 m wide
// Built inside each test, not while collecting them: Stryker only
// activates a mutant while a test runs
const build = () => {
    const straightNet = buildRoadNetwork(network(
        [node('w', 0, 0), node('e', 100, 0)],
        [edge('main', 'w', 'e', [], { rails: [
            { side: 'right', from: 10, to: 30, kind: 'wbeam' },
            { side: 'left', from: 0, to: -1, kind: 'fence', offset: 1 }
        ] })]
    ));
    const main = straightNet.edgeById.get('main')!;
    return { straightNet, main };
};

describe('railLine', () => {
    it('runs beside the road edge plus the offset, on the given side', () => {
        const { main } = build();
        const right = railLine(main, main.def.rails![0]);
        // Heading east the right side is south (+z): 5 m half width + 0.5 m
        expect(right[0][0]).toBeCloseTo(10, 9);
        expect(right[0][1]).toBeCloseTo(5.5, 9);
        expect(right[right.length - 1][0]).toBeCloseTo(30, 9);
        expect(right).toHaveLength(21);
        const left = railLine(main, main.def.rails![1]);
        expect(left[0][1]).toBeCloseTo(-6, 9);
        expect(left[left.length - 1][0]).toBeCloseTo(100, 9);
    });
});

describe('railColliders', () => {
    it('splits a straight rail into 8 m capsules', () => {
        const { main } = build();
        const full: RailRange = { side: 'right', from: 0, to: -1, kind: 'wbeam' };
        const colliders = railColliders(main, full);
        // 100 m: twelve pieces of 8 m and one of 4 m
        expect(colliders).toHaveLength(13);
        expect(colliders[0]).toMatchObject({ kind: 'segment', r: RAIL_RADIUS, top: RAIL_TOP });
        expect(colliders[0].ax).toBeCloseTo(0, 9);
        expect(colliders[0].bx).toBeCloseTo(8, 9);
        expect(colliders[12].bx).toBeCloseTo(100, 9);
        // Consecutive pieces share their ends: no gap to slip through
        for (let i = 1; i < colliders.length; i++) {
            expect(colliders[i].ax).toBe(colliders[i - 1].bx);
            expect(colliders[i].az).toBe(colliders[i - 1].bz);
        }
    });

    it('makes fences impossible to jump', () => {
        const { straightNet } = build();
        expect(networkRailColliders(straightNet).at(-1)!.top).toBe(Infinity);
        // Both rails of the edge, the right one first
        expect(networkRailColliders(straightNet)[0].ax).toBeCloseTo(10, 9);
    });

    it('keeps the capsules within 5 cm of a rail around a 15 m hairpin', () => {
        const R = 15;
        const k = 0.5522847498 * R;
        // Half circle to the left: east, north, west
        const net = buildRoadNetwork(network([node('a', 0, 0), node('m', R, -R, 'joint'), node('b', 0, -2 * R)], [
            { ...edge('in', 'a', 'm'), curve: { type: 'bezier', segments: [{ c1: [k, 0], c2: [R, -R + k] }] } },
            { ...edge('out', 'm', 'b'), curve: { type: 'bezier', segments: [{ c1: [R, -R - k], c2: [k, -2 * R] }] } }
        ]));
        const rail: RailRange = { side: 'right', from: 0, to: -1, kind: 'wbeam' };
        const inner = net.edgeById.get('in')!;
        const line = railLine(inner, rail);
        const colliders = railColliders(inner, rail);
        // Outer rail radius 15 + 5.5 = 20.5: an 8 m chord would bulge 0.39 m
        expect(colliders.length).toBeGreaterThan(Math.ceil(inner.length / 8));
        // The sagitta plus the rounding of the ends to millimetres
        for (const [x, z] of line) {
            const nearest = Math.min(...colliders.map(c => distanceToSegment(x, z, c)));
            expect(nearest).toBeLessThanOrEqual(RAIL_MAX_SAGITTA + 0.001);
        }
    });

    it('rounds every collider end to whole millimetres (the hash sees no stray last bits)', () => {
        const R = 15;
        const k = 0.5522847498 * R;
        const net = buildRoadNetwork(network([node('a', 0.123456, 0), node('b', R, -R)], [
            { ...edge('in', 'a', 'b'), curve: { type: 'bezier', segments: [{ c1: [k, 0], c2: [R, -R + k] }] } }
        ]));
        const colliders = railColliders(net.edgeById.get('in')!, { side: 'left', from: 0, to: -1, kind: 'wbeam' });
        expect(colliders.length).toBeGreaterThan(2);
        for (const c of colliders) {
            for (const v of [c.ax, c.az, c.bx, c.bz]) expect(Math.abs(v * 1000 - Math.round(v * 1000))).toBeLessThan(1e-6);
        }
    });
});

function distanceToSegment(x: number, z: number, c: SegmentCollider): number {
    const ex = c.bx - c.ax, ez = c.bz - c.az;
    const t = Math.max(0, Math.min(1, ((x - c.ax) * ex + (z - c.az) * ez) / (ex * ex + ez * ez)));
    return Math.hypot(x - c.ax - t * ex, z - c.az - t * ez);
}

describe('simplifyPolyline', () => {
    it('keeps corners and merges straight runs up to the maximum length', () => {
        const points: [number, number][] = [[0, 0], [1, 0], [2, 0], [3, 0], [3, 1], [3, 2]];
        expect(simplifyPolyline(points, 10, 0.01)).toEqual([[0, 3], [3, 5]]);
        expect(simplifyPolyline(points, 2, 0.01)).toEqual([[0, 2], [2, 3], [3, 5]]);
    });
});

describe('circleVsSegment', () => {
    const seg: SegmentCollider = { kind: 'segment', ax: 0, az: 0, bx: 10, bz: 0, r: 0.15, top: 0.8 };

    it('pushes a circle out perpendicular to the segment', () => {
        const hit = circleVsSegment(5, 1, 1, seg)!;
        expect(hit.pen).toBeCloseTo(0.15, 12);
        expect(hit.nx).toBe(0);
        expect(hit.nz).toBe(1);
    });

    it('treats the ends as round caps', () => {
        const hit = circleVsSegment(10.5, 0, 1, seg)!;
        expect(hit.pen).toBeCloseTo(0.65, 12);
        expect(hit.nx).toBe(1);
        const diagonal = circleVsSegment(10.6, 0.8, 1, seg)!;
        // Distance 1 to the end point: pen = 1.15 - 1
        expect(diagonal.pen).toBeCloseTo(0.15, 12);
        expect(diagonal.nx).toBeCloseTo(0.6, 12);
        expect(diagonal.nz).toBeCloseTo(0.8, 12);
    });

    it('misses beyond radius plus capsule radius', () => {
        expect(circleVsSegment(5, 1.15, 1, seg)).toBeNull();
        expect(circleVsSegment(12, 0, 1, seg)).toBeNull();
        expect(circleVsSegment(5, 1.149, 1, seg)).not.toBeNull();
    });

    it('leaves along the left normal from a centre exactly on the segment', () => {
        // Segment heading east: left is north (-z)
        const hit = circleVsSegment(4, 0, 1, seg)!;
        expect(hit.pen).toBeCloseTo(1.15, 12);
        expect(hit.nx === 0).toBe(true);
        expect(hit.nz).toBe(-1);
    });
});
