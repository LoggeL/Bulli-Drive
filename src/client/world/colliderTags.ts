import type * as THREE from 'three';

// Rendered props that stand where a collider is (trees, rocks, buildings,
// street furniture) are registered here. The e2e hook lists them, and a test
// checks that each one sits on a collider of shared/world/colliderGen.ts, so
// the look and the collision of the world cannot drift apart. Most of the
// world is merged into batches and instanced meshes (graphics G1), so a prop
// registers the position it is drawn at; a prop that is its own scene object
// can carry the tag in userData instead.

export type ColliderTag =
    | 'tree' | 'rock' | 'building' | 'bench' | 'parkTree' | 'pond'
    | 'planter' | 'parasol' | 'fountain' | 'lamp' | 'palm' | 'signPost';

export interface TaggedCollider {
    tag: ColliderTag;
    x: number;
    z: number;
}

// The world is built once per page (network/websocket.ts), so the list only
// grows while it is built
const drawnAt: TaggedCollider[] = [];

/** A prop drawn into a batch or an instanced mesh at (x, z). */
export function markColliderAt(tag: ColliderTag, x: number, z: number): void {
    drawnAt.push({ tag, x, z });
}

/** A prop that is its own scene object: its world position counts. */
export function markCollider(object: THREE.Object3D, tag: ColliderTag): void {
    object.userData.collider = tag;
}

export function listTaggedColliders(scene: THREE.Scene): TaggedCollider[] {
    const out: TaggedCollider[] = drawnAt.map(prop => ({ ...prop }));
    scene.updateMatrixWorld(true);
    scene.traverse(object => {
        const tag = object.userData.collider as ColliderTag | undefined;
        if (!tag) return;
        const e = object.matrixWorld.elements;
        out.push({ tag, x: e[12], z: e[14] });
    });
    return out;
}
