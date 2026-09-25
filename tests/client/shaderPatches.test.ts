import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { installGrade, installHeightFog } from '../../src/client/render/look.js';
import { patchReflectionBend, patchShadowChunks, patchShadowFilter } from '../../src/client/render/lighting.js';
import { patchWorldMaterial } from '../../src/client/world/materials.js';

// The look patches three's shaders by string replacement (render/look.ts,
// render/lighting.ts, world/materials.ts). A replacement whose target is gone
// after a three.js upgrade does nothing and raises no error, so the world
// silently loses its fog, grade, shadow fade or material blocks. These tests
// run every patch against the shader sources of the installed three.js and
// check that each one landed.

const chunks = THREE.ShaderChunk as unknown as Record<string, string>;

function count(text: string, part: string): number {
    return text.split(part).length - 1;
}

describe('shader patches against the installed three.js', () => {
    it('wraps ACES with the grade and moves the fog before tone mapping', () => {
        installGrade();
        installHeightFog();
        // The original ACES is renamed and the graded one defined once
        expect(count(chunks.tonemapping_pars_fragment, 'vec3 ACESFilmicToneMappingBase( vec3 color ) {')).toBe(1);
        expect(count(chunks.tonemapping_pars_fragment, 'vec3 ACESFilmicToneMapping( vec3 color ) {')).toBe(1);
        // Height fog mixed in linear HDR right before tone mapping, three's
        // own fog after it switched off
        expect(chunks.tonemapping_fragment.indexOf('bulliFogAmount')).toBeGreaterThanOrEqual(0);
        expect(chunks.tonemapping_fragment.indexOf('bulliFogAmount')).toBeLessThan(chunks.tonemapping_fragment.indexOf('toneMapping('));
        expect(chunks.fog_fragment).toBe('');
        expect(chunks.fog_vertex).toContain('vFogWorldPosition');
    });

    it('filters PCF shadows with the smooth 3 x 3 grid instead of the noisy disk', () => {
        expect(patchShadowFilter()).toBe(true);
        const shadowmap = chunks.shadowmap_pars_fragment;
        const pcf = shadowmap.slice(shadowmap.indexOf('float getShadow( sampler2DShadow'), shadowmap.indexOf('#elif defined( SHADOWMAP_TYPE_VSM )'));
        expect(pcf).toContain('// bulli: 3x3 PCF');
        expect(pcf).toContain('shadow *= 1.0 / 9.0;');
        expect(pcf).not.toContain('vogelDiskSample');
        // Still returns through three's shadow intensity
        expect(pcf).toContain('return mix( 1.0, shadow, shadowIntensity );');
    });

    it('fades the sun shadow at the call site of getShadow', () => {
        expect(patchShadowChunks()).toBe(true);
        const lights = chunks.lights_fragment_begin;
        // The only directional shadow lookup is the patched one: edge fade
        // for all, grazing and distance fade for the terrain
        expect(count(lights, 'getShadow( directionalShadowMap[ i ]')).toBe(1);
        expect(lights).toContain('bulliShadowEdge');
        expect(lights).toContain('BULLI_GRAZING_SHADOW_FADE');
        expect(lights).toContain('directLight.color *= bulliShadow;');
        // Applying it twice changes nothing
        expect(patchShadowChunks()).toBe(true);
        expect(chunks.lights_fragment_begin).toBe(lights);
    });

    it('bends the environment reflection by roughness squared', () => {
        expect(patchReflectionBend()).toBe(true);
        const envmap = chunks.envmap_physical_pars_fragment;
        expect(envmap).toContain('reflectVec = normalize( mix( reflectVec, normal, pow2( roughness ) ) );');
        expect(envmap).not.toContain('mix( reflectVec, normal, pow4( roughness ) )');
    });

    it('lands every world material block in the standard material shader', () => {
        const material = new THREE.MeshStandardMaterial({ envMapIntensity: 0.55 });
        material.alphaToCoverage = true;
        patchWorldMaterial(material, {
            macro: 0.1,
            baseAO: 0.7,
            surface: true,
            wind: true,
            cardMask: true,
            alphaCoverage: true,
            translucency: 0.3,
            normal: 'normal = normalize( normal ); // test-normal',
            rough: 'roughnessFactor *= 1.0; // test-rough',
            metal: 'metalnessFactor *= 1.0; // test-metal',
            emissive: 'totalEmissiveRadiance *= 1.0; // test-emissive'
        });
        const shader = {
            vertexShader: THREE.ShaderLib.standard.vertexShader,
            fragmentShader: THREE.ShaderLib.standard.fragmentShader,
            uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.standard.uniforms)
        };
        material.onBeforeCompile(shader as never, null as never);
        const v = shader.vertexShader;
        const f = shader.fragmentShader;

        // Vertex: declarations (common), card UVs (uv_vertex), wind and
        // surface (begin_vertex), world position (project_vertex)
        expect(v).toContain('varying vec3 vWPos;');
        expect(v).toContain('vCardUv = vec3( cardUv, 0.0 );');
        expect(v).toContain('windPhase');
        expect(v).toContain('vSurface = surface;');
        expect(v).toContain('vWPos = ( modelMatrix * worldPosition4 ).xyz;');

        // Fragment: one marker per replaced include
        expect(f).toContain('uniform sampler2D uNoise;'); // common
        expect(f).toContain('nz2'); // color_fragment (macro)
        expect(f).toContain('// test-rough'); // roughnessmap_fragment
        expect(f).toContain('// test-metal'); // metalnessmap_fragment
        expect(f).toContain('// test-emissive'); // emissivemap_fragment
        expect(f).toContain('backLight'); // emissivemap_fragment (translucency)
        expect(f).toContain('// test-normal'); // normal_fragment_maps
        expect(f).toContain('nonPerturbedNormal = normal;'); // normal_fragment_begin (cards)
        expect(f).toContain('reflectedLight.indirectSpecular *= 0.1;'); // aomap_fragment (cards)
        expect(f).toContain('a2cAlpha = clamp('); // alphatest_fragment
        expect(f).toContain('gl_FragColor.a = a2cAlpha;'); // opaque_fragment

        // The material's own envMapIntensity reaches the image based light:
        // the define comes before the functions that read the uniform, and
        // the value follows the material
        const define = f.indexOf('#define envMapIntensity bulliEnvMapIntensity');
        expect(define).toBeGreaterThanOrEqual(0);
        expect(define).toBeLessThan(f.indexOf('#include <envmap_physical_pars_fragment>'));
        const uniforms = shader.uniforms as Record<string, THREE.IUniform>;
        expect(uniforms.bulliEnvMapIntensity.value).toBe(0.55);
        material.envMapIntensity = 0.3;
        expect(uniforms.bulliEnvMapIntensity.value).toBe(0.3);
    });
});
