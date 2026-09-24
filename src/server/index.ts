import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PORT, TERRAIN_CONFIG, HEARTBEAT_INTERVAL_MS } from './config.js';
import { Player } from './types.js';
import { ServerMessage } from '../shared/protocol.js';
import { powerups, trees, coins, cityData, initWorld } from './world.js';
import { players, getPublicPlayers, getScoreboard, randomSpawn } from './state.js';
import { setWss, broadcast, broadcastScoreboard, safeSend } from './net.js';
import { handleClientMessage, cleanupPlayerTimers, applySpawnState } from './handlers.js';
import { hdriMiddleware, versionedAssetCache } from './staticAssets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
// 64 KB cap on inbound frames - guards against memory exhaustion via giant payloads
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
setWss(wss);

// Serve the Vite-built client. This file compiles to dist/server/index.js
// (rootDir is src, so the shared/ modules can be included) and Vite writes the
// client to dist/client, so it is one level up from __dirname both in the
// Docker image (/app/dist/client) and locally (<repo>/dist/client). In dev the
// client is served by the Vite dev server instead, which proxies /ws here.
const clientPath = path.join(__dirname, '../client');
const clientIndexPath = path.join(clientPath, 'index.html');

function preventStaleClientCaching(response: http.ServerResponse) {
    response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    response.setHeader('CDN-Cache-Control', 'no-store');
    response.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
}

if (fs.existsSync(clientIndexPath)) {
    app.get(['/', '/index.html'], (_request, response) => {
        preventStaleClientCaching(response);
        response.sendFile(clientIndexPath);
    });

    app.get('/build-version.txt', (_request, response) => {
        preventStaleClientCaching(response);
        response.sendFile(path.join(clientPath, 'build-version.txt'));
    });

    // Vite puts a content hash into every file name under /assets, so a new
    // build never reuses a URL and these can be cached forever.
    app.use('/assets', express.static(path.join(clientPath, 'assets'), {
        immutable: true,
        maxAge: '1y'
    }));

    // Hashed model and texture URLs cached for good, compressed HDRIs with a
    // content ETag (staticAssets.ts)
    app.use(['/models', '/textures'], versionedAssetCache());
    app.use('/textures/hdri', hdriMiddleware(path.join(clientPath, 'textures', 'hdri')));

    app.use(express.static(clientPath, {
        index: false,
        setHeaders(response, filePath) {
            if (/\.(?:css|html|js|txt)$/.test(filePath)) {
                preventStaleClientCaching(response);
            }
        }
    }));
} else {
    // Expected under "npm run dev": Vite serves the client and proxies /ws here.
    console.warn(`No client build at ${clientPath}, serving the WebSocket only (run "npm run build" for production)`);
}

initWorld();

console.log('Server starting...');

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

    const player: Player = {
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
        lastActivity: Date.now(),
        lastUpdateAt: 0,
        lastHonkAt: 0,
        lastRenameAt: 0,
        lastShotAt: 0,
        respawnShield: true
    };
    players[id] = player;
    // Arm the spawn invulnerability shield (and its server-side expiry cap).
    applySpawnState(player, spawn.x, spawn.z);

    console.log(`Player ${name} (${id}) connected`);

    safeSend(ws, JSON.stringify({
        type: 'init',
        id,
        color,
        name,
        spawn,
        players: getPublicPlayers(),
        powerups,
        coins,
        terrain: TERRAIN_CONFIG,
        trees,
        city: cityData,
        scoreboard: getScoreboard()
    } satisfies ServerMessage));

    ws.on('message', (message: Buffer | string) => {
        let data: unknown;
        try {
            data = JSON.parse(message.toString());
        } catch (e) {
            console.warn('Dropping invalid JSON from', id);
            return;
        }
        // handleClientMessage validates the shape and drops invalid messages.
        try {
            handleClientMessage(id, data);
        } catch (e) {
            console.error('Handler error for type', (data as { type?: unknown } | null)?.type, e);
        }
    });

    ws.on('close', () => {
        const p = players[id];
        if (!p) return;
        console.log(`Player ${p.name} disconnected`);
        cleanupPlayerTimers(p);
        delete players[id];
        broadcast({ type: 'removePlayer', id });
        broadcastScoreboard();
    });

    ws.on('error', (err) => {
        console.warn(`ws error for ${id}`, err);
    });
});

server.listen(PORT, () => {
    console.log(`Listening on port ${PORT}`);
});
