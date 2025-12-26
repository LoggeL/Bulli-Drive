import * as THREE from 'three';
import { state } from '../state.js';

export function spawnParticles(x: number, y: number, z: number, color: number, count: number, size = 0.4, spread = 1.0, speed = 0.5) {
    const geo = new THREE.BoxGeometry(size, size, size);
    const mat = new THREE.MeshStandardMaterial({ 
        color: color,
        transparent: true,
        opacity: 1,
        roughness: 0.8
    });

    for (let i = 0; i < count; i++) {
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

export function updateParticles(dt: number) {
    const frame = dt * 60;
    for (let i = state.particles.length - 1; i >= 0; i--) {
        const p = state.particles[i];
        p.life -= p.decay * frame;
        
        if (p.life <= 0) {
            state.scene.remove(p.mesh);
            state.particles.splice(i, 1);
            continue;
        }

        p.mesh.position.x += p.vx * frame;
        p.mesh.position.y += p.vy * frame;
        p.mesh.position.z += p.vz * frame;
        
        // Gravity
        p.vy -= 0.02 * frame;
        
        // Shrink and fade
        p.mesh.scale.set(p.life, p.life, p.life);
        if (p.mesh.material instanceof THREE.Material) {
            p.mesh.material.opacity = p.life;
        }
    }
}

export function spawnDriftParticle() {
    if (!state.bulli) return;
    const speed = Math.abs(state.bulli.speed);
    if (speed < 0.1) return;

    const carPos = state.bulli.group.position;
    const carAngle = state.bulli.angle;
    
    // Scale particle size with speed
    const size = 0.25 + (speed * 0.5); 
    
    // Position behind wheels
    const offsetX = Math.sin(carAngle + Math.PI) * 2;
    const offsetZ = Math.cos(carAngle + Math.PI) * 2;

    spawnParticles(
        carPos.x + offsetX + (Math.random() - 0.5), 
        carPos.y + 0.2, 
        carPos.z + offsetZ + (Math.random() - 0.5), 
        0xEEEEEE, 
        1, 
        size, 0.2, 0.1
    );
}
