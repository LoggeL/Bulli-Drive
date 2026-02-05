import * as THREE from 'three';
import { state } from '../state.js';
import { getTerrainHeight } from './environment.js';
import { playCollectSound } from '../effects/sounds.js';
import { spawnParticles } from '../effects/particles.js';
import { updateScoreUI } from '../ui/hud.js';

// Store base Y for bobbing animation
const coinBaseY: Map<THREE.Mesh, number> = new Map();

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
    const mat = new THREE.MeshStandardMaterial({
        color: 0xFFD700,
        metalness: 1.0,
        roughness: 0.1,
        emissive: 0xFFD700,
        emissiveIntensity: 0.3
    });
    const coin = new THREE.Mesh(geo, mat);
    const baseY = getTerrainHeight(x, z) + 2.0;
    coin.position.set(x, baseY, z);
    coin.castShadow = true;
    state.scene.add(coin);
    state.coins.push(coin);
    coinBaseY.set(coin, baseY);
}

export function animateCoins(time: number) {
    state.coins.forEach((coin: THREE.Mesh) => {
        // Spin around Y axis
        coin.rotation.y = time * 2.0;
        // Gentle bob up and down
        const baseY = coinBaseY.get(coin);
        if (baseY !== undefined) {
            coin.position.y = baseY + Math.sin(time * 3.0 + coin.position.x) * 0.3;
        }

        // Magnet attraction: pull coins towards the car
        if (state.bulli && state.bulli.powerups.magnet.active) {
            const carPos = state.bulli.group.position;
            const dx = carPos.x - coin.position.x;
            const dz = carPos.z - coin.position.z;
            const dist = Math.sqrt(dx * dx + dz * dz);
            const magnetRange = 25;
            if (dist < magnetRange && dist > 1) {
                const pull = 0.08 * (1 - dist / magnetRange);
                coin.position.x += dx * pull;
                coin.position.z += dz * pull;
                // Update base Y for new position
                const newBaseY = getTerrainHeight(coin.position.x, coin.position.z) + 2.0;
                coinBaseY.set(coin, newBaseY);
            }
        }
    });
}

export function checkCoinCollection() {
    if (!state.bulli) return;
    const carPos = state.bulli.group.position;
    const scale = state.bulli.group.scale.x || 1;
    const magnetActive = state.bulli.powerups.magnet.active;
    const collectRadius = (magnetActive ? 6 : 3) * scale;
    for (let i = state.coins.length - 1; i >= 0; i--) {
        const coin = state.coins[i];
        const dx = carPos.x - coin.position.x;
        const dz = carPos.z - coin.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < collectRadius) {
            collectCoin(coin);
            state.coins.splice(i, 1);
        }
    }
}

export function collectCoin(coin: THREE.Mesh) {
    state.scene.remove(coin);
    coinBaseY.delete(coin);
    state.score += 10;
    updateScoreUI();
    playCollectSound();
    spawnParticles(coin.position.x, coin.position.y, coin.position.z, 0xFFD700, 15, 0.4, 1.5, 0.6);

    // Send score update to server
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({
            type: 'scoreUpdate',
            score: state.score
        }));
    }
}
