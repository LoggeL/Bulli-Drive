import * as THREE from 'three';
import { state } from '../state.js';

const MAX_PARTICLES = 200;
const EXPLOSION_COLORS = [0x333333, 0x555555, 0xFF4400, 0xFF6600];
const FIRE_COLORS = [0xFF4500, 0xFF6600, 0xFFAA00, 0xFF2200, 0xFFDD00];

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
const scratchDriftOffset = new THREE.Vector3();

function ensureParticleBatch(): THREE.InstancedMesh {
    if (!particleMesh) {
        const geometry = new THREE.BoxGeometry(1, 1, 1);
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
                #include <fog_pars_vertex>

                void main() {
                    vParticleColor = particleColor;
                    vParticleOpacity = particleOpacity;
                    vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
                    gl_Position = projectionMatrix * mvPosition;
                    #include <fog_vertex>
                }
            `,
            fragmentShader: `
                varying vec3 vParticleColor;
                varying float vParticleOpacity;
                #include <fog_pars_fragment>

                void main() {
                    gl_FragColor = vec4(vParticleColor, vParticleOpacity);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                    #include <fog_fragment>
                }
            `,
            transparent: true,
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

        writeParticleInstance(i, p, p.initialScale * p.life, p.initialOpacity * p.life);
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
    const isJumping = state.bulli.isFlipping;

    const size = 0.25 + speed * 0.5;
    const offsetX = (Math.random() - 0.5) * 1.5;
    const offsetY = 0.2;

    if (isJumping) {
        scratchDriftOffset.set(offsetX, offsetY, -2.2 + (Math.random() - 0.5) * 0.2);
        spawnFollowingParticle(state.bulli.flipGroup, scratchDriftOffset, 0xEEEEEE, size);
    } else {
        const worldOffsetX = Math.sin(carAngle + Math.PI) * 2;
        const worldOffsetZ = Math.cos(carAngle + Math.PI) * 2;

        spawnParticles(
            carGroup.position.x + worldOffsetX + (Math.random() - 0.5),
            carGroup.position.y + 0.2,
            carGroup.position.z + worldOffsetZ + (Math.random() - 0.5),
            0xEEEEEE,
            1,
            size, 0.2, 0.1
        );
    }
}
