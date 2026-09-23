import * as THREE from 'three';
import { state } from '../state.js';
import { detectRenderTier } from '../effects/renderQuality.js';
import { SKY_COLORS, createSkyDome, createSkyEnvironment, updateSkyDome } from './sky.js';

// Sunset lighting: ACES tone mapping, a low warm sun with a shadow camera that
// follows the car, a warm hemisphere fill and the gradient sky (dome, fog and
// environment map).
// main.ts only calls setupLighting() once and updateLighting() every frame.

export const LIGHTING = {
    exposure: 0.95,
    sunColor: 0xffe0b8,
    sunIntensity: 3.2,
    // Degrees above the horizon, and the compass direction the sun shines
    // from (0 = +z, 90 = +x). A low sun gives long, readable shadows.
    sunElevation: 22,
    sunAzimuth: 67,
    hemiSkyColor: 0xffe3c6,
    hemiGroundColor: 0x6b5842,
    hemiIntensity: 0.35,
    // Brightness of the sky in the environment map (diffuse fill + reflections)
    environmentIntensity: 0.65,
    fogNear: 70,
    fogFar: 340,
    shadow: {
        // Half size of the square the shadow map covers, in meters
        halfExtent: 45,
        // The covered square is shifted this far ahead in the view direction,
        // where the chase camera sees more ground than behind the car.
        lookAhead: 15,
        // Distance of the light from the covered center along the sun direction
        distance: 150,
        near: 1,
        far: 250,
        bias: -0.0004,
        normalBias: 0.03,
        mapSize: { desktop: 2048, mobile: 1024 }
    },
};

// Unit vector pointing from the scene towards the sun
export const SUN_DIRECTION = new THREE.Vector3();
{
    const elevation = THREE.MathUtils.degToRad(LIGHTING.sunElevation);
    const azimuth = THREE.MathUtils.degToRad(LIGHTING.sunAzimuth);
    SUN_DIRECTION.set(
        Math.sin(azimuth) * Math.cos(elevation),
        Math.sin(elevation),
        Math.cos(azimuth) * Math.cos(elevation)
    ).normalize();
}

// Shadow camera basis (see Matrix4.lookAt): texel snapping works in these axes
const _lightX = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), SUN_DIRECTION).normalize();
const _lightY = new THREE.Vector3().crossVectors(SUN_DIRECTION, _lightX);

let sun: THREE.DirectionalLight | null = null;
let skyDome: THREE.Mesh | null = null;
let shadowTexel = 0;

const _focus = new THREE.Vector3();
const _viewDirection = new THREE.Vector3();
const _snapped = new THREE.Vector3();

/**
 * Configures tone mapping, sky, fog, environment and lights. Call once after
 * the renderer exists.
 */
export function setupLighting(scene: THREE.Scene, renderer: THREE.WebGLRenderer): void {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = LIGHTING.exposure;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Sky, fog and clear color share the horizon color
    scene.background = new THREE.Color(SKY_COLORS.horizon);
    scene.fog = new THREE.Fog(SKY_COLORS.horizon, LIGHTING.fogNear, LIGHTING.fogFar);
    skyDome = createSkyDome(SUN_DIRECTION);
    scene.add(skyDome);
    scene.environment = createSkyEnvironment(renderer, SUN_DIRECTION, LIGHTING.environmentIntensity);
    // A lost context takes the rendered environment map with it; three.js
    // restores its own state first (its listener was registered earlier).
    renderer.domElement.addEventListener('webglcontextrestored', () => {
        scene.environment?.dispose();
        scene.environment = createSkyEnvironment(renderer, SUN_DIRECTION, LIGHTING.environmentIntensity);
    });

    // No flat ambient term: the hemisphere and the environment map fill the
    // shadows with sky and ground colors instead.
    scene.add(new THREE.HemisphereLight(LIGHTING.hemiSkyColor, LIGHTING.hemiGroundColor, LIGHTING.hemiIntensity));

    const shadow = LIGHTING.shadow;
    sun = new THREE.DirectionalLight(LIGHTING.sunColor, LIGHTING.sunIntensity);
    sun.castShadow = true;
    const mapSize = shadow.mapSize[detectRenderTier()];
    sun.shadow.mapSize.set(mapSize, mapSize);
    const camera = sun.shadow.camera;
    camera.left = -shadow.halfExtent;
    camera.right = shadow.halfExtent;
    camera.top = shadow.halfExtent;
    camera.bottom = -shadow.halfExtent;
    camera.near = shadow.near;
    camera.far = shadow.far;
    camera.updateProjectionMatrix();
    sun.shadow.bias = shadow.bias;
    sun.shadow.normalBias = shadow.normalBias;
    shadowTexel = (2 * shadow.halfExtent) / mapSize;
    scene.add(sun);
    scene.add(sun.target);
    placeSun(_focus.set(0, 0, 0));
}

/**
 * Per-frame update before rendering: sky dome and shadow camera follow the view.
 */
export function updateLighting(): void {
    const camera = state.camera;
    if (!camera || !sun) return;
    if (skyDome) updateSkyDome(skyDome, camera);

    if (state.bulli) _focus.copy(state.bulli.group.position);
    else _focus.copy(camera.position).setY(0);
    camera.getWorldDirection(_viewDirection).setY(0);
    if (_viewDirection.lengthSq() > 1e-6) {
        _focus.addScaledVector(_viewDirection.normalize(), LIGHTING.shadow.lookAhead);
    }
    placeSun(_focus);
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
