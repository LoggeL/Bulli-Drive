import { describe, expect, it } from 'vitest';
import {
    areaRailColliders, areaRailLine, circleVsSegment, networkRailColliders, RAIL_MAX_SAGITTA, RAIL_RADIUS, RAIL_TOP, railColliders,
    railLine, simplifyPolyline, type SegmentCollider
} from '../../../src/shared/map/rails.js';
import { buildRoadNetwork } from '../../../src/shared/map/roadNetwork.js';
import { validateRoadNetwork, type RailRange, type RoadArea } from '../../../src/shared/map/roadSchema.js';
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

describe('rails at junctions', () => {
    it('keep out of a junction: from its trim radius plus half the road width plus 2 m, on both ends', () => {
        // A crossing at (100, 0): the east-west road through it and a road to the north
        const net = buildRoadNetwork(network(
            [node('w', 0, 0), node('x', 100, 0, 'junction'), node('e', 200, 0), node('n', 100, -100)],
            [
                edge('west', 'w', 'x', [], { rails: [{ side: 'left', from: 0, to: -1, kind: 'wbeam' }] }),
                edge('east', 'x', 'e', [], { rails: [{ side: 'left', from: 0, to: -1, kind: 'wbeam' }] }),
                edge('north', 'x', 'n')
            ]
        ));
        // Trim radius 5 + 2 (half the widest road plus 2 m), half the width 5, plus 2: 14 m
        const west = railColliders(net.edgeById.get('west')!, { side: 'left', from: 0, to: -1, kind: 'wbeam' }, net);
        expect(Math.min(...west.map(c => c.ax))).toBeCloseTo(0, 6);
        expect(Math.max(...west.map(c => c.bx))).toBeCloseTo(100 - 14, 6);
        const east = railColliders(net.edgeById.get('east')!, { side: 'left', from: 0, to: -1, kind: 'wbeam' }, net);
        expect(Math.min(...east.map(c => c.ax))).toBeCloseTo(100 + 14, 6);
        expect(Math.max(...east.map(c => c.bx))).toBeCloseTo(200, 6);
        // Without the network (the look of a single edge) the rail runs to the node
        expect(Math.max(...railColliders(net.edgeById.get('west')!, { side: 'left', from: 0, to: -1, kind: 'wbeam' }).map(c => c.bx))).toBeCloseTo(100, 6);
        // A rail that lies within the clip entirely is left out
        expect(railColliders(net.edgeById.get('east')!, { side: 'left', from: 0, to: 10, kind: 'wbeam' }, net)).toEqual([]);
        expect(networkRailColliders(net)).toEqual([...west, ...east]);
    });
});

describe('area railings', () => {
    const area = (polygon: [number, number][], rails: RoadArea['rails'] = []): RoadArea =>
        ({ id: 'deck', polygon, surface: 'wood', curb: false, connects: [], rails });
    // 20 × 10 m rectangle, once in each winding
    const ccw: [number, number][] = [[0, 0], [20, 0], [20, 10], [0, 10]];
    const cw: [number, number][] = [[0, 0], [0, 10], [20, 10], [20, 0]];

    it('follows the chosen sides 0.5 m inside, mitred at the corner, in either winding', () => {
        // Sides 1 and 2 of ccw: east side and north... the sides x = 20 and z = 10
        expect(areaRailLine(area(ccw), { from: 1, to: 3, kind: 'wood', offset: 0.5 }))
            .toEqual([[19.5, 0], [19.5, 9.5], [0, 9.5]]);
        // Sides 2 and 3 of cw (wrapping to vertex 0): x = 20 and z = 0
        expect(areaRailLine(area(cw), { from: 2, to: 0, kind: 'wood', offset: 0.5 }))
            .toEqual([[19.5, 10], [19.5, 0.5], [0, 0.5]]);
    });

    it('flares an open railing\'s ends outwards past their vertices, not a closed one', () => {
        // Sides x = 20 and z = 10 as above; each end goes on 4 m along its
        // side and bends 1 m out of the rectangle
        expect(areaRailLine(area(ccw), { from: 1, to: 3, kind: 'wood', offset: 0.5, flare: [4, 1] }))
            .toEqual([[20.5, -4], [19.5, 0], [19.5, 9.5], [0, 9.5], [-4, 10.5]]);
        expect(areaRailLine(area(ccw), { from: 0, to: 0, kind: 'fence', flare: [4, 1] })).toHaveLength(5);
    });

    it('mitres an oblique corner so the railing stays the offset away from both sides', () => {
        // The corner at (20 | 0) turns by 45° into the side up to (30 | 10)
        const trapeze: [number, number][] = [[0, 0], [20, 0], [30, 10], [0, 10]];
        const line = areaRailLine(area(trapeze), { from: 0, to: 2, kind: 'wood', offset: 0.5 });
        const corner = line[1];
        // Distance to the side z = 0 and to the side through (20 | 0) and (30 | 10)
        expect(corner[1]).toBeCloseTo(0.5, 9);
        expect(Math.abs((corner[0] - 20) - (corner[1] - 0)) / Math.SQRT2).toBeCloseTo(0.5, 9);
        // Inside the polygon: right of the slanted side (x - z < 20)
        expect(corner[0] - corner[1]).toBeLessThan(20);
    });

    it('closes round the whole outline when from = to, 0.3 m inside by default', () => {
        const line = areaRailLine(area(ccw), { from: 0, to: 0, kind: 'fence' });
        expect(line.map(([x, z]) => [+x.toFixed(9), +z.toFixed(9)])).toEqual([[0.3, 0.3], [19.7, 0.3], [19.7, 9.7], [0.3, 9.7], [0.3, 0.3]]);
    });

    it('builds capsules along the railing and adds them after the edges\' rails', () => {
        const deck = area(ccw, [{ from: 0, to: 0, kind: 'fence' }]);
        const colliders = areaRailColliders(deck, deck.rails![0]);
        // 19.4 m sides in pieces of at most 8 m (3 each), 9.4 m sides (2 each)
        expect(colliders).toHaveLength(10);
        for (const c of colliders) expect(c).toMatchObject({ kind: 'segment', r: RAIL_RADIUS, top: Infinity });
        const net = buildRoadNetwork(network([node('a', 0, 50), node('b', 100, 50)],
            [edge('ab', 'a', 'b', [], { rails: [{ side: 'left', from: 0, to: -1, kind: 'wbeam' }] })], { areas: [deck] }));
        const all = networkRailColliders(net);
        expect(all).toHaveLength(13 + 10);
        expect(all[0].top).toBe(RAIL_TOP);
        expect(all.at(-1)!.top).toBe(Infinity);
    });

    it('gives a quay\'s bollards a low top (a car hits them, 0.7 m, below the rails\' 0.8 m)', () => {
        const quay = area(ccw, [{ from: 0, to: 1, kind: 'bollard' }]);
        const colliders = areaRailColliders(quay, quay.rails![0]);
        expect(colliders).toHaveLength(3);
        for (const c of colliders) expect(c.top).toBe(0.7);
    });

    it('refuses a rail naming a vertex the polygon does not have', () => {
        const file = network([node('a', 0, 50), node('b', 100, 50)], [edge('ab', 'a', 'b')], { areas: [area(ccw, [{ from: 1, to: 4, kind: 'wood' }])] });
        expect(validateRoadNetwork(file)).toEqual(['area deck: rail 1..4 names a vertex the polygon does not have (4)']);
    });
});

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
