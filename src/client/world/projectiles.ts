import * as THREE from 'three';
import { state } from '../state.js';
import { playHitSound } from '../effects/sounds.js';

interface Projectile {
    mesh: THREE.Mesh;
    dx: number;
    dz: number;
    age: number;
    ownerId: string;
}

const PROJECTILE_SPEED = 80;
const PROJECTILE_MAX_AGE = 2.0;
const PROJECTILE_RADIUS = 0.3;
const HIT_DISTANCE = 3.0;

const projectiles: Projectile[] = [];

export function createProjectile(x: number, y: number, z: number, angle: number, color: number, ownerId: string) {
    const geo = new THREE.SphereGeometry(PROJECTILE_RADIUS, 8, 6);
    const mat = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.8,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y + 1.5, z);

    state.scene.add(mesh);

    const dx = Math.sin(angle) * PROJECTILE_SPEED;
    const dz = Math.cos(angle) * PROJECTILE_SPEED;

    projectiles.push({ mesh, dx, dz, age: 0, ownerId });
}

export function updateProjectiles(dt: number) {
    for (let i = projectiles.length - 1; i >= 0; i--) {
        const p = projectiles[i];
        p.age += dt;

        if (p.age >= PROJECTILE_MAX_AGE) {
            state.scene.remove(p.mesh);
            p.mesh.geometry.dispose();
            (p.mesh.material as THREE.Material).dispose();
            projectiles.splice(i, 1);
            continue;
        }

        p.mesh.position.x += p.dx * dt;
        p.mesh.position.z += p.dz * dt;

        // Collision check with remote players
        for (const id in state.remotePlayers) {
            const remote = state.remotePlayers[id];
            const rx = remote.group.position.x;
            const rz = remote.group.position.z;
            const dx = p.mesh.position.x - rx;
            const dz = p.mesh.position.z - rz;
            const dist = Math.sqrt(dx * dx + dz * dz);

            if (dist < HIT_DISTANCE) {
                // Send hit to server
                if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                    state.ws.send(JSON.stringify({
                        type: 'shoot',
                        targetId: id,
                        damage: 25
                    }));
                }

                playHitSound();

                // Remove projectile
                state.scene.remove(p.mesh);
                p.mesh.geometry.dispose();
                (p.mesh.material as THREE.Material).dispose();
                projectiles.splice(i, 1);
                break;
            }
        }
    }
}

export function clearProjectiles() {
    for (const p of projectiles) {
        state.scene.remove(p.mesh);
        p.mesh.geometry.dispose();
        (p.mesh.material as THREE.Material).dispose();
    }
    projectiles.length = 0;
}
