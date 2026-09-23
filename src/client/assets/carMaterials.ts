import * as THREE from 'three';

// Shader patches of the car GLB materials (tools/models/README.md). They are
// installed on the cached templates (ModelCache.prepareTemplate), so the
// warmup compiles the very programs the cars use, and again on every per-car
// clone (three.js does not copy onBeforeCompile with Material.clone). The
// program cache keys are constant, so all clones share one program each.

const patched = new WeakSet<THREE.Material>();

/**
 * Lamp state of one car, uniforms of its atlas material clone:
 * lamps = (brake, blink left, blink right), 0..1 each; carLeft = the car's
 * left axis in world space (xyz) and -dot(left, origin) (w), so the shader
 * can tell the left from the right blinker.
 */
export interface LampUniforms {
    lamps: { value: THREE.Vector3 };
    carLeft: { value: THREE.Vector4 };
}

const lampUniforms = new WeakMap<THREE.Material, LampUniforms>();

/** The lamp uniforms of an atlas material (null for the other materials). */
export function lampUniformsOf(material: THREE.Material): LampUniforms | null {
    return lampUniforms.get(material) ?? null;
}

export function isAtlasMaterial(material: THREE.Material): boolean {
    return /_atlas(_lod\d)?$/.test(material.name);
}

/**
 * Glass: real glass gets more opaque at grazing angles (Fresnel), which keeps
 * the reflections on side windows strong. The "glass" material shares one
 * small texture between the window tint (left half, u < 0.5) and the soft
 * contact blob under the car (right half). The game draws its own contact
 * shadow (render/lighting.ts), which fades while the car is in the air, so
 * the baked blob is discarded here - it would jump with the car.
 */
function patchGlass(material: THREE.Material): void {
    material.onBeforeCompile = shader => {
        shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `#include <opaque_fragment>
            #ifdef USE_MAP
            if ( vMapUv.x >= 0.5 ) discard;
            float fresnelGlass = pow( 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) ), 3.0 );
            gl_FragColor.a = mix( gl_FragColor.a, 1.0, fresnelGlass * 0.8 );
            #endif`);
    };
    material.customProgramCacheKey = () => 'bulli-car-glass-v2';
}

/**
 * Atlas: the lamps are emissive cells of the atlas. Tail lamps (red) light
 * up with the brake, the amber cells blink per side. The kind of lamp comes
 * from the hue of the emissive texel (tail g/r ~0.02, amber ~0.25, head
 * lamps and the faint cabin glow > 0.7), so no extra UVs are needed.
 */
function patchAtlas(material: THREE.Material): void {
    const uniforms: LampUniforms = {
        lamps: { value: new THREE.Vector3() },
        carLeft: { value: new THREE.Vector4(1, 0, 0, 0) }
    };
    lampUniforms.set(material, uniforms);
    material.onBeforeCompile = shader => {
        shader.uniforms.uLamps = uniforms.lamps;
        shader.uniforms.uCarLeft = uniforms.carLeft;
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `#include <common>
                uniform vec4 uCarLeft;
                varying float vCarSide;`)
            .replace('#include <project_vertex>', `#include <project_vertex>
                vCarSide = dot( ( modelMatrix * vec4( transformed, 1.0 ) ).xyz, uCarLeft.xyz ) + uCarLeft.w;`);
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>
                uniform vec3 uLamps;
                varying float vCarSide;`)
            .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
                {
                    vec3 lampEmit = totalEmissiveRadiance;
                    float lampHue = lampEmit.g / max( lampEmit.r, 1e-4 );
                    if ( lampEmit.r > 0.004 ) {
                        if ( lampHue < 0.12 ) totalEmissiveRadiance *= 1.0 + uLamps.x * 14.0;
                        else if ( lampHue < 0.5 ) totalEmissiveRadiance *= 1.0 + ( vCarSide > 0.0 ? uLamps.y : uLamps.z ) * 16.0;
                    }
                }`);
    };
    material.customProgramCacheKey = () => 'bulli-car-atlas-lamps-v1';
}

/** Installs the game's shader patch of a car material (once per material object). */
export function patchCarMaterial(material: THREE.Material): void {
    if (patched.has(material)) return;
    patched.add(material);
    if (material.name === 'glass') patchGlass(material);
    else if (isAtlasMaterial(material)) patchAtlas(material);
}

/** A per-car copy of a shared car material, with the same shader patch. */
export function cloneCarMaterial(material: THREE.Material): THREE.Material {
    const clone = material.clone();
    patchCarMaterial(clone);
    return clone;
}

const _hsl = { h: 0, s: 0, l: 0 };

/**
 * A player's colour as car paint. The server hands out any RGB colour; real
 * paints (and the calm, natural look of the world) are less saturated and
 * never neon or pitch black, so saturation and lightness are pulled into a
 * paint range while the hue - the player's identity - stays.
 */
export function carPaintColor(colorCode: number, target = new THREE.Color()): THREE.Color {
    target.setHex(colorCode, THREE.SRGBColorSpace);
    target.getHSL(_hsl, THREE.SRGBColorSpace);
    const saturation = Math.min(_hsl.s * 0.8, 0.58);
    const lightness = 0.2 + _hsl.l * 0.42;
    return target.setHSL(_hsl.h, saturation, lightness, THREE.SRGBColorSpace);
}
