import * as THREE from 'three';
import { state } from '../state.js';
import { playHitSound } from '../effects/sounds.js';
import { showHitmarker } from '../ui/hud.js';
import { sendToServer } from '../network/socket.js';
import { distSq2D } from './util.js';

interface Projectile {
    mesh: THREE.Mesh;
    dx: number;
    dz: number;
    age: number;
    hitRadius: number;
}

const PROJECTILE_SPEED = 80;
const PROJECTILE_MAX_AGE = 2.0;
const HIT_DISTANCE = 3.0;
const MEGA_PROJECTILE_SCALE = 1.8;
const MEGA_HIT_DISTANCE = 4.5;

// Cached shared geometry - created once, never disposed
const _projectileGeo = new THREE.CapsuleGeometry(0.15, 0.6, 4, 8);

const projectiles: Projectile[] = [];

export function createProjectile(
    x: number,
    y: number,
    z: number,
    angle: number,
    color: number,
    ownerId: string,
    isMega = false
) {
    const mat = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.8,
    });
    const mesh = new THREE.Mesh(_projectileGeo, mat);
    mesh.position.set(x, y + 1.5, z);
    mesh.rotation.x = Math.PI / 2;
    mesh.rotation.y = angle;
    if (isMega) {
        mesh.scale.setScalar(MEGA_PROJECTILE_SCALE);
    }

    state.scene.add(mesh);

    const dx = Math.sin(angle) * PROJECTILE_SPEED;
    const dz = Math.cos(angle) * PROJECTILE_SPEED;

    projectiles.push({
        mesh,
        dx,
        dz,
        age: 0,
        hitRadius: isMega ? MEGA_HIT_DISTANCE : HIT_DISTANCE
    });
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

        // Swept movement: test the whole segment travelled this frame against
        // each target circle so fast projectiles can't tunnel at low framerates.
        const sx = p.mesh.position.x;
        const sz = p.mesh.position.z;
        p.mesh.position.x += p.dx * dt;
        p.mesh.position.z += p.dz * dt;
        const segX = p.mesh.position.x - sx;
        const segZ = p.mesh.position.z - sz;
        const segLenSq = segX * segX + segZ * segZ;

        let hit = false;
        for (const id in state.remotePlayers) {
            const remote = state.remotePlayers[id];
            if (!remote.flipGroup.visible) continue;
            const rx = remote.group.position.x;
            const rz = remote.group.position.z;

            // Closest point on the swept segment to the target
            let t = 0;
            if (segLenSq > 0) {
                t = Math.max(0, Math.min(1, ((rx - sx) * segX + (rz - sz) * segZ) / segLenSq));
            }
            const cx = sx + segX * t;
            const cz = sz + segZ * t;

            if (distSq2D(cx, cz, rx, rz) < p.hitRadius * p.hitRadius) {
                sendToServer({ type: 'shoot', targetId: id });

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
