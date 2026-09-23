import type * as THREE from 'three';
import { ModelCache, lodsForTier } from './ModelCache.js';
import { createGltfModelLoader } from './gltfLoader.js';
import { detectRenderTier } from '../effects/renderQuality.js';

// The game's model cache. main.ts starts the preload as soon as the renderer
// exists, i.e. while the splash screen is up, and compiles the shaders
// afterwards. Nothing renders these models yet; the car code falls back to
// the procedural models whenever a model is not (or not yet) loaded.

let rendererRef: THREE.WebGLRenderer | null = null;

export const models = new ModelCache({
    baseUrl: `${import.meta.env.BASE_URL}models/`,
    createLoader: () => {
        if (!rendererRef) throw new Error('startModelPreload() was not called');
        return createGltfModelLoader(rendererRef);
    }
});

/** Starts loading the car models for this device's render tier (idempotent). */
export function startModelPreload(renderer: THREE.WebGLRenderer, camera: THREE.Camera, scene: THREE.Scene): Promise<void> {
    rendererRef = renderer;
    return models.preload(lodsForTier(detectRenderTier(renderer)))
        .then(() => models.warmup(renderer, camera, scene));
}
