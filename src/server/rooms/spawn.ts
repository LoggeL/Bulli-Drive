import type { CityData } from '../../shared/protocol.js';
import { CITY_LAYOUT, PLAZA_PROP_LAYOUT } from '../../shared/constants.js';
import type { RandomSource } from '../../shared/math/rng.js';
import { blockCenter, PLAZA_BLOCK } from '../../shared/world/cityGen.js';

// Where a car (re)spawns: a random spot on a road or the plaza that is clear
// of buildings, the plaza props, the other players of the same room and the
// room's pickups (a car must not earn a coin by spawning on it). The random
// source defaults to Math.random; tests pass a scripted one.

export interface SpawnPoint {
    x: number;
    z: number;
}

// Where a car spawns and which way it faces
export interface SpawnPose extends SpawnPoint {
    yaw: number;
}

// A circle no car spawns in (a coin or powerup with its pickup radius)
export interface SpawnKeepOut extends SpawnPoint {
    radius: number;
}

const SPAWN_ATTEMPTS = 80;
const SPAWN_PLAZA_CHANCE = 0.2;
const SPAWN_BUILDING_MARGIN = 4;
const SPAWN_ROAD_EDGE_MARGIN = 2;
const SPAWN_ROAD_END_MARGIN = 4;
const SPAWN_PLAYER_SPACING = 12;
// Fountain radius is 5 on the client; this also leaves room for the car.
const SPAWN_FOUNTAIN_CLEARANCE = 9;
const SPAWN_PROP_MARGIN = 2;

function plazaLayout(): { x: number; z: number; halfSize: number } {
    const center = blockCenter(PLAZA_BLOCK.x, PLAZA_BLOCK.z);
    return {
        x: center.x,
        z: center.z,
        halfSize: CITY_LAYOUT.blockSize / 2 - SPAWN_BUILDING_MARGIN
    };
}

function randomRoadPoint(city: CityData, random: RandomSource): SpawnPoint | null {
    if (city.roads.length === 0) return null;

    const road = city.roads[Math.floor(random() * city.roads.length)];
    const halfAcross = Math.max(0, road.width / 2 - SPAWN_ROAD_EDGE_MARGIN);
    const halfAlong = Math.max(0, road.length / 2 - SPAWN_ROAD_END_MARGIN);
    const acrossOffset = (random() * 2 - 1) * halfAcross;
    const alongOffset = (random() * 2 - 1) * halfAlong;

    // These axes match client/world/city.ts: width is across the road and
    // length is along it after applying rotation.
    const acrossX = Math.cos(road.rotation);
    const acrossZ = Math.sin(road.rotation);
    const alongX = Math.sin(road.rotation);
    const alongZ = Math.cos(road.rotation);
    return {
        x: road.x + acrossX * acrossOffset + alongX * alongOffset,
        z: road.z + acrossZ * acrossOffset + alongZ * alongOffset
    };
}

function randomPlazaPoint(random: RandomSource): SpawnPoint {
    const plaza = plazaLayout();
    return {
        x: plaza.x + (random() * 2 - 1) * plaza.halfSize,
        z: plaza.z + (random() * 2 - 1) * plaza.halfSize
    };
}

export function clearsStaticObstacles(city: CityData, point: SpawnPoint): boolean {
    for (const building of city.buildings) {
        const halfWidth = building.width / 2 + SPAWN_BUILDING_MARGIN;
        const halfDepth = building.depth / 2 + SPAWN_BUILDING_MARGIN;
        if (Math.abs(point.x - building.x) < halfWidth &&
            Math.abs(point.z - building.z) < halfDepth) {
            return false;
        }
    }

    const plaza = plazaLayout();
    const fountainDx = point.x - plaza.x;
    const fountainDz = point.z - plaza.z;
    if (fountainDx * fountainDx + fountainDz * fountainDz <
        SPAWN_FOUNTAIN_CLEARANCE * SPAWN_FOUNTAIN_CLEARANCE) {
        return false;
    }

    for (const signX of [-1, 1]) {
        for (const signZ of [-1, 1]) {
            for (const prop of [
                { offset: PLAZA_PROP_LAYOUT.planterOffset, radius: PLAZA_PROP_LAYOUT.planterRadius },
                { offset: PLAZA_PROP_LAYOUT.parasolOffset, radius: PLAZA_PROP_LAYOUT.parasolRadius }
            ]) {
                const dx = point.x - (plaza.x + signX * prop.offset);
                const dz = point.z - (plaza.z + signZ * prop.offset);
                const clearance = prop.radius + SPAWN_PROP_MARGIN;
                if (dx * dx + dz * dz < clearance * clearance) return false;
            }
        }
    }

    return true;
}

function clearsPlayers(point: SpawnPoint, others: readonly SpawnPoint[]): boolean {
    const minDistanceSq = SPAWN_PLAYER_SPACING * SPAWN_PLAYER_SPACING;
    for (const other of others) {
        const dx = point.x - other.x;
        const dz = point.z - other.z;
        if (dx * dx + dz * dz < minDistanceSq) return false;
    }
    return true;
}

function clearsKeepOut(point: SpawnPoint, keepOut: readonly SpawnKeepOut[]): boolean {
    for (const zone of keepOut) {
        const dx = point.x - zone.x;
        const dz = point.z - zone.z;
        if (dx * dx + dz * dz < zone.radius * zone.radius) return false;
    }
    return true;
}

function distanceToClosestSq(point: SpawnPoint, others: readonly SpawnPoint[]): number {
    let closest = Number.POSITIVE_INFINITY;
    for (const other of others) {
        const dx = point.x - other.x;
        const dz = point.z - other.z;
        closest = Math.min(closest, dx * dx + dz * dz);
    }
    return closest;
}

/**
 * The four plaza candidates of the fallback (docs/phase-2-design.md, 18):
 * the middles of the plaza's edges, halfway between the fountain clearance
 * and the plaza edge, (9 + 16) / 2 = 12.5 m from the centre on the axes.
 * The planters and parasols stand on the diagonals, so these points keep
 * clear of them (the plaza corners at 0.7 · halfSize did not).
 */
function plazaCandidates(): SpawnPoint[] {
    const plaza = plazaLayout();
    const d = (SPAWN_FOUNTAIN_CLEARANCE + plaza.halfSize) / 2;
    return [
        { x: plaza.x - d, z: plaza.z },
        { x: plaza.x + d, z: plaza.z },
        { x: plaza.x, z: plaza.z - d },
        { x: plaza.x, z: plaza.z + d }
    ];
}

function fallbackSpawn(city: CityData, others: readonly SpawnPoint[], keepOut: readonly SpawnKeepOut[]): SpawnPoint {
    // Road intersections are guaranteed map surfaces and maximize the number
    // of escape directions. The plaza adds four more crowd-safe options.
    const verticalRoads = city.roads.filter(road => Math.abs(Math.sin(road.rotation)) < 0.001);
    const horizontalRoads = city.roads.filter(road => Math.abs(Math.cos(road.rotation)) < 0.001);
    const candidates: SpawnPoint[] = [];

    for (const vertical of verticalRoads) {
        for (const horizontal of horizontalRoads) {
            candidates.push({ x: vertical.x, z: horizontal.z });
        }
    }

    candidates.push(...plazaCandidates());
    const staticSafe = candidates.filter(point => clearsStaticObstacles(city, point));
    const clearOfPickups = staticSafe.filter(point => clearsKeepOut(point, keepOut));
    const safeCandidates = clearOfPickups.length > 0 ? clearOfPickups : staticSafe;
    if (safeCandidates.length === 0) {
        // Defensive: the generated central plaza is always building-free,
        // and its first candidate clears the fountain and the plaza props
        return plazaCandidates()[0];
    }

    let best = safeCandidates[0];
    let bestClearance = distanceToClosestSq(best, others);
    for (let i = 1; i < safeCandidates.length; i++) {
        const clearance = distanceToClosestSq(safeCandidates[i], others);
        if (clearance > bestClearance) {
            best = safeCandidates[i];
            bestClearance = clearance;
        }
    }
    return best;
}

/**
 * A random free spot for a car. others are the cars of the same room only:
 * players in another room drive in their own copy of the map. keepOut are
 * the room's pickups.
 */
export function randomSpawn(
    city: CityData, others: readonly SpawnPoint[], keepOut: readonly SpawnKeepOut[] = [], random: RandomSource = Math.random
): SpawnPoint {
    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
        const point = random() < SPAWN_PLAZA_CHANCE
            ? randomPlazaPoint(random)
            : randomRoadPoint(city, random);
        if (point && clearsStaticObstacles(city, point) && clearsPlayers(point, others) && clearsKeepOut(point, keepOut)) {
            return point;
        }
    }

    // In a crowded room, return the safe fixed candidate with the most room
    // rather than leaking a rejected random position into a building.
    return fallbackSpawn(city, others, keepOut);
}

/**
 * A heading along the road under the point (either way), or one of the
 * four axes on the plaza and on crossings. Forward is (sin yaw, cos yaw).
 */
export function spawnYaw(city: CityData, point: SpawnPoint, random: RandomSource = Math.random): number {
    const flip = random() < 0.5 ? 0 : Math.PI;
    let inRoads = 0, along = 0;
    for (const road of city.roads) {
        const dx = point.x - road.x, dz = point.z - road.z;
        const across = dx * Math.cos(road.rotation) + dz * Math.sin(road.rotation);
        const alongRoad = dx * Math.sin(road.rotation) + dz * Math.cos(road.rotation);
        if (Math.abs(across) <= road.width / 2 && Math.abs(alongRoad) <= road.length / 2) {
            inRoads++;
            along = road.rotation;
        }
    }
    if (inRoads === 1) return along + flip;
    return Math.floor(random() * 4) * (Math.PI / 2);
}

/** randomSpawn with a heading. */
export function randomSpawnPose(
    city: CityData, others: readonly SpawnPoint[], keepOut: readonly SpawnKeepOut[] = [], random: RandomSource = Math.random
): SpawnPose {
    const point = randomSpawn(city, others, keepOut, random);
    return { ...point, yaw: spawnYaw(city, point, random) };
}
