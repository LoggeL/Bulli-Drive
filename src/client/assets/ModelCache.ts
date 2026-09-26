import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { RenderTier } from '../effects/renderQuality.js';
import { patchCarMaterial } from './carMaterials.js';

// Loads the packed car models (public/models, built by tools/models) once and
// hands out cheap clones. Loading never throws into the game: anything that
// fails is recorded in `errors`, and instantiate() returns null so the caller
// keeps its procedural model (vehicle/CarModel.ts) as the fallback.
//
// The GLTF/KTX2/meshopt loader is injected (assets/gltfLoader.ts in the game,
// a fake in the unit tests), so this class holds no WebGL or network code of
// its own apart from the manifest fetch.

export interface ModelLodEntry {
    lod: number;
    file: string;
    hash: string;
    bytes: number;
    triangles: number;
    primitives: number;
}

export interface ModelEntry {
    name: string;
    wheelRadius: number | null;
    dimensions: { length: number | null; width: number | null; height: number | null; wheelbase: number | null };
    lods: ModelLodEntry[];
}

export interface ModelManifest {
    version: number;
    models: Record<string, ModelEntry>;
}

/** Loads one GLB and returns its scene root. */
export interface ModelLoader {
    load(url: string): Promise<THREE.Object3D>;
}

export type ModelCacheStatus = 'idle' | 'loading' | 'ready' | 'failed';

export interface ModelCacheOptions {
    /** URL of the models directory, with trailing slash */
    baseUrl?: string;
    createLoader: () => Promise<ModelLoader>;
    fetchManifest?: (url: string) => Promise<ModelManifest>;
    /** Per GLB; a model that takes longer counts as failed (fallback) */
    timeoutMs?: number;
}

export interface ModelCacheSnapshot {
    status: ModelCacheStatus;
    loaded: string[];
    errors: string[];
    warmedUp: boolean;
    loadMs: number;
    warmupMs: number;
}

/**
 * LODs to preload per render tier. All tiers keep LOD2 for distant cars; the
 * software tier (no GPU, e2e tests) skips the 25k-triangle LOD0.
 */
export function lodsForTier(tier: RenderTier): number[] {
    return tier === 'software' ? [1, 2] : [0, 1, 2];
}

/**
 * LODs whose wheels are baked into the body per tier: on the phone tier the
 * other players' cars use LOD1 (docs/cars.md), and four separately drawn
 * wheels would cost four draw calls per car. Those wheels no longer spin or
 * steer (LOD2 has its wheels merged in the GLB already).
 */
export function staticWheelLodsForTier(tier: RenderTier): number[] {
    return tier === 'mobile' ? [1] : [];
}

const key = (id: string, lod: number) => `${id}:${lod}`;

async function defaultFetchManifest(url: string): Promise<ModelManifest> {
    // no-cache: revalidate every start (ETag), the manifest names the GLB hashes
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return await response.json() as ModelManifest;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    if (!(ms > 0)) return promise;
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${what}: timeout after ${ms} ms`)), ms);
        promise.then(
            value => { clearTimeout(timer); resolve(value); },
            error => { clearTimeout(timer); reject(error); }
        );
    });
}

export class ModelCache {
    status: ModelCacheStatus = 'idle';
    readonly errors: string[] = [];
    /** LODs whose wheels are merged into the body when loaded (set before preload()) */
    staticWheelLods: number[] = [];
    /** Textures dropped because another LOD of the model carries the same image */
    sharedTextureCount = 0;
    private readonly textures = new Map<string, THREE.Texture>();
    private manifest: ModelManifest | null = null;
    private readonly templates = new Map<string, THREE.Object3D>();
    private readonly baseUrl: string;
    private readonly timeoutMs: number;
    private preloadPromise: Promise<void> | null = null;
    private warmupPromise: Promise<void> | null = null;
    private warmedUp = false;
    private loadMs = 0;
    private warmupMs = 0;
    private disposed = false;
    // Model files per model id: requested, and loaded or failed (the loading screen's counters)
    private readonly filesRequested = new Map<string, number>();
    private readonly filesSettled = new Map<string, number>();

    constructor(private readonly options: ModelCacheOptions) {
        this.baseUrl = options.baseUrl ?? '/models/';
        this.timeoutMs = options.timeoutMs ?? 30_000;
    }

    /**
     * Loads the manifest and the given LODs of the given models (all models by
     * default). Idempotent: later calls return the first call's promise. The
     * promise always resolves; check status/errors or has().
     */
    preload(lods: number[], ids?: string[]): Promise<void> {
        this.preloadPromise ??= this.load(lods, ids);
        return this.preloadPromise;
    }

    /** Resolves once preload() has finished (true = at least one model loaded). */
    async whenLoaded(): Promise<boolean> {
        if (this.preloadPromise) await this.preloadPromise;
        return this.templates.size > 0;
    }

    private async load(lods: number[], ids?: string[]): Promise<void> {
        const t0 = performance.now();
        this.status = 'loading';
        try {
            const fetchManifest = this.options.fetchManifest ?? defaultFetchManifest;
            this.manifest = await withTimeout(fetchManifest(`${this.baseUrl}manifest.json`), this.timeoutMs, 'manifest');
            const loader = await this.options.createLoader();
            const jobs: Promise<void>[] = [];
            for (const id of ids ?? Object.keys(this.manifest.models)) {
                const entry = this.manifest.models[id];
                if (!entry) {
                    this.errors.push(`${id}: not in the manifest`);
                    continue;
                }
                for (const lodEntry of entry.lods) {
                    if (!lods.includes(lodEntry.lod)) continue;
                    const url = `${this.baseUrl}${lodEntry.file}?v=${lodEntry.hash}`;
                    this.filesRequested.set(id, (this.filesRequested.get(id) ?? 0) + 1);
                    const settle = () => this.filesSettled.set(id, (this.filesSettled.get(id) ?? 0) + 1);
                    jobs.push(withTimeout(loader.load(url), this.timeoutMs, lodEntry.file).finally(settle).then(
                        root => {
                            if (this.disposed) return;
                            const template = prepareTemplate(root, id, lodEntry.lod, this.staticWheelLods.includes(lodEntry.lod));
                            this.sharedTextureCount += shareTextures(template, id, this.textures);
                            this.templates.set(key(id, lodEntry.lod), template);
                        },
                        error => {
                            this.errors.push(`${lodEntry.file}: ${error instanceof Error ? error.message : String(error)}`);
                        }
                    ));
                }
            }
            await Promise.all(jobs);
            this.status = this.templates.size > 0 ? 'ready' : 'failed';
        } catch (error) {
            this.errors.push(error instanceof Error ? error.message : String(error));
            this.status = 'failed';
        }
        this.loadMs = Math.round(performance.now() - t0);
        if (this.errors.length) console.warn('[models] falling back to procedural cars for:', this.errors);
    }

    /**
     * Model files of the given models (all by default) that loaded or failed,
     * and how many were requested: [0, 0] until the manifest is in.
     */
    fileProgress(ids?: readonly string[]): [settled: number, requested: number] {
        let settled = 0, requested = 0;
        for (const [id, count] of this.filesRequested) {
            if (ids && !ids.includes(id)) continue;
            requested += count;
            settled += this.filesSettled.get(id) ?? 0;
        }
        return [settled, requested];
    }

    /** Manifest data of a model (dimensions, wheel radius, LOD sizes). */
    entry(id: string): ModelEntry | null {
        return this.manifest?.models[id] ?? null;
    }

    has(id: string, lod: number): boolean {
        return this.templates.has(key(id, lod));
    }

    /** The loaded LOD closest to `wanted` (ties go to the more detailed one), or null. */
    bestLod(id: string, wanted: number): number | null {
        let best: number | null = null;
        for (const lod of this.entry(id)?.lods.map(l => l.lod) ?? []) {
            if (!this.has(id, lod)) continue;
            const better = best === null
                || Math.abs(lod - wanted) < Math.abs(best - wanted)
                || (Math.abs(lod - wanted) === Math.abs(best - wanted) && lod < best);
            if (better) best = lod;
        }
        return best;
    }

    /**
     * A new instance of a model, or null when it is not loaded (use the
     * procedural model then). Geometry, materials and textures are shared
     * with the cache: clone a material before changing it per car (paint
     * colour, ghost opacity) and never dispose shared resources.
     */
    instantiate(id: string, lod: number): THREE.Object3D | null {
        const template = this.templates.get(key(id, lod));
        return template ? template.clone(true) : null;
    }

    /**
     * Compiles the shaders and uploads the textures of every loaded model with
     * the lights, fog and environment of `scene`, so the first car that
     * appears does not stall a frame. Resolves once done (or failed).
     */
    warmup(renderer: THREE.WebGLRenderer, camera: THREE.Camera, scene: THREE.Scene): Promise<void> {
        this.warmupPromise ??= this.runWarmup(renderer, camera, scene);
        return this.warmupPromise;
    }

    private async runWarmup(renderer: THREE.WebGLRenderer, camera: THREE.Camera, scene: THREE.Scene): Promise<void> {
        await this.whenLoaded();
        if (this.templates.size === 0 || this.disposed) return;
        const t0 = performance.now();
        const holder = new THREE.Group();
        for (const template of this.templates.values()) {
            const instance = template.clone(true);
            // Hidden parts (surfboard) have their own materials too
            instance.traverse(child => { child.visible = true; });
            holder.add(instance);
        }
        try {
            const textures = new Set<THREE.Texture>();
            holder.traverse(child => {
                const mesh = child as THREE.Mesh;
                if (!mesh.isMesh) return;
                for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
                    for (const value of Object.values(material)) {
                        if ((value as THREE.Texture)?.isTexture) textures.add(value as THREE.Texture);
                    }
                }
            });
            for (const texture of textures) renderer.initTexture(texture);
            if (typeof renderer.compileAsync === 'function') {
                await renderer.compileAsync(holder, camera, scene);
            } else {
                renderer.compile(holder, camera, scene);
            }
            this.warmedUp = true;
        } catch (error) {
            this.errors.push(`warmup: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.warmupMs = Math.round(performance.now() - t0);
    }

    snapshot(): ModelCacheSnapshot {
        return {
            status: this.status,
            loaded: [...this.templates.keys()].sort(),
            errors: [...this.errors],
            warmedUp: this.warmedUp,
            loadMs: this.loadMs,
            warmupMs: this.warmupMs
        };
    }

    /** Frees every GPU resource of the cached models (instances become invalid). */
    dispose(): void {
        this.disposed = true;
        for (const template of this.templates.values()) {
            template.traverse(child => {
                const mesh = child as THREE.Mesh;
                if (!mesh.isMesh) return;
                mesh.geometry.dispose();
                for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
                    for (const value of Object.values(material)) {
                        if ((value as THREE.Texture)?.isTexture) (value as THREE.Texture).dispose();
                    }
                    material.dispose();
                }
            });
        }
        this.templates.clear();
        this.textures.clear();
    }
}

// --- One-time template setup ----------------------------------------------------------

// Cheap content key of a texture: LOD0 and LOD1 of a car embed the same atlas
// images (same size, bytes and sampling), which would otherwise be
// transcoded, uploaded and kept on the GPU twice
function textureKey(texture: THREE.Texture, id: string): string | null {
    const mip = (texture as THREE.CompressedTexture).mipmaps?.[0] as { data?: ArrayBufferView; width: number; height: number } | undefined;
    const data = mip?.data;
    if (!data) return null;
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    let hash = 2166136261;
    const step = Math.max(1, Math.floor(bytes.length / 4096));
    for (let i = 0; i < bytes.length; i += step) hash = Math.imul(hash ^ bytes[i], 16777619);
    return [
        id, texture.name, mip.width, mip.height, bytes.length, hash >>> 0, texture.format, texture.colorSpace,
        texture.channel, texture.flipY, texture.wrapS, texture.wrapT,
        ...texture.offset.toArray(), ...texture.repeat.toArray(), texture.rotation
    ].join('|');
}

/** Points the materials of `root` at textures already loaded with the same content; returns how many were shared. */
function shareTextures(root: THREE.Object3D, id: string, known: Map<string, THREE.Texture>): number {
    let shared = 0;
    root.traverse(child => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            const slots = material as unknown as Record<string, unknown>;
            for (const [slot, value] of Object.entries(slots)) {
                const texture = value as THREE.Texture;
                if (!texture?.isTexture) continue;
                const k = textureKey(texture, id);
                if (!k) continue;
                const existing = known.get(k);
                if (!existing) {
                    known.set(k, texture);
                } else if (existing !== texture) {
                    slots[slot] = existing;
                    texture.dispose();
                    shared++;
                }
            }
        }
    });
    return shared;
}

// Plain float attributes (the GLBs are quantized: KHR_mesh_quantization), so
// geometries of different nodes can be transformed and merged
function floatGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    for (const [name, attribute] of Object.entries(source.attributes)) {
        const a = attribute as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
        const array = new Float32Array(a.count * a.itemSize);
        const get = [a.getX, a.getY, a.getZ, a.getW].map(getter => getter.bind(a));
        for (let i = 0; i < a.count; i++) {
            for (let c = 0; c < a.itemSize; c++) array[i * a.itemSize + c] = get[c](i);
        }
        geometry.setAttribute(name, new THREE.BufferAttribute(array, a.itemSize));
    }
    if (source.index) geometry.setIndex(Array.from(source.index.array));
    return geometry;
}

/**
 * Bakes the wheels into the body: each wheel mesh is merged with the body
 * mesh of the same material (the atlas), in the model's space. The wheel
 * pivots stay (empty), so the car code needs no special case.
 */
function mergeStaticWheels(root: THREE.Object3D): void {
    root.updateMatrixWorld(true);
    const toRoot = root.matrixWorld.clone().invert();
    const wheelMeshes: THREE.Mesh[] = [];
    const bodyMeshes: THREE.Mesh[] = [];
    root.traverse(child => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh || Array.isArray(mesh.material)) return;
        let node: THREE.Object3D | null = mesh;
        let wheel = false, hidden = false;
        while (node && node !== root) {
            if (/^wheel_(fl|fr|rl|rr)$/.test(node.name)) wheel = true;
            if (!node.visible) hidden = true;
            node = node.parent;
        }
        if (hidden) return;
        (wheel ? wheelMeshes : bodyMeshes).push(mesh);
    });
    for (const material of new Set(wheelMeshes.map(mesh => mesh.material as THREE.Material))) {
        const wheels = wheelMeshes.filter(mesh => mesh.material === material);
        const body = bodyMeshes.find(mesh => mesh.material === material)
            ?? bodyMeshes.find(mesh => (mesh.material as THREE.Material).name === material.name);
        const parts = body ? [body, ...wheels] : wheels;
        const geometries = parts.map(mesh => {
            const geometry = floatGeometry(mesh.geometry);
            geometry.applyMatrix4(toRoot.clone().multiply(mesh.matrixWorld));
            return geometry;
        });
        const merged = mergeGeometries(geometries);
        for (const geometry of geometries) geometry.dispose();
        if (!merged) continue;
        const mesh = new THREE.Mesh(merged, material);
        mesh.name = `${body?.name || 'body'}_static_wheels`;
        for (const part of parts) part.removeFromParent();
        root.add(mesh);
    }
}

/**
 * One-time setup of a loaded model: names it, applies the node conventions of
 * tools/models/README.md (accessories hidden unless default_visible), the
 * game's shader patches (Fresnel glass, lamps; assets/carMaterials.ts) and
 * the shadow flags (transparent glass and the ground blob
 * cast no shadow).
 */
function prepareTemplate(root: THREE.Object3D, id: string, lod: number, staticWheels = false): THREE.Object3D {
    root.name = `model_${id}_lod${lod}`;
    root.userData.modelId = id;
    root.userData.lod = lod;
    root.traverse(child => {
        if (child.userData.default_visible === false) child.visible = false;
    });
    if (staticWheels) {
        mergeStaticWheels(root);
        root.userData.staticWheels = true;
    }
    root.traverse(child => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) patchCarMaterial(material);
        const transparent = materials.some(material => material.transparent);
        mesh.castShadow = !transparent;
        mesh.receiveShadow = !transparent;
    });
    return root;
}
