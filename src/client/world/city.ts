import * as THREE from 'three';
import { state } from '../state.js';
import { BuildingData, RoadData, CityData } from '../types.js';
import { getTerrainHeight } from './environment.js';
import { CITY_LAYOUT, PLAZA_PROP_LAYOUT } from '../../shared/constants.js';
import { createWaterMaterial } from '../effects/worldShaders.js';

const ROAD_COLOR = 0x282a2b;
const INTERSECTION_COLOR = 0x242627;
const LANE_MARKING_COLOR = 0xf6e7ba;
const SIDEWALK_COLOR = 0xc8c1ae;
const PARK_COLOR = 0x4f8a48;

const PLAZA_BLOCK = { x: Math.floor(CITY_LAYOUT.gridSize / 2) - 1, z: Math.floor(CITY_LAYOUT.gridSize / 2) - 1 };
const PARK_BLOCK = { x: CITY_LAYOUT.gridSize - 1, z: CITY_LAYOUT.gridSize - 1 };

function roadGridCenter(index: number): number {
    const { blockSize, roadWidth, gridSize } = CITY_LAYOUT;
    const totalBlockSize = blockSize + roadWidth;
    const halfCity = (gridSize * totalBlockSize) / 2;
    return -halfCity + index * totalBlockSize + roadWidth / 2;
}

// Center of a city block (bx, bz) in world coordinates, derived from the shared layout
function blockCenter(bx: number, bz: number): { x: number; z: number } {
    const { blockSize, roadWidth, gridSize } = CITY_LAYOUT;
    const totalBlockSize = blockSize + roadWidth;
    const halfCity = (gridSize * totalBlockSize) / 2;
    return {
        x: -halfCity + roadWidth + bx * totalBlockSize + blockSize / 2,
        z: -halfCity + roadWidth + bz * totalBlockSize + blockSize / 2
    };
}

// Shared geometries and materials for windows (created once, reused across all buildings)
let sharedHFrameGeo: THREE.BoxGeometry;
let sharedFrameMat: THREE.MeshStandardMaterial;
let sharedGlassLitMat: THREE.MeshStandardMaterial;
let sharedGlassUnlitMat: THREE.MeshStandardMaterial;
let sharedGlassGeo: THREE.PlaneGeometry;

// Shared rooftop geometries/materials
let sharedACGeo: THREE.BoxGeometry;
let sharedACMat: THREE.MeshStandardMaterial;
let sharedTankGeo: THREE.CylinderGeometry;
let sharedTankMat: THREE.MeshStandardMaterial;
let sharedLegGeo: THREE.CylinderGeometry;
let sharedLegMat: THREE.MeshStandardMaterial;
let sharedBushMat: THREE.MeshStandardMaterial;
// A few shared bush sizes instead of a unique geometry per bush
let sharedBushGeos: THREE.SphereGeometry[];

// Shared door/awning resources
let sharedDoorGeo: THREE.PlaneGeometry;
let sharedDoorFrameGeo: THREE.BoxGeometry;
let sharedDoorFrameMat: THREE.MeshStandardMaterial;
let sharedDoorAwningGeo: THREE.BoxGeometry;
let sharedDoorAwningMat: THREE.MeshStandardMaterial;

// Material caches keyed by color (doors/awnings reuse a small fixed palette)
const doorMatCache = new Map<number, THREE.MeshStandardMaterial>();
const awningMatCache = new Map<number, THREE.MeshStandardMaterial>();

const PARTICLE_COUNT = 8;
let sharedParticleMat: THREE.MeshStandardMaterial;
let sharedParticleGeo: THREE.SphereGeometry;
let sharedParkTrunkGeo: THREE.CylinderGeometry;
let sharedParkFoliageGeo: THREE.SphereGeometry;
let sharedParkTrunkMat: THREE.MeshStandardMaterial;
let sharedParkFoliageMat: THREE.MeshStandardMaterial;
let sharedParkFoliageLightMat: THREE.MeshStandardMaterial;
let sharedPalmTrunkGeo: THREE.CylinderGeometry;
let sharedPalmLeafGeo: THREE.BoxGeometry;
let sharedPalmCoconutGeo: THREE.SphereGeometry;
let sharedPalmTrunkMat: THREE.MeshStandardMaterial;
let sharedPalmLeafMats: THREE.MeshStandardMaterial[];
let sharedPalmCoconutMat: THREE.MeshStandardMaterial;

// Fountain animation state, replaced wholesale on each createPlaza (re-entrant)
interface FountainState {
    water: THREE.Mesh;
    baseY: number;
    particles: THREE.Mesh[];
    velocities: { vx: number; vy: number; vz: number; life: number }[];
}
let fountain: FountainState | null = null;

function initSharedResources() {
    const frameThickness = 0.1;
    // Window frame geometry (shared across all windows)
    sharedHFrameGeo = new THREE.BoxGeometry(1.6, frameThickness, frameThickness); // wide enough, scaled per-window not needed if we accept uniform size
    sharedFrameMat = new THREE.MeshStandardMaterial({ color: WINDOW_FRAME_COLOR, roughness: 0.7 });
    sharedGlassLitMat = new THREE.MeshStandardMaterial({
        color: 0xFFE4A0, roughness: 0.4, metalness: 0.0,
        emissive: 0xFFCC44, emissiveIntensity: 0.6,
    });
    sharedGlassUnlitMat = new THREE.MeshStandardMaterial({
        color: 0x5588AA, roughness: 0.0, metalness: 0.5,
        emissive: 0x112233, emissiveIntensity: 0.15,
    });
    sharedGlassGeo = new THREE.PlaneGeometry(UNIFORM_W_WIDTH, UNIFORM_W_HEIGHT);

    // Rooftop shared resources
    sharedACGeo = new THREE.BoxGeometry(1.2, 0.8, 1.0);
    sharedACMat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.7, metalness: 0.3 });
    sharedTankGeo = new THREE.CylinderGeometry(0.6, 0.6, 1.5, 8);
    sharedTankMat = new THREE.MeshStandardMaterial({ color: 0x666666, roughness: 0.6, metalness: 0.4 });
    sharedLegGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.5, 4);
    sharedLegMat = new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.8 });
    sharedBushMat = new THREE.MeshStandardMaterial({ color: 0x3D8B37, roughness: 0.9 });
    // 3 bush sizes covering the previous 0.4..0.7 random radius range
    sharedBushGeos = [
        new THREE.SphereGeometry(0.45, 6, 6),
        new THREE.SphereGeometry(0.55, 6, 6),
        new THREE.SphereGeometry(0.65, 6, 6)
    ];

    // Door shared resources
    sharedDoorGeo = new THREE.PlaneGeometry(1.4, 2.4);
    sharedDoorFrameGeo = new THREE.BoxGeometry(1.8, 0.12, 0.15);
    sharedDoorFrameMat = new THREE.MeshStandardMaterial({ color: 0x3A2A1A, roughness: 0.6 });
    sharedDoorAwningGeo = new THREE.BoxGeometry(2.0, 0.08, 0.6);
    sharedDoorAwningMat = new THREE.MeshStandardMaterial({ color: 0x6B4226, roughness: 0.7 });

    // Fountain particle resources
    sharedParticleGeo = new THREE.SphereGeometry(0.3, 6, 6);
    sharedParticleMat = new THREE.MeshStandardMaterial({
        color: 0x88ccee, transparent: true, opacity: 0.6, roughness: 0.1
    });

    // Trees use unit geometries; per-tree dimensions are object transforms.
    sharedParkTrunkGeo = new THREE.CylinderGeometry(0.3, 0.4, 1, 8);
    sharedParkFoliageGeo = new THREE.SphereGeometry(1, 8, 7);
    sharedParkTrunkMat = new THREE.MeshStandardMaterial({ color: 0x5D4037 });
    sharedParkFoliageMat = new THREE.MeshStandardMaterial({ color: 0x2E7D32, roughness: 0.85 });
    sharedParkFoliageLightMat = new THREE.MeshStandardMaterial({ color: 0x4a9a4e, roughness: 0.85 });
    sharedPalmTrunkGeo = new THREE.CylinderGeometry(0.22, 0.42, 1, 8);
    sharedPalmLeafGeo = new THREE.BoxGeometry(0.48, 0.09, 4.2);
    sharedPalmCoconutGeo = new THREE.SphereGeometry(0.24, 6, 5);
    sharedPalmTrunkMat = new THREE.MeshStandardMaterial({ color: 0x9a6b45, roughness: 0.9 });
    sharedPalmLeafMats = [
        new THREE.MeshStandardMaterial({ color: 0x27734d, roughness: 0.82, side: THREE.DoubleSide }),
        new THREE.MeshStandardMaterial({ color: 0x3f925b, roughness: 0.82, side: THREE.DoubleSide })
    ];
    sharedPalmCoconutMat = new THREE.MeshStandardMaterial({ color: 0x654229, roughness: 0.9 });
}

function getDoorMat(color: number): THREE.MeshStandardMaterial {
    let mat = doorMatCache.get(color);
    if (!mat) {
        mat = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
        doorMatCache.set(color, mat);
    }
    return mat;
}

function getAwningMat(color: number): THREE.MeshStandardMaterial {
    let mat = awningMatCache.get(color);
    if (!mat) {
        mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, side: THREE.DoubleSide });
        awningMatCache.set(color, mat);
    }
    return mat;
}

export function createCity(cityData: CityData) {
    if (!cityData) return;

    initSharedResources();
    createRoads(cityData.roads);
    createIntersectionDetails();
    createBlockSurfaces();
    createBuildings(cityData.buildings);
    createPark();
    createPlaza();
    createStreetDetails();
    createDistrictSigns();
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

    const edgeMarkingMat = new THREE.MeshStandardMaterial({
        color: 0xf3c969,
        roughness: 0.65
    });

    const curbWidth = 1.1;
    const curbGeo = new THREE.BoxGeometry(curbWidth, 0.15, CITY_LAYOUT.blockSize);
    const edgeGeo = new THREE.PlaneGeometry(0.13, CITY_LAYOUT.blockSize - 1.5);
    edgeGeo.rotateX(-Math.PI / 2);
    const dashLength = 3;
    const dashGap = 2;
    const dashWidth = 0.3;
    const dashGeo = new THREE.PlaneGeometry(dashWidth, dashLength);
    dashGeo.rotateX(-Math.PI / 2);

    const segmentInstanceCount = roads.length * CITY_LAYOUT.gridSize * 2;
    const maxDashCount = roads.reduce(
        (count, road) => count + Math.floor(road.length / (dashLength + dashGap)),
        0
    );
    const curbs = new THREE.InstancedMesh(curbGeo, sidewalkMat, segmentInstanceCount);
    const edges = new THREE.InstancedMesh(edgeGeo, edgeMarkingMat, segmentInstanceCount);
    const dashes = new THREE.InstancedMesh(dashGeo, markingMat, maxDashCount);
    curbs.receiveShadow = true;

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0);
    let curbInstance = 0;
    let edgeInstance = 0;
    let dashInstance = 0;

    roads.forEach(road => {
        const terrainY = getTerrainHeight(road.x, road.z);
        const roadGroup = new THREE.Group();
        roadGroup.position.set(road.x, terrainY, road.z);
        roadGroup.rotation.y = road.rotation;

        // Road surface
        const roadGeo = new THREE.PlaneGeometry(road.width, road.length);
        roadGeo.rotateX(-Math.PI / 2);

        const roadMesh = new THREE.Mesh(roadGeo, roadMat);
        roadMesh.position.y = 0.05;
        roadMesh.receiveShadow = true;
        roadGroup.add(roadMesh);
        state.scene.add(roadGroup);

        quaternion.setFromAxisAngle(up, road.rotation);
        const rotationSin = Math.sin(road.rotation);
        const rotationCos = Math.cos(road.rotation);

        // Curbs and edge lines retain the road-local authored transforms, but
        // are composed into world-space instances to collapse their draw calls.
        for (const side of [-1, 1]) {
            const curbOffset = (road.width / 2 + curbWidth / 2) * side;
            const edgeOffset = (road.width / 2 - 0.5) * side;
            for (let segment = 0; segment < CITY_LAYOUT.gridSize; segment++) {
                const segmentOffset = -road.length / 2 + CITY_LAYOUT.roadWidth +
                    CITY_LAYOUT.blockSize / 2 + segment * (CITY_LAYOUT.blockSize + CITY_LAYOUT.roadWidth);

                position.set(
                    road.x + curbOffset * rotationCos + segmentOffset * rotationSin,
                    terrainY + 0.09,
                    road.z - curbOffset * rotationSin + segmentOffset * rotationCos
                );
                matrix.compose(position, quaternion, scale);
                curbs.setMatrixAt(curbInstance++, matrix);

                position.set(
                    road.x + edgeOffset * rotationCos + segmentOffset * rotationSin,
                    terrainY + 0.072,
                    road.z - edgeOffset * rotationSin + segmentOffset * rotationCos
                );
                matrix.compose(position, quaternion, scale);
                edges.setMatrixAt(edgeInstance++, matrix);
            }
        }

        // Lane markings (dashed center line)
        const numDashes = Math.floor(road.length / (dashLength + dashGap));
        for (let i = 0; i < numDashes; i++) {
            const lineOffset = -road.length / 2 + (i + 0.5) * (dashLength + dashGap);
            let insideIntersection = false;
            for (let intersection = 0; intersection <= CITY_LAYOUT.gridSize; intersection++) {
                const intersectionOffset = -road.length / 2 + CITY_LAYOUT.roadWidth / 2 +
                    intersection * (CITY_LAYOUT.blockSize + CITY_LAYOUT.roadWidth);
                if (Math.abs(lineOffset - intersectionOffset) < CITY_LAYOUT.roadWidth / 2 + 0.8) {
                    insideIntersection = true;
                    break;
                }
            }
            if (insideIntersection) continue;

            position.set(
                road.x + lineOffset * rotationSin,
                terrainY + 0.073,
                road.z + lineOffset * rotationCos
            );
            matrix.compose(position, quaternion, scale);
            dashes.setMatrixAt(dashInstance++, matrix);
        }
    });

    curbs.count = curbInstance;
    edges.count = edgeInstance;
    dashes.count = dashInstance;
    curbs.instanceMatrix.needsUpdate = true;
    edges.instanceMatrix.needsUpdate = true;
    dashes.instanceMatrix.needsUpdate = true;
    state.scene.add(curbs);
    state.scene.add(edges);
    state.scene.add(dashes);
}

function createIntersectionDetails() {
    const { roadWidth, gridSize } = CITY_LAYOUT;
    const asphaltMat = new THREE.MeshStandardMaterial({ color: INTERSECTION_COLOR, roughness: 0.94 });
    const stripeMat = new THREE.MeshStandardMaterial({ color: 0xf8f1d8, roughness: 0.6 });
    const padGeo = new THREE.PlaneGeometry(roadWidth + 0.2, roadWidth + 0.2);
    padGeo.rotateX(-Math.PI / 2);

    const stripeLength = roadWidth - 3;
    const stripeGeo = new THREE.BoxGeometry(stripeLength, 0.025, 0.42);
    const bandsPerApproach = 5;
    const stripeCount = (gridSize + 1) * (gridSize + 1) * bandsPerApproach * 4;
    const stripes = new THREE.InstancedMesh(stripeGeo, stripeMat, stripeCount);
    const pads = new THREE.InstancedMesh(padGeo, asphaltMat, (gridSize + 1) * (gridSize + 1));
    pads.receiveShadow = true;
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);
    let instance = 0;
    let padInstance = 0;

    for (let ix = 0; ix <= gridSize; ix++) {
        for (let iz = 0; iz <= gridSize; iz++) {
            const x = roadGridCenter(ix);
            const z = roadGridCenter(iz);
            const y = getTerrainHeight(x, z);

            quaternion.identity();
            matrix.compose(new THREE.Vector3(x, y + 0.056, z), quaternion, scale);
            pads.setMatrixAt(padInstance++, matrix);

            for (const side of [-1, 1]) {
                for (let band = 0; band < bandsPerApproach; band++) {
                    const approachOffset = side * (roadWidth / 2 + 0.65 + band * 0.72);
                    quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0);
                    matrix.compose(
                        new THREE.Vector3(x, y + 0.085, z + approachOffset),
                        quaternion,
                        scale
                    );
                    stripes.setMatrixAt(instance++, matrix);

                    quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
                    matrix.compose(
                        new THREE.Vector3(x + approachOffset, y + 0.085, z),
                        quaternion,
                        scale
                    );
                    stripes.setMatrixAt(instance++, matrix);
                }
            }
        }
    }

    stripes.count = instance;
    stripes.instanceMatrix.needsUpdate = true;
    pads.instanceMatrix.needsUpdate = true;
    state.scene.add(pads);
    state.scene.add(stripes);
}

function createBlockSurfaces() {
    const { blockSize, gridSize } = CITY_LAYOUT;
    const blockColors = [0xc9bea4, 0xd5c7aa, 0xbac8c1, 0xd7b9a8];
    const blockMaterials = blockColors.map(color => new THREE.MeshStandardMaterial({ color, roughness: 0.92 }));
    const alleyMat = new THREE.MeshStandardMaterial({ color: 0x716f68, roughness: 0.95 });

    for (let bx = 0; bx < gridSize; bx++) {
        for (let bz = 0; bz < gridSize; bz++) {
            if ((bx === PLAZA_BLOCK.x && bz === PLAZA_BLOCK.z) ||
                (bx === PARK_BLOCK.x && bz === PARK_BLOCK.z)) continue;

            const center = blockCenter(bx, bz);
            const y = getTerrainHeight(center.x, center.z);
            const surfaceGeo = new THREE.PlaneGeometry(blockSize - 2, blockSize - 2);
            surfaceGeo.rotateX(-Math.PI / 2);
            const surface = new THREE.Mesh(surfaceGeo, blockMaterials[(bx + bz * 2) % blockMaterials.length]);
            surface.position.set(center.x, y + 0.032, center.z);
            surface.receiveShadow = true;
            state.scene.add(surface);

            const alleyHorizontalGeo = new THREE.PlaneGeometry(blockSize - 3, 2.1);
            alleyHorizontalGeo.rotateX(-Math.PI / 2);
            const alleyHorizontal = new THREE.Mesh(alleyHorizontalGeo, alleyMat);
            alleyHorizontal.position.set(center.x, y + 0.041, center.z);
            state.scene.add(alleyHorizontal);

            const alleyVerticalGeo = new THREE.PlaneGeometry(2.1, blockSize - 3);
            alleyVerticalGeo.rotateX(-Math.PI / 2);
            const alleyVertical = new THREE.Mesh(alleyVerticalGeo, alleyMat);
            alleyVertical.position.set(center.x, y + 0.042, center.z);
            state.scene.add(alleyVertical);
        }
    }
}

// Seeded random for deterministic building details
function seededRandom(x: number, z: number, salt: number): number {
    const n = Math.sin(x * 12.9898 + z * 78.233 + salt * 43.1234) * 43758.5453;
    return n - Math.floor(n);
}

const AWNING_COLORS = [0xCC3333, 0xE67E22, 0x2980B9, 0x27AE60, 0x8E44AD, 0xC0392B];
const WINDOW_FRAME_COLOR = 0xF5F0E1;
const DOOR_COLORS = [0x5D3A1A, 0x3B2510, 0x6B4226, 0x2C1810];

// Shared glass geometry size (uniform window size for all buildings)
const UNIFORM_W_WIDTH = 1.2;
const UNIFORM_W_HEIGHT = 1.6;

function addWindows(group: THREE.Group, building: BuildingData) {
    // Windows with frames and varied lighting (wider spacing = fewer windows)
    const windowSpacingH = 3.5;
    const windowSpacingV = 3.5;

    const numWindowsX = Math.max(1, Math.floor((building.width - 2) / windowSpacingH));
    const numWindowsY = Math.max(1, Math.floor((building.height - 2) / windowSpacingV));
    const numWindowsZ = Math.max(0, Math.floor((building.depth - 2) / windowSpacingH));
    const totalWindowCount = 2 * numWindowsY * (numWindowsX + numWindowsZ);

    let litGlassCount = 0;
    for (let wx = 0; wx < numWindowsX; wx++) {
        for (let wy = 0; wy < numWindowsY; wy++) {
            if (seededRandom(building.x + wx, building.z + wy, 7) > 0.6) {
                litGlassCount += 2;
            }
        }
    }
    for (let wz = 0; wz < numWindowsZ; wz++) {
        for (let wy = 0; wy < numWindowsY; wy++) {
            if (seededRandom(building.x + wz + 10, building.z + wy, 8) > 0.6) {
                litGlassCount += 2;
            }
        }
    }

    const unlitGlassCount = totalWindowCount - litGlassCount;
    const frameCount = totalWindowCount * 2;
    const litGlass = litGlassCount > 0
        ? new THREE.InstancedMesh(sharedGlassGeo, sharedGlassLitMat, litGlassCount)
        : null;
    const unlitGlass = unlitGlassCount > 0
        ? new THREE.InstancedMesh(sharedGlassGeo, sharedGlassUnlitMat, unlitGlassCount)
        : null;
    const frames = frameCount > 0
        ? new THREE.InstancedMesh(sharedHFrameGeo, sharedFrameMat, frameCount)
        : null;

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0);
    let litGlassInstance = 0;
    let unlitGlassInstance = 0;
    let frameInstance = 0;

    const writeWindow = (
        x: number,
        y: number,
        z: number,
        rotY: number,
        isLit: boolean
    ) => {
        quaternion.setFromAxisAngle(up, rotY);
        position.set(x, y, z);
        matrix.compose(position, quaternion, scale);
        if (isLit) {
            litGlass!.setMatrixAt(litGlassInstance++, matrix);
        } else {
            unlitGlass!.setMatrixAt(unlitGlassInstance++, matrix);
        }

        const inset = 0.05;
        const offsetZ = Math.cos(rotY) * inset;
        const offsetX = Math.sin(rotY) * inset;
        position.set(
            x + offsetX * 0.5,
            y + UNIFORM_W_HEIGHT / 2,
            z + offsetZ * 0.5
        );
        matrix.compose(position, quaternion, scale);
        frames!.setMatrixAt(frameInstance++, matrix);

        position.set(
            x + offsetX * 0.5,
            y - UNIFORM_W_HEIGHT / 2,
            z + offsetZ * 0.5
        );
        matrix.compose(position, quaternion, scale);
        frames!.setMatrixAt(frameInstance++, matrix);
    };

    // Front and back windows
    for (let wx = 0; wx < numWindowsX; wx++) {
        for (let wy = 0; wy < numWindowsY; wy++) {
            const xPos = -building.width / 2 + 1.5 + wx * windowSpacingH;
            const yPos = 2 + wy * windowSpacingV;
            const isLit = seededRandom(building.x + wx, building.z + wy, 7) > 0.6;

            writeWindow(xPos, yPos, building.depth / 2 + 0.06, 0, isLit);
            writeWindow(xPos, yPos, -building.depth / 2 - 0.06, Math.PI, isLit);
        }
    }

    // Side windows
    for (let wz = 0; wz < numWindowsZ; wz++) {
        for (let wy = 0; wy < numWindowsY; wy++) {
            const zPos = -building.depth / 2 + 1.5 + wz * windowSpacingH;
            const yPos = 2 + wy * windowSpacingV;
            const isLit = seededRandom(building.x + wz + 10, building.z + wy, 8) > 0.6;

            writeWindow(-building.width / 2 - 0.06, yPos, zPos, -Math.PI / 2, isLit);
            writeWindow(building.width / 2 + 0.06, yPos, zPos, Math.PI / 2, isLit);
        }
    }

    if (litGlass) {
        litGlass.count = litGlassInstance;
        litGlass.instanceMatrix.needsUpdate = true;
        group.add(litGlass);
    }
    if (unlitGlass) {
        unlitGlass.count = unlitGlassInstance;
        unlitGlass.instanceMatrix.needsUpdate = true;
        group.add(unlitGlass);
    }
    if (frames) {
        frames.count = frameInstance;
        frames.instanceMatrix.needsUpdate = true;
        group.add(frames);
    }
}

function addDoor(group: THREE.Group, building: BuildingData, seed3: number) {
    // Door on front face
    const doorColor = DOOR_COLORS[Math.floor(seed3 * DOOR_COLORS.length)];
    const door = new THREE.Mesh(sharedDoorGeo, getDoorMat(doorColor));
    door.position.set(0, 1.2, building.depth / 2 + 0.06);
    group.add(door);

    // Door frame
    const doorFrameTop = new THREE.Mesh(sharedDoorFrameGeo, sharedDoorFrameMat);
    doorFrameTop.position.set(0, 2.45, building.depth / 2 + 0.08);
    doorFrameTop.castShadow = true;
    group.add(doorFrameTop);

    // Door overhang / small awning
    const doorAwning = new THREE.Mesh(sharedDoorAwningGeo, sharedDoorAwningMat);
    doorAwning.position.set(0, 2.55, building.depth / 2 + 0.35);
    doorAwning.castShadow = true;
    group.add(doorAwning);
}

function addAwning(group: THREE.Group, building: BuildingData, seed: number, seed2: number) {
    // Shop-front awning on ~40% of buildings
    if (!(seed > 0.6 && building.height > 5)) return;

    const awningColor = AWNING_COLORS[Math.floor(seed2 * AWNING_COLORS.length)];
    const awningMat = getAwningMat(awningColor);
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
    group.add(awning);
}

function addRoofProps(group: THREE.Group, building: BuildingData, seed: number, seed2: number, seed3: number) {
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
            group.add(ac);
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
        group.add(tank);

        // Tank legs (shared geometry/material)
        for (let l = 0; l < 4; l++) {
            const angle = (l / 4) * Math.PI * 2;
            const leg = new THREE.Mesh(sharedLegGeo, sharedLegMat);
            leg.position.set(
                tank.position.x + Math.cos(angle) * 0.4,
                roofY + 0.25,
                tank.position.z + Math.sin(angle) * 0.4
            );
            group.add(leg);
        }
    }

    // Rooftop garden bushes on ~20% of buildings (shared material + shared geo sizes)
    if (seed > 0.3 && seed < 0.5) {
        const numBushes = 2 + Math.floor(seed2 * 3);
        for (let b = 0; b < numBushes; b++) {
            const sizeRand = seededRandom(building.x, building.z, 30 + b);
            const bushGeo = sharedBushGeos[Math.floor(sizeRand * sharedBushGeos.length)];
            const bush = new THREE.Mesh(bushGeo, sharedBushMat);
            bush.position.set(
                (seededRandom(building.x, building.z, 40 + b) - 0.5) * (building.width * 0.7),
                roofY + 0.3,
                (seededRandom(building.x, building.z, 50 + b) - 0.5) * (building.depth * 0.7)
            );
            bush.castShadow = true;
            group.add(bush);
        }
    }
}

function addBuildingShapeDetails(group: THREE.Group, building: BuildingData, seed: number, seed2: number) {
    const trimMat = new THREE.MeshStandardMaterial({ color: 0xf1dfc2, roughness: 0.78 });
    const darkTrimMat = new THREE.MeshStandardMaterial({ color: 0x55483f, roughness: 0.86 });

    // A shadowed ground-floor band and bright parapet give the skyline much
    // stronger silhouettes than one unbroken box per building.
    const baseBand = new THREE.Mesh(
        new THREE.BoxGeometry(building.width + 0.18, 0.55, building.depth + 0.18),
        darkTrimMat
    );
    baseBand.position.y = 0.3;
    baseBand.castShadow = true;
    group.add(baseBand);

    const parapet = new THREE.Mesh(
        new THREE.BoxGeometry(building.width + 0.38, 0.38, building.depth + 0.38),
        trimMat
    );
    parapet.position.y = building.height + 0.12;
    parapet.castShadow = true;
    group.add(parapet);

    if (building.height > 13 && seed > 0.62) {
        const crownHeight = 1.1 + seed2 * 1.3;
        const crown = new THREE.Mesh(
            new THREE.BoxGeometry(building.width * 0.62, crownHeight, building.depth * 0.62),
            trimMat
        );
        crown.position.y = building.height + crownHeight / 2 + 0.28;
        crown.castShadow = true;
        group.add(crown);
    }

    // Short buildings become colourful storefronts, while taller buildings
    // receive a pair of shallow balconies facing the street.
    if (building.height < 11 || seed2 > 0.72) {
        const signColors = [0xe84545, 0xf3a23a, 0x2f86a6, 0x5b9c68];
        const signColor = signColors[Math.floor(seed * signColors.length)];
        const sign = new THREE.Mesh(
            new THREE.BoxGeometry(Math.min(3.8, building.width * 0.45), 0.7, 0.18),
            new THREE.MeshStandardMaterial({
                color: signColor,
                emissive: signColor,
                emissiveIntensity: 0.18,
                roughness: 0.55
            })
        );
        sign.position.set(0, 3.05, building.depth / 2 + 0.14);
        sign.castShadow = true;
        group.add(sign);
    } else {
        const balconyMat = new THREE.MeshStandardMaterial({ color: 0xdbc9aa, roughness: 0.8 });
        for (const y of [4.6, 8.1]) {
            if (y >= building.height - 1) continue;
            const balcony = new THREE.Mesh(
                new THREE.BoxGeometry(building.width * 0.55, 0.16, 1.0),
                balconyMat
            );
            balcony.position.set(0, y, building.depth / 2 + 0.45);
            balcony.castShadow = true;
            group.add(balcony);
        }
    }
}

function createBuildings(buildings: BuildingData[]) {
    buildings.forEach(building => {
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

        addWindows(buildingGroup, building);
        addDoor(buildingGroup, building, seed3);
        addAwning(buildingGroup, building, seed, seed2);
        addRoofProps(buildingGroup, building, seed, seed2, seed3);
        addBuildingShapeDetails(buildingGroup, building, seed, seed2);

        buildingGroup.position.set(
            building.x,
            getTerrainHeight(building.x, building.z),
            building.z
        );
        state.scene.add(buildingGroup);

        // Add as a rectangular (AABB) obstacle so collision matches the actual
        // building footprint instead of an undersized circle fit.
        state.obstacles.push({
            type: 'rect',
            x: building.x,
            z: building.z,
            halfWidth: building.width / 2,
            halfDepth: building.depth / 2
        });
    });
}

function createPark() {
    const { blockSize } = CITY_LAYOUT;
    const { x: parkX, z: parkZ } = blockCenter(PARK_BLOCK.x, PARK_BLOCK.z);
    const terrainY = getTerrainHeight(parkX, parkZ);

    const grassGeo = new THREE.PlaneGeometry(blockSize - 2, blockSize - 2);
    grassGeo.rotateX(-Math.PI / 2);
    const grassMat = new THREE.MeshStandardMaterial({ color: PARK_COLOR, roughness: 0.9 });
    const grass = new THREE.Mesh(grassGeo, grassMat);
    grass.position.set(parkX, terrainY + 0.03, parkZ);
    grass.receiveShadow = true;
    state.scene.add(grass);

    // Sand-coloured walking paths create a clear loop and cross-axis through
    // the park instead of leaving it as an undifferentiated grass square.
    const pathMat = new THREE.MeshStandardMaterial({ color: 0xd8c392, roughness: 0.95 });
    const pathHorizontalGeo = new THREE.PlaneGeometry(blockSize - 4, 3.2);
    pathHorizontalGeo.rotateX(-Math.PI / 2);
    const pathHorizontal = new THREE.Mesh(pathHorizontalGeo, pathMat);
    pathHorizontal.position.set(parkX, terrainY + 0.045, parkZ);
    state.scene.add(pathHorizontal);

    const pathVerticalGeo = new THREE.PlaneGeometry(3.2, blockSize - 4);
    pathVerticalGeo.rotateX(-Math.PI / 2);
    const pathVertical = new THREE.Mesh(pathVerticalGeo, pathMat);
    pathVertical.position.set(parkX, terrainY + 0.046, parkZ);
    state.scene.add(pathVertical);

    // Reflecting pond with a stone rim at the centre of Palm Park.
    const pondGeo = new THREE.CircleGeometry(5.2, 32);
    pondGeo.rotateX(-Math.PI / 2);
    const pondMat = createWaterMaterial({
        color: 0x3f9db0,
        emissive: 0x174d59,
        emissiveIntensity: 0.18,
        roughness: 0.18,
        metalness: 0.12,
        transparent: true,
        opacity: 0.9
    });
    const pond = new THREE.Mesh(pondGeo, pondMat);
    pond.position.set(parkX, terrainY + 0.09, parkZ);
    state.scene.add(pond);

    const pondRim = new THREE.Mesh(
        new THREE.TorusGeometry(5.35, 0.32, 8, 32),
        new THREE.MeshStandardMaterial({ color: 0xb3aa96, roughness: 0.88 })
    );
    pondRim.rotation.x = Math.PI / 2;
    pondRim.position.set(parkX, terrainY + 0.17, parkZ);
    pondRim.castShadow = true;
    state.scene.add(pondRim);

    const benchMat = new THREE.MeshStandardMaterial({ color: 0x5D4037, roughness: 0.8 });
    const benchPositions = [
        { x: parkX - 9, z: parkZ - 6 },
        { x: parkX + 9, z: parkZ + 6 },
        { x: parkX - 6, z: parkZ + 9 },
        { x: parkX + 6, z: parkZ - 9 }
    ];

    benchPositions.forEach(pos => {
        const benchGroup = new THREE.Group();

        // Seat
        const seatGeo = new THREE.BoxGeometry(3, 0.2, 0.8);
        const seat = new THREE.Mesh(seatGeo, benchMat);
        seat.position.y = 0.5;
        seat.castShadow = true;
        benchGroup.add(seat);

        const back = new THREE.Mesh(new THREE.BoxGeometry(3, 0.7, 0.16), benchMat);
        back.position.set(0, 0.92, 0.34);
        back.rotation.x = -0.12;
        back.castShadow = true;
        benchGroup.add(back);

        // Legs
        const legGeo = new THREE.BoxGeometry(0.2, 0.5, 0.2);
        [-1.2, 1.2].forEach(xOff => {
            const leg = new THREE.Mesh(legGeo, benchMat);
            leg.position.set(xOff, 0.25, 0);
            leg.castShadow = true;
            benchGroup.add(leg);
        });

        benchGroup.position.set(pos.x, getTerrainHeight(pos.x, pos.z), pos.z);
        benchGroup.rotation.y = Math.atan2(parkX - pos.x, parkZ - pos.z);
        state.scene.add(benchGroup);
        state.obstacles.push({ x: pos.x, z: pos.z, radius: 1.7 });
    });

    const parkTreePositions = [
        { x: parkX - 13, z: parkZ - 13 },
        { x: parkX + 13, z: parkZ - 13 },
        { x: parkX - 13, z: parkZ + 13 },
        { x: parkX + 13, z: parkZ + 13 }
    ];

    parkTreePositions.forEach(pos => {
        createParkTree(pos.x, pos.z);
    });

    const flowerColors = [0xf2c84b, 0xe95d78, 0x8e68d8, 0xf18d4c];
    const flowerPositions = [
        { x: parkX - 9, z: parkZ },
        { x: parkX + 9, z: parkZ },
        { x: parkX, z: parkZ - 9 },
        { x: parkX, z: parkZ + 9 }
    ];
    flowerPositions.forEach((pos, index) => {
        const bedGeo = new THREE.CircleGeometry(1.7, 20);
        bedGeo.rotateX(-Math.PI / 2);
        const bed = new THREE.Mesh(
            bedGeo,
            new THREE.MeshStandardMaterial({
                color: flowerColors[index],
                emissive: flowerColors[index],
                emissiveIntensity: 0.08,
                roughness: 0.9
            })
        );
        bed.position.set(pos.x, terrainY + 0.07, pos.z);
        state.scene.add(bed);
    });

    state.obstacles.push({ x: parkX, z: parkZ, radius: 5.7 });
}

function createParkTree(x: number, z: number) {
    const treeGroup = new THREE.Group();
    const height = 5.5 + seededRandom(x, z, 91) * 2.5;

    // Trunk
    const trunk = new THREE.Mesh(sharedParkTrunkGeo, sharedParkTrunkMat);
    trunk.scale.y = height;
    trunk.position.y = height / 2;
    trunk.castShadow = true;
    treeGroup.add(trunk);

    // Foliage (rounder for park trees)
    [-1.2, 0, 1.2].forEach((offset, index) => {
        const foliageScale = index === 1 ? 2.6 : 2.1;
        const foliage = new THREE.Mesh(
            sharedParkFoliageGeo,
            index === 1 ? sharedParkFoliageLightMat : sharedParkFoliageMat
        );
        foliage.scale.setScalar(foliageScale);
        foliage.position.set(offset, height + 1.2 + (index === 1 ? 0.8 : 0), (index - 1) * 0.45);
        foliage.castShadow = true;
        treeGroup.add(foliage);
    });

    treeGroup.position.set(x, getTerrainHeight(x, z), z);
    state.scene.add(treeGroup);

    state.obstacles.push({ x, z, radius: 1 });
}

function createPalmTree(x: number, z: number, salt: number) {
    const palm = new THREE.Group();
    const height = 6.5 + seededRandom(x, z, salt) * 2.2;
    const trunk = new THREE.Mesh(sharedPalmTrunkGeo, sharedPalmTrunkMat);
    trunk.scale.y = height;
    trunk.position.y = height / 2;
    trunk.rotation.z = (seededRandom(x, z, salt + 1) - 0.5) * 0.07;
    trunk.castShadow = true;
    palm.add(trunk);

    for (let i = 0; i < 7; i++) {
        const angle = (i / 7) * Math.PI * 2;
        const leaf = new THREE.Mesh(sharedPalmLeafGeo, sharedPalmLeafMats[i % 2]);
        leaf.position.set(Math.sin(angle) * 1.45, height + 0.05, Math.cos(angle) * 1.45);
        leaf.rotation.order = 'YXZ';
        leaf.rotation.y = angle;
        leaf.rotation.x = 0.28;
        leaf.castShadow = true;
        palm.add(leaf);
    }

    for (let i = 0; i < 3; i++) {
        const coconut = new THREE.Mesh(sharedPalmCoconutGeo, sharedPalmCoconutMat);
        const angle = (i / 3) * Math.PI * 2;
        coconut.position.set(Math.cos(angle) * 0.35, height - 0.18, Math.sin(angle) * 0.35);
        palm.add(coconut);
    }

    palm.position.set(x, getTerrainHeight(x, z), z);
    state.scene.add(palm);
    state.obstacles.push({ x, z, radius: 1.0 });
}

function createStreetDetails() {
    const { blockSize, roadWidth, gridSize } = CITY_LAYOUT;
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x334247, roughness: 0.55, metalness: 0.55 });
    const lampMat = new THREE.MeshStandardMaterial({
        color: 0xffe4a3,
        emissive: 0xffc95a,
        emissiveIntensity: 1.25,
        roughness: 0.32
    });
    const poleGeo = new THREE.CylinderGeometry(0.12, 0.18, 5.2, 8);
    const armGeo = new THREE.BoxGeometry(1.25, 0.12, 0.12);
    const lampGeo = new THREE.SphereGeometry(0.28, 8, 6);
    const cornerOffset = blockSize / 2 - 2.1;

    function addStreetLight(x: number, z: number, rotation: number) {
        const light = new THREE.Group();
        const pole = new THREE.Mesh(poleGeo, poleMat);
        pole.position.y = 2.6;
        pole.castShadow = true;
        light.add(pole);

        const arm = new THREE.Mesh(armGeo, poleMat);
        arm.position.set(0.5, 5.08, 0);
        arm.castShadow = true;
        light.add(arm);

        const bulb = new THREE.Mesh(lampGeo, lampMat);
        bulb.position.set(1.02, 4.92, 0);
        light.add(bulb);

        light.position.set(x, getTerrainHeight(x, z), z);
        light.rotation.y = rotation;
        state.scene.add(light);
        state.obstacles.push({ x, z, radius: 0.7 });
    }

    for (let bx = 0; bx < gridSize; bx++) {
        for (let bz = 0; bz < gridSize; bz++) {
            const center = blockCenter(bx, bz);
            const flip = (bx + bz) % 2 === 0;
            const corners = flip
                ? [{ x: -cornerOffset, z: -cornerOffset }, { x: cornerOffset, z: cornerOffset }]
                : [{ x: -cornerOffset, z: cornerOffset }, { x: cornerOffset, z: -cornerOffset }];
            corners.forEach(corner => {
                const x = center.x + corner.x;
                const z = center.z + corner.z;
                addStreetLight(x, z, Math.atan2(-corner.x, -corner.z));
            });
        }
    }

    // A palm-lined central boulevard anchors the California identity and is
    // visible from most blocks, making orientation much easier at speed.
    const boulevardX = roadGridCenter(Math.floor(gridSize / 2));
    for (let bz = 0; bz < gridSize; bz++) {
        const z = blockCenter(0, bz).z;
        createPalmTree(boulevardX - roadWidth / 2 - 2.2, z, 200 + bz);
        createPalmTree(boulevardX + roadWidth / 2 + 2.2, z, 220 + bz);
    }
}

function createSignTexture(label: string, accent: string): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (ctx) {
        ctx.fillStyle = '#20353a';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = accent;
        ctx.lineWidth = 12;
        ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
        ctx.fillStyle = '#fff8e7';
        ctx.font = '700 52px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, canvas.width / 2, canvas.height / 2 + 2);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

function createDistrictSigns() {
    const postMat = new THREE.MeshStandardMaterial({ color: 0x3b4a4d, roughness: 0.65, metalness: 0.45 });

    function addSign(label: string, accent: string, x: number, z: number, rotation: number) {
        const sign = new THREE.Group();
        const texture = createSignTexture(label, accent);
        const boardGeo = new THREE.PlaneGeometry(7.4, 1.85);
        const boardMat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.FrontSide });
        for (const face of [{ z: 0.025, rotation: 0 }, { z: -0.025, rotation: Math.PI }]) {
            const board = new THREE.Mesh(boardGeo, boardMat);
            board.position.set(0, 3.9, face.z);
            board.rotation.y = face.rotation;
            sign.add(board);
        }

        for (const postX of [-2.6, 2.6]) {
            const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 3.3, 7), postMat);
            post.position.set(postX, 1.65, 0);
            post.castShadow = true;
            sign.add(post);
            state.obstacles.push({
                x: x + Math.cos(rotation) * postX,
                z: z - Math.sin(rotation) * postX,
                radius: 0.35
            });
        }

        sign.position.set(x, getTerrainHeight(x, z), z);
        sign.rotation.y = rotation;
        state.scene.add(sign);
    }

    const plaza = blockCenter(PLAZA_BLOCK.x, PLAZA_BLOCK.z);
    const park = blockCenter(PARK_BLOCK.x, PARK_BLOCK.z);
    addSign('SUNSET PLAZA', '#f3a23a', plaza.x, plaza.z - CITY_LAYOUT.blockSize / 2 + 2.1, 0);
    addSign('PALM PARK', '#6fbd77', park.x, park.z - CITY_LAYOUT.blockSize / 2 + 2.1, 0);
}

function createPlaza() {
    const { blockSize } = CITY_LAYOUT;
    const { x: plazaX, z: plazaZ } = blockCenter(PLAZA_BLOCK.x, PLAZA_BLOCK.z);
    const terrainAtFountain = getTerrainHeight(plazaX, plazaZ);

    const plazaGeo = new THREE.PlaneGeometry(blockSize - 2, blockSize - 2);
    plazaGeo.rotateX(-Math.PI / 2);
    const plazaMat = new THREE.MeshStandardMaterial({ color: 0xd8cdb7, roughness: 0.82 });
    const plaza = new THREE.Mesh(plazaGeo, plazaMat);
    plaza.position.set(plazaX, terrainAtFountain + 0.031, plazaZ);
    plaza.receiveShadow = true;
    state.scene.add(plaza);

    // One textured mesh replaces 64 individual tile meshes, preserving the
    // checkerboard landmark while keeping the mobile draw-call budget lean.
    const tileCanvas = document.createElement('canvas');
    tileCanvas.width = 512;
    tileCanvas.height = 512;
    const tileCtx = tileCanvas.getContext('2d');
    const tileCount = 8;
    const tilePixels = tileCanvas.width / tileCount;
    if (tileCtx) {
        for (let tx = 0; tx < tileCount; tx++) {
            for (let tz = 0; tz < tileCount; tz++) {
                tileCtx.fillStyle = (tx + tz) % 2 === 0 ? '#e5d8bd' : '#c77b5b';
                tileCtx.fillRect(tx * tilePixels, tz * tilePixels, tilePixels, tilePixels);
                tileCtx.strokeStyle = 'rgba(91, 70, 55, 0.24)';
                tileCtx.lineWidth = 2;
                tileCtx.strokeRect(tx * tilePixels, tz * tilePixels, tilePixels, tilePixels);
            }
        }
    }
    const tileTexture = new THREE.CanvasTexture(tileCanvas);
    tileTexture.colorSpace = THREE.SRGBColorSpace;
    const tileGeo = new THREE.PlaneGeometry(blockSize - 4, blockSize - 4);
    tileGeo.rotateX(-Math.PI / 2);
    const tiledPlaza = new THREE.Mesh(
        tileGeo,
        new THREE.MeshStandardMaterial({ map: tileTexture, roughness: 0.8 })
    );
    tiledPlaza.position.set(plazaX, terrainAtFountain + 0.043, plazaZ);
    tiledPlaza.receiveShadow = true;
    state.scene.add(tiledPlaza);

    // Central fountain
    const fountainGroup = new THREE.Group();

    // Base
    const baseGeo = new THREE.CylinderGeometry(4, 4.5, 0.8, 24);
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0xb9ad95, roughness: 0.72 });
    const base = new THREE.Mesh(baseGeo, stoneMat);
    base.position.y = 0.4;
    base.castShadow = true;
    base.receiveShadow = true;
    fountainGroup.add(base);

    // Water
    const waterGeo = new THREE.CylinderGeometry(3.5, 3.5, 0.3, 24);
    const waterMat = createWaterMaterial({
        color: 0x3f9fb8,
        emissive: 0x174d5b,
        emissiveIntensity: 0.2,
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

    const topBowl = new THREE.Mesh(
        new THREE.CylinderGeometry(1.6, 1.9, 0.35, 20),
        stoneMat
    );
    topBowl.position.y = 2.75;
    topBowl.castShadow = true;
    fountainGroup.add(topBowl);

    fountainGroup.position.set(plazaX, terrainAtFountain, plazaZ);
    state.scene.add(fountainGroup);

    // Fresh fountain state per plaza (re-entrant: old state simply gets dropped)
    const particles: THREE.Mesh[] = [];
    const velocities: FountainState['velocities'] = [];
    for (let i = 0; i < PARTICLE_COUNT; i++) {
        const p = new THREE.Mesh(sharedParticleGeo, sharedParticleMat);
        p.visible = false;
        fountainGroup.add(p);
        particles.push(p);
        velocities.push({ vx: 0, vy: 0, vz: 0, life: 0 });
    }
    fountain = { water, baseY: 0.85 /* local Y within group */, particles, velocities };

    const planterMat = new THREE.MeshStandardMaterial({ color: 0x9b644d, roughness: 0.86 });
    const planterGreen = new THREE.MeshStandardMaterial({ color: 0x4c8f4d, roughness: 0.9 });
    const parasolColors = [0xe84545, 0xf0a23a, 0x368ca6, 0x6ca469];
    const planterOffset = PLAZA_PROP_LAYOUT.planterOffset;
    const cornerOffsets = [
        { x: -planterOffset, z: -planterOffset }, { x: planterOffset, z: -planterOffset },
        { x: -planterOffset, z: planterOffset }, { x: planterOffset, z: planterOffset }
    ];
    cornerOffsets.forEach((offset, index) => {
        const planter = new THREE.Group();
        const pot = new THREE.Mesh(new THREE.CylinderGeometry(1.45, 1.2, 1.0, 10), planterMat);
        pot.position.y = 0.5;
        pot.castShadow = true;
        planter.add(pot);
        const shrub = new THREE.Mesh(new THREE.SphereGeometry(1.35, 8, 7), planterGreen);
        shrub.position.y = 1.65;
        shrub.castShadow = true;
        planter.add(shrub);
        const planterX = plazaX + offset.x;
        const planterZ = plazaZ + offset.z;
        planter.position.set(planterX, terrainAtFountain + 0.04, planterZ);
        state.scene.add(planter);
        state.obstacles.push({ x: planterX, z: planterZ, radius: PLAZA_PROP_LAYOUT.planterRadius });

        const parasol = new THREE.Group();
        const pole = new THREE.Mesh(
            new THREE.CylinderGeometry(0.06, 0.07, 2.8, 6),
            new THREE.MeshStandardMaterial({ color: 0x6b5948, roughness: 0.8 })
        );
        pole.position.y = 1.4;
        parasol.add(pole);
        const canopy = new THREE.Mesh(
            new THREE.ConeGeometry(2.0, 0.65, 12),
            new THREE.MeshStandardMaterial({ color: parasolColors[index], roughness: 0.72 })
        );
        canopy.position.y = 2.85;
        canopy.castShadow = true;
        parasol.add(canopy);
        const parasolX = plazaX + Math.sign(offset.x) * PLAZA_PROP_LAYOUT.parasolOffset;
        const parasolZ = plazaZ + Math.sign(offset.z) * PLAZA_PROP_LAYOUT.parasolOffset;
        parasol.position.set(parasolX, terrainAtFountain + 0.04, parasolZ);
        state.scene.add(parasol);
        state.obstacles.push({ x: parasolX, z: parasolZ, radius: PLAZA_PROP_LAYOUT.parasolRadius });
    });

    // Fountain as obstacle
    state.obstacles.push({ x: plazaX, z: plazaZ, radius: 5 });
}

// 'time' is the elapsed time in seconds passed by main.ts; the real per-frame
// dt is derived from the delta between successive calls (framerate-independent).
let lastFountainTime: number | null = null;

export function animateFountain(time: number) {
    const f = fountain;
    if (!f) return;

    const dt = lastFountainTime === null ? 0 : Math.min(Math.max(time - lastFountainTime, 0), 0.1);
    lastFountainTime = time;

    // Bob the water surface gently
    f.water.position.y = f.baseY + Math.sin(time * 2.0) * 0.05;
    // Slow rotation for shimmer effect
    f.water.rotation.y = time * 0.3;

    // Animate water spray particles
    for (let i = 0; i < PARTICLE_COUNT; i++) {
        const p = f.particles[i];
        const v = f.velocities[i];

        if (v.life <= 0) {
            // Respawn particle at pillar top with upward velocity
            const angle = Math.random() * Math.PI * 2;
            const spread = 0.5;
            p.position.set(
                Math.cos(angle) * spread,
                2.8,
                Math.sin(angle) * spread
            );
            v.vy = 2.5 + Math.random() * 2.0;
            v.vx = Math.cos(angle) * (0.6 + Math.random() * 1.0);
            v.vz = Math.sin(angle) * (0.6 + Math.random() * 1.0);
            v.life = 1.6 + Math.random() * 1.2;
            p.visible = true;
        } else {
            // Update physics with the real frame dt
            v.vy -= 4.0 * dt; // gravity
            p.position.x += v.vx * dt;
            p.position.y += v.vy * dt;
            p.position.z += v.vz * dt;
            v.life -= dt;

            // Hide when below water level
            if (p.position.y < f.baseY) {
                p.visible = false;
                v.life = 0;
            }
        }
    }
}
