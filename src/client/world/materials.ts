import * as THREE from 'three';
import type { RenderTier } from '../effects/renderQuality.js';
import { WORLD_UNIFORMS } from '../render/look.js';
import { worldTexture } from './textures.js';

// Materials of the realistic world (graphics G1), ported from the world probe.
//
// Every world material goes through patchWorldMaterial(): a world position
// varying, large scale color variation from the world noise against visible
// tiling, cheap contact darkening at wall bases and optional blocks (foliage
// translucency, alpha to coverage, the finishes of street props). The height
// fog comes from the shared fog chunks (look.ts). The map's ground, roads,
// sea and kit build their own materials on it (terrain.ts, roads.ts, sea.ts,
// kit.ts); this module has the shared ones: plants, props, the fountain.
//
// Tiers: desktop gets the full PBR sets (albedo, normal, ARM), phones (the
// low tier) the same without normal maps, software WebGL Lambert materials
// with albedo only (a CPU rasterizer cannot afford the PBR shading).

export interface WorldMaterials {
    stucco: THREE.Material;
    furniture: THREE.Material;
    trunk: THREE.Material;
    fan: THREE.Material;
    frond: THREE.Material;
    tree: THREE.Material;
    shrub: THREE.Material;
    fountainWater: THREE.Material;
    falls: THREE.Material;
}

/**
 * Fountain of the plaza for the fountain water shader: x, z of its axis and
 * the height of its foot (set by fountain.ts).
 */
export const FOUNTAIN_UNIFORMS = {
    uFountain: { value: new THREE.Vector3() }
};

interface PatchOptions {
    // Macro color variation (strength) and its scale in meters
    macro?: number;
    macroScale?: number;
    // Darkening at the foot of walls (factor at the ground)
    baseAO?: number;
    // Albedo alpha is a tint mask for the vertex color (facade atlas)
    tintMask?: boolean;
    // Code after color_fragment (diffuseColor is set)
    color?: string;
    // Code after roughnessmap_fragment (roughnessFactor)
    rough?: string;
    // Code after normal_fragment_maps (normal, view space)
    normal?: string;
    // Extra declarations and uniforms
    decl?: string;
    uniforms?: Record<string, THREE.IUniform>;
    // Back light through leaves (strength)
    translucency?: number;
    // Alpha test that keeps its coverage over mip levels (foliage cards)
    alphaCoverage?: boolean;
    // Foliage cards with a cardUv attribute (0..1 over each card): far away,
    // where the averaged alpha of the low mip levels would let the whole
    // card rectangle pass, the cut-out becomes a soft, irregular crown;
    // cards seen edge-on fade out (no pale ghost planes), and the bent
    // normals of the geometry are kept on back faces as well
    cardMask?: boolean;
    // Code after metalnessmap_fragment (metalnessFactor)
    metal?: string;
    // Code after emissivemap_fragment (totalEmissiveRadiance)
    emissive?: string;
    // Vertex shader: declarations, and code after begin_vertex (may move
    // `transformed`, in object space before the instance matrix)
    vertexDecl?: string;
    vertex?: string;
    // Palm sway and leaf flutter from the `wind` attribute (see WIND_GLSL)
    wind?: boolean;
    // Street furniture finish from the `surface` attribute (see SURFACE_*)
    surface?: boolean;
}

// Wind (palms): `wind` = (bend, flutter, phase). bend (0 at the foot, 1 at the
// crown) sways the whole palm, flutter (0 at a leaf's base, 1 at its tip)
// moves the leaves on their own; phase decorrelates the leaves, the instance
// position the palms. Object space (before the instance matrix), so each
// palm sways in its own direction; meters at scale 1.
const WIND_GLSL = /* glsl */`
	{
		float windPhase = 0.0;
		#ifdef USE_INSTANCING
		windPhase = dot( instanceMatrix[ 3 ].xz, vec2( 0.071, 0.113 ) );
		#endif
		float sway = sin( uTime * 0.83 + windPhase ) * 0.6 + sin( uTime * 1.37 + windPhase * 1.7 ) * 0.3 + sin( uTime * 2.9 + windPhase * 0.4 ) * 0.1;
		transformed.xz += vec2( 0.8, 0.6 ) * ( sway * wind.x * 0.2 );
		float flutter = sin( uTime * 3.3 + wind.z * 6.283 + windPhase ) * 0.7 + sin( uTime * 5.3 + wind.z * 11.0 ) * 0.3;
		transformed.y += flutter * wind.y * 0.11;
		transformed.xz += vec2( -0.6, 0.8 ) * ( flutter * wind.y * 0.05 );
	}`;

// Street furniture: `surface` = (roughness, metalness, emission, signal).
// signal > 0 marks a traffic light lens: 1 + lamp (0 red, 1 yellow, 2 green)
// + 3 * axis. Both axes run a 40 s cycle (16 s green, 3.5 s yellow, then
// red), half a cycle apart, with a short all red between them.
const SURFACE_VERTEX_DECL = 'attribute vec4 surface;\nvarying vec4 vSurface;';
// The axis of a traffic light follows from its instance: signal heads on an
// arm along x control the traffic along z (axis 0), and the other way round
const SURFACE_VERTEX = /* glsl */`
	vSurface = surface;
	#ifdef USE_INSTANCING
	if ( surface.w > 0.5 && abs( instanceMatrix[ 0 ].z ) > abs( instanceMatrix[ 0 ].x ) ) vSurface.w += 3.0;
	#endif`;
const SURFACE_FRAGMENT_DECL = 'varying vec4 vSurface;\nfloat signalLit = 1.0;';
const SURFACE_COLOR = /* glsl */`
	if ( vSurface.w > 0.5 ) {
		float code = vSurface.w - 1.0;
		float axis = floor( code / 3.0 + 0.01 );
		float lamp = code - axis * 3.0;
		float phase = mod( uTime + axis * 20.0, 40.0 );
		float lit = phase < 16.0 ? 2.0 : ( phase < 19.5 ? 1.0 : 0.0 );
		signalLit = 1.0 - step( 0.5, abs( lamp - lit ) );
		// A dark lens is tinted glass, a lit one glows
		diffuseColor.rgb *= mix( 0.12, 1.0, signalLit );
	}`;
const SURFACE_ROUGH = /* glsl */`
	{
		float n = texture2D( uNoise, vWPos.xz / 2.3 + vWPos.y * 0.37 ).g;
		roughnessFactor = clamp( vSurface.x * ( 0.8 + 0.4 * n ), 0.04, 1.0 );
	}`;
const SURFACE_METAL = 'metalnessFactor = vSurface.y;';
const SURFACE_EMISSIVE = 'totalEmissiveRadiance += diffuseColor.rgb * vSurface.z * signalLit;';

// Foliage cards (PatchOptions.cardMask). z of vCardUv: a random number per
// instance, so the far crowns do not all share one outline.
const CARD_VERTEX = /* glsl */`
	vCardUv = vec3( cardUv, 0.0 );
	#ifdef USE_INSTANCING
	vCardUv.z = fract( dot( instanceMatrix[ 3 ].xz, vec2( 0.0713, 0.1131 ) ) );
	#endif`;
// The bent normals stand for a round crown: the same normal on both faces,
// and normals of the crown's far side (seen through the crossing cards) are
// mirrored to the near side, as on a sphere, where every visible normal
// faces the viewer (else the far halves of the cards glow against the sun)
const CARD_NORMAL = /* glsl */`#include <normal_fragment_begin>
	#if defined( DOUBLE_SIDED ) && ! defined( FLAT_SHADED )
	{
		normal = normalize( vNormal );
		vec3 toViewer = normalize( vViewPosition );
		float away = dot( normal, toViewer );
		if ( away < 0.0 ) normal = normalize( normal - 2.0 * away * toViewer );
		// Wrap: light scattered in the crown reaches its shaded side too, so
		// the normals lean towards the sun (else each card is either lit or
		// black, and a crown falls apart into flat halves)
		normal = normalize( normal + 0.5 * ( viewMatrix * vec4( uSunDir, 0.0 ) ).xyz );
		nonPerturbedNormal = normal;
	}
	#endif`;
const CARD_ALPHA = /* glsl */`{
			// Far away: crown and trunk silhouette of the card, the crown
			// outline broken up by noise
			vec2 c = ( vCardUv.xy - vec2( 0.5, 0.62 ) ) / vec2( 0.45, 0.38 );
			float wobble = texture2D( uNoise, vCardUv.xy * vec2( 1.7, 1.4 ) + vCardUv.z * vec2( 0.61, 0.37 ) ).r - 0.5;
			float crown = 1.0 - smoothstep( 0.62, 0.9, length( c ) + wobble * 0.5 );
			float trunk = ( 1.0 - smoothstep( 0.03, 0.06, abs( vCardUv.x - 0.5 ) ) ) * step( vCardUv.y, 0.35 );
			float far = smoothstep( 3.0, 5.0, mip );
			diffuseColor.a = mix( diffuseColor.a, min( diffuseColor.a * 1.5, max( crown, trunk ) ), far );
			// Far crowns are dense: their shaded inside and less scattered
			// light (see translucency) keep them darker than the sunlit grass
			cardFar = far;
			diffuseColor.rgb *= 1.0 - 0.2 * far;
			// Cards seen edge-on fade out instead of showing a thin pale plane
			vec3 cardFace = normalize( cross( dFdx( vWPos ), dFdy( vWPos ) ) );
			vec3 toCamera = normalize( cameraPosition - vWPos );
			diffuseColor.a *= smoothstep( 0.05, 0.2, abs( dot( cardFace, toCamera ) ) );
			// The horizontal top card only from well above (from below it
			// would be a lit disc in the crown)
			if ( abs( cardFace.y ) > 0.9 ) diffuseColor.a *= smoothstep( 0.4, 0.65, toCamera.y );
		}`;

const MACRO = (strength: number, scale: number) => /* glsl */`
	{
		vec4 nz = texture2D( uNoise, vWPos.xz / ${scale.toFixed(1)} );
		vec4 nz2 = texture2D( uNoise, vWPos.xz / ${(scale / 7.3).toFixed(2)} + 0.37 );
		diffuseColor.rgb *= mix( ${(1 - strength).toFixed(3)}, ${(1 + strength * 0.6).toFixed(3)}, nz.r * 0.65 + nz2.g * 0.35 );
	}`;

/**
 * Adds the shared world shader blocks to a built-in material. The options
 * are baked into the program (one program per distinct option set).
 */
export function patchWorldMaterial<T extends THREE.Material>(material: T, options: PatchOptions = {}): T {
    const key = 'bulli-world:' + JSON.stringify(options, (k, v) => (k === 'uniforms' ? Object.keys(v) : v));
    const vertexDecl = [options.vertexDecl ?? ''];
    const vertexCode = [options.vertex ?? ''];
    if (options.wind) {
        vertexDecl.push('attribute vec3 wind;');
        vertexCode.push(WIND_GLSL);
    }
    if (options.surface) {
        vertexDecl.push(SURFACE_VERTEX_DECL);
        vertexCode.push(SURFACE_VERTEX);
    }
    material.onBeforeCompile = shader => {
        Object.assign(shader.uniforms, WORLD_UNIFORMS, options.uniforms ?? {});
        // Each world material scales the image based light with its own
        // envMapIntensity (0.3 to 1.1). Since three r163 the renderer
        // overwrites that uniform with scene.environmentIntensity for every
        // material lit by scene.environment, so the shader reads a copy that
        // follows the material's value.
        shader.uniforms.bulliEnvMapIntensity = {
            get value() { return (material as unknown as { envMapIntensity?: number }).envMapIntensity ?? 1; }
        };
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nuniform float uTime;\n' + vertexDecl.join('\n') + (options.cardMask
                ? '\nattribute vec2 cardUv;\nvarying vec3 vCardUv;'
                : ''))
            .replace('#include <uv_vertex>', '#include <uv_vertex>' + (options.cardMask ? CARD_VERTEX : ''))
            .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + vertexCode.join('\n'))
            .replace('#include <project_vertex>', /* glsl */`#include <project_vertex>
	{
		vec4 worldPosition4 = vec4( transformed, 1.0 );
		#ifdef USE_INSTANCING
		worldPosition4 = instanceMatrix * worldPosition4;
		#endif
		vWPos = ( modelMatrix * worldPosition4 ).xyz;
	}`);
        let f = shader.fragmentShader.replace('#include <common>', /* glsl */`#include <common>
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform sampler2D uNoise;
uniform float uTime;
varying vec3 vWPos;
${options.cardMask ? 'varying vec3 vCardUv;\nfloat cardFar = 0.0;' : ''}
${options.surface ? SURFACE_FRAGMENT_DECL : ''}
${options.decl ?? ''}`);
        f = f.replace('#include <envmap_common_pars_fragment>', /* glsl */`#include <envmap_common_pars_fragment>
#ifdef USE_ENVMAP
uniform float bulliEnvMapIntensity;
#define envMapIntensity bulliEnvMapIntensity
#endif`);
        const colorBlocks: string[] = [];
        if (options.macro) colorBlocks.push(MACRO(options.macro, options.macroScale ?? 60));
        if (options.baseAO) colorBlocks.push(`diffuseColor.rgb *= mix( ${options.baseAO.toFixed(2)}, 1.0, smoothstep( 0.1, 1.4, vWPos.y ) );`);
        if (options.surface) colorBlocks.push(SURFACE_COLOR);
        if (options.color) colorBlocks.push(options.color);
        const colorFragment = options.tintMask
            ? /* glsl */`
	#ifdef USE_MAP
		diffuseColor.rgb *= mix( vec3( 1.0 ), vColor.rgb, sampledDiffuseColor.a );
	#endif
	diffuseColor.a = 1.0;`
            : '#include <color_fragment>';
        f = f.replace('#include <color_fragment>', colorFragment + '\n' + colorBlocks.join('\n'));
        const rough = [options.surface ? SURFACE_ROUGH : '', options.rough ?? ''].join('\n');
        const metal = [options.surface ? SURFACE_METAL : '', options.metal ?? ''].join('\n');
        const emissive = [options.surface ? SURFACE_EMISSIVE : '', options.emissive ?? ''].join('\n');
        f = f.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + rough);
        f = f.replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n' + metal);
        f = f.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + emissive);
        if (options.normal) f = f.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + options.normal);
        if (options.cardMask) {
            f = f.replace('#include <normal_fragment_begin>', CARD_NORMAL);
            // Leaves are matte: the reflected sunset sky would lay a pale
            // sheen over every card that faces the camera
            f = f.replace('#include <aomap_fragment>', 'reflectedLight.indirectSpecular *= 0.1;\n\treflectedLight.directSpecular *= 0.3;\n\t#include <aomap_fragment>');
        }
        if (options.alphaCoverage) {
            // Raise alpha per mip level so cards do not thin out in the
            // distance; with MSAA a sharpened alpha to coverage edge
            const a2c = material.alphaToCoverage;
            f = f.replace('#include <alphatest_fragment>', /* glsl */`
	float a2cAlpha = 1.0;
	#ifdef USE_ALPHATEST
	{
		#ifdef USE_MAP
		vec2 texSize = vec2( textureSize( map, 0 ) );
		vec2 dx = dFdx( vMapUv * texSize ), dy = dFdy( vMapUv * texSize );
		float mip = max( 0.0, 0.5 * log2( max( dot( dx, dx ), dot( dy, dy ) ) ) );
		diffuseColor.a *= 1.0 + min( mip, 2.0 ) * 0.3;
		${options.cardMask ? CARD_ALPHA : ''}
		#endif
		${a2c
        ? `a2cAlpha = clamp( ( diffuseColor.a - alphaTest ) / max( fwidth( diffuseColor.a ), 1e-4 ) + 0.5, 0.0, 1.0 );
		if ( a2cAlpha < 0.004 ) discard;`
        : 'if ( diffuseColor.a < alphaTest ) discard;'}
	}
	#endif`);
            if (a2c) f = f.replace('#include <opaque_fragment>', '#include <opaque_fragment>\n\tgl_FragColor.a = a2cAlpha;');
        }
        if (options.translucency) {
            f = f.replace('#include <emissivemap_fragment>', /* glsl */`#include <emissivemap_fragment>
	{
		vec3 viewDirection = normalize( vWPos - cameraPosition );
		float backLight = pow( max( dot( viewDirection, uSunDir ), 0.0 ), 3.0 );
		${options.cardMask ? `// Crowns: light scattered through the leaves also reaches the shaded
		// side (wrap), not only the view against the sun
		backLight = backLight * 0.7 + 0.3 * clamp( 0.5 - 0.5 * dot( normal, ( viewMatrix * vec4( uSunDir, 0.0 ) ).xyz ), 0.0, 1.0 );` : ''}
		totalEmissiveRadiance += diffuseColor.rgb * uSunColor * ( ${options.translucency.toFixed(2)} * backLight${options.cardMask ? ' * ( 1.0 - 0.7 * cardFar )' : ''} );
	}`);
        }
        shader.fragmentShader = f;
    };
    material.customProgramCacheKey = () => key + material.type;
    return material;
}

// --- Factory ------------------------------------------------------------------------

interface PbrSet {
    map?: THREE.Texture;
    normalMap?: THREE.Texture;
    arm?: THREE.Texture;
    // Mean albedo instead of the map (software tier)
    color?: THREE.Color;
}

// Mean albedo (sRGB) of the tiling PBR sets: the software tier shades the
// large surfaces with it instead of sampling the textures, and it is the
// placeholder texel of the albedo maps until they have loaded
const MEAN_ALBEDO: Record<string, number> = {
    stucco: 0xdcd7cf
};

// What survives of the shader blocks on the software tier: only what the
// look depends on (facade tint mask, foliage cut-outs)
function leanOptions(options: PatchOptions): PatchOptions {
    return {
        tintMask: options.tintMask, alphaCoverage: options.alphaCoverage, cardMask: options.cardMask,
        // Traffic light lenses and lamp globes (emission only)
        surface: options.surface
    };
}

export function createWorldMaterials(tier: RenderTier): WorldMaterials {
    const software = tier === 'software';
    const normals = tier === 'desktop';

    const pbr = (name: string): PbrSet => (software
        ? { color: new THREE.Color(MEAN_ALBEDO[name] ?? 0xffffff) }
        : {
            map: worldTexture(`pbr/${name}_albedo`, { fallback: MEAN_ALBEDO[name] }),
            normalMap: normals ? worldTexture(`pbr/${name}_normal`) : undefined,
            arm: worldTexture(`pbr/${name}_arm`)
        });
    // Software WebGL (a CPU rasterizer) gets the lean shader: every texture
    // fetch and noise block costs it frame rate the e2e driving tests need
    const patch = <T extends THREE.Material>(material: T, options: PatchOptions = {}): T =>
        patchWorldMaterial(material, software ? leanOptions(options) : options);

    // Standard material, or Lambert on the software tier (map, vertex colors,
    // emissive and alpha test carry over; the PBR maps are dropped)
    const surface = (all: THREE.MeshStandardMaterialParameters & { normalScale?: THREE.Vector2 }): THREE.Material => {
        // Unset maps of the tier stay out (three warns about undefined values)
        const params = Object.fromEntries(Object.entries(all).filter(([, value]) => value !== undefined)) as typeof all;
        if (!software) return new THREE.MeshStandardMaterial(params);
        const lambert: THREE.MeshLambertMaterialParameters = {
            map: params.map,
            color: params.color,
            vertexColors: params.vertexColors,
            emissive: params.emissive,
            emissiveMap: params.emissiveMap,
            emissiveIntensity: params.emissiveIntensity,
            alphaTest: params.alphaTest,
            side: params.side,
            transparent: params.transparent,
            opacity: params.opacity,
            polygonOffset: params.polygonOffset,
            polygonOffsetFactor: params.polygonOffsetFactor,
            polygonOffsetUnits: params.polygonOffsetUnits
        };
        return new THREE.MeshLambertMaterial(Object.fromEntries(Object.entries(lambert).filter(([, value]) => value !== undefined)));
    };
    const withPbr = (set: PbrSet, extra: THREE.MeshStandardMaterialParameters = {}) => surface({
        map: set.map,
        color: set.color,
        normalMap: set.normalMap,
        aoMap: set.arm,
        roughnessMap: set.arm,
        roughness: 1,
        metalness: 0,
        ...extra
    });

    const M = {} as WorldMaterials;

    const stucco = pbr('stucco');

    // Smooth plaster: the fountain's stone
    M.stucco = patch(withPbr(stucco, {
        normalScale: new THREE.Vector2(0.6, 0.6),
        vertexColors: true,
        envMapIntensity: 0.95
    }), { macro: 0.08, macroScale: 20, baseAO: 0.72 });

    // Props (railings, fence posts, sunshades, the race dressing): colour
    // from the vertex colors, roughness, metalness and emission from the
    // `surface` attribute (furniture.ts)
    M.furniture = patch(surface({
        vertexColors: true,
        roughness: 1,
        metalness: 0,
        envMapIntensity: 1.0
    }), { surface: true, baseAO: 0.8, macro: 0.05, macroScale: 3 });

    // Palms and trees: cut-out cards with alpha to coverage where MSAA is on
    const card = (name: string, extra: THREE.MeshStandardMaterialParameters, translucency: number, cardMask = false, wind = false) => {
        const map = worldTexture(name, { repeat: false });
        const material = surface({
            map,
            vertexColors: true,
            side: THREE.DoubleSide,
            metalness: 0,
            envMapIntensity: 0.6,
            ...extra
        });
        material.alphaToCoverage = !software;
        return patch(material, { translucency, alphaCoverage: true, cardMask, wind });
    };
    M.trunk = patch(surface({
        map: worldTexture('generated/palm_trunk'),
        normalMap: normals ? worldTexture('generated/palm_trunk_normal') : undefined,
        normalScale: new THREE.Vector2(1.2, 1.2),
        vertexColors: true,
        roughness: 0.95,
        metalness: 0,
        envMapIntensity: 0.7
    }), { wind: true });
    M.fan = card('generated/fan_fronds', { alphaTest: 0.5, roughness: 0.66 }, 0.3, false, true);
    M.frond = card('generated/palm_fronds', { alphaTest: 0.45, roughness: 0.72 }, 0.34, false, true);
    // Leaves scatter light into the shaded side of the crown: more ambient
    M.tree = card('generated/tree_cards', { alphaTest: 0.5, roughness: 0.85, envMapIntensity: 0.85 }, 0.4, true);
    M.shrub = card('generated/shrubs', { alphaTest: 0.45, roughness: 0.8 }, 0.5, true);

    // Fountain water: rings of ripples and foam where the falling water hits
    // the basin, the lower bowl and the top bowl (heights above the foot)
    const FOUNTAIN_RING = /* glsl */`
		vec2 fountainOffset = vWPos.xz - uFountain.xy;
		float fountainR = length( fountainOffset ) + 1e-4;
		float fountainH = vWPos.y - uFountain.z;
		float fountainRing = fountainH < 1.5 ? 2.2 : ( fountainH < 2.9 ? 1.02 : 0.08 );`;
    M.fountainWater = patch(surface({
        color: new THREE.Color(0.04, 0.12, 0.13),
        roughness: 0.06,
        metalness: 0,
        envMapIntensity: 1.0
    }), {
        uniforms: FOUNTAIN_UNIFORMS,
        decl: 'uniform vec3 uFountain;\nfloat waterFoam = 0.0;',
        color: /* glsl */`
	{
		${FOUNTAIN_RING}
		float n = texture2D( uNoise, vWPos.xz / 0.9 + vec2( 0.0, uTime * 0.25 ) ).r;
		waterFoam = smoothstep( 0.6, 0.0, abs( fountainR - fountainRing ) ) * ( 0.45 + 0.55 * n );
		diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.72, 0.78, 0.78 ), waterFoam * 0.6 );
	}`,
        rough: 'roughnessFactor = mix( roughnessFactor, 0.45, waterFoam );',
        normal: /* glsl */`
	{
		${FOUNTAIN_RING}
		vec2 p = vWPos.xz;
		vec2 g = vec2( cos( dot( p, vec2( 0.8, 0.6 ) ) * 2.3 + uTime * 1.7 ), cos( dot( p, vec2( -0.3, 0.95 ) ) * 3.1 + uTime * 2.3 ) ) * 0.04;
		vec4 nz = texture2D( uNoise, p / 1.7 + vec2( uTime * 0.05, 0.0 ) ) - 0.5;
		g += nz.gb * 0.12;
		g += ( fountainOffset / fountainR ) * sin( ( fountainR - fountainRing ) * 11.0 - uTime * 6.5 ) * 0.2 * exp( -abs( fountainR - fountainRing ) * 1.3 );
		normal = normalize( ( viewMatrix * vec4( normalize( vec3( -g.x, 1.0, -g.y ) ), 0.0 ) ).xyz );
	}`
    });

    // Falling water sheets and the jet of the fountain: streaks running
    // down, whiter and denser at the bottom (lathe UVs: y along the fall)
    // (Software WebGL: the lean shader, a plain veil of the given opacity)
    M.falls = patch(surface({
        color: new THREE.Color(0.7, 0.8, 0.84),
        roughness: 0.06,
        metalness: 0,
        envMapIntensity: 1.1,
        transparent: true,
        opacity: 0.35,
        side: THREE.DoubleSide
    }), {
        vertexDecl: 'varying vec2 vFallUv;',
        vertex: 'vFallUv = uv;',
        decl: 'varying vec2 vFallUv;',
        color: /* glsl */`
	{
		float s1 = texture2D( uNoise, vec2( vFallUv.x * 9.0, vFallUv.y * 0.5 - uTime * 0.9 ) ).r;
		float s2 = texture2D( uNoise, vec2( vFallUv.x * 19.0 + 0.3, vFallUv.y * 0.9 - uTime * 1.6 ) ).g;
		float streak = smoothstep( 0.32, 0.8, s1 * 0.6 + s2 * 0.4 );
		float foam = smoothstep( 0.55, 1.0, vFallUv.y );
		diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.93, 0.95, 0.96 ), streak * 0.45 + foam * 0.45 );
		diffuseColor.a = clamp( 0.08 + 0.5 * streak + 0.25 * foam, 0.0, 0.8 ) * smoothstep( 0.0, 0.05, vFallUv.y );
	}`
    });
    M.falls.depthWrite = false;

    return M;
}
