import { describe, expect, it } from 'vitest';
import { mapFor } from '../../../src/server/maps.js';
import { LOT_RULES, placeBuildings } from '../../../src/shared/map/buildings.js';
import { pointInPolygon, type Vec2 } from '../../../src/shared/map/geometry.js';
import { heightAt, zoneAt, type GridSpec, type Heightfield } from '../../../src/shared/map/heightfield.js';
import {
    arenaFence, boundaryFence, createMapData, FENCE_PIECE, heightfieldHash, LANDMARK_PIECES, roadResetPose
} from '../../../src/shared/map/mapData.js';
import { PLANT_COLLIDERS, plantFits } from '../../../src/shared/map/plants.js';
import { networkRailColliders } from '../../../src/shared/map/rails.js';
import { buildRoadNetwork, insideCorridor, roadSurfaceIdAt } from '../../../src/shared/map/roadNetwork.js';
import type { RoadArea } from '../../../src/shared/map/roadSchema.js';
import { BoxIndex, boxesOverlap, boxSamples, KIT_FOOTPRINTS, placementBox } from '../../../src/shared/map/structures.js';
import { SURFACE, ZONE } from '../../../src/shared/map/types.js';
import { createVehicleState } from '../../../src/shared/sim/types.js';
import { createSimCar, spawnVehicle } from '../../../src/shared/sim/vehicle.js';
import { stepWorld } from '../../../src/shared/sim/world.js';
import { edge, network, node, PROFILE } from './fixtures.js';

// The map's runtime data (src/shared/map/mapData.ts, docs/phase-3-design.md,
// 8, 11 and 12): on small hand-built maps with expectations from the rules,
// and invariants of Bulli Bay's own data.

// A 200 × 200 m heightfield (2 m grid) from functions of the position
function makeHeightfield(height: (x: number, z: number) => number, zone: (x: number, z: number) => number = () => ZONE.downtown,
    surface: (x: number, z: number) => number = () => SURFACE.grass): Heightfield {
    const spec: GridSpec = { cols: 101, rows: 101, cellSize: 2, originX: -100, originZ: -100, heightOffset: -20, heightScale: 0.01, waterLevel: 0, zoneCell: 8 };
    const q = new Uint16Array(101 * 101), s = new Uint8Array(101 * 101);
    for (let j = 0; j < 101; j++) {
        for (let i = 0; i < 101; i++) {
            const x = -100 + 2 * i, z = -100 + 2 * j;
            q[j * 101 + i] = Math.round((height(x, z) + 20) / 0.01);
            s[j * 101 + i] = surface(x, z);
        }
    }
    const zones = new Uint8Array(25 * 25);
    for (let j = 0; j < 25; j++) for (let i = 0; i < 25; i++) zones[j * 25 + i] = zone(-100 + 8 * i + 4, -100 + 8 * j + 4);
    return { spec, q, surface: s, zones, mapVersion: 1, sourceHash: new Uint8Array(16) };
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
                expect(LOT_RULES[ZONE.downtown]!.pieces).toContain(lot.piece);
            }
            // Gapless: each house starts where the one before ends (a gap of 2 m
            // steps only where a house did not fit, at the ends of the road)
            let closed = 0;
            for (let i = 1; i < row.length; i++) {
                const a = KIT_FOOTPRINTS[row[i - 1].piece], b = KIT_FOOTPRINTS[row[i].piece];
                const gap = row[i].x - row[i - 1].x - ((a.maxX - a.minX) + (b.maxX - b.minX)) / 2;
                expect(Math.abs(gap) < 0.01 || gap >= 2 - 0.01, `gap ${gap}`).toBe(true);
                if (Math.abs(gap) < 0.01) closed++;
            }
            expect(closed).toBeGreaterThan((row.length - 1) / 2);
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
            expect((piece.ax + piece.bx) / 2).toBeGreaterThan(-50);
            expect(piece.top).toBe(Infinity);
        }
        // The west side is sea: 3 sides of 180 m in 12 pieces each, and the
        // parts of the north and south sides over land (x > -50: 140 m of 180)
        expect(pieces.filter(p => p.ax === 90 && p.bx === 90)).toHaveLength(12);
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

    it('builds the same world twice, and a moved coin or height changes its hash', () => {
        expect(createMapData(map.sources, map.hf).worldHash).toBe(map.worldHash);
        const pois = structuredClone(map.sources.pois);
        pois.arena.coins[0][0] += 1;
        expect(createMapData({ ...map.sources, pois }, map.hf).worldHash).not.toBe(map.worldHash);
        const q = map.hf.q.slice();
        q[123456]++;
        expect(createMapData(map.sources, { ...map.hf, q }).worldHash).not.toBe(map.worldHash);
    });

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

    it('keeps every building clear of the corridors and areas, in its zone, on level dry ground, apart from the others', () => {
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

    it('keeps every plant off the roads, out of the areas and the buildings, and above the water', () => {
        const buildings = new BoxIndex();
        for (const lot of map.buildings) buildings.add(placementBox(lot));
        for (const plant of map.plants) {
            // Street palms stand on the sidewalk, every other plant beyond it;
            // none on the drivable road
            const r = PLANT_COLLIDERS[plant.kind].r * plant.size;
            for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
                expect(roadSurfaceIdAt(map.net, plant.x + dx, plant.z + dz), `${plant.kind} at ${plant.x}, ${plant.z}`).toBe(-1);
            }
            for (const area of map.net.areas) expect(pointInPolygon(area.polygon, plant.x, plant.z)).toBe(false);
            expect(buildings.contains(plant.x, plant.z, PLANT_COLLIDERS[plant.kind].r * plant.size)).toBe(false);
            expect(heightAt(map.hf, plant.x, plant.z)).toBeGreaterThan(0.5);
        }
    });

    it('fences the Party in: the gate is shut there, and a Party ghost stops at the arena\'s border', () => {
        expect(map.partyWorld.colliders).toHaveLength(map.colliders.length + 1);
        expect(map.simWorld.colliders).toHaveLength(map.colliders.length);
        const arena = map.net.areas.find(a => a.id === map.sources.pois.arena.area)!;
        // Through the gate northwards at full throttle, as a ghost (no world colliders)
        const gate = map.sources.pois.arena.gate;
        const car = createSimCar('ghost', 'sport');
        spawnVehicle(car.state, map.partyWorld, gate.x, gate.z + 20, Math.PI);
        car.mods.ghost = true;
        for (let t = 0; t < 180; t++) {
            car.input.throttle = 255;
            stepWorld([car], map.partyWorld);
            expect(pointInPolygon(arena.polygon, car.state.x, car.state.z)).toBe(true);
        }
        // Free Roam drives out of the open gate
        const roamer = createSimCar('roamer', 'sport');
        spawnVehicle(roamer.state, map.simWorld, gate.x, gate.z + 20, Math.PI);
        for (let t = 0; t < 180; t++) {
            roamer.input.throttle = 255;
            stepWorld([roamer], map.simWorld);
        }
        expect(roamer.state.z).toBeLessThan(gate.z - 5);
    });

    it('reads the surface and the water level of its heightfield', () => {
        for (const [x, z] of [[-400, -20], [-640, 0], [300, 300], [-700, 0]]) {
            expect(map.simWorld.surfaceAt(x, z)).toBe(map.hf.surface[Math.round((z + 1000) / 2) * 1001 + Math.round((x + 1000) / 2)]);
        }
        expect(map.simWorld.waterLevel).toBe(0);
        expect(map.simWorld.fallLimit).toBe(-20);
    });
});
