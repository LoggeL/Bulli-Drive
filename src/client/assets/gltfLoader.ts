import type { WebGLRenderer } from 'three';
import type { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import type { ModelLoader } from './ModelCache.js';

// GLTFLoader wired for the packed assets of tools/models and tools/textures:
// EXT_meshopt_compression (meshopt decoder, WASM inlined in the module) and
// KHR_texture_basisu (KTX2Loader + the Basis transcoder of the installed
// three.js: KTX2Loader points at it with new URL(..., import.meta.url), so
// Vite emits basis_transcoder.js/.wasm content-hashed under assets/). The
// loader modules are imported lazily, so they load in parallel with the rest
// of the startup.

let ktx2Loader: Promise<KTX2Loader> | null = null;

/**
 * The one KTX2Loader of the page (three.js warns about several instances:
 * each owns a transcoder worker pool). Also for standalone .ktx2 textures
 * from public/textures, which are encoded with flipY already applied.
 */
export function getKTX2Loader(renderer: WebGLRenderer): Promise<KTX2Loader> {
    ktx2Loader ??= import('three/examples/jsm/loaders/KTX2Loader.js').then(({ KTX2Loader }) => {
        const loader = new KTX2Loader();
        // Two workers are plenty for a handful of small car textures and keep
        // phones responsive during the splash screen
        loader.setWorkerLimit(2);
        loader.detectSupport(renderer);
        return loader;
    });
    return ktx2Loader;
}

export async function createGltfModelLoader(renderer: WebGLRenderer): Promise<ModelLoader> {
    const [{ GLTFLoader }, { MeshoptDecoder }, ktx2] = await Promise.all([
        import('three/examples/jsm/loaders/GLTFLoader.js'),
        import('three/examples/jsm/libs/meshopt_decoder.module.js'),
        getKTX2Loader(renderer)
    ]);
    await MeshoptDecoder.ready;
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.setKTX2Loader(ktx2);
    return {
        async load(url: string) {
            const gltf = await loader.loadAsync(url);
            return gltf.scene;
        }
    };
}
