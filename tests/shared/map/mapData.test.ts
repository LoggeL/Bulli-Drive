import { describe, expect, it } from 'vitest';
import { mapFor } from '../../../src/server/maps.js';
import { LOT_RULES, LOT_SNAP, placeBuildings, type BuildingLot } from '../../../src/shared/map/buildings.js';
import { pointInPolygon, polylineDistance, type Vec2 } from '../../../src/shared/map/geometry.js';
import { heightAt, zoneAt } from '../../../src/shared/map/heightfield.js';
import {
    arenaFence, boundaryFence, CONTAINER_TOP, createMapData, FENCE_PIECE, FOUNTAIN_RADIUS, FOUNTAIN_TOP, heightfieldHash,
    JUMP_LANDING, JUMP_RUNUP, JUMP_SIDE, LANDMARK_PIECES, roadResetPose, zoneFence
} from '../../../src/shared/map/mapData.js';
import { atRockFoot, groundGrade, MOLE_FLANK, placePlants, PLANT_COLLIDERS, PLANT_MAX_GRADE, plantFits, TALUS_MIN_HEIGHT } from '../../../src/shared/map/plants.js';
import { networkRailColliders, type SegmentCollider } from '../../../src/shared/map/rails.js';
import { buildRoadNetwork, insideCorridor, roadSurfaceIdAt } from '../../../src/shared/map/roadNetwork.js';
import type { RoadArea } from '../../../src/shared/map/roadSchema.js';
import { BoxIndex, boxContains, boxesOverlap, boxSamples, KIT_FOOTPRINTS, placementBox } from '../../../src/shared/map/structures.js';
import { SURFACE, ZONE } from '../../../src/shared/map/types.js';
import { createVehicleState } from '../../../src/shared/sim/types.js';
import { createSimCar, spawnVehicle } from '../../../src/shared/sim/vehicle.js';
import { stepWorld } from '../../../src/shared/sim/world.js';
import type { Collider, ColliderInput } from '../../../src/shared/world/colliders.js';
import { edge, makeHeightfield, network, node, PROFILE } from './fixtures.js';

// The map's runtime data (src/shared/map/mapData.ts, docs/phase-3-design.md,
// 8, 11 and 12): on small hand-built maps with expectations from the rules,
// and invariants of Bulli Bay's own data.

// Whether a car's centre at (x, z) stands inside a collider's footprint
function colliderHolds(c: ColliderInput | Collider, x: number, z: number): boolean {
    switch (c.kind) {
        case 'circle':
            return (x - c.x) ** 2 + (z - c.z) ** 2 < c.r * c.r;
        case 'box':
            return Math.abs(x - c.x) < c.hw && Math.abs(z - c.z) < c.hd;
        case 'obox': {
            const dx = x - c.x, dz = z - c.z;
            return Math.abs(dx * c.uz - dz * c.ux) < c.hw && Math.abs(dx * c.ux + dz * c.uz) < c.hd;
        }
        case 'segment': {
            const ex = c.bx - c.ax, ez = c.bz - c.az;
            const t = Math.max(0, Math.min(1, ((x - c.ax) * ex + (z - c.az) * ez) / (ex * ex + ez * ez)));
            return Math.hypot(x - (c.ax + t * ex), z - (c.az + t * ez)) < c.r;
        }
    }
    return false;
}

// An east-west road from (-90, 0) to (90, 0), 10 m wide, 3 m sidewalks
function straightRoad(surface: 'asphalt' | 'dirt' = 'asphalt') {
    return buildRoadNetwork(network([node('w', -90, 0), node('e', 90, 0)], [edge('main', 'w', 'e')], {
        profiles: { road: { ...PROFILE, surface, sidewalk: { left: 3, right: 3 } } }
    }));
}

describe('placeBuildings', () => {
    it('puts closed rows of downtown houses on both sides, their fronts 0.3 m behind the sidewalk, facing the road', () => {
        const net = straightRoad();
        const lots = placeBuildings({ net, hf: makeHeightfield(() => 1), areas: [], reserved: [] });
        const rule = LOT_RULES[ZONE.downtown]!;
        expect(lots.length).toBeGreaterThan(10);
        for (const side of ['left', 'right'] as const) {
            const row = lots.filter(l => l.side === side).sort((a, b) => a.x - b.x);
            expect(row.length).toBeGreaterThan(5);
            // Edge direction +x: its left normal is (0, -1) (north), the front
            // stands 5 + 3 + 0.3 m out, facing back to the road
            const out = side === 'left' ? -1 : 1;
            for (const lot of row) {
                expect(lot.z).toBeCloseTo(out * 8.3, 9);
                expect([lot.ux, lot.uz]).toEqual([0, -out]);
                expect([...rule.pieces, ...rule.corners!]).toContain(lot.piece);
            }
            // The road's ends end the rows: a corner building at each end,
            // flush with them (the lots beside the road clear its corridor)
            const width = (lot: BuildingLot) => KIT_FOOTPRINTS[lot.piece].maxX - KIT_FOOTPRINTS[lot.piece].minX;
            expect(rule.corners).toContain(row[0].piece);
            expect(rule.corners).toContain(row.at(-1)!.piece);
            expect(row[0].x - width(row[0]) / 2).toBeCloseTo(-90, 6);
            expect(row.at(-1)!.x + width(row.at(-1)!) / 2).toBeCloseTo(90, 6);
            // Gapless: each house starts where the one before ends, but for one
            // gap narrower than the narrowest house (8 m) before the last
            const gaps: number[] = [];
            for (let i = 1; i < row.length; i++) gaps.push(row[i].x - row[i - 1].x - (width(row[i - 1]) + width(row[i])) / 2);
            const open = gaps.filter(gap => Math.abs(gap) > 0.01);
            expect(open.length, `gaps ${gaps}`).toBeLessThanOrEqual(1);
            for (const gap of open) expect(gap).toBeLessThan(8);
        }
        // The same on roads of other names (other pieces drawn): where the
        // drawn piece is too wide for the rest of the row, a narrower one
        for (const id of ['high', 'ocean', 'elm', 'pine', 'bay', 'palm']) {
            const other = buildRoadNetwork(network([node('w', -90, 0), node('e', 90, 0)], [edge(id, 'w', 'e')], {
                profiles: { road: { ...PROFILE, sidewalk: { left: 3, right: 3 } } }
            }));
            for (const side of ['left', 'right'] as const) {
                const row = placeBuildings({ net: other, hf: makeHeightfield(() => 1), areas: [], reserved: [] }).filter(l => l.side === side).sort((a, b) => a.x - b.x);
                const width = (lot: BuildingLot) => KIT_FOOTPRINTS[lot.piece].maxX - KIT_FOOTPRINTS[lot.piece].minX;
                const covered = row.reduce((sum, lot) => sum + width(lot), 0);
                expect(180 - covered, `${id} ${side}`).toBeLessThan(8);
            }
        }
        // No lot reaches into the corridor or past the edge's ends
        for (const lot of lots) {
            const box = placementBox(lot);
            for (const [x, z] of boxSamples(box, 2)) {
                expect(insideCorridor(net, x, z, 0.2)).toBe(false);
                expect(Math.abs(x)).toBeLessThanOrEqual(90 + 1e-9);
            }
        }
    });

    it('starts a row with a corner building right behind a junction\'s cross street, and ends it with one before the next', () => {
        // A cross street through (0, 0) north to south; the main road from
        // (-90, 0) through the junction to (90, 0): the rows east of the
        // junction start behind the cross street's corridor (5 + 3 m and the
        // lots' 0.25 m margin: x = 8.25) within LOT_SNAP
        const net = buildRoadNetwork(network(
            [node('w', -90, 0), node('j', 0, 0, 'junction'), node('e', 90, 0), node('n', 0, -90), node('s', 0, 90)],
            [edge('a-west', 'w', 'j'), edge('b-east', 'j', 'e'), edge('c-north', 'n', 'j'), edge('d-south', 'j', 's')],
            { profiles: { road: { ...PROFILE, sidewalk: { left: 3, right: 3 } } } }
        ));
        const lots = placeBuildings({ net, hf: makeHeightfield(() => 1), areas: [], reserved: [] });
        const rule = LOT_RULES[ZONE.downtown]!;
        for (const side of ['left', 'right'] as const) {
            const east = lots.filter(l => l.edge === 'b-east' && l.side === side).sort((a, b) => a.x - b.x);
            const first = east[0], last = east.at(-1)!;
            const half = (lot: BuildingLot) => (KIT_FOOTPRINTS[lot.piece].maxX - KIT_FOOTPRINTS[lot.piece].minX) / 2;
            expect(rule.corners, side).toContain(first.piece);
            expect(rule.corners, side).toContain(last.piece);
            // (The edges go in id order: b-east's rows take the corners before
            // the cross street's)
            const start = first.x - half(first);
            expect(start, side).toBeGreaterThanOrEqual(8.25 - 1e-6);
            expect(start, side).toBeLessThanOrEqual(8.25 + LOT_SNAP);
            expect(last.x + half(last)).toBeCloseTo(90, 6);
        }
    });

    it('follows the zone behind the road, leaves out unpaved roads and reserved places', () => {
        const net = straightRoad();
        // Residential south of the road, wild north of it
        const hf = makeHeightfield(() => 1, (_x, z) => (z > 0 ? ZONE.residential : ZONE.wild));
        const lots = placeBuildings({ net, hf, areas: [], reserved: [] });
        expect(lots.every(l => l.side === 'right' && l.zone === ZONE.residential)).toBe(true);
        // Detached houses 6 m behind the sidewalk, 4 to 12 m apart
        for (const lot of lots) expect(lot.z).toBeCloseTo(5 + 3 + 6, 9);
        expect(lots.length).toBeGreaterThan(3);
        expect(placeBuildings({ net: straightRoad('dirt'), hf, areas: [], reserved: [] })).toEqual([]);
        // A reserved box over the whole south side
        const reserved = [{ x: 0, z: 30, hw: 100, hd: 25, ux: 0, uz: 1 }];
        expect(placeBuildings({ net, hf, areas: [], reserved })).toEqual([]);
    });

    it('drops a lot on ground that differs by more than 2.5 m under it, or in the water, or in an area', () => {
        const net = straightRoad();
        // A 3 m step 15 m north of the road: every northern house straddles it
        const stepped = placeBuildings({ net, hf: makeHeightfield((_x, z) => (z < -15 ? 4 : 1)), areas: [], reserved: [] });
        expect(stepped.filter(l => l.side === 'left')).toEqual([]);
        expect(stepped.filter(l => l.side === 'right').length).toBeGreaterThan(5);
        // South of the road below the water level
        const wet = placeBuildings({ net, hf: makeHeightfield((_x, z) => (z > 6 ? -2 : 1)), areas: [], reserved: [] });
        expect(wet.every(l => l.side === 'left')).toBe(true);
        // An area west of x = 0 on both sides
        const area: RoadArea = {
            id: 'lot', polygon: [[-100, -60], [-100, 60], [0, 60], [0, -60]], surface: 'asphalt', curb: false, connects: []
        };
        const withArea = placeBuildings({ net, hf: makeHeightfield(() => 1), areas: [area], reserved: [] });
        for (const lot of withArea) {
            for (const [x, z] of boxSamples(placementBox(lot), 2)) expect(pointInPolygon(area.polygon, x, z)).toBe(false);
        }
    });
});

describe('plantFits', () => {
    const net = straightRoad();
    const hf = makeHeightfield((_x, z) => (z > 60 ? -1 : 1), () => ZONE.wild, (x, z) => (z > 50 && z <= 60 ? SURFACE.wetSand : SURFACE.grass));
    const buildings = new BoxIndex();
    buildings.add({ x: 50, z: -40, hw: 5, hd: 5, ux: 0, uz: 1 });
    const area: RoadArea = { id: 'a', polygon: [[-60, -60], [-60, -40], [-40, -40], [-40, -60]], surface: 'asphalt', curb: false, connects: [] };
    const ctx = {
        net, hf, areas: [area], buildings, reserved: [{ x: 0, z: 40, hw: 3, hd: 3, ux: 0, uz: 1 }],
        boundary: [[-95, -95], [-95, 95], [95, 95], [95, -95]] as Vec2[]
    };
    const r = PLANT_COLLIDERS.oak.r;

    it('keeps a tree 2 m plus its trunk off the road corridor', () => {
        // Corridor: 5 m half width + 3 m sidewalk; the margin 2 + r beyond it
        expect(plantFits(ctx, 0, 8 + 2 + r + 0.01, r, true)).toBe(true);
        expect(plantFits(ctx, 0, 8 + 2 + r - 0.01, r, true)).toBe(false);
        // Street palms stand on the sidewalk (no corridor test for them)
        expect(plantFits(ctx, 0, 6.2, PLANT_COLLIDERS.palm.r, false)).toBe(true);
    });

    it('keeps out of areas, buildings, reserved places, wet sand, the water and the boundary', () => {
        expect(plantFits(ctx, -50, -50, r, true)).toBe(false);
        expect(plantFits(ctx, -50, -60 - 2 - r - 0.01, r, true)).toBe(true);
        expect(plantFits(ctx, 50, -40, r, true)).toBe(false);
        expect(plantFits(ctx, 50, -40 - 5 - 1.5 - r - 0.01, r, true)).toBe(true);
        // Within the building's 1.5 m margin, though clear of its wall
        expect(plantFits(ctx, 50, -40 - 5 - 1.5, r, true)).toBe(false);
        expect(plantFits(ctx, 0, 40, r, true)).toBe(false);
        expect(plantFits(ctx, 0, 55, r, true)).toBe(false);
        expect(plantFits(ctx, 0, 70, r, true)).toBe(false);
        expect(plantFits(ctx, 97, -30, r, true)).toBe(false);
    });
});

describe('plantFits on slopes', () => {
    // A slope rising to the east by 0.6 m per metre west of x = 0 (31°) and
    // by 0.8 m per metre east of it (39°); the plant limit is tan 35° = 0.7
    const hf = makeHeightfield(x => (x < 0 ? 40 + 0.6 * x : 40 + 0.8 * x), () => ZONE.wild);
    const ctx = {
        net: straightRoad(), hf, areas: [], buildings: new BoxIndex(), reserved: [],
        boundary: [[-95, -95], [-95, 95], [95, 95], [95, -95]] as Vec2[]
    };

    it('measures the gradient over ±1 m and keeps trees off ground steeper than 35°', () => {
        expect(groundGrade(hf, -30, 40)).toBeCloseTo(0.6, 2);
        expect(groundGrade(hf, 30, 40)).toBeCloseTo(0.8, 2);
        expect(PLANT_MAX_GRADE).toBeCloseTo(Math.tan(35 * Math.PI / 180), 2);
        expect(plantFits(ctx, -30, 40, 0.5, true)).toBe(true);
        expect(plantFits(ctx, 30, 40, 0.5, true)).toBe(false);
    });
});

// The talus of the test face as placed when the test was written
const TALUS_LOCK = { count: 10, boulders: 6 };

describe('talus at the foot of a rock face', () => {
    // A cliff face along z: ground at 0.2 m west of x = 0 (the downtown zone:
    // no zone plants), rising 2.5 m per metre to a plateau of 20 m at x = 8,
    // surface rock where it is steep; a road across it along z = 0
    const height = (x: number) => (x < 0 ? 0.2 : x < 8 ? 0.2 + 2.475 * x : 20);
    const hf = makeHeightfield(height, () => ZONE.downtown, x => (x >= 0 && x < 8 ? SURFACE.rock : SURFACE.sand));
    const ctx = () => ({
        net: buildRoadNetwork(network([node('a', -90, 0), node('b', 90, 0)], [edge('ab', 'a', 'b')])),
        hf, areas: [], buildings: new BoxIndex(), reserved: [],
        boundary: [[-95, -95], [-95, 95], [95, 95], [95, -95]] as Vec2[]
    });

    it('finds the foot: rock at least 4 m higher within 8 m (probed at 2, 4.5 and 7 m), not further out, not on the plateau', () => {
        // The face passes 4.2 m (the ground's 0.2 + 4) at x = 1.62
        expect(atRockFoot(hf, -2, 30)).toBe(true);
        expect(atRockFoot(hf, -4, 30)).toBe(true);
        expect(atRockFoot(hf, -6, 30)).toBe(false);
        expect(atRockFoot(hf, -11, 30)).toBe(false);
        expect(atRockFoot(hf, 20, 30)).toBe(false);
    });

    it('scatters rocks and boulders along the foot only, clear of each other and of the road', () => {
        const plants = placePlants(ctx());
        expect(plants.length).toBeGreaterThan(5);
        for (const p of plants) {
            expect(['rock', 'boulder']).toContain(p.kind);
            // Within the reach west of the face, on its gentle ground
            expect(p.x).toBeGreaterThan(-5.5);
            expect(p.x).toBeLessThan(0);
            expect(p.size).toBeGreaterThanOrEqual(0.6);
            expect(p.size).toBeLessThanOrEqual(1.2);
            // The road (5 m half width, 0.5 m shoulders) and 2 m beyond stay clear
            expect(Math.abs(p.z)).toBeGreaterThan(7.5);
        }
        for (let i = 0; i < plants.length; i++) {
            for (let j = i + 1; j < plants.length; j++) {
                const a = plants[i], b = plants[j];
                const reach = PLANT_COLLIDERS[a.kind].r * a.size + PLANT_COLLIDERS[b.kind].r * b.size;
                expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(reach - 1e-9);
            }
        }
        // Regression lock of the seeded placement (6 m cells, 80 % of them,
        // 40 % boulders): the count and the mix of this foot
        expect(plants.length).toBe(TALUS_LOCK.count);
        expect(plants.filter(p => p.kind === 'boulder').length).toBe(TALUS_LOCK.boulders);
    });

    it('keeps the talus out of areas, buildings, reserved places and off the map', () => {
        // Without them the foot has rocks at z = 37..47, -35.5, 53.8 and
        // 71; a lot over z 34..49, a building at z -35.5, a reserved box at
        // z 53.8 and the map's edge at z = 65 take them
        const free = placePlants(ctx());
        const box = (z: number) => ({ x: -3, z, hw: 4, hd: 2, ux: 0, uz: 1 });
        const buildings = new BoxIndex();
        buildings.add(box(-35.5));
        const area: RoadArea = { id: 'lot', polygon: [[-20, 34], [-1, 34], [-1, 49], [-20, 49]], surface: 'asphalt', curb: false, connects: [] };
        const placed = placePlants({
            ...ctx(), areas: [area], buildings, reserved: [box(53.8)],
            boundary: [[-95, -95], [-95, 65], [95, 65], [95, -95]] as Vec2[]
        });
        const within = (list: typeof free, z0: number, z1: number) => list.filter(p => p.z > z0 && p.z < z1).length;
        for (const [z0, z1] of [[34, 49], [-37.5, -33.5], [51.8, 55.8], [65, 95]]) {
            expect(within(free, z0, z1), `${z0}..${z1}`).toBeGreaterThan(0);
            expect(within(placed, z0, z1), `${z0}..${z1}`).toBe(0);
        }
        // Elsewhere the same rocks
        expect(placed.filter(p => p.z < 30 && p.z > -30 || p.z < -40)).toEqual(free.filter(p => p.z < 30 && p.z > -30 || p.z < -40));
    });
});

describe('a breakwater\'s armour', () => {
    it('lays a boulder on the crest every 2.6 m and a rock on each flank 2.8 m out, a quarter and three quarters of a step on', () => {
        // A mole along x from (-60, -40) to (-34, -40) in the shallows; a road
        // across its far end (x = -38) takes the stones within its corridor
        const hf = makeHeightfield(() => -0.5, () => ZONE.wild, () => SURFACE.water);
        const net = buildRoadNetwork(network([node('a', -38, -90), node('b', -38, 90)], [edge('ab', 'a', 'b')]));
        const plants = placePlants({
            net, hf, areas: [], buildings: new BoxIndex(), reserved: [],
            boundary: [[-95, -95], [-95, 95], [95, 95], [95, -95]] as Vec2[], moles: [[[-60, -40], [-34, -40]]]
        });
        const crest = plants.filter(p => p.kind === 'boulder').map(p => [p.x, p.z]);
        // Steps at s = 0, 2.6, ... 26; within 9.2 to 9.9 m of the road (its
        // half width 5, the margin 2 and the boulder's 2.2 to 2.9 m) they go:
        // x = -47 (9 m) and beyond
        expect(crest).toEqual([[-60, -40], [-57.4, -40], [-54.8, -40], [-52.2, -40], [-49.6, -40]]);
        const flanks = plants.filter(p => p.kind === 'rock');
        expect(flanks.slice(0, 2).map(p => [p.x, p.z])).toEqual([[-59.35, -37.2], [-58.05, -42.8]]);
        for (const p of plants) expect(p.size).toBeGreaterThanOrEqual(p.kind === 'boulder' ? 1 : 0.8);
        for (const p of plants) expect(p.size).toBeLessThanOrEqual(p.kind === 'boulder' ? 1.3 : 1.1);
    });

    it('follows a slanting line, left and right of it, and keeps out of areas, buildings and reserved places', () => {
        // From (10, 10) along (0.6, 0.8), 20 m: boulders every 2.6 m from s = 0
        // to 18.2; the first left flank rock (left: (-0.8, 0.6)) a quarter
        // step on, the first right one three quarters
        const hf = makeHeightfield(() => -0.5, () => ZONE.wild, () => SURFACE.water);
        const net = buildRoadNetwork(network([node('a', -90, -90), node('b', -80, -90)], [edge('ab', 'a', 'b')]));
        const base = {
            net, hf, areas: [] as RoadArea[], buildings: new BoxIndex(), reserved: [] as { x: number; z: number; hw: number; hd: number; ux: number; uz: number }[],
            boundary: [[-95, -95], [-95, 95], [95, 95], [95, -95]] as Vec2[], moles: [[[10, 10], [22, 26]] as Vec2[]]
        };
        const plants = placePlants(base);
        const at = (s: number, across: number) => [+(10 + 0.6 * s - 0.8 * across).toFixed(3), +(10 + 0.8 * s + 0.6 * across).toFixed(3)];
        expect(plants.filter(p => p.kind === 'boulder').map(p => [p.x, p.z])).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map(k => at(k * 2.6, 0)));
        const rocks = plants.filter(p => p.kind === 'rock').map(p => [p.x, p.z]);
        expect(rocks[0]).toEqual(at(0.65, 2.8));
        expect(rocks[1]).toEqual(at(1.95, -2.8));
        // An area, a building and a reserved box each take the stones near
        // them: the boulders at s = 0, 2.6 and 7.8, not those 7.8 m on
        const buildings = new BoxIndex();
        buildings.add({ ...at(2.6, 0).reduce((o, v, i) => ({ ...o, [i ? 'z' : 'x']: v }), {} as { x: number; z: number }), hw: 0.5, hd: 0.5, ux: 0, uz: 1 });
        const [rx, rz] = at(7.8, 0);
        const [ax, az] = at(0, 0);
        const has = (list: typeof plants, [x, z]: number[]) => list.some(p => p.kind === 'boulder' && p.x === x && p.z === z);
        const withArea = placePlants({ ...base, areas: [{ id: 'a', polygon: [[ax - 0.5, az - 0.5], [ax + 0.5, az - 0.5], [ax + 0.5, az + 0.5], [ax - 0.5, az + 0.5]], surface: 'asphalt', curb: false, connects: [] }] });
        expect(has(withArea, at(0, 0))).toBe(false);
        expect(has(withArea, at(7.8, 0))).toBe(true);
        const withBuilding = placePlants({ ...base, buildings });
        expect(has(withBuilding, at(2.6, 0))).toBe(false);
        expect(has(withBuilding, at(10.4, 0))).toBe(true);
        const withReserved = placePlants({ ...base, reserved: [{ x: rx, z: rz, hw: 0.5, hd: 0.5, ux: 0, uz: 1 }] });
        expect(has(withReserved, at(7.8, 0))).toBe(false);
        expect(has(withReserved, at(15.6, 0))).toBe(true);
        // Size and looks from a hash of the mole and the step: another mole index, other sizes
        const second = placePlants({ ...base, moles: [[[-50, -50], [-49, -50]] as Vec2[], ...base.moles] });
        expect(second.filter(p => p.x > 0).map(p => p.size)).not.toEqual(plants.map(p => p.size));
    });
});

describe('arenaFence', () => {
    it('fences the lot 0.5 m inside its outline with a gap for the gate, and borders the Party there', () => {
        const area: RoadArea = { id: 'lot', polygon: [[-260, 520], [-260, 660], [-80, 660], [-80, 520]], surface: 'concrete', curb: false, connects: [] };
        const fence = arenaFence(area, { x: -170, z: 520, yaw: 0, width: 12 });
        expect(fence.border).toEqual({ minX: -259.5, maxX: -80.5, minZ: 520.5, maxZ: 659.5 });
        // From the gap's west end round the lot to its east end
        expect(fence.lines).toEqual([[[-176, 520.5], [-259.5, 520.5], [-259.5, 659.5], [-80.5, 659.5], [-80.5, 520.5], [-164, 520.5]]]);
        expect(fence.gate).toMatchObject({ kind: 'segment', ax: -164, az: 520.5, bx: -176, bz: 520.5, top: Infinity });
        // A gate on the east side
        const east = arenaFence(area, { x: -80, z: 600, yaw: Math.PI / 2, width: 10 });
        expect(east.gate).toMatchObject({ ax: -80.5, az: 605, bx: -80.5, bz: 595 });
        expect(east.lines[0][0]).toEqual([-80.5, 595]);
        expect(east.lines[0].at(-1)).toEqual([-80.5, 605]);
        // A gate on the west side (the first side of the ring): from the
        // gap's south end round the east of the lot back to its north end
        const west = arenaFence(area, { x: -260, z: 600, yaw: -Math.PI / 2, width: 10 });
        expect(west.lines).toEqual([[[-259.5, 605], [-259.5, 659.5], [-80.5, 659.5], [-80.5, 520.5], [-259.5, 520.5], [-259.5, 595]]]);
        expect(west.gate).toMatchObject({ ax: -259.5, az: 595, bx: -259.5, bz: 605 });
    });
});

describe('zoneFence', () => {
    it('runs round the rectangle and leaves out the stretches inside a wall, to the metre', () => {
        const none = new BoxIndex();
        // Corner to corner, counter-clockwise from (minX, minZ)
        expect(zoneFence({ minX: 0, minZ: 0, maxX: 100, maxZ: 50 }, none)).toEqual([
            [[0, 0], [0, 50]], [[0, 50], [100, 50]], [[100, 50], [100, 0]], [[100, 0], [0, 0]]
        ]);
        // A building across the side z = 50 from x = 40.3 to 59.7: the fence
        // stops within a 1 m step of its walls (a step is left out when its
        // middle, x + 0.5, lies in the building: 40.5 and 59.5 do)
        const walls = new BoxIndex();
        walls.add({ x: 50, z: 50, hw: 9.7, hd: 5, ux: 0, uz: 1 });
        const lines = zoneFence({ minX: 0, minZ: 0, maxX: 100, maxZ: 50 }, walls);
        expect(lines).toEqual([
            [[0, 0], [0, 50]], [[0, 50], [40, 50]], [[60, 50], [100, 50]], [[100, 50], [100, 0]], [[100, 0], [0, 0]]
        ]);
        // A wall over a corner takes the ends of both sides
        const corner = new BoxIndex();
        corner.add({ x: 100, z: 0, hw: 5.5, hd: 3.5, ux: 0, uz: 1 });
        expect(zoneFence({ minX: 0, minZ: 0, maxX: 100, maxZ: 50 }, corner)).toEqual([
            [[0, 0], [0, 50]], [[0, 50], [100, 50]], [[100, 50], [100, 4]], [[94, 0], [0, 0]]
        ]);
    });
});

describe('boundaryFence', () => {
    it('fences the boundary in pieces of at most 16 m, except over the sea', () => {
        // The sea west of x = -50
        const hf = makeHeightfield(x => (x < -50 ? -5 : 2));
        const boundary: Vec2[] = [[-90, -90], [-90, 90], [90, 90], [90, -90]];
        const pieces = boundaryFence(boundary, hf);
        for (const piece of pieces) {
            expect(Math.hypot(piece.bx - piece.ax, piece.bz - piece.az)).toBeLessThanOrEqual(FENCE_PIECE + 1e-9);
            // Some ground under the piece above the drivable depth: at x = -50
            // the ground rises from -5 to 2 m within the 2 m cell west of it,
            // past -0.6 m at x = -50.63
            expect(Math.max(piece.ax, piece.bx)).toBeGreaterThan(-50.63);
            expect(piece.top).toBe(Infinity);
        }
        // The west side is sea: 3 sides of 180 m in 12 pieces each, and the
        // parts of the north and south sides over land (x > -50: 140 m of 180)
        expect(pieces.filter(p => p.ax === 90 && p.bx === 90)).toHaveLength(12);
        expect(pieces.some(p => p.ax === -90 && p.bx === -90)).toBe(false);
    });

    it('cuts each side into the fewest equal pieces and keeps a piece wherever its ground lies above the sea', () => {
        // The sea west of x = -50 and south of z = -60
        const hf = makeHeightfield((x, z) => (x < -50 || z < -60 ? -5 : 2));
        // Sides of 160 m: exactly ten pieces of 16 m each. On the east side
        // (x = 80) the last one, from z = -64 to -80, lies over the sea
        const pieces = boundaryFence([[-80, -80], [-80, 80], [80, 80], [80, -80]], hf);
        const east = pieces.filter(p => p.ax === 80 && p.bx === 80);
        expect(east).toHaveLength(9);
        for (const p of east) expect(Math.abs(p.bz - p.az)).toBeCloseTo(16, 9);
        // North side (z = 80) from x = -80: pieces from -80, -64, -48, ...;
        // the first lies over the sea from end to end, the second reaches land at -50
        expect(pieces.filter(p => p.az === 80 && p.bz === 80)).toHaveLength(9);
        // The south side (z = -80) is all sea
        expect(pieces.some(p => p.az === -80 && p.bz === -80)).toBe(false);
    });

    it('fences shallow water a car still drives through, not water deep enough for the reset', () => {
        // West of x = -50 the sea floor lies 0.3 m deep (a car drives on up
        // to 0.6 m, vehicle.ts WATER_DEPTH), west of x = -70 2 m deep
        const hf = makeHeightfield(x => (x < -70 ? -2 : x < -50 ? -0.3 : 2));
        const pieces = boundaryFence([[-90, -90], [-90, 90], [90, 90], [90, -90]], hf);
        // The north side (z = 90) from x = -90 in 12 pieces of 15 m: only the
        // first (-90 .. -75) lies over deep water from end to end
        expect(pieces.filter(p => p.az === 90 && p.bz === 90).map(p => p.ax)).toEqual([-75, -60, -45, -30, -15, 0, 15, 30, 45, 60, 75]);
        expect(pieces.some(p => p.ax === -90 && p.bx === -90)).toBe(false);
    });
});

describe('roadResetPose', () => {
    const net = buildRoadNetwork(network([
        node('w', -90, 0), node('e', 90, 0), node('s', 0, 40), node('n', 0, 80), node('a', -70, 30), node('b', -70, 90)
    ], [
        edge('main', 'w', 'e'), edge('oneway', 's', 'n', [], { oneWay: true, overrides: { lanes: [1, 0] } }), edge('ns', 'a', 'b')
    ], {
        areas: [{ id: 'lot', polygon: [[30, 20], [30, 60], [70, 60], [70, 20]], surface: 'asphalt', curb: false, connects: [] }]
    }));
    const reset = roadResetPose(net);
    const pose = (x: number, z: number, yaw: number) => ({ ...createVehicleState(), x, z, yaw });

    it('puts the car into the right-hand lane of the nearest road, heading the way closest to its own', () => {
        // Facing east (+x): right of it is +z; the lane is half a half width out
        const east = pose(-40, -12, Math.PI / 2 + 0.4);
        expect(reset(east)).toBe(true);
        expect([east.x, east.z]).toEqual([expect.closeTo(-40, 6), expect.closeTo(2.5, 6)]);
        expect(east.yaw).toBeCloseTo(Math.PI / 2, 9);
        // Facing west: the other lane
        const west = pose(-40, -12, -Math.PI / 2 - 0.4);
        expect(reset(west)).toBe(true);
        expect([west.x, west.z]).toEqual([expect.closeTo(-40, 6), expect.closeTo(-2.5, 6)]);
        expect(west.yaw).toBeCloseTo(-Math.PI / 2, 9);
        // Facing south (+z) on a north-south road: its right is west (-x)
        const south = pose(-64, 60, 0.3);
        expect(reset(south)).toBe(true);
        expect([south.x, south.z]).toEqual([expect.closeTo(-72.5, 6), expect.closeTo(60, 6)]);
        expect(south.yaw).toBeCloseTo(0, 9);
    });

    it('drives a one-way road only its way, in its middle', () => {
        // Facing north (-z) beside the one-way road that runs south (from s
        // at z = 40 to n at z = 80): turned round to face south, yaw 0
        const car = pose(6, 60, Math.PI);
        expect(reset(car)).toBe(true);
        expect([car.x, car.z]).toEqual([expect.closeTo(0, 6), expect.closeTo(60, 6)]);
        expect(car.yaw).toBeCloseTo(0, 9);
    });

    it('leaves a car on an area where it is', () => {
        const car = pose(50, 40, 1);
        expect(reset(car)).toBe(false);
        expect([car.x, car.z, car.yaw]).toEqual([50, 40, 1]);
    });

    it('resets a car beside an area that is not a rectangle, and one far from every road', () => {
        // A triangular lot: (60, 50) lies in its bounding box, not in it
        const triangle = buildRoadNetwork(network([node('w', -90, 0), node('e', 90, 0)], [edge('main', 'w', 'e')], {
            areas: [{ id: 'lot', polygon: [[30, 20], [30, 60], [70, 20]], surface: 'asphalt', curb: false, connects: [] }]
        }));
        const beside = pose(60, 50, Math.PI / 2);
        expect(roadResetPose(triangle)(beside)).toBe(true);
        expect([beside.x, beside.z]).toEqual([expect.closeTo(60, 6), expect.closeTo(2.5, 6)]);
        const inside = pose(40, 30, 1);
        expect(roadResetPose(triangle)(inside)).toBe(false);
        // 150 m south of the east-west road, beyond the first search radius
        // of 60 m: still onto that road, facing east
        const far = pose(20, -150, Math.PI / 2);
        expect(reset(far)).toBe(true);
        expect([far.x, far.z]).toEqual([expect.closeTo(20, 6), expect.closeTo(2.5, 6)]);
    });

    it('turns round on a diagonal road when the car faces more against it than along it', () => {
        // Two-way from (0, 0) to (100, 100): along it is (1, 1) / √2
        const diagonal = buildRoadNetwork(network([node('a', 0, 0), node('b', 100, 100)], [edge('d', 'a', 'b')]));
        // Heading (sin, cos) = (0.1, -0.995): 40 % along the road's x, but
        // its dot product with the road, (0.1 - 0.995) / √2, is negative
        const car = pose(50, 48, Math.atan2(0.1, -0.995));
        expect(roadResetPose(diagonal)(car)).toBe(true);
        expect(car.yaw).toBeCloseTo(-3 * Math.PI / 4, 9);
        // The nearest centre point (49 | 49), then 2.5 m to the right of
        // the heading (-1, -1) / √2, which is (1, -1) / √2
        expect([car.x, car.z]).toEqual([expect.closeTo(49 + 2.5 / Math.SQRT2, 6), expect.closeTo(49 - 2.5 / Math.SQRT2, 6)]);
        // Heading (-0.995, 0.1): against the road as well, mostly along its z
        const other = pose(50, 48, Math.atan2(-0.995, 0.1));
        expect(roadResetPose(diagonal)(other)).toBe(true);
        expect(other.yaw).toBeCloseTo(-3 * Math.PI / 4, 9);
    });
});

describe('heightfieldHash', () => {
    it('changes with a single height or surface value', () => {
        const hf = makeHeightfield(() => 1);
        const hash = heightfieldHash(hf);
        hf.q[5000]++;
        expect(heightfieldHash(hf)).not.toBe(hash);
        hf.q[5000]--;
        expect(heightfieldHash(hf)).toBe(hash);
        hf.surface[77] = SURFACE.sand;
        expect(heightfieldHash(hf)).not.toBe(hash);
    });
});

describe('Bulli Bay', () => {
    const map = mapFor();
    // Sweeping every building takes several seconds on a 4-core CI runner
    // with every worker busy (the default 5 s timed out there). The tests
    // that build the whole map again are in mapVariants.test.ts.
    const WHOLE_MAP_TIMEOUT = 30_000;

    it('holds the rails, the land border, landmarks, containers, ramps, buildings and plants, in that order', () => {
        const rails = networkRailColliders(map.net);
        expect(map.colliders.slice(0, rails.length)).toEqual(rails);
        const kinds = new Set(map.colliders.map(c => c.kind));
        expect(kinds).toEqual(new Set(['segment', 'obox', 'box', 'circle']));
        // One structure per landmark with a model, twelve containers
        const withModel = map.sources.pois.landmarks.filter(l => LANDMARK_PIECES[l.kind]);
        expect(map.structures.filter(s => s.kind !== 'container')).toHaveLength(withModel.length);
        expect(map.structures.filter(s => s.kind === 'container')).toHaveLength(12);
        // The jumps of pois.json and the arena's two ramps
        expect(map.ramps).toHaveLength((map.sources.pois.jumps ?? []).length + 2);
        // A town and a countryside (regression lock of the placement, see the commit)
        expect(map.buildings.length).toBeGreaterThan(400);
        expect(map.plants.length).toBeGreaterThan(1500);
    });

    it('keeps every building clear of the corridors and areas, in its zone, on level dry ground, apart from the others', { timeout: WHOLE_MAP_TIMEOUT }, () => {
        const boxes = map.buildings.map(placementBox);
        for (const [i, lot] of map.buildings.entries()) {
            let low = Infinity, high = -Infinity;
            for (const [x, z] of boxSamples(boxes[i], 2)) {
                expect(insideCorridor(map.net, x, z, 0.2), lot.edge).toBe(false);
                expect(zoneAt(map.hf, x, z)).toBe(lot.zone);
                for (const area of map.net.areas) expect(pointInPolygon(area.polygon, x, z)).toBe(false);
                const h = heightAt(map.hf, x, z);
                low = Math.min(low, h);
                high = Math.max(high, h);
            }
            expect(high - low).toBeLessThanOrEqual(2.5);
            expect(low).toBeGreaterThan(0.5);
        }
        const index = new BoxIndex();
        for (const box of boxes) {
            expect(index.overlaps(box, -0.05)).toBe(false);
            index.add(box);
        }
        for (const structure of map.structures) expect(boxes.some(b => boxesOverlap(b, placementBox(structure)))).toBe(false);
    });

    it('keeps every plant off the roads, out of the areas and the buildings, and above the water (talus down into the shallows)', () => {
        const buildings = new BoxIndex();
        for (const lot of map.buildings) buildings.add(placementBox(lot));
        let talus = 0, mole = 0;
        const moles = (map.sources.pois.moles ?? []).map(m => m.line);
        for (const plant of map.plants) {
            // Street palms stand on the sidewalk, every other plant beyond it;
            // none on the drivable road
            const r = PLANT_COLLIDERS[plant.kind].r * plant.size;
            for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
                expect(roadSurfaceIdAt(map.net, plant.x + dx, plant.z + dz), `${plant.kind} at ${plant.x}, ${plant.z}`).toBe(-1);
            }
            for (const area of map.net.areas) expect(pointInPolygon(area.polygon, plant.x, plant.z)).toBe(false);
            expect(buildings.contains(plant.x, plant.z, PLANT_COLLIDERS[plant.kind].r * plant.size)).toBe(false);
            // Rocks at the foot of a rock face may lie in the shallow water
            // at its foot, a breakwater's armour on the sea floor beside
            // its spit; everything else stands on dry ground
            const stone = plant.kind === 'rock' || plant.kind === 'boulder';
            const armour = stone && moles.some(line => polylineDistance(line, plant.x, plant.z) <= MOLE_FLANK + 0.1);
            const rock = stone && !armour && atRockFoot(map.hf, plant.x, plant.z);
            if (rock && heightAt(map.hf, plant.x, plant.z) <= 0.5) talus++;
            if (armour) mole++;
            expect(heightAt(map.hf, plant.x, plant.z)).toBeGreaterThan(armour ? -3 : rock ? TALUS_MIN_HEIGHT : 0.5);
        }
        expect(talus).toBeGreaterThan(10);
        expect(mole).toBeGreaterThan(20);
    });

    it('fences the Party\'s zone round the arena and the harbour yards, the gate open, and a Party ghost stops at its border', () => {
        const zone = map.partyZone;
        expect(zone).toEqual(map.sources.pois.party!.zone);
        const arena = map.net.areas.find(a => a.id === map.sources.pois.arena.area)!;
        for (const [x, z] of arena.polygon) expect(x >= zone.minX && x <= zone.maxX && z >= zone.minZ && z <= zone.maxZ).toBe(true);
        // The map's colliders, then the zone's fence (no gate)
        const extra = map.partyWorld.colliders.slice(map.colliders.length);
        expect(map.partyWorld.colliders.slice(0, map.colliders.length).map(c => c.kind)).toEqual(map.colliders.map(c => c.kind));
        expect(extra.length).toBeGreaterThan(80);
        const gate = map.arenaGate;
        expect(extra.some(c => c.kind === 'segment' && c.ax === gate.ax && c.az === gate.az && c.bx === gate.bx && c.bz === gate.bz)).toBe(false);
        // Every fence piece on the zone's outline, none inside a building
        const buildings = new BoxIndex();
        for (const lot of map.buildings) buildings.add(placementBox(lot));
        for (const c of extra) {
            if (c.kind !== 'segment') throw new Error('the fence is capsules');
            const onSide = (c.ax === c.bx && (c.ax === zone.minX || c.ax === zone.maxX)) || (c.az === c.bz && (c.az === zone.minZ || c.az === zone.maxZ));
            expect(onSide, `${c.ax} ${c.az} ${c.bx} ${c.bz}`).toBe(true);
            expect(buildings.contains((c.ax + c.bx) / 2, (c.az + c.bz) / 2)).toBe(false);
        }
        expect(map.fences.filter(f => f.party).length).toBeGreaterThan(4);

        // Out through the open gate northwards onto Cannery Lane, to the
        // fence across it at the zone's northern side
        const car = createSimCar('party', 'sport');
        const g = map.sources.pois.arena.gate;
        spawnVehicle(car.state, map.partyWorld, g.x, g.z + 20, Math.PI);
        let minZ = Infinity;
        for (let t = 0; t < 300; t++) {
            car.input.throttle = 255;
            stepWorld([car], map.partyWorld);
            minZ = Math.min(minZ, car.state.z);
        }
        expect(minZ).toBeLessThan(g.z - 5);
        expect(minZ).toBeGreaterThan(zone.minZ);
        // Free Roam drives on up Cannery Lane
        const roamer = createSimCar('roamer', 'sport');
        spawnVehicle(roamer.state, map.simWorld, g.x, g.z + 20, Math.PI);
        for (let t = 0; t < 300; t++) {
            roamer.input.throttle = 255;
            stepWorld([roamer], map.simWorld);
        }
        expect(roamer.state.z).toBeLessThan(zone.minZ - 20);
        // A Party ghost (no world colliders) north up Dock Street: stopped by the border
        const ghost = createSimCar('ghost', 'sport');
        spawnVehicle(ghost.state, map.partyWorld, -322, 560, Math.PI);
        ghost.mods.ghost = true;
        for (let t = 0; t < 300; t++) {
            ghost.input.throttle = 255;
            stepWorld([ghost], map.partyWorld);
            expect(ghost.state.z).toBeGreaterThan(zone.minZ);
        }
    });

    it('gives every landmark, container, the fountain and every plant its collider', () => {
        const circles = new Map<string, { r: number; top: number }>();
        const oboxes = new Map<string, number>();
        for (const c of map.colliders) {
            if (c.kind === 'circle') circles.set(`${c.x.toFixed(3)} ${c.z.toFixed(3)}`, { r: c.r, top: c.top });
            if (c.kind === 'obox') oboxes.set(`${c.x.toFixed(3)} ${c.z.toFixed(3)} ${c.hw} ${c.hd}`, c.top);
        }
        // Landmarks up to the sky, containers only 2.6 m high (a car can
        // land on one)
        for (const structure of map.structures) {
            const box = placementBox(structure);
            const top = oboxes.get(`${box.x.toFixed(3)} ${box.z.toFixed(3)} ${box.hw} ${box.hd}`);
            expect(top, structure.id).toBe(structure.kind === 'container' ? CONTAINER_TOP : Infinity);
        }
        const fountain = map.sources.pois.landmarks.find(l => l.kind === 'fountain')!;
        expect(circles.get(`${fountain.x.toFixed(3)} ${fountain.z.toFixed(3)}`)).toEqual({ r: FOUNTAIN_RADIUS, top: FOUNTAIN_TOP });
        // A plant's circle grows with its size, up to the sky or its height
        for (const plant of map.plants) {
            const shape = PLANT_COLLIDERS[plant.kind];
            const circle = circles.get(`${plant.x.toFixed(3)} ${plant.z.toFixed(3)}`);
            // (rounded to the millimetre)
            expect(circle?.r, `${plant.kind} at ${plant.x}, ${plant.z}`).toBeCloseTo(shape.r * plant.size, 2);
            if (shape.top === Infinity) expect(circle?.top).toBe(Infinity);
            else expect(circle?.top).toBeCloseTo(shape.top * plant.size, 2);
        }
    });

    it('lays each container along its pose, and every ramp of pois.json with a front wall', () => {
        for (const [i, pose] of map.sources.pois.arena.containers.entries()) {
            const box = placementBox(map.structures.find(s => s.id === `container-${i + 1}`)!);
            const fx = Math.sin(pose.yaw), fz = Math.cos(pose.yaw);
            // 40 ft: 12.2 m long, 2.4 m wide
            expect(boxContains(box, pose.x + 5.8 * fx, pose.z + 5.8 * fz), `container ${i + 1} ahead`).toBe(true);
            expect(boxContains(box, pose.x - 5.8 * fx, pose.z - 5.8 * fz), `container ${i + 1} behind`).toBe(true);
            expect(boxContains(box, pose.x + 2 * fz, pose.z - 2 * fx), `container ${i + 1} beside`).toBe(false);
        }
        const jumps = map.sources.pois.jumps ?? [];
        expect(map.ramps.slice(0, jumps.length).map(r => [r.id, r.x, r.z])).toEqual(jumps.map(j => [j.id, j.x, j.z]));
        for (const [i, ramp] of map.ramps.entries()) {
            // The front wall runs across the whole width; the side walls are thin
            const walls = map.colliders.filter(c => c.kind === 'box' && c.ramp === i);
            expect(walls.some(c => c.kind === 'box' && Math.max(c.hw, c.hd) > ramp.width / 2), ramp.id).toBe(true);
        }
    });

    it('keeps a 30 m run-up behind and the landing zone beyond every jump free of buildings and plants', () => {
        expect(JUMP_LANDING).toBe(45);
        expect(JUMP_RUNUP).toBe(30);
        expect(JUMP_SIDE).toBe(4);
        for (const ramp of map.ramps) {
            // From 30 m behind the ramp's rear edge to 45 m beyond its front
            // edge, 4 m to each side
            const fx = Math.sin(ramp.yaw), fz = Math.cos(ramp.yaw);
            const zone = {
                x: ramp.x + fx * 7.5, z: ramp.z + fz * 7.5,
                hw: ramp.width / 2 + 4, hd: ramp.length / 2 + 37.5, ux: fx, uz: fz
            };
            for (const plant of map.plants) expect(boxContains(zone, plant.x, plant.z), `${plant.kind} at ${plant.x}, ${plant.z} on ${ramp.id}`).toBe(false);
            for (const lot of map.buildings) expect(boxesOverlap(zone, placementBox(lot)), `${lot.edge} on ${ramp.id}`).toBe(false);
        }
    });

    it('leaves a straight run-up of 30 m behind every jump of pois.json free of colliders and deep water', () => {
        // The ramp's width, every metre along and across it, against every
        // collider near it but the ramp's own edge walls (a car on the ground)
        const jumps = map.ramps.slice(0, (map.sources.pois.jumps ?? []).length);
        const found = new Int32Array(map.colliders.length);
        const blocked: string[] = [];
        for (const [i, ramp] of jumps.entries()) {
            const fx = Math.sin(ramp.yaw), fz = Math.cos(ramp.yaw);
            for (let back = 0; back <= 30; back++) {
                for (let across = -ramp.width / 2; across <= ramp.width / 2; across++) {
                    const d = ramp.length / 2 + back;
                    const x = ramp.x - fx * d + fz * across, z = ramp.z - fz * d - fx * across;
                    if (map.ground.height(x, z) <= -0.6) blocked.push(`${ramp.id}: deep water ${back} m behind`);
                    const count = map.simWorld.grid.query(x - 1, z - 1, x + 1, z + 1, found);
                    for (let k = 0; k < count; k++) {
                        const c = map.simWorld.colliders[found[k]];
                        if (c.kind === 'box' && c.ramp === i) continue;
                        if (colliderHolds(c, x, z)) blocked.push(`${ramp.id} ${back} m behind: ${c.kind} ${found[k]}`);
                    }
                }
            }
        }
        expect(blocked).toEqual([]);
    });

    it('fences every stretch of its boundary a car can reach through shallow water', () => {
        // Every metre of the boundary with ground above the drivable depth
        // (0.6 m under the water level) lies on a fence capsule
        const fence = map.colliders.filter((c): c is SegmentCollider => c.kind === 'segment' && c.top === Infinity);
        const boundary = map.sources.map.boundary;
        let gaps = 0, at = '';
        for (let i = 0; i < boundary.length; i++) {
            const [ax, az] = boundary[i], [bx, bz] = boundary[(i + 1) % boundary.length];
            const n = Math.ceil(Math.hypot(bx - ax, bz - az));
            for (let k = 0; k <= n; k++) {
                const x = ax + (bx - ax) * k / n, z = az + (bz - az) * k / n;
                if (map.ground.height(x, z) <= -0.6) continue;
                const fenced = fence.some(c => {
                    if (Math.min(c.ax, c.bx) > x + 1 || Math.max(c.ax, c.bx) < x - 1 || Math.min(c.az, c.bz) > z + 1 || Math.max(c.az, c.bz) < z - 1) return false;
                    const ex = c.bx - c.ax, ez = c.bz - c.az;
                    const t = Math.max(0, Math.min(1, ((x - c.ax) * ex + (z - c.az) * ez) / (ex * ex + ez * ez)));
                    return Math.hypot(x - (c.ax + t * ex), z - (c.az + t * ez)) < 0.01;
                });
                if (!fenced) { gaps++; at = `${x.toFixed(1)} ${z.toFixed(1)}`; }
            }
        }
        expect(gaps, at).toBe(0);
    });

    it('puts the arena\'s items first, then the yards\', none collected, the power-ups taking turns', () => {
        const { arena, party } = map.sources.pois;
        expect(map.items.coins.map(c => [c.id, c.x, c.z])).toEqual([...arena.coins, ...party!.coins].map(([x, z], id) => [id, x, z]));
        expect(map.items.powerups.map(p => [p.id, p.x, p.z])).toEqual([...arena.powerups, ...party!.powerups].map(([x, z], id) => [id, x, z]));
        expect([...map.items.coins, ...map.items.powerups].every(item => item.collected === false)).toBe(true);
        const types = [...new Set(map.items.powerups.map(p => p.type))];
        expect(map.items.powerups.map(p => p.type)).toEqual(map.items.powerups.map((_, i) => types[i % types.length]));
    });

    it('keeps the cars in its 2 km square: the world border 2 m inside it, a collider grid of 16 m cells', () => {
        // 1001 heights 2 m apart: 2000 m
        expect(map.simWorld.bound).toBe(998);
        expect(map.ground.grid).toEqual({ origin: -1000, cellSize: 16, cells: 125 });
    });

    it('refuses a heightfield baked for another map version and an arena without its area', () => {
        expect(() => createMapData(map.sources, { ...map.hf, mapVersion: map.hf.mapVersion + 1 }))
            .toThrow(`terrain.bhf is baked for map version ${map.hf.mapVersion + 1}, map.json has ${map.mapVersion}`);
        const pois = structuredClone(map.sources.pois);
        pois.arena.area = 'no-such-lot';
        expect(() => createMapData({ ...map.sources, pois }, map.hf)).toThrow('pois.json: the arena\'s area no-such-lot is not in roads.json');
    });

    it('reads the surface and the water level of its heightfield', () => {
        for (const [x, z] of [[-400, -20], [-640, 0], [300, 300], [-700, 0]]) {
            expect(map.simWorld.surfaceAt(x, z)).toBe(map.hf.surface[Math.round((z + 1000) / 2) * 1001 + Math.round((x + 1000) / 2)]);
        }
        expect(map.simWorld.waterLevel).toBe(0);
        expect(map.simWorld.fallLimit).toBe(-20);
    });
});
