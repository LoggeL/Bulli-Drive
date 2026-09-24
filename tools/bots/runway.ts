// A free straight stretch of road for scripted bumps (the bot integration
// test and the e2e tests): the longest line x = const on a north-south road
// that no collider blocks, driving towards +z. Pure, on the shared
// collider list, so Node and the browser tests pick the same spot.

import { CITY_BOUNDS, CITY_CONFIG, roadLineCenter } from '../../src/shared/world/cityGen.js';
import type { ColliderInput } from '../../src/shared/world/colliders.js';
import { MEGA_SCALE } from '../../src/shared/constants.js';

// Collision radius of the car, grown by the Mega powerup it might pick up
// on the way, plus some room to spare
export const RUNWAY_CLEARANCE = 1.5 * MEGA_SCALE + 1;

export interface Runway {
    x: number;
    z: number;
    // Free length ahead (towards +z, m)
    free: number;
}

/**
 * Free length ahead of a car at (x, z0) driving towards +z until a
 * collider (grown by RUNWAY_CLEARANCE) blocks the line x = const.
 */
export function freeRunway(colliders: readonly ColliderInput[], x: number, z0: number): number {
    let free = CITY_BOUNDS.maxZ - z0;
    for (const obstacle of colliders) {
        let halfAcross: number;
        let halfAlong: number;
        if (obstacle.kind === 'box') {
            halfAcross = obstacle.hw + RUNWAY_CLEARANCE;
            halfAlong = obstacle.hd + RUNWAY_CLEARANCE;
        } else {
            const dx = Math.abs(obstacle.x - x);
            const reach = obstacle.r + RUNWAY_CLEARANCE;
            if (dx >= reach) continue;
            halfAcross = reach;
            halfAlong = Math.sqrt(reach * reach - dx * dx);
        }
        if (Math.abs(obstacle.x - x) >= halfAcross) continue;
        const nearEdge = obstacle.z - halfAlong;
        const farEdge = obstacle.z + halfAlong;
        if (farEdge <= z0) continue;
        if (nearEdge <= z0) return 0;
        free = Math.min(free, nearEdge - z0);
    }
    return free;
}

/**
 * The longest free stretch on the north-south roads (the centre line and
 * both lanes of every road). lane: only this offset from the centre line.
 */
export function longestRunway(colliders: readonly ColliderInput[], lanes?: number[]): Runway {
    let best: Runway = { x: 0, z: 0, free: -1 };
    const laneOffset = CITY_CONFIG.roadWidth / 4;
    for (let line = 0; line <= CITY_CONFIG.gridSize; line++) {
        for (const lane of lanes ?? [-laneOffset, 0, laneOffset]) {
            const x = roadLineCenter(line, 'x') + lane;
            for (let z = CITY_BOUNDS.minZ + 5; z < CITY_BOUNDS.maxZ; z += 2) {
                const free = freeRunway(colliders, x, z);
                if (free > best.free) best = { x, z, free };
            }
        }
    }
    return best;
}
