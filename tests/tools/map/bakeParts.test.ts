import { describe, expect, it } from 'vitest';
import { decodeHeightfield, surfaceAt, zoneAt, type GridSpec } from '../../../src/shared/map/heightfield.js';
import type { MapFile, ZonesFile } from '../../../src/shared/map/mapFiles.js';
import { buildRoadNetwork, roadChains } from '../../../src/shared/map/roadNetwork.js';
import { SURFACE, ZONE } from '../../../src/shared/map/types.js';
import { areaMeanHeight, bakeTerrain, corridorLine, roadProfiles, sampleGrid, type BakeInput } from '../../../tools/map/bakeTerrain.js';
import { fnv1a128 } from '../../../tools/map/hash.js';
import { edge, network, node, PROFILE } from '../../shared/map/fixtures.js';
import { FLAT_COAST } from './fixtures.js';

// The parts of the bake (tools/map/bakeTerrain.ts, docs/phase-3-design.md
// 6.4) on grids small enough to work out by hand: the bilinear lookup of
// the natural ground, the mean height of an area, the corridor polyline of
// a chain with walls and edges walked backwards, the height profiles of
// chains with plateaus and pins, the report and the ground classes.

// 3 columns × 2 rows, 2 m apart, from (10 | 20): values chosen so that a
// swapped axis or a wrong row offset gives a different number
const SMALL: GridSpec = {
    cols: 3, rows: 2, cellSize: 2, originX: 10, originZ: 20,
    heightOffset: -20, heightScale: 0.01, waterLevel: 0, zoneCell: 2
};
// row z = 20: 1, 2, 4; row z = 22: 8, 16, 32
const VALUES = Float64Array.from([1, 2, 4, 8, 16, 32]);

describe('sampleGrid', () => {
    it('returns the grid values at the grid points', () => {
        expect(sampleGrid(SMALL, VALUES, 10, 20)).toBe(1);
        expect(sampleGrid(SMALL, VALUES, 14, 20)).toBe(4);
        expect(sampleGrid(SMALL, VALUES, 12, 22)).toBe(16);
        expect(sampleGrid(SMALL, VALUES, 14, 22)).toBe(32);
    });

    it('interpolates bilinearly inside a cell: x first, then z', () => {
        // Cell (1, 0): 2, 4 / 16, 32. At fx = 0.25, fz = 0.5:
        // top 2 + 2·0.25 = 2.5, bottom 16 + 16·0.25 = 20, mean 11.25
        expect(sampleGrid(SMALL, VALUES, 12.5, 21)).toBe(11.25);
        // Cell (0, 0) at fx = 0.5, fz = 0.25: top 1.5, bottom 12, 1.5 + 10.5·0.25
        expect(sampleGrid(SMALL, VALUES, 11, 20.5)).toBe(1.5 + 10.5 * 0.25);
    });

    it('clamps outside the grid to the border', () => {
        expect(sampleGrid(SMALL, VALUES, 0, 0)).toBe(1);
        expect(sampleGrid(SMALL, VALUES, 100, 100)).toBe(32);
        expect(sampleGrid(SMALL, VALUES, 100, 21)).toBe(4 + (32 - 4) * 0.5);
    });
});

describe('areaMeanHeight', () => {
    // 4 × 3 points from (0 | 0), 2 m apart: value = 10·i + j
    const spec: GridSpec = { ...SMALL, cols: 4, rows: 3, originX: 0, originZ: 0 };
    const values = new Float64Array(12);
    for (let j = 0; j < 3; j++) for (let i = 0; i < 4; i++) values[j * 4 + i] = 10 * i + j;

    it('averages the grid points inside the polygon', () => {
        // Points (2 | 0), (4 | 0), (2 | 2), (4 | 2): 10, 20, 11, 21
        expect(areaMeanHeight(spec, values, [[1, -1], [5, -1], [5, 3], [1, 3]])).toBe(15.5);
        // Offset box covering only (6 | 4): 32
        expect(areaMeanHeight(spec, values, [[5, 3], [7, 3], [7, 5], [5, 5]])).toBe(32);
    });

    it('takes the ground at the first vertex when the polygon holds no grid point', () => {
        // Between (2 | 2) = 11, (4 | 2) = 21, (2 | 4) = 12, (4 | 4) = 22 at the middle: 16.5
        expect(areaMeanHeight(spec, values, [[3, 3], [3.5, 3], [3.5, 3.5]])).toBe(16.5);
    });
});

describe('corridorLine', () => {
    // Two edges meeting at a joint (0 | 0): west from (-40 | 0), and east
    // drawn from (40 | 0) towards the joint, so the chain walks it
    // backwards. The east edge has a wall on its left (north when drawn
    // westwards) from s = 10 to 20 and a 5 m sidewalk on its left.
    const build = () => buildRoadNetwork(network(
        [node('w', -40, 0), node('m', 0, 0, 'joint'), node('e', 40, 0)],
        [
            edge('west', 'w', 'm'),
            edge('east', 'e', 'm', [], { walls: [{ side: 'left', from: 10, to: 20 }], overrides: { sidewalk: { left: 5, right: 0 } } })
        ]
    ));

    it('joins the chain once at the joint and swaps left and right on the edge walked backwards', () => {
        const net = build();
        const [chain] = roadChains(net);
        const heights = new Map([['west', new Float64Array(41).fill(1)], ['east', new Float64Array(41).fill(2)]]);
        const line = corridorLine(net, chain, heights);
        // 41 samples of west, then 40 of east without the shared joint sample
        expect(line.x).toHaveLength(81);
        expect(line.x[0]).toBe(-40);
        expect(line.x[80]).toBe(40);
        expect(line.y[40]).toBe(1);
        expect(line.y[41]).toBe(2);
        // East is walked eastwards: its left (sidewalk 5 → 5 + 5 = 10) is
        // the chain's right, its right (4 m flat margin → 9) the chain's left
        expect(line.halfLeft[60]).toBe(9);
        expect(line.halfRight[60]).toBe(10);
        expect(line.halfLeft[20]).toBe(9);
        expect(line.halfRight[20]).toBe(9);
    });

    it('marks the wall on the side it stands on, only within its range', () => {
        const net = build();
        const [chain] = roadChains(net);
        const heights = new Map([['west', new Float64Array(41)], ['east', new Float64Array(41)]]);
        const line = corridorLine(net, chain, heights);
        // East sample s lies at x = 40 - s, chain index 80 - s
        const at = (s: number) => 80 - s;
        for (const s of [10, 15, 20]) {
            expect(line.wallRight![at(s)], `s ${s}`).toBe(1);
            expect(line.wallLeft![at(s)], `s ${s}`).toBe(0);
        }
        for (const s of [9, 21, 35]) expect(line.wallRight![at(s)], `s ${s}`).toBe(0);
        for (let i = 0; i <= 40; i++) expect(line.wallRight![i]).toBe(0);
        // Road surface stamped over the drivable width + 1 m
        expect(line.surface![10]).toBe(SURFACE.asphalt);
        expect(line.surfaceHalf![10]).toBe(PROFILE.width / 2 + 1);
    });
});

// Natural ground rising towards the east: 4 % west of x = 0, 10 % east of it
const SPEC: GridSpec = {
    cols: 101, rows: 41, cellSize: 2, originX: -100, originZ: -40,
    heightOffset: -20, heightScale: 0.01, waterLevel: 0, zoneCell: 8
};
function slope(): Float64Array {
    const h = new Float64Array(SPEC.cols * SPEC.rows);
    for (let j = 0; j < SPEC.rows; j++) {
        for (let i = 0; i < SPEC.cols; i++) {
            const x = SPEC.originX + i * 2;
            h[j * SPEC.cols + i] = 20 + (x < 0 ? 0.04 * x : 0.1 * x);
        }
    }
    return h;
}

describe('roadProfiles', () => {
    it('holds a junction plateau over the trim radius or the widest flat zone, whichever is longer', () => {
        // A junction at (0 | 0) with a road west, one east and one north;
        // the east one has 6 m sidewalks: flat zone 5 + 6 = 11 m > trim 7 m
        const net = buildRoadNetwork(network(
            [node('w', -90, 0), node('j', 0, 0, 'junction'), node('e', 90, 0), node('n', 0, -70)],
            [edge('west', 'w', 'j'), edge('east', 'j', 'e', [], { overrides: { sidewalk: { left: 6, right: 6 } }, maxGrade: 0.12 }), edge('north', 'j', 'n')]
        ));
        const { heights } = roadProfiles(net, SPEC, slope());
        const east = heights.get('east')!, west = heights.get('west')!;
        const y = east[0];
        // Flat for 11 m on every road leaving the junction
        expect(east[10]).toBeCloseTo(y, 9);
        expect(west[west.length - 1 - 10]).toBeCloseTo(y, 9);
        // Then climbing / falling with the ground (rounded, so a little later)
        expect(east[40] - y).toBeGreaterThan(0.5);
        expect(y - west[west.length - 1 - 40]).toBeGreaterThan(0.5);
    });

    it('meets a pin on an edge walked backwards at its own station, and gives every edge its own grade', () => {
        // A chain of two edges through a joint: 'up' drawn from the west end
        // to the joint, 'back' drawn from the east end to the joint (walked
        // backwards). Pin on 'back' at its s = 20 (x = 70, natural 27 m).
        const net = buildRoadNetwork(network(
            [node('a', -90, 0), node('m', 0, 0, 'joint'), node('b', 90, 0)],
            [
                edge('up', 'a', 'm', [], { maxGrade: 0.06 }),
                edge('back', 'b', 'm', [], { elevation: [{ s: 20, y: 28 }], maxGrade: 0.12 })
            ]
        ));
        const { heights, reports } = roadProfiles(net, SPEC, slope());
        const back = heights.get('back')!, up = heights.get('up')!;
        expect(reports).toHaveLength(1);
        expect(reports[0]).toMatchObject({ edges: ['up', 'back'], infeasible: 0 });
        expect(reports[0].length).toBeCloseTo(180, 9);
        // A point pin counts at the nearest station of the chain: 180 m in
        // 181 steps of 0.9945 m puts it 0.11 m off, at most 12 % → 1.3 cm
        expect(Math.abs(back[20] - 28)).toBeLessThan(0.014);
        // 'up' keeps its 6 % on the 4 % ground (the station step across the
        // joint takes the grade of the edge its middle lies on, so the last
        // metre before the joint may be steeper); 'back' climbs the 10 %
        let upMax = 0, backMax = 0;
        for (let i = 1; i < up.length - 2; i++) upMax = Math.max(upMax, Math.abs(up[i] - up[i - 1]));
        for (let i = 1; i < back.length; i++) backMax = Math.max(backMax, Math.abs(back[i] - back[i - 1]));
        expect(upMax).toBeLessThanOrEqual(0.06 + 1e-9);
        expect(backMax).toBeGreaterThan(0.07);
    });

    it('holds a road level with its area until the road and its flat zone are clear of the area', () => {
        // Area x -100 .. -60 at y = 15 around the end node a (-90 | 0); the road
        // leaves it after 29-30 m, then its flat zone (9 m) and the margin (4 m):
        // level for 42-43 m. Drawn from a and drawn towards a (walked backwards).
        const area = { id: 'lot', polygon: [[-100, -20], [-60, -20], [-60, 20], [-100, 20]] as [number, number][], surface: 'concrete' as const, curb: false, connects: ['a'] };
        for (const [id, from, to] of [['ab', 'a', 'b'], ['ba', 'b', 'a']]) {
            const net = buildRoadNetwork(network([node('a', -90, 0), node('b', 90, 0)], [edge(id, from, to, [], { maxGrade: 0.12 })], { areas: [area] }));
            const h = roadProfiles(net, SPEC, slope(), [15]).heights.get(id)!;
            const atA = (s: number) => (id === 'ab' ? h[s] : h[h.length - 1 - s]);
            for (const s of [0, 20, 30, 40]) expect(atA(s), `${id} ${s}`).toBeCloseTo(15, 6);
            // and then climbs towards the 29 m ground at b
            expect(atA(80)).toBeGreaterThan(16);
        }
    });

    it('closes a ring of joints at its node height', () => {
        // Four edges round a square through joints; the first node fixed at 30 m
        const net = buildRoadNetwork(network(
            [node('p', -50, -20, 'joint', { y: 30 }), node('q', 50, -20, 'joint'), node('r', 50, 20, 'joint'), node('t', -50, 20, 'joint')],
            [edge('pq', 'p', 'q', [], { maxGrade: 0.12 }), edge('qr', 'q', 'r', [], { maxGrade: 0.12 }), edge('rt', 'r', 't', [], { maxGrade: 0.12 }), edge('tp', 't', 'p', [], { maxGrade: 0.12 })]
        ));
        const { heights, chains } = roadProfiles(net, SPEC, slope());
        expect(chains).toHaveLength(1);
        expect(chains[0].closed).toBe(true);
        const pq = heights.get('pq')!, tp = heights.get('tp')!;
        expect(pq[0]).toBeCloseTo(30, 6);
        expect(tp[tp.length - 1]).toBeCloseTo(30, 6);
    });

    it('closes a ring without a fixed height at the mean of its smoothed ends', () => {
        const net = buildRoadNetwork(network(
            [node('p', -50, -20, 'joint'), node('q', 50, -20, 'joint'), node('r', 50, 20, 'joint'), node('t', -50, 20, 'joint')],
            [edge('pq', 'p', 'q', [], { maxGrade: 0.12 }), edge('qr', 'q', 'r', [], { maxGrade: 0.12 }), edge('rt', 'r', 't', [], { maxGrade: 0.12 }), edge('tp', 't', 'p', [], { maxGrade: 0.12 })]
        ));
        const { heights } = roadProfiles(net, SPEC, slope());
        const pq = heights.get('pq')!, tp = heights.get('tp')!;
        // Both ends of the ring are (-50 | -20), natural 18 m; the 60 m
        // average reaches 30 m along each side: along pq towards the east
        // (18 .. 19.2 m, mean ≈ 18.6), along tp along the west side (18 m):
        // the ring closes at their mean, about 18.3 m
        expect(pq[0]).toBeCloseTo(tp[tp.length - 1], 9);
        expect(pq[0]).toBeGreaterThan(18.05);
        expect(pq[0]).toBeLessThan(18.6);
    });
});

// ---- The bake's report and ground classes on a 400 m map ----

const MAP: MapFile = {
    format: 'bulli-map', version: 1, mapId: 'test', mapVersion: 5, name: 'Test',
    boundary: [[-200, -200], [200, -200], [200, 200], [-200, 200]]
};
const NO_ZONES: ZonesFile = { format: 'bulli-zones', version: 1, mapId: 'test', zones: [] };
const GRID: GridSpec = {
    cols: 201, rows: 201, cellSize: 2, originX: -200, originZ: -200,
    heightOffset: -20, heightScale: 0.01, waterLevel: 0, zoneCell: 8
};

function input(over: Partial<BakeInput>): BakeInput {
    return {
        roads: network([node('a', 100, -150), node('b', 100, 150)], [edge('road', 'a', 'b')]),
        map: MAP, zones: NO_ZONES, base: FLAT_COAST, spec: GRID,
        sourceHash: fnv1a128(new TextEncoder().encode('parts')), ...over
    };
}

describe('bakeTerrain report', () => {
    it('reports heights, road length, surface counts and the steepest baked grade with its edge', () => {
        const result = bakeTerrain(input({
            roads: network(
                [node('a', 100, -150), node('b', 100, 150), node('c', 150, -150), node('d', 150, 150), node('e', 50, -150), node('f', 50, 150)],
                [edge('road', 'a', 'b'), edge('steep', 'c', 'd', [], { profile: 'dirt', maxGrade: 0.18, elevation: [{ s: 100, y: 14 }, { s: 200, y: 24 }] }),
                    // listed last and level: the steepest edge is not the last one looked at
                    edge('level', 'e', 'f')]
            )
        }));
        const r = result.report;
        // Sea floor -10 m at the western edge (FLAT_COAST), no hills
        expect(r.minHeight).toBeCloseTo(-10, 6);
        // The steep road's pin at 24 m holds the ground up there
        expect(r.maxHeight).toBeGreaterThan(23.9);
        expect(r.maxHeight).toBeLessThan(30);
        expect(r.roadLength).toBeCloseTo(900, 6);
        expect(r.edges).toBe(3);
        expect(r.nodes).toBe(6);
        let total = 0;
        for (const count of Object.values(r.surfaceCounts)) total += count;
        expect(total).toBe(201 * 201);
        expect(r.surfaceCounts.water).toBeGreaterThan(0);
        expect(r.surfaceCounts.asphalt).toBeGreaterThan(0);
        // 10 m over 100 m between the pins, 14 m over 100 m down to the
        // 10 m ground at its end: the steep edge has the steepest grade
        expect(r.maxBakedGrade.edge).toBe('steep');
        expect(r.maxBakedGrade.grade).toBeGreaterThan(0.09);
        expect(r.maxBakedGrade.grade).toBeLessThan(0.19);
    });

    it('lists only chains whose pins miss the grade by more than 1 cm', () => {
        // 8 % over 10 m reaches 0.8 m: pins 0.82 m apart miss by 2 cm, 0.805 m by 0.5 cm
        const pinned = (dy: number) => bakeTerrain(input({
            roads: network([node('a', 100, -150), node('b', 100, 150)], [edge('road', 'a', 'b', [], { elevation: [{ s: 100, y: 10 }, { s: 110, y: 10 + dy }] })])
        })).report.infeasibleChains;
        const missing = pinned(0.82);
        expect(missing).toHaveLength(1);
        expect(missing[0].edges).toEqual(['road']);
        expect(missing[0].infeasible).toBeCloseTo(0.02, 6);
        expect(pinned(0.805)).toEqual([]);
    });
});

describe('bakeTerrain ground classes', () => {
    it('puts a region over rock; sea and wet sand stay before a region', () => {
        // A steep hill inland (x = -60, 90 m from the coast), inside a dirt
        // region that reaches over the beach into the sea
        const base = {
            ...FLAT_COAST,
            hills: [{ id: 'knob', x: -60, z: 0, radii: [12, 12] as [number, number], height: 20 }],
            regions: [{ id: 'field', surface: 'dirt' as const, polygon: [[-200, -40], [-40, -40], [-40, 40], [-200, 40]] as [number, number][] }]
        };
        const hf = decodeHeightfield(bakeTerrain(input({ base })).bytes, GRID);
        // The knob's flank: 20 m · 1.5 / 12 m = 2.5, far over 45°, yet dirt
        expect(surfaceAt(hf, -54, 0)).toBe(SURFACE.dirt);
        expect(surfaceAt(hf, -190, 0)).toBe(SURFACE.water);
        expect(surfaceAt(hf, -148, 20)).toBe(SURFACE.wetSand);
        // Without the region the flank is rock
        const plain = decodeHeightfield(bakeTerrain(input({ base: { ...base, regions: [] } })).bytes, GRID);
        expect(surfaceAt(plain, -54, 0)).toBe(SURFACE.rock);
    });

    it('keeps sand to the beach strip and below 1.5 m over the beach top', () => {
        // A gentle cliff along the coast north of z = 0 (30 m reached over a
        // 100 m face, blended with the beach) lifts the beach strip: 2.7 m at
        // 20 m inland (sand, below 2 + 1.5), 4.0 m at 28 m inland (grass: too
        // high, though still in the 30 m strip)
        const base = { ...FLAT_COAST, cliffs: [{ id: 'bluff', line: [[-150, -200], [-150, 0]] as [number, number][], height: 30, face: 100, plateau: 0, fade: 60 }] };
        const hf = decodeHeightfield(bakeTerrain(input({ base })).bytes, GRID);
        expect(surfaceAt(hf, -130, -120)).toBe(SURFACE.sand);
        expect(surfaceAt(hf, -122, -120)).toBe(SURFACE.grass);
        // Without the cliff: the beach strip is sand up to 30 m, then grass
        const flat = decodeHeightfield(bakeTerrain(input({})).bytes, GRID);
        expect(surfaceAt(flat, -140, -100)).toBe(SURFACE.sand);
        expect(surfaceAt(flat, -122, -100)).toBe(SURFACE.sand);
        expect(surfaceAt(flat, -118, -100)).toBe(SURFACE.grass);
        // Wet sand only below 0.5 m: 2 · S(8/30) = 0.35 m at 8 m inland,
        // 2 · S(12/30) = 0.70 m at 12 m
        expect(surfaceAt(flat, -142, -100)).toBe(SURFACE.wetSand);
        expect(surfaceAt(flat, -138, -100)).toBe(SURFACE.sand);
    });

    it('classifies rock by its slope also on the last row and column of the grid', () => {
        // A steep hill cut by the grid's southern and eastern edges
        const base = { ...FLAT_COAST, hills: [{ id: 'edge', x: 200, z: 200, radii: [20, 20] as [number, number], height: 40 }] };
        const hf = decodeHeightfield(bakeTerrain(input({ base, roads: network([node('a', 0, -150), node('b', 0, -100)], [edge('road', 'a', 'b')]) })).bytes, GRID);
        // (190 | 200): on the last row, 10 m from the top, flank 40·1.5/20 = 3
        expect(surfaceAt(hf, 190, 200)).toBe(SURFACE.rock);
        expect(surfaceAt(hf, 200, 190)).toBe(SURFACE.rock);
    });

    it('rasterises zones at the centres of their 8 m cells, later polygons over earlier ones', () => {
        const zones: ZonesFile = {
            format: 'bulli-zones', version: 1, mapId: 'test',
            zones: [
                // Covers the cell centres (4 | 4) and (12 | 4) but not (20 | 4)
                { id: 'a', zone: 'industrial', polygon: [[0, 0], [16, 0], [16, 8], [0, 8]] },
                { id: 'b', zone: 'park', polygon: [[10, 0], [16, 0], [16, 8], [10, 8]] }
            ]
        };
        const hf = decodeHeightfield(bakeTerrain(input({ zones })).bytes, GRID);
        expect(zoneAt(hf, 4, 4)).toBe(ZONE.industrial);
        expect(zoneAt(hf, 12, 4)).toBe(ZONE.park);
        expect(zoneAt(hf, 20, 4)).toBe(ZONE.wild);
        expect(zoneAt(hf, 4, 12)).toBe(ZONE.wild);
        expect(zoneAt(hf, -4, 4)).toBe(ZONE.wild);
    });
});
