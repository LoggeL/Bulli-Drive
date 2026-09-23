import type { CityData } from '../../shared/protocol.js';
import { CITY_LAYOUT, PLAZA_PROP_LAYOUT } from '../../shared/constants.js';
import { blockCenter, PLAZA_BLOCK } from '../../shared/world/cityGen.js';

// Where a car (re)spawns: a random spot on a road or the plaza that is clear
// of buildings, the plaza props and the other players of the same room.

export interface SpawnPoint {
    x: number;
    z: number;
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

function randomRoadPoint(city: CityData): SpawnPoint | null {
    if (city.roads.length === 0) return null;

    const road = city.roads[Math.floor(Math.random() * city.roads.length)];
    const halfAcross = Math.max(0, road.width / 2 - SPAWN_ROAD_EDGE_MARGIN);
    const halfAlong = Math.max(0, road.length / 2 - SPAWN_ROAD_END_MARGIN);
    const acrossOffset = (Math.random() * 2 - 1) * halfAcross;
    const alongOffset = (Math.random() * 2 - 1) * halfAlong;

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

function randomPlazaPoint(): SpawnPoint {
    const plaza = plazaLayout();
    return {
        x: plaza.x + (Math.random() * 2 - 1) * plaza.halfSize,
        z: plaza.z + (Math.random() * 2 - 1) * plaza.halfSize
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

function distanceToClosestSq(point: SpawnPoint, others: readonly SpawnPoint[]): number {
    let closest = Number.POSITIVE_INFINITY;
    for (const other of others) {
        const dx = point.x - other.x;
        const dz = point.z - other.z;
        closest = Math.min(closest, dx * dx + dz * dz);
    }
    return closest;
}

function fallbackSpawn(city: CityData, others: readonly SpawnPoint[]): SpawnPoint {
    // Road intersections are guaranteed map surfaces and maximize the number
    // of escape directions. Plaza corners add four more crowd-safe options.
    const verticalRoads = city.roads.filter(road => Math.abs(Math.sin(road.rotation)) < 0.001);
    const horizontalRoads = city.roads.filter(road => Math.abs(Math.cos(road.rotation)) < 0.001);
    const candidates: SpawnPoint[] = [];

    for (const vertical of verticalRoads) {
        for (const horizontal of horizontalRoads) {
            candidates.push({ x: vertical.x, z: horizontal.z });
        }
    }

    const plaza = plazaLayout();
    const plazaOffset = plaza.halfSize * 0.7;
    for (const xSign of [-1, 1]) {
        for (const zSign of [-1, 1]) {
            candidates.push({
                x: plaza.x + xSign * plazaOffset,
                z: plaza.z + zSign * plazaOffset
            });
        }
    }

    const safeCandidates = candidates.filter(point => clearsStaticObstacles(city, point));
    if (safeCandidates.length === 0) {
        // Defensive: the generated central plaza is always building-free,
        // and this point is outside the fountain clearance.
        return { x: plaza.x + plaza.halfSize * 0.7, z: plaza.z + plaza.halfSize * 0.7 };
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
 * players in another room drive in their own copy of the map.
 */
export function randomSpawn(city: CityData, others: readonly SpawnPoint[]): SpawnPoint {
    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
        const point = Math.random() < SPAWN_PLAZA_CHANCE
            ? randomPlazaPoint()
            : randomRoadPoint(city);
        if (point && clearsStaticObstacles(city, point) && clearsPlayers(point, others)) {
            return point;
        }
    }

    // In a crowded room, return the safe fixed candidate with the most room
    // rather than leaking a rejected random position into a building.
    return fallbackSpawn(city, others);
}
