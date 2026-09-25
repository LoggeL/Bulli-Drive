import * as THREE from 'three';
import type { Heightfield } from '../../shared/map/heightfield.js';
import type { RenderTier } from '../effects/renderQuality.js';
import { patchWorldMaterial } from './materials.js';

// The Pacific (docs/phase-3-design.md 7): a plane at the water level out to
// the horizon, one draw call. Its shader reads the depth of the ground
// under every pixel from the baked heights (R16UI, texelFetch and the
// bilinear formula of heightAt, so no float filtering is needed on iOS) for
// the colour, the transparency of the shallows and the foam of the surf
// along the beach. Software WebGL gets a plain opaque plane: the terrain
// cuts the coast line into it through the depth test.

export const SEA_EXTENT = 16_000;

export function heightTexture(hf: Heightfield): THREE.DataTexture {
    const { cols, rows } = hf.spec;
    const texture = new THREE.DataTexture(hf.q, cols, rows, THREE.RedIntegerFormat, THREE.UnsignedShortType);
    texture.internalFormat = 'R16UI';
    texture.name = 'terrain-heights';
    texture.minFilter = texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    // Rows of 1001 × 2 bytes are not 4-byte aligned
    texture.unpackAlignment = 2;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    return texture;
}

// heightAt in GLSL: clamp into the grid, four texels, bilinear in the same
// order (float32 here; the sim's doubles only matter for the sim)
const HEIGHT_GLSL = /* glsl */`
uniform highp usampler2D tHeights;
uniform vec4 uHeightGrid;
uniform vec2 uHeightScale;
float groundAt( vec2 p ) {
	vec2 g = ( p - uHeightGrid.xy ) / uHeightGrid.z;
	g = clamp( g, vec2( 0.0 ), vec2( uHeightGrid.w - 1.0 ) );
	vec2 c = min( floor( g ), vec2( uHeightGrid.w - 2.0 ) );
	vec2 f = g - c;
	ivec2 k = ivec2( c );
	float h00 = float( texelFetch( tHeights, k, 0 ).r );
	float h10 = float( texelFetch( tHeights, k + ivec2( 1, 0 ), 0 ).r );
	float h01 = float( texelFetch( tHeights, k + ivec2( 0, 1 ), 0 ).r );
	float h11 = float( texelFetch( tHeights, k + ivec2( 1, 1 ), 0 ).r );
	float top = h00 + ( h10 - h00 ) * f.x;
	float bottom = h01 + ( h11 - h01 ) * f.x;
	return uHeightScale.x + ( top + ( bottom - top ) * f.y ) * uHeightScale.y;
}
float seaDepth = 0.0;
float seaFoam = 0.0;`;

export function createSea(hf: Heightfield, tier: RenderTier): THREE.Mesh {
    const geometry = new THREE.PlaneGeometry(SEA_EXTENT, SEA_EXTENT, 1, 1).rotateX(-Math.PI / 2);
    geometry.translate(0, hf.spec.waterLevel, 0);
    let material: THREE.Material;
    if (tier === 'software') {
        material = patchWorldMaterial(new THREE.MeshLambertMaterial({ color: new THREE.Color(0.05, 0.19, 0.21) }), {});
    } else {
        const spec = hf.spec;
        const uniforms = {
            tHeights: { value: heightTexture(hf) },
            uHeightGrid: { value: new THREE.Vector4(spec.originX, spec.originZ, spec.cellSize, spec.cols) },
            uHeightScale: { value: new THREE.Vector2(spec.heightOffset, spec.heightScale) }
        };
        const standard = new THREE.MeshStandardMaterial({
            color: new THREE.Color(0.02, 0.09, 0.1),
            roughness: 0.06,
            metalness: 0,
            envMapIntensity: 1.0,
            transparent: true
        });
        material = patchWorldMaterial(standard, {
            uniforms,
            decl: HEIGHT_GLSL,
            color: /* glsl */`
	{
		float ground = groundAt( vWPos.xz );
		seaDepth = max( 0.0, vWPos.y - ground );
		// Turquoise over sand, deep blue green further out
		vec3 shallow = vec3( 0.08, 0.3, 0.27 );
		vec3 deep = vec3( 0.012, 0.055, 0.075 );
		diffuseColor.rgb = mix( shallow, deep, smoothstep( 0.4, 7.0, seaDepth ) );
		// Surf: bands of foam running in, broken up by noise, thickest where it breaks
		float n = texture2D( uNoise, vWPos.xz / 23.0 + vec2( uTime * 0.01, 0.0 ) ).r;
		float n2 = texture2D( uNoise, vWPos.xz / 3.7 - vec2( 0.0, uTime * 0.03 ) ).g;
		// A breaker running up the beach every few seconds, thin lines of
		// foam behind it, and the wash at the water's edge
		float wave = sin( seaDepth * 3.0 - uTime * 1.1 + n * 4.0 ) * 0.5 + 0.5;
		seaFoam = smoothstep( 1.1, 0.1, seaDepth ) * smoothstep( 0.8, 1.0, wave * 0.75 + n2 * 0.4 ) * 0.8;
		seaFoam = max( seaFoam, smoothstep( 0.22, 0.0, seaDepth ) * smoothstep( 0.35, 0.75, n2 + 0.2 ) * 0.85 );
		diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.78, 0.82, 0.8 ), seaFoam );
		// See-through in the shallows, fading in over the first 12 cm: the
		// wet sand flats lie within centimetres of the water level, where
		// a hard water line would follow the 2 m cells of the heights
		diffuseColor.a = clamp( 0.35 + seaDepth * 0.45 + seaFoam, 0.0, 1.0 ) * smoothstep( 0.0, 0.12, seaDepth );
	}`,
            rough: 'roughnessFactor = mix( roughnessFactor, 0.55, seaFoam );',
            normal: /* glsl */`
	{
		// Swell and ripples from the noise texture (mip-mapped, so it calms
		// down with the distance instead of turning into moire)
		vec2 p = vWPos.xz;
		vec4 swell = texture2D( uNoise, p / 61.0 + vec2( uTime * 0.004, uTime * 0.0025 ) ) - 0.5;
		vec4 nz = texture2D( uNoise, p / 9.0 + vec2( uTime * 0.012, uTime * 0.006 ) ) - 0.5;
		vec4 nz2 = texture2D( uNoise, p / 2.3 - vec2( uTime * 0.02, 0.0 ) ) - 0.5;
		vec2 g = swell.rg * 0.18 + nz.gb * 0.14 + nz2.rg * 0.06;
		g *= 1.0 - 0.6 * smoothstep( 120.0, 900.0, length( vWPos - cameraPosition ) );
		normal = normalize( ( viewMatrix * vec4( normalize( vec3( -g.x, 1.0, -g.y ) ), 0.0 ) ).xyz );
	}`
        });
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'sea';
    mesh.receiveShadow = tier !== 'software';
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    // After the opaque world (it is see-through in the shallows)
    mesh.renderOrder = 2;
    return mesh;
}
