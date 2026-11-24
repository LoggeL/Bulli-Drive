// @vitest-environment happy-dom
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { loadTestMap } from './loadTestMap.js';
import { heightAt } from '../../src/shared/map/heightfield.js';
import { PLANT_COLLIDERS } from '../../src/shared/map/plants.js';
import { MAP_REGISTRY } from '../../src/shared/map/registry.js';
import { ChaseCamera, RACE_CAMERA, type ChaseTarget } from '../../src/client/camera/ChaseCamera.js';
import { ShowroomCamera, type ShowroomEnv } from '../../src/client/camera/ShowroomCamera.js';
import { createWorldMaterials } from '../../src/client/world/materials.js';
import { MapWorld, rockSinkDepth } from '../../src/client/world/mapWorld.js';
import { WORLD_QUALITY } from '../../src/client/world/worldQuality.js';

vi.mock('../../src/client/world/textures.js', async () => {
    const { Texture } = await import('three');
    return {
        worldTexture: () => new Texture(),
        cloneWorldTexture: (source: InstanceType<typeof Texture>) => source.clone(),
        whenWorldTextureLoaded: () => Promise.resolve()
    };
});

describe('Multi-map MapWorld lifecycle, dynamic layers & GPU disposal', () => {
    it('omits ocean sea on dry maps (alpen-pass, stunt-forge) and includes it on coastal/island maps (logge-forge)', () => {
        const M = createWorldMaterials('desktop');
        const alpen = new MapWorld(loadTestMap('alpen-pass'), 'desktop', M, WORLD_QUALITY.high, null);
        expect(alpen.group.children.map(c => c.name)).toEqual(['terrain', 'roads', 'kit', 'plants', 'props']);
        alpen.dispose();

        const quarry = new MapWorld(loadTestMap('stunt-forge'), 'desktop', M, WORLD_QUALITY.high, null);
        expect(quarry.group.children.map(c => c.name)).toEqual(['terrain', 'roads', 'kit', 'plants', 'props']);
        quarry.dispose();

        const forge = new MapWorld(loadTestMap('logge-forge'), 'desktop', M, WORLD_QUALITY.high, null);
        expect(forge.group.children.map(c => c.name)).toEqual(['terrain', 'sea', 'roads', 'kit', 'plants', 'props']);
        forge.dispose();
    });

    it('renders all boost pads in 1 merged draw call and discovery beacons in instanced non-shadow meshes', () => {
        const forgeMap = loadTestMap('logge-forge');
        const M = createWorldMaterials('mobile');
        const world = new MapWorld(forgeMap, 'mobile', M, WORLD_QUALITY.low, null);

        const boostGroup = world.group.getObjectByName('boost-pads')!;
        expect(boostGroup.children).toHaveLength(1);
        const boostMesh = boostGroup.children[0] as THREE.Mesh;
        expect(boostMesh.name).toBe('boost-pads-merged');
        expect(boostMesh.castShadow).toBe(false);

        const rings = world.group.getObjectByName('discovery-rings') as THREE.InstancedMesh;
        const markers = world.group.getObjectByName('discovery-markers') as THREE.InstancedMesh;
        const pinBeam = world.group.getObjectByName('discovery-pin-beam') as THREE.Mesh;
        expect(rings.isInstancedMesh).toBe(true);
        expect(markers.isInstancedMesh).toBe(true);
        expect(rings.count).toBe(forgeMap.discoveries.length);
        expect(rings.castShadow).toBe(false);
        expect(markers.castShadow).toBe(false);
        expect(pinBeam.visible).toBe(false);

        // Pinning a discovery positions and shows the vertical beacon pillar
        const target = forgeMap.discoveries[0];
        world.setDiscoveredIds(new Set([target.id]), target.id);
        expect(pinBeam.visible).toBe(true);
        expect(pinBeam.position.x).toBeCloseTo(target.x, 5);
        expect(pinBeam.position.z).toBeCloseTo(target.z, 5);

        // Clearing pin hides the beam; dynamic update and triggerDiscoveryFx run cleanly
        world.setDiscoveredIds(new Set([target.id]), null);
        expect(pinBeam.visible).toBe(false);
        world.updateDynamic(1 / 60, 1.5, { x: target.x, y: 0, z: target.z });
        expect(() => world.triggerDiscoveryFx(target.id)).not.toThrow();

        world.dispose();
    });

    it('disposes every owned GPU geometry, material, and texture while leaving shared WorldMaterials intact', () => {
        const forgeMap = loadTestMap('logge-forge');
        const M = createWorldMaterials('desktop');
        const sharedMaterials = new Set(Object.values(M).filter((v): v is THREE.Material => v instanceof THREE.Material));

        const world = new MapWorld(forgeMap, 'desktop', M, WORLD_QUALITY.high, null);
        const ownedGeomSpies: ReturnType<typeof vi.spyOn>[] = [];
        const ownedMatSpies: ReturnType<typeof vi.spyOn>[] = [];
        const sharedMatSpies: ReturnType<typeof vi.spyOn>[] = [];
        const seenGeoms = new Set<THREE.BufferGeometry>();
        const seenMats = new Set<THREE.Material>();

        for (const sm of sharedMaterials) sharedMatSpies.push(vi.spyOn(sm, 'dispose'));

        world.group.traverse(obj => {
            const mesh = obj as THREE.Mesh;
            if (!mesh.isMesh) return;
            if (mesh.geometry && !seenGeoms.has(mesh.geometry)) {
                seenGeoms.add(mesh.geometry);
                ownedGeomSpies.push(vi.spyOn(mesh.geometry, 'dispose'));
            }
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            for (const m of mats) {
                if (m && !sharedMaterials.has(m) && !seenMats.has(m)) {
                    seenMats.add(m);
                    ownedMatSpies.push(vi.spyOn(m, 'dispose'));
                }
            }
        });

        const seaMesh = world.group.getObjectByName('sea') as THREE.Mesh;
        const seaHeightTex = seaMesh.userData.heightTexture as THREE.DataTexture;
        const seaHeightSpy = vi.spyOn(seaHeightTex, 'dispose');

        expect(ownedGeomSpies.length).toBeGreaterThan(10);
        expect(ownedMatSpies.length).toBeGreaterThan(5);

        world.dispose();

        expect(world.isDisposed).toBe(true);
        expect(world.group.children).toHaveLength(0);
        expect(seaHeightSpy).toHaveBeenCalledTimes(1);
        for (const spy of ownedGeomSpies) expect(spy).toHaveBeenCalled();
        for (const spy of ownedMatSpies) expect(spy).toHaveBeenCalled();
        for (const spy of sharedMatSpies) expect(spy).not.toHaveBeenCalled();

        // Idempotent second dispose call does not throw or double-dispose seaHeightTex
        expect(() => world.dispose()).not.toThrow();
        expect(seaHeightSpy).toHaveBeenCalledTimes(1);
    });
});

describe('ShowroomCamera.setSpot & ChaseCamera dynamic feel', () => {
    it('relocates the showroom car and camera to a new map showroomSpot using that map heightfield', () => {
        const alpenMap = loadTestMap('alpen-pass');
        const spot = MAP_REGISTRY['alpen-pass'].showroomSpot;
        const env: ShowroomEnv = {
            groundHeight: () => 5,
            carFree: () => true,
            spawned: () => false,
            frame: () => null,
            spawnHint: () => null,
            reducedMotion: () => true,
            lite: false,
            maxFps: 0,
            now: () => 0
        };
        const showroom = new ShowroomCamera(env);
        const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 2600);
        const chase = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2600);
        const car = { group: new THREE.Group(), bodyGroup: new THREE.Group(), angle: 0 };

        showroom.setSpot(spot, alpenMap);
        showroom.update(camera, car, chase);

        const expectedY = heightAt(alpenMap.hf, spot.x, spot.z);
        expect(car.group.position.x).toBeCloseTo(spot.x, 5);
        expect(car.group.position.y).toBeCloseTo(expectedY, 5);
        expect(car.group.position.z).toBeCloseTo(spot.z, 5);
        expect(car.angle).toBeCloseTo(spot.yaw, 5);
        // Camera sits ~10 m in front of the new spot, not back at Bulli Bay pier (-745, -18)
        expect(Math.hypot(camera.position.x - spot.x, camera.position.z - spot.z)).toBeCloseTo(10, 2);
    });

    it('applies FOV punch, drift counter-framing, and airtime look-down bias when requested', () => {
        const chase = new ChaseCamera(RACE_CAMERA);
        const camBase = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
        const target: ChaseTarget = { position: new THREE.Vector3(0, 0, 0), yaw: 0, speedRatio: 0.5, boost: false };
        chase.update(1 / 60, camBase, target, true);
        const baselineFov = camBase.fov;
        const baselineX = camBase.position.x;

        chase.kickBoostFov(6);
        chase.kickShake(0.15);
        target.slipAngle = 0.45;
        target.airHeight = 5.0;
        for (let i = 0; i < 15; i++) chase.update(1 / 60, camBase, target, false);

        expect(camBase.fov).toBeGreaterThan(baselineFov);
        expect(camBase.fov).toBeLessThanOrEqual(RACE_CAMERA.maxFov);
        // Positive slip shifts camera slightly toward -X (right vector for yaw=0 is (+1, 0, 0), desiredDrift < 0)
        expect(camBase.position.x).toBeLessThan(baselineX - 0.15);
    });
});

describe('Alpine slope boulder grounding & Vite dynamic import cleanliness', () => {
    it('sinks rocks/boulders proportional to local terrain slope so downhill rims never float', () => {
        // Flat ground: baseline 0.35 * size
        expect(rockSinkDepth(0, 'boulder', 1)).toBeCloseTo(0.35, 6);
        expect(rockSinkDepth(0, 'rock', 1.2)).toBeCloseTo(0.35 * 1.2, 6);

        // 34 deg alpine slope (tan 34 deg = 0.67451): boulder radius 2.2 m
        // Expected by hand: 0.35 + 0.67451 * 2.2 * 0.65 = 1.31455 m
        const slope34 = Math.tan(34 * Math.PI / 180);
        expect(rockSinkDepth(slope34, 'boulder', 1)).toBeCloseTo(0.35 + slope34 * PLANT_COLLIDERS.boulder.r * 0.65, 5);
        expect(rockSinkDepth(slope34, 'boulder', 1)).toBeGreaterThan(1.25);

        // Extreme cliff slope caps cleanly at 72% of rock height so the top stays visible
        expect(rockSinkDepth(4.0, 'boulder', 1)).toBeCloseTo(PLANT_COLLIDERS.boulder.top * 0.72, 6);
    });

    it('keeps look.ts free of static bulli-bay/map.json imports (avoids Vite ineffective dynamic import warning)', () => {
        const lookSource = fs.readFileSync(path.resolve(__dirname, '../../src/client/render/look.ts'), 'utf8');
        expect(lookSource).not.toMatch(/bulli-bay\/map\.json/);
    });
});
