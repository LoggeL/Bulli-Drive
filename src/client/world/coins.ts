import * as THREE from 'three';
import { state } from '../state.js';
import { getTerrainHeight } from './environment.js';
import { playCollectSound } from '../effects/sounds.js';
import { spawnParticles } from '../effects/particles.js';
import { updateScoreUI } from '../ui/hud.js';

export function createCoins() {
    for (let i = 0; i < 30; i++) {
        const x = (Math.random() - 0.5) * 600;
        const z = (Math.random() - 0.5) * 600;
        // Avoid center
        if (Math.abs(x) < 30 && Math.abs(z) < 30) continue;
        createCoin(x, z);
    }
}

export function createCoin(x: number, z: number) {
    const geo = new THREE.CylinderGeometry(0.8, 0.8, 0.2, 16);
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ 
        color: 0xFFD700, 
        metalness: 1.0, 
        roughness: 0.1,
        emissive: 0xFFD700,
        emissiveIntensity: 0.2
    });
    const coin = new THREE.Mesh(geo, mat);
    coin.position.set(x, getTerrainHeight(x, z) + 1.5, z);
    coin.castShadow = true;
    state.scene.add(coin);
    state.coins.push(coin);
}

export function checkCoinCollection() {
    if (!state.bulli) return;
    const carPos = state.bulli.group.position;
    for (let i = state.coins.length - 1; i >= 0; i--) {
        const coin = state.coins[i];
        const dist = carPos.distanceTo(coin.position);
        if (dist < 3) {
            collectCoin(coin);
            state.coins.splice(i, 1);
        }
    }
}

export function collectCoin(coin: THREE.Object3D) {
    state.scene.remove(coin);
    state.score += 10;
    updateScoreUI();
    playCollectSound();
    spawnParticles(coin.position.x, coin.position.y, coin.position.z, 0xFFD700, 15, 0.4, 1.5, 0.6);
}
