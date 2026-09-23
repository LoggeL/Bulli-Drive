// Deterministic city layout and generation, shared by client and server.
// The server generates the authoritative CityData from a seeded RandomSource;
// the client uses the same layout helpers to place roads, plaza and park.

import { CITY_LAYOUT } from '../constants.js';
import type { BuildingData, CityData, RoadData } from '../protocol.js';
import type { RandomSource } from '../math/rng.js';

// City configuration (grid dimensions come from the shared CITY_LAYOUT)
export const CITY_CONFIG = {
    centerX: 0,
    centerZ: 0,
    blockSize: CITY_LAYOUT.blockSize,
    roadWidth: CITY_LAYOUT.roadWidth,
    gridSize: CITY_LAYOUT.gridSize,
    buildingMargin: 3
};

const TOTAL_BLOCK_SIZE = CITY_CONFIG.blockSize + CITY_CONFIG.roadWidth;
const HALF_CITY = (CITY_CONFIG.gridSize * TOTAL_BLOCK_SIZE) / 2;

// The road grid has gridSize+1 road lines, so the city spans
// [center - halfCity, center + halfCity + roadWidth] on each axis.
export const CITY_BOUNDS = {
    minX: CITY_CONFIG.centerX - HALF_CITY,
    maxX: CITY_CONFIG.centerX + HALF_CITY + CITY_CONFIG.roadWidth,
    minZ: CITY_CONFIG.centerZ - HALF_CITY,
    maxZ: CITY_CONFIG.centerZ + HALF_CITY + CITY_CONFIG.roadWidth
};

// Blocks without buildings: the central plaza (spawn area) and the park corner
export const PLAZA_BLOCK = {
    x: Math.floor(CITY_CONFIG.gridSize / 2) - 1,
    z: Math.floor(CITY_CONFIG.gridSize / 2) - 1
};
export const PARK_BLOCK = { x: CITY_CONFIG.gridSize - 1, z: CITY_CONFIG.gridSize - 1 };

// Mediterranean / California palette
export const BUILDING_COLORS = [
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

// Center line of road number `index` (0..gridSize) along either axis
export function roadLineCenter(index: number): number {
    return CITY_CONFIG.centerX - HALF_CITY + index * TOTAL_BLOCK_SIZE + CITY_CONFIG.roadWidth / 2;
}

// Center of a city block (bx, bz) in world coordinates
export function blockCenter(bx: number, bz: number): { x: number; z: number } {
    const { blockSize, roadWidth, centerX, centerZ } = CITY_CONFIG;
    return {
        x: centerX - HALF_CITY + roadWidth + bx * TOTAL_BLOCK_SIZE + blockSize / 2,
        z: centerZ - HALF_CITY + roadWidth + bz * TOTAL_BLOCK_SIZE + blockSize / 2
    };
}

export function isInCityArea(x: number, z: number): boolean {
    return x >= CITY_BOUNDS.minX && x <= CITY_BOUNDS.maxX &&
           z >= CITY_BOUNDS.minZ && z <= CITY_BOUNDS.maxZ;
}

export function isOnRoad(x: number, z: number): boolean {
    const { roadWidth, centerX, centerZ } = CITY_CONFIG;

    // Offset from city center
    const localX = x - centerX + HALF_CITY;
    const localZ = z - centerZ + HALF_CITY;

    // Check if on road grid
    const xMod = localX % TOTAL_BLOCK_SIZE;
    const zMod = localZ % TOTAL_BLOCK_SIZE;

    return xMod < roadWidth || zMod < roadWidth;
}

// Consumes random() in a fixed order: 1 + 4 draws per building, block by
// block. Changing that order changes every item placed after the city.
export function generateCity(random: RandomSource): CityData {
    const { blockSize, roadWidth, gridSize, centerX, centerZ, buildingMargin } = CITY_CONFIG;
    // Includes both outer road widths: [-halfCity, halfCity + roadWidth].
    const fullCitySpan = gridSize * TOTAL_BLOCK_SIZE + roadWidth;
    const roadSpanCenterX = centerX + roadWidth / 2;
    const roadSpanCenterZ = centerZ + roadWidth / 2;
    const roads: RoadData[] = [];
    const buildings: BuildingData[] = [];

    // PlaneGeometry(width, length) is long on local Z before rotation. Keep
    // width as the across-road dimension for every road, and center the long
    // axis over the complete outer-road footprint.
    for (let i = 0; i <= gridSize; i++) {
        // Vertical (x-constant) roads run along world Z with no rotation.
        roads.push({
            x: roadLineCenter(i),
            z: roadSpanCenterZ,
            width: roadWidth,
            length: fullCitySpan,
            rotation: 0
        });

        // Horizontal (z-constant) roads rotate the long local Z axis onto X.
        roads.push({
            x: roadSpanCenterX,
            z: centerZ - HALF_CITY + i * TOTAL_BLOCK_SIZE + roadWidth / 2,
            width: roadWidth,
            length: fullCitySpan,
            rotation: Math.PI / 2
        });
    }

    // Generate buildings in each block
    for (let bx = 0; bx < gridSize; bx++) {
        for (let bz = 0; bz < gridSize; bz++) {
            // Skip center block for spawn area / plaza
            if (bx === PLAZA_BLOCK.x && bz === PLAZA_BLOCK.z) {
                continue; // Central plaza
            }

            // Park in one corner
            if (bx === PARK_BLOCK.x && bz === PARK_BLOCK.z) {
                continue; // Park area (green in the client)
            }

            const center = blockCenter(bx, bz);

            // Generate 1-3 buildings per block
            const numBuildings = 1 + Math.floor(random() * 3);
            const subBlockSize = (blockSize - buildingMargin * 2) / 2;

            for (let i = 0; i < numBuildings; i++) {
                const subX = i % 2;
                const subZ = Math.floor(i / 2);

                const buildingX = center.x - subBlockSize / 2 + subX * subBlockSize;
                const buildingZ = center.z - subBlockSize / 2 + subZ * subBlockSize;

                const width = 8 + random() * (subBlockSize - 10);
                const depth = 8 + random() * (subBlockSize - 10);
                const height = 6 + random() * 20;
                const color = BUILDING_COLORS[Math.floor(random() * BUILDING_COLORS.length)];

                buildings.push({
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

    return { buildings, roads };
}
