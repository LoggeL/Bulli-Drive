import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';
import { PORT, TERRAIN_CONFIG } from './config.js';
import { Player } from './types.js';
import { powerups, trees, coins, cityData, initWorld } from './world.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
// 64 KB cap on inbound frames - guards against memory exhaustion via giant payloads
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

// Serve static files from public directory
// Note: In the new structure, public is at the root
const publicPath = path.join(__dirname, '../public');
app.use(express.static(publicPath));

const players: Record<string, Player> = {};
const BASE_SHOT_DAMAGE = 25;
const MEGA_DAMAGE_REDUCTION = 0.4;
const POWERUP_DURATIONS = {
    shield: 8000,
    ghost: 8000,
    size: 5000
} as const;
const MEGA_SCALE = 2.5;
const VALID_CAR_TYPES = ['bulli', 'pickup', 'sport', 'beetle', 'jeep'];
const WORLD_BOUND = 1000;
const MAX_SCORE = 1_000_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

function randomSpawn(): { x: number; z: number } {
    const angle = Math.random() * Math.PI * 2;
    const dist = 40 + Math.random() * 60;
    return { x: Math.cos(angle) * dist, z: Math.sin(angle) * dist };
}

function safeSend(ws: WebSocket, msg: string) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
        ws.send(msg);
    } catch (err) {
        console.warn('ws.send failed', err);
    }
}

initWorld();

console.log(`Server starting...`);

// Heartbeat - terminate stale connections so the players map doesn't accumulate ghosts
const heartbeat = setInterval(() => {
    wss.clients.forEach((client) => {
        const c = client as WebSocket & { isAlive?: boolean };
        if (c.isAlive === false) {
            c.terminate();
            return;
        }
        c.isAlive = false;
        try { c.ping(); } catch { /* ignore */ }
    });
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => clearInterval(heartbeat));

wss.on('connection', (ws: WebSocket) => {
    const id = uuidv4();
    const color = Math.floor(Math.random() * 0xffffff);
    const name = `Player ${Math.floor(Math.random() * 1000)}`;
    const spawn = randomSpawn();

    (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    ws.on('pong', () => {
        (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    });

    players[id] = {
        id,
        ws,
        ready: false,
        color,
        name,
        carType: 'bulli',
        x: spawn.x,
        y: 0,
        z: spawn.z,
        angle: 0,
        flipAngle: 0,
        isFlipping: false,
        score: 0,
        health: 100,
        shieldActive: false,
        ghostActive: false,
        megaActive: false,
        shieldTimeout: undefined,
        ghostTimeout: undefined,
        megaTimeout: undefined,
        lastActivity: Date.now(),
        respawnShield: true
    };

    console.log(`Player ${name} (${id}) connected`);

    safeSend(ws, JSON.stringify({
        type: 'init',
        id,
        color,
        name,
        players: getPublicPlayers(),
        powerups: powerups,
        coins: coins,
        terrain: TERRAIN_CONFIG,
        trees: trees,
        city: cityData,
        scoreboard: getScoreboard()
    }));

    ws.on('message', (message: string) => {
        let data: any;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.warn('Dropping invalid JSON from', id);
            return;
        }
        if (!data || typeof data !== 'object' || typeof data.type !== 'string') {
            return;
        }

        try {
            handleClientMessage(id, data);
        } catch (e) {
            console.error('Handler error for type', data.type, e);
        }
    });

    ws.on('close', () => {
        const player = players[id];
        if (!player) return;
        console.log(`Player ${player.name} disconnected`);
        clearPowerupTimeouts(player);
        delete players[id];
        broadcast({
            type: 'removePlayer',
            id
        });
        broadcastScoreboard();
    });

    ws.on('error', (err) => {
        console.warn(`ws error for ${id}`, err);
    });
});

function handleClientMessage(id: string, data: any) {
    const player = players[id];
    if (!player) return;

    switch (data.type) {
        case 'update': {
            if (!Number.isFinite(data.x) || !Number.isFinite(data.z) ||
                !Number.isFinite(data.angle) || !Number.isFinite(data.flipAngle)) return;
            const y = Number.isFinite(data.y) ? data.y : 0;
            if (Math.abs(data.x) > WORLD_BOUND || Math.abs(data.z) > WORLD_BOUND ||
                Math.abs(y) > 500) return;

            player.x = data.x;
            player.y = y;
            player.z = data.z;
            player.angle = data.angle;
            player.flipAngle = data.flipAngle;
            player.isFlipping = !!data.isFlipping;
            player.scale = player.megaActive ? MEGA_SCALE : 1;
            player.lastActivity = Date.now();

            broadcastPlayerState(id, y, id);
            return;
        }

        case 'collectPowerup': {
            if (typeof data.powerupId !== 'number') return;
            const powerup = powerups.find(p => p.id === data.powerupId);
            // Atomic check-and-set: capture the bool, flip immediately, then act
            if (!powerup || powerup.collected) return;
            powerup.collected = true;

            console.log(`Player ${player.name} collected powerup ${powerup.id} (${powerup.type})`);
            broadcast({
                type: 'powerupCollected',
                powerupId: powerup.id,
                playerId: id
            });

            if (powerup.type === 'shield') {
                activatePowerup(id, 'shieldActive', POWERUP_DURATIONS.shield);
            } else if (powerup.type === 'ghost') {
                activatePowerup(id, 'ghostActive', POWERUP_DURATIONS.ghost);
            } else if (powerup.type === 'size') {
                activatePowerup(id, 'megaActive', POWERUP_DURATIONS.size);
            }

            setTimeout(() => {
                powerup.collected = false;
                broadcast({
                    type: 'powerupReset',
                    powerupId: powerup.id
                });
            }, 20000);
            return;
        }

        case 'collectCoin': {
            if (typeof data.coinId !== 'number') return;
            const coin = coins.find(c => c.id === data.coinId);
            if (!coin || coin.collected) return;
            coin.collected = true;

            console.log(`Player ${player.name} collected coin ${coin.id}`);
            broadcast({
                type: 'coinCollected',
                coinId: coin.id,
                playerId: id
            });

            setTimeout(() => {
                coin.collected = false;
                broadcast({
                    type: 'coinReset',
                    coinId: coin.id
                });
            }, 15000);
            return;
        }

        case 'honk': {
            broadcast({ type: 'honk', id }, id);
            return;
        }

        case 'rename': {
            if (typeof data.name !== 'string') return;
            const cleanName = data.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().substring(0, 20);
            if (!cleanName) return;
            const oldName = player.name;
            player.name = cleanName;
            console.log(`Player ${oldName} renamed to ${player.name}`);
            if (player.ready) {
                broadcast({ type: 'playerRenamed', id, name: player.name });
                broadcastScoreboard();
            }
            return;
        }

        case 'setCarType': {
            if (typeof data.carType !== 'string') return;
            if (!VALID_CAR_TYPES.includes(data.carType)) return;
            player.carType = data.carType;
            return;
        }

        case 'playerReady': {
            if (player.ready) return;
            player.ready = true;
            broadcast({ type: 'newPlayer', player: getPublicPlayer(id) }, id);
            broadcastScoreboard();
            return;
        }

        case 'scoreUpdate': {
            if (typeof data.score !== 'number' || !Number.isFinite(data.score)) return;
            player.score = Math.max(0, Math.min(MAX_SCORE, Math.floor(data.score)));
            broadcastScoreboard();
            return;
        }

        case 'respawnShieldExpired': {
            player.respawnShield = false;
            return;
        }

        case 'shoot': {
            if (typeof data.targetId !== 'string' || data.targetId === id) return;
            const target = players[data.targetId];
            if (!target || target.health <= 0) return;

            // AFK players (no update for 3+ seconds) are invulnerable
            if (Date.now() - target.lastActivity > 3000) return;
            // Respawn shield blocks all damage
            if (target.respawnShield) return;
            // Super jump makes player unhittable (y > 10 = jump powerup height)
            if (target.y > 10) return;

            // Shield blocks one hit
            if (target.shieldActive) {
                target.shieldActive = false;
                if (target.shieldTimeout) {
                    clearTimeout(target.shieldTimeout);
                    target.shieldTimeout = undefined;
                }
                console.log(`Player ${target.name}'s shield blocked shot from ${player.name}`);
                broadcast({
                    type: 'shieldBreak',
                    targetId: data.targetId,
                    shooterId: id
                });
                return;
            }

            const damage = target.megaActive
                ? Math.round(BASE_SHOT_DAMAGE * MEGA_DAMAGE_REDUCTION)
                : BASE_SHOT_DAMAGE;
            target.health -= damage;
            if (target.health < 0) target.health = 0;

            console.log(`Player ${player.name} shot ${target.name} (health: ${target.health})`);

            broadcast({
                type: 'playerHit',
                targetId: data.targetId,
                shooterId: id,
                newHealth: target.health,
                damage
            });

            if (target.health <= 0) {
                broadcast({
                    type: 'playerKilled',
                    targetId: data.targetId,
                    killerId: id,
                    killerName: player.name,
                    targetName: target.name
                });

                player.score += 50;
                broadcastScoreboard();

                // Respawn after 3 seconds at a random location.
                // Re-resolve target inside the timeout so we don't poke a stale reference
                // if the player disconnected (and possibly a new player took the slot).
                const targetId = data.targetId;
                setTimeout(() => {
                    const reborn = players[targetId];
                    if (!reborn) return;
                    const sp = randomSpawn();

                    reborn.health = 100;
                    reborn.x = sp.x;
                    reborn.z = sp.z;
                    reborn.respawnShield = true;
                    reborn.shieldActive = false;
                    reborn.ghostActive = false;
                    reborn.megaActive = false;
                    reborn.scale = 1;
                    clearPowerupTimeouts(reborn);

                    broadcast({
                        type: 'playerRespawn',
                        playerId: targetId,
                        health: 100,
                        x: sp.x,
                        z: sp.z
                    });
                }, 3000);
            }
            return;
        }

        default:
            return;
    }
}

function getPublicPlayer(id: string) {
    const p = players[id];
    return {
        id: p.id,
        color: p.color,
        name: p.name,
        carType: p.carType,
        x: p.x,
        z: p.z,
        angle: p.angle,
        flipAngle: p.flipAngle,
        isFlipping: p.isFlipping,
        scale: p.megaActive ? MEGA_SCALE : 1,
        score: p.score,
        health: p.health
    };
}

function getPublicPlayers() {
    const publicPlayers: Record<string, any> = {};
    for (const id in players) {
        if (!players[id].ready) continue;
        publicPlayers[id] = getPublicPlayer(id);
    }
    return publicPlayers;
}

function getScoreboard() {
    return Object.values(players)
        .filter(p => p.ready)
        .map(p => ({
            id: p.id,
            name: p.name,
            score: p.score,
            color: p.color
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
}

function broadcastScoreboard() {
    broadcast({
        type: 'scoreboard',
        scoreboard: getScoreboard()
    });
}

function activatePowerup(id: string, flag: 'shieldActive' | 'ghostActive' | 'megaActive', durationMs: number) {
    const player = players[id];
    if (!player) return;

    player[flag] = true;
    if (flag === 'megaActive') {
        player.scale = MEGA_SCALE;
    }

    const timeoutKey = (
        flag === 'shieldActive' ? 'shieldTimeout' :
        flag === 'ghostActive' ? 'ghostTimeout' :
        'megaTimeout'
    ) as 'shieldTimeout' | 'ghostTimeout' | 'megaTimeout';

    if (player[timeoutKey]) {
        clearTimeout(player[timeoutKey]);
    }

    broadcastPlayerState(id, player.y);

    player[timeoutKey] = setTimeout(() => {
        const current = players[id];
        if (!current) return;
        current[flag] = false;
        if (flag === 'megaActive') {
            current.scale = 1;
        }
        current[timeoutKey] = undefined;
        broadcastPlayerState(id, current.y);
    }, durationMs);
}

function clearPowerupTimeouts(player: Player) {
    for (const key of ['shieldTimeout', 'ghostTimeout', 'megaTimeout'] as const) {
        if (player[key]) {
            clearTimeout(player[key]);
            player[key] = undefined;
        }
    }
}

function broadcastPlayerState(id: string, y?: number, excludeId?: string) {
    const player = players[id];
    if (!player) return;

    broadcast({
        type: 'update',
        id,
        x: player.x,
        z: player.z,
        y,
        angle: player.angle,
        flipAngle: player.flipAngle,
        isFlipping: player.isFlipping,
        scale: player.megaActive ? MEGA_SCALE : 1,
        ghostActive: player.ghostActive,
        shieldActive: player.shieldActive
    }, excludeId);
}

function broadcast(data: any, excludeId?: string) {
    const msg = JSON.stringify(data);
    const excludeWs = excludeId ? players[excludeId]?.ws : undefined;
    wss.clients.forEach((client) => {
        if (client === excludeWs) return;
        safeSend(client as WebSocket, msg);
    });
}

server.listen(PORT, () => {
    console.log(`Listening on port ${PORT}`);
});
