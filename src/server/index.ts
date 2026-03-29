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
const wss = new WebSocketServer({ server });

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

initWorld();

console.log(`Server starting...`);

wss.on('connection', (ws: WebSocket) => {
    const id = uuidv4();
    const color = Math.random() * 0xffffff;
    const name = `Player ${Math.floor(Math.random() * 1000)}`;

    players[id] = {
        id,
        ws,
        ready: false,
        color,
        name,
        carType: 'bulli',
        x: 0,
        y: 0,
        z: 0,
        angle: 0,
        flipAngle: 0,
        isFlipping: false,
        score: 0,
        health: 100,
        shieldActive: false,
        ghostActive: false,
        megaActive: false,
        lastActivity: Date.now(),
        respawnShield: true
    };

    console.log(`Player ${name} (${id}) connected`);

    ws.send(JSON.stringify({
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
        try {
            const data = JSON.parse(message);

            if (data.type === 'update') {
                if (players[id]) {
                    players[id].x = data.x;
                    players[id].y = data.y || 0;
                    players[id].z = data.z;
                    players[id].angle = data.angle;
                    players[id].flipAngle = data.flipAngle;
                    players[id].isFlipping = data.isFlipping;
                    players[id].scale = players[id].megaActive ? MEGA_SCALE : 1;
                    players[id].lastActivity = Date.now();

                    broadcastPlayerState(id, data.y, id);
                }
            } else if (data.type === 'collectPowerup') {
                const powerup = powerups.find(p => p.id === data.powerupId);
                if (powerup && !powerup.collected) {
                    powerup.collected = true;
                    console.log(`Player ${players[id]?.name} collected powerup ${powerup.id} (${powerup.type})`);

                    broadcast({
                        type: 'powerupCollected',
                        powerupId: powerup.id,
                        playerId: id
                    });

                    if (players[id]) {
                        if (powerup.type === 'shield') {
                            activatePowerup(id, 'shieldActive', POWERUP_DURATIONS.shield);
                        } else if (powerup.type === 'ghost') {
                            activatePowerup(id, 'ghostActive', POWERUP_DURATIONS.ghost);
                        } else if (powerup.type === 'size') {
                            activatePowerup(id, 'megaActive', POWERUP_DURATIONS.size);
                        }
                    }

                    setTimeout(() => {
                        powerup.collected = false;
                        broadcast({
                            type: 'powerupReset',
                            powerupId: powerup.id
                        });
                    }, 20000);
                }
            } else if (data.type === 'collectCoin') {
                const coin = coins.find(c => c.id === data.coinId);
                if (coin && !coin.collected) {
                    coin.collected = true;
                    console.log(`Player ${players[id]?.name} collected coin ${coin.id}`);

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
                }
            } else if (data.type === 'honk') {
                broadcast({
                    type: 'honk',
                    id
                }, id);
            } else if (data.type === 'rename') {
                if (players[id] && data.name) {
                    const oldName = players[id].name;
                    players[id].name = data.name.substring(0, 20);
                    console.log(`Player ${oldName} renamed to ${players[id].name}`);

                    if (players[id].ready) {
                        broadcast({
                            type: 'playerRenamed',
                            id,
                            name: players[id].name
                        });
                        
                        // Broadcast updated scoreboard with new name
                        broadcastScoreboard();
                    }
                }
            } else if (data.type === 'setCarType') {
                if (players[id] && data.carType) {
                    const validTypes = ['bulli', 'pickup', 'sport', 'beetle', 'jeep'];
                    if (validTypes.includes(data.carType)) {
                        players[id].carType = data.carType;
                    }
                }
            } else if (data.type === 'playerReady') {
                if (players[id] && !players[id].ready) {
                    players[id].ready = true;
                    broadcast({
                        type: 'newPlayer',
                        player: getPublicPlayer(id)
                    }, id);
                    broadcastScoreboard();
                }
            } else if (data.type === 'scoreUpdate') {
                if (players[id] && typeof data.score === 'number') {
                    players[id].score = data.score;
                    broadcastScoreboard();
                }
            } else if (data.type === 'respawnShieldExpired') {
                if (players[id]) {
                    players[id].respawnShield = false;
                }
            } else if (data.type === 'shoot') {
                const target = players[data.targetId];
                if (target && target.health > 0 && data.targetId !== id) {
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
                        console.log(`Player ${target.name}'s shield blocked shot from ${players[id]?.name}`);
                        broadcast({
                            type: 'shieldBreak',
                            targetId: data.targetId,
                            shooterId: id
                        });
                        return;
                    }

                    // Mega form is tougher and shrugs off a chunk of incoming damage.
                    const damage = target.megaActive
                        ? Math.round(BASE_SHOT_DAMAGE * MEGA_DAMAGE_REDUCTION)
                        : BASE_SHOT_DAMAGE;
                    target.health -= damage;
                    if (target.health < 0) target.health = 0;

                    console.log(`Player ${players[id]?.name} shot ${target.name} (health: ${target.health})`);

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
                            killerName: players[id]?.name || 'Unknown',
                            targetName: target.name
                        });

                        // Award killer 50 points
                        if (players[id]) {
                            players[id].score += 50;
                            broadcastScoreboard();
                        }

                        // Respawn after 3 seconds at random location
                        const targetId = data.targetId;
                        setTimeout(() => {
                            if (players[targetId]) {
                                const angle = Math.random() * Math.PI * 2;
                                const dist = 40 + Math.random() * 60;
                                const spawnX = Math.cos(angle) * dist;
                                const spawnZ = Math.sin(angle) * dist;

                                players[targetId].health = 100;
                                players[targetId].x = spawnX;
                                players[targetId].z = spawnZ;
                                players[targetId].respawnShield = true;
                                players[targetId].shieldActive = false;
                                players[targetId].ghostActive = false;
                                players[targetId].megaActive = false;
                                players[targetId].scale = 1;
                                clearPowerupTimeouts(players[targetId]);

                                broadcast({
                                    type: 'playerRespawn',
                                    playerId: targetId,
                                    health: 100,
                                    x: spawnX,
                                    z: spawnZ
                                });
                            }
                        }, 3000);
                    }
                }
            }
        } catch (e) {
            console.error('Error parsing message', e);
        }
    });

    ws.on('close', () => {
        console.log(`Player ${players[id]?.name} disconnected`);
        if (players[id]) {
            delete players[id];
            broadcast({
                type: 'removePlayer',
                id
            });
            broadcastScoreboard();
        }
    });
});

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
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            let shouldSend = true;
            if (excludeId && players[excludeId] && client === players[excludeId].ws) {
                shouldSend = false;
            }

            if (shouldSend) {
                client.send(msg);
            }
        }
    });
}

server.listen(PORT, () => {
    console.log(`Listening on port ${PORT}`);
});
