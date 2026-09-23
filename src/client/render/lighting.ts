import * as THREE from 'three';
import { state } from '../state.js';
import { detectRenderTier } from '../effects/renderQuality.js';
import { SKY_COLORS, createSkyDome, createSkyEnvironment, updateSkyDome } from './sky.js';

// Sunset lighting: ACES tone mapping, a low warm sun with a shadow camera that
// follows the car, a warm hemisphere fill, the gradient sky (dome, fog and
// environment map), soft contact shadows under every car and the shield rim.
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
    contactShadow: {
        opacity: 0.7,
        // Footprint growth over the car's body
        spread: 1.5,
        color: 0x1d130c
    }
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
        _focus.addScaledVector(_viewDirection.normalize(), LIGHTING.shadow.lookAhead);
    }
    placeSun(_focus);

    updateCars();
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

// --- Contact shadows --------------------------------------------------------

const MAX_CONTACT_SHADOWS = 32;
// Body footprint (width x length) per car type, see Bulli.build*()
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

function writeContactShadow(index: number, car: any): boolean {
    const flipGroup: THREE.Object3D = car.flipGroup;
    if (!flipGroup?.visible) return false;
    const group: THREE.Object3D = car.group;

    // Fade and widen the shadow while the car is in the air
    const lift = Math.max(0, flipGroup.position.y);
    const airFade = 1 / (1 + lift * 0.45);
    const ghostFade = car.powerups?.ghost?.active ? 0.2 : 1;
    const opacity = LIGHTING.contactShadow.opacity * airFade * ghostFade;
    if (opacity < 0.01) return false;

    const [width, length] = CAR_FOOTPRINT[car.carType] ?? DEFAULT_FOOTPRINT;
    const spread = LIGHTING.contactShadow.spread * (group.scale.x || 1) * (1 + lift * 0.06);
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
 * Turns the car's shield bubble into an additive Fresnel rim: nearly clear
 * over the car, glowing at the silhouette. The material stays a
 * MeshStandardMaterial, so the existing opacity/emissiveIntensity animation
 * in main.ts, Bulli.ts and websocket.ts keeps driving it.
 */
function applyShieldRim(material: THREE.Material): void {
    if (rimShields.has(material)) return;
    rimShields.add(material);
    material.transparent = true;
    material.depthWrite = false;
    material.side = THREE.FrontSide;
    material.blending = THREE.AdditiveBlending;
    // Clamp instead of tone mapping keeps the glow cyan rather than white
    material.toneMapped = false;
    material.onBeforeCompile = shader => {
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <opaque_fragment>',
            /* glsl */`
float shieldFacing = abs(dot(normalize(normal), normalize(vViewPosition)));
float shieldRim = pow(1.0 - shieldFacing, 2.0);
vec3 shieldGlow = diffuseColor.rgb + totalEmissiveRadiance;
gl_FragColor = vec4(shieldGlow * (0.04 + shieldRim * 1.5), diffuseColor.a);`
        );
    };
    material.customProgramCacheKey = () => 'bulli-shield-rim-v1';
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

    if (!contactShadows) return;
    contactShadows.count = count;
    if (count > 0) {
        contactShadows.instanceMatrix.needsUpdate = true;
        contactOpacity!.needsUpdate = true;
    }
}
