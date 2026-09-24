import type { ColliderInput } from '../../src/shared/world/colliders.js';
import { sha256, stableStringify } from '../helpers.js';

// Golden values of the default world (seed 0), shared by the tests that
// check a collider list against it instead of rebuilding it with the code
// under test. Regression locks: they only change on purpose, together with
// MAP_VERSION.

// The ordered static collider list: 120 trees, 27 rocks, 92 city colliders
export const GOLDEN_COLLIDERS_SHA = 'a046f62cb53b4cea26a05c9ad7d21c2704ae504c26f42124a1655a7b1a4ce0d4';
export const GOLDEN_COLLIDER_COUNT = 120 + 27 + 92;
// The rocks alone (the offline world without city and trees)
export const GOLDEN_ROCKS_SHA = 'd78f1a7d2a21bf9c9151b304279921c369cd1f91659978bd6bcda71d8f6a0127';
export const GOLDEN_ROCK_COUNT = 27;
export const GOLDEN_WORLD_HASH = 'cd1d366c';

// JSON has no Infinity; spell the tops out so they are part of the hash
export function collidersSha(colliders: readonly ColliderInput[]): string {
    return sha256(stableStringify(colliders.map(c => ({ ...c, top: String(c.top) }))));
}
