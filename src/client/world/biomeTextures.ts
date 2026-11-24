import * as THREE from 'three';
import { getKTX2Loader } from '../assets/gltfLoader.js';
import type { RenderTier } from '../effects/renderQuality.js';

// Lazy per-map loader for photoreal Codex-imagegen biome PBR KTX2 sets under
// public/textures/biomes/ (manifest.json). Uses the same neutral 1x1
// placeholder upgrade pattern as world/textures.ts so materials build
// synchronously without black frames or shader recompilation, and stays
// completely lazy so Bulli Bay never downloads alpine/quarry/forge sets.

export interface BiomeTextureEntry {
    file: string;
    kind: 'color' | 'data' | 'normal';
    width: number;
    height: number;
    encoding: 'etc1s' | 'uastc';
    bytes: number;
    hash: string;
}

export interface BiomeManifest {
    version: number;
    flipY?: boolean;
    textures: Record<string, BiomeTextureEntry>;
}

const BASE = `${import.meta.env.BASE_URL}textures/biomes/`;

const MEAN_BIOME_ALBEDO: Record<string, number> = {
    alpine_snow: 0xdce6f0,
    alpine_ice: 0xa2cde4,
    alpine_rock: 0x7b7f85,
    quarry_gravel: 0x9c8971,
    quarry_red_rock: 0xa86c4a,
    concrete_bowl: 0xb6b0a6,
    forge_cobble: 0x565254,
    tulip_meadow: 0x6f8b4e
};

let activeRenderer: THREE.WebGLRenderer | null = null;
let manifestPromise: Promise<BiomeManifest> | null = null;
let maxAnisotropy = 4;
const cache = new Map<string, THREE.CompressedTexture>();
const jobs = new Map<string, Promise<void>>();

export function initBiomeTextures(renderer: THREE.WebGLRenderer | null, anisotropy = 4): void {
    if (!renderer) return;
    activeRenderer = renderer;
    maxAnisotropy = Math.max(1, Math.min(anisotropy, renderer.capabilities?.getMaxAnisotropy?.() ?? anisotropy));
}

function getManifest(): Promise<BiomeManifest> {
    manifestPromise ??= fetch(`${BASE}manifest.json`, { cache: 'no-cache' }).then(response => {
        if (!response.ok) throw new Error(`biome manifest: HTTP ${response.status}`);
        return response.json() as Promise<BiomeManifest>;
    });
    return manifestPromise;
}

function placeholderFor(key: string, fallback?: number): THREE.CompressedTexture {
    let rgba: [number, number, number, number];
    let srgb = false;
    if (key.endsWith('_normal')) {
        rgba = [128, 128, 255, 255];
    } else if (key.endsWith('_arm')) {
        // AO=1, Roughness=0.82, Metalness=0
        rgba = [255, 210, 0, 255];
    } else {
        srgb = true;
        const set = key.replace(/_albedo$/, '');
        const hex = fallback ?? MEAN_BIOME_ALBEDO[set] ?? 0x909090;
        rgba = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255, 255];
    }
    const texture = new THREE.CompressedTexture(
        [{ data: new Uint8Array(rgba), width: 1, height: 1 }] as unknown as ImageData[],
        1, 1, THREE.RGBAFormat as unknown as THREE.CompressedPixelFormat, THREE.UnsignedByteType
    );
    texture.minFilter = texture.magFilter = THREE.NearestFilter;
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = maxAnisotropy;
    texture.needsUpdate = true;
    return texture;
}

function copyInto(placeholder: THREE.Texture, source: THREE.Texture): void {
    const { wrapS, wrapT, anisotropy } = placeholder;
    const repeat = placeholder.repeat.clone();
    const offset = placeholder.offset.clone();
    source.userData = {};
    placeholder.copy(source);
    placeholder.wrapS = wrapS;
    placeholder.wrapT = wrapT;
    placeholder.anisotropy = anisotropy;
    placeholder.repeat.copy(repeat);
    placeholder.offset.copy(offset);
    placeholder.needsUpdate = true;
}

/**
 * Returns a cached biome KTX2 texture (neutral 1x1 placeholder until transcoded).
 * Safe to call headless/without a renderer: stays as a valid placeholder.
 */
export function biomeTexture(key: string, fallback?: number): THREE.Texture {
    let texture = cache.get(key);
    if (!texture) {
        texture = placeholderFor(key, fallback);
        texture.name = `biomes/${key}`;
        cache.set(key, texture);
    }

    const renderer = activeRenderer;
    if (!renderer || typeof fetch !== 'function' || jobs.has(key)) return texture;

    const target = texture;
    const job = Promise.all([getManifest(), getKTX2Loader(renderer)])
        .then(async ([manifest, loader]) => {
            const entry = manifest.textures[key];
            if (!entry) throw new Error(`biome texture ${key} is not in biomes/manifest.json`);
            const loaded = await loader.loadAsync(`${BASE}${entry.file}?v=${entry.hash}`);
            copyInto(target, loaded);
        })
        .catch(error => {
            console.warn(`Biome texture ${key} failed to load, keeping placeholder`, error);
        });
    jobs.set(key, job);
    return texture;
}

export interface BiomePbrMaps {
    map: THREE.Texture;
    normalMap: () => THREE.Texture;
    arm: THREE.Texture;
}

/** Returns a PBR set (albedo, lazy desktop normal, ARM) for a biome texture base name (e.g. 'alpine_snow'). */
export function biomePbr(setName: string): BiomePbrMaps {
    return {
        map: biomeTexture(`${setName}_albedo`),
        normalMap: () => biomeTexture(`${setName}_normal`),
        arm: biomeTexture(`${setName}_arm`)
    };
}

/** Starts loading only the biome PBR sets needed by the active map. */
export function preloadBiomeTextures(sets: readonly string[], renderer: THREE.WebGLRenderer | null, tier: RenderTier): Promise<void> {
    if (!sets.length || !renderer || tier === 'software') return Promise.resolve();
    initBiomeTextures(renderer, tier === 'desktop' ? 8 : 4);
    const pending: Promise<void>[] = [];
    for (const set of sets) {
        biomeTexture(`${set}_albedo`);
        biomeTexture(`${set}_arm`);
        if (tier === 'desktop') biomeTexture(`${set}_normal`);
        for (const suffix of tier === 'desktop' ? ['albedo', 'arm', 'normal'] : ['albedo', 'arm']) {
            const job = jobs.get(`${set}_${suffix}`);
            if (job) pending.push(job);
        }
    }
    return Promise.all(pending).then(() => undefined);
}

/** Mean sRGB fallback color for a biome PBR set. */
export function biomeFallbackColor(setName: string): number {
    return MEAN_BIOME_ALBEDO[setName] ?? 0x909090;
}
