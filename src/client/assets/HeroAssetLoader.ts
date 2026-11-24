import * as THREE from 'three';
import type { BillboardTextureId, HeroPropModelId } from '../../shared/map/discoverySchema.js';
import type { MapData } from '../../shared/map/mapData.js';
import { getKTX2Loader } from './gltfLoader.js';

// Lazy per-map asset loader for hero monuments/easter-egg props (public/models/props/)
// and custom lore billboards/decals (public/textures/billboards/).
// - Never loads assets that the active map does not reference (Bulli Bay skips all
//   Forge Island monuments; Forge Island only downloads what it places).
// - Shares a single GLTFLoader + MeshoptDecoder and the page's KTX2Loader.
// - Shares geometry and base materials across instances of the same prop model.
// - Provides deterministic neutral placeholders / primitive stand-ins on failure
//   or while streaming, so map load never blocks or shows black meshes.

export interface PropManifestEntry {
    file: string;
    kind: 'monument' | 'prop';
    hash: string;
    bytes: number;
    triangles: number;
    bounds: { min: [number, number, number]; max: [number, number, number] };
    animNodes?: string[];
    billboardNode?: string;
}

export interface PropsManifest {
    version: number;
    billboardUvConvention?: string;
    props: Record<string, PropManifestEntry>;
}

export interface BillboardManifestEntry {
    file: string;
    kind: 'color';
    width: number;
    height: number;
    encoding: 'etc1s' | 'uastc';
    bytes: number;
    hash: string;
    category?: 'sign' | 'decal';
}

export interface BillboardsManifest {
    version: number;
    flipY?: boolean;
    textures: Record<string, BillboardManifestEntry>;
}

export interface LoadedPropTemplate {
    modelId: HeroPropModelId;
    entry: PropManifestEntry | null;
    scene: THREE.Group;
    animNodes: string[];
    billboardNode?: string;
    isFallback: boolean;
}

const PROPS_BASE = `${import.meta.env.BASE_URL}models/props/`;
const BILLBOARDS_BASE = `${import.meta.env.BASE_URL}textures/billboards/`;

// ---- Pure manifest & map-dependency helpers (unit-tested directly) ----

export function parsePropsManifest(raw: unknown): PropsManifest {
    if (!raw || typeof raw !== 'object') throw new Error('props manifest must be an object');
    const obj = raw as Record<string, unknown>;
    if (typeof obj.version !== 'number') throw new Error('props manifest missing numeric version');
    if (!obj.props || typeof obj.props !== 'object') throw new Error('props manifest missing props map');
    const props: Record<string, PropManifestEntry> = {};
    for (const [id, entry] of Object.entries(obj.props as Record<string, unknown>)) {
        if (!entry || typeof entry !== 'object') throw new Error(`props manifest entry ${id} invalid`);
        const e = entry as Record<string, unknown>;
        if (typeof e.file !== 'string' || typeof e.hash !== 'string' || typeof e.bytes !== 'number' || typeof e.triangles !== 'number') {
            throw new Error(`props manifest entry ${id} missing required fields`);
        }
        const bounds = e.bounds as { min?: unknown; max?: unknown } | undefined;
        if (!bounds || !Array.isArray(bounds.min) || bounds.min.length !== 3 || !Array.isArray(bounds.max) || bounds.max.length !== 3) {
            throw new Error(`props manifest entry ${id} missing 3-tuple bounds`);
        }
        props[id] = {
            file: e.file,
            kind: e.kind === 'monument' ? 'monument' : 'prop',
            hash: e.hash,
            bytes: e.bytes,
            triangles: e.triangles,
            bounds: {
                min: [Number(bounds.min[0]), Number(bounds.min[1]), Number(bounds.min[2])],
                max: [Number(bounds.max[0]), Number(bounds.max[1]), Number(bounds.max[2])]
            },
            animNodes: Array.isArray(e.animNodes) ? e.animNodes.map(String) : undefined,
            billboardNode: typeof e.billboardNode === 'string' ? e.billboardNode : undefined
        };
    }
    return {
        version: obj.version,
        billboardUvConvention: typeof obj.billboardUvConvention === 'string' ? obj.billboardUvConvention : undefined,
        props
    };
}

export function parseBillboardsManifest(raw: unknown): BillboardsManifest {
    if (!raw || typeof raw !== 'object') throw new Error('billboards manifest must be an object');
    const obj = raw as Record<string, unknown>;
    if (typeof obj.version !== 'number') throw new Error('billboards manifest missing numeric version');
    if (!obj.textures || typeof obj.textures !== 'object') throw new Error('billboards manifest missing textures map');
    const textures: Record<string, BillboardManifestEntry> = {};
    for (const [id, entry] of Object.entries(obj.textures as Record<string, unknown>)) {
        if (!entry || typeof entry !== 'object') throw new Error(`billboards manifest entry ${id} invalid`);
        const e = entry as Record<string, unknown>;
        if (typeof e.file !== 'string' || typeof e.hash !== 'string' || typeof e.width !== 'number' || typeof e.height !== 'number' || typeof e.bytes !== 'number') {
            throw new Error(`billboards manifest entry ${id} missing required fields`);
        }
        textures[id] = {
            file: e.file,
            kind: 'color',
            width: e.width,
            height: e.height,
            encoding: e.encoding === 'uastc' ? 'uastc' : 'etc1s',
            bytes: e.bytes,
            hash: e.hash,
            category: e.category === 'decal' ? 'decal' : e.category === 'sign' ? 'sign' : undefined
        };
    }
    return {
        version: obj.version,
        flipY: typeof obj.flipY === 'boolean' ? obj.flipY : undefined,
        textures
    };
}

/** Exact set of prop GLB model IDs required by a map (heroProps + billboard stands). */
export function requiredPropModelsForMap(map: Pick<MapData, 'heroProps' | 'billboards'>): HeroPropModelId[] {
    const models = new Set<HeroPropModelId>();
    for (const prop of map.heroProps) models.add(prop.model);
    for (const b of map.billboards) {
        if (b.kind === 'roadside') models.add('prop_roadside_billboard');
        else if (b.kind === 'gantry') models.add('prop_billboard_gantry');
    }
    return [...models].sort();
}

/** Exact set of billboard/decal texture IDs required by a map. */
export function requiredBillboardTexturesForMap(map: Pick<MapData, 'billboards'>): BillboardTextureId[] {
    const ids = new Set<BillboardTextureId>();
    for (const b of map.billboards) ids.add(b.texture);
    return [...ids].sort();
}

export function propUrl(entry: Pick<PropManifestEntry, 'file' | 'hash'>, base = PROPS_BASE): string {
    return `${base}${entry.file}?v=${entry.hash}`;
}

export function billboardUrl(entry: Pick<BillboardManifestEntry, 'file' | 'hash'>, base = BILLBOARDS_BASE): string {
    return `${base}${entry.file}?v=${entry.hash}`;
}

// ---- Fallback primitive stand-ins (never black, never crashes) ----

const FALLBACK_COLORS: Record<string, number> = {
    lmf_forge_arch: 0x3b3838,
    lmf_red_knopf: 0xd93829,
    lmf_jet_loop_reactor: 0x2b8cbf,
    lmf_arcanum_tower: 0x6b4f9c,
    lmf_selantis_arch: 0x8a7e6e,
    lmf_theater_facade: 0x9c3238,
    lmf_melodai_arch: 0x303647,
    lmf_codex_monolith: 0x262932,
    lmf_festival_stage: 0x2f2d38,
    lmf_sailboat_ijsselmeer: 0x2563eb,
    lmf_alpine_chalet: 0x8c5a34,
    lmf_ski_gondola_pylon: 0x64748b,
    prop_roadside_billboard: 0x475569,
    prop_billboard_gantry: 0x475569,
    prop_win98_frame: 0x9ca3af
};

/** Builds a clean primitive stand-in matching the manifest bounds if a GLB fails to load. */
export function createFallbackProp(modelId: HeroPropModelId, entry?: PropManifestEntry | null): THREE.Group {
    const group = new THREE.Group();
    group.name = `fallback-${modelId}`;
    const min = entry?.bounds.min ?? [-2, 0, -2];
    const max = entry?.bounds.max ?? [2, 4, 2];
    const w = Math.max(0.6, max[0] - min[0]);
    const h = Math.max(0.6, max[1] - min[1]);
    const d = Math.max(0.6, max[2] - min[2]);
    const cx = (min[0] + max[0]) * 0.5;
    const cy = (min[1] + max[1]) * 0.5;
    const cz = (min[2] + max[2]) * 0.5;

    const color = FALLBACK_COLORS[modelId] ?? 0x6b7280;
    const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.15 });

    if (modelId === 'prop_roadside_billboard' || modelId === 'prop_billboard_gantry' || modelId === 'prop_win98_frame') {
        const postMat = bodyMat;
        const postH = modelId === 'prop_billboard_gantry' ? 6.5 : 3.4;
        const faceW = modelId === 'prop_billboard_gantry' ? 12 : 8;
        const faceH = modelId === 'prop_billboard_gantry' ? 4 : 4;
        const postOffset = faceW * 0.45;
        for (const sx of [-1, 1]) {
            const post = new THREE.Mesh(new THREE.BoxGeometry(0.35, postH + faceH * 0.5, 0.35), postMat);
            post.position.set(sx * postOffset, (postH + faceH * 0.5) * 0.5, -0.1);
            group.add(post);
        }
        const face = new THREE.Mesh(
            new THREE.PlaneGeometry(faceW, faceH),
            new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.05 })
        );
        face.name = 'billboard_face';
        face.position.set(0, postH + faceH * 0.5, 0.15);
        group.add(face);
    } else {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), bodyMat);
        mesh.position.set(cx, cy, cz);
        group.add(mesh);
    }
    return group;
}

/** Clones a prop template scene graph while sharing geometry and base materials. */
export function clonePropSharingResources(template: THREE.Group): THREE.Group {
    const clone = template.clone(true);
    clone.traverse(obj => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) {
            mesh.userData = { ...mesh.userData, sharedAsset: true };
        }
    });
    return clone;
}

// ---- Runtime lazy loader & caches ----

let propsManifestPromise: Promise<PropsManifest> | null = null;
let billboardsManifestPromise: Promise<BillboardsManifest> | null = null;
let sharedGltfLoaderPromise: Promise<{ loadAsync(url: string): Promise<{ scene: THREE.Group }> }> | null = null;

const propTemplateCache = new Map<HeroPropModelId, Promise<LoadedPropTemplate>>();
const billboardTextureCache = new Map<BillboardTextureId, THREE.CompressedTexture>();
const billboardJobs = new Map<BillboardTextureId, Promise<void>>();

export function loadPropsManifest(): Promise<PropsManifest> {
    propsManifestPromise ??= fetch(`${PROPS_BASE}manifest.json`, { cache: 'no-cache' }).then(res => {
        if (!res.ok) throw new Error(`props manifest HTTP ${res.status}`);
        return res.json();
    }).then(parsePropsManifest);
    return propsManifestPromise;
}

export function loadBillboardsManifest(): Promise<BillboardsManifest> {
    billboardsManifestPromise ??= fetch(`${BILLBOARDS_BASE}manifest.json`, { cache: 'no-cache' }).then(res => {
        if (!res.ok) throw new Error(`billboards manifest HTTP ${res.status}`);
        return res.json();
    }).then(parseBillboardsManifest);
    return billboardsManifestPromise;
}

async function getPropGltfLoader(renderer: THREE.WebGLRenderer): Promise<{ loadAsync(url: string): Promise<{ scene: THREE.Group }> }> {
    sharedGltfLoaderPromise ??= Promise.all([
        import('three/examples/jsm/loaders/GLTFLoader.js'),
        import('three/examples/jsm/libs/meshopt_decoder.module.js'),
        getKTX2Loader(renderer)
    ]).then(async ([{ GLTFLoader }, { MeshoptDecoder }, ktx2]) => {
        await MeshoptDecoder.ready;
        const loader = new GLTFLoader();
        loader.setMeshoptDecoder(MeshoptDecoder);
        loader.setKTX2Loader(ktx2);
        return loader;
    });
    return sharedGltfLoaderPromise;
}

function placeholderBillboardTexture(id: BillboardTextureId, anisotropy: number): THREE.CompressedTexture {
    // Neutral warm charcoal-slate placeholder (decals slightly transparent-tinted)
    const rgba: [number, number, number, number] = id.startsWith('decal_')
        ? [42, 46, 54, 180]
        : [52, 56, 66, 255];
    const tex = new THREE.CompressedTexture(
        [{ data: new Uint8Array(rgba), width: 1, height: 1 }] as unknown as ImageData[],
        1, 1, THREE.RGBAFormat as unknown as THREE.CompressedPixelFormat, THREE.UnsignedByteType
    );
    tex.name = `billboards/${id}`;
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = anisotropy;
    tex.needsUpdate = true;
    return tex;
}

function copyIntoTexture(placeholder: THREE.Texture, source: THREE.Texture): void {
    const { wrapS, wrapT, anisotropy } = placeholder;
    source.userData = {};
    placeholder.copy(source);
    placeholder.wrapS = wrapS;
    placeholder.wrapT = wrapT;
    placeholder.anisotropy = anisotropy;
    placeholder.colorSpace = THREE.SRGBColorSpace;
    placeholder.needsUpdate = true;
}

/**
 * Returns a cached KTX2 texture for a billboard/decal (neutral 1x1 placeholder
 * upgraded in-place once transcoded, preserving encoded flipY: true orientation).
 */
export function getBillboardTexture(id: BillboardTextureId, renderer: THREE.WebGLRenderer | null): THREE.Texture {
    const anisotropy = renderer ? Math.min(8, renderer.capabilities?.getMaxAnisotropy?.() ?? 4) : 1;
    let tex = billboardTextureCache.get(id);
    if (!tex) {
        tex = placeholderBillboardTexture(id, anisotropy);
        billboardTextureCache.set(id, tex);
    }
    if (!renderer || typeof fetch !== 'function' || billboardJobs.has(id)) return tex;

    const target = tex;
    const job = Promise.all([loadBillboardsManifest(), getKTX2Loader(renderer)])
        .then(async ([manifest, ktx2]) => {
            const entry = manifest.textures[id];
            if (!entry) throw new Error(`billboard texture ${id} missing from billboards/manifest.json`);
            const loaded = await ktx2.loadAsync(billboardUrl(entry));
            copyIntoTexture(target, loaded);
        })
        .catch(error => {
            console.warn(`Billboard texture ${id} failed to load, keeping placeholder`, error);
        });
    billboardJobs.set(id, job);
    return tex;
}

/** Loads and caches a single hero prop GLB template (falls back cleanly on error or headless). */
export function loadHeroPropTemplate(modelId: HeroPropModelId, renderer: THREE.WebGLRenderer | null): Promise<LoadedPropTemplate> {
    const cached = propTemplateCache.get(modelId);
    if (cached) return cached;

    if (!renderer || typeof fetch !== 'function') {
        const fallback: LoadedPropTemplate = {
            modelId,
            entry: null,
            scene: createFallbackProp(modelId, null),
            animNodes: [],
            billboardNode: modelId === 'prop_roadside_billboard' || modelId === 'prop_billboard_gantry' || modelId === 'prop_win98_frame'
                ? 'billboard_face'
                : undefined,
            isFallback: true
        };
        return Promise.resolve(fallback);
    }

    const promise = (async (): Promise<LoadedPropTemplate> => {
        let entry: PropManifestEntry | null = null;
        try {
            const [manifest, loader] = await Promise.all([loadPropsManifest(), getPropGltfLoader(renderer)]);
            entry = manifest.props[modelId] ?? null;
            if (!entry) throw new Error(`hero prop ${modelId} missing from props/manifest.json`);
            const gltf = await loader.loadAsync(propUrl(entry));
            const scene = gltf.scene;
            scene.name = modelId;
            scene.traverse(obj => {
                const mesh = obj as THREE.Mesh;
                if (!mesh.isMesh) return;
                mesh.receiveShadow = true;
                const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                for (const m of mats) {
                    if (m && 'envMapIntensity' in m) (m as THREE.MeshStandardMaterial).envMapIntensity = 0.9;
                }
            });
            return {
                modelId,
                entry,
                scene,
                animNodes: entry.animNodes ?? [],
                billboardNode: entry.billboardNode,
                isFallback: false
            };
        } catch (error) {
            console.warn(`Hero prop ${modelId} failed to load, using primitive fallback`, error);
            return {
                modelId,
                entry,
                scene: createFallbackProp(modelId, entry),
                animNodes: entry?.animNodes ?? [],
                billboardNode: entry?.billboardNode,
                isFallback: true
            };
        }
    })();

    propTemplateCache.set(modelId, promise);
    return promise;
}

/** Lazily preloads ONLY the hero prop GLBs and billboard KTX2 textures referenced by `map`. */
export function preloadMapHeroAssets(map: Pick<MapData, 'heroProps' | 'billboards'>, renderer: THREE.WebGLRenderer | null): Promise<void> {
    if (!renderer || typeof fetch !== 'function') return Promise.resolve();
    const models = requiredPropModelsForMap(map);
    const textures = requiredBillboardTexturesForMap(map);
    if (!models.length && !textures.length) return Promise.resolve();

    const jobs: Promise<unknown>[] = [];
    for (const model of models) jobs.push(loadHeroPropTemplate(model, renderer));
    for (const tex of textures) {
        getBillboardTexture(tex, renderer);
        const job = billboardJobs.get(tex);
        if (job) jobs.push(job);
    }
    return Promise.all(jobs).then(() => undefined);
}

/** Clears cached templates & billboard textures (for tests or full teardown). */
export function clearHeroAssetCache(): void {
    for (const tex of billboardTextureCache.values()) tex.dispose();
    billboardTextureCache.clear();
    billboardJobs.clear();
    propTemplateCache.clear();
    propsManifestPromise = null;
    billboardsManifestPromise = null;
    sharedGltfLoaderPromise = null;
}
