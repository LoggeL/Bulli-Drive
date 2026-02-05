import * as THREE from 'three';
import { state } from '../state.js';
import { getTerrainHeight } from './environment.js';
import { playCollectSound } from '../effects/sounds.js';
import { spawnParticles } from '../effects/particles.js';
import { updateScoreUI } from '../ui/hud.js';
import { CoinData } from '../types.js';

// Store base Y for bobbing animation
const coinBaseY: Map<THREE.Mesh, number> = new Map();
// Map coin server ID to mesh
const coinMeshes: Map<number, THREE.Mesh> = new Map();

const coinGeo = new THREE.CylinderGeometry(0.8, 0.8, 0.2, 16);
const coinMat = new THREE.MeshStandardMaterial({
    color: 0xFFD700,
    metalness: 1.0,
    roughness: 0.1,
    emissive: 0xFFD700,
    emissiveIntensity: 0.3
});

export function createCoinsFromServer(coinsData: CoinData[]) {
    coinsData.forEach(cd => {
        if (!cd.collected) {
            createCoin(cd.id, cd.x, cd.z);
        }
    });
}

export function createCoin(id: number, x: number, z: number) {
    const coin = new THREE.Mesh(coinGeo, coinMat.clone());
    const baseY = getTerrainHeight(x, z) + 2.0;
    coin.position.set(x, baseY, z);
    coin.castShadow = true;
    (coin as any).coinId = id;
    state.scene.add(coin);
    state.coins.push(coin);
    coinBaseY.set(coin, baseY);
    coinMeshes.set(id, coin);
}

export function removeCoinById(coinId: number) {
    const coin = coinMeshes.get(coinId);
    if (coin) {
        state.scene.remove(coin);
        coinBaseY.delete(coin);
        coinMeshes.delete(coinId);
        const idx = state.coins.indexOf(coin);
        if (idx !== -1) state.coins.splice(idx, 1);
    }
}

export function resetCoinById(coinId: number) {
    // Find original position from server data stored in state
    const cd = state.serverCoins?.find((c: CoinData) => c.id === coinId);
    if (cd) {
        createCoin(cd.id, cd.x, cd.z);
    }
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
            const coinId = (coin as any).coinId as number;
            collectCoin(coin, coinId);
            state.coins.splice(i, 1);
        }
    }
}

export function collectCoin(coin: THREE.Mesh, coinId: number) {
    state.scene.remove(coin);
    coinBaseY.delete(coin);
    coinMeshes.delete(coinId);
    state.score += 10;
    updateScoreUI();
    playCollectSound();
    spawnParticles(coin.position.x, coin.position.y, coin.position.z, 0xFFD700, 15, 0.4, 1.5, 0.6);

    // Notify server about coin collection
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({
            type: 'collectCoin',
            coinId: coinId
        }));
        state.ws.send(JSON.stringify({
            type: 'scoreUpdate',
            score: state.score
        }));
    }
}
