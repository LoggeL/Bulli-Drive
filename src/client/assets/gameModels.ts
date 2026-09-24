import type * as THREE from 'three';
import { ModelCache, lodsForTier, staticWheelLodsForTier } from './ModelCache.js';
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
let ready: Promise<void> | null = null;

export function startModelPreload(renderer: THREE.WebGLRenderer, camera: THREE.Camera, scene: THREE.Scene): Promise<void> {
    rendererRef = renderer;
    const tier = detectRenderTier(renderer);
    models.staticWheelLods = staticWheelLodsForTier(tier);
    ready ??= models.preload(lodsForTier(tier))
        .then(() => models.warmup(renderer, camera, scene));
    return ready;
}

/**
 * Resolves once the models are loaded and their shaders compiled (or failed):
 * swapping a car to its GLB body before that would compile the car shaders
 * in the middle of a frame.
 */
export function whenModelsReady(): Promise<void> {
    return ready ?? models.whenLoaded().then(() => undefined);
}
