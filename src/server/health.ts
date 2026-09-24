import type { RoomManager } from './rooms/lobby.js';
import type { SessionRegistry } from './sessions.js';
import type { TickScheduler } from './tick.js';

// /healthz and /metrics.json (docs/phase-1b-design.md, 11.4 and 12). The
// process is healthy while the tick scheduler has run within the last
// second; a blocked event loop does not answer at all, which the Docker
// HEALTHCHECK counts as unhealthy too.

export const HEALTHY_TICK_AGE_MS = 1000;

// Bytes in and out of all sockets, and the rate over the last window
export class TrafficMeter {
    bytesIn = 0;
    bytesOut = 0;
    messagesIn = 0;
    messagesOut = 0;
    inPerSec = 0;
    outPerSec = 0;
    private windowStart = -1;
    private windowIn = 0;
    private windowOut = 0;

    noteIn(bytes: number): void {
        this.bytesIn += bytes;
        this.messagesIn++;
    }

    noteOut(bytes: number): void {
        this.bytesOut += bytes;
        this.messagesOut++;
    }

    /** Closes a rate window (called every few seconds). */
    sample(nowMs: number): void {
        if (this.windowStart >= 0 && nowMs > this.windowStart) {
            const seconds = (nowMs - this.windowStart) / 1000;
            this.inPerSec = Math.round((this.bytesIn - this.windowIn) / seconds);
            this.outPerSec = Math.round((this.bytesOut - this.windowOut) / seconds);
        }
        this.windowStart = nowMs;
        this.windowIn = this.bytesIn;
        this.windowOut = this.bytesOut;
    }
}

export interface HealthSources {
    scheduler: TickScheduler;
    lobby: RoomManager;
    sessions: SessionRegistry;
    traffic: TrafficMeter;
    build: string | null;
    startedAtMs: number;
    connections(): number;
    kicks(): number;
    shuttingDown(): boolean;
}

export interface HealthReport {
    ok: boolean;
    uptimeS: number;
    build: string | null;
    rooms: number;
    players: number;
    sessions: number;
    graceSessions: number;
    connections: number;
    lastTickAgeMs: number;
    tickMeanMs: number;
    tickP95Ms: number;
    tickP99Ms: number;
    overruns: number;
    bytesInPerSec: number;
    bytesOutPerSec: number;
    kicks: number;
    shuttingDown: boolean;
    // Memory of the process (MB), for soak runs (24/7, 18)
    heapUsedMb: number;
    rssMb: number;
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

function memoryMb(): { heapUsedMb: number; rssMb: number } {
    const memory = process.memoryUsage();
    return { heapUsedMb: Math.round(memory.heapUsed / 1e5) / 10, rssMb: Math.round(memory.rss / 1e5) / 10 };
}

/** The health report at clock time now (ms on the scheduler's clock). */
export function healthReport(src: HealthSources, nowMs: number): HealthReport {
    const metrics = src.scheduler.metrics;
    const lastTickAgeMs = src.scheduler.lastTickAt < 0 ? Infinity : nowMs - src.scheduler.lastTickAt;
    const shuttingDown = src.shuttingDown();
    return {
        ok: !shuttingDown && src.scheduler.isRunning && lastTickAgeMs < HEALTHY_TICK_AGE_MS,
        uptimeS: Math.round((nowMs - src.startedAtMs) / 1000),
        build: src.build,
        rooms: src.lobby.list().length,
        players: src.lobby.playerCount(),
        sessions: src.sessions.size,
        graceSessions: src.sessions.inGrace,
        connections: src.connections(),
        lastTickAgeMs: Number.isFinite(lastTickAgeMs) ? Math.round(lastTickAgeMs) : -1,
        tickMeanMs: round3(metrics.mean()),
        tickP95Ms: round3(metrics.percentile(0.95)),
        tickP99Ms: round3(metrics.percentile(0.99)),
        overruns: metrics.overruns,
        bytesInPerSec: src.traffic.inPerSec,
        bytesOutPerSec: src.traffic.outPerSec,
        kicks: src.kicks(),
        shuttingDown,
        ...memoryMb()
    };
}

/** The detailed view (/metrics.json, only with METRICS=1). */
export function metricsReport(src: HealthSources, nowMs: number): object {
    const m = src.scheduler.metrics;
    return {
        ...healthReport(src, nowMs),
        ticks: m.ticks,
        tickP50Ms: round3(m.percentile(0.5)),
        tickMaxMs: round3(m.percentile(1)),
        traffic: {
            bytesIn: src.traffic.bytesIn,
            bytesOut: src.traffic.bytesOut,
            messagesIn: src.traffic.messagesIn,
            messagesOut: src.traffic.messagesOut
        },
        roomList: src.lobby.list().map(room => ({
            id: room.id,
            kind: room.kind,
            players: room.size,
            tick: room.tick,
            bytesOut: room.bytesOut
        }))
    };
}
