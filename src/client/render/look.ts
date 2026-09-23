import * as THREE from 'three';

// The realistic, calm sunset look of the world (graphics G1), taken over from
// the world probe (gfx/real/world): low warm sun, HDRI-based sky and image
// based light, height fog with sun scatter in linear HDR before tone mapping,
// ACES with a mild hue-preserving grade. All values in one place; sky.ts,
// lighting.ts and the world materials read them.
//
// Colors are linear (they may exceed 1: fog in the sun direction is HDR).

export const LOOK = {
    // Degrees above the horizon and compass direction the sun shines from
    // (0 = +z, 90 = +x). 17 degrees: golden hour light with long shadows
    // that still leave the streets between the up to 26 m tall buildings
    // partly lit (the probe's 9 degrees suited its two-storey town).
    sunElevation: 17,
    sunAzimuth: 28,
    sunColor: 0xffbd88,
    sunIntensity: 3.9,
    exposure: 1.0,
    // Tone mapping grade (installGrade): share of the hue-preserving curve in
    // the highlights, saturation (a little below the probe's 1.12 and a
    // less orange sun than its #FFB070: the calm, natural variant of its
    // look). No stylizing LUT.
    hueKeep: 0.45,
    saturation: 1.06,
    // Height fog: density, height falloff (1/m), start distance (m), maximum
    fog: { density: 0.0007, heightFalloff: 0.007, start: 100, max: 0.88 },
    fogColor: [0.66, 0.44, 0.42] as const,
    // Fog color looking into the sun (HDR)
    fogSunColor: [1.25, 0.56, 0.2] as const,
    // Sky gradient: zenith and the peach band between horizon and zenith
    zenith: [0.09, 0.17, 0.4] as const,
    skyMid: [0.78, 0.46, 0.38] as const,
    cloud: 1.0,
    cloudCoverage: 0.0,
    sunDisk: 30,
    // Lower half of the environment map (Victoria sunset ground, warm graded)
    groundTint: [1.5, 0.86, 0.5] as const,
    groundGain: 1.2,
    // Constant ground color of the environment map without the HDRI (phones)
    groundFallback: [0.35, 0.3, 0.26] as const,
    // Fill light without the environment map (software tier)
    hemiSky: 0xd9b7a4,
    hemiGround: 0x6b5446,
    hemiIntensity: 1.35
};

/** Unit vector from the scene towards the sun. */
export const SUN_DIRECTION = new THREE.Vector3();
{
    const elevation = THREE.MathUtils.degToRad(LOOK.sunElevation);
    const azimuth = THREE.MathUtils.degToRad(LOOK.sunAzimuth);
    SUN_DIRECTION.set(
        Math.sin(azimuth) * Math.cos(elevation),
        Math.sin(elevation),
        Math.cos(azimuth) * Math.cos(elevation)
    ).normalize();
}

const glslFloat = (value: number) => (Number.isInteger(value) ? value.toFixed(1) : String(value));
const glslVec3 = (v: readonly number[]) => `vec3( ${v.map(glslFloat).join(', ')} )`;

/**
 * Uniforms shared by the world materials and the sky (one object each, so
 * updating the value reaches every program).
 */
export const WORLD_UNIFORMS = {
    uSunDir: { value: SUN_DIRECTION.clone() },
    uSunColor: { value: new THREE.Color(LOOK.sunColor) },
    uFogColor: { value: new THREE.Color().setRGB(...LOOK.fogColor) },
    uFogSunColor: { value: new THREE.Color().setRGB(...LOOK.fogSunColor) },
    // Tileable macro noise (generated/world_noise), assigned once it loaded
    uNoise: { value: null as THREE.Texture | null },
    uTime: { value: 0 }
};

// --- Tone mapping grade ---------------------------------------------------------

const GRADE_MARKER = 'ACESFilmicToneMappingBase';

/**
 * ACES with a mild grade (from the probe): ACES bleaches saturated highlights
 * (orange to white), so the highlights get a share of a hue-preserving curve
 * on luminance, plus a restrained split toning (cool shadows, warm lights).
 * Patched into the shared chunk before any material compiles.
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
	c *= mix( vec3( 0.99, 0.96, 1.0 ), vec3( 1.03, 1.0, 0.95 ), smoothstep( 0.04, 0.55, l ) );
	c = mix( vec3( l ), c, ${glslFloat(LOOK.saturation)} );
	return clamp( c, 0.0, 1.0 );
}`;
}

// --- Height fog -------------------------------------------------------------------

const FOG_MARKER = '// bulli: height fog';

/**
 * Replaces three's distance fog with the probe's height fog for every
 * material with fog enabled: denser near the ground, thinning with height,
 * warm and brighter towards the sun, mixed in linear HDR right before tone
 * mapping (three's own fog comes after tone mapping and color space
 * conversion). scene.fog only switches it on (USE_FOG); its near/far are
 * still available to shaders that fade by distance (the shield rim).
 */
export function installHeightFog(): void {
    const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
    if (chunks.fog_pars_fragment.includes(FOG_MARKER)) return;
    const { density, heightFalloff, start, max } = LOOK.fog;

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
	varying float vFogDepth;
	varying vec3 vFogWorldPosition;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
	vec3 bulliFogColor( vec3 viewDirection ) {
		float s = max( dot( viewDirection, ${glslVec3(SUN_DIRECTION.toArray().map(v => Number(v.toFixed(5))))} ), 0.0 );
		return mix( ${glslVec3(LOOK.fogColor)}, ${glslVec3(LOOK.fogSunColor)}, pow( s, 9.0 ) * 0.7 + pow( s, 90.0 ) * 0.3 );
	}
	float bulliFogAmount( vec3 worldPosition ) {
		float d = length( worldPosition - cameraPosition );
		float h = 0.5 * ( max( worldPosition.y, 0.0 ) + max( cameraPosition.y, 0.0 ) );
		float dens = ${glslFloat(density)} * exp( -${glslFloat(heightFalloff)} * h );
		return min( 1.0 - exp( -dens * max( d - ${glslFloat(start)}, 0.0 ) ), ${glslFloat(max)} );
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
    // Near/far only drive distance fades of custom shaders (shield rim)
    return new THREE.Fog(new THREE.Color().setRGB(...LOOK.fogColor), 250, 1400);
}
