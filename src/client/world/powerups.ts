import * as THREE from 'three';
import { state } from '../state.js';
import { PowerupData } from '../types.js';
import { getTerrainHeight } from './environment.js';
import { showInteractionPrompt } from '../ui/hud.js';
import { sendToServer } from '../network/socket.js';
import { POWERUP_DURATIONS_MS } from '../../shared/constants.js';
import { distSq2D } from './util.js';

// Store base Y for bobbing animation
const powerupBaseY: Map<THREE.Mesh, number> = new Map();
// Marker meshes/materials keyed by server powerup id (no more (p as any) stuffing)
const powerupMarkers = new Map<PowerupData['id'], { mesh: THREE.Mesh; iconMat: THREE.MeshStandardMaterial }>();
// Powerups we already sent a collectPowerup for (until confirmed/reset)
const pendingCollects = new Set<number>();

const COLLECT_RADIUS = 5;

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
    powerupMarkers.set(p.id, { mesh: marker, iconMat });
}

// Dim/restore the marker visuals when a powerup is collected/reset (called from websocket.ts)
export function setPowerupCollectedVisual(id: PowerupData['id'], collected: boolean): void {
    pendingCollects.delete(id);
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

export function checkPowerupCollection() {
    if (!state.bulli) return;
    const carPos = state.bulli.group.position;
    const collectRadiusSq = COLLECT_RADIUS * COLLECT_RADIUS;
    state.worldPowerups.forEach(p => {
        if (p.collected) return;
        if (distSq2D(carPos.x, carPos.z, p.x, p.z) < collectRadiusSq) {
            requestPowerupCollection(p);
        }
    });
}

export function requestPowerupCollection(p: PowerupData) {
    // Only ask once per powerup until the server confirms or resets it
    if (pendingCollects.has(p.id)) return;
    if (sendToServer({ type: 'collectPowerup', powerupId: p.id })) {
        pendingCollects.add(p.id);
    }
}

export function applyPowerupEffect(p: PowerupData) {
    if (!state.bulli) return;
    // Guard against unknown/unsupported powerup types from the server
    if (!(p.type in state.bulli.powerups)) return;
    const key = p.type as keyof typeof state.bulli.powerups;
    state.bulli.powerups[key].active = true;
    state.bulli.powerups[key].timer = (POWERUP_DURATIONS_MS[p.type] ?? 5000) / 1000;

    showInteractionPrompt(`${p.label.toUpperCase()} ACTIVATED!`);
}
