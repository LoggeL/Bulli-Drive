const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = 8000;

// Serve static files from current directory
app.use(express.static(__dirname));

const players = {};
const powerups = [];
const trees = [];

// Terrain Configuration
const TERRAIN_CONFIG = {
    size: 1000,
    segments: 64,
    frequency1: 0.02,
    amplitude1: 2,
    frequency2: 0.05,
    amplitude2: 1
};

// Powerup Configuration
const POWERUP_TYPES = [
    { type: 'speed', color: 0xFFD700, label: 'Turbo' },
    { type: 'size', color: 0xFF1493, label: 'Mega' },
    { type: 'jump', color: 0x00FF7F, label: 'Super Jump' }
];

function initWorld() {
    // Init Powerups
    for (let i = 0; i < 15; i++) {
        const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
        powerups.push({
            id: i,
            x: (Math.random() - 0.5) * 400,
            z: (Math.random() - 0.5) * 400,
            type: type.type,
            color: type.color,
            label: type.label,
            collected: false
        });
    }

    // Init Trees
    for (let i = 0; i < 120; i++) {
        const x = (Math.random() - 0.5) * 600;
        const z = (Math.random() - 0.5) * 600;
        if (Math.abs(x) < 40 && Math.abs(z) < 40) continue;
        trees.push({
            id: i,
            x: x,
            z: z,
            height: 4 + Math.random() * 5
        });
    }
}
initWorld();

console.log(`Server started on http://localhost:${PORT}`);

wss.on('connection', (ws) => {
    const id = uuidv4();
    const color = Math.random() * 0xffffff;
    const name = `Player ${Math.floor(Math.random() * 1000)}`;

    // Initial State
    players[id] = {
        id,
        ws,
        color,
        name,
        x: 0,
        z: 0,
        angle: 0,
        flipAngle: 0,
        isFlipping: false
    };

    console.log(`Player ${name} (${id}) connected`);

    // Send welcome message with ID and assigned color/name
    ws.send(JSON.stringify({
        type: 'init',
        id,
        color,
        name,
        players: getPublicPlayers(),
        powerups: powerups,
        terrain: TERRAIN_CONFIG,
        trees: trees
    }));

    // Broadcast new player to others
    broadcast({
        type: 'newPlayer',
        player: getPublicPlayer(id)
    }, id);

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'update') {
                if (players[id]) {
                    players[id].x = data.x;
                    players[id].z = data.z;
                    players[id].angle = data.angle;
                    players[id].flipAngle = data.flipAngle;
                    players[id].isFlipping = data.isFlipping;

                    broadcast({
                        type: 'update',
                        id,
                        x: data.x,
                        z: data.z,
                        angle: data.angle,
                        flipAngle: data.flipAngle,
                        isFlipping: data.isFlipping
                    }, id);
                }
            } else if (data.type === 'collectPowerup') {
                const powerup = powerups.find(p => p.id === data.powerupId);
                if (powerup && !powerup.collected) {
                    powerup.collected = true;
                    console.log(`Player ${players[id]?.name} collected powerup ${powerup.id} (${powerup.type})`);

                    // Broadcast collection to all
                    broadcast({
                        type: 'powerupCollected',
                        powerupId: powerup.id,
                        playerId: id
                    });

                    // Respawn after 20 seconds
                    setTimeout(() => {
                        powerup.collected = false;
                        broadcast({
                            type: 'powerupReset',
                            powerupId: powerup.id
                        });
                    }, 20000);
                }
            } else if (data.type === 'honk') {
                // Broadcast honk event to all other clients
                broadcast({
                    type: 'honk',
                    id
                }, id);
            } else if (data.type === 'rename') {
                if (players[id] && data.name) {
                    const oldName = players[id].name;
                    players[id].name = data.name.substring(0, 20); // Limit name length
                    console.log(`Player ${oldName} renamed to ${players[id].name}`);

                    broadcast({
                        type: 'playerRenamed',
                        id,
                        name: players[id].name
                    });
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
        }
    });
});

function getPublicPlayer(id) {
    const p = players[id];
    return {
        id: p.id,
        color: p.color,
        name: p.name,
        x: p.x,
        z: p.z,
        angle: p.angle,
        flipAngle: p.flipAngle,
        isFlipping: p.isFlipping
    };
}

function getPublicPlayers() {
    const publicPlayers = {};
    for (const id in players) {
        publicPlayers[id] = getPublicPlayer(id);
    }
    return publicPlayers;
}

function broadcast(data, excludeId) {
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
