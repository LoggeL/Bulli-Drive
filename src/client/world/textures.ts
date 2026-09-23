import * as THREE from 'three';
import { getKTX2Loader } from '../assets/gltfLoader.js';

// KTX2 world textures from public/textures (tools/textures/build.mjs).
//
// worldTexture() hands out a placeholder CompressedTexture right away, so the
// world materials and meshes can be built synchronously when the server's
// 'init' arrives; the file loads in the background and is copied into the
// placeholder (same object, so no material recompiles). Until then the
// texture samples as black, which only happens behind the splash screen.
// A lost WebGL context needs nothing here: three.js uploads the kept
// mipmaps again on the restored context.

interface ManifestEntry {
    file: string;
    kind: 'color' | 'data' | 'normal';
    hash: string;
}

interface TextureManifest {
    textures: Record<string, ManifestEntry>;
}

export interface WorldTextureOptions {
    // Repeat wrapping (tiling PBR sets) instead of clamping (atlases, cards)
    repeat?: boolean;
    // Anisotropic filtering (default: the tier's maximum)
    anisotropy?: number;
}

const BASE = `${import.meta.env.BASE_URL}textures/`;

let renderer: THREE.WebGLRenderer | null = null;
let manifest: Promise<TextureManifest> | null = null;
const cache = new Map<string, THREE.CompressedTexture>();
const pending: Promise<void>[] = [];
const jobs = new Map<string, Promise<void>>();
// Clones (own repeat, same image) that must follow their source once loaded
const clones = new Map<THREE.Texture, THREE.Texture[]>();
let maxAnisotropy = 4;

export const textureStats = { requested: 0, loaded: 0, failed: 0 };

/** Must be called once before the first worldTexture(). */
export function initWorldTextures(target: THREE.WebGLRenderer, anisotropy: number): void {
    renderer = target;
    maxAnisotropy = Math.max(1, Math.min(anisotropy, target.capabilities.getMaxAnisotropy()));
    manifest ??= fetch(`${BASE}manifest.json`, { cache: 'no-cache' }).then(response => {
        if (!response.ok) throw new Error(`texture manifest: HTTP ${response.status}`);
        return response.json() as Promise<TextureManifest>;
    });
}

function copyInto(placeholder: THREE.Texture, loaded: THREE.Texture): void {
    const { wrapS, wrapT, anisotropy } = placeholder;
    const repeat = placeholder.repeat.clone();
    const offset = placeholder.offset.clone();
    loaded.userData = {};
    placeholder.copy(loaded);
    placeholder.wrapS = wrapS;
    placeholder.wrapT = wrapT;
    placeholder.anisotropy = anisotropy;
    placeholder.repeat.copy(repeat);
    placeholder.offset.copy(offset);
    placeholder.needsUpdate = true;
}

/**
 * Placeholder for the manifest texture `name` (e.g. 'pbr/asphalt_albedo').
 * The same name returns the same texture.
 */
export function worldTexture(name: string, options: WorldTextureOptions = {}): THREE.Texture {
    const cached = cache.get(name);
    if (cached) return cached;
    if (!renderer || !manifest) throw new Error('initWorldTextures() first');
    const texture = new THREE.CompressedTexture([], 1, 1, THREE.RGBA_ASTC_4x4_Format);
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
            const loaded = await loader.loadAsync(`${BASE}${entry.file}?v=${entry.hash}`);
            copyInto(texture, loaded);
            for (const clone of clones.get(texture) ?? []) copyInto(clone, texture);
            textureStats.loaded++;
        })
        .catch(error => {
            textureStats.failed++;
            console.warn(`World texture ${name} failed to load`, error);
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
    // Not source.clone(): Texture.copy() flags the copy for upload, which
    // fails while the placeholder has no mipmaps yet
    const clone = new THREE.CompressedTexture([], 1, 1, THREE.RGBA_ASTC_4x4_Format);
    clone.name = source.name;
    clone.wrapS = source.wrapS;
    clone.wrapT = source.wrapT;
    clone.anisotropy = source.anisotropy;
    if ((source as THREE.CompressedTexture).mipmaps?.length) {
        copyInto(clone, source);
    } else {
        const list = clones.get(source) ?? [];
        list.push(clone);
        clones.set(source, list);
    }
    return clone;
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
