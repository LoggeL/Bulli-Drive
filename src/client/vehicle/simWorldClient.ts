import type { CityData, TerrainConfig, TreeData } from '../../shared/protocol.js';
import { cityRoadGrid } from '../../shared/world/cityGen.js';
import { buildWorldColliders } from '../../shared/world/colliderGen.js';
import { createSimWorld, type ColliderInput, type SimWorld } from '../../shared/world/colliders.js';
import { state } from '../state.js';

// The static collision world of the v2 sim. The colliders come from the
// shared generator (shared/world/colliderGen.ts), exactly the list the
// server builds (docs/phase-1b-design.md, 6), never from what the client
// happened to render.

/**
 * Sets the colliders of the world (trees and city; city null offline).
 */
export function setWorldColliders(world: { trees: readonly TreeData[]; city: CityData | null }): void {
    state.worldColliders = buildWorldColliders(world);
}

let cachedWorld: SimWorld | null = null;
// A race room drives in its race world (map + track, race/RaceClient.ts)
let worldOverride: SimWorld | null = null;

/** The world of a race room (null: the map's own again). */
export function setWorldOverride(world: SimWorld | null): void {
    worldOverride = world;
}
let cachedTerrain: TerrainConfig | null = null;
let cachedColliders: readonly ColliderInput[] | null = null;

/**
 * The sim world for the current terrain and collider list. Built once and
 * rebuilt only when either changes (the list is set with the server's
 * world, before the first tick normally). In a race room: its race world.
 */
export function simWorldFor(terrain: TerrainConfig, colliders: readonly ColliderInput[]): SimWorld {
    if (worldOverride) return worldOverride;
    if (!cachedWorld || terrain !== cachedTerrain || colliders !== cachedColliders) {
        cachedWorld = createSimWorld(terrain, colliders, [], cityRoadGrid());
        cachedTerrain = terrain;
        cachedColliders = colliders;
    }
    return cachedWorld;
}
