import * as THREE from 'three';

// Sunset sky: one gradient dome (a single draw call) that also feeds the
// PMREM environment map, so reflections and ambient light share its colors.
// The horizon color is also the fog color, which makes distant terrain and
// the city edge dissolve into the sky without a visible seam.

export const SKY_COLORS = {
    zenith: 0x4a78b8,
    upper: 0x8fb3dc,
    lower: 0xf7d2b2,
    horizon: 0xffc9a0,
    // Lower half of the environment map (the visible dome keeps the fog color there)
    ground: 0x6e5c4a,
    // Tint of the glow around the sun disc
    sunGlow: 0xffb070,
    sunCore: 0xfff1d6
};

// All sky colors are sRGB hex; three converts them to linear working space.
function linear(hex: number): THREE.Color {
    return new THREE.Color(hex);
}

const vertexShader = /* glsl */`
varying vec3 vSkyDirection;

void main() {
    // Object space direction: the dome is centered on the camera (or on the
    // cube camera of the PMREM pass), so this is the view direction.
    vSkyDirection = position;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    // On the far plane: drawn after the opaque scene, the depth test then
    // skips every pixel that is already covered, so only visible sky is shaded
    gl_Position.z = gl_Position.w;
}
`;

const fragmentShader = /* glsl */`
uniform vec3 uZenith;
uniform vec3 uUpper;
uniform vec3 uLower;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform float uGroundMix;
uniform vec3 uSunGlow;
uniform vec3 uSunCore;
uniform vec3 uSunDirection;
uniform float uIntensity;
uniform float uSunDisc;
varying vec3 vSkyDirection;

void main() {
    vec3 direction = normalize(vSkyDirection);
    float h = direction.y;

    // Below the horizon the dome is exactly the fog color; the environment
    // map fades to a darker ground instead
    vec3 color = mix(uHorizon, uGround, smoothstep(0.0, -0.2, h) * uGroundMix);
    if (h > 0.0) {
        color = mix(uHorizon, uLower, smoothstep(0.0, 0.10, h));
        color = mix(color, uUpper, smoothstep(0.08, 0.42, h));
        color = mix(color, uZenith, smoothstep(0.38, 1.0, h));
    }

    // Warm glow around the sun, faded out towards the horizon so the fogged
    // scenery still meets exactly the fog color there
    float sunDot = max(dot(direction, uSunDirection), 0.0);
    float horizonFade = smoothstep(-0.02, 0.10, h);
    float glow = pow(sunDot, 6.0) * 0.55 + pow(sunDot, 48.0) * 0.6;
    color = mix(color, uSunGlow, clamp(glow, 0.0, 1.0) * horizonFade);
    // Broad warm band along the horizon on the sun side
    float sunSide = pow(max(dot(normalize(direction.xz + 1e-5), normalize(uSunDirection.xz)), 0.0), 3.0);
    float band = (1.0 - smoothstep(0.0, 0.3, h)) * smoothstep(-0.01, 0.04, h);
    color = mix(color, uSunGlow, sunSide * band * 0.35);
    color += uSunCore * smoothstep(0.9993, 0.9998, sunDot) * uSunDisc;

    gl_FragColor = vec4(color * uIntensity, 1.0);
    #include <colorspace_fragment>
}
`;

export interface SkyOptions {
    sunDirection: THREE.Vector3;
    // Brightness multiplier (the environment pass uses a dimmer sky)
    intensity?: number;
    // Brightness of the sun disc (0 hides it)
    sunDisc?: number;
    // 1 fades the lower hemisphere to the ground color (environment map)
    groundMix?: number;
}

export function createSkyMaterial(options: SkyOptions): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
        uniforms: {
            uZenith: { value: linear(SKY_COLORS.zenith) },
            uUpper: { value: linear(SKY_COLORS.upper) },
            uLower: { value: linear(SKY_COLORS.lower) },
            uHorizon: { value: linear(SKY_COLORS.horizon) },
            uGround: { value: linear(SKY_COLORS.ground) },
            uGroundMix: { value: options.groundMix ?? 0 },
            uSunGlow: { value: linear(SKY_COLORS.sunGlow) },
            uSunCore: { value: linear(SKY_COLORS.sunCore) },
            uSunDirection: { value: options.sunDirection.clone().normalize() },
            uIntensity: { value: options.intensity ?? 1 },
            uSunDisc: { value: options.sunDisc ?? 1 }
        },
        vertexShader,
        fragmentShader,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        // The sky is already display-referred: at the horizon it has to match
        // the fog color, which three.js mixes in after tone mapping.
        toneMapped: false
    });
}

/**
 * Sky dome for the scene. It follows the camera (see updateSkyDome) and is
 * drawn after all other opaque objects, on the far plane.
 */
export function createSkyDome(sunDirection: THREE.Vector3): THREE.Mesh {
    const dome = new THREE.Mesh(
        new THREE.SphereGeometry(1, 32, 16),
        createSkyMaterial({ sunDirection })
    );
    dome.name = 'sky-dome';
    // Inside the camera's far plane (the shader moves it onto the far plane)
    dome.scale.setScalar(500);
    dome.renderOrder = 1000;
    dome.frustumCulled = false;
    dome.matrixAutoUpdate = false;
    return dome;
}

export function updateSkyDome(dome: THREE.Mesh, camera: THREE.Camera): void {
    dome.position.copy(camera.position);
    dome.updateMatrix();
}

/**
 * Prefiltered environment map of the same sky, generated once. Intensity is
 * baked in (three r160 has no scene.environmentIntensity).
 */
export function createSkyEnvironment(
    renderer: THREE.WebGLRenderer,
    sunDirection: THREE.Vector3,
    intensity: number
): THREE.Texture {
    const skyScene = new THREE.Scene();
    const geometry = new THREE.SphereGeometry(1, 32, 16);
    const material = createSkyMaterial({ sunDirection, intensity, sunDisc: 0, groundMix: 1 });
    const dome = new THREE.Mesh(geometry, material);
    dome.scale.setScalar(50);
    skyScene.add(dome);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const target = pmrem.fromScene(skyScene, 0.02, 0.1, 100);
    pmrem.dispose();
    geometry.dispose();
    material.dispose();
    return target.texture;
}
