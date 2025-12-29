import { Powerup, Tree, Building, Road, CityData } from './types.js';
import { POWERUP_TYPES } from './config.js';

export const powerups: Powerup[] = [];
export const trees: Tree[] = [];
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

// Muted building colors (realistic tones)
const BUILDING_COLORS = [
    0x8B8B8B, // Gray
    0x9C8B7A, // Tan
    0x7A8B8B, // Slate
    0x8B7A6B, // Brown
    0x6B7A8B, // Dusty blue
    0x7A7A6B, // Olive gray
    0x8B8B7A, // Warm gray
    0x6B6B7A, // Cool gray
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
    for (let i = 0; i < 15; i++) {
        const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
        let x, z;
        do {
            x = (Math.random() - 0.5) * 400;
            z = (Math.random() - 0.5) * 400;
        } while (isInCityArea(x, z) && !isOnRoad(x, z)); // Place on roads if in city
        
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
