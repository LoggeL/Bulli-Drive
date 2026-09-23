// Immutable data of one map (docs/phase-1b-design.md, 2.1 and 6): the
// generated world, its colliders, the sim world and a hash over both. The
// server builds it once per map and every room of that map shares it; the
// client builds the same collider world from the same shared functions.

import { DEFAULT_TERRAIN_CONFIG } from '../constants.js';
import type { TerrainConfig } from '../protocol.js';
import { buildWorldColliders } from './colliderGen.js';
import { cityRoadGrid } from './cityGen.js';
import { createSimWorld, type ColliderInput, type SimWorld } from './colliders.js';
import { generateWorld, WORLD_SEED, type GeneratedWorld } from './worldGen.js';

// Bumped whenever the map changes for the same seed (layout, props, colliders)
export const MAP_VERSION = 2;

export interface MapData {
    seed: number;
    mapVersion: number;
    terrain: TerrainConfig;
    // Layout and the initial item placement; rooms copy the items
    world: GeneratedWorld;
    colliders: readonly ColliderInput[];
    simWorld: SimWorld;
    // FNV-1a over the canonical world and collider list (hex, 8 digits)
    worldHash: string;
}

// JSON with sorted keys and exact number spelling (Infinity included), so
// the hash only changes when a value changes.
export function canonicalStringify(value: unknown): string {
    if (typeof value === 'number') return Object.is(value, -0) ? '0' : String(value);
    if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return '{' + Object.keys(record).sort()
            .filter(key => record[key] !== undefined)
            .map(key => JSON.stringify(key) + ':' + canonicalStringify(record[key]))
            .join(',') + '}';
    }
    return JSON.stringify(value) ?? 'null';
}

// 32-bit FNV-1a over the UTF-16 code units
export function fnv1a(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

export function worldHash(world: GeneratedWorld, colliders: readonly ColliderInput[]): string {
    return fnv1a(canonicalStringify({ world, colliders }));
}

export function createMapData(seed: number = WORLD_SEED, terrain: TerrainConfig = DEFAULT_TERRAIN_CONFIG): MapData {
    const world = generateWorld(seed);
    const colliders = buildWorldColliders(world);
    return {
        seed,
        mapVersion: MAP_VERSION,
        terrain,
        world,
        colliders,
        simWorld: createSimWorld(terrain, colliders, [], cityRoadGrid()),
        worldHash: worldHash(world, colliders)
    };
}
