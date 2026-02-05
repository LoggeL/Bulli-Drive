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
        color: 0x4a8c3f,
        roughness: 0.9,
        metalness: 0.0
    });
    const ground = new THREE.Mesh(geometry, material);
    ground.receiveShadow = true;
    state.scene.add(ground);

    // Shared tree materials
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5D4037, roughness: 0.9 });
    const foliageMat = new THREE.MeshStandardMaterial({ color: 0x2E7D32, roughness: 0.8 });
    const foliageLightMat = new THREE.MeshStandardMaterial({ color: 0x3E8D42, roughness: 0.8 });

    // Obstacles (Trees)
    state.obstacles = [];
    treeData.forEach(t => {
        const treeGroup = new THREE.Group();
        treeGroup.position.set(t.x, getTerrainHeight(t.x, t.z), t.z);

        // Trunk
        const trunkGeo = new THREE.CylinderGeometry(0.5, 0.7, t.height, 8);
        const trunk = new THREE.Mesh(trunkGeo, trunkMat);
        trunk.position.y = t.height / 2;
        trunk.castShadow = true;
        trunk.receiveShadow = true;
        treeGroup.add(trunk);

        // Lower foliage (wider)
        const foliageGeo1 = new THREE.ConeGeometry(3.5, t.height * 1.0, 8);
        const foliage1 = new THREE.Mesh(foliageGeo1, foliageMat);
        foliage1.position.y = t.height + (t.height * 0.4);
        foliage1.castShadow = true;
        treeGroup.add(foliage1);

        // Upper foliage (narrower, lighter)
        const foliageGeo2 = new THREE.ConeGeometry(2.2, t.height * 0.9, 8);
        const foliage2 = new THREE.Mesh(foliageGeo2, foliageLightMat);
        foliage2.position.y = t.height + (t.height * 1.0);
        foliage2.castShadow = true;
        treeGroup.add(foliage2);

        state.scene.add(treeGroup);
        state.obstacles.push({ x: t.x, z: t.z, radius: 1.5 } as any);
    });
}
