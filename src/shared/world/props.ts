// Placement of every colliding prop of the city and the scenery as plain
// data (docs/phase-1b-design.md, section 6). The client renders these props
// from exactly these positions and colliderGen.ts turns them into the sim's
// colliders, so what a player sees and what the server collides with cannot
// drift apart. Everything here depends only on the shared layout constants
// and fixed seeds, never on the order in which something is drawn.

import { CITY_LAYOUT, PLAZA_PROP_LAYOUT } from '../constants.js';
import { mulberry32 } from '../math/rng.js';
import { blockCenter, PARK_BLOCK, PLAZA_BLOCK, roadLineCenter } from './cityGen.js';
import { CITY_TERRAIN_AREA } from './terrain.js';

// Collision radii of the round props (the heights are COLLIDER_TOPS in
// colliders.ts). Buildings are boxes of their footprint.
export const PROP_RADII = {
    tree: 1.5,
    bench: 1.7,
    pond: 5.7,
    parkTree: 1,
    palm: 1.0,
    lamp: 0.7,
    signPost: 0.35,
    planter: PLAZA_PROP_LAYOUT.planterRadius,
    parasol: PLAZA_PROP_LAYOUT.parasolRadius,
    fountain: 5,
    // Rocks: radius = rockPerSize × rock size
    rockPerSize: 0.7
} as const;

export interface PropPoint {
    x: number;
    z: number;
}

// ---- Palm Park (the park block in one corner) ----

export interface ParkLayout {
    center: PropPoint;
    // Benches face the pond: rotation = atan2(center - bench)
    benches: Array<PropPoint & { rotation: number }>;
    trees: PropPoint[];
    flowerBeds: PropPoint[];
    pond: PropPoint;
}

export function parkLayout(): ParkLayout {
    const { x: parkX, z: parkZ } = blockCenter(PARK_BLOCK.x, PARK_BLOCK.z);
    const benches = [
        { x: parkX - 9, z: parkZ - 6 },
        { x: parkX + 9, z: parkZ + 6 },
        { x: parkX - 6, z: parkZ + 9 },
        { x: parkX + 6, z: parkZ - 9 }
    ].map(pos => ({ ...pos, rotation: Math.atan2(parkX - pos.x, parkZ - pos.z) }));
    return {
        center: { x: parkX, z: parkZ },
        benches,
        trees: [
            { x: parkX - 13, z: parkZ - 13 },
            { x: parkX + 13, z: parkZ - 13 },
            { x: parkX - 13, z: parkZ + 13 },
            { x: parkX + 13, z: parkZ + 13 }
        ],
        flowerBeds: [
            { x: parkX - 9, z: parkZ },
            { x: parkX + 9, z: parkZ },
            { x: parkX, z: parkZ - 9 },
            { x: parkX, z: parkZ + 9 }
        ],
        pond: { x: parkX, z: parkZ }
    };
}

// ---- Sunset Plaza (the spawn block in the middle) ----

export interface PlazaLayout {
    center: PropPoint;
    // One planter and one parasol per corner, in the same corner order
    planters: PropPoint[];
    parasols: PropPoint[];
    fountain: PropPoint;
}

export function plazaLayout(): PlazaLayout {
    const { x: plazaX, z: plazaZ } = blockCenter(PLAZA_BLOCK.x, PLAZA_BLOCK.z);
    const planterOffset = PLAZA_PROP_LAYOUT.planterOffset;
    const cornerOffsets = [
        { x: -planterOffset, z: -planterOffset }, { x: planterOffset, z: -planterOffset },
        { x: -planterOffset, z: planterOffset }, { x: planterOffset, z: planterOffset }
    ];
    return {
        center: { x: plazaX, z: plazaZ },
        planters: cornerOffsets.map(offset => ({ x: plazaX + offset.x, z: plazaZ + offset.z })),
        parasols: cornerOffsets.map(offset => ({
            x: plazaX + Math.sign(offset.x) * PLAZA_PROP_LAYOUT.parasolOffset,
            z: plazaZ + Math.sign(offset.z) * PLAZA_PROP_LAYOUT.parasolOffset
        })),
        fountain: { x: plazaX, z: plazaZ }
    };
}

// ---- Street furniture ----

// Two lamps per block on opposite corners, alternating the diagonal block
// by block; rotation turns the lamp arm towards the block centre.
export function streetLights(): Array<PropPoint & { rotation: number }> {
    const { blockSize, gridSize } = CITY_LAYOUT;
    const cornerOffset = blockSize / 2 - 2.1;
    const lights: Array<PropPoint & { rotation: number }> = [];
    for (let bx = 0; bx < gridSize; bx++) {
        for (let bz = 0; bz < gridSize; bz++) {
            const center = blockCenter(bx, bz);
            const flip = (bx + bz) % 2 === 0;
            const corners = flip
                ? [{ x: -cornerOffset, z: -cornerOffset }, { x: cornerOffset, z: cornerOffset }]
                : [{ x: -cornerOffset, z: cornerOffset }, { x: cornerOffset, z: -cornerOffset }];
            for (const corner of corners) {
                lights.push({
                    x: center.x + corner.x,
                    z: center.z + corner.z,
                    rotation: Math.atan2(-corner.x, -corner.z)
                });
            }
        }
    }
    return lights;
}

// The palm-lined central boulevard: per block row one palm on the west and
// one on the east side of the middle north-south road. salt seeds the
// palm's height and lean (positionHash in the client).
export function boulevardPalms(): Array<PropPoint & { salt: number }> {
    const { roadWidth, gridSize } = CITY_LAYOUT;
    const boulevardX = roadLineCenter(Math.floor(gridSize / 2), 'x');
    const palms: Array<PropPoint & { salt: number }> = [];
    for (let bz = 0; bz < gridSize; bz++) {
        const z = blockCenter(0, bz).z;
        palms.push({ x: boulevardX - roadWidth / 2 - 2.2, z, salt: 200 + bz });
        palms.push({ x: boulevardX + roadWidth / 2 + 2.2, z, salt: 220 + bz });
    }
    return palms;
}

export interface DistrictSign extends PropPoint {
    label: string;
    accent: string;
    rotation: number;
    // Offsets of the two posts along the board (local x)
    postOffsets: number[];
    // World positions of the posts, in the order of postOffsets
    posts: PropPoint[];
}

const SIGN_POST_OFFSETS = [-2.6, 2.6];

function districtSign(label: string, accent: string, x: number, z: number, rotation: number): DistrictSign {
    return {
        label, accent, x, z, rotation,
        postOffsets: [...SIGN_POST_OFFSETS],
        posts: SIGN_POST_OFFSETS.map(postX => ({
            x: x + Math.cos(rotation) * postX,
            z: z - Math.sin(rotation) * postX
        }))
    };
}

export function districtSigns(): DistrictSign[] {
    const plaza = blockCenter(PLAZA_BLOCK.x, PLAZA_BLOCK.z);
    const park = blockCenter(PARK_BLOCK.x, PARK_BLOCK.z);
    return [
        districtSign('SUNSET PLAZA', '#f3a23a', plaza.x, plaza.z - CITY_LAYOUT.blockSize / 2 + 2.1, 0),
        districtSign('PALM PARK', '#6fbd77', park.x, park.z - CITY_LAYOUT.blockSize / 2 + 2.1, 0)
    ];
}

// ---- Scenery outside the city ----

// Rocks only take their position and size from this stream, so changing
// how a rock looks never moves a collider (docs/phase-1b-design.md, 6).
export const ROCK_COLLIDER_SEED = 0x524f434b; // "ROCK"
// Material, rotation, height and the optional second stone of each rock
export const ROCK_VISUAL_SEED = 0x524f4356; // "ROCV"
// Bushes and wildflowers (no colliders)
export const SCENERY_SEED = 0x42554c4c; // "BULL"

const ROCK_ATTEMPTS = 40;
const ROCK_RANGE = 700;
// Rocks at least this big get a collider; smaller ones can be driven over
const ROCK_COLLIDER_MIN_SIZE = 1.2;

// True inside the flattened city footprint, where no scenery grows
export function insideCitySceneryExclusion(x: number, z: number): boolean {
    return Math.abs(x - CITY_TERRAIN_AREA.centerX) < CITY_TERRAIN_AREA.halfExtent &&
        Math.abs(z - CITY_TERRAIN_AREA.centerZ) < CITY_TERRAIN_AREA.halfExtent;
}

export interface RockPlacement extends PropPoint {
    size: number;
    // Big enough to block a car (radius rockPerSize × size)
    collider: boolean;
    // Index of the attempt, the key into the visual stream
    index: number;
}

/**
 * The rocks scattered around the city. Every attempt draws exactly three
 * values (x, z, size), whether the rock is kept or not, so one rock never
 * shifts another.
 */
export function rockPlacements(): RockPlacement[] {
    const random = mulberry32(ROCK_COLLIDER_SEED);
    const rocks: RockPlacement[] = [];
    for (let index = 0; index < ROCK_ATTEMPTS; index++) {
        const x = (random() - 0.5) * ROCK_RANGE;
        const z = (random() - 0.5) * ROCK_RANGE;
        const size = 0.8 + random() * 2.0;
        if (insideCitySceneryExclusion(x, z)) continue;
        rocks.push({ x, z, size, collider: size > ROCK_COLLIDER_MIN_SIZE, index });
    }
    return rocks;
}
