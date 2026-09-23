import type * as THREE from 'three';

// Rendered objects that stand where a collider is (trees, rocks, buildings,
// props) carry userData.collider. The e2e hook lists them, and a test checks
// that each one sits on a collider of shared/world/colliderGen.ts, so the
// look and the collision of the world cannot drift apart.

export type ColliderTag =
    | 'tree' | 'rock' | 'building' | 'bench' | 'parkTree' | 'pond'
    | 'planter' | 'parasol' | 'fountain' | 'lamp' | 'palm' | 'signPost';

export function markCollider(object: THREE.Object3D, tag: ColliderTag): void {
    object.userData.collider = tag;
}

export interface TaggedCollider {
    tag: ColliderTag;
    x: number;
    z: number;
}

export function listTaggedColliders(scene: THREE.Scene): TaggedCollider[] {
    const out: TaggedCollider[] = [];
    scene.updateMatrixWorld(true);
    scene.traverse(object => {
        const tag = object.userData.collider as ColliderTag | undefined;
        if (!tag) return;
        const e = object.matrixWorld.elements;
        out.push({ tag, x: e[12], z: e[14] });
    });
    return out;
}
