import * as THREE from 'three';
import { state } from '../state.js';
import { groundHeight } from './environment.js';
import { playCollectSound } from '../effects/sounds.js';
import { spawnParticles } from '../effects/particles.js';
import { MAGNET_RANGE } from '../../shared/constants.js';
import { CLIENT_COIN_CONFIRM_MS, CLIENT_COIN_MAGNET_RADIUS, CLIENT_COIN_RADIUS } from '../../shared/party/rules.js';
import { distSq2D } from './util.js';
import { netDriver } from '../net/netDriver.js';
import type { CoinData } from '../../shared/protocol.js';

// Store base Y for bobbing animation
const coinBaseY: Map<THREE.Mesh, number> = new Map();
// Map coin server ID to mesh
const coinMeshes: Map<number, THREE.Mesh> = new Map();
// Coins the local car took before the server confirmed them (8.7): the
// time they were taken; without a pickup event they come back
const pendingCollects = new Map<number, number>();
// Coins the server gave the local car while the magnet still pulls them in:
// they fly on and are taken (without a new confirmation) when they arrive
const confirmedFlying = new Set<number>();
// Buffer, snapshot interval and jitter on top of the round trip
const COIN_CONFIRM_MARGIN_MS = 300;

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
    const baseY = groundHeight(x, z) + 2.0;
    coin.position.set(x, baseY, z);
    coin.castShadow = true;
    (coin as any).coinId = id;
    state.scene.add(coin);
    state.coins.push(coin);
    coinBaseY.set(coin, baseY);
    coinMeshes.set(id, coin);
}

// Removes every coin (a room switch brings the new room's coins)
export function clearCoins() {
    for (const coin of coinMeshes.values()) state.scene.remove(coin);
    for (const coin of state.coins) state.scene.remove(coin);
    coinMeshes.clear();
    coinBaseY.clear();
    pendingCollects.clear();
    confirmedFlying.clear();
    state.coins.length = 0;
}

function markCollected(coinId: number, collected: boolean) {
    const data = state.serverCoins?.find((c: CoinData) => c.id === coinId);
    if (data) data.collected = collected;
}

// Another player took the coin
export function removeCoinById(coinId: number) {
    pendingCollects.delete(coinId);
    confirmedFlying.delete(coinId);
    markCollected(coinId, true);
    removeCoinMesh(coinId);
}

/** The server confirmed the local car's pickup; if it was not taken here yet it goes now. */
export function confirmCoinPickup(coinId: number) {
    markCollected(coinId, true);
    const wasPending = pendingCollects.delete(coinId);
    if (!wasPending && coinMeshes.has(coinId)) {
        const coin = coinMeshes.get(coinId)!;
        // The magnet pulls it in: let it arrive (checkCoinCollection)
        const car = state.bulli?.group.position;
        if (car && state.bulli!.powerups.magnet.active
            && distSq2D(car.x, car.z, coin.position.x, coin.position.z) < MAGNET_RANGE * MAGNET_RANGE) {
            confirmedFlying.add(coinId);
            return;
        }
        collectCoin(coin, coinId);
        pendingCollects.delete(coinId);
        const idx = state.coins.indexOf(coin);
        if (idx !== -1) state.coins.splice(idx, 1);
    }
}

function removeCoinMesh(coinId: number) {
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
    confirmedFlying.delete(coinId);
    markCollected(coinId, false);
    showCoinAgain(coinId);
}

function showCoinAgain(coinId: number) {
    if (coinMeshes.has(coinId)) return; // already visible, nothing to recreate
    // Find original position from server data stored in state
    const cd = state.serverCoins?.find((c: CoinData) => c.id === coinId);
    if (cd) {
        createCoin(cd.id, cd.x, cd.z);
    }
}

// 'time' is state.clock.getElapsed() in seconds; derive real dt from the delta
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
                const newBaseY = groundHeight(coin.position.x, coin.position.z) + 2.0;
                coinBaseY.set(coin, newBaseY);
            }
        }
    });
}

export function checkCoinCollection() {
    // Taken coins the server did not confirm come back. The confirmation
    // needs about a round trip (the server runs the tick a lead later and
    // answers with the next snapshot): on a slow net wait longer than 600 ms
    const now = performance.now();
    const confirmMs = Math.max(CLIENT_COIN_CONFIRM_MS, netDriver.clock.rtt + COIN_CONFIRM_MARGIN_MS);
    for (const [coinId, takenAt] of pendingCollects) {
        if (now - takenAt < confirmMs) continue;
        pendingCollects.delete(coinId);
        const data = state.serverCoins?.find((c: CoinData) => c.id === coinId);
        if (data && !data.collected) showCoinAgain(coinId);
    }
    if (!state.bulli || state.dead) return;
    const carPos = state.bulli.group.position;
    const magnetActive = state.bulli.powerups.magnet.active;
    // Confirmed coins still flying in when the magnet ends arrive at once
    if (!magnetActive && confirmedFlying.size > 0) {
        for (const coinId of [...confirmedFlying]) takeConfirmed(coinId);
    }
    const collectRadius = magnetActive ? CLIENT_COIN_MAGNET_RADIUS : CLIENT_COIN_RADIUS;
    const collectRadiusSq = collectRadius * collectRadius;
    for (let i = state.coins.length - 1; i >= 0; i--) {
        const coin = state.coins[i];
        if (distSq2D(carPos.x, carPos.z, coin.position.x, coin.position.z) < collectRadiusSq) {
            const coinId = (coin as any).coinId as number;
            if (confirmedFlying.has(coinId)) {
                takeConfirmed(coinId);
                continue;
            }
            collectCoin(coin, coinId);
            state.coins.splice(i, 1);
        }
    }
}

// A coin the server already gave the local car arrives: sound and sparkle,
// nothing to wait for
function takeConfirmed(coinId: number) {
    confirmedFlying.delete(coinId);
    const coin = coinMeshes.get(coinId);
    if (!coin) return;
    collectCoin(coin, coinId);
    pendingCollects.delete(coinId);
    const idx = state.coins.indexOf(coin);
    if (idx !== -1) state.coins.splice(idx, 1);
}

export function collectCoin(coin: THREE.Mesh, coinId: number) {
    // Optimistic visual removal + SFX; score is server-authoritative
    // and arrives via the 'scoreboard' message.
    state.scene.remove(coin);
    coinBaseY.delete(coin);
    coinMeshes.delete(coinId);
    playCollectSound();
    spawnParticles(coin.position.x, coin.position.y, coin.position.z, 0xFFD700, 15, 0.4, 1.5, 0.6);

    // The server decides with its own car; this waits for its pickup event
    pendingCollects.set(coinId, performance.now());
}
