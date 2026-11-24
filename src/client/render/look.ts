import * as THREE from 'three';
import { lookAzimuth } from '../../shared/map/lighting.js';
import { MAP_REGISTRY, type MapAtmosphereSpec } from '../../shared/map/registry.js';

const DEFAULT_BULLI_BAY = MAP_REGISTRY['bulli-bay'].atmosphere;

// The realistic, calm sunset look of the world (graphics G1), extended for
// multi-map uniform-driven atmosphere (Bulli Bay sunset, Portes du Bulli alpine
// alpenglow, Kiesgrube warm quarry amber, Logge's Discovery World molten-ember
// twilight). Height fog reads live WORLD_UNIFORMS so switching maps never
// requires recompiling world shaders.
//
// Colors are linear (they may exceed 1: fog in the sun direction is HDR).

export const LOOK = {
    // Degrees above the horizon and direction the sun shines from (0 = +z,
    // 90 = +x): Bulli Bay's evening sun over the Pacific (compass 285°, 17°).
    sunElevation: DEFAULT_BULLI_BAY.sunElevation,
    sunAzimuth: lookAzimuth(DEFAULT_BULLI_BAY.sunAzimuth),
    sunColor: 0xffbd88,
    sunIntensity: 3.9,
    exposure: 1.0,
    // Tone mapping grade (installGrade)
    hueKeep: 0.45,
    saturation: 1.06,
    // Height fog: density, height falloff (1/m), start distance (m), maximum
    fog: { density: 0.0006, heightFalloff: 0.007, start: 100, max: 0.85 },
    fogColor: [0.6, 0.52, 0.46] as const,
    // Fog color looking into the sun (HDR)
    fogSunColor: [1.25, 0.56, 0.2] as const,
    // Sky gradient: zenith and the peach band between horizon and zenith
    zenith: [0.09, 0.17, 0.4] as const,
    skyMid: [0.76, 0.53, 0.42] as const,
    // Clouds: lit from below near the sun, beige to the side, grey above
    cloudSun: [3.2, 1.6, 0.62] as const,
    cloudFar: [1.18, 0.76, 0.6] as const,
    cloudTop: [0.44, 0.41, 0.42] as const,
    cloud: 1.0,
    cloudCoverage: 0.0,
    sunDisk: 30,
    // Lower half of the environment map (Victoria sunset ground, warm graded)
    groundTint: [1.5, 0.86, 0.5] as const,
    groundGain: 1.2,
    // Constant ground color of the environment map without the HDRI (phones)
    groundFallback: [0.35, 0.3, 0.26] as const,
    // Fill light without the environment map (software tier)
    hemiSky: 0xd4c0ae,
    hemiGround: 0x6b5446,
    hemiIntensity: 1.35
};

/** Computes the unit vector from the scene towards the sun for compass azimuth & elevation (degrees). */
export function sunDirectionFor(compassAzimuthDeg: number, elevationDeg: number, target = new THREE.Vector3()): THREE.Vector3 {
    const elevation = THREE.MathUtils.degToRad(elevationDeg);
    const azimuth = THREE.MathUtils.degToRad(lookAzimuth(compassAzimuthDeg));
    return target.set(
        Math.sin(azimuth) * Math.cos(elevation),
        Math.sin(elevation),
        Math.cos(azimuth) * Math.cos(elevation)
    ).normalize();
}

/** Unit vector from the scene towards the sun (default: Bulli Bay). */
export const SUN_DIRECTION = sunDirectionFor(DEFAULT_BULLI_BAY.sunAzimuth, DEFAULT_BULLI_BAY.sunElevation);

const glslFloat = (value: number) => (Number.isInteger(value) ? value.toFixed(1) : String(value));

/**
 * Uniforms shared by the world materials, height fog and the sky (one object
 * each, so updating a map's atmosphere reaches every compiled program with zero
 * shader recompilation).
 */
export const WORLD_UNIFORMS = {
    uSunDir: { value: SUN_DIRECTION.clone() },
    uSunColor: { value: new THREE.Color(LOOK.sunColor) },
    uFogColor: { value: new THREE.Color().setRGB(...LOOK.fogColor) },
    uFogSunColor: { value: new THREE.Color().setRGB(...LOOK.fogSunColor) },
    uFogDensity: { value: LOOK.fog.density },
    uFogHeightFalloff: { value: LOOK.fog.heightFalloff },
    uFogStart: { value: LOOK.fog.start },
    uFogMax: { value: LOOK.fog.max },
    // Tileable macro noise (generated/world_noise), assigned once it loaded
    uNoise: { value: null as THREE.Texture | null },
    uTime: { value: 0 }
};

export interface BiomeSkyTuning {
    fogDensity: number;
    fogHeightFalloff: number;
    fogStart: number;
    fogMax: number;
    fogColor: [number, number, number];
    fogSunColor: [number, number, number];
    zenith: [number, number, number];
    skyMid: [number, number, number];
    cloudSun: [number, number, number];
    cloudFar: [number, number, number];
    cloudTop: [number, number, number];
    cloudCoverage: number;
    groundTint: [number, number, number];
    groundGain: number;
}

const _tmpColor = new THREE.Color();
function hexToLinearRgb(hex: number, scale = 1): [number, number, number] {
    _tmpColor.setHex(hex, THREE.SRGBColorSpace);
    return [_tmpColor.r * scale, _tmpColor.g * scale, _tmpColor.b * scale];
}

/**
 * Derives calibrated linear HDR sky & height-fog parameters from a map's
 * MapAtmosphereSpec. Bulli Bay ('coastal') preserves the exact G1 golden sunset
 * calibration; alpine, quarry, and forge each get a distinct vivid atmosphere.
 */
export function atmosphereTuningFor(spec: MapAtmosphereSpec): BiomeSkyTuning {
    const span = Math.max(200, spec.fogFar - spec.fogNear);
    if (spec.biome === 'coastal') {
        return {
            fogDensity: LOOK.fog.density,
            fogHeightFalloff: LOOK.fog.heightFalloff,
            fogStart: LOOK.fog.start,
            fogMax: LOOK.fog.max,
            fogColor: [...LOOK.fogColor],
            fogSunColor: [...LOOK.fogSunColor],
            zenith: [...LOOK.zenith],
            skyMid: [...LOOK.skyMid],
            cloudSun: [...LOOK.cloudSun],
            cloudFar: [...LOOK.cloudFar],
            cloudTop: [...LOOK.cloudTop],
            cloudCoverage: LOOK.cloudCoverage,
            groundTint: [...LOOK.groundTint],
            groundGain: LOOK.groundGain
        };
    }
    if (spec.biome === 'alpine') {
        return {
            fogDensity: 0.00046 * (590 / span),
            fogHeightFalloff: 0.0042,
            fogStart: spec.fogNear,
            fogMax: 0.72,
            fogColor: hexToLinearRgb(spec.fogColor, 0.92),
            fogSunColor: hexToLinearRgb(spec.skyGlow, 1.35),
            zenith: hexToLinearRgb(spec.skyZenith, 0.95),
            skyMid: hexToLinearRgb(spec.skyHorizon, 0.95),
            cloudSun: [2.8, 2.25, 1.85],
            cloudFar: [1.32, 1.35, 1.45],
            cloudTop: [0.68, 0.74, 0.85],
            cloudCoverage: 0.08,
            groundTint: [0.95, 1.05, 1.18],
            groundGain: 1.15
        };
    }
    if (spec.biome === 'quarry') {
        return {
            fogDensity: 0.00072 * (450 / span),
            fogHeightFalloff: 0.0085,
            fogStart: spec.fogNear,
            fogMax: 0.78,
            fogColor: hexToLinearRgb(spec.fogColor, 0.85),
            fogSunColor: hexToLinearRgb(spec.skyGlow, 1.45),
            zenith: hexToLinearRgb(spec.skyZenith, 0.85),
            skyMid: hexToLinearRgb(spec.skyHorizon, 0.88),
            cloudSun: [3.0, 1.95, 0.95],
            cloudFar: [1.25, 0.96, 0.7],
            cloudTop: [0.58, 0.52, 0.48],
            cloudCoverage: -0.05,
            groundTint: [1.35, 0.95, 0.62],
            groundGain: 1.15
        };
    }
    // 'forge': Logge's Discovery World — molten-ember twilight over deep indigo zenith
    return {
        fogDensity: 0.00058 * (540 / span),
        fogHeightFalloff: 0.006,
        fogStart: spec.fogNear,
        fogMax: 0.8,
        // Keep distant valley haze moody plum-amber without crushing visibility
        fogColor: hexToLinearRgb(spec.fogColor, 1.45),
        fogSunColor: hexToLinearRgb(spec.skyGlow, 1.65),
        zenith: hexToLinearRgb(spec.skyZenith, 1.1),
        skyMid: hexToLinearRgb(spec.skyHorizon, 0.85),
        cloudSun: [3.4, 1.35, 0.36],
        cloudFar: [1.12, 0.56, 0.52],
        cloudTop: [0.34, 0.28, 0.44],
        cloudCoverage: 0.05,
        groundTint: [1.42, 0.78, 0.48],
        groundGain: 1.18
    };
}

export interface AtmosphereContext {
    scene: THREE.Scene;
    sun?: THREE.DirectionalLight;
    hemi?: THREE.HemisphereLight;
    renderer?: THREE.WebGLRenderer;
    sky?: { applyAtmosphere?: (spec: MapAtmosphereSpec) => void };
}

/**
 * Applies a map's atmospheric lighting, fog, exposure, and sky preset live via
 * WORLD_UNIFORMS (zero shader recompiles on map switch).
 */
export function applyMapAtmosphere(spec: MapAtmosphereSpec, ctx?: AtmosphereContext): void {
    const tuning = atmosphereTuningFor(spec);
    const sunDir = sunDirectionFor(spec.sunAzimuth, spec.sunElevation);

    WORLD_UNIFORMS.uSunDir.value.copy(sunDir);
    WORLD_UNIFORMS.uSunColor.value.setHex(spec.biome === 'coastal' ? LOOK.sunColor : spec.sunColor);
    WORLD_UNIFORMS.uFogColor.value.setRGB(...tuning.fogColor);
    WORLD_UNIFORMS.uFogSunColor.value.setRGB(...tuning.fogSunColor);
    WORLD_UNIFORMS.uFogDensity.value = tuning.fogDensity;
    WORLD_UNIFORMS.uFogHeightFalloff.value = tuning.fogHeightFalloff;
    WORLD_UNIFORMS.uFogStart.value = tuning.fogStart;
    WORLD_UNIFORMS.uFogMax.value = tuning.fogMax;

    if (!ctx) return;

    const bgColor = new THREE.Color().setRGB(...tuning.fogColor);
    if (ctx.scene.background instanceof THREE.Color) {
        ctx.scene.background.copy(bgColor);
    } else {
        ctx.scene.background = bgColor;
    }

    if (ctx.scene.fog instanceof THREE.Fog) {
        ctx.scene.fog.color.copy(bgColor);
        ctx.scene.fog.near = spec.fogNear;
        ctx.scene.fog.far = Math.max(spec.fogFar * 2, spec.fogNear + 250);
    } else {
        ctx.scene.fog = new THREE.Fog(bgColor, spec.fogNear, Math.max(spec.fogFar * 2, spec.fogNear + 250));
    }

    if (ctx.sun) {
        ctx.sun.color.setHex(spec.biome === 'coastal' ? LOOK.sunColor : spec.sunColor);
        ctx.sun.intensity = spec.biome === 'coastal' ? LOOK.sunIntensity : spec.sunIntensity;
        ctx.sun.position.copy(ctx.sun.target.position).addScaledVector(sunDir, 240);
    }

    if (ctx.hemi) {
        ctx.hemi.color.setHex(spec.biome === 'coastal' ? LOOK.hemiSky : spec.hemiSky);
        ctx.hemi.groundColor.setHex(spec.biome === 'coastal' ? LOOK.hemiGround : spec.hemiGround);
        ctx.hemi.intensity = spec.biome === 'coastal' ? LOOK.hemiIntensity : spec.hemiIntensity;
    }

    if (ctx.renderer) {
        ctx.renderer.toneMappingExposure = spec.biome === 'coastal' ? LOOK.exposure : spec.exposure;
    }

    ctx.sky?.applyAtmosphere?.(spec);
}

// --- Tone mapping grade ---------------------------------------------------------

const GRADE_MARKER = 'ACESFilmicToneMappingBase';

/**
 * ACES with a mild grade: preserves hue in saturated highlights plus subtle
 * warm/cool split toning. Patched once before any material compiles.
 */
export function installGrade(): void {
    const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
    if (chunks.tonemapping_pars_fragment.includes(GRADE_MARKER)) return;
    chunks.tonemapping_pars_fragment = chunks.tonemapping_pars_fragment.replace(
        'vec3 ACESFilmicToneMapping( vec3 color ) {',
        `vec3 ${GRADE_MARKER}( vec3 color ) {`
    ) + /* glsl */`
vec3 ACESFilmicToneMapping( vec3 color ) {
	vec3 c = ${GRADE_MARKER}( color );
	float lumIn = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
	float lumOut = ${GRADE_MARKER}( vec3( lumIn ) ).g;
	vec3 huePreserved = color * ( lumOut / max( lumIn, 1e-5 ) );
	huePreserved /= max( 1.0, max( huePreserved.r, max( huePreserved.g, huePreserved.b ) ) );
	c = mix( c, huePreserved, ${glslFloat(LOOK.hueKeep)} * smoothstep( 0.25, 0.85, lumOut ) );
	float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
	c *= mix( vec3( 0.985, 0.99, 1.0 ), vec3( 1.03, 1.0, 0.95 ), smoothstep( 0.04, 0.55, l ) );
	c = mix( vec3( l ), c, ${glslFloat(LOOK.saturation)} );
	return clamp( c, 0.0, 1.0 );
}`;
}

// --- Height fog -------------------------------------------------------------------

const FOG_MARKER = '// bulli: height fog';

/**
 * Replaces three's distance fog with uniform-driven height fog for every
 * material with fog enabled: denser near the ground, thinning with height,
 * brighter towards the sun, mixed in linear HDR right before tone mapping.
 * World materials bind WORLD_UNIFORMS (uFogDensity, uFogHeightFalloff,
 * uFogStart, uFogMax, uFogColor, uFogSunColor, uSunDir); unpatched materials
 * (uFogMax == 0) fall back cleanly to scene.fog's fogColor/fogNear/fogFar.
 */
export function installHeightFog(): void {
    const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
    if (chunks.fog_pars_fragment.includes(FOG_MARKER)) return;

    chunks.fog_pars_vertex = /* glsl */`
#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3 vFogWorldPosition;
#endif`;
    chunks.fog_vertex = /* glsl */`
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	// World position from the view space one (view matrix is rigid)
	vFogWorldPosition = ( mvPosition.xyz - viewMatrix[ 3 ].xyz ) * mat3( viewMatrix );
#endif`;
    chunks.fog_pars_fragment = /* glsl */`${FOG_MARKER}
#ifdef USE_FOG
	uniform vec3 fogColor;
	#ifndef BULLI_HAS_SUN_DIR
		uniform vec3 uSunDir;
	#endif
	uniform vec3 uFogColor;
	uniform vec3 uFogSunColor;
	uniform float uFogDensity;
	uniform float uFogHeightFalloff;
	uniform float uFogStart;
	uniform float uFogMax;
	varying float vFogDepth;
	varying vec3 vFogWorldPosition;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
	vec3 bulliFogColor( vec3 viewDirection ) {
		if ( uFogMax <= 0.0 ) return fogColor;
		float s = max( dot( viewDirection, uSunDir ), 0.0 );
		return mix( uFogColor, uFogSunColor, pow( s, 9.0 ) * 0.7 + pow( s, 90.0 ) * 0.3 );
	}
	float bulliFogAmount( vec3 worldPosition ) {
		float d = length( worldPosition - cameraPosition );
		if ( uFogMax <= 0.0 ) {
			#ifdef FOG_EXP2
				return 1.0 - exp( -fogDensity * fogDensity * d * d );
			#else
				return smoothstep( fogNear, fogFar, d ) * 0.85;
			#endif
		}
		float h = 0.5 * ( max( worldPosition.y, 0.0 ) + max( cameraPosition.y, 0.0 ) );
		float dens = uFogDensity * exp( -uFogHeightFalloff * h );
		return min( 1.0 - exp( -dens * max( d - uFogStart, 0.0 ) ), uFogMax );
	}
#endif`;
    // Applied in tonemapping_fragment instead (linear HDR)
    chunks.fog_fragment = '';
    chunks.tonemapping_fragment = /* glsl */`
#ifdef USE_FOG
	gl_FragColor.rgb = mix( gl_FragColor.rgb, bulliFogColor( normalize( vFogWorldPosition - cameraPosition ) ), bulliFogAmount( vFogWorldPosition ) );
#endif
` + chunks.tonemapping_fragment;
}

/** Scene fog object that switches the height fog on (see installHeightFog). */
export function createSceneFog(): THREE.Fog {
    // Near/far also drive distance fades of custom shaders (shield rim, unpatched meshes)
    return new THREE.Fog(new THREE.Color().setRGB(...LOOK.fogColor), 250, 1400);
}
