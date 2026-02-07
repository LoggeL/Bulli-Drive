import * as THREE from 'three';
import { state } from '../state.js';

// Cached shared geometry - created once, never disposed
const _unitBox = new THREE.BoxGeometry(1, 1, 1);
const MAX_PARTICLES = 200;

interface Particle {
    mesh: THREE.Mesh;
    vx: number;
    vy: number;
    vz: number;
    life: number;
    decay: number;
    initialScale: number;
    initialOpacity: number;
    followTarget?: THREE.Object3D;
    localOffset?: THREE.Vector3;
}

export function spawnParticles(x: number, y: number, z: number, color: number, count: number, size = 0.4, spread = 1.0, speed = 0.5) {
    for (let i = 0; i < count; i++) {
        if (state.particles.length >= MAX_PARTICLES) return;
        const mat = new THREE.MeshBasicMaterial({
            color: color,
            transparent: true,
            opacity: 1
        });
        const p = new THREE.Mesh(_unitBox, mat);
        p.position.set(x, y, z);
        p.scale.set(size, size, size);

        const vx = (Math.random() - 0.5) * spread;
        const vy = (Math.random() * 0.5 + 0.2) * speed * 2;
        const vz = (Math.random() - 0.5) * spread;

        state.particles.push({
            mesh: p,
            vx, vy, vz,
            life: 1.0,
            decay: 0.02 + Math.random() * 0.03,
            initialScale: size,
            initialOpacity: 1
        });
        state.scene.add(p);
    }
}

export function spawnFollowingParticle(target: THREE.Object3D, localOffset: THREE.Vector3, color: number, size: number) {
    if (state.particles.length >= MAX_PARTICLES) return;
    const mat = new THREE.MeshBasicMaterial({
        color: color,
        transparent: true,
        opacity: 0.8
    });

    const p = new THREE.Mesh(_unitBox, mat);
    p.scale.set(size, size, size);

    const worldPos = localOffset.clone();
    target.localToWorld(worldPos);
    p.position.copy(worldPos);

    state.particles.push({
        mesh: p,
        vx: (Math.random() - 0.5) * 0.1,
        vy: (Math.random() * 0.1),
        vz: (Math.random() - 0.5) * 0.1,
        life: 1.0,
        decay: 0.03 + Math.random() * 0.02,
        initialScale: size,
        initialOpacity: 0.8,
        followTarget: target,
        localOffset: localOffset.clone()
    } as Particle);
    state.scene.add(p);
}

export function updateParticles(dt: number) {
    const frame = dt * 60;
    let i = 0;
    while (i < state.particles.length) {
        const p = state.particles[i] as Particle;
        p.life -= p.decay * frame;

        if (p.life <= 0) {
            state.scene.remove(p.mesh);
            (p.mesh.material as THREE.Material).dispose();
            // Swap-and-pop instead of splice
            const last = state.particles.length - 1;
            if (i < last) state.particles[i] = state.particles[last];
            state.particles.pop();
            continue;
        }

        if (p.followTarget && p.localOffset) {
            const worldPos = p.localOffset.clone();
            p.followTarget.localToWorld(worldPos);

            p.localOffset.x += p.vx * frame * 0.5;
            p.localOffset.y += p.vy * frame * 0.5;
            p.localOffset.z += p.vz * frame * 0.5;
            p.vy += 0.005 * frame;

            p.mesh.position.copy(worldPos);
        } else {
            p.mesh.position.x += p.vx * frame;
            p.mesh.position.y += p.vy * frame;
            p.mesh.position.z += p.vz * frame;
            p.vy -= 0.02 * frame;
        }

        const s = p.initialScale * p.life;
        p.mesh.scale.set(s, s, s);
        (p.mesh.material as THREE.MeshBasicMaterial).opacity = p.initialOpacity * p.life;

        i++;
    }
}

export function spawnExplosion(x: number, y: number, z: number, color: number) {
    const count = 25;
    const colors = [color, 0x333333, 0x555555, 0xFF4400, 0xFF6600];

    for (let i = 0; i < count; i++) {
        if (state.particles.length >= MAX_PARTICLES) return;
        const c = colors[Math.floor(Math.random() * colors.length)];
        const mat = new THREE.MeshBasicMaterial({
            color: c,
            transparent: true,
            opacity: 1
        });
        const size = 0.3 + Math.random() * 0.5;
        const mesh = new THREE.Mesh(_unitBox, mat);
        mesh.position.set(
            x + (Math.random() - 0.5) * 2,
            y + 1 + Math.random() * 2,
            z + (Math.random() - 0.5) * 2
        );
        mesh.scale.set(size, size, size);

        const angle = Math.random() * Math.PI * 2;
        const speed = 0.2 + Math.random() * 0.4;
        state.particles.push({
            mesh,
            vx: Math.cos(angle) * speed,
            vy: 0.2 + Math.random() * 0.4,
            vz: Math.sin(angle) * speed,
            life: 1.0,
            decay: 0.015 + Math.random() * 0.015,
            initialScale: size,
            initialOpacity: 1
        });
        state.scene.add(mesh);
    }
}

export function spawnDamageSmoke(x: number, y: number, z: number, health: number) {
    if (state.particles.length >= MAX_PARTICLES) return;
    const damagePercent = 1 - health / 100;
    const grayValue = Math.floor(180 - damagePercent * 150);
    const color = (grayValue << 16) | (grayValue << 8) | grayValue;
    const size = 0.3 + damagePercent * 0.4;
    const startOpacity = 0.5 + damagePercent * 0.3;

    const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: startOpacity
    });
    const mesh = new THREE.Mesh(_unitBox, mat);
    mesh.position.set(
        x + (Math.random() - 0.5) * 1.5,
        y + 1.5 + Math.random() * 0.5,
        z + (Math.random() - 0.5) * 1.5
    );
    mesh.scale.set(size, size, size);

    state.particles.push({
        mesh,
        vx: (Math.random() - 0.5) * 0.05,
        vy: 0.05 + Math.random() * 0.08,
        vz: (Math.random() - 0.5) * 0.05,
        life: 1.0,
        decay: 0.03 + Math.random() * 0.02,
        initialScale: size,
        initialOpacity: startOpacity
    });
    state.scene.add(mesh);
}

export function spawnBoostFireParticle() {
    if (!state.bulli) return;
    const speed = Math.abs(state.bulli.speed);
    if (speed < 0.05) return;

    const carGroup = state.bulli.group;
    const carAngle = state.bulli.angle;

    const fireColors = [0xFF4500, 0xFF6600, 0xFFAA00, 0xFF2200, 0xFFDD00];
    const color = fireColors[Math.floor(Math.random() * fireColors.length)];
    const size = 0.3 + speed * 0.4;

    for (let side = -1; side <= 1; side += 2) {
        if (state.particles.length >= MAX_PARTICLES) return;
        const offsetX = side * 0.6;
        const rearDist = 2.5;

        const worldX = carGroup.position.x - Math.sin(carAngle) * rearDist + Math.cos(carAngle) * offsetX;
        const worldZ = carGroup.position.z - Math.cos(carAngle) * rearDist - Math.sin(carAngle) * offsetX;

        const backVx = -Math.sin(carAngle) * speed * 0.3;
        const backVz = -Math.cos(carAngle) * speed * 0.3;

        const mat = new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.9
        });
        const mesh = new THREE.Mesh(_unitBox, mat);
        mesh.position.set(worldX + (Math.random() - 0.5) * 0.3, carGroup.position.y + 0.4, worldZ + (Math.random() - 0.5) * 0.3);
        mesh.scale.set(size, size, size);

        state.particles.push({
            mesh,
            vx: backVx + (Math.random() - 0.5) * 0.15,
            vy: 0.05 + Math.random() * 0.08,
            vz: backVz + (Math.random() - 0.5) * 0.15,
            life: 1.0,
            decay: 0.04 + Math.random() * 0.03,
            initialScale: size,
            initialOpacity: 0.9
        });
        state.scene.add(mesh);
    }
}

export function spawnDriftParticle() {
    if (!state.bulli || state.particles.length >= MAX_PARTICLES) return;
    const speed = Math.abs(state.bulli.speed);
    if (speed < 0.1) return;

    const carGroup = state.bulli.group;
    const carAngle = state.bulli.angle;
    const isJumping = state.bulli.isFlipping;

    const size = 0.25 + (speed * 0.5);

    const offsetX = (Math.random() - 0.5) * 1.5;
    const offsetY = 0.2;

    if (isJumping) {
        const flipGroup = state.bulli.flipGroup;
        const localOffset = new THREE.Vector3(offsetX, offsetY, -2.2 + (Math.random() - 0.5) * 0.2);
        spawnFollowingParticle(flipGroup, localOffset, 0xEEEEEE, size);
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
