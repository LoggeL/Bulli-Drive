import * as THREE from 'three';
import { state } from '../state.js';
import { TreeData } from '../types.js';

export function getTerrainHeight(x: number, z: number) {
    if (!state.terrainConfig) return 0;
    const { frequency1, amplitude1, frequency2, amplitude2 } = state.terrainConfig;
    return Math.sin(x * frequency1) * amplitude1 + 
           Math.cos(z * frequency1) * amplitude1 + 
           Math.sin(x * frequency2 + z * frequency2) * amplitude2;
}

export function createEnvironment(treeData: TreeData[]) {
    if (!state.terrainConfig) return;
    const { size, segments } = state.terrainConfig;

    // Ground Plane
    const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
    geometry.rotateX(-Math.PI / 2);

    // Apply terrain height to vertices
    const vertices = geometry.attributes.position.array as Float32Array;
    for (let i = 0; i < vertices.length; i += 3) {
        const x = vertices[i];
        const z = vertices[i + 2];
        vertices[i + 1] = getTerrainHeight(x, z);
    }
    geometry.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({ 
        color: 0x3b7d3b, 
        roughness: 0.8,
        metalness: 0.2
    });
    const ground = new THREE.Mesh(geometry, material);
    ground.receiveShadow = true;
    state.scene.add(ground);

    // Obstacles (Trees)
    state.obstacles = [];
    treeData.forEach(t => {
        const treeGroup = new THREE.Group();
        treeGroup.position.set(t.x, getTerrainHeight(t.x, t.z), t.z);

        // Trunk
        const trunkGeo = new THREE.CylinderGeometry(0.5, 0.7, t.height, 8);
        const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5D4037 });
        const trunk = new THREE.Mesh(trunkGeo, trunkMat);
        trunk.position.y = t.height / 2;
        trunk.castShadow = true;
        treeGroup.add(trunk);

        // Foliage
        const foliageGeo = new THREE.ConeGeometry(3, t.height * 1.5, 8);
        const foliageMat = new THREE.MeshStandardMaterial({ color: 0x2E7D32 });
        const foliage = new THREE.Mesh(foliageGeo, foliageMat);
        foliage.position.y = t.height + (t.height * 0.75);
        foliage.castShadow = true;
        treeGroup.add(foliage);

        state.scene.add(treeGroup);
        state.obstacles.push({ x: t.x, z: t.z, radius: 1.5 } as any);
    });
}
