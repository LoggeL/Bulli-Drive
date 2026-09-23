import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    DEAD_SOCKET_MS,
    EMPTY_ROOM_TTL_MS,
    HELLO_TIMEOUT_MS,
    MAX_CONNECTIONS,
    MAX_PLAYERS_PER_ROOM,
    PING_EVERY_MS,
    PORT,
    ROOM_SWEEP_INTERVAL_MS
} from './config.js';
import { InputPacketSchema } from '../shared/protocol.js';
import { decodeInputPacket, FRAME_INPUT } from '../shared/net/codec.js';
import { CLOSE_HELLO, CLOSE_POLICY, CLOSE_IDLE } from '../shared/net/constants.js';
import { tuningIsDefault } from '../shared/sim/tuning.js';
import * as v from 'valibot';
import { mapFor } from './maps.js';
import { RoomManager } from './rooms/lobby.js';
import { roomOptions } from './rooms/Room.js';
import { Session } from './session.js';
import { handleClientMessage } from './dispatch.js';
import { acceptHello, reject } from './handshake.js';
import { TickScheduler } from './tick.js';

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

// The build stamp of the client this server serves; a page with another
// stamp reloads once after 'welcome' (docs/phase-1b-design.md, 3.2)
function readServerBuild(): string | null {
    try {
        const version = fs.readFileSync(path.join(clientPath, 'build-version.txt'), 'utf8').trim();
        return /^[a-f0-9]{16}$/.test(version) ? version : null;
    } catch {
        return null;
    }
}
const SERVER_BUILD = readServerBuild();

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

// Online every car drives with the shipped tuning (docs/phase-1b-design.md,
// 5.3): a changed default here would be an accidental import
if (!tuningIsDefault()) {
    console.error('The sim tuning differs from the defaults; refusing to start');
    process.exit(1);
}

// debugPlace only for the e2e tests (Playwright starts the server with E2E=1)
roomOptions.allowDebugPlace = process.env.E2E === '1';

const map = mapFor();
const lobby = new RoomManager(map, {
    maxPlayersPerRoom: MAX_PLAYERS_PER_ROOM,
    emptyRoomTtlMs: EMPTY_ROOM_TTL_MS
});
// Sessions by player id, and the sockets of connections before 'hello'
const sessions = new Map<string, Session>();
let connections = 0;

console.log(`Server starting... (world ${map.worldHash}, ${map.colliders.length} colliders, build ${SERVER_BUILD ?? 'dev'})`);

// 60 Hz for every room with members (docs/phase-1b-design.md, 5.1)
const scheduler = new TickScheduler(() => lobby.stepAll(performance.now()));
scheduler.start();

type Socket = WebSocket & { lastPongAt?: number };

// WebSocket pings: liveness (terminate stale connections so the rooms don't
// accumulate ghosts) and the round trip for the lag ghost
const pinger = setInterval(() => {
    const now = performance.now();
    wss.clients.forEach((client) => {
        const socket = client as Socket;
        if (socket.lastPongAt !== undefined && now - socket.lastPongAt > DEAD_SOCKET_MS) {
            socket.terminate();
            return;
        }
        const payload = Buffer.alloc(8);
        payload.writeDoubleLE(now);
        try { socket.ping(payload); } catch { /* ignore */ }
    });
}, PING_EVERY_MS);

// Closes extra room instances that stayed empty
const roomSweep = setInterval(() => lobby.sweep(), ROOM_SWEEP_INTERVAL_MS);
roomSweep.unref();

lobby.onIdleKick = (session) => kick(session, 'idle');

const handshake = { lobby, serverBuild: SERVER_BUILD };

wss.on('close', () => {
    clearInterval(pinger);
    clearInterval(roomSweep);
    scheduler.stop();
});

function kick(session: Session, reason: 'policy' | 'idle'): void {
    if (session.kicked) return;
    session.kicked = true;
    console.warn(`Kicking ${session.name} (${session.id}): ${reason}`);
    session.send({ type: 'kicked', reason });
    lobby.leave(session, 'kicked');
    session.transport.close(reason === 'policy' ? CLOSE_POLICY : CLOSE_IDLE, reason);
}

function onInputFrame(session: Session, bytes: Uint8Array): void {
    const now = performance.now();
    const admit = session.admitInput(now);
    if (admit === 'kick') return kick(session, 'policy');
    if (admit === 'drop') return;
    const packet = decodeInputPacket(bytes);
    if (!packet || !v.safeParse(InputPacketSchema, packet).success) {
        if (session.noteInvalid(now)) kick(session, 'policy');
        return;
    }
    const room = session.room, member = session.member;
    if (room && member) room.onInput(member, packet, now);
}

wss.on('connection', (ws: WebSocket) => {
    if (connections >= MAX_CONNECTIONS) {
        console.warn(`Turning a connection away: ${connections} open`);
        reject(ws, 'full');
        return;
    }
    connections++;
    let session: Session | null = null;
    const socket = ws as Socket;
    socket.lastPongAt = performance.now();
    ws.on('pong', (payload: Buffer) => {
        const now = performance.now();
        socket.lastPongAt = now;
        if (session && payload.length === 8) session.noteRtt(Math.max(0, now - payload.readDoubleLE(0)));
    });

    const helloTimer = setTimeout(() => {
        if (!session) ws.close(CLOSE_HELLO, 'no hello');
    }, HELLO_TIMEOUT_MS);

    ws.on('message', (data: Buffer, isBinary: boolean) => {
        try {
            if (!session) {
                if (isBinary) {
                    reject(ws, 'hello');
                    return;
                }
                session = acceptHello(ws, data.toString(), handshake);
                if (session) sessions.set(session.id, session);
                if (session) clearTimeout(helloTimer);
                return;
            }
            if (session.kicked) return;
            if (isBinary) {
                if (data.length > 0 && data[0] === FRAME_INPUT) onInputFrame(session, data);
                else if (session.noteInvalid(performance.now())) kick(session, 'policy');
                return;
            }
            let parsed: unknown;
            try {
                parsed = JSON.parse(data.toString());
            } catch {
                parsed = undefined;
            }
            const result = handleClientMessage(lobby, session, parsed, performance.now());
            if (result === 'invalid' && session.noteInvalid(performance.now())) kick(session, 'policy');
        } catch (e) {
            console.error('Handler error', e);
        }
    });

    ws.on('close', () => {
        connections--;
        clearTimeout(helloTimer);
        if (!session) return;
        if (!sessions.delete(session.id)) return;
        console.log(`Player ${session.name} disconnected from ${session.room?.id ?? 'no room'}`);
        lobby.leave(session);
    });

    ws.on('error', (err) => {
        console.warn('ws error', err);
    });
});

server.listen(PORT, () => {
    console.log(`Listening on port ${PORT}`);
});
