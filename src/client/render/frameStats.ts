import type * as THREE from 'three';

// Draw call and triangle counters of a whole frame, shadow pass included.
//
// three.js resets renderer.info only after it rendered the shadow maps, so
// with autoReset the counters leave the shadow pass out. renderFrame() resets
// them itself before render() and records how many of the calls the shadow
// pass took. renderer.info.render.calls/triangles (perf overlay, e2e hook)
// then describe the complete frame.

export interface FrameStats {
    // Draw calls and triangles of the shadow pass of the last frame
    shadowCalls: number;
    shadowTriangles: number;
}

export const frameStats: FrameStats = { shadowCalls: 0, shadowTriangles: 0 };

// The shadow map object is replaced when a lost context is restored
let patchedShadowMap: THREE.WebGLShadowMap | null = null;

function patchShadowMap(renderer: THREE.WebGLRenderer): void {
    const shadowMap = renderer.shadowMap;
    if (shadowMap === patchedShadowMap) return;
    patchedShadowMap = shadowMap;
    const render = shadowMap.render.bind(shadowMap);
    shadowMap.render = (lights, scene, camera) => {
        // Shadow maps may be skipped (autoUpdate off, no casters in view)
        const calls = renderer.info.render.calls;
        const triangles = renderer.info.render.triangles;
        render(lights, scene, camera);
        frameStats.shadowCalls = renderer.info.render.calls - calls;
        frameStats.shadowTriangles = renderer.info.render.triangles - triangles;
    };
}

/** Renders one frame with counters that include the shadow pass. */
export function renderFrame(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    patchShadowMap(renderer);
    // A restored context comes with a fresh info object (autoReset on again)
    renderer.info.autoReset = false;
    renderer.info.reset();
    frameStats.shadowCalls = 0;
    frameStats.shadowTriangles = 0;
    renderer.render(scene, camera);
}
