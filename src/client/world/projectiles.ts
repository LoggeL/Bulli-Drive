import * as THREE from 'three';
import { state } from '../state.js';
import { playHitSound } from '../effects/sounds.js';
import { showHitmarker } from '../ui/hud.js';

interface Projectile {
    mesh: THREE.Mesh;
    dx: number;
    dz: number;
    age: number;
    angle: number;
    ownerId: string;
}

const PROJECTILE_SPEED = 80;
const PROJECTILE_MAX_AGE = 2.0;
const HIT_DISTANCE = 3.0;

// Cached shared geometry - created once, never disposed
const _projectileGeo = new THREE.CapsuleGeometry(0.15, 0.6, 4, 8);

const projectiles: Projectile[] = [];

export function createProjectile(x: number, y: number, z: number, angle: number, color: number, ownerId: string) {
    const mat = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.8,
    });
    const mesh = new THREE.Mesh(_projectileGeo, mat);
    mesh.position.set(x, y + 1.5, z);
    mesh.rotation.x = Math.PI / 2;
    mesh.rotation.y = angle;

    state.scene.add(mesh);

    const dx = Math.sin(angle) * PROJECTILE_SPEED;
    const dz = Math.cos(angle) * PROJECTILE_SPEED;

    projectiles.push({ mesh, dx, dz, age: 0, angle, ownerId });
}

function removeProjectile(index: number) {
    const p = projectiles[index];
    state.scene.remove(p.mesh);
    (p.mesh.material as THREE.Material).dispose();
    const last = projectiles.length - 1;
    if (index < last) projectiles[index] = projectiles[last];
    projectiles.pop();
}

export function updateProjectiles(dt: number) {
    let i = 0;
    while (i < projectiles.length) {
        const p = projectiles[i];
        p.age += dt;

        if (p.age >= PROJECTILE_MAX_AGE) {
            removeProjectile(i);
            continue;
        }

        p.mesh.position.x += p.dx * dt;
        p.mesh.position.z += p.dz * dt;

        let hit = false;
        for (const id in state.remotePlayers) {
            const remote = state.remotePlayers[id];
            if (!remote.flipGroup.visible) continue;
            const rx = remote.group.position.x;
            const rz = remote.group.position.z;
            const dx = p.mesh.position.x - rx;
            const dz = p.mesh.position.z - rz;
            const dist = Math.sqrt(dx * dx + dz * dz);

            if (dist < HIT_DISTANCE) {
                if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                    state.ws.send(JSON.stringify({
                        type: 'shoot',
                        targetId: id,
                        damage: 25
                    }));
                }

                playHitSound();
                showHitmarker();
                removeProjectile(i);
                hit = true;
                break;
            }
        }

        if (!hit) i++;
    }
}

export function clearProjectiles() {
    for (const p of projectiles) {
        state.scene.remove(p.mesh);
        (p.mesh.material as THREE.Material).dispose();
    }
    projectiles.length = 0;
}
