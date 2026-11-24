import * as THREE from 'three';
import type { RewardEffect } from '../../shared/map/discoverySchema.js';
import { SURFACE } from '../../shared/map/types.js';
import { state } from '../state.js';

const MAX_PARTICLES = 320;
const EXPLOSION_COLORS = [0x333333, 0x555555, 0xFF4400, 0xFF6600];
const FIRE_COLORS = [0xFF4500, 0xFF6600, 0xFFAA00, 0xFF2200, 0xFFDD00];
const DRIFT_SPARK_PALETTES: Record<1 | 2 | 3, readonly number[]> = {
    1: [0x38BDF8, 0x7DD3FC, 0xFACC15],
    2: [0xFF7B00, 0xFF9E00, 0xFFD166],
    3: [0xE879F9, 0xA855F7, 0xFEF08A, 0xFFFFFF]
};
const REWARD_PALETTES: Record<RewardEffect, readonly number[]> = {
    sparks: [0xFF6A24, 0xFFB703, 0xFFE699, 0xFFFFFF],
    confetti: [0xFF4D6D, 0x22D3EE, 0xFACC15, 0x4ADE80, 0xA855F7],
    bubbles: [0x7DD3FC, 0xBAE6FD, 0xE0F2FE, 0x38BDF8],
    runes: [0xC084FC, 0x818CF8, 0xFDE047, 0x38BDF8],
    music: [0xF43F5E, 0xFB923C, 0xFACC15, 0xA855F7],
    laser: [0x22D3EE, 0x34D399, 0xEF4444, 0xFFFFFF],
    flash: [0xFFFFFF, 0xFEF08A, 0xFDE68A, 0xBAE6FD],
    shockwave: [0xFF6A24, 0x22D3EE, 0xFFFFFF, 0xFACC15]
};

interface Particle {
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
    life: number;
    decay: number;
    initialScale: number;
    initialOpacity: number;
    color: number;
    // Smoke puffs grow while they fade instead of shrinking
    grows?: boolean;
    followTarget: THREE.Object3D | null;
    localX: number;
    localY: number;
    localZ: number;
}

let particleMesh: THREE.InstancedMesh | null = null;
let colorAttribute: THREE.InstancedBufferAttribute | null = null;
let opacityAttribute: THREE.InstancedBufferAttribute | null = null;

const scratchMatrix = new THREE.Matrix4();
const scratchPosition = new THREE.Vector3();
const scratchScale = new THREE.Vector3();
const scratchRotation = new THREE.Quaternion();
const scratchColor = new THREE.Color();

// Soft round sprites are drawn a bit larger than the cubes they replaced, so a
// puff covers about the same area.
const SPRITE_SIZE = 1.6;

function ensureParticleBatch(): THREE.InstancedMesh {
    if (!particleMesh) {
        // Camera-facing quads (billboarded in the vertex shader) with a soft
        // radial falloff: one draw call for all particles, as before.
        const geometry = new THREE.PlaneGeometry(SPRITE_SIZE, SPRITE_SIZE);
        colorAttribute = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3);
        opacityAttribute = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES), 1);
        colorAttribute.setUsage(THREE.DynamicDrawUsage);
        opacityAttribute.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute('particleColor', colorAttribute);
        geometry.setAttribute('particleOpacity', opacityAttribute);

        const material = new THREE.ShaderMaterial({
            uniforms: THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
            vertexShader: `
                attribute vec3 particleColor;
                attribute float particleOpacity;
                varying vec3 vParticleColor;
                varying float vParticleOpacity;
                varying vec2 vParticleUv;
                #include <fog_pars_vertex>

                void main() {
                    vParticleColor = particleColor;
                    vParticleOpacity = particleOpacity;
                    vParticleUv = uv;
                    // Billboard: offset the corners in view space around the
                    // instance center, scaled by the instance scale.
                    float particleScale = length(instanceMatrix[0].xyz);
                    vec4 mvPosition = modelViewMatrix * vec4(instanceMatrix[3].xyz, 1.0);
                    mvPosition.xy += position.xy * particleScale;
                    gl_Position = projectionMatrix * mvPosition;
                    #include <fog_vertex>
                }
            `,
            fragmentShader: `
                varying vec3 vParticleColor;
                varying float vParticleOpacity;
                varying vec2 vParticleUv;
                #include <fog_pars_fragment>

                void main() {
                    float r = length(vParticleUv * 2.0 - 1.0);
                    float falloff = 1.0 - smoothstep(0.1, 1.0, r);
                    if (falloff <= 0.0) discard;
                    gl_FragColor = vec4(vParticleColor, vParticleOpacity * falloff * falloff);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                    #include <fog_fragment>
                }
            `,
            transparent: true,
            depthWrite: false,
            fog: true
        });

        particleMesh = new THREE.InstancedMesh(geometry, material, MAX_PARTICLES);
        particleMesh.count = 0;
        particleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        particleMesh.frustumCulled = false;
    }

    if (particleMesh.parent !== state.scene) state.scene.add(particleMesh);
    return particleMesh;
}

function writeParticleInstance(index: number, particle: Particle, scale: number, opacity: number): void {
    const mesh = ensureParticleBatch();
    scratchPosition.set(particle.x, particle.y, particle.z);
    scratchScale.set(scale, scale, scale);
    scratchMatrix.compose(scratchPosition, scratchRotation, scratchScale);
    mesh.setMatrixAt(index, scratchMatrix);

    scratchColor.setHex(particle.color);
    colorAttribute!.setXYZ(index, scratchColor.r, scratchColor.g, scratchColor.b);
    opacityAttribute!.setX(index, opacity);
}

function addParticle(particle: Particle): void {
    if (state.particles.length >= MAX_PARTICLES) return;
    const index = state.particles.length;
    state.particles.push(particle);
    writeParticleInstance(index, particle, particle.initialScale, particle.initialOpacity);
    particleMesh!.count = state.particles.length;
    particleMesh!.instanceMatrix.needsUpdate = true;
    colorAttribute!.needsUpdate = true;
    opacityAttribute!.needsUpdate = true;
}

export function spawnParticles(x: number, y: number, z: number, color: number, count: number, size = 0.4, spread = 1.0, speed = 0.5) {
    for (let i = 0; i < count; i++) {
        if (state.particles.length >= MAX_PARTICLES) return;

        const vx = (Math.random() - 0.5) * spread;
        const vy = (Math.random() * 0.5 + 0.2) * speed * 2;
        const vz = (Math.random() - 0.5) * spread;

        addParticle({
            x, y, z,
            vx, vy, vz,
            life: 1.0,
            decay: 0.02 + Math.random() * 0.03,
            initialScale: size,
            initialOpacity: 1,
            color,
            followTarget: null,
            localX: 0,
            localY: 0,
            localZ: 0
        });
    }
}

export function spawnFollowingParticle(target: THREE.Object3D, localOffset: THREE.Vector3, color: number, size: number) {
    if (state.particles.length >= MAX_PARTICLES) return;

    scratchPosition.copy(localOffset);
    target.localToWorld(scratchPosition);

    addParticle({
        x: scratchPosition.x,
        y: scratchPosition.y,
        z: scratchPosition.z,
        vx: (Math.random() - 0.5) * 0.1,
        vy: Math.random() * 0.1,
        vz: (Math.random() - 0.5) * 0.1,
        life: 1.0,
        decay: 0.03 + Math.random() * 0.02,
        initialScale: size,
        initialOpacity: 0.8,
        color,
        followTarget: target,
        localX: localOffset.x,
        localY: localOffset.y,
        localZ: localOffset.z
    });
}

export function updateParticles(dt: number) {
    const frame = dt * 60;
    let i = 0;
    while (i < state.particles.length) {
        const p = state.particles[i] as Particle;
        p.life -= p.decay * frame;

        if (p.life <= 0) {
            const last = state.particles.length - 1;
            if (i < last) state.particles[i] = state.particles[last];
            state.particles.pop();
            continue;
        }

        if (p.followTarget) {
            scratchPosition.set(p.localX, p.localY, p.localZ);
            p.followTarget.localToWorld(scratchPosition);

            p.localX += p.vx * frame * 0.5;
            p.localY += p.vy * frame * 0.5;
            p.localZ += p.vz * frame * 0.5;
            p.vy += 0.005 * frame;

            p.x = scratchPosition.x;
            p.y = scratchPosition.y;
            p.z = scratchPosition.z;
        } else {
            p.x += p.vx * frame;
            p.y += p.vy * frame;
            p.z += p.vz * frame;
            p.vy -= 0.02 * frame;
        }

        const scale = p.grows ? p.initialScale * (2.2 - 1.2 * p.life) : p.initialScale * p.life;
        writeParticleInstance(i, p, scale, p.initialOpacity * p.life);
        i++;
    }

    if (!particleMesh) return;
    particleMesh.count = state.particles.length;
    if (particleMesh.count > 0) {
        particleMesh.instanceMatrix.needsUpdate = true;
        colorAttribute!.needsUpdate = true;
        opacityAttribute!.needsUpdate = true;
    }
}

export function spawnExplosion(x: number, y: number, z: number, color: number) {
    const count = 25;

    for (let i = 0; i < count; i++) {
        if (state.particles.length >= MAX_PARTICLES) return;
        const colorIndex = Math.floor(Math.random() * (EXPLOSION_COLORS.length + 1));
        const particleColor = colorIndex === 0 ? color : EXPLOSION_COLORS[colorIndex - 1];
        const size = 0.3 + Math.random() * 0.5;
        const particleX = x + (Math.random() - 0.5) * 2;
        const particleY = y + 1 + Math.random() * 2;
        const particleZ = z + (Math.random() - 0.5) * 2;
        const angle = Math.random() * Math.PI * 2;
        const particleSpeed = 0.2 + Math.random() * 0.4;

        addParticle({
            x: particleX,
            y: particleY,
            z: particleZ,
            vx: Math.cos(angle) * particleSpeed,
            vy: 0.2 + Math.random() * 0.4,
            vz: Math.sin(angle) * particleSpeed,
            life: 1.0,
            decay: 0.015 + Math.random() * 0.015,
            initialScale: size,
            initialOpacity: 1,
            color: particleColor,
            followTarget: null,
            localX: 0,
            localY: 0,
            localZ: 0
        });
    }
}

export function spawnDamageSmoke(x: number, y: number, z: number, health: number) {
    if (state.particles.length >= MAX_PARTICLES) return;
    const damagePercent = 1 - health / 100;
    const grayValue = Math.floor(180 - damagePercent * 150);
    const color = (grayValue << 16) | (grayValue << 8) | grayValue;
    const size = 0.3 + damagePercent * 0.4;
    const startOpacity = 0.5 + damagePercent * 0.3;

    addParticle({
        x: x + (Math.random() - 0.5) * 1.5,
        y: y + 1.5 + Math.random() * 0.5,
        z: z + (Math.random() - 0.5) * 1.5,
        vx: (Math.random() - 0.5) * 0.05,
        vy: 0.05 + Math.random() * 0.08,
        vz: (Math.random() - 0.5) * 0.05,
        life: 1.0,
        decay: 0.03 + Math.random() * 0.02,
        initialScale: size,
        initialOpacity: startOpacity,
        color,
        followTarget: null,
        localX: 0,
        localY: 0,
        localZ: 0
    });
}

export function spawnBoostFireParticle() {
    if (!state.bulli) return;
    const speed = Math.abs(state.bulli.speed);
    if (speed < 0.05) return;

    const carGroup = state.bulli.group;
    const carAngle = state.bulli.angle;

    const color = FIRE_COLORS[Math.floor(Math.random() * FIRE_COLORS.length)];
    const size = 0.3 + speed * 0.4;

    for (let side = -1; side <= 1; side += 2) {
        if (state.particles.length >= MAX_PARTICLES) return;
        const offsetX = side * 0.6;
        const rearDist = 2.5;

        const worldX = carGroup.position.x - Math.sin(carAngle) * rearDist + Math.cos(carAngle) * offsetX;
        const worldZ = carGroup.position.z - Math.cos(carAngle) * rearDist - Math.sin(carAngle) * offsetX;

        const backVx = -Math.sin(carAngle) * speed * 0.3;
        const backVz = -Math.cos(carAngle) * speed * 0.3;

        addParticle({
            x: worldX + (Math.random() - 0.5) * 0.3,
            y: carGroup.position.y + 0.4,
            z: worldZ + (Math.random() - 0.5) * 0.3,
            vx: backVx + (Math.random() - 0.5) * 0.15,
            vy: 0.05 + Math.random() * 0.08,
            vz: backVz + (Math.random() - 0.5) * 0.15,
            life: 1.0,
            decay: 0.04 + Math.random() * 0.03,
            initialScale: size,
            initialOpacity: 0.9,
            color,
            followTarget: null,
            localX: 0,
            localY: 0,
            localZ: 0
        });
    }
}

export function spawnDriftParticle() {
    if (!state.bulli || state.particles.length >= MAX_PARTICLES) return;
    const speed = Math.abs(state.bulli.speed);
    if (speed < 0.1) return;

    const carGroup = state.bulli.group;
    const carAngle = state.bulli.angle;

    const size = 0.25 + speed * 0.5;
    const worldOffsetX = Math.sin(carAngle + Math.PI) * 2;
    const worldOffsetZ = Math.cos(carAngle + Math.PI) * 2;

    // Soft puff that rises slowly and grows while it fades
    addParticle({
        x: carGroup.position.x + worldOffsetX + (Math.random() - 0.5),
        y: carGroup.position.y + 0.2,
        z: carGroup.position.z + worldOffsetZ + (Math.random() - 0.5),
        vx: (Math.random() - 0.5) * 0.2,
        vy: (Math.random() * 0.5 + 0.2) * 0.2,
        vz: (Math.random() - 0.5) * 0.2,
        life: 1.0,
        decay: 0.02 + Math.random() * 0.03,
        initialScale: size,
        initialOpacity: 0.55,
        color: 0xF2EDE6,
        grows: true,
        followTarget: null,
        localX: 0,
        localY: 0,
        localZ: 0
    });
}

/** Celebratory themed burst fired on unlocking a discovery POI. */
export function spawnDiscoveryBurst(x: number, y: number, z: number, effect: RewardEffect = 'sparks'): void {
    const palette = REWARD_PALETTES[effect] ?? REWARD_PALETTES.sparks;
    const count = effect === 'shockwave' || effect === 'confetti' ? 36 : 28;
    const ring = effect === 'shockwave';
    const floaty = effect === 'bubbles' || effect === 'confetti';
    for (let i = 0; i < count; i++) {
        if (state.particles.length >= MAX_PARTICLES) return;
        const angle = ring ? (i / count) * Math.PI * 2 : Math.random() * Math.PI * 2;
        const speed = ring ? 0.45 + Math.random() * 0.15 : 0.16 + Math.random() * 0.36;
        const vy = ring
            ? 0.08 + Math.random() * 0.14
            : floaty
                ? 0.22 + Math.random() * 0.32
                : 0.25 + Math.random() * 0.45;
        addParticle({
            x: x + Math.cos(angle) * (ring ? 1.2 : 0.5),
            y: y + Math.random() * 0.8,
            z: z + Math.sin(angle) * (ring ? 1.2 : 0.5),
            vx: Math.cos(angle) * speed,
            vy,
            vz: Math.sin(angle) * speed,
            life: 1.0,
            decay: floaty ? 0.011 + Math.random() * 0.01 : 0.016 + Math.random() * 0.016,
            initialScale: effect === 'flash' ? 0.8 + Math.random() * 0.6 : 0.35 + Math.random() * 0.45,
            initialOpacity: effect === 'bubbles' ? 0.8 : 1.0,
            color: palette[i % palette.length],
            grows: effect === 'bubbles' || effect === 'flash',
            followTarget: null,
            localX: 0,
            localY: 0,
            localZ: 0
        });
    }
}

/** Cyan/ember speed surge particles emitted when crossing a boost pad. */
export function spawnBoostPadBurst(x: number, y: number, z: number, yaw: number): void {
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const colors = [0x22D3EE, 0x38BDF8, 0xFF6A24, 0xFFFFFF];
    for (let i = 0; i < 18; i++) {
        if (state.particles.length >= MAX_PARTICLES) return;
        const lateral = (Math.random() - 0.5) * 2.2;
        const back = 1.4 + Math.random() * 1.4;
        addParticle({
            x: x - fx * back + fz * lateral,
            y: y + 0.3 + Math.random() * 0.5,
            z: z - fz * back - fx * lateral,
            vx: -fx * (0.28 + Math.random() * 0.25) + (Math.random() - 0.5) * 0.14,
            vy: 0.08 + Math.random() * 0.14,
            vz: -fz * (0.28 + Math.random() * 0.25) + (Math.random() - 0.5) * 0.14,
            life: 1.0,
            decay: 0.032 + Math.random() * 0.02,
            initialScale: 0.38 + Math.random() * 0.3,
            initialOpacity: 0.95,
            color: colors[i % colors.length],
            followTarget: null,
            localX: 0,
            localY: 0,
            localZ: 0
        });
    }
}

/** Tiered drift mini-turbo sparks from both rear tires (tier 1 blue/gold, 2 orange, 3 violet-white). */
export function spawnDriftSparks(x: number, y: number, z: number, yaw: number, tier: 1 | 2 | 3): void {
    const palette = DRIFT_SPARK_PALETTES[tier];
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const backX = x - fx * 1.65, backZ = z - fz * 1.65;
    const perWheel = tier === 3 ? 2 : 1;
    for (const side of [-1, 1]) {
        for (let k = 0; k < perWheel; k++) {
            if (state.particles.length >= MAX_PARTICLES) return;
            addParticle({
                x: backX + fz * side * 0.92 + (Math.random() - 0.5) * 0.2,
                y: y + 0.18 + Math.random() * 0.12,
                z: backZ - fx * side * 0.92 + (Math.random() - 0.5) * 0.2,
                vx: -fx * (0.18 + tier * 0.06) + fz * side * 0.08 + (Math.random() - 0.5) * 0.12,
                vy: 0.09 + Math.random() * (0.08 + tier * 0.03),
                vz: -fz * (0.18 + tier * 0.06) - fx * side * 0.08 + (Math.random() - 0.5) * 0.12,
                life: 1.0,
                decay: 0.045 + Math.random() * 0.03,
                initialScale: 0.22 + tier * 0.08,
                initialOpacity: 0.95,
                color: palette[Math.floor(Math.random() * palette.length)],
                followTarget: null,
                localX: 0,
                localY: 0,
                localZ: 0
            });
        }
    }
}

/** Surface-aware tire spray/dust/ice-glint emitted at a wheel contact point. */
export function spawnSurfaceTireParticle(x: number, y: number, z: number, surface: number, intensity = 1): void {
    if (state.particles.length >= MAX_PARTICLES) return;
    let color = 0xF2EDE6;
    let grows = true;
    let scale = 0.42 * intensity;
    let opacity = 0.5;
    let decay = 0.025 + Math.random() * 0.02;
    let vy = 0.08 + Math.random() * 0.09;

    if (surface === SURFACE.snow) {
        color = Math.random() < 0.5 ? 0xEEF6FF : 0xD6E9FF;
        scale = 0.55 * intensity;
        opacity = 0.72;
        vy = 0.12 + Math.random() * 0.14;
    } else if (surface === SURFACE.ice) {
        color = Math.random() < 0.5 ? 0xA5F3FC : 0xFFFFFF;
        grows = false;
        scale = 0.24 * intensity;
        opacity = 0.9;
        decay = 0.045 + Math.random() * 0.025;
        vy = 0.1 + Math.random() * 0.12;
    } else if (surface === SURFACE.sand) {
        color = 0xE2C799;
        scale = 0.5 * intensity;
        opacity = 0.58;
    } else if (surface === SURFACE.dirt || surface === SURFACE.gravel) {
        color = surface === SURFACE.gravel ? 0xA89882 : 0xBA9B74;
        scale = 0.54 * intensity;
        opacity = 0.62;
    } else if (surface === SURFACE.grass) {
        color = 0x7D9258;
        scale = 0.34 * intensity;
        opacity = 0.48;
    }

    addParticle({
        x: x + (Math.random() - 0.5) * 0.35,
        y: y + 0.18,
        z: z + (Math.random() - 0.5) * 0.35,
        vx: (Math.random() - 0.5) * 0.18,
        vy,
        vz: (Math.random() - 0.5) * 0.18,
        life: 1.0,
        decay,
        initialScale: scale,
        initialOpacity: opacity,
        color,
        grows,
        followTarget: null,
        localX: 0,
        localY: 0,
        localZ: 0
    });
}
