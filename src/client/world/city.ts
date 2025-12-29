import * as THREE from 'three';
import { state } from '../state.js';
import { getTerrainHeight } from './environment.js';

export interface BuildingData {
    x: number;
    z: number;
    width: number;
    depth: number;
    height: number;
    color: number;
}

export interface RoadData {
    x: number;
    z: number;
    width: number;
    length: number;
    rotation: number;
}

export interface CityData {
    buildings: BuildingData[];
    roads: RoadData[];
}

const ROAD_COLOR = 0x2a2a2a;
const LANE_MARKING_COLOR = 0xeeeeee;
const PARK_COLOR = 0x4a7c3f;

export function createCity(cityData: CityData) {
    if (!cityData) return;
    
    createRoads(cityData.roads);
    createBuildings(cityData.buildings);
    createPark();
    createPlaza();
}

function createRoads(roads: RoadData[]) {
    const roadMat = new THREE.MeshStandardMaterial({ 
        color: ROAD_COLOR, 
        roughness: 0.9,
        metalness: 0.1
    });
    
    const markingMat = new THREE.MeshStandardMaterial({
        color: LANE_MARKING_COLOR,
        roughness: 0.5
    });
    
    roads.forEach(road => {
        // Road surface
        const roadGeo = new THREE.PlaneGeometry(road.width, road.length);
        roadGeo.rotateX(-Math.PI / 2);
        
        const roadMesh = new THREE.Mesh(roadGeo, roadMat);
        roadMesh.position.set(road.x, getTerrainHeight(road.x, road.z) + 0.02, road.z);
        roadMesh.rotation.y = road.rotation;
        roadMesh.receiveShadow = true;
        state.scene.add(roadMesh);
        
        // Lane markings (dashed center line)
        const dashLength = 3;
        const dashGap = 2;
        const dashWidth = 0.3;
        const numDashes = Math.floor(road.length / (dashLength + dashGap));
        
        for (let i = 0; i < numDashes; i++) {
            const dashGeo = new THREE.PlaneGeometry(dashWidth, dashLength);
            dashGeo.rotateX(-Math.PI / 2);
            
            const dash = new THREE.Mesh(dashGeo, markingMat);
            const offset = -road.length / 2 + (i + 0.5) * (dashLength + dashGap);
            
            if (road.rotation === 0) {
                dash.position.set(road.x, getTerrainHeight(road.x, road.z + offset) + 0.03, road.z + offset);
            } else {
                dash.position.set(road.x + offset, getTerrainHeight(road.x + offset, road.z) + 0.03, road.z);
                dash.rotation.y = Math.PI / 2;
            }
            state.scene.add(dash);
        }
    });
}

function createBuildings(buildings: BuildingData[]) {
    buildings.forEach(building => {
        const buildingGroup = new THREE.Group();
        
        // Main building body
        const bodyGeo = new THREE.BoxGeometry(building.width, building.height, building.depth);
        const bodyMat = new THREE.MeshStandardMaterial({ 
            color: building.color,
            roughness: 0.8,
            metalness: 0.1
        });
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        body.position.y = building.height / 2;
        body.castShadow = true;
        body.receiveShadow = true;
        buildingGroup.add(body);
        
        // Windows
        const windowMat = new THREE.MeshStandardMaterial({
            color: 0x334455,
            roughness: 0.1,
            metalness: 0.8,
            emissive: 0x111122,
            emissiveIntensity: 0.1
        });
        
        const windowSize = 1.2;
        const windowSpacingH = 2.5;
        const windowSpacingV = 3;
        const windowInset = 0.05;
        
        // Front and back windows
        const numWindowsX = Math.floor((building.width - 2) / windowSpacingH);
        const numWindowsY = Math.floor((building.height - 2) / windowSpacingV);
        
        for (let wx = 0; wx < numWindowsX; wx++) {
            for (let wy = 0; wy < numWindowsY; wy++) {
                const windowGeo = new THREE.PlaneGeometry(windowSize, windowSize * 1.5);
                
                // Front
                const windowFront = new THREE.Mesh(windowGeo, windowMat);
                const xPos = -building.width / 2 + 1.5 + wx * windowSpacingH;
                const yPos = 2 + wy * windowSpacingV;
                windowFront.position.set(xPos, yPos, building.depth / 2 + windowInset);
                buildingGroup.add(windowFront);
                
                // Back
                const windowBack = new THREE.Mesh(windowGeo, windowMat);
                windowBack.position.set(xPos, yPos, -building.depth / 2 - windowInset);
                windowBack.rotation.y = Math.PI;
                buildingGroup.add(windowBack);
            }
        }
        
        // Side windows
        const numWindowsZ = Math.floor((building.depth - 2) / windowSpacingH);
        for (let wz = 0; wz < numWindowsZ; wz++) {
            for (let wy = 0; wy < numWindowsY; wy++) {
                const windowGeo = new THREE.PlaneGeometry(windowSize, windowSize * 1.5);
                
                const zPos = -building.depth / 2 + 1.5 + wz * windowSpacingH;
                const yPos = 2 + wy * windowSpacingV;
                
                // Left
                const windowLeft = new THREE.Mesh(windowGeo, windowMat);
                windowLeft.position.set(-building.width / 2 - windowInset, yPos, zPos);
                windowLeft.rotation.y = -Math.PI / 2;
                buildingGroup.add(windowLeft);
                
                // Right
                const windowRight = new THREE.Mesh(windowGeo, windowMat);
                windowRight.position.set(building.width / 2 + windowInset, yPos, zPos);
                windowRight.rotation.y = Math.PI / 2;
                buildingGroup.add(windowRight);
            }
        }
        
        // Roof detail
        const roofGeo = new THREE.BoxGeometry(building.width * 0.3, 1, building.depth * 0.3);
        const roofMat = new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.9 });
        const roof = new THREE.Mesh(roofGeo, roofMat);
        roof.position.y = building.height + 0.5;
        roof.castShadow = true;
        buildingGroup.add(roof);
        
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
    
    fountainGroup.position.set(plazaX, getTerrainHeight(plazaX, plazaZ), plazaZ);
    state.scene.add(fountainGroup);
    
    // Fountain as obstacle
    state.obstacles.push({ x: plazaX, z: plazaZ, radius: 5 } as any);
}
