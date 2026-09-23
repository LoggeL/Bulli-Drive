import { CITY_LAYOUT } from '../../shared/constants.js';
import { positionHash } from '../../shared/math/rng.js';
import { blockCenter, PARK_BLOCK } from '../../shared/world/cityGen.js';
import type { FurnitureKind } from './furniture.js';

// Where the street furniture of the city stands (graphics G1). Pure layout,
// no rendering, so tests can check it (tests/client/streetLayout.test.ts).
//
// The collision layout must not change: lamp posts keep their places and
// colliders; at the five crossings with a post on every corner the posts
// become traffic signal mast arms (the same collider). Hydrants and trash
// cans only stand inside an existing collider (next to a post or a bench),
// so no new obstacle is needed and the car never drives through one.

const { blockSize, roadWidth, gridSize } = CITY_LAYOUT;

export const LAMP_COLLIDER_RADIUS = 0.7;
export const BENCH_COLLIDER_RADIUS = 1.7;

// Distance of a post from both curbs of its block corner
const CORNER_INSET = 2.1;

export interface PostSpot {
    x: number;
    z: number;
    // Rotation of the swan neck lamp (its arm along object +x)
    lampRotation: number;
    // Rotation of the signal mast arm, or null: a plain street light
    signalRotation: number | null;
    // Directions from the post towards its two curbs (unit vectors)
    curbs: [[number, number], [number, number]];
}

/** The street light posts in the order city.ts pushes their colliders. */
export function streetPosts(): PostSpot[] {
    const cornerOffset = blockSize / 2 - CORNER_INSET;
    const posts: (PostSpot & { key: string; rel: [number, number] })[] = [];
    for (let bx = 0; bx < gridSize; bx++) {
        for (let bz = 0; bz < gridSize; bz++) {
            const center = blockCenter(bx, bz);
            const flip = (bx + bz) % 2 === 0;
            const corners = flip
                ? [{ x: -cornerOffset, z: -cornerOffset }, { x: cornerOffset, z: cornerOffset }]
                : [{ x: -cornerOffset, z: cornerOffset }, { x: cornerOffset, z: -cornerOffset }];
            for (const corner of corners) {
                const sx = Math.sign(corner.x), sz = Math.sign(corner.z);
                // The crossing this corner belongs to
                const ix = center.x + sx * (blockSize + roadWidth) / 2;
                const iz = center.z + sz * (blockSize + roadWidth) / 2;
                posts.push({
                    x: center.x + corner.x,
                    z: center.z + corner.z,
                    lampRotation: Math.atan2(-corner.x, -corner.z),
                    signalRotation: null,
                    curbs: [[sx, 0], [0, sz]],
                    key: `${Math.round(ix)},${Math.round(iz)}`,
                    rel: [-sx, -sz]
                });
            }
        }
    }
    // Crossings with a post on all four corners get traffic signals: each
    // corner's mast arm reaches over the lanes of the traffic that arrives
    // from the opposite side (US right hand traffic: the far right corner)
    const perCrossing = new Map<string, number>();
    for (const post of posts) perCrossing.set(post.key, (perCrossing.get(post.key) ?? 0) + 1);
    return posts.map(({ key, rel, ...post }) => {
        if (perCrossing.get(key) !== 4) return post;
        const [rx, rz] = rel;
        // North west: northbound traffic (+z), arm along +x; south east:
        // southbound; north east: eastbound (+x); south west: westbound
        const rotation = rx < 0 && rz > 0 ? 0 : rx > 0 && rz < 0 ? Math.PI : rx > 0 && rz > 0 ? Math.PI / 2 : -Math.PI / 2;
        return { ...post, signalRotation: rotation };
    });
}

export interface FurniturePlacement {
    kind: FurnitureKind;
    x: number;
    z: number;
    rotation: number;
    // The collider the piece stands in
    host: { x: number; z: number; radius: number };
}

// Offsets from the post's axis: clear of the post's foot, inside its collider
const HYDRANT_OFFSET = 0.415;
const CAN_OFFSET = 0.45;

/** Lamps, signal masts and the hydrants and trash cans next to the posts. */
export function streetFurniture(posts: PostSpot[] = streetPosts()): FurniturePlacement[] {
    const placements: FurniturePlacement[] = [];
    for (const post of posts) {
        const host = { x: post.x, z: post.z, radius: LAMP_COLLIDER_RADIUS };
        const signal = post.signalRotation !== null;
        placements.push({ kind: signal ? 'signal' : 'lamp', x: post.x, z: post.z, rotation: signal ? post.signalRotation! : post.lampRotation, host });
        const pick = positionHash(post.x, post.z, 311);
        const [ux, uz] = post.curbs[positionHash(post.x, post.z, 312) < 0.5 ? 0 : 1];
        if (pick < (signal ? 0.35 : 0.4)) {
            // Pumper outlet (object -z) towards the curb, away from the post
            placements.push({ kind: 'hydrant', x: post.x + ux * HYDRANT_OFFSET, z: post.z + uz * HYDRANT_OFFSET, rotation: Math.atan2(-ux, -uz), host });
        } else if (!signal && pick < 0.85) {
            placements.push({ kind: 'trashCan', x: post.x + ux * CAN_OFFSET, z: post.z + uz * CAN_OFFSET, rotation: pick * 20, host });
        }
    }
    return placements;
}

export interface BenchSpot {
    x: number;
    z: number;
    // The bench faces object +z: towards the pond
    rotation: number;
}

/** The four benches around the pond of Palm Park (city.ts pushes their colliders in this order). */
export function parkBenches(): BenchSpot[] {
    const { x: parkX, z: parkZ } = blockCenter(PARK_BLOCK.x, PARK_BLOCK.z);
    return [
        { x: parkX - 9, z: parkZ - 6 },
        { x: parkX + 9, z: parkZ + 6 },
        { x: parkX - 6, z: parkZ + 9 },
        { x: parkX + 6, z: parkZ - 9 }
    ].map(({ x, z }) => ({ x, z, rotation: Math.atan2(parkX - x, parkZ - z) }));
}

// Trash can at the right hand end of a bench (object +x), inside its collider
const BENCH_CAN_OFFSET = 1.33;

/** Benches and the trash cans next to two of them. */
export function parkFurniture(benches: BenchSpot[] = parkBenches()): FurniturePlacement[] {
    const placements: FurniturePlacement[] = [];
    benches.forEach((bench, index) => {
        const host = { x: bench.x, z: bench.z, radius: BENCH_COLLIDER_RADIUS };
        placements.push({ kind: 'bench', x: bench.x, z: bench.z, rotation: bench.rotation, host });
        if (index % 2 === 0) {
            const c = Math.cos(bench.rotation), s = Math.sin(bench.rotation);
            placements.push({ kind: 'trashCan', x: bench.x + c * BENCH_CAN_OFFSET, z: bench.z - s * BENCH_CAN_OFFSET, rotation: index, host });
        }
    });
    return placements;
}
