import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadTestMap } from './loadTestMap.js';
import { PropBatch } from '../../src/client/world/furniture.js';
import {
    disposeMapFeatures, mapFeaturesGroup, RAMP_SKIRT_DEPTH, rampMesh, type LookedRamp
} from '../../src/client/race/TrackDressing.js';

vi.mock('../../src/client/world/textures.js', async () => {
    const { Texture } = await import('three');
    return {
        worldTexture: () => new Texture(),
        cloneWorldTexture: (source: InstanceType<typeof Texture>) => source.clone(),
        whenWorldTextureLoaded: () => Promise.resolve()
    };
});

afterEach(() => {
    disposeMapFeatures();
});

describe('TrackDressing mapFeaturesGroup cache keying & disposal', () => {
    it('reuses the ramp group for the same mapId:worldHash and disposes/rebuilds cleanly on map switch', () => {
        const bulli = loadTestMap('bulli-bay');
        const alpen = loadTestMap('alpen-pass');
        const forge = loadTestMap('logge-forge');
        const stunt = loadTestMap('stunt-forge');

        const scene = new THREE.Scene();

        const gBulli1 = mapFeaturesGroup(bulli)!;
        expect(gBulli1).not.toBeNull();
        expect(gBulli1.userData.mapKey).toBe(`${bulli.mapId}:${bulli.worldHash}`);
        scene.add(gBulli1);

        // Same map returns cached group without rebuilding
        const gBulli2 = mapFeaturesGroup(bulli)!;
        expect(gBulli2).toBe(gBulli1);

        const bulliMesh = gBulli1.children[0] as THREE.Mesh;
        expect(bulliMesh.isMesh).toBe(true);
        const bulliDispose = vi.spyOn(bulliMesh.geometry, 'dispose');
        const bulliBox = bulliMesh.geometry.boundingBox!.clone();

        // Switching to alpen-pass detaches and disposes Bulli Bay ramps and builds Alpen Pass ramps
        const gAlpen = mapFeaturesGroup(alpen)!;
        expect(gAlpen).not.toBe(gBulli1);
        expect(gAlpen.userData.mapKey).toBe(`${alpen.mapId}:${alpen.worldHash}`);
        expect(gBulli1.parent).toBeNull();
        expect(bulliDispose).toHaveBeenCalledTimes(1);

        const alpenMesh = gAlpen.children[0] as THREE.Mesh;
        expect(alpenMesh.isMesh).toBe(true);
        const alpenBox = alpenMesh.geometry.boundingBox!;
        // Every alpen-pass ramp lies inside alpenBox, and Bulli Bay ghost bounds differ completely
        for (const r of alpen.ramps) {
            expect(r.x).toBeGreaterThanOrEqual(alpenBox.min.x - r.width - r.length);
            expect(r.x).toBeLessThanOrEqual(alpenBox.max.x + r.width + r.length);
            expect(r.z).toBeGreaterThanOrEqual(alpenBox.min.z - r.width - r.length);
            expect(r.z).toBeLessThanOrEqual(alpenBox.max.z + r.width + r.length);
        }
        expect(alpenBox.max.y).not.toBeCloseTo(bulliBox.max.y, 0);

        // Switching through logge-forge and stunt-forge builds each map's distinct ramp geometry
        const gForge = mapFeaturesGroup(forge)!;
        expect(gForge.userData.mapKey).toBe(`${forge.mapId}:${forge.worldHash}`);
        expect((gForge.children[0] as THREE.Mesh).geometry.attributes.position.count).toBeGreaterThan(0);

        const gStunt = mapFeaturesGroup(stunt)!;
        expect(gStunt.userData.mapKey).toBe(`${stunt.mapId}:${stunt.worldHash}`);
        expect((gStunt.children[0] as THREE.Mesh).geometry.attributes.position.count).toBeGreaterThan(0);

        // Passing null disposes active mapFeatures and returns null
        expect(mapFeaturesGroup(null)).toBeNull();
    });
});

describe('TrackDressing rampMesh front-face winding & ground conforming', () => {
    it('winds the front vertical face outward (+along) at every yaw so it is never backface-culled', () => {
        for (const yaw of [0, Math.PI / 2, -Math.PI / 2, Math.PI, 0.7]) {
            const ramp: LookedRamp = { x: 10, z: -20, yaw, width: 8, length: 12, height: 2.4, look: 'steel' };
            const props = new PropBatch('test-ramp');
            rampMesh(props, ramp, () => 5);
            const geom = props.build()!;
            const pos = geom.attributes.position;
            const idx = geom.index!;

            const alongX = Math.sin(yaw), alongZ = Math.cos(yaw);
            const halfL = ramp.length / 2;
            const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
            const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();

            let frontFaceTris = 0;
            for (let t = 0; t < idx.count; t += 3) {
                a.fromBufferAttribute(pos, idx.getX(t));
                b.fromBufferAttribute(pos, idx.getX(t + 1));
                c.fromBufferAttribute(pos, idx.getX(t + 2));

                // Identify the main ramp body's vertical front-lip triangles: all 3 vertices sit at along == +halfL
                // and span height >= 2 m (excluding the small lip bar)
                const alongOf = (v: THREE.Vector3) => (v.x - ramp.x) * alongX + (v.z - ramp.z) * alongZ;
                if (Math.abs(alongOf(a) - halfL) < 1e-3 && Math.abs(alongOf(b) - halfL) < 1e-3 && Math.abs(alongOf(c) - halfL) < 1e-3) {
                    const dy = Math.max(a.y, b.y, c.y) - Math.min(a.y, b.y, c.y);
                    if (dy < 1.5) continue;
                    ab.subVectors(b, a);
                    ac.subVectors(c, a);
                    n.crossVectors(ab, ac).normalize();
                    const dot = n.x * alongX + n.z * alongZ;
                    expect(dot, `yaw=${yaw} front triangle must face +along`).toBeGreaterThan(0.99);
                    frontFaceTris++;
                }
            }
            expect(frontFaceTris, `yaw=${yaw} should emit 2 front-face triangles`).toBe(2);
            geom.dispose();
        }
    });

    it('conforms rear entry edge vertices to sloped terrain and drops side/rear skirts to -1.0 m', () => {
        // Cross-sloped terrain: y = 10 + 0.25 * x + 0.1 * z (at yaw=0, rear is z=-6:
        // across=-4 -> x=-4 => y=8.4; across=0 -> y=9.4; across=+4 -> x=+4 => y=10.4)
        const slope = (x: number, z: number) => 10 + 0.25 * x + 0.1 * z;
        const ramp: LookedRamp = { x: 0, z: 0, yaw: 0, width: 8, length: 12, height: 2.0, look: 'earth' };
        const props = new PropBatch('sloped-ramp');
        rampMesh(props, ramp, slope);
        const geom = props.build()!;
        const pos = geom.attributes.position;

        const halfW = ramp.width / 2;
        const halfL = ramp.length / 2;
        const rearCorners = [-halfW, 0, halfW];

        for (const rx of rearCorners) {
            const expectedGround = slope(rx, -halfL);
            const ysAtCorner: number[] = [];
            for (let i = 0; i < pos.count; i++) {
                if (Math.abs(pos.getX(i) - rx) < 1e-3 && Math.abs(pos.getZ(i) - (-halfL)) < 1e-3) {
                    ysAtCorner.push(pos.getY(i));
                }
            }
            expect(ysAtCorner.length, `rear vertex at x=${rx}`).toBeGreaterThan(0);
            // Deck rear entry sits flush with terrain (exact ground height), never hovering or buried
            expect(Math.max(...ysAtCorner)).toBeCloseTo(expectedGround, 4);
            // Rear/side skirt drops at least RAMP_SKIRT_DEPTH (1.0 m) below ground
            expect(Math.min(...ysAtCorner)).toBeLessThanOrEqual(expectedGround - RAMP_SKIRT_DEPTH + 1e-4);
        }

        // Front takeoff lip lifts cleanly to max(rearLeft, rearCenter, rearRight) + ramp.height = 10.4 + 2.0 = 12.4
        const expectedLipY = Math.max(...rearCorners.map(rx => slope(rx, -halfL))) + ramp.height;
        const frontDeckYs: number[] = [];
        for (let i = 0; i < pos.count; i++) {
            if (Math.abs(pos.getZ(i) - halfL) < 1e-3 && Math.abs(Math.abs(pos.getX(i)) - halfW) < 1e-3) {
                frontDeckYs.push(pos.getY(i));
            }
        }
        expect(Math.max(...frontDeckYs)).toBeCloseTo(expectedLipY, 4);
        geom.dispose();
    });
});
