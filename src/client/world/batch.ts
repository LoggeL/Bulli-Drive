import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Static world geometry per material: a Batch collects parts (with a vertex
// color each) and merges them into one geometry, so every material of the
// city is a single draw call (and one more in the shadow pass).

export type RGB = readonly [number, number, number];

// World-space box projection of UVs: `scale` meters per texture repeat
export interface BoxUv {
    box: number;
}

// Attributes a part keeps (cardUv: position inside a foliage card, wind:
// sway weights of palms, surface: finish of street furniture). Every part of
// one batch must carry the same set (mergeGeometries).
const KEPT_ATTRIBUTES = new Set(['position', 'normal', 'uv', 'color', 'cardUv', 'wind', 'surface']);

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();

/** Linear RGB of an sRGB hex color. */
export function rgb(hex: number | string): RGB {
    const c = new THREE.Color(hex);
    return [c.r, c.g, c.b];
}

export const scaleRgb = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

export class Batch {
    private parts: THREE.BufferGeometry[] = [];

    constructor(readonly name: string) {}

    get size(): number {
        return this.parts.length;
    }

    /** Adds a copy of `geometry` (transformed by `matrix`) in one color. */
    add(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4 | null = null, color: RGB = [1, 1, 1], uv: BoxUv | null = null): THREE.BufferGeometry {
        let g = geometry.index ? geometry.clone() : geometry.clone();
        if (!g.index) {
            const count = g.attributes.position.count;
            const index: number[] = new Array(count);
            for (let i = 0; i < count; i++) index[i] = i;
            g.setIndex(index);
        }
        for (const key of Object.keys(g.attributes)) {
            if (!KEPT_ATTRIBUTES.has(key)) g.deleteAttribute(key);
        }
        for (const key of Object.keys(g.morphAttributes)) delete g.morphAttributes[key];
        if (!g.attributes.normal) g.computeVertexNormals();
        if (matrix) g.applyMatrix4(matrix);
        const count = g.attributes.position.count;
        if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
        if (uv) {
            const s = 1 / uv.box;
            const P = g.attributes.position;
            const N = g.attributes.normal;
            const UV = g.attributes.uv;
            for (let i = 0; i < count; i++) {
                _v.fromBufferAttribute(P, i);
                _n.fromBufferAttribute(N, i);
                const ax = Math.abs(_n.x), ay = Math.abs(_n.y), az = Math.abs(_n.z);
                if (ay >= ax && ay >= az) UV.setXY(i, _v.x * s, -_v.z * s);
                else if (ax >= az) UV.setXY(i, -_v.z * s * Math.sign(_n.x), _v.y * s);
                else UV.setXY(i, _v.x * s * Math.sign(_n.z), _v.y * s);
            }
        }
        if (!g.attributes.color) {
            const colors = new Float32Array(count * 3);
            for (let i = 0; i < count; i++) {
                colors[i * 3] = color[0];
                colors[i * 3 + 1] = color[1];
                colors[i * 3 + 2] = color[2];
            }
            g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        }
        // mergeGeometries needs one attribute layout: plain, non-interleaved
        for (const key of Object.keys(g.attributes)) {
            const attribute = g.attributes[key];
            if ((attribute as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute || attribute.normalized) {
                const plain = new THREE.BufferAttribute(new Float32Array(attribute.count * attribute.itemSize), attribute.itemSize);
                const read = [attribute.getX, attribute.getY, attribute.getZ, attribute.getW];
                for (let i = 0; i < attribute.count; i++) {
                    for (let c = 0; c < attribute.itemSize; c++) plain.setComponent(i, c, read[c].call(attribute, i));
                }
                g.setAttribute(key, plain);
            }
        }
        this.parts.push(g);
        return g;
    }

    /** Axis aligned box of size w x h x d centered at (x, y, z), turned by ry. */
    box(w: number, h: number, d: number, x: number, y: number, z: number, color: RGB, uv: BoxUv | null = null, ry = 0): void {
        const matrix = new THREE.Matrix4().makeRotationY(ry).setPosition(x, y, z);
        this.add(new THREE.BoxGeometry(w, h, d), matrix, color, uv);
    }

    build(): THREE.BufferGeometry | null {
        if (!this.parts.length) return null;
        const merged = mergeGeometries(this.parts, false);
        for (const part of this.parts) part.dispose();
        this.parts = [];
        if (!merged) return null;
        merged.computeBoundingSphere();
        merged.computeBoundingBox();
        return merged;
    }

    mesh(material: THREE.Material, options: { cast?: boolean; receive?: boolean } = {}): THREE.Mesh | null {
        const geometry = this.build();
        if (!geometry) return null;
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = this.name;
        mesh.castShadow = options.cast ?? true;
        mesh.receiveShadow = options.receive ?? true;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        return mesh;
    }
}

type Vec3 = readonly [number, number, number];
type Vec2 = readonly [number, number];

/**
 * Quad from four corners (counter-clockwise seen from the front: bottom
 * left, bottom right, top right, top left) with optional UVs.
 */
export function quad(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, uv: readonly Vec2[] = [[0, 0], [1, 0], [1, 1], [0, 1]]): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([...p0, ...p1, ...p2, ...p3]), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv.flat()), 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.computeVertexNormals();
    return g;
}

/** Quad facing `want` (flips the winding if needed). */
export function orientedQuad(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, want: Vec3, uv?: readonly Vec2[]): THREE.BufferGeometry {
    const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const e2 = [p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (n[0] * want[0] + n[1] * want[1] + n[2] * want[2] < 0) {
        return quad(p3, p2, p1, p0, uv ? [uv[3], uv[2], uv[1], uv[0]] : undefined);
    }
    return quad(p0, p1, p2, p3, uv);
}

/** Tube with varying radius along a polyline (palm trunks, lamp arms). */
export function tube(points: THREE.Vector3[], radii: number[], radial = 8, vScale = 1): THREE.BufferGeometry {
    const position: number[] = [], normal: number[] = [], uv: number[] = [], index: number[] = [];
    const T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const side = new THREE.Vector3(1, 0, 0);
    let length = 0;
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (i > 0) length += p.distanceTo(points[i - 1]);
        const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
        T.subVectors(b, a).normalize();
        N.crossVectors(Math.abs(T.y) > 0.9 ? side : up, T).normalize();
        B.crossVectors(T, N).normalize();
        for (let j = 0; j <= radial; j++) {
            const t = (j / radial) * Math.PI * 2;
            const dx = Math.cos(t), dy = Math.sin(t);
            const nx = N.x * dx + B.x * dy, ny = N.y * dx + B.y * dy, nz = N.z * dx + B.z * dy;
            position.push(p.x + nx * radii[i], p.y + ny * radii[i], p.z + nz * radii[i]);
            normal.push(nx, ny, nz);
            uv.push(j / radial, length * vScale);
        }
    }
    const R = radial + 1;
    for (let i = 0; i < points.length - 1; i++) {
        for (let j = 0; j < radial; j++) {
            const a = i * R + j, b = a + 1, c = a + R, d = c + 1;
            index.push(a, c, b, b, c, d);
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(index);
    return g;
}

/** Deterministic random numbers in [0, 1) (the shared mulberry32). */
export { mulberry32 as rng } from '../../shared/math/rng.js';
