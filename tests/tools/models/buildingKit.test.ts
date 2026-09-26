import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { sha256 } from '../../helpers.js';

// Budget and convention checks of the committed building kit (tools/models/buildings ->
// public/models/kit). The GLBs are decoded (meshopt) so the checks look at the real geometry:
// triangle counts per LOD, the declared footprint and height against the vertex bounds, every
// triangle's UVs inside one atlas region (the kit cuts its faces at the texture periods, so no
// face may sample across a region border) and the winding against the normals (three.js draws
// FrontSide only). Expected frontages come from kit.json parameters and the module sizes
// documented in tools/models/buildings/README.md, not from the Blender scripts.

const ROOT = path.resolve(__dirname, '../../..');
const KIT_DIR = path.join(ROOT, 'public/models/kit');
const SRC = path.join(ROOT, 'tools/models/buildings');
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

interface Piece { id: string; [key: string]: unknown }
interface Group { module: string; category: string; pieces: Piece[] }
const kit = readJson(path.join(SRC, 'kit.json')) as { groups: Record<string, Group>; lodDistances: Record<string, number[]> };
const budgets = readJson(path.join(SRC, 'budgets.json'));
const atlas = readJson(path.join(SRC, 'atlas.json'));
const manifest = readJson(path.join(KIT_DIR, 'manifest.json'));

// Street frontage (three.js x extent) of the building families, README "Modules"
const BAY_DOWNTOWN = 4.0;
const BAY_INDUSTRIAL = 6.0;

interface GltfNode {
    name?: string; mesh?: number; children?: number[]; extras?: Record<string, unknown>;
    translation?: number[]; rotation?: number[]; scale?: number[]; matrix?: number[];
}
interface Accessor {
    bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string;
    normalized?: boolean; min?: number[]; max?: number[];
}
interface BufferView {
    buffer: number; byteOffset?: number; byteLength: number; byteStride?: number;
    extensions?: { EXT_meshopt_compression?: { buffer: number; byteOffset?: number; byteLength: number; byteStride: number; mode: string; filter?: string; count: number } };
}
interface Gltf {
    nodes: GltfNode[];
    meshes: { primitives: { attributes: Record<string, number>; indices?: number; material?: number; mode?: number }[] }[];
    accessors: Accessor[];
    bufferViews: BufferView[];
    buffers: { byteLength: number; uri?: string }[];
    materials?: { name?: string; pbrMetallicRoughness?: Record<string, { index: number } | unknown>; normalTexture?: { index: number };
        occlusionTexture?: { index: number }; emissiveTexture?: { index: number }; emissiveFactor?: number[] }[];
    textures?: { source?: number; extensions?: { KHR_texture_basisu?: { source: number } } }[];
    images?: { uri?: string; bufferView?: number; mimeType?: string }[];
    extensionsUsed?: string[];
    extensionsRequired?: string[];
}

function readGlb(file: string): { json: Gltf; bin: Uint8Array } {
    const data = fs.readFileSync(file);
    if (data.readUInt32LE(0) !== 0x46546c67 || data.readUInt32LE(4) !== 2 || data.readUInt32LE(8) !== data.length) {
        throw new Error(`${file} is not a GLB 2.0 file`);
    }
    const jsonLength = data.readUInt32LE(12);
    const json = JSON.parse(data.subarray(20, 20 + jsonLength).toString('utf8')) as Gltf;
    const binStart = 20 + jsonLength;
    const binLength = data.readUInt32LE(binStart);
    return { json, bin: new Uint8Array(data.buffer, data.byteOffset + binStart + 8, binLength) };
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

/** Decoded glTF: bufferViews unpacked with meshopt, accessors as float arrays (dequantised). */
class Decoded {
    views = new Map<number, { data: Uint8Array; stride: number }>();
    constructor(public json: Gltf, private bin: Uint8Array) {}

    view(index: number) {
        const cached = this.views.get(index);
        if (cached) return cached;
        const bv = this.json.bufferViews[index];
        const ext = bv.extensions?.EXT_meshopt_compression;
        let data: Uint8Array;
        let stride = bv.byteStride ?? 0;
        if (ext) {
            // buffer 0 is the GLB BIN chunk (the fallback buffer 1 has no data)
            const source = this.bin.subarray(ext.byteOffset ?? 0, (ext.byteOffset ?? 0) + ext.byteLength);
            data = new Uint8Array(ext.count * ext.byteStride);
            MeshoptDecoder.decodeGltfBuffer(data, ext.count, ext.byteStride, source, ext.mode, ext.filter ?? 'NONE');
            stride = ext.byteStride;
        } else {
            data = this.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
        }
        const out = { data, stride };
        this.views.set(index, out);
        return out;
    }

    accessor(index: number): { values: Float64Array; size: number } {
        const a = this.json.accessors[index];
        const size = COMPONENTS[a.type];
        const { data, stride: vStride } = this.view(a.bufferView!);
        const bytes = BYTES[a.componentType];
        const stride = vStride || size * bytes;
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const values = new Float64Array(a.count * size);
        for (let i = 0; i < a.count; i++) {
            for (let c = 0; c < size; c++) {
                const o = (a.byteOffset ?? 0) + i * stride + c * bytes;
                let v: number;
                switch (a.componentType) {
                    case 5120: v = dv.getInt8(o); if (a.normalized) v = Math.max(v / 127, -1); break;
                    case 5121: v = dv.getUint8(o); if (a.normalized) v /= 255; break;
                    case 5122: v = dv.getInt16(o, true); if (a.normalized) v = Math.max(v / 32767, -1); break;
                    case 5123: v = dv.getUint16(o, true); if (a.normalized) v /= 65535; break;
                    case 5125: v = dv.getUint32(o, true); break;
                    default: v = dv.getFloat32(o, true);
                }
                values[i * size + c] = v;
            }
        }
        return { values, size };
    }
}

type Mat = number[];   // column-major 4x4
function multiply(a: Mat, b: Mat): Mat {
    const out = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return out;
}
function nodeMatrix(n: GltfNode): Mat {
    if (n.matrix) return n.matrix;
    const [tx, ty, tz] = n.translation ?? [0, 0, 0];
    const [qx, qy, qz, qw] = n.rotation ?? [0, 0, 0, 1];
    const [sx, sy, sz] = n.scale ?? [1, 1, 1];
    return [
        (1 - 2 * (qy * qy + qz * qz)) * sx, 2 * (qx * qy + qz * qw) * sx, 2 * (qx * qz - qy * qw) * sx, 0,
        2 * (qx * qy - qz * qw) * sy, (1 - 2 * (qx * qx + qz * qz)) * sy, 2 * (qy * qz + qx * qw) * sy, 0,
        2 * (qx * qz + qy * qw) * sz, 2 * (qy * qz - qx * qw) * sz, (1 - 2 * (qx * qx + qy * qy)) * sz, 0,
        tx, ty, tz, 1
    ];
}
const apply = (m: Mat, x: number, y: number, z: number): [number, number, number] =>
    [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];

interface LodGeometry {
    lod: number;
    positions: number[][];     // three.js world metres
    normals: number[][];
    uvs: number[][];
    colors: number[][];
    triangles: number[][];     // vertex indices into the arrays above
    primitives: number;
}

/** All LODs of every piece of one GLB, with world-space attributes. */
function piecesOf(d: Decoded): Map<string, { extras: Record<string, unknown>; lods: LodGeometry[] }> {
    const json = d.json;
    const parents = new Map<number, number>();
    json.nodes.forEach((n, i) => (n.children ?? []).forEach(c => parents.set(c, i)));
    const world = (i: number): Mat => {
        const p = parents.get(i);
        return p === undefined ? nodeMatrix(json.nodes[i]) : multiply(world(p), nodeMatrix(json.nodes[i]));
    };
    const out = new Map<string, { extras: Record<string, unknown>; lods: LodGeometry[] }>();
    json.nodes.forEach((node, i) => {
        const id = node.extras?.kit_piece;
        if (typeof id !== 'string') return;
        const lods: LodGeometry[] = [];
        for (const c of node.children ?? []) {
            const m = /_lod(\d)$/.exec(json.nodes[c].name ?? '');
            if (!m) continue;
            const g: LodGeometry = { lod: Number(m[1]), positions: [], normals: [], uvs: [], colors: [], triangles: [], primitives: 0 };
            const visit = (ni: number) => {
                const n = json.nodes[ni];
                if (n.mesh !== undefined) {
                    const M = world(ni);
                    for (const prim of json.meshes[n.mesh].primitives) {
                        expect(prim.mode ?? 4).toBe(4);
                        g.primitives++;
                        const base = g.positions.length;
                        const pos = d.accessor(prim.attributes.POSITION);
                        const nrm = d.accessor(prim.attributes.NORMAL);
                        const uv = d.accessor(prim.attributes.TEXCOORD_0);
                        const col = d.accessor(prim.attributes.COLOR_0);
                        const count = json.accessors[prim.attributes.POSITION].count;
                        for (let k = 0; k < count; k++) {
                            g.positions.push(apply(M, pos.values[k * 3], pos.values[k * 3 + 1], pos.values[k * 3 + 2]));
                            // no rotations in the kit nodes (checked below): normals only need renormalising
                            const nx = nrm.values[k * nrm.size], ny = nrm.values[k * nrm.size + 1], nz = nrm.values[k * nrm.size + 2];
                            const len = Math.hypot(nx, ny, nz) || 1;
                            g.normals.push([nx / len, ny / len, nz / len]);
                            g.uvs.push([uv.values[k * 2], uv.values[k * 2 + 1]]);
                            g.colors.push(Array.from(col.values.subarray(k * col.size, k * col.size + 3)));
                        }
                        const idx = d.accessor(prim.indices!).values;
                        for (let t = 0; t < idx.length; t += 3) g.triangles.push([base + idx[t], base + idx[t + 1], base + idx[t + 2]]);
                    }
                }
                for (const cc of n.children ?? []) visit(cc);
            };
            visit(c);
            lods.push(g);
        }
        lods.sort((a, b) => a.lod - b.lod);
        out.set(id, { extras: node.extras!, lods });
    });
    return out;
}

/** Faces lying in one side plane of the footprint (the outer walls of a building, the sides of
 *  a container) must face out of the footprint: counts those that face in. The normals come
 *  from the winding, so this catches a flipped face even when its normal was flipped with it. */
function inwardBoundaryFaces(l: LodGeometry, f: { minX: number; maxX: number; minZ: number; maxZ: number }): { checked: number; inward: number } {
    const sides: [number, number, number][] = [[0, f.minX, -1], [0, f.maxX, 1], [2, f.minZ, -1], [2, f.maxZ, 1]];
    let checked = 0;
    let inward = 0;
    for (const [a, b, c] of l.triangles) {
        const [pa, pb, pc] = [l.positions[a], l.positions[b], l.positions[c]];
        const e1 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
        const e2 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
        const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const len = Math.hypot(n[0], n[1], n[2]);
        if (len < 1e-5) continue;
        for (const [axis, value, out] of sides) {
            if ([pa, pb, pc].every(p => Math.abs(p[axis] - value) < 2e-3) && Math.abs(n[axis] / len) > 0.9) {
                checked++;
                if (n[axis] * out < 0) inward++;
            }
        }
    }
    return { checked, inward };
}

function bounds(points: number[][]) {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const p of points) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
    return { lo, hi };
}

// Atlas regions (content rects in glTF UV space: origin top left, like the image rows)
interface Region { name: string; u0: number; v0: number; u1: number; v1: number }
function atlasRegions(): Region[] {
    const N = atlas.size as number;
    const content = (name: string, [x, y, w, h]: number[], pad: number): Region =>
        ({ name, u0: (x + pad) / N, v0: (y + pad) / N, u1: (x + w - pad) / N, v1: (y + h - pad) / N });
    const out: Region[] = [];
    for (const [name, t] of Object.entries(atlas.tiles) as [string, { rect: number[]; pad: number }][]) out.push(content(name, t.rect, t.pad));
    for (const [name, t] of Object.entries(atlas.decals) as [string, { rect: number[]; pad: number }][]) out.push(content(name, t.rect, t.pad));
    out.push(content('palette', atlas.palette.rect, 0));
    return out;
}

beforeAll(async () => {
    await MeshoptDecoder.ready;
});

describe('building kit atlas (tools/models/buildings/atlas.json)', () => {
    const N = atlas.size as number;
    const rects: [string, number[]][] = [
        ...Object.entries(atlas.tiles).map(([n, t]) => [n, (t as { rect: number[] }).rect] as [string, number[]]),
        ...Object.entries(atlas.decals).map(([n, t]) => [n, (t as { rect: number[] }).rect] as [string, number[]]),
        ['palette', atlas.palette.rect]
    ];

    it('keeps every region inside the atlas and apart from the others', () => {
        for (const [name, [x, y, w, h]] of rects) {
            expect(x, name).toBeGreaterThanOrEqual(0);
            expect(y, name).toBeGreaterThanOrEqual(0);
            expect(x + w, name).toBeLessThanOrEqual(N);
            expect(y + h, name).toBeLessThanOrEqual(N);
        }
        for (let i = 0; i < rects.length; i++) {
            for (let j = i + 1; j < rects.length; j++) {
                const [a, [ax, ay, aw, ah]] = rects[i];
                const [b, [bx, by, bw, bh]] = rects[j];
                const overlap = ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
                expect(overlap, `${a} overlaps ${b}`).toBe(false);
            }
        }
    });

    it('gives every tile at least the minimum texel density at the shipped size', () => {
        const scale = atlas.ship.albedo / N;
        for (const [name, t] of Object.entries(atlas.tiles) as [string, { rect: number[]; pad: number; period: number | number[] }][]) {
            const period = Array.isArray(t.period) ? t.period : [t.period, t.period];
            const pxPerMetre = Math.min((t.rect[2] - 2 * t.pad) / period[0], (t.rect[3] - 2 * t.pad) / period[1]) * scale;
            expect(pxPerMetre, name).toBeGreaterThanOrEqual(budgets.atlas.minPixelsPerMetre);
        }
    });

    it('ships the four maps as KTX2 at the sizes of atlas.json, within the byte budget', () => {
        let total = 0;
        for (const map of ['albedo', 'normal', 'arm', 'emissive']) {
            const entry = manifest.atlas[map];
            const data = fs.readFileSync(path.join(KIT_DIR, entry.file));
            expect(data.subarray(0, 12).equals(Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
            expect(data.readUInt32LE(20), map).toBe(atlas.ship[map]);         // pixelWidth
            expect(data.readUInt32LE(24), map).toBe(atlas.ship[map]);         // pixelHeight
            expect(data.readUInt32LE(40), map).toBe(Math.log2(atlas.ship[map]) + 1);   // full mip chain
            expect(data.length).toBe(entry.bytes);
            expect(sha256(data).slice(0, 12)).toBe(entry.hash);
            total += data.length;
        }
        expect(total).toBeLessThanOrEqual(budgets.atlas.maxBytes);
    });
});

describe('building kit (public/models/kit)', () => {
    const regions = atlasRegions();

    it('builds Main Street mostly in the California styles, with many different shop signs', () => {
        // Review finding 11: red brick and sash windows read as the East Coast; a California
        // beach town's downtown is stucco, Mission Revival and Art Deco, with brick on a few
        // older blocks. And three signs repeated along 1.7 km of street front were too few.
        const main = Object.values(kit.groups).filter(g => g.module === 'downtown').flatMap(g => g.pieces);
        const styles = main.map(p => p.style as string);
        expect(styles.filter(s => s === 'brick').length / styles.length).toBeLessThanOrEqual(0.25);
        for (const style of ['stucco', 'mission', 'deco']) expect(styles.filter(s => s === style).length, style).toBeGreaterThanOrEqual(2);
        const signs = new Set<string>();
        for (const [g, spec] of Object.entries(kit.groups)) {
            if (spec.module !== 'downtown') continue;
            const { json } = readGlb(path.join(KIT_DIR, `kit_${g}.glb`));
            for (const n of json.nodes) {
                const shops = (n.extras?.params as { shops?: string[] } | undefined)?.shops ?? [];
                for (const s of shops) if (s !== 'entrance') signs.add(s);
            }
        }
        expect(signs.size).toBeGreaterThanOrEqual(10);
        for (const s of signs) expect(atlas.decals, s).toHaveProperty(s);
    });

    it('has exactly the files of the manifest', () => {
        const listed = [
            'manifest.json',
            ...Object.values(manifest.atlas).map(a => (a as { file: string }).file),
            ...Object.values(manifest.groups).map(g => (g as { file: string }).file)
        ].sort();
        expect(fs.readdirSync(KIT_DIR).sort()).toEqual(listed);
        expect(Object.keys(manifest.groups).sort()).toEqual(Object.keys(kit.groups).sort());
    });

    it('stays within the byte budgets per group and for all groups', () => {
        let total = 0;
        for (const [g, entry] of Object.entries(manifest.groups) as [string, { file: string; bytes: number; hash: string }][]) {
            const data = fs.readFileSync(path.join(KIT_DIR, entry.file));
            expect(data.length, g).toBe(entry.bytes);
            expect(sha256(data).slice(0, 12), g).toBe(entry.hash);
            expect(data.length, g).toBeLessThanOrEqual(budgets.maxBytesPerGroup);
            total += data.length;
        }
        expect(total).toBeLessThanOrEqual(budgets.maxBytesAllGroups);
    });

    it('keeps the worst-case views of budgets.json inside their triangle shares', () => {
        for (const [name, s] of Object.entries(budgets.scenarios) as [string, { group: string; lod0: number; lod1: number; lod2: number; maxTriangles: number }][]) {
            if (name === '_doc') continue;
            const pieces = Object.values(manifest.groups[s.group].pieces) as { lods: { lod: number; triangles: number }[] }[];
            const worst = (lod: number) => Math.max(...pieces.map(p => p.lods.find(l => l.lod === lod)!.triangles));
            const total = s.lod0 * worst(0) + s.lod1 * worst(1) + s.lod2 * worst(2);
            expect(total, name).toBeLessThanOrEqual(s.maxTriangles);
        }
    });

    for (const [group, spec] of Object.entries(kit.groups)) {
        describe(`kit_${group}.glb`, () => {
            const file = path.join(KIT_DIR, `kit_${group}.glb`);
            const { json, bin } = readGlb(file);
            let pieces: ReturnType<typeof piecesOf>;
            beforeAll(() => {
                pieces = piecesOf(new Decoded(json, bin));
            });

            it('uses meshopt, quantisation and the shared KTX2 atlas by reference', () => {
                const used = json.extensionsUsed ?? [];
                for (const e of budgets.requiredExtensions) expect(used).toContain(e);
                for (const e of used) expect(budgets.allowedExtensions).toContain(e);
                expect(json.materials?.map(m => m.name)).toEqual([budgets.requiredMaterial]);
                const images = json.images ?? [];
                for (const img of images) {
                    expect(img.bufferView).toBeUndefined();
                    expect(fs.existsSync(path.join(KIT_DIR, img.uri!)), img.uri).toBe(true);
                }
                const uriOf = (ref: unknown) => {
                    const tex = json.textures![(ref as { index: number }).index];
                    return images[tex.extensions!.KHR_texture_basisu!.source].uri;
                };
                const m = json.materials![0];
                expect(uriOf(m.pbrMetallicRoughness!.baseColorTexture)).toBe(manifest.atlas.albedo.file);
                expect(uriOf(m.pbrMetallicRoughness!.metallicRoughnessTexture)).toBe(manifest.atlas.arm.file);
                expect(uriOf(m.occlusionTexture)).toBe(manifest.atlas.arm.file);
                expect(uriOf(m.normalTexture)).toBe(manifest.atlas.normal.file);
                expect(uriOf(m.emissiveTexture)).toBe(manifest.atlas.emissive.file);
                for (const n of json.nodes) expect(n.rotation ?? [0, 0, 0, 1]).toEqual([0, 0, 0, 1]);
            });

            it('has every piece of kit.json with its LODs, category and LOD distances', () => {
                expect([...pieces.keys()].sort()).toEqual(spec.pieces.map(p => p.id).sort());
                for (const p of spec.pieces) {
                    const got = pieces.get(p.id)!;
                    const category = (p.category as string | undefined) ?? spec.category;
                    const lods = (p.lods as number[] | undefined) ?? [0, 1, 2];
                    expect(got.extras.category, p.id).toBe(category);
                    expect(got.lods.map(l => l.lod), p.id).toEqual(lods);
                    expect(got.extras.lod_distances, p.id).toEqual(kit.lodDistances[category].slice(0, lods.length - 1));
                    for (const [k, v] of Object.entries(p)) if (k !== 'id' && k !== 'category') expect((got.extras.params as Record<string, unknown>)[k], `${p.id} ${k}`).toEqual(v);
                }
            });

            it('keeps every LOD to one primitive and inside the triangle budget of its category', () => {
                for (const [id, p] of pieces) {
                    const cat = budgets.categories[p.extras.category as string];
                    const tris = p.lods.map(l => l.triangles.length);
                    p.lods.forEach((l, i) => {
                        expect(l.primitives, `${id} lod${l.lod}`).toBe(budgets.maxPrimitivesPerLod);
                        expect(tris[i], `${id} lod${l.lod}`).toBeLessThanOrEqual(cat.lods[String(l.lod)].maxTriangles);
                        if (i > 0) expect(tris[i], `${id} lod${l.lod} vs lod${p.lods[i - 1].lod}`).toBeLessThanOrEqual(tris[i - 1]);
                    });
                    // the coarsest LOD at most half of LOD0, unless LOD0 already fits the coarsest LOD's
                    // budget (a small landmark gains nothing from a still coarser copy)
                    const coarsest = cat.lods[String(p.lods[p.lods.length - 1].lod)].maxTriangles;
                    if (tris[0] > coarsest) expect(tris[tris.length - 1], `${id} coarsest LOD`).toBeLessThanOrEqual(tris[0] * budgets.lod2MaxFractionOfLod0);
                    const listed = manifest.groups[group].pieces[id].lods.map((l: { triangles: number }) => l.triangles);
                    expect(tris, `${id} manifest`).toEqual(listed);
                }
            });

            it('fills its declared footprint and height (collider box) with every LOD', () => {
                for (const [id, p] of pieces) {
                    const f = p.extras.footprint as { minX: number; maxX: number; minZ: number; maxZ: number };
                    const over = (p.extras.overhang as number) + 0.35;
                    // buildings fill their lot exactly; props and rocks may shrink a little per LOD
                    const reach = p.extras.category === 'building' ? 0.1 : 0.5;
                    for (const l of p.lods) {
                        const { lo, hi } = bounds(l.positions);
                        const tag = `${id} lod${l.lod}`;
                        expect(lo[0], tag).toBeGreaterThanOrEqual(f.minX - over);
                        expect(hi[0], tag).toBeLessThanOrEqual(f.maxX + over);
                        expect(lo[2], tag).toBeGreaterThanOrEqual(f.minZ - over);
                        expect(hi[2], tag).toBeLessThanOrEqual(f.maxZ + over);
                        // the mesh reaches the footprint edges (no LOD shrinks or shifts the building)
                        expect(lo[0], tag).toBeLessThanOrEqual(f.minX + reach);
                        expect(hi[0], tag).toBeGreaterThanOrEqual(f.maxX - reach);
                        expect(lo[2], tag).toBeLessThanOrEqual(f.minZ + reach);
                        expect(hi[2], tag).toBeGreaterThanOrEqual(f.maxZ - reach);
                        expect(hi[1], tag).toBeLessThanOrEqual((p.extras.height as number) + 0.02);
                        expect(lo[1], tag).toBeGreaterThanOrEqual(-(p.extras.foundation as number) - 0.02);
                    }
                    // the declared collider top is the highest point of the piece (checked on LOD0)
                    const { hi } = bounds(p.lods[0].positions);
                    expect(hi[1], `${id} lod0 top`).toBeGreaterThan((p.extras.height as number) - 0.05);
                }
            });

            it('samples inside one atlas region per triangle', () => {
                const eps = 1 / (atlas.size as number);
                const inside = (r: Region, uv: number[]) =>
                    uv[0] >= r.u0 - eps && uv[0] <= r.u1 + eps && uv[1] >= r.v0 - eps && uv[1] <= r.v1 + eps;
                for (const [id, p] of pieces) {
                    for (const l of p.lods) {
                        let bad = 0;
                        for (const t of l.triangles) {
                            const uvs = t.map(i => l.uvs[i]);
                            if (!regions.some(r => uvs.every(uv => inside(r, uv)))) bad++;
                        }
                        expect(bad, `${id} lod${l.lod}: triangles across atlas regions`).toBe(0);
                    }
                }
            });

            it('keeps the texel density of every tiled material equal across its LODs', () => {
                // A coarser LOD may drop cuts and details but not stretch the texture: brick twice
                // as coarse at LOD2 shows as a jump when the LOD switches (review finding 11).
                // Density = sqrt(UV area / surface area) per triangle, area-weighted median per
                // tile region, LOD0 against every coarser LOD of the same piece.
                const tiles = regions.filter(r => r.name in atlas.tiles);
                const density = (l: LodGeometry) => {
                    const per = new Map<string, { d: number; w: number }[]>();
                    for (const [a, b, c] of l.triangles) {
                        const [pa, pb, pc] = [l.positions[a], l.positions[b], l.positions[c]];
                        const e1 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
                        const e2 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
                        const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
                        const area = Math.sqrt(cr[0] * cr[0] + cr[1] * cr[1] + cr[2] * cr[2]) / 2;
                        if (area < 1e-3) continue;
                        const [ua, ub, uc] = [l.uvs[a], l.uvs[b], l.uvs[c]];
                        const uvArea = Math.abs((ub[0] - ua[0]) * (uc[1] - ua[1]) - (uc[0] - ua[0]) * (ub[1] - ua[1])) / 2;
                        const r = tiles.find(t => [ua, ub, uc].every(uv => uv[0] >= t.u0 - 1e-4 && uv[0] <= t.u1 + 1e-4 && uv[1] >= t.v0 - 1e-4 && uv[1] <= t.v1 + 1e-4));
                        if (!r) continue;
                        const list = per.get(r.name) ?? [];
                        list.push({ d: Math.sqrt(uvArea / area), w: area });
                        per.set(r.name, list);
                    }
                    const out = new Map<string, { median: number; area: number }>();
                    for (const [name, list] of per) {
                        list.sort((x, y) => x.d - y.d);
                        const total = list.reduce((s, x) => s + x.w, 0);
                        let acc = 0;
                        const mid = list.find(x => (acc += x.w) >= total / 2)!;
                        out.set(name, { median: mid.d, area: total });
                    }
                    return out;
                };
                let compared = 0;
                let tiled = 0;
                for (const [id, p] of pieces) {
                    const base = density(p.lods[0]);
                    if ([...base.values()].some(d => d.area >= 4)) tiled++;
                    for (const l of p.lods.slice(1)) {
                        for (const [name, d] of density(l)) {
                            const ref = base.get(name);
                            // a material with only a sliver of surface (a trim, a cap) has no stable median
                            if (!ref || ref.area < 4 || d.area < 4) continue;
                            compared++;
                            expect(d.median / ref.median, `${id} lod${l.lod} ${name}`).toBeCloseTo(1, 1);
                        }
                    }
                }
                // groups built from palette colours only (the guardrails) have nothing to compare
                if (tiled > 0) expect(compared).toBeGreaterThanOrEqual(tiled);
            });

            it('winds every triangle towards its normals and carries tint x AO colours', () => {
                for (const [id, p] of pieces) {
                    for (const l of p.lods) {
                        let flipped = 0;
                        let counted = 0;
                        for (const [a, b, c] of l.triangles) {
                            const [pa, pb, pc] = [l.positions[a], l.positions[b], l.positions[c]];
                            const e1 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
                            const e2 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
                            const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
                            const len = Math.hypot(n[0], n[1], n[2]);
                            if (len < 1e-6) continue;           // slivers carry no orientation
                            counted++;
                            const vn = [0, 1, 2].map(k => l.normals[a][k] + l.normals[b][k] + l.normals[c][k]);
                            if (n[0] * vn[0] + n[1] * vn[1] + n[2] * vn[2] <= 0) flipped++;
                        }
                        expect(counted, `${id} lod${l.lod}`).toBeGreaterThan(0);
                        expect(flipped, `${id} lod${l.lod}: triangles wound against their normals`).toBe(0);
                        // COLOR_0 = linear tint x baked AO (floor 0.35) x ground grime: never black and never
                        // above 1 (the darkest tint, a rust red container, averages about 0.06)
                        let sum = 0;
                        for (const col of l.colors) {
                            expect(Math.max(...col), `${id} lod${l.lod} black vertex`).toBeGreaterThan(0.02);
                            expect(Math.max(...col), `${id} lod${l.lod} colour`).toBeLessThanOrEqual(1.0);
                            sum += (col[0] + col[1] + col[2]) / 3;
                        }
                        expect(sum / l.colors.length, `${id} lod${l.lod} mean colour`).toBeGreaterThan(0.05);
                    }
                }
            });

            it('turns the faces on its footprint sides outwards', () => {
                for (const [id, p] of pieces) {
                    const f = p.extras.footprint as { minX: number; maxX: number; minZ: number; maxZ: number };
                    for (const l of p.lods) {
                        const { checked, inward } = inwardBoundaryFaces(l, f);
                        if (p.extras.category === 'building') expect(checked, `${id} lod${l.lod} outer wall faces`).toBeGreaterThan(20);
                        expect(inward, `${id} lod${l.lod} faces turned into the footprint`).toBe(0);
                    }
                }
            });

            if (['downtown', 'downtown_revival', 'industrial', 'spanish', 'beach', 'landmarks'].includes(group)) {
                it('matches the street frontage of its parameters', () => {
                    for (const p of spec.pieces) {
                        const f = pieces.get(p.id)!.extras.footprint as { minX: number; maxX: number; maxZ: number };
                        if (group === 'landmarks') {
                            // own lots: centred on the street side, which is the lot line
                            expect(f.maxX + f.minX, `${p.id} centred on the lot`).toBeCloseTo(0, 3);
                            expect(f.maxZ, `${p.id} front on the lot line`).toBeCloseTo(0, 3);
                            continue;
                        }
                        const expected = spec.module === 'downtown' ? (p.bays as number) * BAY_DOWNTOWN
                            : group === 'industrial' ? (p.bays as number) * BAY_INDUSTRIAL : (p.width as number);
                        expect(f.maxX - f.minX, p.id).toBeCloseTo(expected, 3);
                        expect(f.maxX + f.minX, `${p.id} centred on the lot`).toBeCloseTo(0, 3);
                        expect(f.maxZ, `${p.id} front on the lot line`).toBeCloseTo(0, 3);
                    }
                });
            }
        });
    }
});
