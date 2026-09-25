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
    MAX_SESSIONS,
    MAX_SOCKETS_PER_ADDRESS,
    NEW_SESSION_BURST_PER_ADDRESS,
    NEW_SESSIONS_PER_MINUTE_PER_ADDRESS,
    PING_EVERY_MS,
    PORT,
    ROOM_SWEEP_INTERVAL_MS,
    SESSION_GRACE_MS
} from './config.js';
import { InputPacketSchema } from '../shared/protocol.js';
import { decodeInputPacket, FRAME_INPUT } from '../shared/net/codec.js';
import { CLOSE_HELLO, CLOSE_POLICY, CLOSE_IDLE, CLOSE_REASON_NO_HELLO, CLOSE_RESTART } from '../shared/net/constants.js';
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
import { hdriMiddleware, terrainMiddleware, versionedAssetCache } from './staticAssets.js';
import { AddressLimits, clientAddress, sessionLog } from './access.js';
import { ClientReports } from './clientReports.js';

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
// Graphics trouble reports from real devices (src/server/clientReports.ts)
const clientReports = new ClientReports();
app.post('/api/client-report', express.json({ limit: '4kb', type: () => true }), (request, response) => {
    const outcome = clientReports.add(clientAddress(request) ?? 'unknown', request.body);
    response.status(outcome === 'stored' ? 204 : outcome === 'limited' ? 429 : 400).end();
});
app.get('/api/client-reports', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json(clientReports.list());
});

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

    // Hashed model and texture URLs cached for good, compressed HDRIs with a
    // content ETag (staticAssets.ts)
    app.use(['/models', '/textures', '/maps'], versionedAssetCache());
    app.use('/textures/hdri', hdriMiddleware(path.join(clientPath, 'textures', 'hdri')));
    app.use('/maps', terrainMiddleware(path.join(clientPath, 'maps')));

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
const addressLimits = new AddressLimits({
    maxSockets: MAX_SOCKETS_PER_ADDRESS,
    helloBurst: NEW_SESSION_BURST_PER_ADDRESS,
    hellosPerMinute: NEW_SESSIONS_PER_MINUTE_PER_ADDRESS
});
let kicks = 0;
let shuttingDown = false;

console.log(`Server starting... (map ${map.mapId} v${map.mapVersion}, world ${map.worldHash}, ${map.colliders.length} colliders, build ${SERVER_BUILD ?? 'dev'})`);

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
        connection.ping(now);
    }
}, PING_EVERY_MS);

// Closes extra room instances that stayed empty
const roomSweep = setInterval(() => lobby.sweep(), ROOM_SWEEP_INTERVAL_MS);
roomSweep.unref();

// Sessions whose player did not come back in time leave their room
const graceSweep = setInterval(() => {
    for (const session of sessions.expire(performance.now())) {
        sessionLog.log(`Player ${session.name} (${session.id}) did not come back; leaving ${session.room?.id ?? 'no room'}`);
        lobby.leave(session);
    }
    addressLimits.sweep(performance.now());
}, 1000);
graceSweep.unref();

const trafficSampler = setInterval(() => traffic.sample(performance.now()), 5000);
trafficSampler.unref();
traffic.sample(performance.now());

lobby.onIdleKick = (session) => kick(session, 'idle');

// A session gone for good before its grace time ends: pushed out by a new
// one (MAX_SESSIONS), or never a player (no input) when its socket closed
function dropSession(session: Session, why: string): void {
    sessionLog.log(`Player ${session.name} (${session.id}) ${why}; leaving ${session.room?.id ?? 'no room'}`);
    lobby.leave(session);
    sessions.remove(session);
}

const handshake = {
    lobby, serverBuild: SERVER_BUILD, sessions, tickets,
    maxSessions: MAX_SESSIONS,
    evict: (session: Session) => dropSession(session, 'made room for a new player')
};

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
    session.sentInput = true;
    const packet = decodeInputPacket(bytes);
    if (!packet || !v.safeParse(InputPacketSchema, packet).success) {
        if (session.noteInvalid(now)) kick(session, 'policy');
        return;
    }
    const room = session.room, member = session.member;
    if (room && member) room.onInput(member, packet, now);
}

wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    if (shuttingDown) {
        ws.close(CLOSE_RESTART, 'restart');
        return;
    }
    if (connections.size >= MAX_CONNECTIONS) {
        console.warn(`Turning a connection away: ${connections.size} open`);
        reject(ws, 'full');
        return;
    }
    const address = clientAddress(req);
    if (!addressLimits.openSocket(address, performance.now())) {
        console.warn(`Turning a connection away: ${address} has ${MAX_SOCKETS_PER_ADDRESS} open`);
        reject(ws, 'full');
        return;
    }
    const connection = new SocketConnection(ws, traffic, netsim);
    connections.add(connection);
    const context = { ...handshake, admitNewSession: () => addressLimits.admitNewSession(address, performance.now()) };
    let session: Session | null = null;
    ws.on('pong', (payload: Buffer) => connection.inbound(false, payload.length, () => {
        const now = performance.now();
        connection.lastPongAt = now;
        const rtt = connection.pongRtt(payload, now);
        if (rtt !== null && session && session.transport === connection) session.noteRtt(rtt);
    }));

    const helloTimer = setTimeout(() => {
        if (!session) connection.close(CLOSE_HELLO, CLOSE_REASON_NO_HELLO);
    }, HELLO_TIMEOUT_MS);

    const handle = (data: Buffer, isBinary: boolean) => {
        try {
            if (!session) {
                if (isBinary) {
                    reject(connection, 'hello');
                    return;
                }
                const result = acceptHelloResult(connection, data.toString(), context);
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
            const admit = session.admitMessage(performance.now());
            if (admit === 'kick') return kick(session, 'policy');
            if (admit === 'drop') return;
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
        addressLimits.closeSocket(address);
        connection.dispose();
        clearTimeout(helloTimer);
        if (!session || shuttingDown) return;
        // Taken over by a newer socket, or kicked: nothing to do
        if (session.transport !== connection || !sessions.has(session)) return;
        // Never sent an input: nothing to come back to, no ghost car
        if (!session.sentInput) return dropSession(session, 'closed before playing');
        sessions.disconnect(session, performance.now());
        sessionLog.log(`Player ${session.name} lost the connection in ${session.room?.id ?? 'no room'} (waiting ${SESSION_GRACE_MS / 1000} s)`);
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
