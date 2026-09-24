import * as THREE from 'three';
import { Batch, rng } from './batch.js';
import type { WorldMaterials } from './materials.js';

// Trees and shrubs of the world probe: trees as crossed cards from the tree
// atlas (one InstancedMesh per kind), shrubs as merged crossed cards. The
// palms are in palms.ts.

// UV rects in generated/tree_cards (generated/tree_cards.json)
export const TREE_UV = {
    oak: [0.0, 0.0117, 0.6836, 0.9883],
    cypress: [0.7344, 0.0117, 0.9805, 0.9883]
} as const;

// --- Trees (cards) ----------------------------------------------------------------

// Crown part of the oak card for the horizontal top card: seen from above
// (overview, hills below the camera) the vertical cards thin out, the top
// card keeps a crown there
const OAK_TOP_UV = [0.02, 0.36, 0.66, 0.98] as const;

/**
 * Crossed vertical cards around the trunk, plus an optional horizontal card
 * at `top` (fraction of the height). Normals are bent away from the trunk
 * axis in the plane of each card (up at the center, outwards at the edges),
 * so every card is lit like a rounded crown whatever its angle; the
 * material keeps them on both faces (no flip for back faces, see
 * PatchOptions.cardMask). The vertex color is a baked occlusion: darker at
 * the foot of the crown.
 */
function crossCard(uv: readonly number[], width: number, height: number, planes: number, top = 0): THREE.BufferGeometry {
    const [u0, v0, u1, v1] = uv;
    const position: number[] = [], uvs: number[] = [], normal: number[] = [], index: number[] = [], card: number[] = [], color: number[] = [];
    const n = new THREE.Vector3();
    for (let k = 0; k < planes; k++) {
        card.push(0, 0, 1, 0, 1, 1, 0, 1);
        const a = (k / planes) * Math.PI, dx = Math.cos(a), dz = Math.sin(a);
        const c = dx * width / 2, s = dz * width / 2, b = k * 4;
        position.push(-c, 0, -s, c, 0, s, c, height, s, -c, height, -s);
        uvs.push(u0, v0, u1, v0, u1, v1, u0, v1);
        // [side along the card, up] per corner: bottom corners lean out
        // more, top corners face up more
        for (const [side, up] of [[-1, 0.6], [1, 0.6], [1, 1], [-1, 1]]) {
            n.set(side * dx * 0.42, up, side * dz * 0.42).normalize();
            normal.push(n.x, n.y, n.z);
        }
        color.push(0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 1, 1, 1, 1, 1, 1);
        index.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    if (top > 0) {
        const [t0, s0, t1, s1] = OAK_TOP_UV;
        const r = width * 0.4, y = height * top, b = planes * 4;
        position.push(-r, y, r, r, y, r, r, y, -r, -r, y, -r);
        uvs.push(t0, s0, t1, s0, t1, s1, t0, s1);
        // cardUv so that the far crown mask (a disc) covers the whole card
        card.push(0.05, 0.24, 0.95, 0.24, 0.95, 1, 0.05, 1);
        for (let i = 0; i < 4; i++) normal.push(0, 1, 0);
        color.push(0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95);
        index.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setAttribute('cardUv', new THREE.Float32BufferAttribute(card, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
    g.setIndex(index);
    return g;
}

export type TreeKind = 'oak' | 'cypress' | 'bush';

export interface TreeSpot {
    x: number;
    y: number;
    z: number;
    scale: number;
    // Sun light that reaches the crown (0..1): below 1 in the shadow of a
    // hill, which the shadow map does not cover out there
    sun?: number;
}

// Card size in meters at scale 1
const TREE_SIZE: Record<TreeKind, [number, number]> = { oak: [7.2, 10.3], cypress: [3.0, 12.0], bush: [7.2, 10.3] };

/** Tree cards of one kind as an InstancedMesh (deterministic per seed). */
export function createTreeCards(M: WorldMaterials, kind: TreeKind, spots: TreeSpot[], seed: number, castShadow = kind !== 'bush'): THREE.InstancedMesh | null {
    if (!spots.length) return null;
    const R = rng(seed);
    const [width, height] = TREE_SIZE[kind];
    const geometry = crossCard(kind === 'cypress' ? TREE_UV.cypress : TREE_UV.oak, width, height, kind === 'cypress' ? 2 : 3, kind === 'oak' ? 0.62 : 0);
    const mesh = new THREE.InstancedMesh(geometry, M.tree, spots.length);
    const matrix = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const color = new THREE.Color();
    spots.forEach((spot, i) => {
        q.setFromAxisAngle(up, R() * Math.PI);
        // Uneven width and height per tree, half of them mirrored (another
        // silhouette from the same card)
        const wide = spot.scale * (0.82 + R() * 0.36) * (R() < 0.5 ? -1 : 1);
        s.set(wide, spot.scale * (kind === 'bush' ? 0.7 : 0.88 + R() * 0.24), Math.abs(wide) * (0.9 + R() * 0.2));
        matrix.compose(p.set(spot.x, spot.y - (kind === 'bush' ? 0.6 : 0.4) * spot.scale, spot.z), q, s);
        mesh.setMatrixAt(i, matrix);
        const t = (0.8 + R() * 0.3) * (0.45 + 0.55 * (spot.sun ?? 1));
        if (kind === 'bush') mesh.setColorAt(i, color.setRGB(t * 0.62, t * 0.74, t * 0.5));
        else mesh.setColorAt(i, color.setRGB(t, t * (0.95 + R() * 0.1), t * 0.9));
    });
    mesh.castShadow = castShadow;
    // Crossed cards would shadow each other in hard halves (and leave a lit
    // seam where they cross): the trees take no shadows, the baked occlusion
    // in the vertex color darkens the foot of the crown instead
    mesh.receiveShadow = kind === 'bush';
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
