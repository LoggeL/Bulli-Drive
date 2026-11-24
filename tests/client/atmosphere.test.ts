import * as THREE from 'three';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { MAP_REGISTRY } from '../../src/shared/map/registry.js';
import {
    applyMapAtmosphere, atmosphereTuningFor, LOOK, SUN_DIRECTION, sunDirectionFor, WORLD_UNIFORMS
} from '../../src/client/render/look.js';

describe('per-map atmosphere & uniform-driven height fog', () => {
    afterAll(() => {
        // Restore Bulli Bay default uniforms so other suites see initial state
        applyMapAtmosphere(MAP_REGISTRY['bulli-bay'].atmosphere);
    });

    it('computes sun direction from compass azimuth & elevation matching hand-calculated spherical coordinates', () => {
        // Bulli Bay default: compass azimuth 285 deg -> lookAzimuth = 540 - 285 = 255 deg, elevation 17 deg
        const bulli = sunDirectionFor(285, 17);
        const rad = Math.PI / 180;
        const expectedX = Math.sin(255 * rad) * Math.cos(17 * rad);
        const expectedY = Math.sin(17 * rad);
        const expectedZ = Math.cos(255 * rad) * Math.cos(17 * rad);
        expect(bulli.x).toBeCloseTo(expectedX, 6);
        expect(bulli.y).toBeCloseTo(expectedY, 6);
        expect(bulli.z).toBeCloseTo(expectedZ, 6);
        expect(bulli.length()).toBeCloseTo(1, 6);
        expect(bulli.distanceTo(SUN_DIRECTION)).toBeLessThan(1e-6);

        // High noon at 90 deg elevation points straight up (+Y)
        const zenith = sunDirectionFor(0, 90);
        expect(zenith.x).toBeCloseTo(0, 6);
        expect(zenith.y).toBeCloseTo(1, 6);
        expect(zenith.z).toBeCloseTo(0, 6);
    });

    it('updates live WORLD_UNIFORMS, scene fog, lights, exposure and sky across all 4 maps without recompiling', () => {
        const scene = new THREE.Scene();
        scene.fog = new THREE.Fog(0x000000, 10, 100);
        const sun = new THREE.DirectionalLight(0xffffff, 1);
        const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
        const renderer = { toneMappingExposure: 1 } as unknown as THREE.WebGLRenderer;
        const skySpy = vi.fn();
        const sky = { applyAtmosphere: skySpy };

        for (const [id, desc] of Object.entries(MAP_REGISTRY)) {
            const spec = desc.atmosphere;
            applyMapAtmosphere(spec, { scene, sun, hemi, renderer, sky });

            const expectedDir = sunDirectionFor(spec.sunAzimuth, spec.sunElevation);
            expect(WORLD_UNIFORMS.uSunDir.value.distanceTo(expectedDir), id).toBeLessThan(1e-6);

            const fog = scene.fog as THREE.Fog;
            expect(fog.near, id).toBe(spec.fogNear);
            expect(fog.far, id).toBeGreaterThanOrEqual(spec.fogFar);

            const expectedSunColor = spec.biome === 'coastal' ? LOOK.sunColor : spec.sunColor;
            const expectedSunInt = spec.biome === 'coastal' ? LOOK.sunIntensity : spec.sunIntensity;
            const expectedHemiSky = spec.biome === 'coastal' ? LOOK.hemiSky : spec.hemiSky;
            const expectedHemiGround = spec.biome === 'coastal' ? LOOK.hemiGround : spec.hemiGround;
            const expectedHemiInt = spec.biome === 'coastal' ? LOOK.hemiIntensity : spec.hemiIntensity;
            const expectedExposure = spec.biome === 'coastal' ? LOOK.exposure : spec.exposure;

            expect(sun.color.getHex(), id).toBe(expectedSunColor);
            expect(sun.intensity, id).toBe(expectedSunInt);
            expect(hemi.color.getHex(), id).toBe(expectedHemiSky);
            expect(hemi.groundColor.getHex(), id).toBe(expectedHemiGround);
            expect(hemi.intensity, id).toBe(expectedHemiInt);
            expect(renderer.toneMappingExposure, id).toBe(expectedExposure);

            const expectedTuning = atmosphereTuningFor(spec);
            expect(WORLD_UNIFORMS.uFogDensity.value, id).toBeCloseTo(expectedTuning.fogDensity, 8);
            expect(WORLD_UNIFORMS.uFogStart.value, id).toBe(expectedTuning.fogStart);
            expect(WORLD_UNIFORMS.uFogMax.value, id).toBeCloseTo(expectedTuning.fogMax, 6);
            expect(WORLD_UNIFORMS.uFogColor.value.r, id).toBeCloseTo(expectedTuning.fogColor[0], 5);
            expect(WORLD_UNIFORMS.uFogColor.value.g, id).toBeCloseTo(expectedTuning.fogColor[1], 5);
            expect(WORLD_UNIFORMS.uFogColor.value.b, id).toBeCloseTo(expectedTuning.fogColor[2], 5);
        }

        expect(skySpy).toHaveBeenCalledTimes(4);
    });

    it('gives each biome distinct fog mood while preserving Bulli Bay coastal LOOK defaults', () => {
        const coastal = atmosphereTuningFor(MAP_REGISTRY['bulli-bay'].atmosphere);
        const alpine = atmosphereTuningFor(MAP_REGISTRY['alpen-pass'].atmosphere);
        const quarry = atmosphereTuningFor(MAP_REGISTRY['stunt-forge'].atmosphere);
        const forge = atmosphereTuningFor(MAP_REGISTRY['logge-forge'].atmosphere);

        // Bulli Bay matches LOOK constants exactly
        expect(coastal.fogDensity).toBe(LOOK.fog.density);
        expect(coastal.fogHeightFalloff).toBe(LOOK.fog.heightFalloff);
        expect(coastal.fogStart).toBe(LOOK.fog.start);
        expect(coastal.fogMax).toBe(LOOK.fog.max);

        // Forge twilight is thicker & warmer than crisp alpine snow air
        expect(forge.fogDensity).toBeGreaterThan(alpine.fogDensity);
        expect(forge.fogMax).toBeGreaterThan(alpine.fogMax);
        // Forge ember glow is red-dominant; alpine sun glow is cooler/bluer
        expect(forge.fogSunColor[0] / forge.fogSunColor[2]).toBeGreaterThan(alpine.fogSunColor[0] / alpine.fogSunColor[2]);
        expect(quarry.fogSunColor[0]).not.toBeCloseTo(alpine.fogSunColor[0], 2);
    });
});
