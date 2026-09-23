import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { ModelCache, lodsForTier, type ModelLoader, type ModelManifest } from '../../src/client/assets/ModelCache.js';

const manifest: ModelManifest = {
    version: 1,
    models: {
        bulli: {
            name: 'VW T1',
            wheelRadius: 0.333,
            dimensions: { length: 4.28, width: 1.8, height: 1.94, wheelbase: 2.4 },
            lods: [0, 1, 2].map(lod => ({
                lod, file: `bulli_lod${lod}.glb`, hash: `h${lod}`, bytes: 1000, triangles: 100, primitives: 3
            }))
        }
    }
};

// A tiny stand-in for a car GLB: body, glass and a hidden surfboard
function fakeCar(): THREE.Object3D {
    const root = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ name: 'paint_primary' }));
    body.name = 'body';
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial({ name: 'glass', transparent: true }));
    const board = new THREE.Group();
    board.name = 'accessory_surfboard';
    board.userData.default_visible = false;
    root.add(body, glass, board);
    return root;
}

function fakeLoader(fail: (url: string) => boolean = () => false) {
    const urls: string[] = [];
    const loader: ModelLoader = {
        async load(url) {
            urls.push(url);
            if (fail(url)) throw new Error('broken GLB');
            return fakeCar();
        }
    };
    return { loader, urls };
}

function cache(loader: ModelLoader, fetchManifest = async () => manifest) {
    return new ModelCache({ baseUrl: '/models/', createLoader: async () => loader, fetchManifest });
}

describe('ModelCache', () => {
    it('loads the requested LODs with cache-busting URLs', async () => {
        const { loader, urls } = fakeLoader();
        const models = cache(loader);
        await models.preload([1, 2]);
        expect(urls.sort()).toEqual(['/models/bulli_lod1.glb?v=h1', '/models/bulli_lod2.glb?v=h2']);
        expect(models.status).toBe('ready');
        expect(models.has('bulli', 0)).toBe(false);
        expect(models.has('bulli', 1)).toBe(true);
        expect(models.snapshot().loaded).toEqual(['bulli:1', 'bulli:2']);
        expect(models.entry('bulli')?.wheelRadius).toBe(0.333);
    });

    it('preloads only once', async () => {
        const { loader, urls } = fakeLoader();
        const models = cache(loader);
        const a = models.preload([0]);
        const b = models.preload([0, 1, 2]);
        expect(a).toBe(b);
        await b;
        expect(urls).toHaveLength(1);
    });

    it('hands out clones that share geometry and materials', async () => {
        const models = cache(fakeLoader().loader);
        await models.preload([0]);
        const a = models.instantiate('bulli', 0)!;
        const b = models.instantiate('bulli', 0)!;
        expect(a).not.toBe(b);
        const bodyA = a.getObjectByName('body') as THREE.Mesh;
        const bodyB = b.getObjectByName('body') as THREE.Mesh;
        expect(bodyA.geometry).toBe(bodyB.geometry);
        expect(bodyA.material).toBe(bodyB.material);
    });

    it('applies the node conventions: hidden accessories, no shadows from glass', async () => {
        const models = cache(fakeLoader().loader);
        await models.preload([0]);
        const car = models.instantiate('bulli', 0)!;
        expect(car.getObjectByName('accessory_surfboard')!.visible).toBe(false);
        const meshes: THREE.Mesh[] = [];
        car.traverse(child => { if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh); });
        const body = meshes.find(m => (m.material as THREE.Material).name === 'paint_primary')!;
        const glass = meshes.find(m => (m.material as THREE.Material).name === 'glass')!;
        expect(body.castShadow).toBe(true);
        expect(glass.castShadow).toBe(false);
        // Fresnel glass shader patch, one program for all cars
        expect((glass.material as THREE.Material).customProgramCacheKey()).toBe('bulliFresnelGlass');
        expect(car.userData).toMatchObject({ modelId: 'bulli', lod: 0 });
    });

    it('falls back per LOD: a broken GLB leaves the others usable', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const models = cache(fakeLoader(url => url.includes('lod0')).loader);
        await models.preload([0, 1, 2]);
        expect(models.status).toBe('ready');
        expect(models.instantiate('bulli', 0)).toBeNull();
        expect(models.bestLod('bulli', 0)).toBe(1);
        expect(models.errors.join()).toMatch(/bulli_lod0\.glb: broken GLB/);
        warn.mockRestore();
    });

    it('fails soft when the manifest is missing', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const models = cache(fakeLoader().loader, async () => { throw new Error('HTTP 404'); });
        await expect(models.preload([0])).resolves.toBeUndefined();
        expect(models.status).toBe('failed');
        expect(models.instantiate('bulli', 0)).toBeNull();
        expect(await models.whenLoaded()).toBe(false);
        warn.mockRestore();
    });

    it('treats a hanging load as failed after the timeout', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const models = new ModelCache({
            createLoader: async () => ({ load: () => new Promise<THREE.Object3D>(() => {}) }),
            fetchManifest: async () => manifest,
            timeoutMs: 20
        });
        await models.preload([2]);
        expect(models.status).toBe('failed');
        expect(models.errors.join()).toMatch(/timeout/);
        warn.mockRestore();
    });

    it('picks the nearest loaded LOD, preferring more detail on ties', async () => {
        const models = cache(fakeLoader().loader);
        await models.preload([0, 2]);
        expect(models.bestLod('bulli', 0)).toBe(0);
        expect(models.bestLod('bulli', 1)).toBe(0);
        expect(models.bestLod('bulli', 2)).toBe(2);
        expect(models.bestLod('beetle', 0)).toBeNull();
    });

    it('warms up every loaded model with the target scene', async () => {
        const models = cache(fakeLoader().loader);
        await models.preload([0, 1]);
        const compiled: THREE.Object3D[] = [];
        const renderer = {
            initTexture: vi.fn(),
            compileAsync: vi.fn(async (object: THREE.Object3D) => { compiled.push(object); return object; })
        } as unknown as THREE.WebGLRenderer;
        const scene = new THREE.Scene();
        await models.warmup(renderer, new THREE.PerspectiveCamera(), scene);
        expect(compiled).toHaveLength(1);
        expect(compiled[0].children).toHaveLength(2);
        expect((renderer.compileAsync as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe(scene);
        expect(models.snapshot().warmedUp).toBe(true);
    });

    it('preloads every LOD except LOD0 on the software tier', () => {
        expect(lodsForTier('desktop')).toEqual([0, 1, 2]);
        expect(lodsForTier('mobile')).toEqual([0, 1, 2]);
        expect(lodsForTier('software')).toEqual([1, 2]);
    });
});
