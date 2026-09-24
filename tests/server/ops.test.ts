import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acceptHello } from '../../src/server/handshake.js';
import { HEALTHY_TICK_AGE_MS, healthReport, metricsReport, TrafficMeter, type HealthSources } from '../../src/server/health.js';
import { mapFor } from '../../src/server/maps.js';
import { RoomManager } from '../../src/server/rooms/lobby.js';
import type { PartyRoom } from '../../src/server/rooms/PartyRoom.js';
import { TicketSigner } from '../../src/server/resumeTicket.js';
import type { Session } from '../../src/server/session.js';
import { SessionRegistry } from '../../src/server/sessions.js';
import { gracefulShutdown } from '../../src/server/shutdown.js';
import { TickScheduler, type SchedulerClock } from '../../src/server/tick.js';
import { CLOSE_RESTART, SHUTDOWN_CLOSE_DELAY_MS, SHUTDOWN_MAX_MS, SHUTDOWN_RECONNECT_MS } from '../../src/shared/net/constants.js';
import { PROTOCOL_VERSION } from '../../src/shared/protocol.js';
import { FakeTransport, ready } from './helpers.js';

// Operations (docs/phase-1b-design.md, 11.2 and 11.4): /healthz and the
// graceful shutdown.

let lobby: RoomManager;
let sessions: SessionRegistry;
let tickets: TicketSigner;

beforeEach(() => {
    lobby = new RoomManager(mapFor(), { maxPlayersPerRoom: 32, emptyRoomTtlMs: 60_000 });
    sessions = new SessionRegistry();
    tickets = new TicketSigner('a test secret of some length');
});

afterEach(() => {
    for (const room of lobby.list()) room.dispose();
});

function player(name: string, connId: string): { session: Session; transport: FakeTransport } {
    const transport = new FakeTransport();
    const session = acceptHello(transport, JSON.stringify({
        type: 'hello', protocolVersion: PROTOCOL_VERSION, build: null, connId,
        name, carType: 'bulli', profile: 'standard', room: 'party'
    }), { lobby, serverBuild: null, sessions, tickets })!;
    return { session, transport };
}

// A scheduler on a hand-driven clock
function manualScheduler(): { scheduler: TickScheduler; clock: { time: number }; fire(): void } {
    const clock = { time: 0 };
    let pending: (() => void) | null = null;
    const schedulerClock: SchedulerClock = {
        now: () => clock.time,
        setTimeout: (fn) => { pending = fn; return 1; },
        clearTimeout: () => { pending = null; }
    };
    const scheduler = new TickScheduler(() => lobby.stepAll(clock.time), schedulerClock);
    return { scheduler, clock, fire: () => { const fn = pending; pending = null; fn?.(); } };
}

describe('/healthz', () => {
    function sources(scheduler: TickScheduler, shuttingDown = false): HealthSources {
        return {
            scheduler, lobby, sessions, traffic: new TrafficMeter(), build: 'abc', startedAtMs: 0,
            connections: () => 2, kicks: () => 0, shuttingDown: () => shuttingDown
        };
    }

    it('is healthy while the tick runs, with rooms, players and tick times', () => {
        const { scheduler, clock, fire } = manualScheduler();
        player('Ada', 'p1');
        const b = player('Bob', 'p2');
        ready(lobby, b.session);
        scheduler.start();
        for (let i = 0; i < 120; i++) {
            clock.time += 1000 / 60;
            fire();
        }
        const report = healthReport(sources(scheduler), clock.time + 10);
        expect(report).toEqual(expect.objectContaining({
            ok: true, build: 'abc', rooms: 1, players: 2, sessions: 2, graceSessions: 0, connections: 2, shuttingDown: false
        }));
        expect(report.lastTickAgeMs).toBeLessThan(HEALTHY_TICK_AGE_MS);
        expect(report.tickP95Ms).toBeGreaterThanOrEqual(0);
        expect(report.tickP99Ms).toBeGreaterThanOrEqual(report.tickP95Ms);
        expect(report.uptimeS).toBe(2);
        const metrics = metricsReport(sources(scheduler), clock.time) as { roomList: { id: string; players: number }[] };
        expect(metrics.roomList).toEqual([expect.objectContaining({ id: 'party-1', players: 2 })]);
        scheduler.stop();
    });

    it('turns unhealthy when the tick stalls for a second, before the first tick and while shutting down', () => {
        const { scheduler, clock, fire } = manualScheduler();
        expect(healthReport(sources(scheduler), 0).ok).toBe(false);
        scheduler.start();
        clock.time += 20;
        fire();
        expect(healthReport(sources(scheduler), clock.time + HEALTHY_TICK_AGE_MS - 1).ok).toBe(true);
        expect(healthReport(sources(scheduler), clock.time + HEALTHY_TICK_AGE_MS).ok).toBe(false);
        expect(healthReport(sources(scheduler, true), clock.time).ok).toBe(false);
        scheduler.stop();
        expect(healthReport(sources(scheduler), clock.time).ok).toBe(false);
    });

    it('measures the traffic rate per window', () => {
        const traffic = new TrafficMeter();
        traffic.sample(0);
        traffic.noteOut(5000);
        traffic.noteIn(1000);
        traffic.sample(2000);
        expect([traffic.outPerSec, traffic.inPerSec]).toEqual([2500, 500]);
    });
});

describe('graceful shutdown', () => {
    it('tells every client to come back with a ticket, closes with 1012 and exits with 0', async () => {
        const a = player('Ada', 'p1');
        const b = player('Bob', 'p2');
        ready(lobby, a.session);
        (a.session.room as PartyRoom).partyState(a.session.id)!.score = 60;
        // One session already waits in its grace time: it gets nothing
        b.transport.close(1006);
        sessions.disconnect(b.session, 0);

        const log: string[] = [];
        let time = 0;
        let exitCode: number | null = null;
        const waits: number[] = [];
        await gracefulShutdown({
            stopAccepting: () => log.push('stop accepting'),
            stopTicking: () => log.push('stop ticking'),
            sessions: () => sessions.all(),
            tickets,
            socketsOpen: () => [a.transport, b.transport].filter(t => t.readyState === 1).length,
            closeAll: (code) => {
                log.push(`close ${code}`);
                a.transport.close(code);
            },
            exit: (code) => {
                if (exitCode === null) exitCode = code;
                log.push(`exit ${code}`);
            },
            wait: (ms) => {
                waits.push(ms);
                // The long deadline never comes in this test
                if (ms >= SHUTDOWN_MAX_MS) return new Promise(() => { /* pending */ });
                time += ms;
                return Promise.resolve();
            },
            log: () => { /* quiet */ }
        }, 'SIGTERM');

        expect(log).toEqual(['stop accepting', 'stop ticking', `close ${CLOSE_RESTART}`, 'exit 0']);
        expect(exitCode).toBe(0);
        expect(waits).toContain(SHUTDOWN_CLOSE_DELAY_MS);
        expect(time).toBeLessThan(SHUTDOWN_MAX_MS);
        const [shutdown] = a.transport.of('shutdown');
        expect(shutdown.reconnectInMs).toBe(SHUTDOWN_RECONNECT_MS);
        expect(tickets.redeem(shutdown.resume!)).toEqual(expect.objectContaining({ name: 'Ada', score: 60, roomKind: 'party' }));
        expect(b.transport.of('shutdown')).toEqual([]);
    });

    it('exits at the latest after the deadline even when closing hangs', async () => {
        let exitCode: number | null = null;
        let resolveDeadline: () => void = () => { /* set below */ };
        const done = gracefulShutdown({
            stopAccepting: () => { /* */ },
            stopTicking: () => { /* */ },
            sessions: () => sessions.all(),
            tickets,
            socketsOpen: () => 1,
            closeAll: () => { /* */ },
            exit: (code) => { exitCode = code; },
            wait: (ms) => ms >= SHUTDOWN_MAX_MS
                ? new Promise<void>(resolve => { resolveDeadline = resolve; })
                : new Promise<void>(() => { /* a close that never finishes */ }),
            log: () => { /* quiet */ }
        }, 'SIGTERM');
        void done;
        await Promise.resolve();
        expect(exitCode).toBeNull();
        resolveDeadline();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(exitCode).toBe(0);
    });
});
