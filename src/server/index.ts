import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    CLOSE_SERVER_FULL,
    EMPTY_ROOM_TTL_MS,
    HEARTBEAT_INTERVAL_MS,
    MAX_CONNECTIONS,
    MAX_PLAYERS_PER_ROOM,
    PORT,
    ROOM_SWEEP_INTERVAL_MS,
    TERRAIN_CONFIG
} from './config.js';
import { DEFAULT_ROOM_KIND, isRoomKind, type ServerMessage } from '../shared/protocol.js';
import { mapFor } from './maps.js';
import { RoomManager } from './rooms/lobby.js';
import { Session } from './session.js';
import { handleClientMessage } from './dispatch.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
// 64 KB cap on inbound frames - guards against memory exhaustion via giant payloads
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

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

const map = mapFor();
const lobby = new RoomManager(map, {
    maxPlayersPerRoom: MAX_PLAYERS_PER_ROOM,
    emptyRoomTtlMs: EMPTY_ROOM_TTL_MS
});
const sessions = new Map<string, Session>();

console.log(`Server starting... (world ${map.worldHash}, ${map.colliders.length} colliders)`);

// Heartbeat - terminate stale connections so the rooms don't accumulate ghosts
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

// Closes extra room instances that stayed empty
const roomSweep = setInterval(() => lobby.sweep(), ROOM_SWEEP_INTERVAL_MS);
roomSweep.unref();

wss.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(roomSweep);
});

// The room kind the client asked for in the URL (/ws?room=freeroam)
function requestedRoomKind(url: string | undefined) {
    const kind = new URL(url ?? '/', 'http://localhost').searchParams.get('room');
    return isRoomKind(kind) ? kind : DEFAULT_ROOM_KIND;
}

wss.on('connection', (ws: WebSocket, request: http.IncomingMessage) => {
    if (sessions.size >= MAX_CONNECTIONS) {
        console.warn(`Turning a connection away: ${sessions.size} open`);
        ws.close(CLOSE_SERVER_FULL, 'server full');
        return;
    }

    const id = uuidv4();
    const color = Math.floor(Math.random() * 0xffffff);
    const name = `Player ${Math.floor(Math.random() * 1000)}`;
    const session = new Session(id, ws, name, color);
    sessions.set(id, session);

    (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    ws.on('pong', () => {
        (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    });

    const member = lobby.join(session, requestedRoomKind(request.url));
    const room = session.room!;
    console.log(`Player ${name} (${id}) connected to ${room.id}`);

    session.send({
        type: 'init',
        id,
        color,
        name,
        ...room.snapshotFor(member),
        terrain: TERRAIN_CONFIG,
        trees: map.world.trees,
        city: map.world.city
    } satisfies ServerMessage);

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
            handleClientMessage(lobby, session, data);
        } catch (e) {
            console.error('Handler error for type', (data as { type?: unknown } | null)?.type, e);
        }
    });

    ws.on('close', () => {
        if (!sessions.delete(id)) return;
        console.log(`Player ${session.name} disconnected from ${session.room?.id ?? 'no room'}`);
        lobby.leave(session);
    });

    ws.on('error', (err) => {
        console.warn(`ws error for ${id}`, err);
    });
});

server.listen(PORT, () => {
    console.log(`Listening on port ${PORT}`);
});
