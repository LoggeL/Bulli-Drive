// @vitest-environment happy-dom
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { loadTestMap } from './loadTestMap.js';
import { heightAt } from '../../src/shared/map/heightfield.js';
import { KIT_FOOTPRINTS } from '../../src/shared/map/structures.js';
import { MAP_REGISTRY } from '../../src/shared/map/registry.js';
import { ChaseCamera, RACE_CAMERA, type ChaseTarget } from '../../src/client/camera/ChaseCamera.js';
import { ShowroomCamera, type ShowroomEnv } from '../../src/client/camera/ShowroomCamera.js';
import { DISCOVERY_RING_LIFT, DiscoveryRenderer } from '../../src/client/world/discoveryRenderer.js';
import { createWorldMaterials } from '../../src/client/world/materials.js';
import { MapWorld, rockSinkDepth } from '../../src/client/world/mapWorld.js';
import { WORLD_QUALITY } from '../../src/client/world/worldQuality.js';
import { makeHeightfield } from '../shared/map/fixtures.js';

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

        const rings = world.group.getObjectByName('discovery-rings') as THREE.Mesh;
        const markers = world.group.getObjectByName('discovery-markers') as THREE.InstancedMesh;
        const pinBeam = world.group.getObjectByName('discovery-pin-beam') as THREE.Mesh;
        expect(rings.isMesh).toBe(true);
        expect(markers.isInstancedMesh).toBe(true);
        expect(markers.count).toBe(forgeMap.discoveries.length);
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

describe('Alpine slope boulder grounding, conformed discovery rings & Vite dynamic import cleanliness', () => {
    it('sinks rocks/boulders to exact minCornerY over their rotated footprint so zero boulders hover on steep slopes', () => {
        // Flat ground: baseline 0.25 * size
        const flatHf = makeHeightfield(() => 10);
        expect(rockSinkDepth(flatHf, 0, 0, 0, 'boulder', 1)).toBeCloseTo(0.25, 6);
        expect(rockSinkDepth(flatHf, 0, 0, 0, 'rock', 1.2)).toBeCloseTo(0.25 * 1.2, 6);

        // 34 deg slope descending along +x: y = 50 - tan(34 deg) * x
        // At yaw = 0, rock_boulder_l's maxX = 3.066 * size drops downhill by tan(34°) * 3.066!
        const slope34 = Math.tan(34 * Math.PI / 180);
        const slopedHf = makeHeightfield(x => 50 - slope34 * x);
        const fpL = KIT_FOOTPRINTS.rock_boulder_l;
        const sink0 = rockSinkDepth(slopedHf, 0, 0, 0, 'boulder', 1);
        expect(sink0).toBeCloseTo(0.25 + slope34 * fpL.maxX, 2);
        // At yaw = PI, minX (-2.467) now faces +x downhill (asymmetric footprint rotates accurately!)
        const sinkPi = rockSinkDepth(slopedHf, 0, 0, Math.PI, 'boulder', 1);
        expect(sinkPi).toBeCloseTo(0.25 + slope34 * Math.abs(fpL.minX), 2);
        expect(sink0).toBeGreaterThan(sinkPi + 0.3);

        // Across ALL 4 shipped maps, zero rocks/boulders have downhill rim hover above any footprint corner
        for (const mapId of ['alpen-pass', 'stunt-forge', 'bulli-bay', 'logge-forge'] as const) {
            const m = loadTestMap(mapId);
            for (const plant of m.plants) {
                if (plant.kind !== 'boulder' && plant.kind !== 'rock') continue;
                const yaw = (plant.seed % 360) * Math.PI / 180;
                const sink = rockSinkDepth(m.hf, plant.x, plant.z, yaw, plant.kind, plant.size);
                const baseY = heightAt(m.hf, plant.x, plant.z) - sink;
                const fp = KIT_FOOTPRINTS[plant.kind === 'boulder' ? 'rock_boulder_l' : 'rock_boulder_m'];
                const cos = Math.cos(yaw), sin = Math.sin(yaw);
                for (const [lx, lz] of [[fp.minX, fp.minZ], [fp.maxX, fp.minZ], [fp.maxX, fp.maxZ], [fp.minX, fp.maxZ]]) {
                    const hy = heightAt(m.hf, plant.x + (lx * cos + lz * sin) * plant.size, plant.z + (-lx * sin + lz * cos) * plant.size);
                    expect(baseY, `${mapId} ${plant.kind} at (${plant.x},${plant.z})`).toBeLessThanOrEqual(hy + 1e-4);
                }
            }
        }
    });

    it('conforms every discovery ring vertex to heightAt(hf, wx, wz) + 0.08 on sloped terrain', () => {
        const forgeMap = loadTestMap('logge-forge');
        const vault = forgeMap.discoveries.find(d => d.id === 'transcripator-vault')!;
        const renderer = new DiscoveryRenderer(forgeMap, 'desktop');
        renderer.update(0, 0, { x: vault.x, y: 0, z: vault.z });
        const ringMesh = renderer.group.getObjectByName('discovery-rings') as THREE.Mesh;
        const pos = ringMesh.geometry.attributes.position as THREE.BufferAttribute;

        const vaultIdx = forgeMap.discoveries.findIndex(d => d.id === 'transcripator-vault');
        const vertsPerRing = pos.count / forgeMap.discoveries.length;
        let minY = Infinity, maxY = -Infinity;
        for (let k = 0; k < vertsPerRing; k++) {
            const i = vaultIdx * vertsPerRing + k;
            const wx = pos.getX(i), wy = pos.getY(i), wz = pos.getZ(i);
            const expected = heightAt(forgeMap.hf, wx, wz) + DISCOVERY_RING_LIFT + (vault.yOffset ?? 0);
            expect(wy).toBeCloseTo(expected, 4);
            minY = Math.min(minY, wy);
            maxY = Math.max(maxY, wy);
        }
        // Ring follows the sloped hillside (> 0.5 m elevation span) instead of lying flat
        expect(maxY - minY).toBeGreaterThan(0.5);
        renderer.dispose();
    });

    it('keeps look.ts free of static bulli-bay/map.json imports (avoids Vite ineffective dynamic import warning)', () => {
        const lookSource = fs.readFileSync(path.resolve(__dirname, '../../src/client/render/look.ts'), 'utf8');
        expect(lookSource).not.toMatch(/bulli-bay\/map\.json/);
    });
});
