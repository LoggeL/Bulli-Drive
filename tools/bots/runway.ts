// A free straight stretch for scripted bumps and drives (the bot
// integration test and the e2e tests). In Free Roam: the longest line
// x = const along a north-south road of the map, driving towards +z, that
// stays on the road and that no collider blocks. In the Party: the longest
// line z = const across the arena, driving towards +x, clear of the
// containers, ramps and masts, of every pickup and of the arena's border.
// Pure, on the shared map data, so Node and the browser tests pick the
// same spot.

import { MEGA_SCALE } from '../../src/shared/constants.js';
import type { MapData } from '../../src/shared/map/mapData.js';
import { COIN_PICKUP_RADIUS, POWERUP_PICKUP_RADIUS } from '../../src/shared/party/rules.js';
import { roadSurfaceIdAt } from '../../src/shared/map/roadNetwork.js';
import { colliderBounds, type Collider } from '../../src/shared/world/colliders.js';

// Collision radius of the car, grown by the Mega powerup it might pick up
// on the way, plus some room to spare
export const RUNWAY_CLEARANCE = 1.5 * MEGA_SCALE + 1;
// The line is followed in steps of this (m) and may climb at most this
// much per step (a steep road is no place to measure a bump)
const STEP = 2;
const MAX_RISE = 0.3;
// Candidate lines: roads whose tangent is within this of the z axis
const NORTH_SOUTH = 0.02;
// The arena's lines are this far apart (m)
const ARENA_ROW = 0.5;

export interface Runway {
    x: number;
    z: number;
    // Heading of the drive (sim yaw: 0 is +z, π/2 is +x)
    yaw: number;
    // Free length ahead (m)
    free: number;
}

// Colliders as bounding boxes grown by the clearance: [minX, minZ, maxX, maxZ]
function obstacles(colliders: readonly Collider[]): [number, number, number, number][] {
    return colliders.map(collider => {
        const [minX, minZ, maxX, maxZ] = colliderBounds(collider);
        return [minX - RUNWAY_CLEARANCE, minZ - RUNWAY_CLEARANCE, maxX + RUNWAY_CLEARANCE, maxZ + RUNWAY_CLEARANCE];
    });
}

/**
 * Free length ahead of a car at (x, z0) driving towards +z: up to the first
 * collider (its bounding box grown by RUNWAY_CLEARANCE) on the line, or to
 * where the line leaves the road or climbs too steeply.
 */
export function freeRunway(map: MapData, x: number, z0: number, boxes = obstacles(map.simWorld.colliders)): number {
    let limit = Infinity;
    for (const [minX, minZ, maxX, maxZ] of boxes) {
        if (x < minX || x > maxX || maxZ <= z0) continue;
        if (minZ <= z0) return 0;
        limit = Math.min(limit, minZ - z0);
    }
    const ground = map.simWorld.terrainHeight;
    let free = 0;
    while (free < limit) {
        const z = z0 + free + STEP;
        if (roadSurfaceIdAt(map.net, x, z) < 0) break;
        if (Math.abs(ground(x, z) - ground(x, z - STEP)) > MAX_RISE) break;
        free += STEP;
    }
    return Math.min(free, limit);
}

/**
 * The longest free stretch on the north-south roads (Free Roam), on the
 * centre line and both lanes (lanes: only these offsets from the centre
 * line).
 */
const runways = new WeakMap<MapData, Runway>();

export function longestRunway(map: MapData, lanes?: number[]): Runway {
    const cached = lanes ? undefined : runways.get(map);
    if (cached) return cached;
    const boxes = obstacles(map.simWorld.colliders);
    let best: Runway = { x: 0, z: 0, yaw: 0, free: -1 };
    for (const edge of map.net.edges) {
        const offsets = lanes ?? [-edge.halfWidth / 2, 0, edge.halfWidth / 2];
        for (let k = 0; k < edge.samples.length; k += 4) {
            const p = edge.samples[k];
            if (Math.abs(p.tx) > NORTH_SOUTH) continue;
            for (const lane of offsets) {
                const x = Math.round((p.x + lane) * 10) / 10, z = Math.round(p.z);
                const free = freeRunway(map, x, z, boxes);
                if (free > best.free) best = { x, z, yaw: 0, free };
            }
        }
    }
    if (!lanes) runways.set(map, best);
    return best;
}

/**
 * The longest free line across the Party's arena, driving towards +x from
 * its western border: clear of the arena's colliders (grown by
 * RUNWAY_CLEARANCE), of every coin and power-up (by its pickup radius) and
 * of the border.
 */
export function arenaRunway(map: MapData): Runway {
    const world = map.partyWorld;
    const { minX, maxX, minZ, maxZ } = world.border;
    // Clear of the fence on the border (a capsule of 0.15 m) and its clearance
    const x0 = minX + RUNWAY_CLEARANCE + 1;
    const end = maxX - RUNWAY_CLEARANCE - 1;
    const boxes = obstacles(world.colliders).filter(([bx0, bz0, bx1, bz1]) => bx1 > minX && bx0 < maxX && bz1 > minZ && bz0 < maxZ);
    const items = [
        ...map.items.coins.map(c => ({ x: c.x, z: c.z, r: COIN_PICKUP_RADIUS })),
        ...map.items.powerups.map(p => ({ x: p.x, z: p.z, r: POWERUP_PICKUP_RADIUS }))
    ];
    let best: Runway = { x: x0, z: minZ, yaw: Math.PI / 2, free: -1 };
    for (let z = minZ + RUNWAY_CLEARANCE + 1; z <= maxZ - RUNWAY_CLEARANCE - 1; z += ARENA_ROW) {
        let limit = end - x0;
        for (const [bx0, bz0, bx1, bz1] of boxes) {
            if (z < bz0 || z > bz1 || bx1 <= x0) continue;
            limit = Math.min(limit, Math.max(0, bx0 - x0));
        }
        for (const item of items) {
            const dz = Math.abs(item.z - z);
            if (dz >= item.r || item.x + item.r <= x0) continue;
            limit = Math.min(limit, Math.max(0, item.x - Math.sqrt(item.r * item.r - dz * dz) - x0));
        }
        if (limit > best.free) best = { x: x0, z, yaw: Math.PI / 2, free: limit };
    }
    return best;
}
