import * as THREE from 'three';
import { state } from '../state.js';
import { PowerupData } from '../types.js';
import { getTerrainHeight } from './environment.js';
import { showInteractionPrompt } from '../ui/hud.js';

// Store base Y for bobbing animation
const powerupBaseY: Map<THREE.Mesh, number> = new Map();

// Reusable vector for distance checks
const _powerupCheckVec = new THREE.Vector3();

export function createPowerupMarker(p: PowerupData) {
    const geo = new THREE.TorusGeometry(1.5, 0.2, 16, 32);
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({
        color: p.color,
        transparent: true,
        opacity: p.collected ? 0.2 : 0.8,
        emissive: p.color,
        emissiveIntensity: 0.5
    });
    const marker = new THREE.Mesh(geo, mat);
    const baseY = getTerrainHeight(p.x, p.z) + 1.5;
    marker.position.set(p.x, baseY, p.z);

    // Add floating icon - different shapes per type
    let iconGeo: THREE.BufferGeometry;
    switch (p.type) {
        case 'shield':
            iconGeo = new THREE.SphereGeometry(0.7, 8, 6);
            break;
        case 'magnet':
            iconGeo = new THREE.TorusGeometry(0.5, 0.2, 8, 12);
            break;
        case 'ghost':
            iconGeo = new THREE.ConeGeometry(0.6, 1.2, 6);
            break;
        default:
            iconGeo = new THREE.OctahedronGeometry(0.8);
            break;
    }
    const iconMat = new THREE.MeshStandardMaterial({
        color: p.color,
        transparent: true,
        opacity: p.collected ? 0.2 : 0.8,
        emissive: p.color,
        emissiveIntensity: 0.8
    });
    const icon = new THREE.Mesh(iconGeo, iconMat);
    icon.position.y = 1.5;
    marker.add(icon);

    state.scene.add(marker);
    powerupBaseY.set(marker, baseY);
    (p as any).mesh = marker;
    (p as any).iconMat = iconMat;
}

export function animatePowerups(time: number) {
    state.projects.forEach(p => {
        const mesh = (p as any).mesh as THREE.Mesh | undefined;
        if (!mesh) return;
        const baseY = powerupBaseY.get(mesh);
        if (baseY !== undefined) {
            mesh.position.y = baseY + Math.sin(time * 2.0 + p.id) * 0.5;
        }
        // Spin the torus
        mesh.rotation.z = time * 1.5;
        // Spin the icon inside
        if (mesh.children[0]) {
            mesh.children[0].rotation.y = time * 3.0;
        }
    });
}

export function checkPowerupCollection() {
    if (!state.bulli) return;
    const carPos = state.bulli.group.position;
    const scale = state.bulli.group.scale.x || 1;
    const collectRadius = 5 * scale;
    state.projects.forEach(p => {
        if (p.collected) return;
        _powerupCheckVec.set(p.x, carPos.y, p.z);
        const dist = carPos.distanceTo(_powerupCheckVec);
        if (dist < collectRadius) {
            requestPowerupCollection(p);
        }
    });
}

export function requestPowerupCollection(p: PowerupData) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({
            type: 'collectPowerup',
            powerupId: p.id
        }));
    }
}

export function applyPowerupEffect(p: PowerupData) {
    if (!state.bulli) return;
    const key = p.type as keyof typeof state.bulli.powerups;
    state.bulli.powerups[key].active = true;
    // Shield and ghost last longer
    const duration = (p.type === 'shield' || p.type === 'ghost') ? 8 : 5;
    state.bulli.powerups[key].timer = duration;

    showInteractionPrompt(`${p.label.toUpperCase()} ACTIVATED!`);
}
