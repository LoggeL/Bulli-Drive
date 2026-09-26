import * as THREE from 'three';
import { FetchTally } from '../assets/fetchTally.js';
import { getKTX2Loader } from '../assets/gltfLoader.js';
import { placeholderTexel } from './texturePlaceholders.js';

// KTX2 world textures from public/textures (tools/textures/build.mjs).
//
// worldTexture() hands out a placeholder right away, so the world materials
// and meshes can be built synchronously when the server's 'init' arrives;
// the file loads in the background and is copied into the placeholder (same
// object, so no material recompiles). The placeholder is a neutral 1 x 1
// texel of the texture's kind (mean albedo, flat normal, rough non-metal,
// transparent foliage), so a world whose textures are late (the start
// button waits for them, with a time limit) or failed to load (network,
// transcoder) is plainly shaded, never black.
// A lost WebGL context needs nothing here: three.js uploads the kept
// mipmaps again on the restored context.

interface ManifestEntry {
    file: string;
    kind: 'color' | 'data' | 'normal';
    hash: string;
    bytes: number;
}

interface TextureManifest {
    textures: Record<string, ManifestEntry>;
}

export interface WorldTextureOptions {
    // Repeat wrapping (tiling PBR sets) instead of clamping (atlases, cards)
    repeat?: boolean;
    // Anisotropic filtering (default: the tier's maximum)
    anisotropy?: number;
    // sRGB color of the placeholder of a color texture (default by name)
    fallback?: number;
}

const BASE = `${import.meta.env.BASE_URL}textures/`;

let renderer: THREE.WebGLRenderer | null = null;
let manifest: Promise<TextureManifest> | null = null;
const cache = new Map<string, THREE.CompressedTexture>();
const pending: Promise<void>[] = [];
const jobs = new Map<string, Promise<void>>();
// Clones (own repeat, same image) that must follow their source once loaded
const clones = new Map<THREE.Texture, THREE.Texture[]>();
const loaded = new Set<THREE.Texture>();
let maxAnisotropy = 4;

export const textureStats = { requested: 0, loaded: 0, failed: 0 };
/** The downloads of the requested textures (bytes and files, for the loading screen) */
export const textureTally = new FetchTally();

/** Must be called once before the first worldTexture(). */
export function initWorldTextures(target: THREE.WebGLRenderer, anisotropy: number): void {
    renderer = target;
    maxAnisotropy = Math.max(1, Math.min(anisotropy, target.capabilities.getMaxAnisotropy()));
    manifest ??= fetch(`${BASE}manifest.json`, { cache: 'no-cache' }).then(response => {
        if (!response.ok) throw new Error(`texture manifest: HTTP ${response.status}`);
        return response.json() as Promise<TextureManifest>;
    });
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

function placeholder(name: string, fallback?: number): THREE.CompressedTexture {
    const { rgba, srgb } = placeholderTexel(name, fallback);
    // An uncompressed level in a CompressedTexture (three uploads RGBA
    // levels with texImage2D). Nearest filtering: the loaded texture always
    // gets another cache key in three, so a new GL texture instead of a
    // second texStorage2D on the immutable 1 x 1 one.
    const texture = new THREE.CompressedTexture(
        [{ data: new Uint8Array(rgba), width: 1, height: 1 }] as unknown as ImageData[],
        1, 1, THREE.RGBAFormat as unknown as THREE.CompressedPixelFormat, THREE.UnsignedByteType
    );
    texture.minFilter = texture.magFilter = THREE.NearestFilter;
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.needsUpdate = true;
    return texture;
}

/**
 * Placeholder for the manifest texture `name` (e.g. 'pbr/asphalt_albedo').
 * The same name returns the same texture.
 */
export function worldTexture(name: string, options: WorldTextureOptions = {}): THREE.Texture {
    const cached = cache.get(name);
    if (cached) return cached;
    if (!renderer || !manifest) throw new Error('initWorldTextures() first');
    const texture = placeholder(name, options.fallback);
    texture.name = name;
    const wrap = options.repeat === false ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    texture.wrapS = texture.wrapT = wrap;
    texture.anisotropy = options.anisotropy ?? maxAnisotropy;
    cache.set(name, texture);
    textureStats.requested++;

    const target = renderer;
    const job = Promise.all([manifest, getKTX2Loader(target)])
        .then(async ([list, loader]) => {
            const entry = list.textures[name];
            if (!entry) throw new Error(`texture ${name} is not in the manifest`);
            textureTally.expect(name, entry.bytes);
            const file = await loader.loadAsync(`${BASE}${entry.file}?v=${entry.hash}`, textureTally.listener(name));
            textureTally.fetched(name);
            copyInto(texture, file);
            loaded.add(texture);
            for (const clone of clones.get(texture) ?? []) copyInto(clone, texture);
            textureStats.loaded++;
        })
        .catch(error => {
            // The placeholder stays: a neutral texel instead of black
            textureTally.fetched(name);
            textureStats.failed++;
            console.warn(`World texture ${name} failed to load, keeping its neutral placeholder`, error);
        });
    pending.push(job);
    jobs.set(name, job);
    return texture;
}

/** Resolves once the texture `name` (requested before) has loaded or failed. */
export function whenWorldTextureLoaded(name: string): Promise<void> {
    return jobs.get(name) ?? Promise.resolve();
}

/** Same image (and GPU texture) with its own repeat/offset. */
export function cloneWorldTexture(source: THREE.Texture): THREE.Texture {
    // Starts as a copy of the source (its placeholder or the loaded image)
    // with its own wrapping; follows the source once that has loaded
    const clone = new THREE.CompressedTexture([], 1, 1, THREE.RGBA_ASTC_4x4_Format);
    clone.name = source.name;
    clone.wrapS = source.wrapS;
    clone.wrapT = source.wrapT;
    clone.anisotropy = source.anisotropy;
    copyInto(clone, source);
    if (!loaded.has(source)) {
        const list = clones.get(source) ?? [];
        list.push(clone);
        clones.set(source, list);
    }
    return clone;
}

/** Share of the requested textures that loaded or failed (1 with none requested). */
export function worldTextureProgress(): number {
    const { requested, loaded: done, failed } = textureStats;
    return requested ? (done + failed) / requested : 1;
}

/** Resolves once every texture requested so far has loaded (or failed). */
export async function whenWorldTexturesLoaded(): Promise<void> {
    let count = -1;
    // Textures requested while waiting are awaited as well
    while (count !== pending.length) {
        count = pending.length;
        await Promise.all(pending);
    }
}
