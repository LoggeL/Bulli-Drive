import * as THREE from 'three';
import { state } from '../state.js';
import { PowerupData } from '../types.js';
import { getTerrainHeight } from './environment.js';
import { showInteractionPrompt } from '../ui/hud.js';

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
    marker.position.set(p.x, getTerrainHeight(p.x, p.z) + 0.5, p.z);
    
    // Add floating label/icon
    const iconGeo = new THREE.OctahedronGeometry(0.8);
    const icon = new THREE.Mesh(iconGeo, mat);
    icon.position.y = 1.5;
    marker.add(icon);

    state.scene.add(marker);
    (p as any).mesh = marker;
}

export function checkPowerupCollection() {
    if (!state.bulli) return;
    const carPos = state.bulli.group.position;
    state.projects.forEach(p => {
        if (p.collected) return;
        const dist = carPos.distanceTo(new THREE.Vector3(p.x, carPos.y, p.z));
        if (dist < 5) {
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
    state.bulli.powerups[p.type as keyof typeof state.bulli.powerups].active = true;
    state.bulli.powerups[p.type as keyof typeof state.bulli.powerups].timer = 10; // 10 seconds
    
    showInteractionPrompt(`${p.label.toUpperCase()} ACTIVATED!`);
}
