import { describe, expect, it } from 'vitest';
import { quantizeHeight, zoneCols, zoneRows, type GridSpec, type Heightfield } from '../../../src/shared/map/heightfield.js';
import type { MapFile, PoisFile, TrackRoute, ZonesFile } from '../../../src/shared/map/mapFiles.js';
import { buildRoadNetwork, type RoadNetwork } from '../../../src/shared/map/roadNetwork.js';
import type { RoadArea, RoadNetworkFile } from '../../../src/shared/map/roadSchema.js';
import {
    boxDistance, checkAreaRails, checkBoundary, checkConnectivity, checkCrossings, checkCurves, checkGrades, checkPois,
    checkRails, checkRamp, checkTerrainMesh, checkTrack, checkZones, rampFlight, rampLip, routeFlow, segmentSegmentDistance,
    terrainMeshStats, validateMap, type Finding
} from '../../../tools/map/validateMap.js';
import { edge, network, node, PROFILE } from '../../shared/map/fixtures.js';

// The map validation (docs/phase-3-design.md 15, deviation A14) on small
// hand-built networks over synthetic heightfields. Every road is 10 m wide
// (half width 5, flat zone 5 + 4 = 9 m) unless a test says otherwise; the
// expected findings follow from that geometry by hand.

const SPEC: GridSpec = {
    cols: 176, rows: 176, cellSize: 2, originX: -100, originZ: -100,
    heightOffset: -20, heightScale: 0.01, waterLevel: 0, zoneCell: 8
};

// A heightfield from a height function, sampled at the grid points
function field(h: (x: number, z: number) => number, spec: GridSpec = SPEC): Heightfield {
    const q = new Uint16Array(spec.cols * spec.rows);
    for (let j = 0; j < spec.rows; j++) {
        for (let i = 0; i < spec.cols; i++) {
            q[j * spec.cols + i] = quantizeHeight(spec, h(spec.originX + i * spec.cellSize, spec.originZ + j * spec.cellSize));
        }
    }
    return {
        spec, q, surface: new Uint8Array(spec.cols * spec.rows),
        zones: new Uint8Array(zoneCols(spec) * zoneRows(spec)), mapVersion: 1, sourceHash: new Uint8Array(16)
    };
}

const FLAT = field(() => 5);

function net(file: RoadNetworkFile): RoadNetwork {
    return buildRoadNetwork(file);
}

const messages = (findings: Finding[]) => findings.map(f => f.message);

describe('checkConnectivity', () => {
    it('reports the edges of a second, smaller network and areas tied to it', () => {
        // The shorter part (cd, 60 m) is listed first: the longer one is the network
        const findings = checkConnectivity(net(network(
            [node('a', 0, 0), node('b', 100, 0), node('c', 0, 100), node('d', 60, 100)],
            [edge('cd', 'c', 'd'), edge('ab', 'a', 'b')],
            { areas: [{ id: 'lot', polygon: [[-20, 90], [0, 90], [0, 110], [-20, 110]], surface: 'asphalt', curb: false, connects: ['c'] }] }
        )));
        expect(messages(findings)).toEqual([
            'edges cd are not connected to the network',
            'area lot connects to a separate part of the network'
        ]);
    });

    it('asks an area\'s road to reach it: every node it connects on its outline or inside, within 1 m', () => {
        const lot = (x0: number) => net(network([node('a', 0, 0), node('b', 100, 0)], [edge('ab', 'a', 'b')], {
            areas: [{ id: 'lot', polygon: [[x0, -20], [x0 + 40, -20], [x0 + 40, 20], [x0, 20]], surface: 'asphalt', curb: false, connects: ['b'] }]
        }));
        expect(checkConnectivity(lot(100.8))).toEqual([]);
        expect(checkConnectivity(lot(90))).toEqual([]);
        expect(messages(checkConnectivity(lot(106)))).toEqual(['area lot: node b lies 6.0 m off its outline']);
    });

    it('joins the parts an area connects', () => {
        const joined = net(network(
            [node('a', 0, 0), node('b', 100, 0), node('c', 0, 100), node('d', 60, 100)],
            [edge('cd', 'c', 'd'), edge('ab', 'a', 'b')],
            { areas: [{ id: 'lot', polygon: [[60, 0], [110, 0], [110, 100], [60, 100]], surface: 'asphalt', curb: false, connects: ['b', 'd'] }] }
        ));
        expect(checkConnectivity(joined)).toEqual([]);
    });

    it('accepts an unconnected area touching a road or its sidewalk, but not one standing apart', () => {
        const area = (id: string, z0: number, extra: Partial<RoadArea> = {}): RoadArea => ({
            id, polygon: [[20, z0], [60, z0], [60, z0 + 20], [20, z0 + 20]], surface: 'asphalt', curb: true, connects: [], ...extra
        });
        const withSidewalk = { road: { ...PROFILE, sidewalk: { left: 3, right: 3 } } };
        const roads = (areas: RoadArea[], profiles = {}) => net(network(
            [node('a', 0, 0), node('b', 100, 0)], [edge('ab', 'a', 'b')],
            { areas, profiles: { ...network([], []).profiles, ...profiles } }
        ));
        // Reach: half width 5 + 1 m, plus the sidewalk
        expect(checkConnectivity(roads([area('near', 6)]))).toEqual([]);
        expect(messages(checkConnectivity(roads([area('far', 8)])))).toEqual(['area far neither connects to a node nor touches a road']);
        expect(checkConnectivity(roads([area('behind-sidewalk', 9)], withSidewalk))).toEqual([]);
        // A pedestrian plaza is not part of the driving network
        expect(checkConnectivity(roads([area('plaza', 40, { markings: 'plazaPavers' })]))).toEqual([]);
    });

    it('passes on the network builder\'s issues (a joint with a kink)', () => {
        // Bézier handles: aj arrives heading +x, jb leaves at 45°
        const findings = checkConnectivity(net(network(
            [node('a', 0, 0), node('j', 100, 0, 'joint'), node('b', 100, 100)],
            [
                edge('aj', 'a', 'j', [], { curve: { type: 'bezier', segments: [{ c1: [30, 0], c2: [70, 0] }] } }),
                edge('jb', 'j', 'b', [], { curve: { type: 'bezier', segments: [{ c1: [130, 30], c2: [100, 70] }] } })
            ]
        )));
        expect(findings).toHaveLength(1);
        expect(findings[0].message).toMatch(/^node j: joint is not tangent-continuous/);
    });
});

describe('checkCrossings', () => {
    it('measures the distance between segments, 0 where they cross', () => {
        expect(segmentSegmentDistance([0, 0], [10, 0], [5, -5], [5, 5])).toBe(0);
        expect(segmentSegmentDistance([0, 0], [10, 0], [0, 3], [10, 3])).toBe(3);
        expect(segmentSegmentDistance([0, 0], [10, 0], [13, 4], [20, 4])).toBe(5);
        // Touching: an end on the other segment, and collinear overlap
        expect(segmentSegmentDistance([0, 0], [10, 0], [5, 0], [5, 7])).toBe(0);
        expect(segmentSegmentDistance([0, 0], [10, 0], [5, 7], [5, 0])).toBe(0);
        expect(segmentSegmentDistance([5, 0], [5, 7], [0, 0], [10, 0])).toBe(0);
        expect(segmentSegmentDistance([0, 0], [0, 10], [0, 4], [0, 20])).toBe(0);
        // Collinear, apart
        expect(segmentSegmentDistance([0, 0], [10, 0], [12, 0], [20, 0])).toBe(2);
    });

    it('reports roads that cross or come closer than both half widths + 1 m without a junction', () => {
        const findings = checkCrossings(net(network(
            [node('a', 0, 0), node('b', 100, 0), node('c', 50, -50), node('d', 50, 50),
                node('e', 0, 60), node('f', 100, 60), node('g', 0, 70.5), node('h', 100, 70.5),
                node('i', 0, 83), node('k', 100, 83)],
            [edge('ab', 'a', 'b'), edge('cd', 'c', 'd'), edge('ef', 'e', 'f'), edge('gh', 'g', 'h'), edge('ik', 'i', 'k')]
        )));
        // ab × cd cross; cd reaches ef; ef and gh are 10.5 m apart (need 11);
        // gh and ik 12.5 m (fine)
        // (reported at the first sample pair closer than 11 m)
        expect(messages(findings)).toEqual([
            expect.stringMatching(/^edges ab and cd overlap without a junction \(\d+\.\d m apart, need 11\.0 m\)$/),
            expect.stringMatching(/^edges cd and ef overlap without a junction \(\d+\.\d m apart, need 11\.0 m\)$/),
            'edges ef and gh overlap without a junction (10.5 m apart, need 11.0 m)'
        ]);
    });

    it('lets roads meet in a junction and a road bend back on itself with room', () => {
        const junction = net(network(
            [node('a', 0, 0), node('b', 100, 0, 'junction'), node('c', 200, 0), node('d', 100, 100)],
            [edge('ab', 'a', 'b'), edge('bc', 'b', 'c'), edge('bd', 'b', 'd')]
        ));
        expect(checkCrossings(junction)).toEqual([]);
        // A U-turn whose legs are 30 m apart
        const wide = net(network([node('a', 0, 0), node('b', 0, 30)], [edge('u', 'a', 'b', [[100, 0], [115, 15], [100, 30]])]));
        expect(checkCrossings(wide)).toEqual([]);
    });

    it('reports a road that folds back onto itself', () => {
        // Legs 8 m apart, a 10 m road needs 11
        const tight = net(network([node('a', 0, 0), node('b', 0, 8)], [edge('u', 'a', 'b', [[100, 0], [104, 4], [100, 8]])]));
        expect(messages(checkCrossings(tight))).toEqual([expect.stringMatching(/^edge u overlaps itself without a junction/)]);
        // Short legs (25 m): the points facing each other are at most 63 m
        // apart along the road, well beyond the 18 m a bend of 11 m may take
        const short = net(network([node('a', 0, 0), node('b', 0, 8)], [edge('u', 'a', 'b', [[25, 0], [29, 4], [25, 8]])]));
        expect(messages(checkCrossings(short))).toEqual([expect.stringMatching(/^edge u overlaps itself without a junction/)]);
    });

    it('lets two roads touch near their shared joint or junction only as far as a bend or the junction takes', () => {
        // A hairpin split at its apex joint: legs 30 m apart, fine; 8 m, not
        const hairpin = (gap: number) => net(network(
            [node('a', 0, 0), node('j', 100 + gap / 2, gap / 2, 'joint'), node('b', 0, gap)],
            [edge('in', 'a', 'j', [[100, 0]]), edge('out', 'j', 'b', [[100, gap]])]
        ));
        expect(checkCrossings(hairpin(30))).toEqual([]);
        expect(messages(checkCrossings(hairpin(8)))).toEqual([expect.stringMatching(/^edges in and out overlap without a junction/)]);
        // Two roads leaving a junction 30° apart: 2·r·sin 15° < 11 m out to
        // r = 21 m, beyond the junction's 7 m + 5 m
        const acute = net(network(
            [node('a', -100, 0), node('j', 0, 0, 'junction'), node('b', 100, 0), node('c', 100 * Math.cos(Math.PI / 6), 100 * Math.sin(Math.PI / 6))],
            [edge('aj', 'a', 'j'), edge('jb', 'j', 'b'), edge('jc', 'j', 'c')]
        ));
        expect(messages(checkCrossings(acute))).toEqual([expect.stringMatching(/^edges jb and jc overlap without a junction/)]);
    });
});

describe('checkGrades', () => {
    const straight = (extra: Parameters<typeof edge>[4] = {}, profile = 'road') =>
        net(network([node('a', 0, 0), node('b', 200, 0)], [edge('ab', 'a', 'b', [], { profile, ...extra })]));

    it('accepts level ground and a climb within maxGrade', () => {
        expect(checkGrades(straight(), FLAT)).toEqual([]);
        expect(checkGrades(straight(), field(x => 5 + 0.07 * x))).toEqual([]);
    });

    it('reports baked ground steeper than maxGrade + 1 % tolerance', () => {
        // 10 % against the default 8 %
        const findings = checkGrades(straight(), field(x => 5 + 0.1 * x));
        expect(messages(findings)).toEqual([expect.stringMatching(/^edge ab: baked grade 10\.0 % at s = \d+ exceeds 8 %$/)]);
        // 8.4 % is within the tolerance: rounding the grid heights to 1 cm
        // changes the grade between two grid points 2 m apart by up to 0.5 %
        expect(checkGrades(straight(), field(x => 5 + 0.084 * x))).toEqual([]);
        expect(checkGrades(straight({ maxGrade: 0.12 }), field(x => 5 + 0.1 * x))).toEqual([]);
    });

    it('limits maxGrade per surface: 12 % paved, 18 % dirt', () => {
        expect(messages(checkGrades(straight({ maxGrade: 0.15 }), FLAT)))
            .toEqual(['edge ab: maxGrade 0.15 is steeper than asphalt allows (0.12)']);
        expect(checkGrades(straight({ maxGrade: 0.15 }, 'dirt'), FLAT)).toEqual([]);
    });

    it('reports a climb the weakest class cannot drive up', () => {
        // Pickup: 8 · (1 - (10/47)^2.5) = 7.83 m/s² < 9.81 · 0.9
        const findings = checkGrades(straight({ maxGrade: 0.18 }, 'dirt'), field(x => 5 + 0.9 * Math.max(0, x - 100)));
        expect(findings.some(f => /cannot climb 90\.0 % on dirt$/.test(f.message))).toBe(true);
    });
});

describe('checkCurves', () => {
    // A quarter circle of radius r around (0, r), from (0, 0) to (r, r):
    // the cubic Bézier with handles 0.5523·r, whose radius stays within 2 %
    // of r
    function arc(r: number, designSpeed?: number) {
        const h = 0.5523 * r;
        const profiles = { road: { ...PROFILE, ...(designSpeed ? { designSpeed } : {}) } };
        const curve = { type: 'bezier' as const, segments: [{ c1: [h, 0] as [number, number], c2: [r, r - h] as [number, number] }] };
        return net(network([node('a', 0, 0), node('b', r, r)], [edge('bend', 'a', 'b', [], { curve })], { profiles }));
    }

    it('accepts a bend the weakest class takes at the design speed', () => {
        // R ≈ 40: pickup ≈ √(14.7 · 40) = 24 m/s = 87 km/h
        expect(checkCurves(arc(40, 60))).toEqual([]);
    });

    it('reports a bend slower than the design speed and one too tight for the road', () => {
        expect(messages(checkCurves(arc(40, 120)))).toEqual([expect.stringMatching(/^edge bend: bend with R = \d+\.\d m at s = \d+ allows \d+ km\/h, design speed 120 km\/h$/)]);
        // R = 6 (± 2 %): wider than the half width 5, but less than 5 + 2
        const tight = checkCurves(arc(6));
        expect(tight.some(f => /^edge bend: radius [56]\.\d m at s = \d+ is too tight for a 10 m road$/.test(f.message))).toBe(true);
        expect(checkCurves(arc(7.5)).some(f => f.message.includes('too tight'))).toBe(false);
    });
});

describe('checkRails (guard-rail duty, 5.5 and A16)', () => {
    // Road along z = 0; the ground falls away beyond its flat zone (9 m)
    const embankment = (run: number) => field((_, z) => 5 - Math.max(0, Math.abs(z) - 9) / run);
    const road = (extra: Parameters<typeof edge>[4] = {}) =>
        net(network([node('a', 0, 0), node('b', 100, 0)], [edge('ab', 'a', 'b', [], extra)]));

    it('asks for a rail on both sides of a fill with 1 : 1.5 slopes (2.7 m drop in 4 m)', () => {
        const findings = checkRails(road(), embankment(1.5));
        expect(findings.map(f => f.message.slice(0, 22))).toEqual(['edge ab, left side, s ', 'edge ab, right side, s']);
        // The grid points lie at even z: the bilinear ground is 4.67 m at the
        // flat zone's edge (z = 9, between 5 and 4.33) and 2.33 m at z = 13
        expect(findings[0].message).toMatch(/ground drops 2\.3 m beside the road without a rail or wall$/);
    });

    it('is satisfied by a rail or a wall on that side, or the tag noRail', () => {
        const left = checkRails(road({ rails: [{ side: 'left', from: 0, to: -1, kind: 'wbeam' }] }), embankment(1.5));
        expect(left.map(f => f.message.slice(0, 19))).toEqual(['edge ab, right side']);
        const both = road({
            rails: [{ side: 'left', from: 0, to: -1, kind: 'wbeam' }],
            walls: [{ side: 'right', from: 0, to: -1 }]
        });
        expect(checkRails(both, embankment(1.5))).toEqual([]);
        expect(checkRails(road({ tags: ['noRail'] }), embankment(1.5))).toEqual([]);
    });

    it('ignores a gentle slope (1 : 4, 1 m in 4 m)', () => {
        expect(checkRails(road(), embankment(4))).toEqual([]);
    });

    it('covers only the stations of a rail range (± 1 m), and ignores stretches shorter than 6 m', () => {
        const partial = checkRails(road({ rails: [{ side: 'left', from: 0, to: 40, kind: 'wbeam' }, { side: 'right', from: 0, to: -1, kind: 'wbeam' }] }), embankment(1.5));
        // Probed every 2 m from s = 6 (the end node takes the half width 5)
        expect(messages(partial)).toEqual([expect.stringMatching(/^edge ab, left side, s 42–94: /)]);
        // A fill only between x = 40 and x = 44: a 4 m stretch
        const bump = field((x, z) => (x >= 40 && x <= 44 ? 5 - Math.max(0, Math.abs(z) - 9) / 1.5 : 5));
        expect(checkRails(road(), bump)).toEqual([]);
    });

    it('measures each side from its own flat zone edge (sidewalk 6 m left: 11 m, right: 9 m)', () => {
        // North (left of a road heading east): level to z = -11, then 1 : 1.5
        // down. South: a 4 m step at 1 : 1 between z = 9 and 13, level
        // beyond. On the grid (even z) the right probe sees 4.5 m at z = 9
        // and 1.5 m at z = 13 (3 m drop); probed from 11 m it would see
        // 3 m and 1 m (2 m, no rail).
        const ground = field((_, z) => (z < 0
            ? 5 - Math.max(0, -z - 11) / 1.5
            : 5 - Math.min(4, Math.max(0, z - 9))));
        const profiles = { road: { ...PROFILE, sidewalk: { left: 6, right: 0 } } };
        const findings = checkRails(net(network([node('a', 0, 0), node('b', 100, 0)], [edge('ab', 'a', 'b')], { profiles })), ground);
        expect(findings.map(f => f.message.slice(0, 20))).toEqual(['edge ab, left side, ', 'edge ab, right side,']);
    });
});

describe('checkAreaRails (railings along the pier, lookouts and quays)', () => {
    // A deck 5 m above the ground (walls: no flat margin) south of a road
    // along z = 0: x 21..61, z 5..45 (odd edges, so no grid point lies on
    // them). Its north side touches the road.
    const DECK: [number, number][] = [[21, 5], [61, 5], [61, 45], [21, 45]];
    const ground = field((x, z) => (x > 21 && x < 61 && z > 5 && z < 45 ? 5 : 0));
    const deck = (extra: Partial<RoadArea> = {}) => net(network([node('a', -80, 0), node('b', 80, 0)], [edge('ab', 'a', 'b')], {
        areas: [{ id: 'deck', polygon: DECK, y: 5, surface: 'wood', curb: false, connects: [], walls: true, ...extra }]
    }));

    it('asks for a railing on every side that drops more than 2 m, not where the road goes on', () => {
        const findings = checkAreaRails(deck(), ground);
        expect(messages(findings).map(m => m.slice(0, 16))).toEqual(['area deck, side ', 'area deck, side ', 'area deck, side ']);
        expect(messages(findings).map(m => m.slice(0, 17))).toEqual(['area deck, side 1', 'area deck, side 2', 'area deck, side 3']);
        // 0.3 m inside the east side (x = 60.7) the bilinear deck is at
        // 5 · 0.65 = 3.25 m, 4 m out the ground is 0
        expect(findings[0].message).toMatch(/^area deck, side 1 \(1–39 m\): ground drops 3\.\d m beside it without a railing$/);
    });

    it('is satisfied by railings on those sides or the tag noRail', () => {
        expect(checkAreaRails(deck({ rails: [{ from: 1, to: 0, kind: 'wood' }] }), ground)).toEqual([]);
        expect(messages(checkAreaRails(deck({ rails: [{ from: 1, to: 3, kind: 'wood' }] }), ground))).toEqual([
            expect.stringMatching(/^area deck, side 3 /)
        ]);
        expect(checkAreaRails(deck({ tags: ['noRail'] }), ground)).toEqual([]);
    });

    it('keeps an open railing\'s ends off the drivable width of a road (a flare leads them out)', () => {
        // A pier 8 m wide at the end of a 10 m road (x = 0): its railings end
        // 0.3 m inside the pier's sides, at z = ±3.7 on the road; flared 4 m
        // back and 1.8 m out they end at z = ±5.5, beside the road
        const pier = (flare?: [number, number]) => net(network([node('a', -80, 0), node('b', 0, 0)], [edge('ab', 'a', 'b')], {
            areas: [{ id: 'pier', polygon: [[0, -4], [40, -4], [40, 4], [0, 4]], y: 5, surface: 'wood', curb: false, connects: ['b'],
                rails: [{ from: 0, to: 3, kind: 'wood', ...(flare ? { flare } : {}) }] }]
        }));
        expect(messages(checkAreaRails(pier(), FLAT))).toEqual([
            'area pier: a railing ends on the drivable width of ab',
            'area pier: a railing ends on the drivable width of ab'
        ]);
        expect(checkAreaRails(pier([4, 1.8]), FLAT)).toEqual([]);
    });

    it('measures a level area from beyond its 4 m flat margin', () => {
        // A car park level with its surroundings, then 1 : 1 down from 5 m
        // out: 3 m lower 4 m beyond the flat margin
        const lot = field((x, z) => 5 - Math.max(0, Math.max(21 - x, x - 61, 5 - z, z - 45) - 5));
        expect(checkAreaRails(deck({ walls: false }), lot).length).toBe(3);
        expect(checkAreaRails(deck({ walls: false }), FLAT)).toEqual([]);
    });
});

describe('ramps: lip, flight, axis', () => {
    const ramp = { x: 0, z: 0, yaw: 0, width: 8, length: 10, height: 1.2 };

    it('measures the lip above the ground in front, less what the ground rises under the ramp', () => {
        expect(rampLip(FLAT, ramp)).toBeCloseTo(1.2, 9);
        // 10 % up along +z: the front edge's ground is 1 m higher than the rear's
        const up = field((_, z) => 5 + 0.1 * z);
        expect(rampLip(up, ramp)).toBeCloseTo(0.2, 9);
        // Facing down the slope the ground falls 1 m: 2.2 m
        expect(rampLip(up, { ...ramp, yaw: Math.PI })).toBeCloseTo(2.2, 9);
        // 10 % across (x): the higher front corner at x = 4 is 0.4 m up
        const across = field(x => 5 + 0.1 * x);
        expect(rampLip(across, ramp)).toBeCloseTo(0.8, 9);
    });

    it('estimates the flight from the ramp slope, the lip and the sim\'s GRAVITY = 20', () => {
        // h / L = 0.2 at 20 m/s: vy = 20 · 0.2 / √1.04 = 3.922, vh = 19.61;
        // falls 2 m: t = (3.922 + √(3.922² + 2 · 20 · 2)) / 20 = 0.6844 s
        const flight = rampFlight({ ...ramp, height: 2 }, 2, 20);
        expect(flight.time).toBeCloseTo(0.6844, 3);
        expect(flight.distance).toBeCloseTo(13.42, 1);
    });

    it('reports a lip under 0.8 m and a ramp off the axes; 1.5708 counts as π/2', () => {
        const up = field((_, z) => 5 + 0.1 * z);
        expect(messages(checkRamp('r', ramp, up))).toEqual(['r: lip 0.20 m above the ground in front (height 1.2 m less the rise of the ground), needs 0.8 m']);
        expect(checkRamp('r', { ...ramp, yaw: 1.5708 }, FLAT)).toEqual([]);
        expect(messages(checkRamp('r', { ...ramp, yaw: 0.3 }, FLAT))).toEqual(['r: faces 17.2°, not along an axis (its walls need obox colliders, M3)']);
    });
});

describe('checkTerrainMesh', () => {
    // Corners alternating 10 ± a like a chessboard: every cell has
    // |d| = |h00 + h11 - h10 - h01| = 4a
    const saddle = (a: number, surface = 5) => {
        const hf = field((x, z) => 10 + a * (Math.round((x + z) / 2) % 2 === 0 ? 1 : -1));
        hf.surface.fill(surface);
        return hf;
    };

    it('accepts a gentle twist (d = 0.4 m: 10 cm at 2 m, 0.6 cm at 0.5 m) off the roads', () => {
        const stats = terrainMeshStats(saddle(0.1));
        expect(stats.worst2m).toBeCloseTo(0.1, 2);
        expect(stats.worstNear).toBeCloseTo(0.4 / 64, 3);
        expect(checkTerrainMesh(saddle(0.1))).toEqual([]);
    });

    it('reports a twist the near subdivision cannot follow, and any on a road above 3 cm', () => {
        // d = 4 m: 6.25 cm at 0.5 m
        expect(messages(checkTerrainMesh(saddle(1)))).toEqual([expect.stringMatching(/^the terrain mesh misses the ground by 6\.\d cm even at 4× subdivision/)]);
        // On asphalt (0): d = 0.4 m, 10 cm at 2 m
        expect(messages(checkTerrainMesh(saddle(0.1, 0)))).toEqual([expect.stringMatching(/^the 2 m terrain mesh misses a road by 10\.\d cm/)]);
        // Water and rock cells do not count
        expect(checkTerrainMesh(saddle(1, 9))).toEqual([]);
        expect(checkTerrainMesh(saddle(1, 8))).toEqual([]);
    });
});

describe('checkBoundary', () => {
    const MAP: MapFile = {
        format: 'bulli-map', version: 1, mapId: 'test', mapVersion: 1, name: 'Test',
        boundary: [[-50, -50], [150, -50], [150, 150], [-50, 150]]
    };

    it('accepts roads that stay their half width inside, reports one that leaves', () => {
        const inside = net(network([node('a', 0, 0), node('b', 144, 0)], [edge('ab', 'a', 'b')]));
        expect(checkBoundary(inside, MAP)).toEqual([]);
        const out = net(network([node('a', 0, 0), node('b', 147, 0)], [edge('ab', 'a', 'b')]));
        expect(messages(checkBoundary(out, MAP))).toEqual(['edge ab leaves the drivable boundary at s = 146']);
    });

    it('reports an area reaching beyond it', () => {
        const withArea = net(network([node('a', 0, 0), node('b', 100, 0)], [edge('ab', 'a', 'b')], {
            areas: [{ id: 'lot', polygon: [[100, 100], [160, 100], [160, 120], [100, 120]], surface: 'asphalt', curb: false, connects: [] }]
        }));
        expect(messages(checkBoundary(withArea, MAP))).toEqual(['area lot reaches beyond the drivable boundary']);
    });
});

describe('checkZones', () => {
    it('reports a zone without area and warns about one beyond the heightfield', () => {
        const zones: ZonesFile = {
            format: 'bulli-zones', version: 1, mapId: 'test',
            zones: [
                { id: 'ok', zone: 'downtown', polygon: [[0, 0], [50, 0], [50, 50]] },
                { id: 'line', zone: 'park', polygon: [[0, 5], [10, 5], [20, 5]] },
                { id: 'wide', zone: 'wild', polygon: [[0, 0], [500, 0], [0, 50]] },
                { id: 'north', zone: 'wild', polygon: [[0, 0], [10, -300], [20, 0]] }
            ]
        };
        const findings = checkZones(zones, FLAT);
        expect(findings.map(f => [f.severity, f.message])).toEqual([
            ['error', 'zone line has no area'],
            ['warning', 'zone wide reaches beyond the heightfield'],
            ['warning', 'zone north reaches beyond the heightfield']
        ]);
    });
});

// ---- POIs: a road along z = 0 with an arena lot south of it ----

const ARENA: [number, number][] = [[20, 20], [180, 20], [180, 140], [20, 140]];
const CENTRE = { x: 100, z: 80 };

function poiNetwork(): RoadNetwork {
    return net(network([node('a', -80, 0), node('b', 240, 0)], [edge('ab', 'a', 'b')], {
        areas: [{ id: 'lot', polygon: ARENA, y: 5, surface: 'concrete', curb: false, connects: [] }]
    }));
}

function validPois(): PoisFile {
    const facing = (x: number, z: number) => ({ x, z, yaw: Math.atan2(CENTRE.x - x, CENTRE.z - z) });
    const party = [];
    for (let k = 0; k < 8; k++) party.push(facing(30 + k * 20, 26), facing(30 + k * 20, 134));
    // Containers in a column at x = 100 (along z), ramps beside them
    const containers = [];
    for (let k = 0; k < 12; k++) containers.push({ x: k < 6 ? 60 : 140, z: 40 + (k % 6) * 15, yaw: 0 });
    const ramps = [{ x: 100, z: 60, yaw: 0, width: 6, length: 10, height: 1.5 }, { x: 100, z: 100, yaw: Math.PI, width: 6, length: 10, height: 1.5 }];
    const coins: [number, number][] = [];
    const powerups: [number, number][] = [];
    for (let k = 0; k < 30; k++) coins.push([30 + (k % 10) * 2.5, 50 + Math.floor(k / 10) * 20]);
    for (let k = 0; k < 25; k++) powerups.push([150 + (k % 5) * 5, 40 + Math.floor(k / 5) * 18]);
    const free = [];
    for (let g = 0; g < 4; g++) for (let k = 0; k < 4; k++) free.push({ group: `g${g}`, x: -60 + g * 70 + k * 12, z: 2.5, yaw: Math.PI / 2 });
    return {
        format: 'bulli-pois', version: 1, mapId: 'test',
        landmarks: [{ id: 'arena', kind: 'partyArena', name: 'Arena', x: 100, z: 80, area: 'lot' }],
        spawns: { freeRoam: free, party },
        arena: { area: 'lot', gate: { x: 100, z: 20, yaw: 0, width: 12 }, containers, ramps, coins, powerups }
    };
}

const POI_MAP: MapFile = {
    format: 'bulli-map', version: 1, mapId: 'test', mapVersion: 1, name: 'Test',
    boundary: [[-90, -90], [248, -90], [248, 248], [-90, 248]]
};

describe('checkPois', () => {
    it('accepts spawns on dry road, party spawns facing the middle and a clear arena', () => {
        expect(checkPois(poiNetwork(), FLAT, POI_MAP, validPois())).toEqual([]);
    });

    it('measures the distance to a rotated box, 0 inside', () => {
        expect(boxDistance(0, 0, 0, 0, 0, 12, 2)).toBe(0);
        // Box along z (yaw 0), 12 long, 2 wide: 3 m beside it, 4 m beyond its end
        expect(boxDistance(4, 0, 0, 0, 0, 12, 2)).toBeCloseTo(3, 12);
        expect(boxDistance(0, 10, 0, 0, 0, 12, 2)).toBeCloseTo(4, 12);
        // Turned by 90°: along x now
        expect(boxDistance(10, 0, 0, 0, Math.PI / 2, 12, 2)).toBeCloseTo(4, 12);
    });

    it('reports free-roam spawns off the road, in the water, too close, and missing groups', () => {
        const pois = validPois();
        pois.spawns.freeRoam = pois.spawns.freeRoam.slice(0, 12);
        pois.spawns.freeRoam[0] = { ...pois.spawns.freeRoam[0], z: 30 };
        pois.spawns.freeRoam[1] = { ...pois.spawns.freeRoam[1], x: pois.spawns.freeRoam[2].x - 3 };
        // 5 cm above the sea still counts as wet (a spawn needs 10 cm)
        const wet = field((x) => (x < -40 ? 0.05 : 5));
        expect(messages(checkPois(poiNetwork(), wet, POI_MAP, pois))).toEqual([
            'only 3 free-roam spawn groups, the design has 4',
            'free-roam spawn 1 (g0) is not on a road or area',
            'free-roam spawn 1 (g0) is in the water',
            'free-roam spawns 2 and 3 are closer than 6 m'
        ]);
    });

    // The harbour yards of the Party (A54): here the road along z = 0 north of the lot
    function withYards(pois: PoisFile): PoisFile {
        const coins: [number, number][] = [];
        const powerups: [number, number][] = [];
        for (let k = 0; k < 21; k++) coins.push([-12 + k * 10, 1]);
        for (let k = 0; k < 8; k++) powerups.push([-7 + k * 25, -1]);
        const harbor = Array.from({ length: 8 }, (_, k) => ({ group: 'harbor' as const, x: -10 + k * 25, z: 0, yaw: Math.PI / 2 }));
        return {
            ...pois,
            spawns: { ...pois.spawns, party: [...pois.spawns.party, ...harbor] },
            party: { zone: { minX: -20, minZ: -15, maxX: 200, maxZ: 150 }, coins, powerups }
        };
    }

    it('accepts a Party zone round the arena with spawns and items on its road', () => {
        expect(checkPois(poiNetwork(), FLAT, POI_MAP, withYards(validPois()))).toEqual([]);
    });

    it('reports a zone that leaves out the arena or the boundary, and yard spawns and items off the zone, the road or in the arena', () => {
        const pois = withYards(validPois());
        pois.party!.zone = { minX: -20, minZ: -15, maxX: 250, maxZ: 130 };
        // Within 3 m of the shrunk zone's edge (z 130), and off the road; a coin
        // in the arena and one beside the road
        pois.spawns.party[16] = { ...pois.spawns.party[16], z: 128 };
        pois.party!.coins[0] = [100, 80];
        pois.party!.coins[1] = [-2, 12];
        pois.party!.powerups.pop();
        expect(messages(checkPois(poiNetwork(), FLAT, POI_MAP, pois))).toEqual([
            'the party zone does not contain the arena',
            'the party zone reaches beyond the boundary',
            'party spawn 17 is not inside the party zone',
            'party spawn 17 (harbor) is not on a road or area',
            'harbour coin point 1 is not in the yards',
            'harbour coin point 2 is not on a road',
            '7 power-up points in the harbour yards, the design has 8'
        ]);
        // Yard spawns need the zone
        const lost = validPois();
        lost.spawns.party.push({ group: 'harbor', x: 0, z: 0, yaw: 0 });
        expect(messages(checkPois(poiNetwork(), FLAT, POI_MAP, lost))).toEqual([
            'harbour spawns without a party zone',
            'party spawn 17 is not inside the party zone'
        ]);
    });

    it('reports party spawns outside the arena or looking away from its middle', () => {
        const pois = validPois();
        pois.spawns.party[0] = { ...pois.spawns.party[0], z: 21 };
        pois.spawns.party[1] = { ...pois.spawns.party[1], yaw: pois.spawns.party[1].yaw + Math.PI };
        pois.spawns.party.pop();
        expect(messages(checkPois(poiNetwork(), FLAT, POI_MAP, pois))).toEqual([
            '15 party spawns in the arena, the design has 16',
            'party spawn 1 is not inside the arena',
            'party spawn 2 does not face the arena\'s middle'
        ]);
    });

    it('reports containers and ramps outside the arena and items next to them', () => {
        const pois = validPois();
        pois.arena.containers[0] = { x: 25, z: 60, yaw: Math.PI / 2 };
        pois.arena.ramps[0] = { ...pois.arena.ramps[0], z: 138 };
        // 1.5 m beside the container at (60, 55): inside the 2 m clearance
        pois.arena.coins[0] = [60 + 1.22 + 1.5, 55];
        pois.arena.powerups.pop();
        expect(messages(checkPois(poiNetwork(), FLAT, POI_MAP, pois))).toEqual([
            'container 1 is not inside the arena',
            'arena ramp 1 is not inside the arena',
            'coin point 1 is inside or next to a container or ramp',
            '24 power-up points, the design has 25'
        ]);
    });

    it('reports a spawn group short of slots, a spawn outside the boundary and party spawns on top of each other', () => {
        const pois = validPois();
        pois.spawns.freeRoam = pois.spawns.freeRoam.filter((_, i) => i !== 15);
        pois.spawns.freeRoam[0] = { ...pois.spawns.freeRoam[0], x: -95 };
        pois.spawns.party[3] = { ...pois.spawns.party[1], x: pois.spawns.party[1].x + 2 };
        const found = messages(checkPois(poiNetwork(), FLAT, POI_MAP, pois));
        expect(found).toContain('spawn group g3 has 3 slots, the design has 4');
        expect(found).toContain('free-roam spawn 1 (g0) is outside the boundary');
        expect(found).toContain('party spawns 2 and 4 are closer than 6 m');
    });

    it('accepts party spawns turned less than 45° from the middle, also across ±π', () => {
        const pois = validPois();
        const turn = (i: number, by: number) => { pois.spawns.party[i] = { ...pois.spawns.party[i], yaw: pois.spawns.party[i].yaw + by }; };
        turn(0, 0.5);
        turn(2, 2 * Math.PI - 0.5);
        turn(4, 1.0);
        expect(messages(checkPois(poiNetwork(), FLAT, POI_MAP, pois))).toEqual(['party spawn 5 does not face the arena\'s middle']);
    });

    it('counts the containers and keeps items and party spawns clear of ramps and containers', () => {
        const pois = validPois();
        pois.arena.containers.pop();
        // Ramp 1 at (100 | 60), 10 long (along z), 6 wide: 1 m beside it
        pois.arena.coins[1] = [100 + 3 + 1, 60];
        pois.spawns.party[0] = { ...pois.spawns.party[0], x: 60, z: 40 };
        expect(messages(checkPois(poiNetwork(), FLAT, POI_MAP, pois))).toEqual([
            '11 containers, the design has 12',
            'coin point 2 is inside or next to a container or ramp',
            'party spawn 1 is inside or next to a container or ramp'
        ]);
    });

    it('reports a missing arena area, a landmark outside the map and one on an unknown area', () => {
        const pois = validPois();
        pois.landmarks.push({ id: 'far', kind: 'lighthouse', name: 'Far', x: 400, z: 0 });
        pois.landmarks.push({ id: 'lost', kind: 'diner', name: 'Lost', x: 0, z: 0, area: 'nowhere' });
        expect(messages(checkPois(poiNetwork(), FLAT, POI_MAP, pois))).toEqual([
            'landmark far is outside the boundary',
            'landmark lost: unknown area nowhere'
        ]);
        expect(messages(checkPois(poiNetwork(), FLAT, POI_MAP, { ...pois, arena: { ...pois.arena, area: 'nope' } })))
            .toEqual(['arena area nope is not in roads.json']);
    });

    it('checks the jumps of the map: unique, inside, a working lip and a dry landing at 90 km/h', () => {
        const jump = { id: 'kicker', x: 100, z: -40, yaw: 0, width: 6, length: 10, height: 1.5, look: 'earth' as const };
        expect(checkPois(poiNetwork(), FLAT, POI_MAP, { ...validPois(), jumps: [jump] })).toEqual([]);
        const low = { ...jump, id: 'low', x: 30, height: 0.5 };
        const out = { ...jump, id: 'out', x: 245 };
        // Water between z = -30 and -10: a jump at z = -48 heading south
        // (+z) leaves at z = -43 and flies 15.2 m at 25 m/s (h / L = 0.15,
        // lip 1.5 m: t = 0.615 s), landing at z = -27.8
        const wet = field((_, z) => (z > -30 && z < -10 ? -2 : 5));
        expect(messages(checkPois(poiNetwork(), FLAT, POI_MAP, { ...validPois(), jumps: [jump, jump, low, out] }))).toEqual([
            'jump kicker: duplicate id',
            'jump low: lip 0.50 m above the ground in front (height 0.5 m less the rise of the ground), needs 0.8 m',
            'jump out reaches beyond the boundary'
        ]);
        expect(messages(checkPois(poiNetwork(), wet, POI_MAP, { ...validPois(), jumps: [{ ...jump, z: -48 }] })))
            .toContainEqual('jump kicker: a car at 90 km/h lands in the water or beyond the boundary');
        expect(checkPois(poiNetwork(), wet, POI_MAP, { ...validPois(), jumps: [{ ...jump, z: -52 }] })).toEqual([]);
        // A run-up of 30 m behind the rear edge, checked every 2 m: from a
        // ramp at z = 1 heading south (rear edge at z = -4) it reaches the
        // water at z = -12 (the 2 m grid: -10 is still dry); from one at
        // z = -70 (rear edge -75) it leaves the map at z = -91
        expect(messages(checkPois(poiNetwork(), wet, POI_MAP, { ...validPois(), jumps: [{ ...jump, z: 1 }] })))
            .toEqual(['jump kicker: the 30 m run-up runs into deep water 8 m behind the ramp']);
        expect(messages(checkPois(poiNetwork(), FLAT, POI_MAP, { ...validPois(), jumps: [{ ...jump, z: -70 }] })))
            .toEqual(['jump kicker: the 30 m run-up leaves the map 16 m behind the ramp']);
        // A ramp without a working lip gets no landing check on top
        expect(messages(checkPois(poiNetwork(), wet, POI_MAP, { ...validPois(), jumps: [{ ...jump, z: -48, height: 0.5 }] })))
            .toEqual(['jump kicker: lip 0.50 m above the ground in front (height 0.5 m less the rise of the ground), needs 0.8 m']);
    });

    it('checks the arena ramps\' lips and axes', () => {
        const pois = validPois();
        pois.arena.ramps[0] = { ...pois.arena.ramps[0], yaw: 0.5 };
        expect(messages(checkPois(poiNetwork(), FLAT, POI_MAP, pois))).toEqual(['arena ramp 1: faces 28.6°, not along an axis (its walls need obox colliders, M3)']);
    });

    it('reports a gate away from the fence and a landmark off its area', () => {
        const pois = validPois();
        pois.arena.gate = { ...pois.arena.gate, z: 80 };
        pois.landmarks[0] = { ...pois.landmarks[0], z: 150 };
        expect(messages(checkPois(poiNetwork(), FLAT, POI_MAP, pois))).toEqual([
            'the arena gate is not on the arena\'s outline',
            'landmark arena is not on area lot'
        ]);
    });
});

// ---- Tracks over the square of trackRoute.test.ts ----

function square(): RoadNetwork {
    return net(network(
        [
            node('a', 0, 0, 'junction'), node('m1', 100, 0, 'junction'), node('b', 200, 0, 'junction'),
            node('c', 200, 200, 'junction'), node('m2', 100, 200, 'junction'), node('d', 0, 200, 'junction')
        ],
        [
            edge('ab1', 'a', 'm1'), edge('ab2', 'm1', 'b'), edge('bc', 'b', 'c'), edge('cd1', 'c', 'm2'),
            edge('cd2', 'm2', 'd'), edge('da', 'd', 'a'), edge('cross', 'm1', 'm2')
        ]
    ));
}

const LOOP: TrackRoute = {
    id: 'loop', name: 'Loop', kind: 'circuit', laps: 2, trackVersion: 1,
    route: ['ab1', 'ab2', 'bc', 'cd1', 'cd2', 'da'], start: { edge: 'ab1', s: 60 }, gateSpacing: 300, minCornerSpeed: 20
};

describe('checkTrack', () => {
    const big = field(() => 5, { ...SPEC, cols: 201, rows: 201, originX: -100, originZ: -100 });

    it('resolves a valid circuit and estimates its climb and race time', () => {
        const { findings, stats } = checkTrack(square(), big, LOOP);
        expect(findings).toEqual([]);
        expect(stats!.climb).toBe(0);
        // Two laps of about 787 m: no class can beat a standing start at the
        // best acceleration of the classes (11 m/s²) held all the way
        expect(stats!.fastest.time).toBeGreaterThan(Math.sqrt(2 * 2 * 780 / 11));
        expect(stats!.slowest.time).toBeGreaterThanOrEqual(stats!.fastest.time);
        // The corners (R ≈ 12: trim 7 + half width 5) are the slowest bends:
        // about √(14.7 · 12) m/s = 48 km/h
        expect(stats!.minCornerSpeed).toBeGreaterThan(42);
        expect(stats!.minCornerSpeed).toBeLessThan(54);
    });

    it('reports routing errors with the track ID', () => {
        const { findings, stats } = checkTrack(square(), big, { ...LOOP, route: ['ab1', 'bc'] });
        expect(stats).toBeNull();
        expect(messages(findings)).toEqual([
            'track loop: gap between ab1 (ends at m1) and bc (starts at b)',
            'track loop: circuit is not closed: ends at c, starts at a'
        ]);
    });

    it('reports a bend slower than minCornerSpeed and a ramp reaching into a junction', () => {
        const { findings } = checkTrack(square(), big, {
            ...LOOP, minCornerSpeed: 60, ramps: [{ edge: 'ab2', s: 90, length: 10, height: 1 }, { edge: 'bc', s: 100, length: 10, height: 1 }]
        });
        expect(messages(findings)).toEqual([
            expect.stringMatching(/^track loop: bend with R = \d+\.\d m allows \d+ km\/h, minCornerSpeed 60$/),
            'track loop: ramp at s = 90 on ab2 reaches into a junction or beyond the edge',
            // Its front edge (s = 95) is already in the corner at B
            'track loop: ramp at s = 90 on ab2: lands in a bend (R 12 m, 0 m after the ramp)'
        ]);
    });

    it('reports a route passing close to itself, a grid wider than the road and a circuit with too few gates', () => {
        // A block of four corners without branches: only the start/finish gate
        const block = (width: number) => net(network(
            [node('p', 0, 0, 'junction'), node('q', 150, 0, 'junction'), node('r', 150, 150, 'junction'), node('t', 0, 150, 'junction')],
            [edge('pq', 'p', 'q'), edge('qr', 'q', 'r'), edge('rt', 'r', 't'), edge('tp', 't', 'p')],
            { profiles: { road: { ...PROFILE, width } } }
        ));
        const lap: TrackRoute = { ...LOOP, route: ['pq', 'qr', 'rt', 'tp'], start: { edge: 'pq', s: 60 }, gateSpacing: 1000, minCornerSpeed: 5 };
        expect(messages(checkTrack(block(10), big, lap).findings)).toEqual(['track loop: only 1 gates']);
        // The same on a 4 m road: the grid's lanes (±1 m) plus a car (1.4 m)
        // do not fit into the half width of 2 m
        const narrow = block(4);
        const narrowFindings = messages(checkTrack(narrow, big, lap).findings);
        expect(narrowFindings.filter(m => m.includes('is not on the road'))).toHaveLength(8);
        // A sprint out along z = 0 and back along z = 9 (the hairpin is a
        // junction, so the network itself is only warned by checkCrossings)
        const outAndBack = net(network(
            [node('a', 0, 0), node('j', 150, 4.5, 'junction'), node('b', 0, 9), node('c', 250, 4.5)],
            [edge('out', 'a', 'j', [[140, 0]]), edge('back', 'j', 'b', [[140, 9]]), edge('on', 'j', 'c')]
        ));
        const { findings } = checkTrack(outAndBack, big, {
            ...LOOP, kind: 'sprint', laps: 1, route: ['out', 'back'], start: { edge: 'out', s: 50 }, finish: { edge: 'back', s: 100 }
        });
        expect(messages(findings)).toContainEqual(expect.stringMatching(/^track loop passes within \d+\.\d m of itself$/));
    });

    it('reports ramps off the route or wider than the road, and a climb no class can make', () => {
        const { findings } = checkTrack(square(), big, {
            ...LOOP, ramps: [{ edge: 'cross', s: 50, length: 10, height: 1 }, { edge: 'bc', s: 100, length: 10, height: 1, width: 12 }]
        });
        expect(messages(findings)).toEqual([
            'track loop: ramp on edge cross, which is not on the route',
            'track loop: ramp at s = 100 on bc is wider than the road'
        ]);
        // 90 % up from x = 60 on: more than the pickup's drive (8 m/s² at
        // most) can hold against 9.81 · 0.9 = 8.83 m/s²
        const wall = field(x => 5 + 0.9 * Math.min(120, Math.max(0, x - 60)), { ...SPEC, cols: 201, rows: 201 });
        const stalls = messages(checkTrack(square(), wall, {
            ...LOOP, kind: 'sprint', laps: 1, route: ['ab1', 'ab2'], start: { edge: 'ab1', s: 50 }, finish: { edge: 'ab2', s: 80 }
        }).findings);
        expect(stalls.some(m => /^track loop: pickup stalls on the climb at \d+ m$/.test(m))).toBe(true);
    });

    it('lists the jumps with lip, take-off speed and flight, and asks for minJumps', () => {
        const withRamp = { ...LOOP, minJumps: 2, ramps: [{ edge: 'bc', s: 100, length: 10, height: 1.5 }] };
        const { findings, stats } = checkTrack(square(), big, withRamp);
        expect(messages(findings)).toEqual(['track loop: 1 working jumps, needs 2']);
        expect(stats!.jumps).toHaveLength(1);
        const jump = stats!.jumps[0];
        expect(jump).toMatchObject({ x: 200, z: 100, lip: 1.5 });
        // Lap stations: ab1 0..76, M1 ..100, ab2 ..176, B's corner (6π)
        // ..194.85, bc from its s = 12: s = 100 is station 194.85 + 88
        expect(jump.s).toBeCloseTo(282.85, 1);
        // h / L = 0.15 from 1.5 m: 0.51 s at 15 m/s .. 0.78 s at 40 m/s
        expect(jump.speed).toBeGreaterThan(15 * 3.6);
        expect(jump.airtime).toBeGreaterThan(0.5);
        expect(jump.airtime).toBeLessThan(0.8);
    });

    it('reports a jump landing in a bend and a lip the slope eats', () => {
        const late = checkTrack(square(), big, { ...LOOP, ramps: [{ edge: 'bc', s: 175, length: 10, height: 1.5 }] });
        expect(messages(late.findings)).toEqual([expect.stringMatching(/^track loop: ramp at s = 175 on bc: lands in a bend \(R \d+ m, \d+ m after the ramp\)$/)]);
        // bc runs south (+z): ground rising 12 % southwards takes 1.2 m of 1.5
        const rising = field((_, z) => 5 + 0.12 * Math.max(0, Math.min(200, z)), { ...SPEC, cols: 201, rows: 201 });
        const eaten = checkTrack(square(), rising, { ...LOOP, ramps: [{ edge: 'bc', s: 100, length: 10, height: 1.5 }] });
        expect(messages(eaten.findings)).toContainEqual(expect.stringMatching(/^track loop: ramp at s = 100 on bc: lip 0\.30 m /));
    });

    it('measures the flow: longest straight and bends per km; race tracks keep the limits, bonus tracks do not', () => {
        const { stats } = checkTrack(square(), big, LOOP);
        // Straights of 176 m (bc, and ab1 + M1 + ab2 = 76 + 24 + 76), four
        // corners per lap of 656 + 48 + 24π = 779.4 m: 5.1 per km
        expect(stats!.longestStraight).toBeGreaterThan(174);
        expect(stats!.longestStraight).toBeLessThan(178);
        expect(stats!.bendsPerKm).toBeCloseTo(4 / 0.7794, 1);
        // A 600 m straight sprint
        const long = net(network([node('a', 0, 0), node('b', 700, 0)], [edge('ab', 'a', 'b')]));
        const wide = field(() => 5, { ...SPEC, cols: 451, rows: 101, originX: -50, originZ: -100 });
        const sprint: TrackRoute = { ...LOOP, kind: 'sprint', laps: 1, route: ['ab'], start: { edge: 'ab', s: 50 }, finish: { edge: 'ab', s: 650 } };
        expect(messages(checkTrack(long, wide, sprint).findings)).toEqual([
            'track loop: straight of 600 m, at most 450 m',
            'track loop: 0.0 bends per km, at least 3'
        ]);
        expect(checkTrack(long, wide, { ...sprint, bonus: true }).findings).toEqual([]);
    });

    it('reports grid slots closer than 6 m on a narrow road and warns about oblique barrier rows', () => {
        const narrow = net(network(
            [
                node('a', 0, 0, 'junction'), node('m1', 100, 0, 'junction'), node('b', 200, 0, 'junction'),
                node('c', 200, 200, 'junction'), node('m2', 100, 200, 'junction'), node('d', 0, 200, 'junction'), node('x', 150, 60)
            ],
            [
                edge('ab1', 'a', 'm1'), edge('ab2', 'm1', 'b'), edge('bc', 'b', 'c'), edge('cd1', 'c', 'm2'),
                edge('cd2', 'm2', 'd'), edge('da', 'd', 'a'), edge('cross', 'm1', 'm2'), edge('diag', 'm1', 'x')
            ],
            { profiles: { road: { ...PROFILE, width: 7 } } }
        ));
        const { findings } = checkTrack(narrow, big, LOOP);
        // Lanes ±1.75 m, 4 m apart: √(3.5² + 4²) = 5.3 m between neighbours
        expect(findings.filter(f => f.message.includes('closer than 6 m'))).toHaveLength(7);
        // The branch to x leaves M1 at 50° south-east of the road
        expect(findings.filter(f => f.severity === 'warning').map(f => f.message))
            .toEqual(['track loop: 1 barrier rows are not along an axis (obox colliders, M3)']);
    });

    it('averages the climb of a circuit per lap and names the slowest and fastest class', () => {
        // 5 % up towards +x: each lap climbs about 0.05 · 186 m on bc's side
        // and the corners, the same down on da's side
        const slope = field(x => 5 + 0.05 * Math.max(0, x), { ...SPEC, cols: 201, rows: 201 });
        const { stats } = checkTrack(square(), slope, LOOP);
        expect(stats!.climb).toBeGreaterThan(9);
        expect(stats!.climb).toBeLessThan(10.5);
        expect(stats!.descent).toBeCloseTo(stats!.climb, 1);
        expect(stats!.slowest.car).not.toBe(stats!.fastest.car);
        expect(stats!.slowest.time).toBeGreaterThan(stats!.fastest.time);
    });

    it('measures the climb of a sprint between start and finish', () => {
        // 5 % up along x; the sprint A → B runs from x = 50 to x = 180
        const slope = field(x => 5 + 0.05 * Math.max(0, x), { ...SPEC, cols: 201, rows: 201 });
        const { stats } = checkTrack(square(), slope, {
            ...LOOP, kind: 'sprint', laps: 1, route: ['ab1', 'ab2'], start: { edge: 'ab1', s: 50 }, finish: { edge: 'ab2', s: 80 }
        });
        expect(stats!.length).toBeCloseTo(130, 6);
        expect(stats!.climb).toBeCloseTo(0.05 * 130, 1);
        expect(stats!.descent).toBeCloseTo(0, 6);
    });
});

describe('validateMap', () => {
    it('collects the findings of every check and the tracks it could resolve', () => {
        const result = validateMap({
            net: square(),
            map: { format: 'bulli-map', version: 1, mapId: 'test', mapVersion: 1, name: 'T', boundary: [[-50, -50], [150, -50], [150, 250], [-50, 250]] },
            zones: { format: 'bulli-zones', version: 1, mapId: 'test', zones: [] },
            pois: { ...validPois(), arena: { ...validPois().arena, area: 'none' } },
            tracks: { format: 'bulli-tracks', version: 1, mapId: 'test', tracks: [LOOP, { ...LOOP, id: 'broken', route: ['ab1'] }] },
            hf: field(() => 5, { ...SPEC, cols: 201, rows: 201 })
        });
        const checks = new Set(result.findings.map(f => f.check));
        expect([...checks].sort()).toEqual(['boundary', 'pois', 'tracks']);
        expect(result.findings.some(f => f.message.startsWith('track broken:'))).toBe(true);
        expect(result.tracks.map(t => t.id)).toEqual(['loop']);
        expect(result.routes.map(r => r.track.id)).toEqual(['loop']);
    });

    it('sums the road length per surface', () => {
        const file = network(
            [node('a', 0, 0), node('b', 100, 0, 'junction'), node('c', 100, 60)],
            [edge('ab', 'a', 'b'), edge('bc', 'b', 'c', [], { profile: 'dirt' })]
        );
        const result = validateMap({
            net: net(file),
            map: { format: 'bulli-map', version: 1, mapId: 'test', mapVersion: 1, name: 'T', boundary: [[-50, -50], [200, -50], [200, 200], [-50, 200]] },
            zones: { format: 'bulli-zones', version: 1, mapId: 'test', zones: [] },
            pois: validPois(),
            tracks: { format: 'bulli-tracks', version: 1, mapId: 'test', tracks: [] },
            hf: FLAT
        });
        expect(result.roads.km).toBeCloseTo(0.16, 9);
        expect(result.roads.pavedKm).toBeCloseTo(0.1, 9);
        expect(result.roads.bySurface).toEqual({ asphalt: expect.closeTo(0.1, 9), dirt: expect.closeTo(0.06, 9) });
    });
});
