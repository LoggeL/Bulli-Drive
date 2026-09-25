import * as THREE from 'three';
import { LOOK, WORLD_UNIFORMS } from './look.js';

// Sky and image based light (from the world probe).
//
// The visible sky is a gradient (horizon = the fog color, peach band, blue
// zenith) whose clouds take their structure from the Qwantani sunset HDRI
// (CC0): luminance divided by the row average, so only the cloud detail comes
// from the photo and color and brightness stay under control. A procedural
// cloud band (world noise) and the sun disc and glow sit on the direction of
// the directional light. The HDRI is remapped in elevation so its sun lands
// on ours.
//
// The environment map (PMREM) is the same sky above the horizon and the
// Victoria sunset HDRI (CC0, warm graded) below, so reflections and ambient
// light match the visible sky. Phones skip both HDRIs (2.7 MB): the clouds
// then come from the noise alone and the ground is a warm constant.

const VERTEX = /* glsl */`
varying vec3 vSkyDirection;
void main() {
	vSkyDirection = normalize( ( modelMatrix * vec4( position, 0.0 ) ).xyz );
	vec4 p = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
	// On the far plane: drawn after the opaque scene, only visible sky is shaded
	gl_Position = p.xyww;
}`;

const FRAGMENT = /* glsl */`
uniform sampler2D tSky;
uniform sampler2D tRow;
uniform sampler2D tGround;
uniform float uUOff;
uniform float uSrcElev;
uniform float uDstElev;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uFogColor;
uniform vec3 uFogSunColor;
uniform vec3 uZenith;
uniform vec3 uMid;
uniform float uCloud;
uniform float uEnv;
uniform float uSunDisk;
uniform float uGlow;
uniform vec3 uGroundTint;
uniform float uGroundGain;
uniform sampler2D uNoise;
uniform vec3 uCloudSun;
uniform vec3 uCloudFar;
uniform vec3 uCloudTop;
uniform float uCloudCov;
varying vec3 vSkyDirection;

// Cloud layer as a plane about 1.5 km up, noise stretched into bands
float cloudDensity( vec3 d, out float edge ) {
	vec2 p = d.xz / max( d.y, 0.035 );
	p = mat2( 0.94, -0.34, 0.34, 0.94 ) * p;
	vec2 q = p * vec2( 0.16, 0.55 );
	float n = texture2D( uNoise, q * 0.11 + vec2( 0.13, 0.71 ) ).r * 0.52
		+ texture2D( uNoise, q * 0.29 + vec2( 0.4, 0.2 ) ).g * 0.28
		+ texture2D( uNoise, p * vec2( 0.21, 0.6 ) + vec2( 0.7, 0.1 ) ).b * 0.14
		+ texture2D( uNoise, p * vec2( 0.9, 1.6 ) ).r * 0.06;
	float big = texture2D( uNoise, p * vec2( 0.018, 0.05 ) + vec2( 0.31, 0.47 ) ).g;
	n += ( big - 0.5 ) * 0.55;
	float band = smoothstep( 0.012, 0.05, d.y ) * ( 1.0 - smoothstep( 0.32, 0.62, d.y ) );
	edge = smoothstep( 0.5 - uCloudCov, 0.56 - uCloudCov, n ) - smoothstep( 0.56 - uCloudCov, 0.7 - uCloudCov, n );
	return smoothstep( 0.5 - uCloudCov, 0.64 - uCloudCov, n ) * band;
}

#define SKY_PI 3.141592653589793
vec3 fogDirColor( vec3 vd ) {
	float s = max( dot( vd, uSunDir ), 0.0 );
	return mix( uFogColor, uFogSunColor, pow( s, 9.0 ) * 0.7 + pow( s, 90.0 ) * 0.3 );
}

void main() {
	vec3 d = normalize( vSkyDirection );
	float el = asin( clamp( d.y, -1.0, 1.0 ) );
	float sd = max( dot( d, uSunDir ), 0.0 );
	vec3 c;
	if ( d.y >= 0.0 || uEnv < 0.5 ) {
		float y = max( d.y, 0.0 );
		// Horizon (fog color, brighter towards the sun) -> peach -> zenith
		vec3 H = fogDirColor( d );
		vec3 mid = mix( uMid, H, 0.35 + 0.4 * pow( sd, 3.0 ) );
		c = mix( H, mid, smoothstep( 0.0, 0.12, y ) );
		// The environment gets a warmer zenith (blue shadows otherwise)
		vec3 Z = uEnv > 0.5 ? mix( uZenith, uMid, 0.5 ) : uZenith;
		c = mix( c, Z, smoothstep( 0.04, 0.42, y ) * ( 1.0 - 0.35 * pow( sd, 10.0 ) ) );
		#ifndef SKY_SIMPLE
		// Cloud structure of the HDRI, elevation remapped onto our sun height
		float e2 = el <= uDstElev
			? el * ( uSrcElev / uDstElev )
			: uSrcElev + ( el - uDstElev ) * ( ( SKY_PI * 0.5 - uSrcElev ) / ( SKY_PI * 0.5 - uDstElev ) );
		e2 = max( e2, 0.003 );
		float u = atan( d.z, d.x ) / ( 2.0 * SKY_PI ) + 0.5 + uUOff;
		float v = e2 / SKY_PI + 0.5;
		vec3 hdr = texture2D( tSky, vec2( fract( u ), v ) ).rgb;
		float lum = min( dot( hdr, vec3( 0.2126, 0.7152, 0.0722 ) ), 4.0 );
		float avg = texture2D( tRow, vec2( 0.5, v ) ).r;
		float ratio = clamp( lum / max( avg, 1e-4 ), 0.25, 3.0 );
		c *= mix( 1.0, pow( ratio, 0.9 ), 0.25 * smoothstep( 0.06, 0.2, y ) );
		#endif
		// Sun disc behind the clouds, glow in front
		float disk = smoothstep( cos( 0.0125 ), cos( 0.0100 ), dot( d, uSunDir ) );
		c += uSunColor * ( pow( sd, 1500.0 ) * 5.0 + pow( sd, 120.0 ) * 0.7 + pow( sd, 16.0 ) * 0.1 ) * uGlow;
		float edge = 0.0;
		float cd = 0.0;
		#ifndef SKY_SIMPLE
		cd = cloudDensity( d, edge ) * ( 1.0 - 0.85 * pow( sd, 400.0 ) );
		#endif
		c += mix( uSunColor, vec3( 1.0, 0.93, 0.78 ), 0.8 ) * disk * uSunDisk * ( 1.0 - cd * 0.9 );
		// Clouds: gold near the sun, beige to the side, grey above
		vec3 cl = mix( uCloudFar, uCloudSun, pow( sd, 4.0 ) );
		cl = mix( cl, uCloudTop, smoothstep( 0.1, 0.45, y ) * ( 1.0 - pow( sd, 3.0 ) ) );
		cl += uSunColor * edge * ( pow( sd, 12.0 ) * 2.5 + 0.12 );
		c = mix( c, cl, cd * uCloud );
		// Below the horizon (hidden by the world) the fog color
		if ( d.y < 0.0 ) c = fogDirColor( d );
	} else {
		// Environment ground: the Victoria sunset, warm graded
		float u = atan( d.z, d.x ) / ( 2.0 * SKY_PI ) + 0.5 + uUOff;
		float v = el / SKY_PI + 0.5;
		vec3 g = texture2D( tGround, vec2( fract( u ), v ) ).rgb;
		float gl = dot( g, vec3( 0.2126, 0.7152, 0.0722 ) );
		c = mix( g, gl * uGroundTint, 0.6 ) * uGroundGain;
		c = mix( c, fogDirColor( d ), exp( d.y * 10.0 ) * 0.6 );
	}
	gl_FragColor = vec4( c, 1.0 );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`;

// Where the sun is in the Qwantani HDRI: u of its azimuth, its elevation
const HDRI_SUN_U = 0.6;
const HDRI_SUN_ELEVATION = THREE.MathUtils.degToRad(6.1);

interface SkyTextures {
    sky: THREE.Texture;
    row: THREE.Texture;
    ground: THREE.Texture;
}

function constantTexture(r: number, g: number, b: number): THREE.DataTexture {
    const data = new Uint16Array([r, g, b, 1].map(THREE.DataUtils.toHalfFloat));
    const texture = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat, THREE.HalfFloatType);
    texture.needsUpdate = true;
    return texture;
}

function fallbackTextures(): SkyTextures {
    return {
        sky: constantTexture(1, 1, 1),
        row: constantTexture(1, 1, 1),
        ground: constantTexture(...LOOK.groundFallback)
    };
}

// Row average of the luminance of an equirect HDR as a 1 x height texture
function rowAverage(texture: THREE.DataTexture): THREE.DataTexture {
    const { width, height, data } = texture.image as unknown as { width: number; height: number; data: Uint16Array | Float32Array };
    const half = data instanceof Uint16Array;
    const channels = data.length / (width * height);
    const read = (value: number) => (half ? THREE.DataUtils.fromHalfFloat(value) : value);
    const out = new Uint16Array(height * 4);
    for (let y = 0; y < height; y++) {
        let sum = 0;
        for (let x = 0; x < width; x += 2) {
            const i = (y * width + x) * channels;
            sum += Math.min(4, 0.2126 * read(data[i]) + 0.7152 * read(data[i + 1]) + 0.0722 * read(data[i + 2]));
        }
        const average = THREE.DataUtils.toHalfFloat(Math.min(sum / (width / 2), 60000));
        out[y * 4] = out[y * 4 + 1] = out[y * 4 + 2] = average;
        out[y * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
    }
    const row = new THREE.DataTexture(out, 1, height, THREE.RGBAFormat, THREE.HalfFloatType);
    row.minFilter = row.magFilter = THREE.LinearFilter;
    row.flipY = texture.flipY;
    row.needsUpdate = true;
    return row;
}

async function loadHdriTextures(): Promise<SkyTextures> {
    const { HDRLoader } = await import('three/examples/jsm/loaders/HDRLoader.js');
    const loader = new HDRLoader();
    const base = `${import.meta.env.BASE_URL}textures/hdri/`;
    const [sky, ground] = await Promise.all([
        loader.loadAsync(`${base}qwantani_sunset_puresky_1k.hdr`),
        loader.loadAsync(`${base}victoria_sunset_1k.hdr`)
    ]);
    for (const texture of [sky, ground]) {
        texture.wrapS = THREE.RepeatWrapping;
        texture.minFilter = texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
    }
    return { sky, row: rowAverage(sky), ground };
}

function uOffset(sunDirection: THREE.Vector3): number {
    return HDRI_SUN_U - (Math.atan2(sunDirection.z, sunDirection.x) / (2 * Math.PI) + 0.5);
}

function createSkyMaterial(textures: SkyTextures, environment: boolean, simple = false): THREE.ShaderMaterial {
    const sun = WORLD_UNIFORMS.uSunDir.value;
    return new THREE.ShaderMaterial({
        // Gradient and sun only, without clouds (software tier)
        defines: simple ? { SKY_SIMPLE: '' } : {},
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        // The environment is lit linear HDR; the visible sky is tone mapped
        toneMapped: !environment,
        uniforms: {
            tSky: { value: textures.sky },
            tRow: { value: textures.row },
            tGround: { value: textures.ground },
            uUOff: { value: uOffset(sun) },
            uSrcElev: { value: HDRI_SUN_ELEVATION },
            uDstElev: { value: Math.asin(sun.y) },
            uSunDir: WORLD_UNIFORMS.uSunDir,
            uSunColor: WORLD_UNIFORMS.uSunColor,
            uFogColor: WORLD_UNIFORMS.uFogColor,
            uFogSunColor: WORLD_UNIFORMS.uFogSunColor,
            uNoise: WORLD_UNIFORMS.uNoise,
            uZenith: { value: new THREE.Color().setRGB(...LOOK.zenith) },
            uMid: { value: new THREE.Color().setRGB(...LOOK.skyMid) },
            uCloud: { value: environment ? LOOK.cloud * 0.6 : LOOK.cloud },
            uEnv: { value: environment ? 1 : 0 },
            uSunDisk: { value: environment ? 0 : LOOK.sunDisk },
            uGlow: { value: environment ? 0.5 : 1 },
            uGroundTint: { value: new THREE.Color().setRGB(...LOOK.groundTint) },
            uGroundGain: { value: LOOK.groundGain },
            uCloudCov: { value: LOOK.cloudCoverage },
            uCloudSun: { value: new THREE.Color().setRGB(...LOOK.cloudSun) },
            uCloudFar: { value: new THREE.Color().setRGB(...LOOK.cloudFar) },
            uCloudTop: { value: new THREE.Color().setRGB(...LOOK.cloudTop) }
        }
    });
}

export interface Sky {
    dome: THREE.Mesh;
    /** Renders the environment map again (after the HDRIs loaded, after a context loss). */
    rebuildEnvironment(): void;
    /** Resolves once the HDRIs are in and the environment has been rebuilt with them. */
    ready: Promise<void>;
}

// What rebuildEnvironment needs of THREE.PMREMGenerator (tests hand in a fake)
export interface PmremFactory {
    (renderer: THREE.WebGLRenderer): Pick<THREE.PMREMGenerator, 'fromScene' | 'dispose'>;
}

const createPmrem: PmremFactory = renderer => new THREE.PMREMGenerator(renderer);

/**
 * Creates the sky dome and, unless `environment` is false (software tier),
 * sets scene.environment. `hdri` false keeps the constant fallback textures.
 * `beforeEnvironment` resolves when the other inputs of the environment (the
 * world noise texture) are loaded.
 */
export function createSky(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    options: { environment: boolean; hdri: boolean; simple: boolean; beforeEnvironment: Promise<void>; pmrem?: PmremFactory }
): Sky {
    let textures = fallbackTextures();
    const skyMaterial = createSkyMaterial(textures, false, options.simple);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1, options.simple ? 24 : 48, options.simple ? 12 : 24), skyMaterial);
    dome.name = 'sky-dome';
    dome.scale.setScalar(500);
    dome.renderOrder = 1000;
    dome.frustumCulled = false;
    dome.matrixAutoUpdate = false;
    scene.add(dome);

    let environmentTarget: THREE.WebGLRenderTarget | null = null;
    const rebuildEnvironment = () => {
        if (!options.environment) return;
        const envScene = new THREE.Scene();
        const material = createSkyMaterial(textures, true);
        const geometry = new THREE.SphereGeometry(50, 64, 32);
        envScene.add(new THREE.Mesh(geometry, material));
        const pmrem = (options.pmrem ?? createPmrem)(renderer);
        const target = pmrem.fromScene(envScene, 0, 0.1, 200);
        pmrem.dispose();
        material.dispose();
        geometry.dispose();
        environmentTarget?.dispose();
        environmentTarget = target;
        scene.environment = target.texture;
    };
    rebuildEnvironment();

    const ready = (async () => {
        if (options.hdri) {
            try {
                const loaded = await loadHdriTextures();
                for (const key of ['sky', 'row', 'ground'] as const) {
                    textures[key].dispose();
                    skyMaterial.uniforms[key === 'sky' ? 'tSky' : key === 'row' ? 'tRow' : 'tGround'].value = loaded[key];
                }
                textures = loaded;
            } catch (error) {
                console.warn('Sky HDRIs failed to load, keeping the fallback sky', error);
            }
        }
        await options.beforeEnvironment;
        rebuildEnvironment();
    })();

    // A lost context takes the rendered environment map with it; three.js
    // restores its own state first (its listener was registered earlier).
    renderer.domElement.addEventListener('webglcontextrestored', () => {
        environmentTarget = null;
        rebuildEnvironment();
    });

    return { dome, rebuildEnvironment, ready };
}

export function updateSkyDome(dome: THREE.Mesh, camera: THREE.Camera): void {
    dome.position.copy(camera.position);
    dome.updateMatrix();
}
