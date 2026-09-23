import * as THREE from 'three';
import { CITY_LAYOUT } from '../../shared/constants.js';
import { roadLineCenter } from '../../shared/world/cityGen.js';
import type { RenderTier } from '../effects/renderQuality.js';
import { WORLD_UNIFORMS } from '../render/look.js';
import { cloneWorldTexture, worldTexture } from './textures.js';

// Materials of the realistic world (graphics G1), ported from the world probe.
//
// Every world material goes through patchWorldMaterial(): a world position
// varying, large scale color variation from the world noise against visible
// tiling, cheap contact darkening at wall bases and optional blocks (road
// wear, sidewalk joints, terrain splat, foliage translucency, alpha to
// coverage). The height fog comes from the shared fog chunks (look.ts).
//
// Tiers: desktop gets the full PBR sets (albedo, normal, ARM), phones (the
// low tier) the same without normal maps, software WebGL Lambert materials
// with albedo only (a CPU rasterizer cannot afford the PBR shading).

export interface WorldMaterials {
    asphalt: THREE.Material;
    markings: THREE.Material;
    sidewalk: THREE.Material;
    lawn: THREE.Material;
    sand: THREE.Material;
    facade: THREE.Material;
    stucco: THREE.Material;
    tiles: THREE.Material;
    gravel: THREE.Material;
    storefront: THREE.Material;
    fabric: THREE.Material;
    props: THREE.Material;
    emissive: THREE.Material;
    terrain: THREE.Material;
    rock: THREE.Material;
    trunk: THREE.Material;
    fan: THREE.Material;
    frond: THREE.Material;
    tree: THREE.Material;
    shrub: THREE.Material;
    water: THREE.Material;
}

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
    // The geometry has a cardUv attribute (0..1 over each card): far away,
    // where the averaged alpha of the low mip levels would let the whole
    // card rectangle pass, the cut-out becomes a soft rounded crown
    cardMask?: boolean;
}

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
    material.onBeforeCompile = shader => {
        Object.assign(shader.uniforms, WORLD_UNIFORMS, options.uniforms ?? {});
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;' + (options.cardMask
                ? '\nattribute vec2 cardUv;\nvarying vec2 vCardUv;'
                : ''))
            .replace('#include <uv_vertex>', '#include <uv_vertex>' + (options.cardMask ? '\nvCardUv = cardUv;' : ''))
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
${options.cardMask ? 'varying vec2 vCardUv;' : ''}
${options.decl ?? ''}`);
        const colorBlocks: string[] = [];
        if (options.macro) colorBlocks.push(MACRO(options.macro, options.macroScale ?? 60));
        if (options.baseAO) colorBlocks.push(`diffuseColor.rgb *= mix( ${options.baseAO.toFixed(2)}, 1.0, smoothstep( 0.1, 1.4, vWPos.y ) );`);
        if (options.color) colorBlocks.push(options.color);
        const colorFragment = options.tintMask
            ? /* glsl */`
	#ifdef USE_MAP
		diffuseColor.rgb *= mix( vec3( 1.0 ), vColor.rgb, sampledDiffuseColor.a );
	#endif
	diffuseColor.a = 1.0;`
            : '#include <color_fragment>';
        f = f.replace('#include <color_fragment>', colorFragment + '\n' + colorBlocks.join('\n'));
        if (options.rough) f = f.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + options.rough);
        if (options.normal) f = f.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + options.normal);
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
		${options.cardMask ? `{
			// Crown and trunk silhouette of the card
			vec2 c = ( vCardUv - vec2( 0.5, 0.62 ) ) / vec2( 0.45, 0.38 );
			float crown = 1.0 - smoothstep( 0.75, 1.0, length( c ) );
			float trunk = ( 1.0 - smoothstep( 0.03, 0.06, abs( vCardUv.x - 0.5 ) ) ) * step( vCardUv.y, 0.35 );
			float far = smoothstep( 3.0, 5.0, mip );
			diffuseColor.a = mix( diffuseColor.a, min( diffuseColor.a * 1.5, max( crown, trunk ) ), far );
			// The dark cut-out cards would read as black blobs far away
			diffuseColor.rgb *= 1.0 + 0.2 * far;
		}` : ''}
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
		totalEmissiveRadiance += diffuseColor.rgb * uSunColor * ( ${options.translucency.toFixed(2)} * backLight );
	}`);
        }
        shader.fragmentShader = f;
    };
    material.customProgramCacheKey = () => key + material.type;
    return material;
}

// --- Road coordinates -------------------------------------------------------------

// Offset from the nearest road center line across the road, or 99 in
// intersections and away from roads (the grid of cityGen.ts)
const ROAD_GLSL = /* glsl */`
float roadAcross( vec3 wp ) {
	vec2 o = mod( wp.xz - ${roadLineCenter(0, 'x').toFixed(1)} + ${(CITY_LAYOUT.blockSize + CITY_LAYOUT.roadWidth) / 2}.0, ${(CITY_LAYOUT.blockSize + CITY_LAYOUT.roadWidth).toFixed(1)} ) - ${(CITY_LAYOUT.blockSize + CITY_LAYOUT.roadWidth) / 2}.0;
	bool onX = abs( o.x ) < ${(CITY_LAYOUT.roadWidth / 2).toFixed(1)};
	bool onZ = abs( o.y ) < ${(CITY_LAYOUT.roadWidth / 2).toFixed(1)};
	return onX && !onZ ? o.x : ( onZ && !onX ? o.y : 99.0 );
}`;

// --- Factory ------------------------------------------------------------------------

interface PbrSet {
    map?: THREE.Texture;
    normalMap?: THREE.Texture;
    arm?: THREE.Texture;
    // Mean albedo instead of the map (software tier)
    color?: THREE.Color;
}

// Mean albedo (sRGB) of the tiling PBR sets: the software tier shades the
// large surfaces with it instead of sampling the textures
const MEAN_ALBEDO: Record<string, number> = {
    asphalt: 0x55524e,
    sidewalk: 0xb9b2a8,
    grass: 0x6f7a44,
    grass_dry: 0x9c8c62,
    sand: 0xc9b596,
    stucco: 0xdcd7cf,
    roof_tiles: 0xa9573a,
    roof_gravel: 0x8f887d
};

// What survives of the shader blocks on the software tier: only what the
// look depends on (facade tint mask, foliage cut-outs)
function leanOptions(options: PatchOptions): PatchOptions {
    return { tintMask: options.tintMask, alphaCoverage: options.alphaCoverage, cardMask: options.cardMask };
}

export function createWorldMaterials(tier: RenderTier): WorldMaterials {
    const software = tier === 'software';
    const normals = tier === 'desktop';

    const pbr = (name: string): PbrSet => (software
        ? { color: new THREE.Color(MEAN_ALBEDO[name] ?? 0xffffff) }
        : {
            map: worldTexture(`pbr/${name}_albedo`),
            normalMap: normals ? worldTexture(`pbr/${name}_normal`) : undefined,
            arm: worldTexture(`pbr/${name}_arm`)
        });
    // Software WebGL (a CPU rasterizer) gets the lean shader: every texture
    // fetch and noise block costs it frame rate the e2e driving tests need
    const patch = <T extends THREE.Material>(material: T, options: PatchOptions = {}): T =>
        patchWorldMaterial(material, software ? leanOptions(options) : options);

    // Standard material, or Lambert on the software tier (map, vertex colors,
    // emissive and alpha test carry over; the PBR maps are dropped)
    const surface = (params: THREE.MeshStandardMaterialParameters & { normalScale?: THREE.Vector2 }): THREE.Material => {
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
        return new THREE.MeshLambertMaterial(lambert);
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

    // Asphalt with wheel tracks, oil in the lane centers, dirt along the
    // curbs and darker patches. Roads sit a little above the terrain; the
    // polygon offset keeps the flat layers apart at any distance.
    M.asphalt = patch(withPbr(pbr('asphalt'), {
        normalScale: new THREE.Vector2(0.8, 0.8),
        envMapIntensity: 0.55,
        aoMapIntensity: 0.7,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2
    }), {
        macro: 0.16,
        macroScale: 45,
        decl: ROAD_GLSL + '\nfloat wearMask = 0.0;',
        color: /* glsl */`
	{
		float across = roadAcross( vWPos );
		float a = abs( across );
		vec4 n1 = texture2D( uNoise, vWPos.xz / 9.0 );
		// Wheel tracks: two per lane
		float tracks = exp( -pow( ( a - 2.2 ) / 0.35, 2.0 ) ) + exp( -pow( ( a - 3.8 ) / 0.35, 2.0 ) );
		tracks *= 0.6 + 0.4 * n1.g;
		wearMask = tracks;
		diffuseColor.rgb *= 1.0 - 0.10 * tracks;
		float oil = exp( -pow( ( a - 3.0 ) / 0.28, 2.0 ) ) * smoothstep( 0.45, 0.8, n1.b );
		diffuseColor.rgb *= 1.0 - 0.22 * oil;
		// Gutter: dirt and sand along the curb
		float gutter = smoothstep( 5.3, 6.0, a ) * step( a, 50.0 );
		diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 1.08, 1.0, 0.9 ) * 0.82, gutter * 0.8 );
		// Patches of fresh, darker tar
		vec4 n2 = texture2D( uNoise, vWPos.xz / 38.0 + 0.21 );
		float patchMask = smoothstep( 0.58, 0.63, n2.a );
		diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * 0.72, patchMask * 0.85 );
		wearMask += patchMask * 0.6;
	}`,
        rough: 'roughnessFactor = clamp( roughnessFactor * 0.88 - 0.18 * wearMask, 0.22, 1.0 );'
    });

    // Road paint, worn off in the wheel tracks
    M.markings = patch(surface({
        vertexColors: true,
        roughness: 0.62,
        metalness: 0,
        envMapIntensity: 0.5,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4
    }), {
        decl: ROAD_GLSL,
        color: /* glsl */`
	{
		float a = abs( roadAcross( vWPos ) );
		float tracks = a < 50.0 ? exp( -pow( ( a - 2.2 ) / 0.42, 2.0 ) ) + exp( -pow( ( a - 3.8 ) / 0.42, 2.0 ) ) : 0.3;
		vec4 m = texture2D( uNoise, vWPos.xz / 17.0 + 0.5 );
		vec4 n = texture2D( uNoise, vWPos.xz / 1.1 );
		float wear = tracks * 0.5 + ( 1.0 - m.g ) * 0.42 + ( n.b - 0.5 ) * 0.18;
		if ( wear > 0.74 ) discard;
		diffuseColor.rgb *= mix( 1.0, 0.72, smoothstep( 0.35, 0.74, wear ) );
	}`
    });

    // Broom finished concrete with the 1.5 m joint grid of US sidewalks
    M.sidewalk = patch(withPbr(pbr('sidewalk'), {
        vertexColors: true,
        envMapIntensity: 0.6,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1
    }), {
        macro: 0.12,
        macroScale: 30,
        baseAO: 0.9,
        color: /* glsl */`
	{
		vec2 q = vWPos.xz / 1.52;
		vec2 fw = fwidth( q ) * 1.2;
		vec2 gd = abs( fract( q ) - 0.5 );
		float joint = 1.0 - smoothstep( 0.5 - 0.012 - fw.x, 0.5 - 0.004, max( gd.x, gd.y ) );
		diffuseColor.rgb *= mix( 0.62, 1.0, joint );
		vec4 n = texture2D( uNoise, vWPos.xz / 11.0 );
		diffuseColor.rgb *= 1.0 - 0.12 * n.a;
	}`
    });

    M.lawn = patch(withPbr(pbr('grass'), {
        vertexColors: true,
        envMapIntensity: 0.5,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1
    }), { macro: 0.18, macroScale: 14 });

    M.sand = patch(withPbr(pbr('sand'), {
        vertexColors: true,
        envMapIntensity: 0.55,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2
    }), { macro: 0.1, macroScale: 20 });

    const stucco = pbr('stucco');

    // Facades: storey atlas (4 bands) with a tint mask in the alpha channel,
    // stucco relief as bump, warm interior light behind some windows
    {
        const facadeMap = worldTexture('generated/facade_albedo_tint');
        const arm = software ? undefined : worldTexture('generated/facade_arm');
        // Atlas UV: 1 unit = 13.6 m, the stucco tiles every 2 m
        let bump: THREE.Texture | undefined;
        if (normals) {
            bump = cloneWorldTexture(stucco.map!);
            bump.repeat.set(6.8, 6.8);
        }
        M.facade = patch(surface({
            map: facadeMap,
            aoMap: arm,
            roughnessMap: arm,
            bumpMap: bump,
            bumpScale: 1.6,
            emissiveMap: software ? undefined : worldTexture('generated/facade_emissive'),
            emissive: new THREE.Color(1, 0.75, 0.5),
            emissiveIntensity: software ? 0 : 0.35,
            vertexColors: true,
            roughness: 1,
            metalness: 0,
            envMapIntensity: 0.95,
            aoMapIntensity: 0.6
        }), {
            tintMask: true,
            macro: 0.07,
            macroScale: 25,
            baseAO: 0.72,
            color: /* glsl */`
	{
		// Vertical dirt streaks
		float streak = texture2D( uNoise, vec2( ( vWPos.x + vWPos.z ) / 5.0, vWPos.y / 60.0 ) ).b;
		diffuseColor.rgb *= 1.0 - 0.14 * smoothstep( 0.45, 0.85, streak );
	}`
        });
    }

    // Smooth plaster: ledges, cornices, parapets, eaves, fountain
    M.stucco = patch(withPbr(stucco, {
        normalScale: new THREE.Vector2(0.6, 0.6),
        vertexColors: true,
        envMapIntensity: 0.95
    }), { macro: 0.08, macroScale: 20, baseAO: 0.72 });

    M.tiles = patch(withPbr(pbr('roof_tiles'), {
        vertexColors: true,
        envMapIntensity: 0.6
    }), { macro: 0.12, macroScale: 18 });

    M.gravel = patch(withPbr(pbr('roof_gravel'), {
        vertexColors: true,
        envMapIntensity: 0.3
    }), { macro: 0.15, macroScale: 15 });

    // Shop fronts (diner, surf shop, service station) with neon
    M.storefront = patch(surface({
        map: worldTexture('generated/storefront_atlas', { repeat: false }),
        emissiveMap: worldTexture('generated/storefront_emissive', { repeat: false }),
        emissive: new THREE.Color(1, 1, 1),
        emissiveIntensity: 2.2,
        roughness: 0.55,
        metalness: 0,
        envMapIntensity: 0.9,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -2
    }), {
        baseAO: 0.8,
        // Dark glass is glossy, painted wood and signs are rough
        rough: 'roughnessFactor = mix( 0.12, 0.8, smoothstep( 0.18, 0.5, dot( diffuseColor.rgb, vec3( 0.33 ) ) ) );'
    });

    M.fabric = patch(surface({
        vertexColors: true,
        roughness: 0.85,
        metalness: 0,
        side: THREE.DoubleSide,
        envMapIntensity: 0.6
    }), { translucency: 0.35, macro: 0.08, macroScale: 5 });

    // Street furniture in vertex colors
    M.props = patch(surface({
        vertexColors: true,
        roughness: 0.5,
        metalness: 0,
        envMapIntensity: 0.9
    }), { macro: 0.06, macroScale: 3 });

    // Lamp cores and signals (vertex colors may exceed 1)
    M.emissive = new THREE.MeshBasicMaterial({ vertexColors: true });

    // Terrain: dry golden grass with olive chaparral patches and bare earth
    // (vertex colors carry the large scale splat), rock on steep slopes
    {
        const set = pbr('grass_dry');
        const rock = software ? null : worldTexture('generated/rock_albedo');
        M.terrain = patch(withPbr(set, {
            vertexColors: true,
            envMapIntensity: 0.5
        }), {
            macro: 0.16,
            macroScale: 80,
            uniforms: { tRock: { value: rock } },
            decl: 'uniform sampler2D tRock;',
            color: /* glsl */`
	{
		float n = texture2D( uNoise, vWPos.xz / 240.0 ).r * 0.6 + texture2D( uNoise, vWPos.xz / 64.0 ).g * 0.4;
		float scrub = smoothstep( 0.4, 0.5, n ) * smoothstep( 1.0, 6.0, abs( vWPos.x ) + abs( vWPos.z ) - 150.0 );
		diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.05, 0.085, 0.03 ) * ( 0.6 + 0.8 * texture2D( uNoise, vWPos.xz / 4.0 ).r ), scrub * 0.55 );
		float fine = texture2D( uNoise, vWPos.xz / 9.0 ).b;
		diffuseColor.rgb *= mix( 0.85, 1.1, fine );
		float dirt = smoothstep( 0.62, 0.7, texture2D( uNoise, vWPos.xz / 140.0 + 0.3 ).a * 0.5 + texture2D( uNoise, vWPos.xz / 33.0 ).r * 0.5 );
		diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.4, 0.31, 0.21 ), dirt * 0.45 );
		// Rock on steep slopes (triplanar)
		vec3 nw = normalize( cross( dFdx( vWPos ), dFdy( vWPos ) ) );
		float slope = 1.0 - abs( nw.y );
		vec3 blend = pow( abs( nw ), vec3( 4.0 ) );
		blend /= ( blend.x + blend.y + blend.z );
		vec3 rockColor = texture2D( tRock, vWPos.zy / 11.0 ).rgb * blend.x + texture2D( tRock, vWPos.xy / 11.0 ).rgb * blend.z + texture2D( tRock, vWPos.xz / 13.0 ).rgb * blend.y;
		float rockMask = smoothstep( 0.22, 0.42, slope + ( texture2D( uNoise, vWPos.xz / 60.0 ).g - 0.5 ) * 0.25 );
		diffuseColor.rgb = mix( diffuseColor.rgb, rockColor * vec3( 0.95, 0.9, 0.85 ), rockMask );
	}`
        });
        // Tree shadows fade on grazing slopes and in the distance (lighting.ts)
        M.terrain.defines = { ...M.terrain.defines, BULLI_GRAZING_SHADOW_FADE: '' };
    }

    M.rock = patch(surface({
        map: worldTexture('generated/rock_albedo'),
        normalMap: normals ? worldTexture('generated/rock_normal') : undefined,
        vertexColors: true,
        roughness: 0.9,
        metalness: 0,
        envMapIntensity: 0.6
    }), { macro: 0.1, macroScale: 7 });

    // Palms and trees: cut-out cards with alpha to coverage where MSAA is on
    const card = (name: string, extra: THREE.MeshStandardMaterialParameters, translucency: number, cardMask = false) => {
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
        return patch(material, { translucency, alphaCoverage: true, cardMask });
    };
    M.trunk = patch(surface({
        map: worldTexture('generated/palm_trunk'),
        normalMap: normals ? worldTexture('generated/palm_trunk_normal') : undefined,
        normalScale: new THREE.Vector2(1.2, 1.2),
        vertexColors: true,
        roughness: 0.95,
        metalness: 0,
        envMapIntensity: 0.7
    }), {});
    M.fan = card('generated/fan_fronds', { alphaTest: 0.5, roughness: 0.7 }, 0.14);
    M.frond = card('generated/palm_fronds', { alphaTest: 0.45, roughness: 0.75 }, 0.3);
    M.tree = card('generated/tree_cards', { alphaTest: 0.5, roughness: 0.85, envMapIntensity: 0.5 }, 0.35, true);
    M.shrub = card('generated/shrubs', { alphaTest: 0.45, roughness: 0.8 }, 0.5, true);

    // Ponds and the fountain basin: dark, glossy water with moving normals
    M.water = patch(surface({
        color: new THREE.Color(0.03, 0.11, 0.12),
        roughness: 0.08,
        metalness: 0,
        envMapIntensity: 0.9
    }), {
        normal: /* glsl */`
	{
		vec2 p = vWPos.xz;
		vec2 g = vec2( cos( dot( p, vec2( 0.8, 0.6 ) ) * 1.9 + uTime * 1.6 ), cos( dot( p, vec2( -0.3, 0.95 ) ) * 2.7 + uTime * 2.1 ) ) * 0.06;
		vec4 nz = texture2D( uNoise, p / 3.0 + vec2( uTime * 0.02, 0.0 ) ) - 0.5;
		g += nz.gb * 0.12;
		normal = normalize( ( viewMatrix * vec4( normalize( vec3( -g.x, 1.0, -g.y ) ), 0.0 ) ).xyz );
	}`
    });

    return M;
}
