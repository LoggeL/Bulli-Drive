import type { CityData, TerrainConfig, TreeData } from '../../shared/protocol.js';
import { cityRoadGrid } from '../../shared/world/cityGen.js';
import { buildWorldColliders } from '../../shared/world/colliderGen.js';
import { createSimWorld, type ColliderInput, type SimWorld } from '../../shared/world/colliders.js';
import { state } from '../state.js';
import type { Obstacle } from '../types.js';

// The static collision world of the v2 sim. The colliders come from the
// shared generator (shared/world/colliderGen.ts), exactly the list the
// server builds (docs/phase-1b-design.md, 6), never from what the client
// happened to render.

// The legacy physics (?physics=legacy) still reads circles and rects; it
// goes away in phase 1b, and this view with it.
export function collidersToObstacles(colliders: readonly ColliderInput[]): Obstacle[] {
    return colliders.map((collider): Obstacle => collider.kind === 'box'
        ? { type: 'rect', x: collider.x, z: collider.z, halfWidth: collider.hw, halfDepth: collider.hd, top: collider.top }
        : { x: collider.x, z: collider.z, radius: collider.r, top: collider.top });
}

/**
 * Sets the colliders of the world the server sent (trees and city; city null
 * offline) and the legacy obstacle view of them.
 */
export function setWorldColliders(world: { trees: readonly TreeData[]; city: CityData | null }): void {
    state.worldColliders = buildWorldColliders(world);
    state.obstacles = collidersToObstacles(state.worldColliders);
}

let cachedWorld: SimWorld | null = null;
let cachedTerrain: TerrainConfig | null = null;
let cachedColliders: readonly ColliderInput[] | null = null;

/**
 * The sim world for the current terrain and collider list. Built once and
 * rebuilt only when either changes (the list is set with the server's
 * world, before the first tick normally).
 */
export function simWorldFor(terrain: TerrainConfig, colliders: readonly ColliderInput[]): SimWorld {
    if (!cachedWorld || terrain !== cachedTerrain || colliders !== cachedColliders) {
        cachedWorld = createSimWorld(terrain, colliders, [], cityRoadGrid());
        cachedTerrain = terrain;
        cachedColliders = colliders;
    }
    return cachedWorld;
}
