import * as THREE from 'three';
import { state } from '../state.js';
import type { PowerupData } from '../../shared/protocol.js';
import { groundHeight } from './environment.js';
import { showInteractionPrompt } from '../ui/hud.js';
import { POWERUP_DURATIONS_MS } from '../../shared/constants.js';

// Store base Y for bobbing animation
const powerupBaseY: Map<THREE.Mesh, number> = new Map();
// Marker meshes/materials keyed by server powerup id (no more (p as any) stuffing)
const powerupMarkers = new Map<PowerupData['id'], { mesh: THREE.Mesh; iconMat: THREE.MeshStandardMaterial }>();

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
    const baseY = groundHeight(p.x, p.z) + 1.5;
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
    powerupMarkers.set(p.id, { mesh: marker, iconMat });
}

// Removes every marker (a room switch brings the new room's powerups)
export function clearPowerupMarkers() {
    for (const { mesh, iconMat } of powerupMarkers.values()) {
        state.scene.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        const icon = mesh.children[0] as THREE.Mesh | undefined;
        icon?.geometry.dispose();
        iconMat.dispose();
    }
    powerupMarkers.clear();
    powerupBaseY.clear();
    state.worldPowerups = [];
}

// Dim/restore the marker visuals when a powerup is collected/reset (called from websocket.ts)
export function setPowerupCollectedVisual(id: PowerupData['id'], collected: boolean): void {
    const entry = powerupMarkers.get(id);
    if (!entry) return;
    const opacity = collected ? 0.2 : 0.8;
    (entry.mesh.material as THREE.MeshStandardMaterial).opacity = opacity;
    entry.iconMat.opacity = opacity;
}

export function animatePowerups(time: number) {
    state.worldPowerups.forEach(p => {
        const entry = powerupMarkers.get(p.id);
        if (!entry) return;
        const mesh = entry.mesh;
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

// The server gave the local car this powerup (its window drives the sim
// and the HUD, net/netDriver.ts); offline the car counts the timer itself
export function applyPowerupEffect(p: PowerupData) {
    if (!state.bulli) return;
    // Guard against unknown/unsupported powerup types from the server
    if (!(p.type in state.bulli.powerups)) return;
    if (!state.ws) {
        const key = p.type as keyof typeof state.bulli.powerups;
        state.bulli.powerups[key].active = true;
        state.bulli.powerups[key].timer = (POWERUP_DURATIONS_MS[p.type] ?? 5000) / 1000;
    }
    showInteractionPrompt(`${p.label.toUpperCase()} ACTIVATED!`);
}
