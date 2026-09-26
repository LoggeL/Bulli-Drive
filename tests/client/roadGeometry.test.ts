import { describe, expect, it } from 'vitest';
import { buildRoadNetwork } from '../../src/shared/map/roadNetwork.js';
import type { RoadArea } from '../../src/shared/map/roadSchema.js';
import {
    AREA_LIFT, AREA_WALL_DEPTH, areaFrame, buildRoadGeometry, CENTRE_CODE, cornerCurve, edgeRuns, edgeStations, END_CODE, MAX_STATION_STEP, ROAD_FLAG,
    groundNormal, ROAD_LIFT, splitByChunk, triangulatePolygon, MeshArrays
} from '../../src/client/world/roadGeometry.js';
import { roadBlock } from '../../src/client/world/roads.js';
import { edge, network, node, PROFILE } from '../shared/map/fixtures.js';

// The road meshes (src/client/world/roadGeometry.ts, docs/phase-3-design.md
// 5.4, 5.5 and 9) on hand-built networks: where the vertices lie, what the
// shader attributes say, how the junctions close. Expected values by hand.

const flat = () => 0;
const slope = (x: number, z: number) => 0.1 * x + 0.05 * z;

// Vertices of a mesh as objects
function vertices(mesh: MeshArrays) {
    const out = [];
    for (let v = 0; v < mesh.vertexCount; v++) {
        out.push({
            x: mesh.positions[v * 3], y: mesh.positions[v * 3 + 1], z: mesh.positions[v * 3 + 2],
            u: mesh.uvs[v * 2], s: mesh.uvs[v * 2 + 1],
            a: mesh.roadA.slice(v * 4, v * 4 + 4), b: mesh.roadB.slice(v * 4, v * 4 + 4)
        });
    }
    return out;
}

// Signed area (x-z) of all triangles, and whether each faces up
function triangles(mesh: MeshArrays): { area: number; allUp: boolean } {
    let area = 0, allUp = true;
    const P = mesh.positions;
    for (let t = 0; t < mesh.index.length; t += 3) {
        const [a, b, c] = mesh.index.slice(t, t + 3);
        const ux = P[b * 3] - P[a * 3], uz = P[b * 3 + 2] - P[a * 3 + 2];
        const vx = P[c * 3] - P[a * 3], vz = P[c * 3 + 2] - P[a * 3 + 2];
        const up = uz * vx - ux * vz;
        if (up <= 0) allUp = false;
        area += up / 2;
    }
    return { area, allUp };
}

describe('ground normals and road blocks', () => {
    it('takes the ground normal from central differences: on a plane, its normalised gradient', () => {
        // y = 0.1 x - 0.2 z + 3: the normal (-0.1, 1, 0.2) normalised
        const l = Math.sqrt(0.01 + 1 + 0.04);
        const [nx, ny, nz] = groundNormal((x, z) => 0.1 * x - 0.2 * z + 3, 7, -3);
        expect(nx).toBeCloseTo(-0.1 / l, 12);
        expect(ny).toBeCloseTo(1 / l, 12);
        expect(nz).toBeCloseTo(0.2 / l, 12);
    });

    it('cuts the 2 km square into 4 × 4 blocks of 500 m, row by row from the north-west', () => {
        expect(roadBlock(-1000, -1000)).toBe(0);
        expect(roadBlock(-501, -999)).toBe(0);
        expect(roadBlock(-499, -999)).toBe(1);
        expect(roadBlock(999, -999)).toBe(3);
        expect(roadBlock(-999, -499)).toBe(4);
        expect(roadBlock(1, 1)).toBe(10);
        expect(roadBlock(999, 999)).toBe(15);
        // Beyond the square: the border blocks
        expect(roadBlock(-1200, 1300)).toBe(12);
    });
});

describe('a straight road', () => {
    // 40 m along +x, 10 m wide, two dead ends
    const net = buildRoadNetwork(network([node('a', 0, 0), node('b', 40, 0)], [edge('ab', 'a', 'b')]));

    it('is a band of the profile\'s width on the ground, the lift above it', () => {
        const layers = buildRoadGeometry(net, slope);
        const ribbon = vertices(layers.asphalt);
        expect(ribbon.length).toBeGreaterThan(0);
        for (const v of ribbon) {
            expect(Math.abs(v.u)).toBeCloseTo(5, 9);
            // Left of +x is -z (north), across = +5 there
            expect(v.z).toBeCloseTo(-v.u, 9);
            expect(v.y).toBeCloseTo(slope(v.x, v.z) + ROAD_LIFT, 9);
        }
        // Area of the band: 40 × 10, every triangle facing up
        const { area, allUp } = triangles(layers.asphalt);
        expect(area).toBeCloseTo(400, 6);
        expect(allUp).toBe(true);
    });

    it('takes a station every 4 m on a straight', () => {
        expect(MAX_STATION_STEP).toBe(4);
        expect(edgeStations(net.edges[0], 0, 40)).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40]);
        expect(edgeStations(net.edges[0], 3.5, 10)).toEqual([3.5, 8, 10]);
    });

    it('carries the markings of its profile to the shader', () => {
        const v = vertices(buildRoadGeometry(net, flat).asphalt)[0];
        // Centre line dashed yellow, one lane each way, no flags; half width
        // 5, no stop line or crosswalk at dead ends, stations 0 to 40
        expect(v.a).toEqual([CENTRE_CODE.dashedYellow, 1, 1, 0]);
        expect(v.b).toEqual([5, 0, 0, 40]);
    });

    it('draws no sidewalk without one in the profile, and one at curb height with it', () => {
        expect(buildRoadGeometry(net, flat).walk.vertexCount).toBe(0);
        const walked = buildRoadNetwork(network([node('a', 0, 0), node('b', 40, 0)], [edge('ab', 'a', 'b')], {
            profiles: { road: { ...PROFILE, sidewalk: { left: 3, right: 0 }, curb: { left: true, right: false, height: 0.15 } } }
        }));
        const walk = vertices(buildRoadGeometry(walked, flat).walk);
        const tops = walk.filter(v => v.y > 0.1);
        expect(tops.length).toBeGreaterThan(0);
        for (const v of tops) {
            expect(v.y).toBeCloseTo(0.15, 9);
            // On the left (north) side, from the road edge 5 m out to 8 m
            expect(-v.z).toBeGreaterThanOrEqual(5 - 1e-9);
            expect(-v.z).toBeLessThanOrEqual(8 + 1e-9);
        }
        // The curb face at the road edge reaches from the road up to the top
        const face = walk.filter(v => Math.abs(v.z + 5) < 1e-9);
        expect(Math.min(...face.map(v => v.y))).toBeCloseTo(ROAD_LIFT, 9);
    });
});

describe('a junction', () => {
    // A cross of two 12 m roads at the origin, stop signs and crosswalks
    const profile = { ...PROFILE, width: 12, markings: { center: 'doubleYellow' as const, lanes: 'none' as const, edges: true } };
    const net = buildRoadNetwork(network([
        node('c', 0, 0, 'junction', { junction: { shape: 'auto', control: 'stop', crosswalks: true } }),
        node('e', 60, 0), node('w', -60, 0), node('n', 0, -60), node('s', 0, 60)
    ], [edge('ce', 'c', 'e'), edge('wc', 'w', 'c'), edge('cn', 'c', 'n'), edge('sc', 's', 'c')], { profiles: { road: profile } }));

    it('trims the roads at the trim radius (half the widest road + 2 m)', () => {
        const ce = net.edgeById.get('ce')!;
        const { start, end, runs } = edgeRuns(net, ce);
        expect(start).toBe(8);
        expect(end).toBe(60);
        expect(runs).toEqual([{ from: 8, to: 60 }]);
    });

    it('marks stop lines and crosswalks at the junction end only', () => {
        const layers = buildRoadGeometry(net, flat);
        const ce = vertices(layers.asphalt).filter(v => v.b[2] === 8 && v.x > 7);
        expect(ce.length).toBeGreaterThan(0);
        // Starts at the junction: start code stop + crosswalk, end code 0 (a dead end)
        expect(ce[0].b[1]).toBe(END_CODE.stop + END_CODE.crosswalk);
        expect(ce[0].a).toEqual([CENTRE_CODE.doubleYellow, 1, 1, ROAD_FLAG.edges]);
        // wc ends at the junction: end code 3 → 4 · 3
        const wc = vertices(layers.asphalt).find(v => v.x < -7 && v.b[2] === 0);
        expect(wc?.b[3]).toBeCloseTo(52, 6);
        expect(wc?.b[1]).toBe(4 * (END_CODE.stop + END_CODE.crosswalk));
    });

    it('closes the square between the trimmed ends with the fill', () => {
        const layers = buildRoadGeometry(net, flat);
        const { area, allUp } = triangles(layers.asphalt);
        expect(allUp).toBe(true);
        // Four ribbons of 52 × 12, the fill: the 16 × 16 square of the trim
        // radius minus four corners. Each corner curve runs from (8, 6) to
        // (6, 8) round the control (6, 6): outside the fill are the corner's
        // half square beyond the chord (2) and the curve's bulge towards the
        // control, 2/3 of the other half (4/3); the 8 straight steps of the
        // curve cut a sliver of it back (under 0.1 m² in all)
        const exact = 4 * 52 * 12 + 16 * 16 - 4 * (2 + 4 / 3);
        expect(Math.abs(area - exact)).toBeLessThan(0.1);
    });

    it('rounds the corner from one road edge to the next through their meeting point', () => {
        // Right edge of a road leaving along +x at (8, 6), left edge of one
        // leaving along +z at (6, 8): they meet at (6, 6)
        const curve = cornerCurve([8, 6], [-1, 0], [6, 8], [0, -1], 2);
        expect(curve[0]).toEqual([8, 6]);
        expect(curve[2]).toEqual([6, 8]);
        // Middle of the quadratic curve: (p0 + 2 control + p1) / 4
        expect(curve[1][0]).toBeCloseTo((8 + 12 + 6) / 4, 12);
        expect(curve[1][1]).toBeCloseTo((6 + 12 + 8) / 4, 12);
    });
});

describe('lots', () => {
    it('triangulate their outline, convex or not, facing up', () => {
        expect(triangulatePolygon([[0, 0], [10, 0], [10, 5], [0, 5]])).toHaveLength(2);
        // An L of 10 × 10 minus 5 × 5: area 75, six corners, four triangles
        const l: [number, number][] = [[0, 0], [10, 0], [10, 5], [5, 5], [5, 10], [0, 10]];
        const tris = triangulatePolygon(l);
        expect(tris).toHaveLength(4);
        let area = 0;
        for (const [i, j, k] of tris) {
            area += Math.abs((l[j][0] - l[i][0]) * (l[k][1] - l[i][1]) - (l[j][1] - l[i][1]) * (l[k][0] - l[i][0])) / 2;
        }
        expect(area).toBe(75);
    });

    it('carry a frame along their longest side for the stalls', () => {
        const frame = areaFrame([[0, 0], [0, 20], [60, 20], [60, 0]]);
        expect(frame.length).toBe(60);
        expect(frame.depth).toBe(20);
        // Along +x from (0, 20) or (60, 0), inwards
        expect(Math.abs(frame.ux)).toBe(1);
        expect(frame.vx * (30 - frame.ox) + frame.vz * (10 - frame.oz)).toBeGreaterThan(0);
    });

    it('draw a parking lot with the stall flag, a plaza on the pavers, a pier not at all', () => {
        const lot: RoadArea = { id: 'lot', polygon: [[100, 0], [160, 0], [160, 20], [100, 20]], surface: 'asphalt', curb: false, markings: 'parking', connects: [] };
        const plaza: RoadArea = { id: 'plaza', polygon: [[200, 0], [240, 0], [240, 40], [200, 40]], surface: 'concrete', curb: true, markings: 'plazaPavers', connects: [] };
        const pier: RoadArea = { id: 'pier', polygon: [[300, 0], [400, 0], [400, 10], [300, 10]], surface: 'wood', curb: false, y: 5, walls: true, connects: [] };
        const net = buildRoadNetwork(network([node('a', 0, 0), node('b', 40, 0)], [edge('ab', 'a', 'b')], { areas: [lot, plaza, pier] }));
        const layers = buildRoadGeometry(net, flat);
        const lotVertices = vertices(layers.asphalt).filter(v => v.x >= 100);
        expect(lotVertices.length).toBeGreaterThan(0);
        for (const v of lotVertices) expect(v.a[3]).toBe(ROAD_FLAG.parkingLot);
        expect(triangles(layers.pavers).area).toBeCloseTo(1600, 6);
        // The plaza has no road: a curb round it
        expect(vertices(layers.walk).some(v => v.x >= 200 && v.y > 0.1)).toBe(true);
        // Nothing drawn over the pier (its deck is the kit's)
        for (const layer of Object.values(layers)) expect(vertices(layer).some(v => v.x > 290)).toBe(false);
    });

    it('draw an area at a fixed height level at it, whatever the ground at its outline (a quay\'s walls)', () => {
        // A concrete quay at y = 1.4 on walls; the ground falls away beyond
        // x = 110 (the sea), so at its outline it leans down
        const quay: RoadArea = { id: 'quay', polygon: [[100, 0], [120, 0], [120, 30], [100, 30]], surface: 'concrete', curb: false, y: 1.4, walls: true, connects: [] };
        const net = buildRoadNetwork(network([node('a', 0, 0), node('b', 40, 0)], [edge('ab', 'a', 'b')], { areas: [quay] }));
        const ground = (x: number) => (x > 110 ? 1.4 - (x - 110) : 1.4);
        const mesh = buildRoadGeometry(net, ground).concrete;
        const concrete = vertices(mesh).map((v, i) => ({ ...v, i })).filter(v => v.x >= 100);
        const top = concrete.filter(v => v.y > 0);
        expect(top.length).toBeGreaterThan(4);
        for (const v of top) expect(v.y).toBeCloseTo(1.4 + AREA_LIFT, 12);
        // Its walls go down AREA_WALL_DEPTH, each facing out: the east wall +x
        const walls = concrete.filter(v => v.y < 0);
        expect(walls.length).toBeGreaterThan(4);
        for (const v of walls) expect(v.y).toBeCloseTo(1.4 + AREA_LIFT - AREA_WALL_DEPTH, 12);
        const east = walls.filter(v => v.x === 120 && v.z > 0 && v.z < 30);
        expect(east.length).toBeGreaterThan(0);
        for (const v of east) expect([mesh.normals[v.i * 3], mesh.normals[v.i * 3 + 1], Math.abs(mesh.normals[v.i * 3 + 2])]).toEqual([1, 0, 0]);
        // Its triangles wind to face out as well (front faces drawn): the
        // cross product of each wall triangle points along its normal
        for (let t = 0; t < mesh.index.length; t += 3) {
            const [i, j, k] = [mesh.index[t], mesh.index[t + 1], mesh.index[t + 2]];
            const p = (n: number) => [mesh.positions[n * 3], mesh.positions[n * 3 + 1], mesh.positions[n * 3 + 2]];
            const [a, b, c] = [p(i), p(j), p(k)];
            if (a[1] >= 0 && b[1] >= 0 && c[1] >= 0) continue;
            const e = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], f = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            const cross = [e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]];
            expect(cross[0] * mesh.normals[i * 3] + cross[2] * mesh.normals[i * 3 + 2]).toBeGreaterThan(0);
        }
    });
});

describe('chunks', () => {
    // Two triangles, one each side of x = 0, sharing the vertex at (0, 0):
    // centroids at x = -2/3 and +2/3, chunk = side of x = 0
    const mesh = () => {
        const out = new MeshArrays();
        const n = [0, 1, 0];
        out.vertex(-1, 0, 0, n, -1, 0, [1, 2, 3, 4], [5, 6, 7, 8]);
        out.vertex(0, 0, 0, n, 0, 0, [1, 2, 3, 4], [5, 6, 7, 9]);
        out.vertex(-1, 0, 1, n, -1, 1, [1, 2, 3, 4], [5, 6, 7, 10]);
        out.vertex(1, 0, 0, n, 1, 0, [1, 2, 3, 4], [5, 6, 7, 11]);
        out.vertex(1, 0, 1, n, 1, 1, [1, 2, 3, 4], [5, 6, 7, 12]);
        out.index.push(0, 2, 1, 1, 4, 3);
        return out;
    };
    const side = (x: number) => (x < 0 ? 0 : 1);

    it('put each triangle into the chunk of its centroid, with its own copies of the vertices', () => {
        const chunks = splitByChunk(mesh(), side);
        expect([...chunks.keys()].sort()).toEqual([0, 1]);
        const west = chunks.get(0)!, east = chunks.get(1)!;
        // The shared vertex (0, 0) is in both; each chunk has 3 vertices
        expect(vertices(west).map(v => [v.x, v.z, v.b[3]])).toEqual([[-1, 0, 8], [-1, 1, 10], [0, 0, 9]]);
        expect(vertices(east).map(v => [v.x, v.z, v.b[3]])).toEqual([[0, 0, 9], [1, 1, 12], [1, 0, 11]]);
        // Winding kept: (a, c, b) of the source is (0, 1, 2) of the copy
        expect(west.index).toEqual([0, 1, 2]);
        expect(east.index).toEqual([0, 1, 2]);
        expect(vertices(west)[1]).toMatchObject({ u: -1, s: 1, a: [1, 2, 3, 4] });
    });

    it('keep every triangle of a layer exactly once', () => {
        // A 60 m road, 10 m wide, across the chunk border at x = 0: 30 × 10
        // on each side
        const net = network([node('a', -30, 0), node('b', 30, 0)], [edge('ab', 'a', 'b')]);
        const asphalt = buildRoadGeometry(buildRoadNetwork(net), flat).asphalt;
        const chunks = splitByChunk(asphalt, side);
        const total = [...chunks.values()].reduce((sum, part) => sum + part.index.length, 0);
        expect(total).toBe(asphalt.index.length);
        expect(triangles(chunks.get(0)!).area).toBeCloseTo(300, 6);
        expect(triangles(chunks.get(1)!).area).toBeCloseTo(300, 6);
    });
});
