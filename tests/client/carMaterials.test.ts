import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { carPaintColor, cloneCarMaterial, lampUniformsOf, patchCarMaterial } from '../../src/client/assets/carMaterials.js';

// The per-car material copies of the GLB cars (assets/carMaterials.ts): the
// shader patches survive the clone (three.js drops onBeforeCompile there),
// every clone gets its own lamp uniforms and shares the program key, and the
// player colour is turned into a paint.

function atlas(name = 'bulli_atlas'): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({ name, emissive: 0xffffff });
}

function compile(material: THREE.Material): { vertexShader: string; fragmentShader: string; uniforms: Record<string, THREE.IUniform> } {
    const shader = {
        vertexShader: '#include <common>\n#include <project_vertex>',
        fragmentShader: '#include <common>\n#include <emissivemap_fragment>\n#include <opaque_fragment>',
        uniforms: {} as Record<string, THREE.IUniform>
    };
    material.onBeforeCompile(shader as never, null as never);
    return shader;
}

describe('car materials', () => {
    it('patches the atlas with lamp uniforms and keeps the patch on clones', () => {
        const template = atlas();
        patchCarMaterial(template);
        const a = cloneCarMaterial(template);
        const b = cloneCarMaterial(template);
        const lampsA = lampUniformsOf(a)!;
        const lampsB = lampUniformsOf(b)!;
        expect(lampsA).not.toBeNull();
        expect(lampsA).not.toBe(lampsB);
        expect(lampsA).not.toBe(lampUniformsOf(template));

        // Same program for all clones, their own uniform values
        expect(a.customProgramCacheKey()).toBe(template.customProgramCacheKey());
        const shader = compile(a);
        expect(shader.fragmentShader).toContain('uLamps');
        expect(shader.vertexShader).toContain('vCarSide');
        expect(shader.uniforms.uLamps).toBe(lampsA.lamps);
        lampsA.lamps.value.set(1, 0, 1);
        expect(lampsB.lamps.value.toArray()).toEqual([0, 0, 0]);
    });

    it('recognises the LOD2 atlas and leaves paint alone', () => {
        const lod2 = atlas('bulli_atlas_lod2');
        patchCarMaterial(lod2);
        expect(lampUniformsOf(lod2)).not.toBeNull();
        const paint = new THREE.MeshPhysicalMaterial({ name: 'paint_primary' });
        const key = paint.customProgramCacheKey();
        patchCarMaterial(paint);
        expect(lampUniformsOf(paint)).toBeNull();
        expect(paint.customProgramCacheKey()).toBe(key);
    });

    it('discards the baked ground blob of the glass and adds the Fresnel alpha', () => {
        const glass = new THREE.MeshStandardMaterial({ name: 'glass', transparent: true });
        patchCarMaterial(glass);
        const shader = compile(cloneCarMaterial(glass));
        expect(shader.fragmentShader).toContain('vMapUv.x >= 0.5 ) discard');
        expect(shader.fragmentShader).toContain('fresnelGlass');
    });

    it('turns any player colour into a car paint with the same hue', () => {
        const hsl = { h: 0, s: 0, l: 0 };
        for (const hex of [0x00ff00, 0xff00ff, 0x000000, 0xffffff, 0x4caf50, 0x123456]) {
            const paint = carPaintColor(hex);
            paint.getHSL(hsl, THREE.SRGBColorSpace);
            expect(hsl.s).toBeLessThanOrEqual(0.58 + 1e-4);
            expect(hsl.l).toBeGreaterThanOrEqual(0.2 - 1e-4);
            expect(hsl.l).toBeLessThanOrEqual(0.62 + 1e-4);
            const source = new THREE.Color().setHex(hex, THREE.SRGBColorSpace).getHSL({ h: 0, s: 0, l: 0 }, THREE.SRGBColorSpace);
            if (source.s > 0.05) expect(hsl.h).toBeCloseTo(source.h, 2);
        }
    });
});
