import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';
import { PORT, TERRAIN_CONFIG } from './config.js';
import { Player } from './types.js';
import { powerups, trees, cityData, initWorld } from './world.js';

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

initWorld();

console.log(`Server starting...`);

wss.on('connection', (ws: WebSocket) => {
    const id = uuidv4();
    const color = Math.random() * 0xffffff;
    const name = `Player ${Math.floor(Math.random() * 1000)}`;

    players[id] = {
        id,
        ws,
        color,
        name,
        x: 0,
        z: 0,
        angle: 0,
        flipAngle: 0,
        isFlipping: false,
        score: 0
    };

    console.log(`Player ${name} (${id}) connected`);

    ws.send(JSON.stringify({
        type: 'init',
        id,
        color,
        name,
        players: getPublicPlayers(),
        powerups: powerups,
        terrain: TERRAIN_CONFIG,
        trees: trees,
        city: cityData,
        scoreboard: getScoreboard()
    }));

    broadcast({
        type: 'newPlayer',
        player: getPublicPlayer(id)
    }, id);

    ws.on('message', (message: string) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'update') {
                if (players[id]) {
                    players[id].x = data.x;
                    players[id].z = data.z;
                    players[id].angle = data.angle;
                    players[id].flipAngle = data.flipAngle;
                    players[id].isFlipping = data.isFlipping;
                    players[id].scale = data.scale;

                    broadcast({
                        type: 'update',
                        id,
                        x: data.x,
                        z: data.z,
                        y: data.y,
                        angle: data.angle,
                        flipAngle: data.flipAngle,
                        isFlipping: data.isFlipping,
                        scale: data.scale
                    }, id);
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

                    setTimeout(() => {
                        powerup.collected = false;
                        broadcast({
                            type: 'powerupReset',
                            powerupId: powerup.id
                        });
                    }, 20000);
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

                    broadcast({
                        type: 'playerRenamed',
                        id,
                        name: players[id].name
                    });
                    
                    // Broadcast updated scoreboard with new name
                    broadcastScoreboard();
                }
            } else if (data.type === 'scoreUpdate') {
                if (players[id] && typeof data.score === 'number') {
                    players[id].score = data.score;
                    broadcastScoreboard();
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
        x: p.x,
        z: p.z,
        angle: p.angle,
        flipAngle: p.flipAngle,
        isFlipping: p.isFlipping,
        scale: p.scale,
        score: p.score
    };
}

function getPublicPlayers() {
    const publicPlayers: Record<string, any> = {};
    for (const id in players) {
        publicPlayers[id] = getPublicPlayer(id);
    }
    return publicPlayers;
}

function getScoreboard() {
    return Object.values(players)
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
