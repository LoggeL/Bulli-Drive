import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { ModelCache, lodsForTier, staticWheelLodsForTier, type ModelLoader, type ModelManifest } from '../../src/client/assets/ModelCache.js';

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
        expect((glass.material as THREE.Material).customProgramCacheKey()).toBe('bulli-car-glass-v2');
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

    it('bakes the wheels into the body on the static wheel LODs', async () => {
        // Body atlas mesh plus four wheel pivots with quantized geometry (like
        // the GLBs: KHR_mesh_quantization), all with the atlas material
        const atlas = new THREE.MeshStandardMaterial({ name: 'bulli_atlas' });
        const quantized = () => {
            const box = new THREE.BoxGeometry(0.6, 0.6, 0.2);
            const position = box.attributes.position;
            const q = new Int16Array(position.count * 3);
            for (let i = 0; i < q.length; i++) q[i] = Math.round((position.array[i] as number) / 0.5 * 32767);
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(q, 3, true));
            geometry.setAttribute('normal', box.attributes.normal);
            geometry.setAttribute('uv', box.attributes.uv);
            geometry.setIndex(box.index);
            return geometry;
        };
        const loader: ModelLoader = {
            async load() {
                const root = fakeCar();
                const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1, 4), atlas);
                body.name = 'body_atlas';
                root.add(body);
                for (const [name, x, z] of [['wheel_fl', 0.8, 1.2], ['wheel_fr', -0.8, 1.2], ['wheel_rl', 0.8, -1.2], ['wheel_rr', -0.8, -1.2]] as const) {
                    const pivot = new THREE.Group();
                    pivot.name = name;
                    pivot.position.set(x, 0.33, z);
                    const geo = new THREE.Group();
                    geo.name = `${name}_geo`;
                    geo.scale.setScalar(0.5);
                    geo.add(new THREE.Mesh(quantized(), atlas));
                    pivot.add(geo);
                    root.add(pivot);
                }
                return root;
            }
        };
        const models = cache(loader);
        models.staticWheelLods = [1];
        await models.preload([0, 1]);
        const count = (root: THREE.Object3D) => {
            let meshes = 0;
            root.traverseVisible(child => { if ((child as THREE.Mesh).isMesh) meshes++; });
            return meshes;
        };
        const lod0 = models.instantiate('bulli', 0)!;
        const lod1 = models.instantiate('bulli', 1)!;
        // LOD0: paint, glass, atlas, 4 wheels; LOD1: paint, glass, atlas + wheels
        expect(count(lod0)).toBe(7);
        expect(count(lod1)).toBe(3);
        const merged = lod1.getObjectByName('body_atlas_static_wheels') as THREE.Mesh;
        expect(merged.material).toBe(atlas);
        merged.geometry.computeBoundingBox();
        const box = merged.geometry.boundingBox!;
        // The front left wheel is in place: quantized ±0.3 m reads ±0.6, the
        // node scale 0.5 brings it back, at x 0.8 on its pivot
        expect(box.max.x).toBeCloseTo(1.1, 3);
        expect(box.min.y).toBeCloseTo(-0.5, 2);
        // The pivots stay, empty
        expect(lod1.getObjectByName('wheel_fl')!.getObjectByProperty('isMesh', true)).toBeUndefined();
        expect(staticWheelLodsForTier('mobile')).toEqual([1]);
        expect(staticWheelLodsForTier('desktop')).toEqual([]);
    });

    it('shares textures that two LODs of a model embed identically', async () => {
        const image = () => {
            const texture = new THREE.CompressedTexture([{ data: new Uint8Array(64).fill(7), width: 4, height: 4 }] as unknown as ImageData[], 4, 4, THREE.RGBA_ASTC_4x4_Format);
            texture.name = 'atlas_base';
            return texture;
        };
        const loader: ModelLoader = {
            async load(url) {
                const root = fakeCar();
                const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map: image(), name: 'atlas' }));
                if (url.includes('lod2')) (mesh.material as THREE.MeshStandardMaterial).map!.name = 'atlas_lod2';
                root.add(mesh);
                return root;
            }
        };
        const models = cache(loader);
        await models.preload([0, 1, 2]);
        const mapOf = (lod: number) => {
            let map: THREE.Texture | null = null;
            models.instantiate('bulli', lod)!.traverse(child => {
                const material = (child as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
                if (material?.map) map = material.map;
            });
            return map;
        };
        expect(mapOf(0)).toBe(mapOf(1));
        expect(mapOf(2)).not.toBe(mapOf(0));
        expect(models.sharedTextureCount).toBe(1);
    });

    it('counts the files of each model that loaded or failed (the loading screen)', async () => {
        const twoCars: ModelManifest = {
            version: 1,
            models: { bulli: manifest.models.bulli, beetle: { ...manifest.models.bulli, lods: manifest.models.bulli.lods.map(l => ({ ...l, file: `beetle_lod${l.lod}.glb` })) } }
        };
        let releaseBeetle: () => void = () => undefined;
        const beetleHeld = new Promise<void>(resolve => { releaseBeetle = resolve; });
        const loader: ModelLoader = {
            async load(url) {
                if (url.includes('beetle_lod1')) await beetleHeld;
                if (url.includes('bulli_lod2')) throw new Error('broken GLB');
                return fakeCar();
            }
        };
        const models = cache(loader, async () => twoCars);
        expect(models.fileProgress()).toEqual([0, 0]);
        const done = models.preload([1, 2]);
        await vi.waitFor(() => expect(models.fileProgress(['bulli'])).toEqual([2, 2]));
        // The broken bulli LOD counts as settled, the held beetle LOD not
        expect(models.fileProgress(['beetle'])).toEqual([1, 2]);
        expect(models.fileProgress()).toEqual([3, 4]);
        releaseBeetle();
        await done;
        expect(models.fileProgress(['beetle'])).toEqual([2, 2]);
        expect(models.fileProgress(['bulli', 'beetle'])).toEqual([4, 4]);
    });
});
