import * as THREE from 'three';
import type { RenderTier } from '../effects/renderQuality.js';
import { Batch, rng, tube, type RGB } from './batch.js';
import type { WorldMaterials } from './materials.js';

// Palms, trees and shrubs of the world probe: palms as instanced trunk +
// frond meshes (Washingtonia fan palms and date palms), trees as crossed
// cards from the tree atlas (one InstancedMesh per kind), shrubs as merged
// crossed cards.

// UV rects in generated/tree_cards (generated/tree_cards.json)
const TREE_UV = {
    oak: [0.0, 0.0117, 0.6836, 0.9883],
    cypress: [0.7344, 0.0117, 0.9805, 0.9883]
} as const;

export type PalmKind = 'fan' | 'date';

// --- Palms ------------------------------------------------------------------------

type FrondBuilder = (batch: Batch, base: THREE.Vector3, azimuth: number, elevation: number, droop: number,
    length: number, param: number, color: RGB, fold?: number, twist?: number) => void;

// Normals bent up and outwards: soft, rounded light on flat cards
function bendNormals(g: THREE.BufferGeometry, base: THREE.Vector3, sideWeight: number, outWeight: number, upWeight: number): void {
    const N = g.attributes.normal, P = g.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < N.count; i++) {
        const ox = P.getX(i) - base.x, oz = P.getZ(i) - base.z, ol = Math.hypot(ox, oz) || 1;
        v.set(Math.abs(N.getX(i)) * sideWeight + ox / ol * outWeight, Math.abs(N.getY(i)) + upWeight, Math.abs(N.getZ(i)) * sideWeight + oz / ol * outWeight).normalize();
        N.setXYZ(i, v.x, v.y, v.z);
    }
}

function stripGeometry(positions: number[], uvs: number[], segments: number): THREE.BufferGeometry {
    const index: number[] = [];
    for (let i = 0; i < segments; i++) {
        for (let j = 0; j < 2; j++) {
            const a = i * 3 + j, b = a + 1, c = a + 3, d = c + 1;
            index.push(a, b, d, a, d, c);
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(index);
    g.computeVertexNormals();
    return g;
}

function makeFrond(segments: number): FrondBuilder {
    // Date palm frond: a V-folded strip from one of 4 columns of the atlas
    return (batch, base, azimuth, elevation, droop, length, column, color, fold = 0.18, twist = 0) => {
        const positions: number[] = [], uvs: number[] = [], colors: number[] = [];
        const u0 = column * 0.25 + 0.012, u1 = (column + 1) * 0.25 - 0.012, um = (u0 + u1) / 2;
        const p = new THREE.Vector3();
        const ca = Math.cos(azimuth), sa = Math.sin(azimuth);
        const width = 1.15;
        for (let i = 0; i <= segments; i++) {
            const t = i / segments;
            if (i > 0) {
                const e = elevation - droop * Math.pow(t, 1.4);
                const step = length / segments;
                p.add(new THREE.Vector3(Math.cos(e) * step, Math.sin(e) * step, 0));
            }
            const w = width * (0.55 + 0.45 * Math.sin(Math.min(1, t * 1.25 + 0.15) * Math.PI * 0.95));
            const tw = twist * t;
            for (const [s, u] of [[-1, u0], [0, um], [1, u1]] as const) {
                const z = s * w * 0.5 * Math.cos(tw), y = -Math.abs(s) * fold * w + s * w * 0.5 * Math.sin(tw);
                positions.push(base.x + p.x * ca - z * sa, base.y + p.y + y, base.z + p.x * sa + z * ca);
                uvs.push(u, t);
                const ao = 0.45 + 0.55 * Math.min(1, t * 1.6);
                colors.push(color[0] * ao, color[1] * ao, color[2] * ao);
            }
        }
        const g = stripGeometry(positions, uvs, segments);
        bendNormals(g, base, 0.3, 0.5, 0.6);
        g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        batch.add(g);
    };
}

function makeFanLeaf(segments: number): FrondBuilder {
    // Washingtonia fan leaf: a square card of the 2 x 2 atlas; the stalk (the
    // lower 35 %) is straight, the blade bends down and folds into a V
    return (batch, base, azimuth, elevation, droop, length, cell, color, fold = 0.16, twist = 0) => {
        const positions: number[] = [], uvs: number[] = [], colors: number[] = [];
        const cu = (cell % 2) * 0.5, cv = cell < 2 ? 0.5 : 0.0;
        const u0 = cu + 0.004, u1 = cu + 0.496, um = (u0 + u1) / 2;
        const p = new THREE.Vector3();
        const ca = Math.cos(azimuth), sa = Math.sin(azimuth);
        const W = length * 0.98;
        for (let i = 0; i <= segments; i++) {
            const t = i / segments;
            if (i > 0) {
                const tb = Math.max(0, (t - 0.35) / 0.65);
                const e = elevation - droop * Math.pow(tb, 1.3);
                const step = length / segments;
                p.add(new THREE.Vector3(Math.cos(e) * step, Math.sin(e) * step, 0));
            }
            const blade = Math.min(1, Math.max(0, (t - 0.3) / 0.25));
            const tw = twist * t;
            for (const [s, u] of [[-1, u0], [0, um], [1, u1]] as const) {
                const z = s * W * 0.5 * Math.cos(tw), y = -Math.abs(s) * fold * W * blade + s * W * 0.5 * Math.sin(tw);
                positions.push(base.x + p.x * ca - z * sa, base.y + p.y + y, base.z + p.x * sa + z * ca);
                uvs.push(u, cv + 0.004 + t * 0.492);
                const ao = 0.4 + 0.6 * Math.min(1, t * 1.4);
                colors.push(color[0] * ao, color[1] * ao, color[2] * ao);
            }
        }
        const g = stripGeometry(positions, uvs, segments);
        bendNormals(g, base, 0.3, 0.55, 0.5);
        g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        batch.add(g);
    };
}

interface PalmGeometry {
    trunk: THREE.BufferGeometry;
    fronds: THREE.BufferGeometry;
}

function buildPalm(kind: PalmKind, seed: number, low: boolean): PalmGeometry {
    const R = rng(seed);
    const keep = () => R() < (low ? 0.72 : 1);
    const segments = low ? (kind === 'fan' ? 3 : 4) : (kind === 'fan' ? 5 : 6);
    const radial = low ? 6 : 9;
    const trunk = new Batch(`palm-trunk-${kind}`);
    const fronds = new Batch(`palm-fronds-${kind}`);
    const height = kind === 'fan' ? 13 : 8.5;
    const r0 = kind === 'fan' ? 0.33 : 0.48, r1 = kind === 'fan' ? 0.21 : 0.4;
    const bend = kind === 'fan' ? 0.9 : 0.6;
    const points: THREE.Vector3[] = [], radii: number[] = [];
    const rings = kind === 'fan' ? (low ? 9 : 14) : (low ? 7 : 10);
    for (let i = 0; i <= rings; i++) {
        const t = i / rings;
        points.push(new THREE.Vector3(bend * t * t, t * height, 0));
        const flare = kind === 'fan' ? 0.25 * Math.exp(-t * 18) : 0.2 * Math.exp(-t * 10);
        radii.push(r0 + (r1 - r0) * t + flare);
    }
    const g = tube(points, radii, radial, 1 / 1.3);
    // Darker at the foot
    const colors: number[] = [];
    for (let i = 0; i <= rings; i++) {
        for (let j = 0; j <= radial; j++) {
            const d = 0.7 + 0.3 * Math.min(1, (i / rings) * 4);
            colors.push(d, d * 0.97, d * 0.93);
        }
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    trunk.add(g);
    const top = points[rings].clone();
    if (kind === 'fan') {
        const leaf = makeFanLeaf(segments);
        // Dark crown core and a skirt of dead, hanging leaves
        trunk.add(new THREE.SphereGeometry(0.55, low ? 6 : 9, low ? 4 : 7).scale(1, 1.25, 1).translate(top.x, top.y - 0.25, top.z), null, [0.2, 0.16, 0.1]);
        trunk.add(new THREE.CylinderGeometry(0.5, 0.3, 2.2, radial, 1, true).translate(top.x, top.y - 1.4, top.z), null, [0.36, 0.27, 0.18]);
        for (let i = 0; i < 14; i++) {
            const azimuth = (i / 14) * Math.PI * 2 + R() * 0.3;
            if (!keep()) continue;
            leaf(fronds, top.clone().add(new THREE.Vector3(0, -0.2 - (i % 2) * 0.3, 0)), azimuth, -1.38 - R() * 0.1, 0.05, 1.5 + R() * 0.3, 3, [0.36, 0.32, 0.28], 0.05);
        }
        // Green crown: four rings from steep to hanging
        const crown: [number, number, number, number][] = [[1.2, 8, 2.6, 0.45], [0.72, 11, 2.9, 0.6], [0.28, 13, 3.0, 0.85], [-0.2, 10, 2.8, 1.05]];
        crown.forEach(([elevation, count, length, droop], ring) => {
            for (let i = 0; i < count; i++) {
                const azimuth = (i / count) * Math.PI * 2 + R() * 0.4 + ring * 0.37;
                if (!keep()) continue;
                const cell = ring === 3 && R() < 0.2 ? 2 : (R() < 0.5 ? 0 : 1);
                const g2 = 0.62 + R() * 0.16;
                const color: RGB = cell === 2 ? [g2 * 0.75, g2 * 0.72, g2 * 0.6] : [g2, g2, g2 * 0.95];
                leaf(fronds, top.clone().add(new THREE.Vector3(0, 0.15 - ring * 0.18, 0)), azimuth, elevation + (R() - 0.5) * 0.2, droop, length + R() * 0.4, cell, color, 0.16, (R() - 0.5) * 0.7);
            }
        });
    } else {
        const frond = makeFrond(segments);
        trunk.add(new THREE.SphereGeometry(0.62, 9, 6).scale(1, 0.9, 1).translate(top.x, top.y - 0.1, top.z), null, [0.55, 0.45, 0.32]);
        for (let i = 0; i < 30; i++) {
            const ring = i % 3;
            const azimuth = (i / 30) * Math.PI * 2 * 3 + R() * 0.3;
            const elevation = [1.05, 0.55, 0.1][ring] + R() * 0.2;
            const g2 = 0.7 + R() * 0.15;
            if (!keep()) continue;
            frond(fronds, top.clone().add(new THREE.Vector3(0, 0.25, 0)), azimuth, elevation, [1.2, 1.5, 1.2][ring], 4.2 + R() * 0.9, Math.floor(R() * 4), [g2, g2 * 1.02, g2 * 0.9], 0.22, (R() - 0.5) * 0.5);
        }
    }
    return { trunk: trunk.build()!, fronds: fronds.build()! };
}

export interface PalmSpot {
    kind: PalmKind;
    x: number;
    y: number;
    z: number;
    scale: number;
    yaw: number;
}

/** Instanced palms: one trunk and one frond mesh per kind. */
export function createPalms(M: WorldMaterials, spots: PalmSpot[], tier: RenderTier): THREE.Group {
    const group = new THREE.Group();
    group.name = 'palms';
    const low = tier !== 'desktop';
    const matrix = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (const kind of ['fan', 'date'] as const) {
        const list = spots.filter(spot => spot.kind === kind);
        if (!list.length) continue;
        const geometry = buildPalm(kind, kind === 'fan' ? 3 : 5, low);
        const trunks = new THREE.InstancedMesh(geometry.trunk, M.trunk, list.length);
        const fronds = new THREE.InstancedMesh(geometry.fronds, kind === 'fan' ? M.fan : M.frond, list.length);
        list.forEach((spot, i) => {
            q.setFromAxisAngle(up, spot.yaw);
            s.set(spot.scale, spot.scale, spot.scale);
            matrix.compose(p.set(spot.x, spot.y, spot.z), q, s);
            trunks.setMatrixAt(i, matrix);
            fronds.setMatrixAt(i, matrix);
        });
        for (const mesh of [trunks, fronds]) {
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.computeBoundingSphere();
            group.add(mesh);
        }
        trunks.name = `palm-trunks-${kind}`;
        fronds.name = `palm-fronds-${kind}`;
    }
    return group;
}

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
