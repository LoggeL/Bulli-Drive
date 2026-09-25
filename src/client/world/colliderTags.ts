// Rendered props that stand where a collider is (buildings, landmarks,
// containers, trees, palms, rocks, the fountain) are registered here. The
// e2e hook lists them, and a test checks that each one sits on a collider of
// the map (shared/map/mapData.ts), so the look and the collision of the
// world cannot drift apart. The world is merged into cells and instanced
// meshes, so a prop registers the position it is drawn at.

export type ColliderTag = 'building' | 'landmark' | 'container' | 'tree' | 'palm' | 'rock' | 'fountain';

export interface TaggedCollider {
    tag: ColliderTag;
    x: number;
    z: number;
}

// The world is built once per page (world/mapScene.ts), so the list only
// grows while it is built
const drawnAt: TaggedCollider[] = [];

/** A prop drawn into a batch or an instanced mesh at (x, z). */
export function markColliderAt(tag: ColliderTag, x: number, z: number): void {
    drawnAt.push({ tag, x, z });
}

/** Every prop drawn on a collider so far. */
export function listTaggedColliders(): TaggedCollider[] {
    return drawnAt.map(prop => ({ ...prop }));
}
