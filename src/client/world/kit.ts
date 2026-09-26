import * as THREE from 'three';
import type { RenderTier } from '../effects/renderQuality.js';
import { getKTX2Loader } from '../assets/gltfLoader.js';
import { patchWorldMaterial } from './materials.js';

// The building kit of the curated map (tools/models/buildings, public/models/kit,
// docs/phase-3-design.md A23, A24, A41): one meshopt GLB per group, three
// LODs per piece, all pieces on one material with a shared KTX2 atlas.
// Loaded once; every piece's LODs are turned into plain arrays in the
// piece's own frame (origin on the ground at the street front, front along
// +z), which the chunk builder transforms and merges (kitCells.ts, mapWorld).

export interface KitGeometry {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    colors: Float32Array;
    index: Uint32Array;
}

export interface KitPieceData {
    id: string;
    category: string;
    lods: KitGeometry[];
    // Switch distances of the category (m): LOD0 → 1, LOD1 → 2
    lodDistances: number[];
}

export interface KitCatalog {
    pieces: Map<string, KitPieceData>;
    material: THREE.Material;
    // The atlas textures (for the instanced props' material)
    textures: THREE.Texture[];
}

interface KitManifest {
    groups: Record<string, { file: string; hash: string }>;
    atlas: Record<string, { file: string; hash: string }>;
}

const BASE = `${import.meta.env.BASE_URL}models/kit/`;

// The piece's arrays from one LOD object (meshes under it, in piece space)
function extractLod(lod: THREE.Object3D, pieceInverse: THREE.Matrix4): KitGeometry | null {
    const meshes: THREE.Mesh[] = [];
    lod.traverse(object => { if ((object as THREE.Mesh).isMesh) meshes.push(object as THREE.Mesh); });
    if (!meshes.length) return null;
    let vertexCount = 0, indexCount = 0;
    for (const mesh of meshes) {
        vertexCount += mesh.geometry.attributes.position.count;
        indexCount += mesh.geometry.index ? mesh.geometry.index.count : mesh.geometry.attributes.position.count;
    }
    const out: KitGeometry = {
        positions: new Float32Array(vertexCount * 3),
        normals: new Float32Array(vertexCount * 3),
        uvs: new Float32Array(vertexCount * 2),
        colors: new Float32Array(vertexCount * 3),
        index: new Uint32Array(indexCount)
    };
    const matrix = new THREE.Matrix4(), normalMatrix = new THREE.Matrix3();
    const v = new THREE.Vector3();
    let base = 0, t = 0;
    for (const mesh of meshes) {
        mesh.updateWorldMatrix(true, false);
        matrix.multiplyMatrices(pieceInverse, mesh.matrixWorld);
        normalMatrix.getNormalMatrix(matrix);
        const g = mesh.geometry;
        const P = g.attributes.position, N = g.attributes.normal, UV = g.attributes.uv, C = g.attributes.color;
        for (let i = 0; i < P.count; i++) {
            v.fromBufferAttribute(P, i).applyMatrix4(matrix);
            out.positions.set([v.x, v.y, v.z], (base + i) * 3);
            if (N) {
                v.fromBufferAttribute(N, i).applyMatrix3(normalMatrix).normalize();
                out.normals.set([v.x, v.y, v.z], (base + i) * 3);
            }
            if (UV) out.uvs.set([UV.getX(i), UV.getY(i)], (base + i) * 2);
            if (C) out.colors.set([C.getX(i), C.getY(i), C.getZ(i)], (base + i) * 3);
            else out.colors.set([1, 1, 1], (base + i) * 3);
        }
        if (g.index) {
            for (let i = 0; i < g.index.count; i++) out.index[t++] = base + g.index.getX(i);
        } else {
            for (let i = 0; i < P.count; i++) out.index[t++] = base + i;
        }
        base += P.count;
    }
    return out;
}

function kitMaterial(source: THREE.MeshStandardMaterial, tier: RenderTier): THREE.Material {
    if (tier === 'software') {
        const lambert = new THREE.MeshLambertMaterial({
            map: source.map, vertexColors: true, emissiveMap: source.emissiveMap, emissive: new THREE.Color(1, 0.8, 0.6), emissiveIntensity: 0.6
        });
        lambert.name = 'kit_atlas';
        return patchWorldMaterial(lambert, {});
    }
    const material = new THREE.MeshStandardMaterial({
        map: source.map,
        normalMap: tier === 'desktop' ? source.normalMap : null,
        aoMap: source.aoMap,
        roughnessMap: source.roughnessMap,
        metalnessMap: source.metalnessMap,
        emissiveMap: source.emissiveMap,
        emissive: new THREE.Color(1, 0.8, 0.6),
        // Lit windows and neon at dusk, soft (the sun is still up)
        emissiveIntensity: 0.9,
        vertexColors: true,
        roughness: 1,
        metalness: 1,
        envMapIntensity: 0.9,
        aoMapIntensity: 0.8
    });
    material.name = 'kit_atlas';
    // Walls cast from their sunny faces (see materials.ts, the facades)
    material.shadowSide = THREE.FrontSide;
    return patchWorldMaterial(material, { macro: 0.05, macroScale: 25 });
}

/**
 * Loads every group of the kit (GLTFLoader with meshopt and KTX2). The atlas
 * is referenced by every GLB; a shared KTX2 loader answers each URL once,
 * so it is fetched, transcoded and uploaded once.
 */
export async function loadKit(
    renderer: THREE.WebGLRenderer,
    tier: RenderTier,
    // Groups loaded (or failed) of all groups, for the loading screen
    onProgress: (settled: number, total: number) => void = () => undefined
): Promise<KitCatalog> {
    const [{ GLTFLoader }, { MeshoptDecoder }, ktx2] = await Promise.all([
        import('three/examples/jsm/loaders/GLTFLoader.js'),
        import('three/examples/jsm/libs/meshopt_decoder.module.js'),
        getKTX2Loader(renderer)
    ]);
    await MeshoptDecoder.ready;
    const manifest = await (await fetch(`${BASE}manifest.json`, { cache: 'no-cache' })).json() as KitManifest;
    // One texture per URL, whatever the number of GLBs asking for it
    const textures = new Map<string, Promise<THREE.Texture>>();
    const sharedKtx2 = Object.create(ktx2) as typeof ktx2;
    // The atlas by its content hash (cached as immutable, like the GLBs)
    const atlasHash = new Map(Object.values(manifest.atlas).map(entry => [entry.file, entry.hash]));
    // Software WebGL draws the kit with its albedo and emission only: the
    // normal and ARM maps would cost it a transcode and an upload for nothing
    const unused = tier === 'software' ? /kit_atlas_(normal|arm)\.ktx2$/ : null;
    sharedKtx2.load = ((url: string, onLoad: (texture: THREE.Texture) => void, _progress?: unknown, onError?: (error: unknown) => void) => {
        let texture = textures.get(url);
        if (!texture && unused?.test(url)) {
            texture = Promise.resolve(new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1));
            textures.set(url, texture);
        }
        if (!texture) {
            const hash = atlasHash.get(url.slice(url.lastIndexOf('/') + 1));
            texture = ktx2.loadAsync(hash ? `${url}?v=${hash}` : url);
            textures.set(url, texture);
        }
        texture.then(onLoad, onError);
    }) as unknown as typeof ktx2.load;
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.setKTX2Loader(sharedKtx2);
    const groups = Object.values(manifest.groups);
    let settled = 0;
    onProgress(0, groups.length);
    const scenes = await Promise.all(groups.map(group =>
        loader.loadAsync(`${BASE}${group.file}?v=${group.hash}`)
            .finally(() => onProgress(++settled, groups.length))
            .then(gltf => gltf.scene)));

    const pieces = new Map<string, KitPieceData>();
    let source: THREE.MeshStandardMaterial | null = null;
    const inverse = new THREE.Matrix4();
    for (const scene of scenes) {
        scene.updateMatrixWorld(true);
        scene.traverse(object => {
            const extras = object.userData as { kit_piece?: string; category?: string; lod_distances?: number[] };
            if (!extras.kit_piece) return;
            inverse.copy(object.matrixWorld).invert();
            const lods: KitGeometry[] = [];
            for (let l = 0; l < 3; l++) {
                const lod = object.getObjectByName(`${extras.kit_piece}_lod${l}`);
                const arrays = lod ? extractLod(lod, inverse) : null;
                if (arrays) lods.push(arrays);
            }
            object.traverse(child => {
                const mesh = child as THREE.Mesh;
                if (!source && mesh.isMesh) source = mesh.material as THREE.MeshStandardMaterial;
            });
            if (lods.length) {
                pieces.set(extras.kit_piece, {
                    id: extras.kit_piece, category: extras.category ?? 'building', lods,
                    lodDistances: extras.lod_distances ?? [60, 180]
                });
            }
        });
    }
    if (!source) throw new Error('kit: no material in the GLBs');
    const base = source as THREE.MeshStandardMaterial;
    // The GLBs' geometry lives on in the arrays; their GPU side never existed
    for (const scene of scenes) scene.traverse(object => (object as THREE.Mesh).geometry?.dispose());
    return {
        pieces,
        material: kitMaterial(base, tier),
        textures: [base.map, base.normalMap, base.aoMap, base.emissiveMap].filter((t): t is THREE.Texture => !!t)
    };
}

// ---- Placing and merging ----

/** A piece in the world: origin and heading (rotation.y = yaw: local +z along (sin, cos)). */
export interface KitInstance {
    piece: string;
    x: number;
    y: number;
    z: number;
    // Local +z axis in the world (unit)
    ux: number;
    uz: number;
}

/** Merges the given LOD of the instances into one geometry (null if empty). */
export function mergeKit(catalog: KitCatalog, instances: readonly KitInstance[], lod: number): THREE.BufferGeometry | null {
    let vertices = 0, indices = 0;
    const parts: { geometry: KitGeometry; instance: KitInstance }[] = [];
    for (const instance of instances) {
        const piece = catalog.pieces.get(instance.piece);
        if (!piece) continue;
        const geometry = piece.lods[Math.min(lod, piece.lods.length - 1)];
        parts.push({ geometry, instance });
        vertices += geometry.positions.length / 3;
        indices += geometry.index.length;
    }
    if (!parts.length) return null;
    const positions = new Float32Array(vertices * 3), normals = new Float32Array(vertices * 3);
    const uvs = new Float32Array(vertices * 2), colors = new Float32Array(vertices * 3);
    const index = vertices > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
    let v = 0, t = 0;
    for (const { geometry, instance } of parts) {
        // Local x axis (uz, -ux), local z axis (ux, uz)
        const cx = instance.uz, sx = -instance.ux, cz = instance.ux, sz = instance.uz;
        const n = geometry.positions.length / 3;
        const P = geometry.positions, N = geometry.normals;
        for (let i = 0; i < n; i++) {
            const lx = P[i * 3], ly = P[i * 3 + 1], lz = P[i * 3 + 2];
            positions[(v + i) * 3] = instance.x + lx * cx + lz * cz;
            positions[(v + i) * 3 + 1] = instance.y + ly;
            positions[(v + i) * 3 + 2] = instance.z + lx * sx + lz * sz;
            const nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2];
            normals[(v + i) * 3] = nx * cx + nz * cz;
            normals[(v + i) * 3 + 1] = ny;
            normals[(v + i) * 3 + 2] = nx * sx + nz * sz;
        }
        uvs.set(geometry.uvs, v * 2);
        colors.set(geometry.colors, v * 3);
        for (let i = 0; i < geometry.index.length; i++) index[t++] = v + geometry.index[i];
        v += n;
    }
    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    merged.setIndex(new THREE.BufferAttribute(index, 1));
    merged.computeBoundingSphere();
    merged.computeBoundingBox();
    return merged;
}

/** One LOD of a piece as a geometry in its own frame (for instancing). */
export function pieceGeometry(catalog: KitCatalog, piece: string, lod: number): THREE.BufferGeometry | null {
    return mergeKit(catalog, [{ piece, x: 0, y: 0, z: 0, ux: 0, uz: 1 }], lod);
}
