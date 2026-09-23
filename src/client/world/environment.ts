import * as THREE from 'three';
import { state } from '../state.js';
import type { TreeData } from '../../shared/protocol.js';
import { mulberry32 } from '../../shared/math/rng.js';
import { getTerrainHeight as getSharedTerrainHeight } from '../../shared/world/terrain.js';
import { createTerrainMaterial } from '../effects/worldShaders.js';
import {
    insideCitySceneryExclusion,
    rockPlacements,
    ROCK_VISUAL_SEED,
    SCENERY_SEED
} from '../../shared/world/props.js';
import { markCollider } from './colliderTags.js';

// Height of the terrain the server configured (flat 0 before 'init').
export function getTerrainHeight(x: number, z: number) {
    if (!state.terrainConfig) return 0;
    return getSharedTerrainHeight(state.terrainConfig, x, z);
}

export function createEnvironment(treeData: TreeData[]) {
    if (!state.terrainConfig) return;
    const { size, segments } = state.terrainConfig;
    // Reset on every environment build so every client and reconnect produces
    // exactly the same procedural scenery. Rocks take position and size from
    // shared/world/props.ts (their colliders) and only their looks from here.
    const rockRandom = mulberry32(ROCK_VISUAL_SEED);
    const sceneryRandom = mulberry32(SCENERY_SEED);

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
    const color = new THREE.Color();

    for (let i = 0; i < vertices.length; i += 3) {
        const x = vertices[i];
        const z = vertices[i + 2];
        const h = getTerrainHeight(x, z);
        vertices[i + 1] = h;

        // Color based on height + noise. Only hilltops turn rocky (valleys stay
        // green), and the blend factor is clamped: extrapolating past the rock
        // color produced negative channels, which rendered as cyan patches.
        const vi = (i / 3) * 3;
        const noise = Math.sin(x * 0.1) * Math.cos(z * 0.1);
        const heightFactor = Math.max(h, 0) / 6.0;

        if (heightFactor > 0.7) {
            color.lerpColors(dirt, rock, Math.min((heightFactor - 0.7) / 0.3, 1));
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

    const material = createTerrainMaterial({
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
    const treeTrunkGeo = new THREE.CylinderGeometry(0.5, 0.7, 1, 8);
    const treeFoliageLowerGeo = new THREE.ConeGeometry(3.5, 1, 8);
    const treeFoliageUpperGeo = new THREE.ConeGeometry(2.2, 1, 8);

    // Trees from the server's world (colliders: shared/world/colliderGen.ts)
    treeData.forEach(t => {
        const treeGroup = new THREE.Group();
        treeGroup.position.set(t.x, getTerrainHeight(t.x, t.z), t.z);

        // Trunk
        const trunk = new THREE.Mesh(treeTrunkGeo, trunkMat);
        trunk.scale.y = t.height;
        trunk.position.y = t.height / 2;
        trunk.castShadow = true;
        trunk.receiveShadow = true;
        treeGroup.add(trunk);

        // Lower foliage (wider)
        const foliage1 = new THREE.Mesh(treeFoliageLowerGeo, foliageMat);
        foliage1.scale.y = t.height;
        foliage1.position.y = t.height + (t.height * 0.4);
        foliage1.castShadow = true;
        treeGroup.add(foliage1);

        // Upper foliage (narrower, lighter)
        const foliage2 = new THREE.Mesh(treeFoliageUpperGeo, foliageLightMat);
        foliage2.scale.y = t.height * 0.9;
        foliage2.position.y = t.height + (t.height * 1.0);
        foliage2.castShadow = true;
        treeGroup.add(foliage2);

        markCollider(treeGroup, 'tree');
        state.scene.add(treeGroup);
    });

    // Rocks around the city. Every rock draws the same number of values
    // from its visual stream, so one rock's looks never shift another's.
    for (const placement of rockPlacements()) {
        const { x: rx, z: rz, size: rockSize } = placement;
        const rockGroup = new THREE.Group();
        const h = getTerrainHeight(rx, rz);
        rockGroup.position.set(rx, h, rz);

        const dark = rockRandom() > 0.5;
        const rotX = rockRandom() * Math.PI, rotY = rockRandom() * Math.PI;
        const squash = 0.5 + rockRandom() * 0.4;
        const second = rockRandom() > 0.5;
        const smallRotX = rockRandom() * Math.PI, smallRotY = rockRandom() * Math.PI;

        const rock = new THREE.Mesh(rockGeoLarge, dark ? rockDarkMat : rockMat);
        rock.position.y = rockSize * 0.4;
        rock.rotation.set(rotX, rotY, 0);
        rock.scale.set(rockSize, rockSize * squash, rockSize);
        rock.castShadow = true;
        rock.receiveShadow = true;
        rockGroup.add(rock);

        // Sometimes a second, smaller rock
        if (second) {
            const smallSize = rockSize * 0.5;
            const smallRock = new THREE.Mesh(rockGeoSmall, rockDarkMat);
            smallRock.position.set(rockSize * 0.8, smallSize * 0.3, rockSize * 0.3);
            smallRock.rotation.set(smallRotX, smallRotY, 0);
            smallRock.scale.set(smallSize / 0.5, smallSize / 0.5 * 0.6, smallSize / 0.5);
            smallRock.castShadow = true;
            rockGroup.add(smallRock);
        }

        if (placement.collider) markCollider(rockGroup, 'rock');
        state.scene.add(rockGroup);
    }

    // Scatter bushes (reduced from 60 to 30)
    for (let i = 0; i < 30; i++) {
        const bx = (sceneryRandom() - 0.5) * 600;
        const bz = (sceneryRandom() - 0.5) * 600;
        if (insideCitySceneryExclusion(bx, bz)) continue;

        const h = getTerrainHeight(bx, bz);
        const bushGroup = new THREE.Group();
        bushGroup.position.set(bx, h, bz);

        const bushSize = 1.0 + sceneryRandom() * 1.5;
        const mainBush = new THREE.Mesh(
            bushGeoMain,
            sceneryRandom() > 0.5 ? bushMat : bushLightMat
        );
        mainBush.position.y = bushSize * 0.6;
        mainBush.scale.set(bushSize, bushSize * (0.6 + sceneryRandom() * 0.3), bushSize);
        mainBush.castShadow = true;
        bushGroup.add(mainBush);

        // Secondary lobe
        if (sceneryRandom() > 0.4) {
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
        const fx = (sceneryRandom() - 0.5) * 500;
        const fz = (sceneryRandom() - 0.5) * 500;
        if (insideCitySceneryExclusion(fx, fz)) continue;

        const h = getTerrainHeight(fx, fz);
        const patchGroup = new THREE.Group();
        patchGroup.position.set(fx, h + 0.05, fz);

        const flowerCount = 5 + Math.floor(sceneryRandom() * 10);
        const flowerMat = flowerMats[Math.floor(sceneryRandom() * flowerMats.length)];

        for (let j = 0; j < flowerCount; j++) {
            const flower = new THREE.Mesh(flowerGeo, flowerMat);
            const fScale = 0.75 + sceneryRandom() * 0.75;
            flower.scale.setScalar(fScale);
            flower.position.set(
                (sceneryRandom() - 0.5) * 4,
                0.15 + sceneryRandom() * 0.3,
                (sceneryRandom() - 0.5) * 4
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
