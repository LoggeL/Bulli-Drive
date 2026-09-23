import express from 'express';
import http from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
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
    ROOM_SWEEP_INTERVAL_MS,
    SESSION_GRACE_MS
} from './config.js';
import { InputPacketSchema } from '../shared/protocol.js';
import { decodeInputPacket, FRAME_INPUT } from '../shared/net/codec.js';
import { CLOSE_HELLO, CLOSE_POLICY, CLOSE_IDLE, CLOSE_RESTART } from '../shared/net/constants.js';
import { tuningIsDefault } from '../shared/sim/tuning.js';
import * as v from 'valibot';
import { mapFor } from './maps.js';
import { RoomManager } from './rooms/lobby.js';
import { roomOptions } from './rooms/Room.js';
import type { Session } from './session.js';
import { SessionRegistry } from './sessions.js';
import { handleClientMessage } from './dispatch.js';
import { acceptHelloResult, reject } from './handshake.js';
import { TickScheduler } from './tick.js';
import { healthReport, metricsReport, TrafficMeter, type HealthSources } from './health.js';
import { TicketSigner } from './resumeTicket.js';
import { gracefulShutdown } from './shutdown.js';
import { netsimFromEnv, SocketConnection } from './connection.js';

// A crash leaves the process in an unknown state: log it and exit, the
// restart policy starts a fresh one (docs/phase-1b-design.md, 11.2)
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception, exiting', err);
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection, exiting', reason);
    process.exit(1);
});

const startedAtMs = performance.now();

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

// Health and metrics (docs/phase-1b-design.md, 11.4 and 12). Defined
// further down once the scheduler exists; the routes come first so they
// also answer in dev, where Vite serves the client.
let healthSources: HealthSources | null = null;
app.get('/healthz', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (!healthSources) {
        response.status(503).json({ ok: false });
        return;
    }
    const report = healthReport(healthSources, performance.now());
    response.status(report.ok ? 200 : 503).json(report);
});
if (process.env.METRICS === '1') {
    app.get('/metrics.json', (_request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        response.json(healthSources ? metricsReport(healthSources, performance.now()) : {});
    });
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
// Sessions by id and token, with the grace time after a lost connection
// (11.1); the open sockets; the resume tickets for restarts (11.3); the
// dev netsim (11.5)
const sessions = new SessionRegistry(SESSION_GRACE_MS);
const connections = new Set<SocketConnection>();
const tickets = TicketSigner.fromEnv();
const netsim = netsimFromEnv();
const traffic = new TrafficMeter();
let kicks = 0;
let shuttingDown = false;

console.log(`Server starting... (world ${map.worldHash}, ${map.colliders.length} colliders, build ${SERVER_BUILD ?? 'dev'})`);

// 60 Hz for every room with members (docs/phase-1b-design.md, 5.1)
const scheduler = new TickScheduler(() => lobby.stepAll(performance.now()));
scheduler.start();

healthSources = {
    scheduler,
    lobby,
    sessions,
    traffic,
    build: SERVER_BUILD,
    startedAtMs,
    connections: () => connections.size,
    kicks: () => kicks,
    shuttingDown: () => shuttingDown
};

// WebSocket pings: liveness (terminate stale connections; their sessions go
// into the grace time) and the round trip for the lag ghost
const pinger = setInterval(() => {
    const now = performance.now();
    for (const connection of connections) {
        if (now - connection.lastPongAt > DEAD_SOCKET_MS) {
            connection.terminate();
            continue;
        }
        const payload = Buffer.alloc(8);
        payload.writeDoubleLE(now);
        connection.ping(payload);
    }
}, PING_EVERY_MS);

// Closes extra room instances that stayed empty
const roomSweep = setInterval(() => lobby.sweep(), ROOM_SWEEP_INTERVAL_MS);
roomSweep.unref();

// Sessions whose player did not come back in time leave their room
const graceSweep = setInterval(() => {
    for (const session of sessions.expire(performance.now())) {
        console.log(`Player ${session.name} (${session.id}) did not come back; leaving ${session.room?.id ?? 'no room'}`);
        lobby.leave(session);
    }
}, 1000);
graceSweep.unref();

const trafficSampler = setInterval(() => traffic.sample(performance.now()), 5000);
trafficSampler.unref();
traffic.sample(performance.now());

lobby.onIdleKick = (session) => kick(session, 'idle');

const handshake = { lobby, serverBuild: SERVER_BUILD, sessions, tickets };

wss.on('close', () => {
    clearInterval(pinger);
    clearInterval(roomSweep);
    clearInterval(graceSweep);
    clearInterval(trafficSampler);
    scheduler.stop();
});

// No grace after a kick: the session is gone
function kick(session: Session, reason: 'policy' | 'idle'): void {
    if (session.kicked) return;
    session.kicked = true;
    kicks++;
    console.warn(`Kicking ${session.name} (${session.id}): ${reason}`);
    session.send({ type: 'kicked', reason });
    lobby.leave(session, 'kicked');
    sessions.remove(session);
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
    if (shuttingDown) {
        ws.close(CLOSE_RESTART, 'restart');
        return;
    }
    if (connections.size >= MAX_CONNECTIONS) {
        console.warn(`Turning a connection away: ${connections.size} open`);
        reject(ws, 'full');
        return;
    }
    const connection = new SocketConnection(ws, traffic, netsim);
    connections.add(connection);
    let session: Session | null = null;
    ws.on('pong', (payload: Buffer) => connection.inbound(false, payload.length, () => {
        const now = performance.now();
        connection.lastPongAt = now;
        if (session && session.transport === connection && payload.length === 8) {
            session.noteRtt(Math.max(0, now - payload.readDoubleLE(0)));
        }
    }));

    const helloTimer = setTimeout(() => {
        if (!session) connection.close(CLOSE_HELLO, 'no hello');
    }, HELLO_TIMEOUT_MS);

    const handle = (data: Buffer, isBinary: boolean) => {
        try {
            if (!session) {
                if (isBinary) {
                    reject(connection, 'hello');
                    return;
                }
                const result = acceptHelloResult(connection, data.toString(), handshake);
                if (result) {
                    session = result.session;
                    clearTimeout(helloTimer);
                }
                return;
            }
            // A socket whose session another socket took over is ignored
            if (session.kicked || session.transport !== connection) return;
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
    };
    ws.on('message', (data: Buffer, isBinary: boolean) => connection.inbound(isBinary, data.length, () => handle(data, isBinary)));

    ws.on('close', () => {
        connections.delete(connection);
        connection.dispose();
        clearTimeout(helloTimer);
        if (!session || shuttingDown) return;
        // Taken over by a newer socket, or kicked: nothing to do
        if (session.transport !== connection || !sessions.has(session)) return;
        sessions.disconnect(session, performance.now());
        console.log(`Player ${session.name} lost the connection in ${session.room?.id ?? 'no room'} (waiting ${SESSION_GRACE_MS / 1000} s)`);
    });

    ws.on('error', (err) => {
        console.warn('ws error', err);
    });
});

// Graceful shutdown (11.2): SIGTERM from a deploy or docker stop, SIGINT
// from the terminal (a second SIGINT exits at once)
function onSignal(signal: NodeJS.Signals): void {
    if (shuttingDown) {
        if (signal === 'SIGINT') process.exit(1);
        return;
    }
    shuttingDown = true;
    void gracefulShutdown({
        stopAccepting: () => {
            server.close();
            wss.close();
        },
        stopTicking: () => scheduler.stop(),
        sessions: () => sessions.all(),
        tickets,
        socketsOpen: () => connections.size,
        closeAll: (code, reason) => {
            for (const connection of connections) connection.close(code, reason);
        },
        exit: code => process.exit(code),
        wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
        log: message => console.log(message)
    }, signal);
}
process.on('SIGTERM', onSignal);
process.on('SIGINT', onSignal);

server.listen(PORT, () => {
    console.log(`Listening on port ${PORT}`);
});
