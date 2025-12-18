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
        players: getPublicPlayers()
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
            } else if (data.type === 'honk') {
                // Broadcast honk event to all other clients
                broadcast({
                    type: 'honk',
                    id
                }, id);
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
