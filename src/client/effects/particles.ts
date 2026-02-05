import * as THREE from 'three';
import { state } from '../state.js';

interface Particle {
    mesh: THREE.Mesh;
    vx: number;
    vy: number;
    vz: number;
    life: number;
    decay: number;
    followTarget?: THREE.Object3D;
    localOffset?: THREE.Vector3;
}

export function spawnParticles(x: number, y: number, z: number, color: number, count: number, size = 0.4, spread = 1.0, speed = 0.5) {
    const geo = new THREE.BoxGeometry(size, size, size);

    for (let i = 0; i < count; i++) {
        const mat = new THREE.MeshStandardMaterial({
            color: color,
            transparent: true,
            opacity: 1,
            roughness: 0.8
        });
        const p = new THREE.Mesh(geo, mat);
        p.position.set(x, y, z);
        
        // Random velocity
        const vx = (Math.random() - 0.5) * spread;
        const vy = (Math.random() * 0.5 + 0.2) * speed * 2;
        const vz = (Math.random() - 0.5) * spread;

        state.particles.push({
            mesh: p,
            vx, vy, vz,
            life: 1.0,
            decay: 0.02 + Math.random() * 0.03
        });
        state.scene.add(p);
    }
}

export function spawnFollowingParticle(target: THREE.Object3D, localOffset: THREE.Vector3, color: number, size: number) {
    const geo = new THREE.BoxGeometry(size, size, size);
    const mat = new THREE.MeshStandardMaterial({ 
        color: color,
        transparent: true,
        opacity: 0.8,
        roughness: 0.8
    });

    const p = new THREE.Mesh(geo, mat);
    
    // Calculate initial world position
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
        followTarget: target,
        localOffset: localOffset.clone()
    } as Particle);
    state.scene.add(p);
}

export function updateParticles(dt: number) {
    const frame = dt * 60;
    for (let i = state.particles.length - 1; i >= 0; i--) {
        const p = state.particles[i] as Particle;
        p.life -= p.decay * frame;
        
        if (p.life <= 0) {
            state.scene.remove(p.mesh);
            if (p.mesh.material instanceof THREE.Material) p.mesh.material.dispose();
            state.particles.splice(i, 1);
            continue;
        }

        if (p.followTarget && p.localOffset) {
            // Follow the target with drift
            const worldPos = p.localOffset.clone();
            p.followTarget.localToWorld(worldPos);
            
            // Add accumulated drift velocity
            p.localOffset.x += p.vx * frame * 0.5;
            p.localOffset.y += p.vy * frame * 0.5;
            p.localOffset.z += p.vz * frame * 0.5;
            
            // Slight upward drift and expand outward
            p.vy += 0.005 * frame;
            
            p.mesh.position.copy(worldPos);
        } else {
            // Standard particle physics
            p.mesh.position.x += p.vx * frame;
            p.mesh.position.y += p.vy * frame;
            p.mesh.position.z += p.vz * frame;
            
            // Gravity
            p.vy -= 0.02 * frame;
        }
        
        // Shrink and fade
        p.mesh.scale.set(p.life, p.life, p.life);
        if (p.mesh.material instanceof THREE.Material) {
            p.mesh.material.opacity = p.life;
        }
    }
}

export function spawnBoostFireParticle() {
    if (!state.bulli) return;
    const speed = Math.abs(state.bulli.speed);
    if (speed < 0.05) return;

    const carGroup = state.bulli.group;
    const carAngle = state.bulli.angle;

    // Fire colors: orange, red, yellow
    const fireColors = [0xFF4500, 0xFF6600, 0xFFAA00, 0xFF2200, 0xFFDD00];
    const color = fireColors[Math.floor(Math.random() * fireColors.length)];
    const size = 0.3 + speed * 0.4;

    // Spawn from both exhaust pipes (rear left and rear right)
    for (let side = -1; side <= 1; side += 2) {
        const offsetX = side * 0.6;
        const rearDist = 2.5;

        const worldX = carGroup.position.x - Math.sin(carAngle) * rearDist + Math.cos(carAngle) * offsetX;
        const worldZ = carGroup.position.z - Math.cos(carAngle) * rearDist - Math.sin(carAngle) * offsetX;

        // Fire shoots backward and slightly upward
        const backVx = -Math.sin(carAngle) * speed * 0.3;
        const backVz = -Math.cos(carAngle) * speed * 0.3;

        const geo = new THREE.BoxGeometry(size, size, size);
        const mat = new THREE.MeshStandardMaterial({
            color,
            transparent: true,
            opacity: 0.9,
            emissive: color,
            emissiveIntensity: 0.8,
            roughness: 1.0
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(worldX + (Math.random() - 0.5) * 0.3, carGroup.position.y + 0.4, worldZ + (Math.random() - 0.5) * 0.3);

        state.particles.push({
            mesh,
            vx: backVx + (Math.random() - 0.5) * 0.15,
            vy: 0.05 + Math.random() * 0.08,
            vz: backVz + (Math.random() - 0.5) * 0.15,
            life: 1.0,
            decay: 0.04 + Math.random() * 0.03
        });
        state.scene.add(mesh);
    }
}

export function spawnDriftParticle() {
    if (!state.bulli) return;
    const speed = Math.abs(state.bulli.speed);
    if (speed < 0.1) return;

    const carGroup = state.bulli.group;
    const carAngle = state.bulli.angle;
    const isJumping = state.bulli.isFlipping;
    
    // Scale particle size with speed
    const size = 0.25 + (speed * 0.5); 
    
    // Position behind wheels (local offset)
    const offsetX = (Math.random() - 0.5) * 1.5;
    const offsetY = 0.2;
    const offsetZ = -2 + (Math.random() - 0.5) * 0.5;

    if (isJumping) {
        // When jumping, spawn following particles attached to the flipping body
        // This ensures smoke comes from the exhaust even while rotating
        const flipGroup = state.bulli.flipGroup;
        // Adjust offsetZ to be relative to the car body (rear)
        const localOffset = new THREE.Vector3(offsetX, offsetY, -2.2 + (Math.random() - 0.5) * 0.2);
        spawnFollowingParticle(flipGroup, localOffset, 0xEEEEEE, size);
    } else {
        // Normal ground particles
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
