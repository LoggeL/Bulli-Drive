import { Player } from './types.js';
import { PlayerData, ScoreboardEntry } from '../shared/protocol.js';
import { CITY_LAYOUT, MEGA_SCALE, PLAZA_PROP_LAYOUT } from '../shared/constants.js';
import { cityData } from './world.js';

export const players: Record<string, Player> = {};

interface SpawnPoint {
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
    const { blockSize, roadWidth, gridSize } = CITY_LAYOUT;
    const totalBlockSize = blockSize + roadWidth;
    const halfCity = (gridSize * totalBlockSize) / 2;
    const blockIndex = Math.floor(gridSize / 2) - 1;
    const center = -halfCity + roadWidth + blockIndex * totalBlockSize + blockSize / 2;
    return {
        x: center,
        z: center,
        halfSize: blockSize / 2 - SPAWN_BUILDING_MARGIN
    };
}

function randomRoadPoint(): SpawnPoint | null {
    if (cityData.roads.length === 0) return null;

    const road = cityData.roads[Math.floor(Math.random() * cityData.roads.length)];
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

function clearsStaticObstacles(point: SpawnPoint): boolean {
    for (const building of cityData.buildings) {
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

function clearsPlayers(point: SpawnPoint): boolean {
    const minDistanceSq = SPAWN_PLAYER_SPACING * SPAWN_PLAYER_SPACING;
    for (const player of Object.values(players)) {
        const dx = point.x - player.x;
        const dz = point.z - player.z;
        if (dx * dx + dz * dz < minDistanceSq) return false;
    }
    return true;
}

function distanceToClosestPlayerSq(point: SpawnPoint): number {
    let closest = Number.POSITIVE_INFINITY;
    for (const player of Object.values(players)) {
        const dx = point.x - player.x;
        const dz = point.z - player.z;
        closest = Math.min(closest, dx * dx + dz * dz);
    }
    return closest;
}

function fallbackSpawn(): SpawnPoint {
    // Road intersections are guaranteed map surfaces and maximize the number
    // of escape directions. Plaza corners add four more crowd-safe options.
    const verticalRoads = cityData.roads.filter(road => Math.abs(Math.sin(road.rotation)) < 0.001);
    const horizontalRoads = cityData.roads.filter(road => Math.abs(Math.cos(road.rotation)) < 0.001);
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

    const safeCandidates = candidates.filter(clearsStaticObstacles);
    if (safeCandidates.length === 0) {
        // Defensive pre-init fallback. The generated central plaza is always
        // building-free, and this point is outside the fountain clearance.
        return { x: plaza.x + plaza.halfSize * 0.7, z: plaza.z + plaza.halfSize * 0.7 };
    }

    let best = safeCandidates[0];
    let bestClearance = distanceToClosestPlayerSq(best);
    for (let i = 1; i < safeCandidates.length; i++) {
        const clearance = distanceToClosestPlayerSq(safeCandidates[i]);
        if (clearance > bestClearance) {
            best = safeCandidates[i];
            bestClearance = clearance;
        }
    }
    return best;
}

export function playerScale(p: Player): number {
    return p.megaActive ? MEGA_SCALE : 1;
}

export function randomSpawn(): { x: number; z: number } {
    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
        const point = Math.random() < SPAWN_PLAZA_CHANCE
            ? randomPlazaPoint()
            : randomRoadPoint();
        if (point && clearsStaticObstacles(point) && clearsPlayers(point)) {
            return point;
        }
    }

    // In a crowded server, return the safe fixed candidate with the most room
    // rather than leaking a rejected random position into a building.
    return fallbackSpawn();
}

export function getPublicPlayer(id: string): PlayerData {
    const p = players[id];
    return {
        id: p.id,
        color: p.color,
        name: p.name,
        carType: p.carType,
        x: p.x,
        z: p.z,
        angle: p.angle,
        flipAngle: p.flipAngle,
        isFlipping: p.isFlipping,
        scale: playerScale(p),
        score: p.score,
        health: p.health
    };
}

export function getPublicPlayers(): Record<string, PlayerData> {
    const publicPlayers: Record<string, PlayerData> = {};
    for (const id in players) {
        if (!players[id].ready) continue;
        publicPlayers[id] = getPublicPlayer(id);
    }
    return publicPlayers;
}

export function getScoreboard(): ScoreboardEntry[] {
    return Object.values(players)
        .filter(p => p.ready)
        .map(p => ({
            id: p.id,
            name: p.name,
            score: p.score,
            color: p.color
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
}
