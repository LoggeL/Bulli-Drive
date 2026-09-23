import * as THREE from 'three';
import { Batch, rng } from './batch.js';
import type { WorldMaterials } from './materials.js';

// Trees and shrubs of the world probe: trees as crossed cards from the tree
// atlas (one InstancedMesh per kind), shrubs as merged crossed cards. The
// palms are in palms.ts.

// UV rects in generated/tree_cards (generated/tree_cards.json)
const TREE_UV = {
    oak: [0.0, 0.0117, 0.6836, 0.9883],
    cypress: [0.7344, 0.0117, 0.9805, 0.9883]
} as const;

// --- Trees (cards) ----------------------------------------------------------------

function crossCard(uv: readonly number[], width: number, height: number, planes: number): THREE.BufferGeometry {
    const [u0, v0, u1, v1] = uv;
    const position: number[] = [], uvs: number[] = [], normal: number[] = [], index: number[] = [], card: number[] = [];
    for (let k = 0; k < planes; k++) {
        card.push(0, 0, 1, 0, 1, 1, 0, 1);
        const a = (k / planes) * Math.PI, c = Math.cos(a) * width / 2, s = Math.sin(a) * width / 2, b = k * 4;
        position.push(-c, 0, -s, c, 0, s, c, height, s, -c, height, -s);
        uvs.push(u0, v0, u1, v0, u1, v1, u0, v1);
        // Normals bent up and out: rounded light instead of flat cards
        normal.push(-0.5, 0.5, -0.2, 0.5, 0.5, 0.2, 0.4, 0.85, 0.2, -0.4, 0.85, -0.2);
        index.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setAttribute('cardUv', new THREE.Float32BufferAttribute(card, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(position.length).fill(1), 3));
    g.setIndex(index);
    const N = g.attributes.normal;
    const v = new THREE.Vector3();
    for (let i = 0; i < N.count; i++) {
        v.fromBufferAttribute(N, i).normalize();
        N.setXYZ(i, v.x, v.y, v.z);
    }
    return g;
}

export type TreeKind = 'oak' | 'cypress' | 'bush';

export interface TreeSpot {
    x: number;
    y: number;
    z: number;
    scale: number;
}

// Card size in meters at scale 1
const TREE_SIZE: Record<TreeKind, [number, number]> = { oak: [7.2, 10.3], cypress: [3.0, 12.0], bush: [7.2, 10.3] };

/** Tree cards of one kind as an InstancedMesh (deterministic per seed). */
export function createTreeCards(M: WorldMaterials, kind: TreeKind, spots: TreeSpot[], seed: number, castShadow = kind !== 'bush'): THREE.InstancedMesh | null {
    if (!spots.length) return null;
    const R = rng(seed);
    const [width, height] = TREE_SIZE[kind];
    const geometry = crossCard(kind === 'cypress' ? TREE_UV.cypress : TREE_UV.oak, width, height, kind === 'cypress' ? 2 : 3);
    const mesh = new THREE.InstancedMesh(geometry, M.tree, spots.length);
    const matrix = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const color = new THREE.Color();
    spots.forEach((spot, i) => {
        q.setFromAxisAngle(up, R() * Math.PI);
        s.set(spot.scale * (0.9 + R() * 0.2), spot.scale * (kind === 'bush' ? 0.7 : 1), spot.scale * (0.9 + R() * 0.2));
        matrix.compose(p.set(spot.x, spot.y - (kind === 'bush' ? 0.6 : 0.4) * spot.scale, spot.z), q, s);
        mesh.setMatrixAt(i, matrix);
        const t = 0.8 + R() * 0.3;
        if (kind === 'bush') mesh.setColorAt(i, color.setRGB(t * 0.62, t * 0.74, t * 0.5));
        else mesh.setColorAt(i, color.setRGB(t, t * (0.95 + R() * 0.1), t * 0.9));
    });
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    mesh.name = `trees-${kind}`;
    mesh.computeBoundingSphere();
    return mesh;
}

// --- Shrubs -----------------------------------------------------------------------

/**
 * Adds a shrub of three crossed cards to `batch` (M.shrub): kind 0 is the
 * flowering (bougainvillea) half of the atlas, 1 the green one.
 */
export function addShrub(batch: Batch, R: () => number, x: number, y: number, z: number, size: number, kind: 0 | 1): void {
    const u0 = kind * 0.5 + 0.005, u1 = kind * 0.5 + 0.495;
    for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI + R() * 0.3;
        const ca = Math.cos(a) * size / 2, sa = Math.sin(a) * size / 2;
        const h = size * 0.95;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute([x - ca, y, z - sa, x + ca, y, z + sa, x + ca, y + h, z + sa, x - ca, y + h, z - sa], 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute([u0, 0.02, u1, 0.02, u1, 0.98, u0, 0.98], 2));
        g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
        g.setAttribute('cardUv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
        g.setIndex([0, 1, 2, 0, 2, 3]);
        const t = 0.85 + R() * 0.2;
        batch.add(g, null, [t, t, t]);
    }
}
