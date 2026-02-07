import * as THREE from 'three';
import { state } from '../state.js';
import { BuildingData, RoadData, CityData } from '../types.js';
import { getTerrainHeight } from './environment.js';

const ROAD_COLOR = 0x333333;
const LANE_MARKING_COLOR = 0xeeeeee;
const SIDEWALK_COLOR = 0xaaaaaa;
const PARK_COLOR = 0x4a7c3f;

// Shared geometries and materials for windows (created once, reused across all buildings)
let sharedHFrameGeo: THREE.BoxGeometry;
let sharedVFrameGeo: THREE.BoxGeometry;
let sharedFrameMat: THREE.MeshStandardMaterial;
let sharedGlassLitMat: THREE.MeshStandardMaterial;
let sharedGlassUnlitMat: THREE.MeshStandardMaterial;

// Shared rooftop geometries/materials
let sharedACGeo: THREE.BoxGeometry;
let sharedACMat: THREE.MeshStandardMaterial;
let sharedTankGeo: THREE.CylinderGeometry;
let sharedTankMat: THREE.MeshStandardMaterial;
let sharedLegGeo: THREE.CylinderGeometry;
let sharedLegMat: THREE.MeshStandardMaterial;
let sharedBushMat: THREE.MeshStandardMaterial;

// Fountain animation state
let fountainWater: THREE.Mesh | null = null;
let fountainBaseY = 0;
let fountainX = 0;
let fountainZ = 0;
const PARTICLE_COUNT = 8;
const fountainParticles: THREE.Mesh[] = [];
let sharedParticleMat: THREE.MeshStandardMaterial;
let sharedParticleGeo: THREE.SphereGeometry;

function initSharedResources() {
    const frameThickness = 0.1;
    // Window frame geometries (shared across all windows)
    sharedHFrameGeo = new THREE.BoxGeometry(1.6, frameThickness, frameThickness); // wide enough, scaled per-window not needed if we accept uniform size
    sharedVFrameGeo = new THREE.BoxGeometry(frameThickness, 1.4, frameThickness);
    sharedFrameMat = new THREE.MeshStandardMaterial({ color: WINDOW_FRAME_COLOR, roughness: 0.7 });
    sharedGlassLitMat = new THREE.MeshStandardMaterial({
        color: 0xFFE4A0, roughness: 0.4, metalness: 0.0,
        emissive: 0xFFCC44, emissiveIntensity: 0.6,
    });
    sharedGlassUnlitMat = new THREE.MeshStandardMaterial({
        color: 0x5588AA, roughness: 0.0, metalness: 0.5,
        emissive: 0x112233, emissiveIntensity: 0.15,
    });

    // Rooftop shared resources
    sharedACGeo = new THREE.BoxGeometry(1.2, 0.8, 1.0);
    sharedACMat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.7, metalness: 0.3 });
    sharedTankGeo = new THREE.CylinderGeometry(0.6, 0.6, 1.5, 8);
    sharedTankMat = new THREE.MeshStandardMaterial({ color: 0x666666, roughness: 0.6, metalness: 0.4 });
    sharedLegGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.5, 4);
    sharedLegMat = new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.8 });
    sharedBushMat = new THREE.MeshStandardMaterial({ color: 0x3D8B37, roughness: 0.9 });

    // Fountain particle resources
    sharedParticleGeo = new THREE.SphereGeometry(0.3, 6, 6);
    sharedParticleMat = new THREE.MeshStandardMaterial({
        color: 0x88ccee, transparent: true, opacity: 0.6, roughness: 0.1
    });
}

export function createCity(cityData: CityData) {
    if (!cityData) return;

    initSharedResources();
    createRoads(cityData.roads);
    createBuildings(cityData.buildings);
    createPark();
    createPlaza();
}

function createRoads(roads: RoadData[]) {
    const roadMat = new THREE.MeshStandardMaterial({
        color: ROAD_COLOR,
        roughness: 0.9,
        metalness: 0.0
    });

    const markingMat = new THREE.MeshStandardMaterial({
        color: LANE_MARKING_COLOR,
        roughness: 0.5
    });

    const sidewalkMat = new THREE.MeshStandardMaterial({
        color: SIDEWALK_COLOR,
        roughness: 0.8,
        metalness: 0.0
    });

    roads.forEach(road => {
        const terrainY = getTerrainHeight(road.x, road.z);

        // Road surface
        const roadGeo = new THREE.PlaneGeometry(road.width, road.length);
        roadGeo.rotateX(-Math.PI / 2);

        const roadMesh = new THREE.Mesh(roadGeo, roadMat);
        roadMesh.position.set(road.x, terrainY + 0.05, road.z);
        roadMesh.rotation.y = road.rotation;
        roadMesh.receiveShadow = true;
        state.scene.add(roadMesh);

        // Sidewalk curbs (thin raised strips on both edges)
        const curbWidth = 0.8;
        const curbGeo = new THREE.BoxGeometry(curbWidth, 0.15, road.length);
        [-1, 1].forEach(side => {
            const curb = new THREE.Mesh(curbGeo, sidewalkMat);
            const offset = (road.width / 2 + curbWidth / 2) * side;
            if (road.rotation === 0) {
                curb.position.set(road.x + offset, terrainY + 0.08, road.z);
            } else {
                curb.position.set(road.x, terrainY + 0.08, road.z + offset);
                curb.rotation.y = Math.PI / 2;
            }
            curb.receiveShadow = true;
            state.scene.add(curb);
        });

        // Lane markings (dashed center line)
        const dashLength = 3;
        const dashGap = 2;
        const dashWidth = 0.3;
        const numDashes = Math.floor(road.length / (dashLength + dashGap));

        // Use the road's single terrain height for all dashes to avoid clipping
        const dashY = terrainY + 0.07;
        const dashGeo = new THREE.PlaneGeometry(dashWidth, dashLength);
        dashGeo.rotateX(-Math.PI / 2);

        for (let i = 0; i < numDashes; i++) {
            const dash = new THREE.Mesh(dashGeo, markingMat);
            const lineOffset = -road.length / 2 + (i + 0.5) * (dashLength + dashGap);

            if (road.rotation === 0) {
                dash.position.set(road.x, dashY, road.z + lineOffset);
            } else {
                dash.position.set(road.x + lineOffset, dashY, road.z);
                dash.rotation.y = Math.PI / 2;
            }
            state.scene.add(dash);
        }
    });
}

// Seeded random for deterministic building details
function seededRandom(x: number, z: number, salt: number): number {
    const n = Math.sin(x * 12.9898 + z * 78.233 + salt * 43.1234) * 43758.5453;
    return n - Math.floor(n);
}

const AWNING_COLORS = [0xCC3333, 0xE67E22, 0x2980B9, 0x27AE60, 0x8E44AD, 0xC0392B];
const WINDOW_FRAME_COLOR = 0xF5F0E1;
const DOOR_COLORS = [0x5D3A1A, 0x3B2510, 0x6B4226, 0x2C1810];

// Shared glass geometry (uniform window size for all buildings)
const UNIFORM_W_WIDTH = 1.2;
const UNIFORM_W_HEIGHT = 1.6;
let sharedGlassGeo: THREE.PlaneGeometry;

function addWindowWithFrame(
    group: THREE.Group,
    x: number, y: number, z: number,
    rotY: number, _wWidth: number, _wHeight: number,
    isLit: boolean
) {
    // Use uniform shared sizes for all windows
    if (!sharedGlassGeo) {
        sharedGlassGeo = new THREE.PlaneGeometry(UNIFORM_W_WIDTH, UNIFORM_W_HEIGHT);
    }

    const glass = new THREE.Mesh(sharedGlassGeo, isLit ? sharedGlassLitMat : sharedGlassUnlitMat);
    glass.position.set(x, y, z);
    glass.rotation.y = rotY;
    group.add(glass);

    // Single frame: top and bottom bars only (2 meshes instead of 4)
    const inset = 0.05;
    const offsetZ = Math.cos(rotY) * inset;
    const offsetX = Math.sin(rotY) * inset;

    const topFrame = new THREE.Mesh(sharedHFrameGeo, sharedFrameMat);
    topFrame.position.set(x + offsetX * 0.5, y + UNIFORM_W_HEIGHT / 2, z + offsetZ * 0.5);
    topFrame.rotation.y = rotY;
    group.add(topFrame);

    const botFrame = new THREE.Mesh(sharedHFrameGeo, sharedFrameMat);
    botFrame.position.set(x + offsetX * 0.5, y - UNIFORM_W_HEIGHT / 2, z + offsetZ * 0.5);
    botFrame.rotation.y = rotY;
    group.add(botFrame);
}

function createBuildings(buildings: BuildingData[]) {
    buildings.forEach((building, idx) => {
        const buildingGroup = new THREE.Group();
        const seed = seededRandom(building.x, building.z, 0);
        const seed2 = seededRandom(building.x, building.z, 1);
        const seed3 = seededRandom(building.x, building.z, 2);

        // Main building body
        const bodyGeo = new THREE.BoxGeometry(building.width, building.height, building.depth);
        const bodyMat = new THREE.MeshStandardMaterial({
            color: building.color,
            roughness: 0.85,
            metalness: 0.05
        });
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        body.position.y = building.height / 2;
        body.castShadow = true;
        body.receiveShadow = true;
        buildingGroup.add(body);

        // Windows with frames and varied lighting (wider spacing = fewer windows)
        const windowSpacingH = 3.5;
        const windowSpacingV = 3.5;
        const wWidth = UNIFORM_W_WIDTH;
        const wHeight = UNIFORM_W_HEIGHT;

        const numWindowsX = Math.max(1, Math.floor((building.width - 2) / windowSpacingH));
        const numWindowsY = Math.max(1, Math.floor((building.height - 2) / windowSpacingV));

        // Front and back windows
        for (let wx = 0; wx < numWindowsX; wx++) {
            for (let wy = 0; wy < numWindowsY; wy++) {
                const xPos = -building.width / 2 + 1.5 + wx * windowSpacingH;
                const yPos = 2 + wy * windowSpacingV;
                const isLit = seededRandom(building.x + wx, building.z + wy, 7) > 0.6;

                // Front
                addWindowWithFrame(buildingGroup, xPos, yPos, building.depth / 2 + 0.06, 0, wWidth, wHeight, isLit);
                // Back
                addWindowWithFrame(buildingGroup, xPos, yPos, -building.depth / 2 - 0.06, Math.PI, wWidth, wHeight, isLit);
            }
        }

        // Side windows
        const numWindowsZ = Math.floor((building.depth - 2) / windowSpacingH);
        for (let wz = 0; wz < numWindowsZ; wz++) {
            for (let wy = 0; wy < numWindowsY; wy++) {
                const zPos = -building.depth / 2 + 1.5 + wz * windowSpacingH;
                const yPos = 2 + wy * windowSpacingV;
                const isLit = seededRandom(building.x + wz + 10, building.z + wy, 8) > 0.6;

                // Left
                addWindowWithFrame(buildingGroup, -building.width / 2 - 0.06, yPos, zPos, -Math.PI / 2, wWidth, wHeight, isLit);
                // Right
                addWindowWithFrame(buildingGroup, building.width / 2 + 0.06, yPos, zPos, Math.PI / 2, wWidth, wHeight, isLit);
            }
        }

        // Door on front face
        const doorColor = DOOR_COLORS[Math.floor(seed3 * DOOR_COLORS.length)];
        const doorMat = new THREE.MeshStandardMaterial({ color: doorColor, roughness: 0.7 });
        const doorGeo = new THREE.PlaneGeometry(1.4, 2.4);
        const door = new THREE.Mesh(doorGeo, doorMat);
        door.position.set(0, 1.2, building.depth / 2 + 0.06);
        buildingGroup.add(door);

        // Door frame
        const doorFrameMat = new THREE.MeshStandardMaterial({ color: 0x3A2A1A, roughness: 0.6 });
        const doorFrameTop = new THREE.Mesh(
            new THREE.BoxGeometry(1.8, 0.12, 0.15),
            doorFrameMat
        );
        doorFrameTop.position.set(0, 2.45, building.depth / 2 + 0.08);
        doorFrameTop.castShadow = true;
        buildingGroup.add(doorFrameTop);

        // Door overhang / small awning
        const doorAwningGeo = new THREE.BoxGeometry(2.0, 0.08, 0.6);
        const doorAwningMat = new THREE.MeshStandardMaterial({ color: 0x6B4226, roughness: 0.7 });
        const doorAwning = new THREE.Mesh(doorAwningGeo, doorAwningMat);
        doorAwning.position.set(0, 2.55, building.depth / 2 + 0.35);
        doorAwning.castShadow = true;
        buildingGroup.add(doorAwning);

        // Shop-front awning on ~40% of buildings
        if (seed > 0.6 && building.height > 5) {
            const awningColor = AWNING_COLORS[Math.floor(seed2 * AWNING_COLORS.length)];
            const awningMat = new THREE.MeshStandardMaterial({ color: awningColor, roughness: 0.6, side: THREE.DoubleSide });
            const awningWidth = building.width * 0.9;
            const awningDepth = 1.5;
            const awningHeight = 0.6;

            // Wedge-shaped awning using BufferGeometry with 8 triangles (top, bottom, sides, front)
            const hw = awningWidth / 2;
            const vertices = new Float32Array([
                // Top face (2 triangles) - flat top extending outward
                -hw, 0, 0,   hw, 0, 0,   hw, 0, awningDepth,
                -hw, 0, 0,   hw, 0, awningDepth,   -hw, 0, awningDepth,
                // Bottom/sloped face (2 triangles) - slopes down from building to tip
                -hw, 0, 0,   hw, -awningHeight, awningDepth,   hw, 0, 0,
                -hw, 0, 0,   -hw, -awningHeight, awningDepth,   hw, -awningHeight, awningDepth,
                // Left side triangle
                -hw, 0, 0,   -hw, 0, awningDepth,   -hw, -awningHeight, awningDepth,
                // Right side triangle
                hw, 0, 0,   hw, -awningHeight, awningDepth,   hw, 0, awningDepth,
                // Front face (2 triangles)
                -hw, 0, awningDepth,   hw, 0, awningDepth,   hw, -awningHeight, awningDepth,
                -hw, 0, awningDepth,   hw, -awningHeight, awningDepth,   -hw, -awningHeight, awningDepth,
            ]);
            const awningGeo = new THREE.BufferGeometry();
            awningGeo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
            awningGeo.computeVertexNormals();

            const awning = new THREE.Mesh(awningGeo, awningMat);
            awning.position.set(0, 3.5, building.depth / 2 + 0.05);
            awning.castShadow = true;
            buildingGroup.add(awning);
        }

        // Rooftop details
        const roofY = building.height;

        // AC units on ~30% of buildings (shared geometry/material)
        if (seed2 > 0.7) {
            const numAC = 1 + Math.floor(seed * 2);
            for (let i = 0; i < numAC; i++) {
                const ac = new THREE.Mesh(sharedACGeo, sharedACMat);
                const acX = (seededRandom(building.x, building.z, 10 + i) - 0.5) * (building.width * 0.6);
                const acZ = (seededRandom(building.x, building.z, 20 + i) - 0.5) * (building.depth * 0.6);
                ac.position.set(acX, roofY + 0.4, acZ);
                ac.castShadow = true;
                buildingGroup.add(ac);
            }
        }

        // Water tank on ~15% of buildings (shared geometry/material)
        if (seed3 > 0.85 && building.height > 6) {
            const tank = new THREE.Mesh(sharedTankGeo, sharedTankMat);
            tank.position.set(
                (seed - 0.5) * building.width * 0.4,
                roofY + 0.75,
                (seed2 - 0.5) * building.depth * 0.4
            );
            tank.castShadow = true;
            buildingGroup.add(tank);

            // Tank legs (shared geometry/material)
            for (let l = 0; l < 4; l++) {
                const angle = (l / 4) * Math.PI * 2;
                const leg = new THREE.Mesh(sharedLegGeo, sharedLegMat);
                leg.position.set(
                    tank.position.x + Math.cos(angle) * 0.4,
                    roofY + 0.25,
                    tank.position.z + Math.sin(angle) * 0.4
                );
                buildingGroup.add(leg);
            }
        }

        // Rooftop garden bushes on ~20% of buildings (shared material, few shared geo sizes)
        if (seed > 0.3 && seed < 0.5) {
            const numBushes = 2 + Math.floor(seed2 * 3);
            for (let b = 0; b < numBushes; b++) {
                const bushGeo = new THREE.SphereGeometry(0.4 + seededRandom(building.x, building.z, 30 + b) * 0.3, 6, 6);
                const bush = new THREE.Mesh(bushGeo, sharedBushMat);
                bush.position.set(
                    (seededRandom(building.x, building.z, 40 + b) - 0.5) * (building.width * 0.7),
                    roofY + 0.3,
                    (seededRandom(building.x, building.z, 50 + b) - 0.5) * (building.depth * 0.7)
                );
                bush.castShadow = true;
                buildingGroup.add(bush);
            }
        }

        buildingGroup.position.set(
            building.x,
            getTerrainHeight(building.x, building.z),
            building.z
        );
        state.scene.add(buildingGroup);

        // Add as obstacle for collision
        state.obstacles.push({
            x: building.x,
            z: building.z,
            radius: Math.max(building.width, building.depth) / 2 + 1
        } as any);
    });
}

function createPark() {
    // Park is in the corner block (grid position 3,3)
    // Based on city config: blockSize=40, roadWidth=12, gridSize=4
    const blockSize = 40;
    const roadWidth = 12;
    const gridSize = 4;
    const totalBlockSize = blockSize + roadWidth;
    const halfCity = (gridSize * totalBlockSize) / 2;
    
    const parkX = -halfCity + roadWidth + (gridSize - 1) * totalBlockSize + blockSize / 2;
    const parkZ = -halfCity + roadWidth + (gridSize - 1) * totalBlockSize + blockSize / 2;
    
    // Grass area
    const grassGeo = new THREE.PlaneGeometry(blockSize - 4, blockSize - 4);
    grassGeo.rotateX(-Math.PI / 2);
    const grassMat = new THREE.MeshStandardMaterial({ color: PARK_COLOR, roughness: 0.9 });
    const grass = new THREE.Mesh(grassGeo, grassMat);
    grass.position.set(parkX, getTerrainHeight(parkX, parkZ) + 0.01, parkZ);
    grass.receiveShadow = true;
    state.scene.add(grass);
    
    // Park benches
    const benchMat = new THREE.MeshStandardMaterial({ color: 0x5D4037, roughness: 0.8 });
    const benchPositions = [
        { x: parkX - 8, z: parkZ },
        { x: parkX + 8, z: parkZ },
        { x: parkX, z: parkZ - 8 },
        { x: parkX, z: parkZ + 8 }
    ];
    
    benchPositions.forEach(pos => {
        const benchGroup = new THREE.Group();
        
        // Seat
        const seatGeo = new THREE.BoxGeometry(3, 0.2, 0.8);
        const seat = new THREE.Mesh(seatGeo, benchMat);
        seat.position.y = 0.5;
        seat.castShadow = true;
        benchGroup.add(seat);
        
        // Legs
        const legGeo = new THREE.BoxGeometry(0.2, 0.5, 0.2);
        [-1.2, 1.2].forEach(xOff => {
            const leg = new THREE.Mesh(legGeo, benchMat);
            leg.position.set(xOff, 0.25, 0);
            leg.castShadow = true;
            benchGroup.add(leg);
        });
        
        benchGroup.position.set(pos.x, getTerrainHeight(pos.x, pos.z), pos.z);
        if (pos.x === parkX) benchGroup.rotation.y = Math.PI / 2;
        state.scene.add(benchGroup);
    });
    
    // Park trees
    const parkTreePositions = [
        { x: parkX - 12, z: parkZ - 12 },
        { x: parkX + 12, z: parkZ - 12 },
        { x: parkX - 12, z: parkZ + 12 },
        { x: parkX + 12, z: parkZ + 12 },
        { x: parkX, z: parkZ }
    ];
    
    parkTreePositions.forEach(pos => {
        createParkTree(pos.x, pos.z);
    });
}

function createParkTree(x: number, z: number) {
    const treeGroup = new THREE.Group();
    const height = 5 + Math.random() * 3;
    
    // Trunk
    const trunkGeo = new THREE.CylinderGeometry(0.3, 0.4, height, 8);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5D4037 });
    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    trunk.position.y = height / 2;
    trunk.castShadow = true;
    treeGroup.add(trunk);
    
    // Foliage (rounder for park trees)
    const foliageGeo = new THREE.SphereGeometry(2.5, 8, 8);
    const foliageMat = new THREE.MeshStandardMaterial({ color: 0x2E7D32 });
    const foliage = new THREE.Mesh(foliageGeo, foliageMat);
    foliage.position.y = height + 1.5;
    foliage.castShadow = true;
    treeGroup.add(foliage);
    
    treeGroup.position.set(x, getTerrainHeight(x, z), z);
    state.scene.add(treeGroup);
    
    state.obstacles.push({ x, z, radius: 1 } as any);
}

function createPlaza() {
    // Plaza is in the center block (grid position 1,1 for a 4x4 grid)
    const blockSize = 40;
    const roadWidth = 12;
    const gridSize = 4;
    const totalBlockSize = blockSize + roadWidth;
    const halfCity = (gridSize * totalBlockSize) / 2;
    
    const bx = Math.floor(gridSize / 2) - 1;
    const bz = Math.floor(gridSize / 2) - 1;
    
    const plazaX = -halfCity + roadWidth + bx * totalBlockSize + blockSize / 2;
    const plazaZ = -halfCity + roadWidth + bz * totalBlockSize + blockSize / 2;
    
    // Plaza ground (light colored tiles)
    const plazaGeo = new THREE.PlaneGeometry(blockSize - 4, blockSize - 4);
    plazaGeo.rotateX(-Math.PI / 2);
    const plazaMat = new THREE.MeshStandardMaterial({ color: 0xccccbb, roughness: 0.7 });
    const plaza = new THREE.Mesh(plazaGeo, plazaMat);
    plaza.position.set(plazaX, getTerrainHeight(plazaX, plazaZ) + 0.01, plazaZ);
    plaza.receiveShadow = true;
    state.scene.add(plaza);
    
    // Central fountain
    const fountainGroup = new THREE.Group();

    // Base
    const baseGeo = new THREE.CylinderGeometry(4, 4.5, 0.8, 16);
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.6 });
    const base = new THREE.Mesh(baseGeo, stoneMat);
    base.position.y = 0.4;
    base.castShadow = true;
    base.receiveShadow = true;
    fountainGroup.add(base);

    // Water
    const waterGeo = new THREE.CylinderGeometry(3.5, 3.5, 0.3, 16);
    const waterMat = new THREE.MeshStandardMaterial({
        color: 0x4488aa,
        roughness: 0.1,
        metalness: 0.3,
        transparent: true,
        opacity: 0.8
    });
    const water = new THREE.Mesh(waterGeo, waterMat);
    water.position.y = 0.85;
    fountainGroup.add(water);

    // Center pillar
    const pillarGeo = new THREE.CylinderGeometry(0.5, 0.6, 2, 8);
    const pillar = new THREE.Mesh(pillarGeo, stoneMat);
    pillar.position.y = 1.8;
    pillar.castShadow = true;
    fountainGroup.add(pillar);

    const terrainAtFountain = getTerrainHeight(plazaX, plazaZ);
    fountainGroup.position.set(plazaX, terrainAtFountain, plazaZ);
    state.scene.add(fountainGroup);

    // Store fountain references for animation
    fountainWater = water;
    fountainBaseY = 0.85; // local Y within group
    fountainX = plazaX;
    fountainZ = plazaZ;

    // Create particle pool for water spray
    for (let i = 0; i < PARTICLE_COUNT; i++) {
        const p = new THREE.Mesh(sharedParticleGeo, sharedParticleMat);
        p.visible = false;
        fountainGroup.add(p);
        fountainParticles.push(p);
    }

    // Fountain as obstacle
    state.obstacles.push({ x: plazaX, z: plazaZ, radius: 5 } as any);
}

// Particle velocity state (stored separately from meshes)
const particleVelocities: { vy: number; vx: number; vz: number; life: number }[] = [];

export function animateFountain(time: number) {
    if (!fountainWater) return;

    // Bob the water surface gently
    fountainWater.position.y = fountainBaseY + Math.sin(time * 2.0) * 0.05;
    // Slow rotation for shimmer effect
    fountainWater.rotation.y = time * 0.3;

    // Initialize velocity state if needed
    while (particleVelocities.length < PARTICLE_COUNT) {
        particleVelocities.push({ vy: 0, vx: 0, vz: 0, life: 0 });
    }

    // Animate water spray particles
    for (let i = 0; i < PARTICLE_COUNT; i++) {
        const p = fountainParticles[i];
        const v = particleVelocities[i];

        if (v.life <= 0) {
            // Respawn particle at pillar top with upward velocity
            const angle = Math.random() * Math.PI * 2;
            const spread = 0.3;
            p.position.set(
                Math.cos(angle) * spread,
                2.8,
                Math.sin(angle) * spread
            );
            v.vy = 1.5 + Math.random() * 1.0;
            v.vx = Math.cos(angle) * (0.3 + Math.random() * 0.5);
            v.vz = Math.sin(angle) * (0.3 + Math.random() * 0.5);
            v.life = 0.8 + Math.random() * 0.6;
            p.visible = true;
        } else {
            // Update physics
            const dt = 0.016; // approx frame time
            v.vy -= 4.0 * dt; // gravity
            p.position.x += v.vx * dt;
            p.position.y += v.vy * dt;
            p.position.z += v.vz * dt;
            v.life -= dt;

            // Hide when below water level
            if (p.position.y < fountainBaseY) {
                p.visible = false;
                v.life = 0;
            }
        }
    }
}
