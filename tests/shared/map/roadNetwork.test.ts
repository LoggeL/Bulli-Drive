import { describe, expect, it } from 'vitest';
import {
    buildRoadNetwork, DEFAULT_ROUNDABOUT_RADIUS, isOnRoad, junctionRadius, nearestRoad, roadChains,
    roadSurfaceAt
} from '../../../src/shared/map/roadNetwork.js';
import { parseZonesFile } from '../../../src/shared/map/mapFiles.js';
import { parseRoadNetwork, validateRoadNetwork } from '../../../src/shared/map/roadSchema.js';
import { edge, network, node, PROFILE } from './fixtures.js';

// roads.json schema and checks, and the corridor queries on hand-built
// networks (docs/phase-3-design.md, 5.2 to 5.4)

describe('roads.json schema', () => {
    const valid = network([node('a', 0, 0), node('b', 100, 0)], [edge('ab', 'a', 'b')]);

    it('accepts a minimal network', () => {
        const parsed = parseRoadNetwork(JSON.parse(JSON.stringify(valid)));
        expect(parsed.ok).toBe(true);
    });

    it('rejects unknown keys instead of silently using defaults', () => {
        const typo = JSON.parse(JSON.stringify(valid));
        typo.profiles.road.shoulders = 2;
        const parsed = parseRoadNetwork(typo);
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) expect(parsed.errors.join()).toMatch(/profiles\.road/);
    });

    it('rejects bad values with their path', () => {
        const bad = JSON.parse(JSON.stringify(valid));
        bad.edges[0].maxGrade = 0.5;
        bad.nodes[0].kind = 'bridge';
        const parsed = parseRoadNetwork(bad);
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) {
            expect(parsed.errors.some(e => e.startsWith('edges.0.maxGrade'))).toBe(true);
            expect(parsed.errors.some(e => e.startsWith('nodes.0.kind'))).toBe(true);
        }
    });

    it('finds broken references, node kinds and ranges', () => {
        const errors = validateRoadNetwork(network(
            [node('a', 0, 0), node('b', 100, 0, 'joint'), node('c', 200, 0), node('a', 5, 5), node('lonely', 9, 9, 'junction'),
                node('d', 0, 50), node('e', 100, 50)],
            [
                edge('ab', 'a', 'b', [], { rails: [{ side: 'left', from: 20, to: 10, kind: 'wbeam' }] }),
                edge('bx', 'b', 'x'),
                edge('ac', 'a', 'c', [], { profile: 'nope' }),
                edge('de', 'd', 'e', [[0.3, 50]])
            ]
        ));
        expect(errors).toEqual(expect.arrayContaining([
            'node a: duplicate id',
            'edge bx: unknown to node x',
            'edge ac: unknown profile nope',
            'edge de: support points 0 and 1 closer than 0.5 m',
            'edge ab: range 20..10 is empty (use to = -1 for the edge end)',
            // ab and ac both start at a
            'node a: an end needs exactly 1 edge end, has 2'
        ]));
        expect(errors).toContain('node lonely: junction without edges');
        // b has two ends (ab, bx): a valid joint
        expect(errors.some(e => e.startsWith('node b'))).toBe(false);
    });

    it('checks where Bézier segments end', () => {
        const errors = validateRoadNetwork(network([node('a', 0, 0), node('b', 100, 0)], [
            { ...edge('ab', 'a', 'b'), curve: { type: 'bezier', segments: [{ c1: [10, 0], c2: [20, 0] }, { c1: [60, 0], c2: [90, 0], to: [100, 0] }] } }
        ]));
        expect(errors).toEqual([
            'edge ab: Bézier segment 0 needs "to"',
            'edge ab: the last Bézier segment ends at node b, drop its "to"'
        ]);
    });

    it('parses zones.json and rejects duplicate ids', () => {
        const zone = { id: 'z', zone: 'downtown', polygon: [[0, 0], [1, 0], [0, 1]] };
        const zones = { format: 'bulli-zones', version: 1, mapId: 'test', zones: [zone] };
        expect(parseZonesFile(zones).ok).toBe(true);
        expect(parseZonesFile({ ...zones, zones: [zone, zone] })).toEqual({ ok: false, errors: ['zone z: duplicate id'] });
        expect(parseZonesFile({ ...zones, zones: [{ ...zone, zone: 'moon' }] }).ok).toBe(false);
    });

    it('refuses to build an invalid network', () => {
        expect(() => buildRoadNetwork(network([node('a', 0, 0)], [edge('ab', 'a', 'b')]))).toThrow(/unknown to node b/);
    });
});

describe('nearestRoad', () => {
    // East-west road from (0, 0) to (100, 0), 10 m wide
    // Built inside each test, not while collecting them: Stryker only
    // activates a mutant while a test runs
    const build = () => {
        const net = buildRoadNetwork(network([node('w', 0, 0), node('e', 100, 0)], [edge('main', 'w', 'e')]));
        return { net };
    };

    it('projects onto the centre line with station, distance and side', () => {
        const { net } = build();
        // North of the road (-z) is left of the direction east
        const hit = nearestRoad(net, 30.5, -4)!;
        expect(hit.edge.id).toBe('main');
        expect(hit.s).toBeCloseTo(30.5, 9);
        expect(hit.x).toBeCloseTo(30.5, 9);
        expect(hit.z).toBeCloseTo(0, 9);
        expect(hit.distance).toBeCloseTo(4, 9);
        expect(hit.lateral).toBeCloseTo(4, 9);
        expect(hit.tx).toBeCloseTo(1, 12);
        expect(nearestRoad(net, 70, 3)!.lateral).toBeCloseTo(-3, 9);
    });

    it('clamps to the end of the road', () => {
        const { net } = build();
        const hit = nearestRoad(net, 106, 8)!;
        expect(hit.s).toBeCloseTo(100, 9);
        expect(hit.distance).toBeCloseTo(10, 9);
    });

    it('finds nothing beyond the search distance', () => {
        const { net } = build();
        expect(nearestRoad(net, 50, 60, 50)).toBeNull();
        expect(nearestRoad(net, 50, 49, 50)!.distance).toBeCloseTo(49, 9);
    });

    it('picks the closer of two roads', () => {
        const two = buildRoadNetwork(network(
            [node('a', 0, 0), node('b', 100, 0), node('c', 0, 30), node('d', 100, 30)],
            [edge('north', 'a', 'b'), edge('south', 'c', 'd')]
        ));
        expect(nearestRoad(two, 50, 14)!.edge.id).toBe('north');
        expect(nearestRoad(two, 50, 16)!.edge.id).toBe('south');
        // Exactly halfway: the lower edge index wins
        expect(nearestRoad(two, 50, 15)!.edge.id).toBe('north');
    });

    it('projects onto a curved road: station, side and tangent of the arc', () => {
        // Quarter circle R = 100 from the origin heading east, turning left
        // (north) around the centre (0, -100)
        const R = 100, k = 0.5522847498 * R;
        const arc = buildRoadNetwork(network([node('a', 0, 0), node('b', R, -R)], [
            { ...edge('arc', 'a', 'b'), curve: { type: 'bezier', segments: [{ c1: [k, 0], c2: [R, -R + k] }] } }
        ]));
        const c = Math.SQRT1_2;
        // 4 m inside the bend at 45°, the curve's axis of symmetry
        const hit = nearestRoad(arc, (R - 4) * c, -R + (R - 4) * c)!;
        // Symmetric curve: the 45° point is at half its length. The Bézier
        // circle is within 3 cm of the true one.
        expect(hit.s).toBeCloseTo(arc.edges[0].length / 2, 1);
        expect(hit.distance).toBeCloseTo(4, 1);
        // The inside of a left bend is on the left
        expect(hit.lateral).toBeCloseTo(4, 1);
        // lateral uses the interpolated tangent, distance the chord: < 1 µm apart
        expect(hit.lateral).toBeCloseTo(hit.distance, 5);
        // Heading north-east: (cos 45°, -sin 45°)
        expect(hit.tx).toBeCloseTo(c, 3);
        expect(hit.tz).toBeCloseTo(-c, 3);
        expect(hit.x).toBeCloseTo(R * c, 1);
        expect(hit.z).toBeCloseTo(-R + R * c, 1);
    });
});

describe('roadSurfaceAt and isOnRoad', () => {
    // Built inside each test, not while collecting them: Stryker only
    // activates a mutant while a test runs
    const build = () => {
        const net = buildRoadNetwork(network(
            [node('w', 0, 0), node('e', 100, 0), node('n', 50, -60), node('s', 50, -20)],
            [edge('main', 'w', 'e'), edge('track', 'n', 's', [], { profile: 'dirt' })],
            {
                areas: [
                    { id: 'lot', polygon: [[80, -20], [120, -20], [120, 20], [80, 20]], surface: 'concrete', curb: false, connects: [] },
                    { id: 'pier', polygon: [[0, -2], [-50, -2], [-50, 2], [0, 2]], surface: 'wood', curb: false, connects: [] }
                ]
            }
        ));
        return { net };
    };

    it('is the road surface within half the width', () => {
        const { net } = build();
        expect(roadSurfaceAt(net, 30, 4.9)).toEqual({ surface: 'asphalt', edge: 'main' });
        expect(roadSurfaceAt(net, 30, -4.9)?.surface).toBe('asphalt');
        expect(roadSurfaceAt(net, 30, 5.1)).toBeNull();
        expect(isOnRoad(net, 30, 5.1)).toBe(false);
        // The dirt track is 6 m wide
        expect(roadSurfaceAt(net, 52.9, -40)).toEqual({ surface: 'dirt', edge: 'track' });
        expect(isOnRoad(net, 53.1, -40)).toBe(false);
    });

    it('lets the higher priority of table 8.1 win where claims overlap', () => {
        const { net } = build();
        // Asphalt (9) over concrete (8) where the road enters the lot
        expect(roadSurfaceAt(net, 90, 0)).toEqual({ surface: 'asphalt', edge: 'main' });
        // Inside the lot, off the road
        expect(roadSurfaceAt(net, 90, 15)).toEqual({ surface: 'concrete', area: 'lot' });
        // Wood (10) over asphalt at the pier's start
        expect(roadSurfaceAt(net, -0.5, 0)).toEqual({ surface: 'wood', area: 'pier' });
        expect(roadSurfaceAt(net, 0.5, 0)).toEqual({ surface: 'asphalt', edge: 'main' });
        // Asphalt (9) over dirt (5) where the track meets the road
        expect(roadSurfaceAt(net, 51, -2)?.surface).toBe('asphalt');
    });

    it('prefers an area over a road of the same surface, then the earlier area', () => {
        const square = { id: 'square', polygon: [[20, -10], [40, -10], [40, 10], [20, 10]] as [number, number][], surface: 'asphalt' as const, curb: false, connects: [] };
        const both = buildRoadNetwork(network([node('w', 0, 0), node('e', 100, 0)], [edge('main', 'w', 'e')], {
            areas: [square, { ...square, id: 'square-2' }]
        }));
        expect(roadSurfaceAt(both, 30, 0)).toEqual({ surface: 'asphalt', area: 'square' });
    });

    it('searches as far as the widest road reaches', () => {
        // A 60 m wide boulevard and, 200 m further south, a 10 m road (so the
        // query lies inside the index, not clamped onto its border cells)
        const wide = buildRoadNetwork(network(
            [node('w', 0, 400), node('e', 100, 400), node('w2', 0, 200), node('e2', 100, 200)],
            [edge('narrow', 'w', 'e'), edge('boulevard', 'w2', 'e2', [], { overrides: { width: 60 } })]
        ));
        expect(roadSurfaceAt(wide, 50, 229)).toEqual({ surface: 'asphalt', edge: 'boulevard' });
        expect(roadSurfaceAt(wide, 50, 231)).toBeNull();
    });
});

describe('junctionRadius', () => {
    // Built inside each test, not while collecting them: Stryker only
    // activates a mutant while a test runs
    const build = () => {
        const file = network(
            [node('j', 0, 0, 'junction'), node('a', -100, 0), node('b', 100, 0), node('c', 0, 100),
                node('r', 0, -200, 'junction', { junction: { shape: 'roundabout', control: 'yield', crosswalks: false } }),
                node('x', 200, -200, 'junction', { junction: { shape: 'auto', radius: 11, control: 'none', crosswalks: false } })],
            [edge('ja', 'j', 'a'), edge('jb', 'j', 'b', [], { overrides: { width: 16 } }), edge('jc', 'j', 'c', [], { profile: 'dirt' }),
                edge('rj', 'r', 'j'), edge('xr', 'x', 'r')]
        );
        const net = buildRoadNetwork(file);
        return { net };
    };

    it('is half the widest incident road plus 2 m, or the configured radius', () => {
        const { net } = build();
        expect(junctionRadius(net, net.nodeById.get('j')!)).toBe(16 / 2 + 2);
        expect(junctionRadius(net, net.nodeById.get('r')!)).toBe(DEFAULT_ROUNDABOUT_RADIUS);
        expect(junctionRadius(net, net.nodeById.get('x')!)).toBe(11);
        expect(junctionRadius(net, net.nodeById.get('a')!)).toBe(0);
    });

    it('resolves profile overrides per edge', () => {
        const { net } = build();
        expect(net.edgeById.get('jb')!.profile.width).toBe(16);
        expect(net.edgeById.get('jb')!.profile.surface).toBe(PROFILE.surface);
        expect(net.edgeById.get('ja')!.halfWidth).toBe(5);
    });
});

describe('roadChains', () => {
    it('joins edges through joints, whatever their direction', () => {
        // a -e1-> j1 <-e2- j2 -e3-> k (junction) -e4-> z
        const net = buildRoadNetwork(network(
            [node('a', 0, 0), node('j1', 100, 0, 'joint'), node('j2', 200, 0, 'joint'),
                node('k', 300, 0, 'junction'), node('z', 400, 0), node('y', 300, 100)],
            [edge('e1', 'a', 'j1'), edge('e2', 'j2', 'j1'), edge('e3', 'j2', 'k'), edge('e4', 'k', 'z'), edge('e5', 'k', 'y')]
        ));
        const chains = roadChains(net);
        const describe = chains.map(c => c.parts.map(p => (p.reversed ? '-' : '') + net.edges[p.edge].id).join(' '));
        expect(describe).toEqual(['e1 -e2 e3', 'e4', 'e5']);
        expect(net.nodes[chains[0].startNode].id).toBe('a');
        expect(net.nodes[chains[0].endNode].id).toBe('k');
        expect(chains[0].length).toBeCloseTo(300, 6);
        expect(chains[0].closed).toBe(false);
    });

    it('finds a chain that starts in the middle and closes a ring of joints', () => {
        const net = buildRoadNetwork(network(
            [node('p', 0, 0, 'joint'), node('q', 100, 0, 'joint'), node('r', 50, 80, 'joint')],
            [edge('pq', 'p', 'q'), edge('qr', 'q', 'r'), edge('rp', 'r', 'p')]
        ));
        const chains = roadChains(net);
        expect(chains).toHaveLength(1);
        expect(chains[0].closed).toBe(true);
        expect(chains[0].parts.map(p => net.edges[p.edge].id)).toEqual(['pq', 'qr', 'rp']);
        expect(chains[0].startNode).toBe(chains[0].endNode);
    });

    it('extends a chain backwards from an edge in its middle', () => {
        // e1 is listed after e0, but walked first: e0 must come before it
        const net = buildRoadNetwork(network(
            [node('a', 0, 0), node('m', 100, 0, 'joint'), node('b', 200, 0)],
            [edge('e1', 'm', 'b'), edge('e0', 'a', 'm')]
        ));
        const chains = roadChains(net);
        expect(chains.map(c => c.parts.map(p => net.edges[p.edge].id))).toEqual([['e0', 'e1']]);
        expect(net.nodes[chains[0].startNode].id).toBe('a');
    });
});
