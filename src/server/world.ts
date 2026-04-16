import { Powerup, Tree, Building, Road, CityData, Coin } from './types.js';
import { POWERUP_TYPES } from './config.js';

export const powerups: Powerup[] = [];
export const trees: Tree[] = [];
export const coins: Coin[] = [];
export const cityData: CityData = { buildings: [], roads: [] };

// City configuration
const CITY_CONFIG = {
    centerX: 0,
    centerZ: 0,
    blockSize: 40,
    roadWidth: 12,
    gridSize: 4, // 4x4 blocks
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
    const halfCity = (CITY_CONFIG.gridSize * (CITY_CONFIG.blockSize + CITY_CONFIG.roadWidth)) / 2;
    return Math.abs(x - CITY_CONFIG.centerX) < halfCity && Math.abs(z - CITY_CONFIG.centerZ) < halfCity;
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
    
    // Init Powerups (spread around, some in city)
    for (let i = 0; i < 25; i++) {
        const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
        let x = 0, z = 0;
        for (let attempts = 0; attempts < 30; attempts++) {
            x = (Math.random() - 0.5) * 400;
            z = (Math.random() - 0.5) * 400;
            if (!(isInCityArea(x, z) && !isOnRoad(x, z))) break;
        }

        powerups.push({
            id: i,
            x,
            z,
            type: type.type,
            color: type.color,
            label: type.label,
            collected: false
        });
    }

    // Init Coins (spread around, avoid city center)
    for (let i = 0; i < 30; i++) {
        let x = 0, z = 0;
        for (let attempts = 0; attempts < 30; attempts++) {
            x = (Math.random() - 0.5) * 600;
            z = (Math.random() - 0.5) * 600;
            if (!(Math.abs(x) < 30 && Math.abs(z) < 30)) break;
        }

        coins.push({
            id: i,
            x,
            z,
            collected: false
        });
    }

    // Init Trees (outside city area)
    for (let i = 0; i < 120; i++) {
        let x, z;
        let attempts = 0;
        do {
            x = (Math.random() - 0.5) * 600;
            z = (Math.random() - 0.5) * 600;
            attempts++;
        } while ((isInCityArea(x, z) || (Math.abs(x) < 40 && Math.abs(z) < 40)) && attempts < 20);
        
        if (attempts >= 20) continue;
        
        trees.push({
            id: i,
            x: x,
            z: z,
            height: 4 + Math.random() * 5
        });
    }
}
