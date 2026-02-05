import * as THREE from 'three';
import { state } from '../state.js';
import { TreeData } from '../types.js';

export function getTerrainHeight(x: number, z: number) {
    if (!state.terrainConfig) return 0;
    const { frequency1, amplitude1, frequency2, amplitude2 } = state.terrainConfig;
    const freq3 = (state.terrainConfig as any).frequency3 || 0;
    const amp3 = (state.terrainConfig as any).amplitude3 || 0;

    // Flatten city area (within ~110 units of center)
    const distFromCenter = Math.sqrt(x * x + z * z);
    const cityRadius = 110;
    const blendRadius = 40;
    let flattenFactor = 1.0;
    if (distFromCenter < cityRadius) {
        flattenFactor = 0.0;
    } else if (distFromCenter < cityRadius + blendRadius) {
        flattenFactor = (distFromCenter - cityRadius) / blendRadius;
        flattenFactor = flattenFactor * flattenFactor; // Smooth ease-in
    }

    const height = (
        Math.sin(x * frequency1) * amplitude1 +
        Math.cos(z * frequency1) * amplitude1 +
        Math.sin(x * frequency2 + z * frequency2) * amplitude2 +
        Math.sin(x * freq3 + 1.7) * Math.cos(z * freq3 + 2.3) * amp3
    ) * flattenFactor;

    return height;
}

export function createEnvironment(treeData: TreeData[]) {
    if (!state.terrainConfig) return;
    const { size, segments } = state.terrainConfig;

    // Ground Plane
    const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
    geometry.rotateX(-Math.PI / 2);

    // Apply terrain height to vertices + vertex colors
    const vertices = geometry.attributes.position.array as Float32Array;
    const vertexCount = vertices.length / 3;
    const colors = new Float32Array(vertexCount * 3);

    // Base colors
    const grassDark = new THREE.Color(0x3a7c2f);
    const grassLight = new THREE.Color(0x5a9c4f);
    const dirt = new THREE.Color(0x8B7355);
    const rock = new THREE.Color(0x777777);

    for (let i = 0; i < vertices.length; i += 3) {
        const x = vertices[i];
        const z = vertices[i + 2];
        const h = getTerrainHeight(x, z);
        vertices[i + 1] = h;

        // Color based on height + noise
        const vi = (i / 3) * 3;
        const noise = Math.sin(x * 0.1) * Math.cos(z * 0.1);
        const heightFactor = Math.abs(h) / 6.0;

        const color = new THREE.Color();
        if (heightFactor > 0.7) {
            color.lerpColors(dirt, rock, (heightFactor - 0.7) / 0.3);
        } else if (noise > 0.3) {
            color.copy(dirt).lerp(grassLight, 0.5);
        } else {
            color.lerpColors(grassDark, grassLight, noise * 0.5 + 0.5);
        }

        colors[vi] = color.r;
        colors[vi + 1] = color.g;
        colors[vi + 2] = color.b;
    }

    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({
        vertexColors: true,
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

    // Rock materials
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.95, metalness: 0.05 });
    const rockDarkMat = new THREE.MeshStandardMaterial({ color: 0x666666, roughness: 0.95, metalness: 0.05 });

    // Bush materials
    const bushMat = new THREE.MeshStandardMaterial({ color: 0x2D6B22, roughness: 0.9 });
    const bushLightMat = new THREE.MeshStandardMaterial({ color: 0x3D8B32, roughness: 0.9 });

    // Shared geometries - create once, reuse for all instances
    const rockGeoLarge = new THREE.DodecahedronGeometry(1.0, 0);
    const rockGeoSmall = new THREE.DodecahedronGeometry(0.5, 0);
    const bushGeoMain = new THREE.SphereGeometry(1.0, 8, 6);
    const bushGeoLobe = new THREE.SphereGeometry(0.7, 6, 5);
    const flowerGeo = new THREE.SphereGeometry(0.2, 6, 4);
    const stemGeo = new THREE.CylinderGeometry(0.02, 0.03, 0.3, 4);
    const stemMat = new THREE.MeshStandardMaterial({ color: 0x2D6B22 });

    // Obstacles (Trees) - server-driven, keep all
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

    // Scatter rocks across the terrain (reduced from 80 to 40)
    for (let i = 0; i < 40; i++) {
        const rx = (Math.random() - 0.5) * 700;
        const rz = (Math.random() - 0.5) * 700;
        // Skip city area
        if (Math.abs(rx) < 120 && Math.abs(rz) < 120) continue;

        const rockGroup = new THREE.Group();
        const h = getTerrainHeight(rx, rz);
        rockGroup.position.set(rx, h, rz);

        const rockSize = 0.8 + Math.random() * 2.0;
        const rock = new THREE.Mesh(rockGeoLarge, Math.random() > 0.5 ? rockMat : rockDarkMat);
        rock.position.y = rockSize * 0.4;
        rock.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
        rock.scale.set(rockSize, rockSize * (0.5 + Math.random() * 0.4), rockSize);
        rock.castShadow = true;
        rock.receiveShadow = true;
        rockGroup.add(rock);

        // Sometimes add a second smaller rock
        if (Math.random() > 0.5) {
            const smallSize = rockSize * 0.5;
            const smallRock = new THREE.Mesh(rockGeoSmall, rockDarkMat);
            smallRock.position.set(rockSize * 0.8, smallSize * 0.3, rockSize * 0.3);
            smallRock.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
            smallRock.scale.set(smallSize / 0.5, smallSize / 0.5 * 0.6, smallSize / 0.5);
            smallRock.castShadow = true;
            rockGroup.add(smallRock);
        }

        state.scene.add(rockGroup);
        if (rockSize > 1.2) {
            state.obstacles.push({ x: rx, z: rz, radius: rockSize * 0.7 } as any);
        }
    }

    // Scatter bushes (reduced from 60 to 30)
    for (let i = 0; i < 30; i++) {
        const bx = (Math.random() - 0.5) * 600;
        const bz = (Math.random() - 0.5) * 600;
        if (Math.abs(bx) < 120 && Math.abs(bz) < 120) continue;

        const h = getTerrainHeight(bx, bz);
        const bushGroup = new THREE.Group();
        bushGroup.position.set(bx, h, bz);

        const bushSize = 1.0 + Math.random() * 1.5;
        const mainBush = new THREE.Mesh(
            bushGeoMain,
            Math.random() > 0.5 ? bushMat : bushLightMat
        );
        mainBush.position.y = bushSize * 0.6;
        mainBush.scale.set(bushSize, bushSize * (0.6 + Math.random() * 0.3), bushSize);
        mainBush.castShadow = true;
        bushGroup.add(mainBush);

        // Secondary lobe
        if (Math.random() > 0.4) {
            const lobSize = bushSize * 0.7;
            const lobe = new THREE.Mesh(
                bushGeoLobe,
                bushLightMat
            );
            lobe.position.set(bushSize * 0.6, lobSize * 0.5, bushSize * 0.3);
            lobe.scale.set(lobSize / 0.7, lobSize / 0.7 * 0.7, lobSize / 0.7);
            lobe.castShadow = true;
            bushGroup.add(lobe);
        }

        state.scene.add(bushGroup);
    }

    // Scatter wildflower patches (reduced from 40 to 20)
    const flowerColors = [0xFF6B9D, 0xFFD93D, 0xC084FC, 0xFF8C42, 0x6BCB77];
    // Pre-create flower materials for each color (shared across patches)
    const flowerMats = flowerColors.map(c => new THREE.MeshStandardMaterial({
        color: c, emissive: c, emissiveIntensity: 0.15, roughness: 0.8
    }));
    for (let i = 0; i < 20; i++) {
        const fx = (Math.random() - 0.5) * 500;
        const fz = (Math.random() - 0.5) * 500;
        if (Math.abs(fx) < 120 && Math.abs(fz) < 120) continue;

        const h = getTerrainHeight(fx, fz);
        const patchGroup = new THREE.Group();
        patchGroup.position.set(fx, h + 0.05, fz);

        const flowerCount = 5 + Math.floor(Math.random() * 10);
        const flowerMat = flowerMats[Math.floor(Math.random() * flowerMats.length)];

        for (let j = 0; j < flowerCount; j++) {
            const flower = new THREE.Mesh(flowerGeo, flowerMat);
            const fScale = 0.75 + Math.random() * 0.75;
            flower.scale.setScalar(fScale);
            flower.position.set(
                (Math.random() - 0.5) * 4,
                0.15 + Math.random() * 0.3,
                (Math.random() - 0.5) * 4
            );
            patchGroup.add(flower);

            // Stem
            const stem = new THREE.Mesh(stemGeo, stemMat);
            stem.position.set(flower.position.x, flower.position.y - 0.15, flower.position.z);
            patchGroup.add(stem);
        }

        state.scene.add(patchGroup);
    }
}
