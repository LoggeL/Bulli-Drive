// The immutable data of a curated map at runtime (docs/phase-3-design.md,
// 7, 8, 11, 12 and 14, M3): the sources, the baked heightfield and road
// network, everything that stands in the sim world (rails and fences,
// landmarks, containers, jump ramps, buildings, trees and rocks), the sim
// worlds of Free Roam and the Party, the Party's items, the spawns per mode
// and a hash over all of it. The server builds it once per process and all
// rooms share it; the client builds the same from the same bytes and checks
// the hash against the server's ('roomState', docs/phase-1b-design.md, 6).

import { POWERUP_TYPES } from '../constants.js';
import type { CoinData, PowerupData } from '../protocol.js';
import type { VehicleState } from '../sim/types.js';
import {
    createSimWorld, rampEdgeColliders, type ColliderInput, type GroundModel, type RampDef, type SimWorld
} from '../world/colliders.js';
import { canonicalStringify, fnv1a } from '../world/mapData.js';
import { placeBuildings, type BuildingLot } from './buildings.js';
import { pointInPolygon, type Vec2 } from './geometry.js';
import { heightAt, surfaceAt, type Heightfield } from './heightfield.js';
import type { Landmark, PoisFile } from './mapFiles.js';
import type { MapSources } from './mapSources.js';
import { placePlants, PLANT_COLLIDERS, type Plant } from './plants.js';
import { benchBox, FURNITURE_COLLIDERS, placeFurniture, type Furniture } from './furniture.js';
import { networkRailColliders, RAIL_RADIUS, type SegmentCollider } from './rails.js';
import { buildRoadNetwork, nearestRoad, type RoadHit, type RoadNetwork } from './roadNetwork.js';
import { AXIS_SNAP, snapYaw } from './routeToTrack.js';
import type { RoadArea } from './roadSchema.js';
import {
    BoxIndex, placeByCentre, placementBox, toMillimetre, yawAxis, type KitPieceId, type OBox, type Placement
} from './structures.js';

// ---- Shapes ----

export type RampLook = 'steel' | 'earth' | 'sand' | 'wood';

/** A jump ramp of the map: the sim's RampDef with its ID and look; its index is its index in SimWorld.ramps. */
export interface MapRamp extends RampDef {
    id: string;
    look: RampLook;
}

/** A landmark or prop from pois.json with the kit piece that stands for it. */
export interface MapStructure extends Placement {
    id: string;
    kind: string;
}

export interface SpawnSlot {
    group: string;
    x: number;
    z: number;
    yaw: number;
}

export interface Rect {
    minX: number;
    minZ: number;
    maxX: number;
    maxZ: number;
}

export interface MapItems {
    powerups: PowerupData[];
    coins: CoinData[];
}

export interface MapData {
    mapId: string;
    mapVersion: number;
    name: string;
    sources: MapSources;
    hf: Heightfield;
    net: RoadNetwork;
    // Index = ramp index of the sim worlds
    ramps: readonly MapRamp[];
    structures: readonly MapStructure[];
    buildings: readonly BuildingLot[];
    plants: readonly Plant[];
    // Street lights, signals, hydrants, benches and trash cans (furniture.ts)
    furniture: readonly Furniture[];
    // Fences (looks and colliders): the arena's, with the gap of its gate,
    // and round the Party's zone (party: a collider in the Party world only,
    // left out where a building's wall closes the zone)
    fences: readonly { id: string; line: readonly Vec2[]; party?: boolean }[];
    // The arena's gate across that gap (a collider in the Party world when
    // the Party has no zone beyond the arena, else open)
    arenaGate: SegmentCollider;
    // The arena's fence rectangle, and the Party's zone: the border of its
    // world (the arena's rectangle without a zone in pois.json)
    arenaBounds: Rect;
    partyZone: Rect;
    colliders: readonly ColliderInput[];
    // The ground of every sim world on the map (heightfield, surfaces, water)
    ground: GroundModel;
    // Free Roam (and the base of the race worlds) and the Party arena
    simWorld: SimWorld;
    partyWorld: SimWorld;
    // The Party's coins and power-ups (rooms copy them)
    items: MapItems;
    spawns: { freeRoam: readonly SpawnSlot[]; party: readonly SpawnSlot[] };
    // FNV-1a over the canonical colliders, ramps, items, spawns and the heightfield
    worldHash: string;
}

// ---- Constants ----

// The collider grid over the 2 km square (8.2): 16 m cells
export const MAP_GRID_CELL = 16;
// A car below this is reset (8.3)
export const FALL_LIMIT = -20;
// Border fence: capsules of at most this length (a long diagonal capsule
// would sit in every grid cell of its bounding box)
export const FENCE_PIECE = 16;
// Arena fence: this far inside the lot's outline
export const ARENA_FENCE_INSET = 0.5;
// Landmark kinds and the kit piece that stands for them (A23, A41). Kinds
// without a piece have no collider (a square, a beach, a harbour basin, the
// lookout's lot); a quay crane collides with its caisson.
export const LANDMARK_PIECES: Partial<Record<Landmark['kind'], KitPieceId>> = {
    diner: 'landmark_diner',
    gasStation: 'landmark_gas_station',
    lighthouse: 'landmark_lighthouse',
    crane: 'landmark_quay_crane',
    waterTower: 'landmark_water_tower',
    lifeguardTower: 'lifeguard_tower',
    lightMast: 'arena_floodlight',
    cannery: 'industrial_b8_d36',
    barn: 'industrial_b4_d24',
    restaurant: 'beach_w11_f2_shop',
    surfShop: 'beach_w9_f1_shop'
};
// The plaza fountain: a basin one can jump onto (as in the old city)
export const FOUNTAIN_RADIUS = 5;
export const FOUNTAIN_TOP = 1.5;
// Shipping containers stand on the arena's concrete; a car can land on one
export const CONTAINER_TOP = 2.6;
// Places kept free of buildings and plants: around the jump ramps and their
// landings, around the spawns
export const JUMP_LANDING = 45;
export const JUMP_SIDE = 4;
export const SPAWN_KEEP = 8;

// ---- Builders ----

function segment(a: Vec2, b: Vec2, top: number): SegmentCollider {
    return {
        kind: 'segment',
        ax: toMillimetre(a[0]), az: toMillimetre(a[1]),
        bx: toMillimetre(b[0]), bz: toMillimetre(b[1]),
        r: RAIL_RADIUS, top
    };
}

// A straight line cut into equal capsules of at most `piece` m
function segmentChain(a: Vec2, b: Vec2, piece: number, top: number, out: SegmentCollider[]): void {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const n = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dz * dz) / piece - 1e-9));
    for (let k = 0; k < n; k++) {
        out.push(segment([a[0] + dx * k / n, a[1] + dz * k / n], [a[0] + dx * (k + 1) / n, a[1] + dz * (k + 1) / n], top));
    }
}

/**
 * The drivable boundary (8.3) as a fence of capsules that cannot be jumped
 * over, except where it runs over the sea: there the water reset holds the
 * cars back.
 */
export function boundaryFence(boundary: readonly Vec2[], hf: Heightfield): SegmentCollider[] {
    const out: SegmentCollider[] = [];
    const pieces: SegmentCollider[] = [];
    for (let i = 0; i < boundary.length; i++) {
        pieces.length = 0;
        segmentChain(boundary[i], boundary[(i + 1) % boundary.length], FENCE_PIECE, Infinity, pieces);
        for (const piece of pieces) {
            if (heightAt(hf, (piece.ax + piece.bx) / 2, (piece.az + piece.bz) / 2) > hf.spec.waterLevel) out.push(piece);
        }
    }
    return out;
}

// An axis-aligned rectangle's outline moved `inset` inwards
function insetRectangle(polygon: readonly Vec2[], inset: number): [number, number, number, number] {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const [x, z] of polygon) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    return [minX + inset, minZ + inset, maxX - inset, maxZ - inset];
}

/**
 * The arena's chain-link fence (12): round the lot, a gap for the gate.
 * The lot is an axis-aligned rectangle and the gate sits on one of its
 * sides, facing along an axis (the validator checks both). Returns the
 * fence as polylines and the gate across its gap.
 */
export function arenaFence(area: RoadArea, gate: PoisFile['arena']['gate']): {
    lines: Vec2[][]; gate: SegmentCollider; border: { minX: number; maxX: number; minZ: number; maxZ: number };
} {
    const [x0, z0, x1, z1] = insetRectangle(area.polygon, ARENA_FENCE_INSET);
    // Corners counter-clockwise from the north-west one (north = -z)
    const ring: Vec2[] = [[x0, z0], [x0, z1], [x1, z1], [x1, z0]];
    const half = gate.width / 2;
    // The side nearest to the gate, and where along it the gap lies
    let best = -1, bestDistance = Infinity;
    for (let i = 0; i < 4; i++) {
        const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % 4];
        const along = ax === bx;
        const d = along ? Math.abs(gate.x - ax) : Math.abs(gate.z - az);
        if (d < bestDistance) { bestDistance = d; best = i; }
    }
    const a = ring[best], b = ring[(best + 1) % 4];
    const dx = Math.sign(b[0] - a[0]), dz = Math.sign(b[1] - a[1]);
    // Gap ends on that side
    const centre: Vec2 = dx !== 0 ? [gate.x, a[1]] : [a[0], gate.z];
    const gapA: Vec2 = [centre[0] - dx * half, centre[1] - dz * half];
    const gapB: Vec2 = [centre[0] + dx * half, centre[1] + dz * half];
    const line: Vec2[] = [gapB, b, ring[(best + 2) % 4], ring[(best + 3) % 4], a, gapA];
    return { lines: [line], gate: segment(gapA, gapB, Infinity), border: { minX: x0, maxX: x1, minZ: z0, maxZ: z1 } };
}

// The Party zone's fence is laid in steps of this length; a step whose
// middle lies in a building is left out
export const ZONE_FENCE_STEP = 1;

/**
 * The fence round the Party's zone (12, A54): the rectangle's sides from
 * corner to corner, without the stretches inside a wall (a building or
 * landmark on the line closes the zone there itself; a fence through it
 * would only show). Returns the pieces as two-point lines.
 */
export function zoneFence(zone: Rect, walls: BoxIndex): Vec2[][] {
    const corners: Vec2[] = [[zone.minX, zone.minZ], [zone.minX, zone.maxZ], [zone.maxX, zone.maxZ], [zone.maxX, zone.minZ]];
    const lines: Vec2[][] = [];
    for (let i = 0; i < 4; i++) {
        const a = corners[i], b = corners[(i + 1) % 4];
        const length = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
        const n = Math.max(1, Math.round(length / ZONE_FENCE_STEP));
        const at = (k: number): Vec2 => [a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n];
        let start = -1;
        for (let k = 0; k <= n; k++) {
            const open = k < n && !walls.contains(a[0] + (b[0] - a[0]) * (k + 0.5) / n, a[1] + (b[1] - a[1]) * (k + 0.5) / n);
            if (open && start < 0) start = k;
            if (!open && start >= 0) {
                lines.push([at(start), at(k)]);
                start = -1;
            }
        }
    }
    return lines;
}

/** The pieces and placements of the landmarks that have a model (and the fountain's basin). */
export function landmarkStructures(pois: PoisFile): MapStructure[] {
    const out: MapStructure[] = [];
    for (const landmark of pois.landmarks) {
        const piece = LANDMARK_PIECES[landmark.kind];
        if (!piece) continue;
        const [ux, uz] = yawAxis(landmark.yaw ?? 0);
        out.push({ id: landmark.id, kind: landmark.kind, ...placeByCentre(piece, landmark.x, landmark.z, ux, uz) });
    }
    return out;
}

/** The arena's containers: the kit's 40 ft container, its length along the pose's yaw. */
export function containerStructures(pois: PoisFile): MapStructure[] {
    return pois.arena.containers.map((pose, i) => {
        const [fx, fz] = yawAxis(pose.yaw);
        // The piece is long along its local x axis (uz, -ux): turn it so that
        // this is the pose's forward (fx, fz)
        return { id: `container-${i + 1}`, kind: 'container', ...placeByCentre('arena_container_40', pose.x, pose.z, -fz, fx) };
    });
}

function boxCollider(box: OBox, top: number): ColliderInput {
    return {
        kind: 'obox',
        x: toMillimetre(box.x), z: toMillimetre(box.z),
        hw: box.hw, hd: box.hd, ux: box.ux, uz: box.uz, top
    };
}

// The ramps of the whole map: the jumps, then the arena's (12). Their
// yaws snap onto the nearest axis within 1° (A31): the sim builds a ramp's
// edge walls as axis-aligned boxes.
function mapRamps(pois: PoisFile): MapRamp[] {
    const jumps: MapRamp[] = (pois.jumps ?? []).map(({ id, x, z, yaw, width, length, height, look }) =>
        ({ id, x, z, yaw: snapYaw(yaw, AXIS_SNAP), width, length, height, look }));
    const arena: MapRamp[] = pois.arena.ramps.map((ramp, i) =>
        ({ id: `arena-ramp-${i + 1}`, ...ramp, yaw: snapYaw(ramp.yaw, AXIS_SNAP), look: 'steel' as const }));
    return [...jumps, ...arena];
}

// A ramp with the ground beyond its front edge where cars land
function jumpZone(ramp: RampDef): OBox {
    const [ux, uz] = yawAxis(ramp.yaw);
    const forward = JUMP_LANDING / 2;
    return {
        x: ramp.x + ux * forward, z: ramp.z + uz * forward,
        hw: ramp.width / 2 + JUMP_SIDE, hd: ramp.length / 2 + forward,
        ux, uz
    };
}

function spawnZone(x: number, z: number): OBox {
    return { x, z, hw: SPAWN_KEEP, hd: SPAWN_KEEP, ux: 0, uz: 1 };
}

// ---- Reset onto the road (8.3) ----

/**
 * The reset target of Free Roam: a car on an area (a parking lot, the
 * arena, the pier) stays where it is; otherwise the nearest point of the
 * nearest road's centre line, facing along the road in the direction
 * closest to the car's heading (a one-way road only its way), in the
 * middle of the right-hand half of a two-way road.
 */
export function roadResetPose(net: RoadNetwork): (s: VehicleState) => boolean {
    const hit: RoadHit = { edge: net.edges[0], s: 0, x: 0, z: 0, tx: 0, tz: 0, distance: 0, lateral: 0 };
    return (s: VehicleState): boolean => {
        for (let i = 0; i < net.areas.length; i++) {
            const b = 4 * i;
            if (s.x < net.areaBounds[b] || s.x > net.areaBounds[b + 2] || s.z < net.areaBounds[b + 1] || s.z > net.areaBounds[b + 3]) continue;
            if (pointInPolygon(net.areas[i].polygon, s.x, s.z)) return false;
        }
        const found = nearestRoad(net, s.x, s.z, 60, hit) ?? nearestRoad(net, s.x, s.z, 400, hit) ?? nearestRoad(net, s.x, s.z, 3000, hit);
        if (!found) return false;
        // determinism: the sim's own heading (a reset is not hashed; the
        // prediction corrects a last-bit difference like any other)
        const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw); // determinism: see above
        const sign = found.edge.def.oneWay || found.tx * fx + found.tz * fz >= 0 ? 1 : -1;
        const tx = found.tx * sign, tz = found.tz * sign;
        const lanes = found.edge.profile.lanes;
        const offset = lanes[0] > 0 && lanes[1] > 0 ? found.edge.halfWidth / 2 : 0;
        // Right of the heading (tx, tz) is (-tz, tx)
        s.x = found.x - tz * offset;
        s.z = found.z + tx * offset;
        s.yaw = Math.atan2(tx, tz); // determinism: as the race world's lineResetPose
        return true;
    };
}

// ---- Hash ----

// FNV-1a over the heightfield's height and surface layers (hex)
export function heightfieldHash(hf: Heightfield): string {
    let h = 0x811c9dc5;
    const q = hf.q, surface = hf.surface;
    for (let i = 0; i < q.length; i++) h = Math.imul(h ^ q[i], 0x01000193);
    for (let i = 0; i < surface.length; i++) h = Math.imul(h ^ surface[i], 0x01000193);
    return (h >>> 0).toString(16).padStart(8, '0');
}

// ---- The map ----

export function createMapData(sources: MapSources, hf: Heightfield): MapData {
    const { roads, map, pois } = sources;
    if (hf.mapVersion !== map.mapVersion) {
        throw new Error(`terrain.bhf is baked for map version ${hf.mapVersion}, map.json has ${map.mapVersion}`);
    }
    const net = buildRoadNetwork(roads);
    const ramps = mapRamps(pois);
    const structures = [...landmarkStructures(pois), ...containerStructures(pois)];
    const arenaArea = net.areas.find(area => area.id === pois.arena.area);
    if (!arenaArea) throw new Error(`pois.json: the arena's area ${pois.arena.area} is not in roads.json`);
    const arena = arenaFence(arenaArea, pois.arena.gate);

    // Reserved for landmarks, jumps and spawns: no building or plant there
    const reserved: OBox[] = [
        ...structures.map(placementBox),
        ...ramps.map(jumpZone),
        ...pois.spawns.freeRoam.map(slot => spawnZone(slot.x, slot.z)),
        ...pois.spawns.party.map(slot => spawnZone(slot.x, slot.z))
    ];
    const buildings = placeBuildings({ net, hf, areas: net.areas, reserved });
    const buildingIndex = new BoxIndex();
    for (const lot of buildings) buildingIndex.add(placementBox(lot));
    const plants = placePlants({ net, hf, areas: net.areas, boundary: map.boundary, buildings: buildingIndex, reserved });
    const fountains = pois.landmarks.filter(landmark => landmark.kind === 'fountain').map(({ x, z }): [number, number] => [x, z]);
    const furniture = placeFurniture({ net, hf, areas: net.areas, boundary: map.boundary, buildings: buildingIndex, reserved, plants, fountains });

    // The colliders, in a fixed order (it decides the order of the
    // collision response): rails, the border, the arena fence, landmarks
    // and containers, the ramps' edge walls, buildings, plants, street
    // furniture
    const colliders: ColliderInput[] = [...networkRailColliders(net), ...boundaryFence(map.boundary, hf)];
    for (const line of arena.lines) {
        for (let i = 1; i < line.length; i++) segmentChain(line[i - 1], line[i], 8, Infinity, colliders as SegmentCollider[]);
    }
    const fountain = pois.landmarks.find(landmark => landmark.kind === 'fountain');
    for (const structure of structures) {
        colliders.push(boxCollider(placementBox(structure), structure.kind === 'container' ? CONTAINER_TOP : Infinity));
    }
    if (fountain) colliders.push({ kind: 'circle', x: fountain.x, z: fountain.z, r: FOUNTAIN_RADIUS, top: FOUNTAIN_TOP });
    const ground = (x: number, z: number) => heightAt(hf, x, z);
    ramps.forEach((ramp, i) => colliders.push(...rampEdgeColliders(ramp, i, true, ground)));
    for (const lot of buildings) colliders.push(boxCollider(placementBox(lot), Infinity));
    for (const plant of plants) {
        const shape = PLANT_COLLIDERS[plant.kind];
        colliders.push({ kind: 'circle', x: plant.x, z: plant.z, r: toMillimetre(shape.r * plant.size), top: shape.top === Infinity ? Infinity : toMillimetre(shape.top * plant.size) });
    }
    for (const piece of furniture) {
        if (piece.kind === 'bench') colliders.push(boxCollider(benchBox(piece), FURNITURE_COLLIDERS.bench.top));
        else colliders.push({ kind: 'circle', x: piece.x, z: piece.z, r: FURNITURE_COLLIDERS[piece.kind].r, top: FURNITURE_COLLIDERS[piece.kind].top });
    }

    const spec = hf.spec;
    const extent = (spec.cols - 1) * spec.cellSize;
    const model: GroundModel = {
        height: ground,
        surface: (x, z) => surfaceAt(hf, x, z),
        waterLevel: spec.waterLevel,
        fallLimit: FALL_LIMIT,
        // The square of the data; the border fence and the sea keep the cars
        // well inside it
        bound: extent / 2 - 2,
        grid: { origin: spec.originX, cellSize: MAP_GRID_CELL, cells: Math.ceil(extent / MAP_GRID_CELL) }
    };
    const rampDefs: RampDef[] = ramps.map(({ x, z, yaw, width, length, height }) => ({ x, z, yaw, width, length, height }));
    const simWorld = createSimWorld(model, colliders, rampDefs);
    simWorld.resetPose = roadResetPose(net);
    // The Party's world: its zone fenced (the arena's gate open), or without
    // a zone the arena behind its closed gate; a reset there leaves the car
    // where it is. The world border is the zone's (the fence's) rectangle,
    // so a Party ghost (no world colliders) cannot leave either.
    const partyZone: Rect = pois.party?.zone ?? arena.border;
    const walls = new BoxIndex();
    for (const lot of buildings) walls.add(placementBox(lot));
    for (const structure of structures) if (structure.kind !== 'container') walls.add(placementBox(structure));
    const partyFence = pois.party ? zoneFence(partyZone, walls) : [];
    const partyColliders: SegmentCollider[] = [];
    for (const [a, b] of partyFence) segmentChain(a, b, 8, Infinity, partyColliders);
    if (!pois.party) partyColliders.push(arena.gate);
    const partyWorld = createSimWorld(model, [...colliders, ...partyColliders], rampDefs);
    partyWorld.border = partyZone;

    // The arena's items first, then the yards' (ids in that order, power-up
    // types in turn over all of them)
    const coinPoints = [...pois.arena.coins, ...(pois.party?.coins ?? [])];
    const powerupPoints = [...pois.arena.powerups, ...(pois.party?.powerups ?? [])];
    const items: MapItems = {
        powerups: powerupPoints.map(([x, z], id) => {
            const type = POWERUP_TYPES[id % POWERUP_TYPES.length];
            return { id, x, z, type: type.type, color: type.color, label: type.label, collected: false };
        }),
        coins: coinPoints.map(([x, z], id) => ({ id, x, z, collected: false }))
    };
    const spawns = {
        freeRoam: pois.spawns.freeRoam.map(({ group, x, z, yaw }) => ({ group, x, z, yaw })),
        party: pois.spawns.party.map(({ group, x, z, yaw }) => ({ group: group ?? 'arena', x, z, yaw }))
    };
    const worldHash = fnv1a(canonicalStringify({
        mapId: map.mapId, mapVersion: map.mapVersion, terrain: heightfieldHash(hf),
        colliders, gate: arena.gate, party: { zone: partyZone, colliders: partyColliders }, ramps: rampDefs, items, spawns
    }));

    return {
        mapId: map.mapId, mapVersion: map.mapVersion, name: map.name,
        sources, hf, net, ramps, structures, buildings, plants, furniture,
        fences: [
            ...arena.lines.map((line, i) => ({ id: `arena-fence-${i + 1}`, line })),
            ...partyFence.map((line, i) => ({ id: `party-fence-${i + 1}`, line, party: true }))
        ],
        arenaGate: arena.gate,
        arenaBounds: arena.border,
        partyZone,
        colliders, ground: model, simWorld, partyWorld, items, spawns, worldHash
    };
}
