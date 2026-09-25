// Canonical serialisation and FNV-1a of the world data (docs/phase-1b-design.md,
// 6): client and server hash the same map and track data and compare the
// hashes strictly. The map itself is src/shared/map/mapData.ts (phase 3);
// the old city's colliders (colliderGen.ts) are only drawn by the client
// until the Bulli Bay renderer replaces them.

import type { ColliderInput } from './colliders.js';
import type { GeneratedWorld } from './worldGen.js';

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

// The old city's world hash (its golden test pins the generator)
export function worldHash(world: GeneratedWorld, colliders: readonly ColliderInput[]): string {
    return fnv1a(canonicalStringify({ world, colliders }));
}
