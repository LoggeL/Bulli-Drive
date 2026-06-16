import { Powerup, Tree, Coin, CityData } from './types.js';
import { POWERUP_TYPES, CITY_LAYOUT } from '../shared/constants.js';

export const powerups: Powerup[] = [];
export const trees: Tree[] = [];
export const coins: Coin[] = [];
export const cityData: CityData = { buildings: [], roads: [] };

// City configuration (grid dimensions are shared with the client)
const CITY_CONFIG = {
    centerX: 0,
    centerZ: 0,
    blockSize: CITY_LAYOUT.blockSize,
    roadWidth: CITY_LAYOUT.roadWidth,
    gridSize: CITY_LAYOUT.gridSize,
    buildingMargin: 3
};

// Mediterranean / California palette
const BUILDING_COLORS = [
    0xC17A56, // Terracotta
    0xE8D5B7, // Sand
    0xF5F0E1, // Cream
    0xB8D4E3, // Pale blue
    0xA8C6A0, // Sage green
    0xFAF6F0, // Warm white
    0xE8856A, // Coral
    0xD4A574, // Adobe tan
    0xC9B99A, // Khaki sand
    0xE0C8A8, // Stucco beige
];

function isInCityArea(x: number, z: number): boolean {
    const { blockSize, roadWidth, gridSize, centerX, centerZ } = CITY_CONFIG;
    const totalBlockSize = blockSize + roadWidth;
    const halfCity = (gridSize * totalBlockSize) / 2;
    // The road grid has gridSize+1 road lines, so it spans
    // [center - halfCity, center + halfCity + roadWidth] on each axis.
    const localX = x - centerX;
    const localZ = z - centerZ;
    return localX >= -halfCity && localX <= halfCity + roadWidth &&
           localZ >= -halfCity && localZ <= halfCity + roadWidth;
}

function isOnRoad(x: number, z: number): boolean {
    const { blockSize, roadWidth, gridSize, centerX, centerZ } = CITY_CONFIG;
    const totalBlockSize = blockSize + roadWidth;
    const halfCity = (gridSize * totalBlockSize) / 2;

    // Offset from city center
    const localX = x - centerX + halfCity;
    const localZ = z - centerZ + halfCity;

    // Check if on road grid
    const xMod = localX % totalBlockSize;
    const zMod = localZ % totalBlockSize;

    return xMod < roadWidth || zMod < roadWidth;
}

// Sample random positions in [-range/2, range/2]^2 until reject() passes.
// Returns ok=false (with the last candidate) when all attempts were rejected.
function placeWithRejection(
    range: number,
    maxAttempts: number,
    reject: (x: number, z: number) => boolean
): { x: number; z: number; ok: boolean } {
    let x = 0, z = 0;
    for (let attempts = 0; attempts < maxAttempts; attempts++) {
        x = (Math.random() - 0.5) * range;
        z = (Math.random() - 0.5) * range;
        if (!reject(x, z)) return { x, z, ok: true };
    }
    return { x, z, ok: false };
}

function generateCity() {
    const { blockSize, roadWidth, gridSize, centerX, centerZ, buildingMargin } = CITY_CONFIG;
    const totalBlockSize = blockSize + roadWidth;
    const halfCity = (gridSize * totalBlockSize) / 2;

    // Generate roads
    for (let i = 0; i <= gridSize; i++) {
        // Horizontal roads
        const zPos = centerZ - halfCity + i * totalBlockSize + roadWidth / 2;
        cityData.roads.push({
            x: centerX,
            z: zPos,
            width: halfCity * 2,
            length: roadWidth,
            rotation: 0
        });

        // Vertical roads
        const xPos = centerX - halfCity + i * totalBlockSize + roadWidth / 2;
        cityData.roads.push({
            x: xPos,
            z: centerZ,
            width: roadWidth,
            length: halfCity * 2,
            rotation: Math.PI / 2
        });
    }

    // Generate buildings in each block
    for (let bx = 0; bx < gridSize; bx++) {
        for (let bz = 0; bz < gridSize; bz++) {
            // Block center
            const blockCenterX = centerX - halfCity + roadWidth + bx * totalBlockSize + blockSize / 2;
            const blockCenterZ = centerZ - halfCity + roadWidth + bz * totalBlockSize + blockSize / 2;

            // Skip center block for spawn area / plaza
            if (bx === Math.floor(gridSize / 2) - 1 && bz === Math.floor(gridSize / 2) - 1) {
                continue; // Central plaza
            }

            // Park in one corner
            if (bx === gridSize - 1 && bz === gridSize - 1) {
                continue; // Park area (will be green in client)
            }

            // Generate 1-4 buildings per block
            const numBuildings = 1 + Math.floor(Math.random() * 3);
            const subBlockSize = (blockSize - buildingMargin * 2) / 2;

            for (let i = 0; i < numBuildings; i++) {
                const subX = i % 2;
                const subZ = Math.floor(i / 2);

                const buildingX = blockCenterX - subBlockSize / 2 + subX * subBlockSize;
                const buildingZ = blockCenterZ - subBlockSize / 2 + subZ * subBlockSize;

                const width = 8 + Math.random() * (subBlockSize - 10);
                const depth = 8 + Math.random() * (subBlockSize - 10);
                const height = 6 + Math.random() * 20;
                const color = BUILDING_COLORS[Math.floor(Math.random() * BUILDING_COLORS.length)];

                cityData.buildings.push({
                    x: buildingX,
                    z: buildingZ,
                    width,
                    depth,
                    height,
                    color
                });
            }
        }
    }
}

export function initWorld() {
    // Generate city
    generateCity();

    // Init Powerups: keep them within reach of the action - on city roads or in
    // the open ring just around the city (<=150 from center), never inside a
    // building block or out in the distant wilderness.
    for (let i = 0; i < 25; i++) {
        const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
        const spot = placeWithRejection(300, 30, (x, z) =>
            (isInCityArea(x, z) && !isOnRoad(x, z)) || (x * x + z * z) > 150 * 150);

        powerups.push({
            id: i,
            x: spot.x,
            z: spot.z,
            type: type.type,
            color: type.color,
            label: type.label,
            collected: false
        });
    }

    // Init Coins: spread across the playable area (within ~140 of center),
    // skipping the central spawn pad and building-block interiors.
    for (let i = 0; i < 30; i++) {
        const spot = placeWithRejection(280, 30, (x, z) =>
            (Math.abs(x) < 25 && Math.abs(z) < 25) || (isInCityArea(x, z) && !isOnRoad(x, z)));

        coins.push({
            id: i,
            x: spot.x,
            z: spot.z,
            collected: false
        });
    }

    // Init Trees (outside city area; skip the tree if no valid spot was found)
    for (let i = 0; i < 120; i++) {
        const spot = placeWithRejection(600, 20, (x, z) =>
            isInCityArea(x, z) || (Math.abs(x) < 40 && Math.abs(z) < 40));
        if (!spot.ok) continue;

        trees.push({
            id: i,
            x: spot.x,
            z: spot.z,
            height: 4 + Math.random() * 5
        });
    }
}
