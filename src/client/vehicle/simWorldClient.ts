import type { TerrainConfig } from '../../shared/protocol.js';
import { cityRoadGrid } from '../../shared/world/cityGen.js';
import { createSimWorld, type ColliderInput, type SimWorld } from '../../shared/world/colliders.js';
import type { Obstacle } from '../types.js';

// The static collision world of the v2 sim, built from the obstacles the
// client placed while building the city and the scenery (state.obstacles).
// In phase 1b the placement moves to shared/world so the server builds the
// same world (docs/phase-1a-design.md, 7.2).

export function obstaclesToColliders(obstacles: readonly Obstacle[]): ColliderInput[] {
    return obstacles.map((obstacle): ColliderInput => {
        const top = obstacle.top ?? Infinity;
        if (obstacle.type === 'rect') {
            return { kind: 'box', x: obstacle.x, z: obstacle.z, hw: obstacle.halfWidth, hd: obstacle.halfDepth, top };
        }
        return { kind: 'circle', x: obstacle.x, z: obstacle.z, r: obstacle.radius, top };
    });
}

let cachedWorld: SimWorld | null = null;
let cachedTerrain: TerrainConfig | null = null;
let cachedObstacles: readonly Obstacle[] | null = null;
let cachedCount = -1;

/**
 * The sim world for the current terrain and obstacle list. Built once and
 * rebuilt only when the world changes (the obstacle list is filled while
 * the city is built, before the first tick normally).
 */
export function simWorldFor(terrain: TerrainConfig, obstacles: readonly Obstacle[]): SimWorld {
    if (!cachedWorld || terrain !== cachedTerrain || obstacles !== cachedObstacles || obstacles.length !== cachedCount) {
        cachedWorld = createSimWorld(terrain, obstaclesToColliders(obstacles), [], cityRoadGrid());
        cachedTerrain = terrain;
        cachedObstacles = obstacles;
        cachedCount = obstacles.length;
    }
    return cachedWorld;
}
