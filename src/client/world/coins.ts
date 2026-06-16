import * as THREE from 'three';
import { state } from '../state.js';
import { getTerrainHeight } from './environment.js';
import { playCollectSound } from '../effects/sounds.js';
import { spawnParticles } from '../effects/particles.js';
import { sendToServer } from '../network/socket.js';
import { MAGNET_RANGE } from '../../shared/constants.js';
import { distSq2D } from './util.js';
import { CoinData } from '../types.js';

// Store base Y for bobbing animation
const coinBaseY: Map<THREE.Mesh, number> = new Map();
// Map coin server ID to mesh
const coinMeshes: Map<number, THREE.Mesh> = new Map();
// Coins we already sent a collectCoin for (until server confirms/resets)
const pendingCollects = new Set<number>();

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
    const coin = new THREE.Mesh(coinGeo, coinMat);
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
    pendingCollects.delete(coinId);
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
    pendingCollects.delete(coinId);
    if (coinMeshes.has(coinId)) return; // already visible, nothing to recreate
    // Find original position from server data stored in state
    const cd = state.serverCoins?.find((c: CoinData) => c.id === coinId);
    if (cd) {
        createCoin(cd.id, cd.x, cd.z);
    }
}

// 'time' is state.clock.elapsedTime in seconds; derive real dt from the delta
// between calls so the magnet pull is framerate-independent.
let lastAnimTime: number | null = null;

export function animateCoins(time: number) {
    const dt = lastAnimTime === null ? 0 : Math.min(Math.max(time - lastAnimTime, 0), 0.1);
    lastAnimTime = time;

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
            const distSq = distSq2D(carPos.x, carPos.z, coin.position.x, coin.position.z);
            if (distSq < MAGNET_RANGE * MAGNET_RANGE && distSq > 1) {
                const dist = Math.sqrt(distSq);
                // 0.08 per frame at 60fps -> scale by dt * 60 to keep the same feel
                const pull = 0.08 * (1 - dist / MAGNET_RANGE) * dt * 60;
                coin.position.x += (carPos.x - coin.position.x) * pull;
                coin.position.z += (carPos.z - coin.position.z) * pull;
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
    const magnetActive = state.bulli.powerups.magnet.active;
    const collectRadius = magnetActive ? 6 : 3;
    const collectRadiusSq = collectRadius * collectRadius;
    for (let i = state.coins.length - 1; i >= 0; i--) {
        const coin = state.coins[i];
        if (distSq2D(carPos.x, carPos.z, coin.position.x, coin.position.z) < collectRadiusSq) {
            const coinId = (coin as any).coinId as number;
            collectCoin(coin, coinId);
            state.coins.splice(i, 1);
        }
    }
}

export function collectCoin(coin: THREE.Mesh, coinId: number) {
    // Optimistic visual removal + SFX; score is server-authoritative
    // and arrives via the 'scoreboard' message.
    state.scene.remove(coin);
    coinBaseY.delete(coin);
    coinMeshes.delete(coinId);
    playCollectSound();
    spawnParticles(coin.position.x, coin.position.y, coin.position.z, 0xFFD700, 15, 0.4, 1.5, 0.6);

    // Notify server about coin collection (once per coin until confirmed/reset)
    if (!pendingCollects.has(coinId)) {
        pendingCollects.add(coinId);
        sendToServer({ type: 'collectCoin', coinId: coinId });
    }
}
