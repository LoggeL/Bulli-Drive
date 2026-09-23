import * as THREE from 'three';
import { state } from '../state.js';
import type { BuildingData, RoadData, CityData } from '../../shared/protocol.js';
import { getTerrainHeight } from './environment.js';
import { CITY_LAYOUT, PLAZA_PROP_LAYOUT } from '../../shared/constants.js';
import { positionHash } from '../../shared/math/rng.js';
import { blockCenter, PARK_BLOCK, PLAZA_BLOCK, roadLineCenter } from '../../shared/world/cityGen.js';
import { COLLIDER_TOPS } from '../../shared/world/colliders.js';
import { lightingTier } from '../render/lighting.js';
import { Batch, orientedQuad, quad, rgb, rng, scaleRgb, type RGB } from './batch.js';
import { worldMaterials } from './worldMaterials.js';
import { addShrub } from './vegetation.js';
import { createPalms, type PalmSpot } from './palms.js';
import { createFurniture, FINISH, lathe, PropBatch, type Finish, type FurnitureSpot } from './furniture.js';
import { BENCH_COLLIDER_RADIUS, LAMP_COLLIDER_RADIUS, parkBenches, parkFurniture, streetFurniture, streetPosts, type FurniturePlacement } from './streetLayout.js';
import { addPondRim, buildFountain } from './fountain.js';

// The city in the realistic look (graphics G1): asphalt with worn markings,
// concrete sidewalks, stucco buildings from a storey atlas with hip or flat
// roofs, awnings and shop fronts, a paved plaza with a fountain and a lawn
// park with Canary Island date palms. All static geometry is merged per
// material (a dozen draw calls for the whole city instead of about a
// thousand meshes); street furniture (furniture.ts: street lights, traffic
// signals, hydrants, trash cans, benches) and palms (palms.ts) are
// instanced.
//
// Layout and collisions are unchanged: every obstacle is pushed at the same
// place, in the same order and with the same size as before, only the
// visuals changed.

const { blockSize, roadWidth, gridSize } = CITY_LAYOUT;
const HALF_ROAD = roadWidth / 2;

// Heights above the terrain of the flat layers (the materials add polygon
// offsets, so they do not flicker at a distance)
const Y_BLOCK = 0.032;
const Y_ROAD = 0.05;
const Y_MARK = 0.062;
const CURB_HEIGHT = 0.15;

// Facade atlas (generated/facade_albedo_tint): 4 storey bands, 1 unit = 13.6 m
// with 3 window axes; wall piers between the windows sit at u = 0.04 + k / 3
const ATLAS_MODULE = 13.6;
const AXIS = ATLAS_MODULE / 3;
const PIER_U = 0.04;
const bandV = (band: number): [number, number] => [1 - (band + 1) / 4 + 0.002, 1 - band / 4 - 0.002];

// Server building colors -> the calm stucco tints of the probe
const TINTS: Record<number, number> = {
    0xC17A56: 0xF5BFA0, // terracotta -> peach
    0xE8D5B7: 0xEBD9BC, // sand
    0xF5F0E1: 0xF7EEDC, // cream
    0xB8D4E3: 0xD5DFE3, // pale blue
    0xA8C6A0: 0xD3DEC2, // sage
    0xFAF6F0: 0xFBF8EE, // warm white
    0xE8856A: 0xF3CBC2, // coral -> pink
    0xD4A574: 0xF2D09A, // adobe -> ochre
    0xC9B99A: 0xEBD9BC, // khaki -> sand
    0xE0C8A8: 0xF7EEDC // stucco beige -> cream
};
const AWNING_COLORS: [number, number][] = [[0x9E2F2A, 0xEFE8DA], [0x2E5E47, 0xEAE3D2], [0x23566E, 0xEAE3D2], [0xA86A2A, 0xEFE8DA]];
const PARASOL_COLORS = [0xB8322C, 0xC98A2E, 0x23566E, 0x2E5E47];

const CONCRETE = rgb(0xF4EDE2);
// Rooftop air conditioning units: galvanized casing, dark fan grille
const AC_CASING: Finish = { color: rgb(0x8D918F), rough: 0.45, metal: 0.6 };
const AC_GRILLE: Finish = { color: rgb(0x5F6462), rough: 0.5, metal: 0.4 };

interface CityBatches {
    asphalt: Batch;
    markings: Batch;
    sidewalk: Batch;
    lawn: Batch;
    sand: Batch;
    facade: Batch;
    stucco: Batch;
    tiles: Batch;
    gravel: Batch;
    storefront: Batch;
    fabric: Batch;
    props: PropBatch;
    pavers: Batch;
    shrub: Batch;
    pond: Batch;
    signs: Batch;
}

// Palms, street furniture and fountain water of the city (instanced or
// separate meshes, added after the batches)
interface CityExtras {
    palms: PalmSpot[];
    furniture: FurnitureSpot[];
    water: THREE.Mesh[];
}

const toSpot = (placement: FurniturePlacement): FurnitureSpot => ({
    kind: placement.kind,
    x: placement.x,
    y: getTerrainHeight(placement.x, placement.z),
    z: placement.z,
    rotation: placement.rotation
});

export function createCity(cityData: CityData) {
    if (!cityData) return;
    const M = worldMaterials();
    const B: CityBatches = {
        asphalt: new Batch('city-asphalt'),
        markings: new Batch('city-markings'),
        sidewalk: new Batch('city-sidewalk'),
        lawn: new Batch('city-lawn'),
        sand: new Batch('city-paths'),
        facade: new Batch('city-facades'),
        stucco: new Batch('city-stucco'),
        tiles: new Batch('city-roof-tiles'),
        gravel: new Batch('city-roof-gravel'),
        storefront: new Batch('city-storefronts'),
        fabric: new Batch('city-fabric'),
        props: new PropBatch('city-props'),
        pavers: new Batch('city-pavers'),
        shrub: new Batch('city-shrubs'),
        pond: new Batch('city-pond'),
        signs: new Batch('city-signs')
    };
    const extras: CityExtras = { palms: [], furniture: [], water: [] };

    createRoads(B, cityData.roads);
    createIntersectionDetails(B);
    createBlockSurfaces(B);
    createBuildings(B, cityData.buildings);
    createPark(B, extras);
    createPlaza(B, extras);
    createStreetDetails(extras);
    createDistrictSigns(B);

    const group = new THREE.Group();
    group.name = 'city';
    const add = (batch: Batch, material: THREE.Material, cast: boolean, receive = true) => {
        const mesh = batch.mesh(material, { cast, receive });
        if (mesh) group.add(mesh);
        return mesh;
    };
    add(B.asphalt, M.asphalt, false);
    add(B.markings, M.markings, false);
    add(B.sidewalk, M.sidewalk, false);
    add(B.lawn, M.lawn, false);
    add(B.sand, M.sand, false);
    add(B.pond, M.water, false);
    add(B.facade, M.facade, true);
    add(B.stucco, M.stucco, true);
    add(B.tiles, M.tiles, true);
    add(B.gravel, M.gravel, false);
    add(B.storefront, M.storefront, false);
    add(B.fabric, M.fabric, true);
    add(B.pavers, M.pavers, false);
    const props = B.props.mesh(M.furniture, { cast: true });
    if (props) group.add(props);
    add(B.shrub, M.shrub, true);
    add(B.signs, signMaterial(), true);
    const tier = lightingTier();
    group.add(createFurniture(M.furniture, extras.furniture, tier));
    group.add(createPalms(M, extras.palms, tier, state.renderer ?? null));
    group.add(...extras.water);
    state.scene.add(group);
}

// --- Roads ------------------------------------------------------------------------

// Asphalt as non-overlapping pieces: intersection squares and the stretches
// between them (overlapping road planes would flicker)
function createRoads(B: CityBatches, roads: RoadData[]) {
    const xs = roads.filter(road => Math.abs(Math.sin(road.rotation)) < 0.5).map(road => road.x).sort((a, b) => a - b);
    const zs = roads.filter(road => Math.abs(Math.sin(road.rotation)) >= 0.5).map(road => road.z).sort((a, b) => a - b);
    const y = (x: number, z: number) => getTerrainHeight(x, z) + Y_ROAD;
    const plane = (x0: number, x1: number, z0: number, z1: number) => {
        const cy = y((x0 + x1) / 2, (z0 + z1) / 2);
        B.asphalt.add(quad([x0, cy, z1], [x1, cy, z1], [x1, cy, z0], [x0, cy, z0]), null, [1, 1, 1], { box: 3 });
    };
    for (const x of xs) {
        for (const z of zs) plane(x - HALF_ROAD, x + HALF_ROAD, z - HALF_ROAD, z + HALF_ROAD);
        for (let k = 0; k < zs.length - 1; k++) plane(x - HALF_ROAD, x + HALF_ROAD, zs[k] + HALF_ROAD, zs[k + 1] - HALF_ROAD);
    }
    for (const z of zs) {
        for (let k = 0; k < xs.length - 1; k++) plane(xs[k] + HALF_ROAD, xs[k + 1] - HALF_ROAD, z - HALF_ROAD, z + HALF_ROAD);
    }

    const white = rgb(0xE8E4D8);
    const yellow = rgb(0xE0A526);
    const red = rgb(0xA8312A);
    // Paint rectangle, long along the road (subdivided so the wear noise
    // and the vertex positions stay precise)
    const stripe = (x: number, z: number, along: 'x' | 'z', length: number, width: number, color: RGB) => {
        const my = y(x, z) - Y_ROAD + Y_MARK;
        const hl = length / 2, hw = width / 2;
        if (along === 'z') B.markings.add(quad([x - hw, my, z + hl], [x + hw, my, z + hl], [x + hw, my, z - hl], [x - hw, my, z - hl]), null, color);
        else B.markings.add(quad([x - hl, my, z + hw], [x + hl, my, z + hw], [x + hl, my, z - hw], [x - hl, my, z - hw]), null, color);
    };

    // Per stretch between two intersections: yellow dashed center line,
    // white edge lines, red curbs next to the corners
    const stretch = (a: number, b: number, line: number, along: 'x' | 'z') => {
        const at = (s: number, off: number): [number, number] => (along === 'z' ? [line + off, s] : [s, line + off]);
        const start = a + HALF_ROAD + 12, end = b - HALF_ROAD - 12;
        for (let s = start; s + 3 <= end + 0.01; s += 9) {
            const [x, z] = at(s + 1.5, 0);
            stripe(x, z, along, 3, 0.13, yellow);
        }
        const edgeStart = a + HALF_ROAD + 9.9, edgeEnd = b - HALF_ROAD - 9.9;
        for (const off of [-(HALF_ROAD - 0.5), HALF_ROAD - 0.5]) {
            const [x, z] = at((edgeStart + edgeEnd) / 2, off);
            stripe(x, z, along, edgeEnd - edgeStart, 0.12, white);
        }
        // Red curb faces over the first and last 4 m (no parking)
        for (const side of [-1, 1]) {
            for (const [s0, s1] of [[a + HALF_ROAD, a + HALF_ROAD + 4], [b - HALF_ROAD - 4, b - HALF_ROAD]]) {
                const off = side * (HALF_ROAD + 0.004);
                const [xa, za] = at(s0, off);
                const [xb, zb] = at(s1, off);
                const g = y(xa, za) - Y_ROAD;
                B.markings.add(orientedQuad([xa, g, za], [xb, g, zb], [xb, g + CURB_HEIGHT + 0.07, zb], [xa, g + CURB_HEIGHT + 0.07, za],
                    along === 'z' ? [-side, 0, 0] : [0, 0, -side]), null, red);
            }
        }
    };
    for (const x of xs) for (let k = 0; k < zs.length - 1; k++) stretch(zs[k], zs[k + 1], x, 'z');
    for (const z of zs) for (let k = 0; k < xs.length - 1; k++) stretch(xs[k], xs[k + 1], z, 'x');

    // Curbs: a raised concrete strip along both sides of every stretch
    const curbWidth = 1.1;
    for (const road of roads) {
        const rotationSin = Math.sin(road.rotation);
        const rotationCos = Math.cos(road.rotation);
        const terrainY = getTerrainHeight(road.x, road.z);
        for (const side of [-1, 1]) {
            const curbOffset = (road.width / 2 + curbWidth / 2) * side;
            for (let segment = 0; segment < gridSize; segment++) {
                const segmentOffset = -road.length / 2 + roadWidth + blockSize / 2 + segment * (blockSize + roadWidth);
                const x = road.x + curbOffset * rotationCos + segmentOffset * rotationSin;
                const z = road.z - curbOffset * rotationSin + segmentOffset * rotationCos;
                B.sidewalk.box(curbWidth, CURB_HEIGHT, blockSize, x, terrainY + CURB_HEIGHT / 2 + 0.015, z, CONCRETE, { box: 2.5 }, road.rotation);
            }
        }
    }
}

// Continental crosswalks (bars along the traffic) and stop lines at every
// intersection
function createIntersectionDetails(B: CityBatches) {
    const white = rgb(0xE8E4D8);
    const depth = 3.2;
    for (let ix = 0; ix <= gridSize; ix++) {
        for (let iz = 0; iz <= gridSize; iz++) {
            const x = roadLineCenter(ix, 'x');
            const z = roadLineCenter(iz, 'z');
            const y = getTerrainHeight(x, z) + Y_MARK;
            const bar = (cx: number, cz: number, lx: number, lz: number) => {
                B.markings.add(quad([cx - lx / 2, y, cz + lz / 2], [cx + lx / 2, y, cz + lz / 2], [cx + lx / 2, y, cz - lz / 2], [cx - lx / 2, y, cz - lz / 2]), null, white);
            };
            for (const side of [-1, 1]) {
                const center = side * (HALF_ROAD + 0.6 + depth / 2);
                for (let s = -HALF_ROAD + 0.8; s <= HALF_ROAD - 0.8 + 1e-6; s += 1.2) {
                    bar(x + s, z + center, 0.55, depth);
                    bar(x + center, z + s, depth, 0.55);
                }
                // Stop lines on the lane that drives towards the intersection
                const stop = side * (HALF_ROAD + 0.6 + depth + 1.0);
                bar(x + side * HALF_ROAD / 2, z + stop, HALF_ROAD - 0.6, 0.45);
                bar(x + stop, z - side * HALF_ROAD / 2, 0.45, HALF_ROAD - 0.6);
            }
        }
    }
}

// Paved blocks with an alley cross; the pavement is cut around the alleys so
// no two flat layers overlap
function createBlockSurfaces(B: CityBatches) {
    const tints = [0xF3EADC, 0xEFE4D2, 0xE9E4DA, 0xF1E2D4].map(rgb);
    const half = (blockSize - 2) / 2;
    const alley = 1.05;
    for (let bx = 0; bx < gridSize; bx++) {
        for (let bz = 0; bz < gridSize; bz++) {
            if ((bx === PLAZA_BLOCK.x && bz === PLAZA_BLOCK.z) ||
                (bx === PARK_BLOCK.x && bz === PARK_BLOCK.z)) continue;
            const center = blockCenter(bx, bz);
            const ground = getTerrainHeight(center.x, center.z);
            const tint = tints[(bx + bz * 2) % tints.length];
            const pave = (x0: number, x1: number, z0: number, z1: number, batch: Batch, color: RGB, dy: number, uv: number) => {
                const y = ground + dy;
                batch.add(quad([center.x + x0, y, center.z + z1], [center.x + x1, y, center.z + z1], [center.x + x1, y, center.z + z0], [center.x + x0, y, center.z + z0]), null, color, { box: uv });
            };
            for (const [x0, x1] of [[-half, -alley], [alley, half]]) {
                for (const [z0, z1] of [[-half, -alley], [alley, half]]) pave(x0, x1, z0, z1, B.sidewalk, tint, Y_BLOCK, 2.5);
            }
            // Alleys (clean asphalt look: the road wear stays on the roads)
            pave(-half, half, -alley, alley, B.asphalt, [0.9, 0.9, 0.9], Y_BLOCK + 0.004, 3);
            pave(-alley, alley, -half, -alley, B.asphalt, [0.9, 0.9, 0.9], Y_BLOCK + 0.004, 3);
            pave(-alley, alley, alley, half, B.asphalt, [0.9, 0.9, 0.9], Y_BLOCK + 0.004, 3);
        }
    }
}

// --- Buildings ----------------------------------------------------------------------

type Side = '+x' | '-x' | '+z' | '-z';

interface Wall {
    // Left and right end seen from outside, outward normal
    a: [number, number];
    c: [number, number];
    n: [number, number];
}

function wallsOf(x0: number, x1: number, z0: number, z1: number): Record<Side, Wall> {
    return {
        '+x': { a: [x1, z1], c: [x1, z0], n: [1, 0] },
        '-x': { a: [x0, z0], c: [x0, z1], n: [-1, 0] },
        '+z': { a: [x0, z1], c: [x1, z1], n: [0, 1] },
        '-z': { a: [x1, z0], c: [x0, z0], n: [0, -1] }
    };
}

function tintOf(color: number): RGB {
    return rgb(TINTS[color] ?? color);
}

function createBuildings(B: CityBatches, buildings: BuildingData[]) {
    let blockIndex = -1;
    let lastBlock = '';
    buildings.forEach(building => {
        // Which block (for the shop fronts: one every other block)
        const bxIndex = Math.round((building.x - blockCenter(0, 0).x) / (blockSize + roadWidth));
        const bzIndex = Math.round((building.z - blockCenter(0, 0).z) / (blockSize + roadWidth));
        const blockKey = `${bxIndex},${bzIndex}`;
        const firstInBlock = blockKey !== lastBlock;
        if (firstInBlock) {
            blockIndex++;
            lastBlock = blockKey;
        }
        const center = blockCenter(bxIndex, bzIndex);
        const shopSlot = firstInBlock && (bxIndex + bzIndex) % 2 === 0 ? blockIndex % 4 : -1;
        addBuilding(B, building, center, shopSlot);

        // Add as a rectangular (AABB) obstacle so collision matches the actual
        // building footprint instead of an undersized circle fit.
        state.obstacles.push({
            type: 'rect',
            x: building.x,
            z: building.z,
            halfWidth: building.width / 2,
            halfDepth: building.depth / 2,
            top: COLLIDER_TOPS.building
        });
    });
}

function addBuilding(B: CityBatches, building: BuildingData, blockMid: { x: number; z: number }, shopSlot: number) {
    const hash = (salt: number) => positionHash(building.x, building.z, salt);
    const x0 = building.x - building.width / 2, x1 = building.x + building.width / 2;
    const z0 = building.z - building.depth / 2, z1 = building.z + building.depth / 2;
    const base = getTerrainHeight(building.x, building.z);
    const H = building.height;
    const top = base + H;
    const T = tintOf(building.color);
    const Tr = scaleRgb(T, 0.86);
    const walls = wallsOf(x0, x1, z0, z1);
    // The faces towards the roads around the block
    const streetX: Side = building.x >= blockMid.x ? '+x' : '-x';
    const streetZ: Side = building.z >= blockMid.z ? '+z' : '-z';
    const shopSide: Side = streetZ;

    // Storeys: a taller ground floor, the rest shares the height
    const floors = Math.max(1, Math.round(H / 3.6));
    const groundHeight = floors === 1 ? H : Math.min(4.2, (H / floors) * 1.15);
    const upperHeight = floors === 1 ? 0 : (H - groundHeight) / (floors - 1);
    const groundBand = hash(3) < 0.5 ? 2 : 3;
    const upperBand = hash(4) < 0.55 ? 0 : 1;
    const shift = Math.floor(hash(5) * 3) / 3;
    const awnings = hash(6) < 0.4 && floors > 1 ? AWNING_COLORS[Math.floor(hash(7) * AWNING_COLORS.length)].map(rgb) : null;

    for (const side of Object.keys(walls) as Side[]) {
        const wall = walls[side];
        const length = Math.hypot(wall.c[0] - wall.a[0], wall.c[1] - wall.a[1]);
        const [nx, nz] = wall.n;
        const P = (t: number, y: number, d = 0): [number, number, number] =>
            [wall.a[0] + (wall.c[0] - wall.a[0]) * t + nx * d, y, wall.a[1] + (wall.c[1] - wall.a[1]) * t + nz * d];
        // Whole window axes, stretched a little to fit the wall
        const axes = Math.max(1, Math.round(length / AXIS));
        const u0 = PIER_U + shift, u1 = u0 + axes / 3;
        for (let floor = 0; floor < floors; floor++) {
            const ya = base + (floor === 0 ? 0 : groundHeight + (floor - 1) * upperHeight);
            const yb = floor === 0 ? base + groundHeight : ya + upperHeight;
            const band = floor === 0 ? groundBand : (floor % 2 === 1 ? upperBand : 0);
            const [va, vb] = bandV(band);
            B.facade.add(quad(P(0, ya), P(1, ya), P(1, yb), P(0, yb), [[u0, va], [u1, va], [u1, vb], [u0, vb]]), null, T);
        }
        // String course over the ground floor
        const ledge = (y: number, h: number, out: number) => {
            const cx = (wall.a[0] + wall.c[0]) / 2 + nx * out / 2, cz = (wall.a[1] + wall.c[1]) / 2 + nz * out / 2;
            const w = length + out * 2;
            B.stucco.box(nx ? out : w, h, nx ? w : out, cx, y + h / 2, cz, T, { box: 2 });
        };
        if (floors > 1) ledge(base + groundHeight - 0.1, 0.2, 0.12);

        // Shop front decal on the street side of every other block
        if (shopSlot >= 0 && side === shopSide && length > 8) {
            const w = Math.min(9.4, length - 1.4), h = w / 2;
            const visible = Math.min(h, groundHeight - 0.2);
            const t0 = 0.5 - (w / 2) / length, t1 = 0.5 + (w / 2) / length;
            const Q = (t: number, yy: number) => P(t, yy, 0.035);
            const [ua, va] = ([[0, 0.5], [0.5, 0.5], [0, 0], [0.5, 0]] as const)[shopSlot];
            const ub = ua + 0.5;
            const vTop = va + 0.5 * Math.min(1, visible / h);
            B.storefront.add(quad(Q(t0, base), Q(t1, base), Q(t1, base + visible), Q(t0, base + visible),
                [[ua + 0.001, va + 0.001], [ub - 0.001, va + 0.001], [ub - 0.001, vTop - 0.001], [ua + 0.001, vTop - 0.001]]));
        }
        // Striped awnings over the ground floor window axes on the street sides
        if (awnings && (side === streetX || side === streetZ)) {
            for (let k = 0; k < axes; k++) {
                const t = (k + 0.5) / axes;
                const along = t * length;
                if (along < 1.6 || along > length - 1.6) continue;
                if (shopSlot >= 0 && side === shopSide && Math.abs(along - length / 2) < Math.min(9.4, length - 1.4) / 2 + 1) continue;
                awning(B, P, length, t, base + Math.min(groundHeight, 4.0) - 0.45, nx, nz, awnings as unknown as [RGB, RGB]);
            }
        }
    }

    // Roof
    const cx = building.x, cz = building.z, w = building.width, d = building.depth;
    const R = rng(Math.floor(Math.abs(cx * 13 + cz * 7)) + 11);
    B.stucco.box(w + 0.3, 0.26, d + 0.3, cx, top - 0.05, cz, T, { box: 2 });
    const hip = H < 17 ? hash(8) < 0.7 : hash(8) < 0.3;
    if (hip) {
        const o = 0.62;
        hipRoof(B, x0 - o, x1 + o, z0 - o, z1 + o, top + 0.08, Math.min(w, d) * (0.26 + R() * 0.06));
        eaves(B, x0 - o, x1 + o, z0 - o, z1 + o, x0, x1, z0, z1, top + 0.08, Tr);
        if (R() < 0.35) chimney(B, cx + (R() - 0.5) * w * 0.4, cz + (R() - 0.5) * d * 0.4, top + Math.min(w, d) * 0.2 + 0.9, T);
    } else {
        B.gravel.box(w - 0.1, 0.1, d - 0.1, cx, top + 0.1, cz, [0.95, 0.88, 0.78], { box: 4 });
        const ph = 0.95, pt = 0.25;
        B.stucco.box(w, ph, pt, cx, top + ph / 2, z0 + pt / 2, T, { box: 2 });
        B.stucco.box(w, ph, pt, cx, top + ph / 2, z1 - pt / 2, T, { box: 2 });
        B.stucco.box(pt, ph, d - 2 * pt, x0 + pt / 2, top + ph / 2, cz, T, { box: 2 });
        B.stucco.box(pt, ph, d - 2 * pt, x1 - pt / 2, top + ph / 2, cz, T, { box: 2 });
        // Terracotta coping
        const ct = 0.4, ch = 0.09, y = top + ph + ch / 2;
        B.tiles.box(w + 0.08, ch, ct, cx, y, z0 + pt / 2, [1, 1, 1], { box: 1.2 });
        B.tiles.box(w + 0.08, ch, ct, cx, y, z1 - pt / 2, [1, 1, 1], { box: 1.2 });
        B.tiles.box(ct, ch, d, x0 + pt / 2, y, cz, [1, 1, 1], { box: 1.2 });
        B.tiles.box(ct, ch, d, x1 - pt / 2, y, cz, [1, 1, 1], { box: 1.2 });
        // Mission style tiled visor on the street sides of lower buildings
        if (H < 14 && hash(9) < 0.5) {
            for (const side of [streetX, streetZ]) visor(B, walls[side], top + ph, Tr);
        }
        // A few air conditioning units
        const units = hash(10) < 0.45 ? 1 + Math.floor(hash(11) * 2) : 0;
        for (let i = 0; i < units; i++) {
            const ax = cx + (R() - 0.5) * w * 0.4, az = cz + (R() - 0.5) * d * 0.4, sw = 1.0 + R() * 0.6;
            B.props.box(sw, 0.8 + R() * 0.3, 0.9 + R() * 0.4, ax, top + 0.55, az, AC_CASING);
            B.props.box(sw * 0.7, 0.06, 0.6, ax, top + 1.0, az, AC_GRILLE);
        }
    }
}

function eaves(B: CityBatches, X0: number, X1: number, Z0: number, Z1: number, x0: number, x1: number, z0: number, z1: number, y: number, color: RGB) {
    // Soffit ring from the wall to the eave edge, and the fascia board
    const down: [number, number, number] = [0, -1, 0];
    const soffit = scaleRgb(color, 0.78);
    const fascia = rgb(0x6B4A35);
    B.stucco.add(orientedQuad([X0, y, Z0], [X1, y, Z0], [x1, y, z0], [x0, y, z0], down), null, soffit, { box: 2 });
    B.stucco.add(orientedQuad([X1, y, Z1], [X0, y, Z1], [x0, y, z1], [x1, y, z1], down), null, soffit, { box: 2 });
    B.stucco.add(orientedQuad([X0, y, Z1], [X0, y, Z0], [x0, y, z0], [x0, y, z1], down), null, soffit, { box: 2 });
    B.stucco.add(orientedQuad([X1, y, Z0], [X1, y, Z1], [x1, y, z1], [x1, y, z0], down), null, soffit, { box: 2 });
    const fh = 0.16;
    B.stucco.add(orientedQuad([X0, y - fh, Z0], [X1, y - fh, Z0], [X1, y, Z0], [X0, y, Z0], [0, 0, -1]), null, fascia, { box: 2 });
    B.stucco.add(orientedQuad([X0, y - fh, Z1], [X1, y - fh, Z1], [X1, y, Z1], [X0, y, Z1], [0, 0, 1]), null, fascia, { box: 2 });
    B.stucco.add(orientedQuad([X0, y - fh, Z0], [X0, y - fh, Z1], [X0, y, Z1], [X0, y, Z0], [-1, 0, 0]), null, fascia, { box: 2 });
    B.stucco.add(orientedQuad([X1, y - fh, Z0], [X1, y - fh, Z1], [X1, y, Z1], [X1, y, Z0], [1, 0, 0]), null, fascia, { box: 2 });
}

function visor(B: CityBatches, wall: Wall, y: number, color: RGB) {
    // Sloped tile band in front of the parapet: 1.1 m out, 0.45 m drop
    const out = 1.1, drop = 0.45, [nx, nz] = wall.n;
    const a0: [number, number, number] = [wall.a[0], y, wall.a[1]], c0: [number, number, number] = [wall.c[0], y, wall.c[1]];
    const a1: [number, number, number] = [wall.a[0] + nx * out, y - drop, wall.a[1] + nz * out];
    const c1: [number, number, number] = [wall.c[0] + nx * out, y - drop, wall.c[1] + nz * out];
    const length = Math.hypot(wall.c[0] - wall.a[0], wall.c[1] - wall.a[1]), slope = Math.hypot(out, drop), S = 1.3;
    B.tiles.add(orientedQuad(a1, c1, c0, a0, [nx * 0.4, 1, nz * 0.4], [[0, 0], [length / S, 0], [length / S, slope / S], [0, slope / S]]), null, [1, 1, 1]);
    B.stucco.add(orientedQuad(a1, c1, [c0[0], y - drop, c0[2]], [a0[0], y - drop, a0[2]], [0, -1, 0]), null, scaleRgb(color, 0.78), { box: 2 });
}

function chimney(B: CityBatches, x: number, z: number, top: number, color: RGB) {
    B.stucco.box(0.7, 2.0, 0.7, x, top - 1.0, z, color, { box: 2 });
    B.tiles.box(0.95, 0.12, 0.95, x, top + 0.06, z, [1, 1, 1], { box: 1 });
    B.tiles.box(0.5, 0.2, 0.5, x, top + 0.22, z, [0.8, 0.8, 0.8], { box: 1 });
}

function awning(B: CityBatches, P: (t: number, y: number, d?: number) => [number, number, number], length: number, t: number, yTop: number, nx: number, nz: number, colors: [RGB, RGB]) {
    const W = 2.7, D = 1.25, drop = 0.6, valance = 0.3, stripes = 12;
    const tA = t - (W / 2) / length;
    for (let i = 0; i < stripes; i++) {
        const ta = tA + (i / stripes) * (W / length), tb = tA + ((i + 1) / stripes) * (W / length);
        const pa = P(ta, yTop), pb = P(tb, yTop);
        const oa: [number, number, number] = [pa[0] + nx * D, yTop - drop, pa[2] + nz * D];
        const ob: [number, number, number] = [pb[0] + nx * D, yTop - drop, pb[2] + nz * D];
        const color = colors[i % 2];
        B.fabric.add(quad(oa, ob, pb, pa), null, color);
        B.fabric.add(quad([oa[0], oa[1] - valance, oa[2]], [ob[0], ob[1] - valance, ob[2]], ob, oa), null, color);
    }
}

function hipRoof(B: CityBatches, x0: number, x1: number, z0: number, z1: number, y: number, h: number) {
    const w = x1 - x0, d = z1 - z0;
    const alongX = w >= d;
    const inset = (alongX ? d : w) / 2;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const r0: [number, number, number] = alongX ? [x0 + inset, y + h, cz] : [cx, y + h, z0 + inset];
    const r1: [number, number, number] = alongX ? [x1 - inset, y + h, cz] : [cx, y + h, z1 - inset];
    const c00: [number, number, number] = [x0, y, z0], c10: [number, number, number] = [x1, y, z0];
    const c11: [number, number, number] = [x1, y, z1], c01: [number, number, number] = [x0, y, z1];
    const S = 1.3; // tile scale
    const slope = Math.hypot(h, inset);
    const face = (a: [number, number, number], b: [number, number, number], top1: [number, number, number], top0: [number, number, number]) => {
        const ex = Math.hypot(b[0] - a[0], b[2] - a[2]);
        const dx = (b[0] - a[0]) / ex, dz = (b[2] - a[2]) / ex;
        const uv = (p: [number, number, number]): [number, number] =>
            [((p[0] - a[0]) * dx + (p[2] - a[2]) * dz) / S, ((p[1] - y) / h) * slope / S];
        B.tiles.add(quad(a, b, top1, top0, [uv(a), uv(b), uv(top1), uv(top0)]), null, [1, 1, 1]);
    };
    if (alongX) {
        face(c01, c11, r1, r0);
        face(c10, c00, r0, r1);
        face(c11, c10, r1, r1);
        face(c00, c01, r0, r0);
    } else {
        face(c11, c10, r0, r1);
        face(c00, c01, r1, r0);
        face(c01, c11, r1, r1);
        face(c10, c00, r0, r0);
    }
    // Ridge tiles
    const ridge = Math.hypot(r1[0] - r0[0], r1[2] - r0[2]);
    if (ridge > 0.1) B.tiles.box(alongX ? ridge : 0.22, 0.12, alongX ? 0.22 : ridge, (r0[0] + r1[0]) / 2, y + h + 0.04, (r0[2] + r1[2]) / 2, [0.85, 0.85, 0.85], { box: 1 });
}

// --- Park ---------------------------------------------------------------------------

function createPark(B: CityBatches, extras: CityExtras) {
    const { x: parkX, z: parkZ } = blockCenter(PARK_BLOCK.x, PARK_BLOCK.z);
    const terrainY = getTerrainHeight(parkX, parkZ);
    const half = (blockSize - 2) / 2;
    const path = 1.6;
    const pondRadius = 5.2;

    // Lawn in four quadrants around a cross of decomposed granite paths
    // with concrete edging
    const flat = (batch: Batch, x0: number, x1: number, z0: number, z1: number, dy: number, color: RGB, uv: number) => {
        const y = terrainY + dy;
        batch.add(quad([parkX + x0, y, parkZ + z1], [parkX + x1, y, parkZ + z1], [parkX + x1, y, parkZ + z0], [parkX + x0, y, parkZ + z0]), null, color, { box: uv });
    };
    for (const [x0, x1] of [[-half, -path], [path, half]]) {
        for (const [z0, z1] of [[-half, -path], [path, half]]) flat(B.lawn, x0, x1, z0, z1, 0.03, [0.78, 0.95, 0.66], 2);
    }
    flat(B.sand, -half, half, -path, path, 0.04, [1, 0.94, 0.86], 5);
    flat(B.sand, -path, path, -half, -path, 0.04, [1, 0.94, 0.86], 5);
    flat(B.sand, -path, path, path, half, 0.04, [1, 0.94, 0.86], 5);
    const edging = (x0: number, x1: number, z0: number, z1: number) => {
        const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
        B.sidewalk.box(Math.max(0.14, x1 - x0), 0.08, Math.max(0.14, z1 - z0), parkX + cx, terrainY + 0.04, parkZ + cz, rgb(0xDDD6CA), { box: 2.5 });
    };
    for (const side of [-1, 1]) {
        const e = side * (path + 0.07);
        for (const [a0, a1] of [[-half, -pondRadius - 0.6], [pondRadius + 0.6, half]]) {
            edging(a0, a1, e, e);
            edging(e, e, a0, a1);
        }
    }

    // Reflecting pond with a moulded stone coping at the centre of Palm Park
    B.pond.add(new THREE.CircleGeometry(pondRadius, 48).rotateX(-Math.PI / 2).translate(parkX, terrainY + 0.09, parkZ));
    addPondRim(B.stucco, parkX, terrainY, parkZ, lightingTier());

    // Benches facing the pond (and two trash cans) inside the bench colliders
    parkBenches().forEach(bench => {
        state.obstacles.push({ x: bench.x, z: bench.z, radius: BENCH_COLLIDER_RADIUS, top: COLLIDER_TOPS.bench });
    });
    extras.furniture.push(...parkFurniture().map(toSpot));

    // Canary Island date palms on the four tree spots (same colliders)
    const parkTreePositions = [
        { x: parkX - 13, z: parkZ - 13 },
        { x: parkX + 13, z: parkZ - 13 },
        { x: parkX - 13, z: parkZ + 13 },
        { x: parkX + 13, z: parkZ + 13 }
    ];
    parkTreePositions.forEach(pos => {
        extras.palms.push({
            kind: 'date',
            x: pos.x,
            y: getTerrainHeight(pos.x, pos.z),
            z: pos.z,
            scale: 0.95 + positionHash(pos.x, pos.z, 91) * 0.25,
            yaw: positionHash(pos.x, pos.z, 92) * Math.PI * 2
        });
        state.obstacles.push({ x: pos.x, z: pos.z, radius: 1, top: COLLIDER_TOPS.parkTree });
    });

    // Flower beds: bougainvillea shrubs on a ring of soil with a stone edge
    const R = rng(0xf10e);
    const flowerPositions = [
        { x: parkX - 9, z: parkZ },
        { x: parkX + 9, z: parkZ },
        { x: parkX, z: parkZ - 9 },
        { x: parkX, z: parkZ + 9 }
    ];
    flowerPositions.forEach((pos, index) => {
        B.props.add(new THREE.CylinderGeometry(1.7, 1.75, 0.12, 24).translate(pos.x, terrainY + 0.06, pos.z), FINISH.soil);
        B.props.add(new THREE.TorusGeometry(1.76, 0.07, 5, 28).rotateX(Math.PI / 2).translate(pos.x, terrainY + 0.08, pos.z), FINISH.concrete);
        for (let k = 0; k < 3; k++) {
            const a = (k / 3) * Math.PI * 2 + index;
            addShrub(B.shrub, R, pos.x + Math.cos(a) * 0.7, terrainY + 0.1, pos.z + Math.sin(a) * 0.7, 1.4 + R() * 0.4, index % 2 === 0 ? 0 : 1);
        }
    });

    state.obstacles.push({ x: parkX, z: parkZ, radius: 5.7, top: COLLIDER_TOPS.pond });
}

// --- Plaza --------------------------------------------------------------------------

function createPlaza(B: CityBatches, extras: CityExtras) {
    const { x: plazaX, z: plazaZ } = blockCenter(PLAZA_BLOCK.x, PLAZA_BLOCK.z);
    const terrainAtFountain = getTerrainHeight(plazaX, plazaZ);
    const outer = (blockSize - 2) / 2;
    const inner = (blockSize - 4) / 2;
    const tier = lightingTier();

    // Concrete frame around a field of terracotta pavers (the tiles come
    // from the pavers shader; software WebGL draws them in one mean color)
    const flat = (batch: Batch, x0: number, x1: number, z0: number, z1: number, dy: number, color: RGB) => {
        const y = terrainAtFountain + dy;
        batch.add(quad([plazaX + x0, y, plazaZ + z1], [plazaX + x1, y, plazaZ + z1], [plazaX + x1, y, plazaZ + z0], [plazaX + x0, y, plazaZ + z0]), null, color, { box: 2.5 });
    };
    flat(B.sidewalk, -outer, outer, -outer, -inner, 0.031, CONCRETE);
    flat(B.sidewalk, -outer, outer, inner, outer, 0.031, CONCRETE);
    flat(B.sidewalk, -outer, -inner, -inner, inner, 0.031, CONCRETE);
    flat(B.sidewalk, inner, outer, -inner, inner, 0.031, CONCRETE);
    flat(B.pavers, -inner, inner, -inner, inner, 0.031, tier === 'software' ? rgb(0xD2A07E) : [1, 1, 1]);

    // Central fountain: stone basin and pedestal (merged), water meshes
    extras.water.push(...buildFountain(B.stucco, worldMaterials(), plazaX, terrainAtFountain, plazaZ, tier));

    const planterOffset = PLAZA_PROP_LAYOUT.planterOffset;
    const cornerOffsets = [
        { x: -planterOffset, z: -planterOffset }, { x: planterOffset, z: -planterOffset },
        { x: -planterOffset, z: planterOffset }, { x: planterOffset, z: planterOffset }
    ];
    const R = rng(0x91a2);
    const segments = tier === 'desktop' ? 28 : 16;
    cornerOffsets.forEach((offset, index) => {
        const planterX = plazaX + offset.x;
        const planterZ = plazaZ + offset.z;
        const y = terrainAtFountain + 0.04;
        // Terracotta pot with a rolled rim, on a low plinth, filled with soil
        B.props.add(lathe([[1.2, 0], [1.24, 0.05], [1.32, 0.35], [1.42, 0.78], [1.47, 0.84], [1.52, 0.9], [1.52, 1.0], [1.46, 1.04], [1.39, 1.0], [1.37, 0.9]], segments)
            .translate(planterX, y, planterZ), FINISH.terracotta);
        B.props.add(new THREE.CylinderGeometry(1.37, 1.37, 0.02, segments).translate(planterX, y + 0.93, planterZ), FINISH.soil);
        addShrub(B.shrub, R, planterX, y + 0.9, planterZ, 2.6, 1);
        addShrub(B.shrub, R, planterX + 0.3, y + 0.9, planterZ - 0.2, 1.6, 0);
        state.obstacles.push({ x: planterX, z: planterZ, radius: PLAZA_PROP_LAYOUT.planterRadius, top: COLLIDER_TOPS.planter });

        // Market parasol: weighted base, wooden pole, octagonal canopy with
        // ribs and a valance
        const parasolX = plazaX + Math.sign(offset.x) * PLAZA_PROP_LAYOUT.parasolOffset;
        const parasolZ = plazaZ + Math.sign(offset.z) * PLAZA_PROP_LAYOUT.parasolOffset;
        const at = (g: THREE.BufferGeometry) => g.translate(parasolX, y, parasolZ);
        B.props.add(at(lathe([[0.36, 0], [0.36, 0.05], [0.3, 0.1], [0.12, 0.14], [0.06, 0.2]], 12)), FINISH.castIron);
        B.props.add(at(new THREE.CylinderGeometry(0.04, 0.045, 3.1, 8).translate(0, 1.6, 0)), FINISH.wood);
        B.props.add(at(new THREE.SphereGeometry(0.06, 8, 5).translate(0, 3.2, 0)), FINISH.wood);
        for (let k = 0; k < 8; k++) {
            const a = (k / 8) * Math.PI * 2;
            const rib = new THREE.CylinderGeometry(0.012, 0.012, 2.05, 4).rotateZ(Math.PI / 2 - 0.2).translate(1.0, 2.93, 0).rotateY(-a);
            B.props.add(at(rib), FINISH.canvasPole);
        }
        const color = rgb(PARASOL_COLORS[index]);
        B.fabric.add(at(lathe([[2.08, 2.66], [1.6, 2.86], [0.9, 3.04], [0.3, 3.14], [0.02, 3.17]], 8)), null, color);
        B.fabric.add(at(new THREE.CylinderGeometry(2.08, 2.08, 0.2, 8, 1, true).translate(0, 2.57, 0)), null, scaleRgb(color, 0.92));
        state.obstacles.push({ x: parasolX, z: parasolZ, radius: PLAZA_PROP_LAYOUT.parasolRadius, top: COLLIDER_TOPS.parasol });
    });

    // Fountain as obstacle
    state.obstacles.push({ x: plazaX, z: plazaZ, radius: 5, top: COLLIDER_TOPS.fountain });
}

// --- Street lights, signals and palms --------------------------------------------------

function createStreetDetails(extras: CityExtras) {
    // Street lights on two corners of every block; at the crossings with a
    // post on each corner they are traffic signal mast arms (streetLayout.ts)
    const posts = streetPosts();
    for (const post of posts) state.obstacles.push({ x: post.x, z: post.z, radius: LAMP_COLLIDER_RADIUS, top: COLLIDER_TOPS.lamp });
    extras.furniture.push(...streetFurniture(posts).map(toSpot));

    // A palm-lined central boulevard anchors the California identity and is
    // visible from most blocks, making orientation much easier at speed.
    const boulevardX = roadLineCenter(Math.floor(gridSize / 2), 'x');
    for (let bz = 0; bz < gridSize; bz++) {
        const z = blockCenter(0, bz).z;
        addPalm(extras, boulevardX - roadWidth / 2 - 2.2, z, 200 + bz);
        addPalm(extras, boulevardX + roadWidth / 2 + 2.2, z, 220 + bz);
    }
}

function addPalm(extras: CityExtras, x: number, z: number, salt: number) {
    const size = positionHash(x, z, salt);
    extras.palms.push({
        kind: positionHash(x, z, salt + 2) < 0.75 ? 'fan' : 'date',
        x,
        y: getTerrainHeight(x, z),
        z,
        scale: 0.85 + size * 0.3,
        yaw: positionHash(x, z, salt + 1) * Math.PI * 2
    });
    state.obstacles.push({ x, z, radius: 1.0, top: COLLIDER_TOPS.palm });
}

// --- District signs -------------------------------------------------------------------

const SIGN_LABELS = [
    { label: 'SUNSET PLAZA', accent: '#c98a2e' },
    { label: 'PALM PARK', accent: '#5f8f5a' }
];

let signTexture: THREE.CanvasTexture | null = null;

// Powder coated steel frame and posts of the district signs
const SIGN_FRAME: Finish = { color: rgb(0x2A3A3D), rough: 0.45, metal: 0.3 };
const SIGN_POST: Finish = { color: rgb(0x3B4A4D), rough: 0.42, metal: 0.3 };

// Both signs in one canvas (one material): enamel boards with a thin border
function signMaterial(): THREE.Material {
    if (!signTexture) {
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 256;
        const ctx = canvas.getContext('2d');
        if (ctx) {
            SIGN_LABELS.forEach(({ label, accent }, row) => {
                const y = row * 128;
                ctx.fillStyle = '#1f3438';
                ctx.fillRect(0, y, 512, 128);
                ctx.strokeStyle = accent;
                ctx.lineWidth = 8;
                ctx.strokeRect(10, y + 10, 492, 108);
                ctx.fillStyle = '#f3ecdc';
                ctx.font = '700 50px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(label, 256, y + 66);
            });
        }
        signTexture = new THREE.CanvasTexture(canvas);
        signTexture.colorSpace = THREE.SRGBColorSpace;
        signTexture.anisotropy = 4;
    }
    return new THREE.MeshStandardMaterial({ map: signTexture, roughness: 0.45, metalness: 0.1 });
}

function createDistrictSigns(B: CityBatches) {
    function addSign(row: number, x: number, z: number, rotation: number) {
        const ground = getTerrainHeight(x, z);
        const matrix = new THREE.Matrix4().makeRotationY(rotation).setPosition(x, ground, z);
        // UV rows: canvas row 0 is the top half (v 0.5..1)
        const v0 = row === 0 ? 0.5 : 0, v1 = v0 + 0.5;
        const uv: [number, number][] = [[0, v0], [1, v0], [1, v1], [0, v1]];
        const w = 7.4, h = 1.85, y = 3.9;
        B.signs.add(quad([-w / 2, y - h / 2, 0.03], [w / 2, y - h / 2, 0.03], [w / 2, y + h / 2, 0.03], [-w / 2, y + h / 2, 0.03], uv), matrix);
        B.signs.add(quad([w / 2, y - h / 2, -0.03], [-w / 2, y - h / 2, -0.03], [-w / 2, y + h / 2, -0.03], [w / 2, y + h / 2, -0.03], uv), matrix);
        B.props.add(new THREE.BoxGeometry(w + 0.1, h + 0.1, 0.05).translate(0, y, 0), SIGN_FRAME, matrix);

        for (const postX of [-2.6, 2.6]) {
            B.props.add(new THREE.CylinderGeometry(0.1, 0.13, 3.3, 8).translate(postX, 1.65, 0), SIGN_POST, matrix);
            state.obstacles.push({
                x: x + Math.cos(rotation) * postX,
                z: z - Math.sin(rotation) * postX,
                radius: 0.35,
                top: COLLIDER_TOPS.signPost
            });
        }
    }

    const plaza = blockCenter(PLAZA_BLOCK.x, PLAZA_BLOCK.z);
    const park = blockCenter(PARK_BLOCK.x, PARK_BLOCK.z);
    addSign(0, plaza.x, plaza.z - blockSize / 2 + 2.1, 0);
    addSign(1, park.x, park.z - blockSize / 2 + 2.1, 0);
}
