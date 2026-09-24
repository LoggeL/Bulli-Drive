import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSky } from '../../src/client/render/sky.js';
import { createPalms, palmStats, updatePalms, type PalmSpot } from '../../src/client/world/palms.js';
import { createWorldMaterials } from '../../src/client/world/materials.js';

// Blank textures instead of the KTX2 files of the client build
vi.mock('../../src/client/world/textures.js', async () => {
    const { Texture } = await import('three');
    return {
        worldTexture: () => new Texture(),
        cloneWorldTexture: (source: InstanceType<typeof Texture>) => source.clone(),
        whenWorldTextureLoaded: () => Promise.resolve()
    };
});

// A lost WebGL context takes whatever the page rendered into its own targets
// with it; three.js restores its GL state, the world has to render these
// again on 'webglcontextrestored' (graphics G1): the PMREM environment map
// of the sky (render/sky.ts) and the palm impostor atlas (world/palms.ts),
// which falls back to the near palms while it is gone. The picture after a
// real restore is compared in tests/e2e/desktop.spec.ts.

// The renderer calls the world makes, recorded; domElement carries the
// context events like the real canvas
function fakeRenderer() {
    const domElement = new EventTarget();
    let target: THREE.WebGLRenderTarget | null = null;
    const renderer = {
        domElement,
        renders: 0,
        autoClear: true,
        shadowMap: { autoUpdate: true },
        getRenderTarget: () => target,
        setRenderTarget: (next: THREE.WebGLRenderTarget | null) => { target = next; },
        getClearColor: (out: THREE.Color) => out.set(0),
        getClearAlpha: () => 1,
        setClearColor: () => {},
        clear: () => {},
        render: () => { renderer.renders++; }
    };
    return renderer;
}

const fire = (renderer: { domElement: EventTarget }, type: 'webglcontextlost' | 'webglcontextrestored') =>
    renderer.domElement.dispatchEvent(new Event(type));

describe('the sky after a lost context', () => {
    function pmremFake() {
        const targets: Array<THREE.WebGLRenderTarget & { disposed: boolean }> = [];
        const factory = () => ({
            fromScene: () => {
                const target = Object.assign(new THREE.WebGLRenderTarget(4, 4), { disposed: false });
                target.addEventListener('dispose', () => { target.disposed = true; });
                targets.push(target);
                return target;
            },
            dispose: () => {}
        });
        return { targets, factory };
    }

    it('renders the environment map again on the restored context', async () => {
        const renderer = fakeRenderer();
        const scene = new THREE.Scene();
        const pmrem = pmremFake();
        const sky = createSky(renderer as unknown as THREE.WebGLRenderer, scene,
            { environment: true, hdri: false, simple: false, beforeEnvironment: Promise.resolve(), pmrem: pmrem.factory });
        await sky.ready;
        // Built at once and again with the final inputs; the first one is freed
        expect(pmrem.targets).toHaveLength(2);
        expect(pmrem.targets[0].disposed).toBe(true);
        expect(scene.environment).toBe(pmrem.targets[1].texture);

        fire(renderer, 'webglcontextrestored');
        expect(pmrem.targets).toHaveLength(3);
        expect(scene.environment).toBe(pmrem.targets[2].texture);
        expect(scene.getObjectByName('sky-dome')).toBeDefined();
    });

    it('has no environment map on the software tier, also after a restore', async () => {
        const renderer = fakeRenderer();
        const scene = new THREE.Scene();
        const pmrem = pmremFake();
        const sky = createSky(renderer as unknown as THREE.WebGLRenderer, scene,
            { environment: false, hdri: false, simple: true, beforeEnvironment: Promise.resolve(), pmrem: pmrem.factory });
        await sky.ready;
        fire(renderer, 'webglcontextrestored');
        expect(pmrem.targets).toHaveLength(0);
        expect(scene.environment).toBeNull();
    });
});

describe('the palm impostors after a lost context', () => {
    // One palm next to the camera, two far beyond the impostor distance
    // (80 m on the software tier)
    const spots: PalmSpot[] = [
        { kind: 'date', x: 5, y: 0, z: 0, scale: 1, yaw: 0 },
        { kind: 'fan', x: 300, y: 0, z: 0, scale: 1, yaw: 1 },
        { kind: 'date', x: 0, y: 0, z: -400, scale: 1.1, yaw: 2 }
    ];
    const camera = new THREE.PerspectiveCamera();
    const renderer = fakeRenderer();

    beforeAll(async () => {
        vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => null }) });
        createPalms(createWorldMaterials('software'), spots, 'software', renderer as unknown as THREE.WebGLRenderer);
        await vi.waitFor(() => expect(palmStats()?.baked).toBe(true));
    });
    afterAll(() => vi.unstubAllGlobals());

    it('draws far palms as impostors once baked, near geometry while the atlas is lost, impostors again after the restore', () => {
        updatePalms(camera);
        expect(palmStats()).toEqual({ near: 1, impostors: 2, baked: true });
        const bakes = renderer.renders;
        expect(bakes).toBe(2);

        fire(renderer, 'webglcontextlost');
        updatePalms(camera);
        expect(palmStats()).toEqual({ near: 3, impostors: 0, baked: false });

        fire(renderer, 'webglcontextrestored');
        // Both kinds baked again into the atlas
        expect(renderer.renders).toBe(bakes + 2);
        updatePalms(camera);
        expect(palmStats()).toEqual({ near: 1, impostors: 2, baked: true });
    });
});
