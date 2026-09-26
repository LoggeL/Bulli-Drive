import * as THREE from 'three';
import { state } from '../state.js';
import { gameHooks } from '../game/hooks.js';
import { detectRenderTier, type RenderTier } from '../effects/renderQuality.js';
import { createSky, updateSkyDome } from './sky.js';
import { LOOK, SUN_DIRECTION, WORLD_UNIFORMS, createSceneFog, installGrade, installHeightFog } from './look.js';
import { initWorldTextures, worldTexture, whenWorldTextureLoaded } from '../world/textures.js';

// Realistic sunset lighting (graphics G1, values in look.ts): ACES with a mild
// grade, a low warm sun whose shadow camera follows the car, the HDRI sky
// (dome and PMREM environment map), height fog, soft contact shadows under
// every car and the shield rim. main.ts only calls setupLighting() once and
// updateLighting() every frame.

export { SUN_DIRECTION };

export const LIGHTING = {
    // Tree shadows on the terrain fade out between these camera distances
    // (meters). Streets and plazas are not terrain and keep their shadows.
    terrainShadowFade: { start: 55, end: 110 },
    // Anisotropic filtering of the world textures per tier
    anisotropy: { desktop: 8, mobile: 4, software: 1 } as Record<RenderTier, number>,
    shadow: {
        // No shadow map on a CPU rasterizer: the shadow pass and the 3 x 3
        // lookups in every lit pixel cost SwiftShader about a seventh of each
        // frame, and the depth programs half a second of compiling per page
        // (docs/phase-3-design.md A71). The contact shadows under the cars stay.
        enabled: { desktop: true, mobile: true, software: false } as Record<RenderTier, boolean>,
        // Half size of the square the shadow map covers (in light space,
        // meters). On the ground it reaches 1 / sin(sunElevation) times as far
        // along the sun's direction.
        halfExtent: { desktop: 60, mobile: 45, software: 45 } as Record<RenderTier, number>,
        // Texels across the sun direction: desktop 6 cm, mobile (the low
        // tier: 1024 map) 9 cm, software 9 cm
        mapSize: { desktop: 2048, mobile: 1024, software: 1024 } as Record<RenderTier, number>,
        // The covered square is pushed ahead in the view direction as far as
        // it can while it still covers these points around the car (meters
        // forward, meters to the side), where the chase camera sees the ground
        // right next to the car.
        mustCover: [[-15, 20], [5, 32]] as [number, number][],
        lookAhead: { min: 10, max: 90 },
        // Shadows fade out over this part of the map towards its border, so
        // the end of the covered area is a soft falloff, not a hard line.
        edgeFade: 0.12,
        // Distance of the light from the covered center along the sun
        // direction: far enough for the tallest buildings (26 m) at the low sun
        distance: 240,
        near: 1,
        far: 480,
        bias: -0.0004,
        normalBias: 0.035
    },
    contactShadow: {
        opacity: 0.7,
        // Footprint growth over the car's body
        spread: 1.5,
        color: 0x1d130c
    }
};

// Shadow camera basis (see Matrix4.lookAt): texel snapping and the coverage
// test work in these axes
const _lightX = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), SUN_DIRECTION).normalize();
const _lightY = new THREE.Vector3().crossVectors(SUN_DIRECTION, _lightX);

let sun: THREE.DirectionalLight | null = null;
let skyDome: THREE.Mesh | null = null;
let shadowHalfExtent = 0;
let shadowTexel = 0;
let renderTier: RenderTier = 'desktop';
let skyReady: Promise<void> = Promise.resolve();

const _focus = new THREE.Vector3();
const _viewDirection = new THREE.Vector3();
const _side = new THREE.Vector3();
const _snapped = new THREE.Vector3();

/** The render tier the lighting (and the world materials) were set up for. */
export function lightingTier(): RenderTier {
    return renderTier;
}

/** Resolves once the sky HDRIs are loaded and the environment map is final. */
export function whenSkyReady(): Promise<void> {
    return skyReady;
}

/**
 * Configures tone mapping, sky, fog, environment and lights. Call once after
 * the renderer exists.
 */
export function setupLighting(scene: THREE.Scene, renderer: THREE.WebGLRenderer): void {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = LOOK.exposure;
    const tier = renderTier = detectRenderTier(renderer);
    renderer.shadowMap.enabled = LIGHTING.shadow.enabled[tier];
    // One filter for every tier (three r186 has no PCFSoftShadowMap): PCF
    // with the smooth 3 x 3 kernel of patchShadowFilter. Its nine hardware
    // lookups cost less than the 17 of r160's PCFShadowMap the software tier
    // used before.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    // Shader chunk patches, before any material compiles
    installGrade();
    installHeightFog();
    patchShadowFilter();
    patchShadowChunks();
    patchReflectionBend();

    initWorldTextures(renderer, LIGHTING.anisotropy[tier]);
    const noise = worldTexture('generated/world_noise');
    noise.colorSpace = THREE.NoColorSpace;
    WORLD_UNIFORMS.uNoise.value = noise;

    scene.background = new THREE.Color().setRGB(...LOOK.fogColor);
    scene.fog = createSceneFog();
    // Software WebGL renders without the environment map: sampling it in
    // every lit pixel costs a CPU rasterizer about a quarter of its frame
    // rate. A hemisphere fill in the sky's colors takes over. Phones render
    // it from the procedural sky without the 2.7 MB of HDRIs.
    const useEnvironment = tier !== 'software';
    const sky = createSky(renderer, scene, {
        environment: useEnvironment,
        hdri: tier === 'desktop',
        simple: tier === 'software',
        beforeEnvironment: whenWorldTextureLoaded('generated/world_noise')
    });
    skyDome = sky.dome;
    skyReady = sky.ready;
    if (!useEnvironment) {
        scene.add(new THREE.HemisphereLight(LOOK.hemiSky, LOOK.hemiGround, LOOK.hemiIntensity));
    }

    const shadow = LIGHTING.shadow;
    shadowHalfExtent = shadow.halfExtent[tier];
    const mapSize = shadow.mapSize[tier];
    sun = new THREE.DirectionalLight(LOOK.sunColor, LOOK.sunIntensity);
    sun.castShadow = renderer.shadowMap.enabled;
    sun.shadow.mapSize.set(mapSize, mapSize);
    const camera = sun.shadow.camera;
    camera.left = -shadowHalfExtent;
    camera.right = shadowHalfExtent;
    camera.top = shadowHalfExtent;
    camera.bottom = -shadowHalfExtent;
    camera.near = shadow.near;
    camera.far = shadow.far;
    camera.updateProjectionMatrix();
    sun.shadow.bias = shadow.bias;
    sun.shadow.normalBias = shadow.normalBias;
    shadowTexel = (2 * shadowHalfExtent) / mapSize;
    scene.add(sun);
    scene.add(sun.target);
    placeSun(_focus.set(0, 0, 0));

    initContactShadows(scene);
}

/**
 * Per-frame update before rendering: sky dome and shadow camera follow the
 * view, contact shadows follow the cars.
 */
export function updateLighting(): void {
    const camera = state.camera;
    if (!camera || !sun) return;
    if (skyDome) updateSkyDome(skyDome, camera);

    if (state.bulli) _focus.copy(state.bulli.group.position);
    else _focus.copy(camera.position).setY(0);
    camera.getWorldDirection(_viewDirection).setY(0);
    if (_viewDirection.lengthSq() > 1e-6) {
        _viewDirection.normalize();
        _focus.addScaledVector(_viewDirection, shadowLookAhead(_viewDirection));
    }
    placeSun(_focus);

    updateCars();
}

/**
 * Re-centers sky dome and shadows on a camera that was moved after
 * updateLighting() ran (fixed screenshot views, see e2eHook.ts): the dome on
 * the camera, the shadow map on `focus`.
 */
export function focusLightingOn(camera: THREE.Camera, focus: THREE.Vector3): void {
    if (skyDome) updateSkyDome(skyDome, camera);
    placeSun(_focus.copy(focus));
}

// How far to push the shadow square ahead of the car in `view` (horizontal,
// unit length). Along the sun direction the square covers much more ground
// than across it, so the push depends on the angle between view and sun: when
// driving across the sun it stays small, when driving towards or away from the
// sun the covered area reaches far ahead. Every mustCover point has to stay
// inside the square, which bounds the push from above.
function shadowLookAhead(view: THREE.Vector3): number {
    const { mustCover, lookAhead } = LIGHTING.shadow;
    _side.set(-view.z, 0, view.x);
    const viewX = view.dot(_lightX);
    const viewY = view.dot(_lightY);
    let limit = lookAhead.max;
    for (const [forward, sideways] of mustCover) {
        for (const sign of [-1, 1]) {
            // Light-space position of the point relative to the car
            const px = forward * viewX + sign * sideways * _side.dot(_lightX);
            const py = forward * viewY + sign * sideways * _side.dot(_lightY);
            // Inside while |p - d * view| <= halfExtent on both axes
            if (viewX > 1e-4) limit = Math.min(limit, (px + shadowHalfExtent) / viewX);
            else if (viewX < -1e-4) limit = Math.min(limit, (px - shadowHalfExtent) / viewX);
            if (viewY > 1e-4) limit = Math.min(limit, (py + shadowHalfExtent) / viewY);
            else if (viewY < -1e-4) limit = Math.min(limit, (py - shadowHalfExtent) / viewY);
        }
    }
    return Math.max(lookAhead.min, limit);
}

// Moves sun and shadow camera over `focus`, snapped to whole shadow texels in
// the light's view plane, so static shadow edges do not crawl as the car moves.
function placeSun(focus: THREE.Vector3): void {
    if (!sun) return;
    const x = Math.round(focus.dot(_lightX) / shadowTexel) * shadowTexel;
    const y = Math.round(focus.dot(_lightY) / shadowTexel) * shadowTexel;
    const z = focus.dot(SUN_DIRECTION);
    _snapped.copy(_lightX).multiplyScalar(x)
        .addScaledVector(_lightY, y)
        .addScaledVector(SUN_DIRECTION, z);
    sun.target.position.copy(_snapped);
    sun.position.copy(_snapped).addScaledVector(SUN_DIRECTION, LIGHTING.shadow.distance);
    sun.target.updateMatrixWorld();
}

// --- Shadow lookup --------------------------------------------------------------

const SHADOW_PATCH_MARKER = '// bulli: shadow edge fade';

/**
 * Two changes to three's lookup of the directional (sun) shadow, patched into
 * the shared lights chunk before any material compiles:
 * - Shadows fade out towards the border of the shadow map instead of ending
 *   at a hard line (the only shadow-casting light is the sun).
 * - Materials that define BULLI_GRAZING_SHADOW_FADE (the terrain) drop the
 *   shadow where the sun only grazes the surface, and fade it out with
 *   distance. The terrain casts no shadow itself, so without this, tree
 *   shadows on slopes facing away from the low sun become long, dark streaks
 *   on otherwise lit grass, and on distant, hazy hills they look like dark
 *   tree silhouettes hanging in the air.
 * Both work on the result of getShadow() at its call site, so they do not
 * depend on the filter (PCF, VSM, basic) that three compiles for it.
 */
export function patchShadowChunks(): boolean {
    const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
    if (chunks.lights_fragment_begin.includes(SHADOW_PATCH_MARKER)) return true;

    const directional = 'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;';
    if (!chunks.lights_fragment_begin.includes(directional)) {
        console.warn('lighting: shadow chunk changed, shadow edge and grazing fade disabled');
        return false;
    }
    chunks.lights_fragment_begin = chunks.lights_fragment_begin.replace(
        directional,
        /* glsl */`{
			${SHADOW_PATCH_MARKER}
			float bulliShadow = ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
			vec2 bulliShadowUv = vDirectionalShadowCoord[ i ].xy / vDirectionalShadowCoord[ i ].w;
			vec2 bulliShadowEdge = min( bulliShadowUv, 1.0 - bulliShadowUv );
			bulliShadow = mix( 1.0, bulliShadow, smoothstep( 0.0, ${LIGHTING.shadow.edgeFade.toFixed(3)}, min( bulliShadowEdge.x, bulliShadowEdge.y ) ) );
			#ifdef BULLI_GRAZING_SHADOW_FADE
			bulliShadow = mix( 1.0, bulliShadow, smoothstep( 0.05, 0.3, dot( geometryNormal, directLight.direction ) ) );
			bulliShadow = mix( bulliShadow, 1.0, smoothstep( ${LIGHTING.terrainShadowFade.start.toFixed(1)}, ${LIGHTING.terrainShadowFade.end.toFixed(1)}, length( vViewPosition ) ) );
			#endif
			directLight.color *= bulliShadow;
		}`
    );
    return true;
}

const SHADOW_FILTER_MARKER = '// bulli: 3x3 PCF';

/**
 * Replaces the five taps of three's PCF (a Vogel disk rotated per pixel by
 * interleaved gradient noise) with a 3 x 3 grid of hardware-filtered
 * lookups one texel apart. That is the penumbra of r160's PCFSoftShadowMap
 * the look was tuned on: smooth, where the rotated disk leaves a grainy
 * dither along every shadow edge (there is no temporal filter to hide it).
 */
export function patchShadowFilter(): boolean {
    const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
    if (chunks.shadowmap_pars_fragment.includes(SHADOW_FILTER_MARKER)) return true;
    // The sampling expression of getShadow() in the PCF branch
    const vogel = /shadow = \(\s*texture\( shadowMap, vec3\( shadowCoord\.xy \+ vogelDiskSample\( 0, 5, phi \) \* radius, shadowCoord\.z \) \)[\s\S]*?\) \* 0\.2;/;
    if (!vogel.test(chunks.shadowmap_pars_fragment)) {
        console.warn('lighting: PCF shadow chunk changed, shadow filter not patched');
        return false;
    }
    chunks.shadowmap_pars_fragment = chunks.shadowmap_pars_fragment.replace(vogel, /* glsl */`${SHADOW_FILTER_MARKER}
				shadow = 0.0;
				for ( int bx = - 1; bx <= 1; bx ++ ) {
					for ( int by = - 1; by <= 1; by ++ ) {
						shadow += texture( shadowMap, vec3( shadowCoord.xy + vec2( float( bx ), float( by ) ) * texelSize * shadowRadius, shadowCoord.z ) );
					}
				}
				shadow *= 1.0 / 9.0;`);
    return true;
}

// --- Reflection direction ------------------------------------------------------

const REFLECTION_PATCH_MARKER = '// bulli: reflection bend';

/**
 * Keeps the bend of the environment reflection towards the normal at
 * roughness^2, as in three r160 (r186 bends by roughness^4, as Filament).
 * The look (look.ts) and the per-material envMapIntensity values were tuned
 * on it: with the weaker bend, rough surfaces seen at a grazing angle mirror
 * the bright horizon, so the palm crowns got a pale sheen and the road
 * markings lost their sunset gloss.
 */
export function patchReflectionBend(): boolean {
    const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
    if (chunks.envmap_physical_pars_fragment.includes(REFLECTION_PATCH_MARKER)) return true;
    const bend = 'reflectVec = normalize( mix( reflectVec, normal, pow4( roughness ) ) );';
    if (!chunks.envmap_physical_pars_fragment.includes(bend)) {
        console.warn('lighting: environment reflection chunk changed, reflection bend not patched');
        return false;
    }
    chunks.envmap_physical_pars_fragment = chunks.envmap_physical_pars_fragment.replace(
        bend,
        `${REFLECTION_PATCH_MARKER}\n\t\t\treflectVec = normalize( mix( reflectVec, normal, pow2( roughness ) ) );`
    );
    return true;
}

// --- Contact shadows --------------------------------------------------------

const MAX_CONTACT_SHADOWS = 32;
// Body footprint (width x length) per car type, see CarModel.build*()
const CAR_FOOTPRINT: Record<string, [number, number]> = {
    bulli: [2.8, 4.0],
    pickup: [3.0, 5.0],
    sport: [2.6, 4.5],
    beetle: [2.4, 3.5],
    jeep: [3.0, 4.2]
};
const DEFAULT_FOOTPRINT: [number, number] = [2.8, 4.2];

let contactShadows: THREE.InstancedMesh | null = null;
let contactOpacity: THREE.InstancedBufferAttribute | null = null;
const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _scale = new THREE.Vector3();

function initContactShadows(scene: THREE.Scene): void {
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    contactOpacity = new THREE.InstancedBufferAttribute(new Float32Array(MAX_CONTACT_SHADOWS), 1);
    contactOpacity.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('blobOpacity', contactOpacity);

    const material = new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.merge([
            THREE.UniformsLib.fog,
            { uColor: { value: new THREE.Color(LIGHTING.contactShadow.color) } }
        ]),
        vertexShader: /* glsl */`
            attribute float blobOpacity;
            varying float vOpacity;
            varying vec2 vUv;
            #include <fog_pars_vertex>

            void main() {
                vUv = uv;
                vOpacity = blobOpacity;
                vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
                gl_Position = projectionMatrix * mvPosition;
                #include <fog_vertex>
            }
        `,
        fragmentShader: /* glsl */`
            uniform vec3 uColor;
            varying float vOpacity;
            varying vec2 vUv;
            #include <fog_pars_fragment>

            void main() {
                // Rounded rectangle (superellipse) that matches a car body
                // better than a circle, dark up to the body edge, then soft
                vec2 p = abs(vUv * 2.0 - 1.0);
                p *= p;
                float r = sqrt(sqrt(dot(p, p)));
                float falloff = 1.0 - smoothstep(0.55, 1.0, r);
                gl_FragColor = vec4(uColor, vOpacity * falloff);
                #include <colorspace_fragment>
                #include <fog_fragment>
            }
        `,
        transparent: true,
        depthWrite: false,
        fog: true
    });

    contactShadows = new THREE.InstancedMesh(geometry, material, MAX_CONTACT_SHADOWS);
    contactShadows.name = 'contact-shadows';
    contactShadows.count = 0;
    contactShadows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    contactShadows.frustumCulled = false;
    // Before other transparent objects (particles, shields)
    contactShadows.renderOrder = -1;
    scene.add(contactShadows);
}

/**
 * The contact shadow of a car whose wheels are `lift` m over the ground:
 * its opacity and size relative to standing. It gets paler and smaller as
 * the car rises (the car leaves its shadow behind on the ground), gone at
 * about 10 m; on the ground and on the springs it stays whole.
 */
export function contactShadowLook(lift: number): { fade: number; size: number } {
    const h = Math.max(0, lift);
    return { fade: 1 / (1 + h * 0.6 + h * h * 0.05), size: 1 - 0.4 * h / (h + 3) };
}

function writeContactShadow(index: number, car: any): boolean {
    const bodyGroup: THREE.Object3D = car.bodyGroup;
    if (!bodyGroup?.visible) return false;
    const group: THREE.Object3D = car.group;

    // Paler and smaller while the car is in the air (vehicle/bodyMotion.ts
    // sets the height of the wheels over the ground)
    const look = contactShadowLook(car.airHeight ?? 0);
    const ghostFade = car.powerups?.ghost?.active ? 0.2 : 1;
    const opacity = LIGHTING.contactShadow.opacity * look.fade * ghostFade;
    if (opacity < 0.01) return false;

    // The car model knows its body size (GLB or procedural)
    const [width, length] = car.footprint ?? CAR_FOOTPRINT[car.carType] ?? DEFAULT_FOOTPRINT;
    const spread = LIGHTING.contactShadow.spread * (group.scale.x || 1) * look.size;
    // Just above road markings and curbs, tilted with the car on slopes
    _position.copy(group.position);
    _position.y += 0.1;
    _scale.set(width * spread, 1, length * spread);
    _matrix.compose(_position, group.quaternion, _scale);
    contactShadows!.setMatrixAt(index, _matrix);
    contactOpacity!.setX(index, opacity);
    return true;
}

// --- Shield rim ---------------------------------------------------------------

const rimShields = new WeakSet<THREE.Material>();

/**
 * Turns the car's shield bubble into a Fresnel rim: nearly clear over the car,
 * a saturated cyan edge at the silhouette plus a little additive glow. The
 * material stays a MeshStandardMaterial, so the existing
 * opacity/emissiveIntensity animation in main.ts, Bulli.ts and websocket.ts
 * keeps driving it.
 *
 * Blending is premultiplied (ONE, ONE_MINUS_SRC_ALPHA): the rim covers the
 * background with cyan instead of only adding to it, so it stays cyan over
 * the bright, warm sky and facades (pure additive blending turned it white).
 * Fog fades the whole contribution out rather than mixing in the fog color,
 * which would otherwise add a bright disc for far-away cars.
 */
function applyShieldRim(material: THREE.Material): void {
    if (rimShields.has(material)) return;
    rimShields.add(material);
    material.transparent = true;
    material.depthWrite = false;
    material.side = THREE.FrontSide;
    material.blending = THREE.CustomBlending;
    material.blendEquation = THREE.AddEquation;
    material.blendSrc = THREE.OneFactor;
    material.blendDst = THREE.OneMinusSrcAlphaFactor;
    material.premultipliedAlpha = false;
    // The rim color is used as is (tone mapping would wash out the cyan)
    material.toneMapped = false;
    material.onBeforeCompile = shader => {
        shader.fragmentShader = shader.fragmentShader
            .replace(
                '#include <opaque_fragment>',
                /* glsl */`
float shieldFacing = abs(dot(normalize(normal), normalize(vViewPosition)));
float shieldRim = pow(1.0 - shieldFacing, 2.0);
vec3 shieldColor = diffuseColor.rgb + totalEmissiveRadiance;
// Keep the hue, but no channel above 1 (the colors are not tone mapped)
shieldColor /= max(1.0, max(shieldColor.r, max(shieldColor.g, shieldColor.b)));
float shieldCover = clamp(diffuseColor.a * (0.15 + shieldRim * 2.4), 0.0, 0.85);
float shieldGlow = diffuseColor.a * shieldRim * (0.6 + length(totalEmissiveRadiance));
gl_FragColor = vec4(shieldColor, shieldCover);`
            )
            .replace(
                '#include <fog_fragment>',
                /* glsl */`
// Premultiply (after the color space conversion) and add the glow
gl_FragColor.rgb *= gl_FragColor.a + shieldGlow;
#ifdef USE_FOG
    #ifdef FOG_EXP2
        float shieldFog = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
        float shieldFog = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    gl_FragColor *= 1.0 - shieldFog;
#endif`
            );
    };
    material.customProgramCacheKey = () => 'bulli-shield-rim-v2';
    material.needsUpdate = true;
}

function updateCars(): void {
    let count = 0;
    const visit = (car: any) => {
        if (!car?.group) return;
        const shield: THREE.Mesh | undefined = car.shieldMesh;
        if (shield) applyShieldRim(shield.material as THREE.Material);
        if (contactShadows && count < MAX_CONTACT_SHADOWS && writeContactShadow(count, car)) count++;
    };
    visit(state.bulli);
    for (const id in state.remotePlayers) visit(state.remotePlayers[id]);
    // Sandbox dummies (?sandbox=1)
    for (const model of gameHooks.extraModels) visit(model);

    if (!contactShadows) return;
    contactShadows.count = count;
    if (count > 0) {
        contactShadows.instanceMatrix.needsUpdate = true;
        contactOpacity!.needsUpdate = true;
    }
}
