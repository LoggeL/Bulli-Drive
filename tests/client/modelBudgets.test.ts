import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BILLBOARD_TEXTURES, HERO_PROP_MODELS } from '../../src/shared/map/discoverySchema.js';
import { sha256 } from '../helpers.js';

// Budget and convention checks of the committed, packed assets (tools/models,
// tools/textures). They read only the GLB JSON chunk and the KTX2 headers, so
// they need no decoder: triangle counts come from the index accessor counts,
// which meshopt compression leaves in the JSON.

const ROOT = path.resolve(__dirname, '../..');
const MODELS_DIR = path.join(ROOT, 'public/models');
const TEXTURES_DIR = path.join(ROOT, 'public/textures');
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

const budgets = readJson(path.join(ROOT, 'tools/models/budgets.json'));
const registry = readJson(path.join(ROOT, 'tools/models/models.json')).models as Record<string, { lods: number[] }>;
const manifest = readJson(path.join(MODELS_DIR, 'manifest.json'));
const propsManifest = readJson(path.join(MODELS_DIR, 'props/manifest.json'));
const textureManifest = readJson(path.join(TEXTURES_DIR, 'manifest.json'));
const biomesManifest = readJson(path.join(TEXTURES_DIR, 'biomes/manifest.json'));
const billboardsManifest = readJson(path.join(TEXTURES_DIR, 'billboards/manifest.json'));

function isPowerOfTwo(n: number): boolean {
    return n > 0 && (n & (n - 1)) === 0;
}

// All new binary assets together (models + textures + HDRIs), see docs/assets.md
const MAX_PUBLIC_ASSET_BYTES = 30 * 1024 * 1024;
// Car types of src/client/vehicle/CarModel.ts
const CAR_TYPES = ['bulli', 'pickup', 'sport', 'beetle', 'jeep'];

interface GltfNode { name?: string; mesh?: number; children?: number[]; extras?: Record<string, unknown> }
interface Gltf {
    asset: { version: string };
    nodes: GltfNode[];
    meshes: { primitives: { indices?: number; mode?: number; material?: number; attributes: Record<string, number> }[] }[];
    accessors: { count: number }[];
    materials?: { name?: string; extensions?: Record<string, unknown> }[];
    images?: { mimeType?: string }[];
    textures?: { source?: number; extensions?: Record<string, { source: number }> }[];
    extensionsUsed?: string[];
    extensionsRequired?: string[];
}

function readGlbJson(file: string): Gltf {
    const data = fs.readFileSync(file);
    // 'glTF', version 2, total length, then the 'JSON' chunk
    if (data.readUInt32LE(0) !== 0x46546c67 || data.readUInt32LE(4) !== 2 || data.readUInt32LE(8) !== data.length
        || data.readUInt32LE(16) !== 0x4e4f534a) {
        throw new Error(`${file} is not a GLB 2.0 file with a JSON chunk`);
    }
    const jsonLength = data.readUInt32LE(12);
    return JSON.parse(data.subarray(20, 20 + jsonLength).toString('utf8')) as Gltf;
}

function countGeometry(gltf: Gltf): { triangles: number; primitives: number } {
    let triangles = 0;
    let primitives = 0;
    for (const node of gltf.nodes) {
        if (node.mesh === undefined) continue;
        for (const prim of gltf.meshes[node.mesh].primitives) {
            expect(prim.mode ?? 4).toBe(4);                  // triangles only
            primitives++;
            const count = prim.indices !== undefined
                ? gltf.accessors[prim.indices].count
                : gltf.accessors[prim.attributes.POSITION].count;
            triangles += count / 3;
        }
    }
    return { triangles, primitives };
}

function ktx2Header(file: string) {
    const data = fs.readFileSync(file);
    const magic = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(data.subarray(0, 12).equals(magic)).toBe(true);
    return {
        vkFormat: data.readUInt32LE(12),
        width: data.readUInt32LE(20),
        height: data.readUInt32LE(24),
        levels: data.readUInt32LE(40),
        supercompression: data.readUInt32LE(44),
        bytes: data.length
    };
}

describe('car models (public/models)', () => {
    const ids = Object.keys(manifest.models);

    it('lists every model of tools/models/models.json and only known car types', () => {
        expect(ids.sort()).toEqual(Object.keys(registry).sort());
        for (const id of ids) expect(CAR_TYPES).toContain(id);
    });

    it('has a Blender model for every car type, with the stricter budgets for the cars after the T1', () => {
        expect(ids.sort()).toEqual([...CAR_TYPES].sort());
        for (const id of ['beetle', 'pickup', 'sport', 'jeep']) {
            expect(budgets.modelTriangles[id]).toEqual({ 0: 20000, 1: 7000, 2: 2000 });
        }
    });

    it('has exactly the GLBs the manifest names', () => {
        const listed = ids.flatMap(id => manifest.models[id].lods.map((l: { file: string }) => l.file)).sort();
        const onDisk = fs.readdirSync(MODELS_DIR).filter(f => f.endsWith('.glb')).sort();
        expect(onDisk).toEqual(listed);
    });

    for (const id of ids) {
        const entry = manifest.models[id];

        it(`${id}: LODs ${registry[id]?.lods.join('/')} with wheel radius and dimensions`, () => {
            expect(entry.lods.map((l: { lod: number }) => l.lod)).toEqual(registry[id].lods);
            expect(entry.wheelRadius).toBeGreaterThan(0.2);
            expect(entry.wheelRadius).toBeLessThan(0.5);
            expect(entry.dimensions.length).toBeGreaterThan(3);
            expect(entry.dimensions.length).toBeLessThan(5);
            const total = entry.lods.reduce((sum: number, l: { bytes: number }) => sum + l.bytes, 0);
            expect(total).toBeLessThanOrEqual(budgets.maxBytesPerModel);
        });

        for (const lodEntry of entry.lods) {
            describe(`${id} LOD${lodEntry.lod}`, () => {
                const file = path.join(MODELS_DIR, lodEntry.file);
                const budget = budgets.lods[String(lodEntry.lod)];
                const gltf = readGlbJson(file);
                const byName = new Map(gltf.nodes.map(n => [n.name ?? '', n]));

                it('matches the manifest (bytes, hash, triangles, primitives)', () => {
                    const data = fs.readFileSync(file);
                    expect(data.length).toBe(lodEntry.bytes);
                    expect(sha256(data).slice(0, 12)).toBe(lodEntry.hash);
                    expect(countGeometry(gltf)).toEqual({ triangles: lodEntry.triangles, primitives: lodEntry.primitives });
                });

                it('stays within the triangle, draw call and size budget', () => {
                    const { triangles, primitives } = countGeometry(gltf);
                    expect(triangles).toBeLessThanOrEqual(budget.maxTriangles);
                    // Stricter per-model limits (the cars after the T1: 20k / 7k / 2k)
                    const modelLimit = budgets.modelTriangles?.[id]?.[String(lodEntry.lod)];
                    if (modelLimit !== undefined) expect(triangles).toBeLessThanOrEqual(modelLimit);
                    expect(primitives).toBeLessThanOrEqual(budget.maxPrimitives);
                    expect(fs.statSync(file).size).toBeLessThanOrEqual(budget.maxBytes);
                });

                it('has the required nodes, root and paint material', () => {
                    expect(byName.has(`car_${id}`)).toBe(true);
                    for (const name of budgets.requiredNodes) expect(byName.has(name), name).toBe(true);
                    const materials = (gltf.materials ?? []).map(m => m.name);
                    for (const name of budgets.requiredMaterials) expect(materials).toContain(name);
                });

                it('has wheel pivots with radius/steer extras on the axles', () => {
                    for (const wheel of ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr']) {
                        const extras = byName.get(wheel)!.extras ?? {};
                        expect(extras.role).toBe('wheel');
                        expect(extras.radius).toBeCloseTo(entry.wheelRadius, 3);
                        expect(extras.steer).toBe(wheel.startsWith('wheel_f'));
                        expect(extras.side).toBe(wheel.endsWith('l') ? 'left' : 'right');
                    }
                });

                it('hides the surfboard accessory by default', () => {
                    expect(byName.get('accessory_surfboard')!.extras?.default_visible).toBe(false);
                });

                it('uses meshopt, quantisation and KTX2 textures only', () => {
                    const used = gltf.extensionsUsed ?? [];
                    for (const ext of budgets.requiredExtensions) expect(used).toContain(ext);
                    for (const ext of used) expect(budgets.allowedExtensions).toContain(ext);
                    expect(gltf.extensionsRequired ?? []).toContain('EXT_meshopt_compression');
                    for (const image of gltf.images ?? []) expect(image.mimeType).toBe('image/ktx2');
                    for (const texture of gltf.textures ?? []) {
                        expect(texture.source).toBeUndefined();
                        expect(texture.extensions?.KHR_texture_basisu).toBeDefined();
                    }
                });
            });
        }
    }
});

describe('textures (public/textures)', () => {
    const entries = Object.entries(textureManifest.textures) as [string, {
        file: string; kind: string; width: number; height: number; bytes: number; hash: string; encoding: string;
    }][];

    it('has a KTX2 file for every manifest entry and no strays', () => {
        // Subdirectories owned by public/textures/manifest.json (biomes/ and billboards/ have their own manifests below)
        const ownDirs = new Set(entries.map(([, e]) => e.file.split('/')[0]));
        const onDisk: string[] = [];
        for (const dir of fs.readdirSync(TEXTURES_DIR, { withFileTypes: true })) {
            if (!dir.isDirectory() || !ownDirs.has(dir.name)) continue;
            for (const f of fs.readdirSync(path.join(TEXTURES_DIR, dir.name))) {
                if (f.endsWith('.ktx2')) onDisk.push(`${dir.name}/${f}`);
            }
        }
        expect(onDisk.sort()).toEqual(entries.map(([, e]) => e.file).sort());
    });

    for (const [key, entry] of entries) {
        it(`${key}: Basis KTX2 with mipmaps, ${entry.width}x${entry.height}`, () => {
            const header = ktx2Header(path.join(TEXTURES_DIR, entry.file));
            expect(header.vkFormat).toBe(0);                       // Basis Universal (transcoded)
            expect(header.width).toBe(entry.width);
            expect(header.height).toBe(entry.height);
            expect(header.bytes).toBe(entry.bytes);
            expect(header.levels).toBe(Math.floor(Math.log2(Math.max(entry.width, entry.height))) + 1);
            // 1 = BasisLZ (ETC1S), 2 = Zstandard (UASTC)
            expect(header.supercompression).toBe(entry.encoding === 'etc1s' ? 1 : 2);
            if (entry.kind === 'normal') expect(entry.encoding).toBe('uastc');
            expect(Math.max(entry.width, entry.height)).toBeLessThanOrEqual(1024);
        });
    }

    it('names a CC0 source and tile size for every PBR material', () => {
        for (const [role, material] of Object.entries(textureManifest.materials) as [string, Record<string, unknown>][]) {
            expect(material.license, role).toBe('CC0-1.0');
            expect(String(material.source)).toMatch(/^https:\/\/polyhaven\.com\/a\//);
            expect(material.tileMeters, role).toBeGreaterThan(0);
            // Every published map is shipped, the albedo always (the lawns
            // publish only theirs, tools/textures/textures.json)
            expect(material.albedo, `${role} albedo`).toBeDefined();
            for (const map of ['albedo', 'normal', 'arm']) {
                if (material[map] === undefined) continue;
                expect(textureManifest.textures[material[map] as string], `${role} ${map}`).toBeDefined();
            }
        }
    });

    it('ships the HDRIs as Radiance files', () => {
        for (const hdri of Object.values(textureManifest.hdri) as { file: string; bytes: number }[]) {
            const data = fs.readFileSync(path.join(TEXTURES_DIR, hdri.file));
            expect(data.length).toBe(hdri.bytes);
            expect(data.subarray(0, 10).toString('latin1')).toBe('#?RADIANCE');
        }
    });
});

describe('hero monuments & easter-egg props (public/models/props)', () => {
    const propsDir = path.join(MODELS_DIR, 'props');
    const entries = Object.entries(propsManifest.props) as [string, {
        file: string; kind: 'monument' | 'prop'; hash: string; bytes: number; triangles: number;
        bounds: { min: number[]; max: number[] }; animNodes?: string[]; billboardNode?: string;
    }][];

    it('uses the three-plane-flipY-true UV convention and covers every HERO_PROP_MODELS id with zero strays', () => {
        expect(propsManifest.billboardUvConvention).toBe('three-plane-flipY-true');
        expect(entries.map(([id]) => id).sort()).toEqual([...HERO_PROP_MODELS].sort());
        const onDisk = fs.readdirSync(propsDir).filter(f => f.endsWith('.glb')).sort();
        expect(onDisk).toEqual(entries.map(([, e]) => e.file).sort());
    });

    for (const [id, entry] of entries) {
        it(`${id}: meshopt GLB, valid hash/tris/budget/nodes`, () => {
            const file = path.join(propsDir, entry.file);
            const data = fs.readFileSync(file);
            expect(data.length).toBe(entry.bytes);
            expect(sha256(data).slice(0, 12)).toBe(entry.hash);
            const gltf = readGlbJson(file);
            const { triangles } = countGeometry(gltf);
            expect(triangles).toBe(entry.triangles);
            expect(triangles).toBeLessThanOrEqual(entry.kind === 'monument' ? 10000 : 4000);
            expect(data.length).toBeLessThanOrEqual(150 * 1024);

            const used = gltf.extensionsUsed ?? [];
            expect(used).toContain('EXT_meshopt_compression');
            expect(used).not.toContain('KHR_draco_mesh_compression');
            for (const image of gltf.images ?? []) expect(image.mimeType).toBe('image/ktx2');

            const nodeNames = new Set(gltf.nodes.map(n => n.name ?? ''));
            for (const anim of entry.animNodes ?? []) expect(nodeNames.has(anim), `${id} animNode ${anim}`).toBe(true);
            if (entry.billboardNode) expect(nodeNames.has(entry.billboardNode), `${id} billboardNode`).toBe(true);
        });
    }
});

describe('biome PBR textures (public/textures/biomes)', () => {
    const biomesDir = path.join(TEXTURES_DIR, 'biomes');
    const entries = Object.entries(biomesManifest.textures) as [string, {
        file: string; kind: string; width: number; height: number; encoding: string; bytes: number; hash: string;
    }][];

    it('declares flipY: true and has zero stray KTX2 files', () => {
        expect(biomesManifest.flipY).toBe(true);
        const onDisk = fs.readdirSync(biomesDir).filter(f => f.endsWith('.ktx2')).sort();
        expect(onDisk).toEqual(entries.map(([, e]) => e.file).sort());
    });

    for (const [key, entry] of entries) {
        it(`${key}: Basis KTX2, POT <= 1024, exact hash & mipmaps`, () => {
            const file = path.join(biomesDir, entry.file);
            const data = fs.readFileSync(file);
            expect(sha256(data).slice(0, 16)).toBe(entry.hash);
            const header = ktx2Header(file);
            expect(header.vkFormat).toBe(0);
            expect(header.width).toBe(entry.width);
            expect(header.height).toBe(entry.height);
            expect(header.bytes).toBe(entry.bytes);
            expect(isPowerOfTwo(entry.width)).toBe(true);
            expect(isPowerOfTwo(entry.height)).toBe(true);
            expect(Math.max(entry.width, entry.height)).toBeLessThanOrEqual(1024);
            expect(header.levels).toBe(Math.floor(Math.log2(Math.max(entry.width, entry.height))) + 1);
            expect(header.supercompression).toBe(entry.encoding === 'etc1s' ? 1 : 2);
            if (entry.kind === 'normal') expect(entry.encoding).toBe('uastc');
        });
    }

    it('ships complete albedo + normal + arm maps for every biome material set', () => {
        for (const [setName, mat] of Object.entries(biomesManifest.materials) as [string, Record<string, unknown>][]) {
            expect(mat.tileMeters, setName).toBeGreaterThan(0);
            for (const map of ['albedo', 'normal', 'arm']) {
                expect(biomesManifest.textures[mat[map] as string], `${setName} ${map}`).toBeDefined();
            }
        }
    });
});

describe('billboard & decal textures (public/textures/billboards)', () => {
    const billboardsDir = path.join(TEXTURES_DIR, 'billboards');
    const entries = Object.entries(billboardsManifest.textures) as [string, {
        file: string; kind: string; width: number; height: number; encoding: string; bytes: number; hash: string;
    }][];

    it('declares flipY: true, covers every BILLBOARD_TEXTURES id, and has zero strays', () => {
        expect(billboardsManifest.flipY).toBe(true);
        expect(entries.map(([id]) => id).sort()).toEqual([...BILLBOARD_TEXTURES].sort());
        const onDisk = fs.readdirSync(billboardsDir).filter(f => f.endsWith('.ktx2')).sort();
        expect(onDisk).toEqual(entries.map(([, e]) => e.file).sort());
    });

    for (const [key, entry] of entries) {
        it(`${key}: Basis ETC1S KTX2, POT <= 1024, exact hash & mipmaps`, () => {
            const file = path.join(billboardsDir, entry.file);
            const data = fs.readFileSync(file);
            expect(sha256(data).slice(0, 16)).toBe(entry.hash);
            const header = ktx2Header(file);
            expect(header.vkFormat).toBe(0);
            expect(header.width).toBe(entry.width);
            expect(header.height).toBe(entry.height);
            expect(header.bytes).toBe(entry.bytes);
            expect(isPowerOfTwo(entry.width)).toBe(true);
            expect(isPowerOfTwo(entry.height)).toBe(true);
            expect(Math.max(entry.width, entry.height)).toBeLessThanOrEqual(1024);
            expect(header.levels).toBe(Math.floor(Math.log2(Math.max(entry.width, entry.height))) + 1);
            expect(header.supercompression).toBe(entry.encoding === 'etc1s' ? 1 : 2);
        });
    }
});

describe('asset size', () => {
    it(`keeps public/models + public/textures under ${MAX_PUBLIC_ASSET_BYTES / 1024 / 1024} MB`, () => {
        let total = 0;
        const walk = (dir: string) => {
            for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, item.name);
                if (item.isDirectory()) walk(p);
                else total += fs.statSync(p).size;
            }
        };
        walk(MODELS_DIR);
        walk(TEXTURES_DIR);
        expect(total).toBeLessThanOrEqual(MAX_PUBLIC_ASSET_BYTES);
    });
});
