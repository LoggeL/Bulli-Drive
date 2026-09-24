import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { netsimFromEnv, SocketConnection } from '../../src/server/connection.js';
import { TrafficMeter } from '../../src/server/health.js';

// The server side of the dev netsim (docs/phase-1b-design.md, 11.5): every
// message in both directions waits in the simulated network, the close
// behind what was sent before it, and only outside production.

class FakeWs {
    readyState = 1;
    bufferedAmount = 0;
    readonly sent: { data: string | Uint8Array; at: number }[] = [];
    closed: { code?: number; at: number } | null = null;
    pings = 0;
    lastPing: Buffer | null = null;
    send(data: string | Uint8Array): void { this.sent.push({ data, at: performance.now() }); }
    close(code?: number): void { this.closed = { code, at: performance.now() }; this.readyState = 3; }
    ping(payload: Buffer): void { this.pings++; this.lastPing = payload; }
    terminate(): void { this.readyState = 3; }
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('netsimFromEnv', () => {
    it('reads NETSIM outside production only, unless NETSIM_ALLOW=1', () => {
        expect(netsimFromEnv({})).toBeNull();
        expect(netsimFromEnv({ NETSIM: 'rtt=120,jitter=10,loss=2' })).toEqual({ rttMs: 120, jitterMs: 10, loss: 0.02, mode: 'tcp' });
        expect(netsimFromEnv({ NETSIM: 'rtt=120', NODE_ENV: 'production' })).toBeNull();
        expect(netsimFromEnv({ NETSIM: 'rtt=120', NODE_ENV: 'production', NETSIM_ALLOW: '1' })).not.toBeNull();
        expect(netsimFromEnv({ NETSIM: 'nonsense' })).toBeNull();
    });
});

describe('SocketConnection', () => {
    it('without a netsim: sends at once and counts the bytes', () => {
        const ws = new FakeWs();
        const traffic = new TrafficMeter();
        const connection = new SocketConnection(ws as unknown as WebSocket, traffic, null);
        connection.send('hello');
        connection.send(new Uint8Array(10));
        expect(ws.sent).toHaveLength(2);
        expect(traffic.bytesOut).toBe(15);
        let handled = 0;
        connection.inbound(true, 23, () => handled++);
        expect(handled).toBe(1);
        expect(traffic.bytesIn).toBe(23);
    });

    it('with a netsim: holds both directions for half the round trip, closes behind the queue', () => {
        const ws = new FakeWs();
        const connection = new SocketConnection(ws as unknown as WebSocket, new TrafficMeter(), { rttMs: 100, jitterMs: 0, loss: 0, mode: 'tcp' });
        connection.send('a');
        connection.send(new Uint8Array(4));
        expect(ws.sent).toHaveLength(0);
        expect(connection.bufferedAmount).toBe(5);
        connection.close(1012, 'restart');
        // Closing: the session sends nothing more
        expect(connection.readyState).toBe(2);
        let handled = 0;
        connection.inbound(false, 3, () => handled++);
        expect(handled).toBe(0);
        vi.advanceTimersByTime(49);
        expect(ws.sent).toHaveLength(0);
        vi.advanceTimersByTime(1);
        expect(ws.sent.map(s => typeof s.data)).toEqual(['string', 'object']);
        expect(ws.closed?.code).toBe(1012);
        expect(handled).toBe(1);
        expect(connection.bufferedAmount).toBe(0);
    });

    it('delivers nothing after dispose', () => {
        const ws = new FakeWs();
        const connection = new SocketConnection(ws as unknown as WebSocket, new TrafficMeter(), { rttMs: 100, jitterMs: 0, loss: 0, mode: 'tcp' });
        let handled = 0;
        connection.inbound(true, 5, () => handled++);
        connection.dispose();
        vi.advanceTimersByTime(500);
        expect(handled).toBe(0);
    });

    it('measures the round trip only from the pong of its own ping', () => {
        const ws = new FakeWs();
        const connection = new SocketConnection(ws as unknown as WebSocket, new TrafficMeter(), null);
        // Nothing asked: an unsolicited pong does not count
        expect(connection.pongRtt(Buffer.alloc(8), 1000)).toBeNull();
        connection.ping(1000);
        const payload = ws.lastPing!;
        expect(payload).toHaveLength(8);
        // A forged payload (the old scheme: the client echoes a clock time,
        // here NaN or a time far in the past) answers no ping
        const forged = Buffer.alloc(8);
        forged.writeDoubleLE(Number.NaN);
        expect(connection.pongRtt(forged, 1080)).toBeNull();
        forged.writeDoubleLE(1);
        expect(connection.pongRtt(forged, 1080)).toBeNull();
        expect(connection.pongRtt(Buffer.alloc(4), 1080)).toBeNull();
        // The real pong: the time since the ping, once
        expect(connection.pongRtt(payload, 1080)).toBe(80);
        expect(connection.pongRtt(payload, 1090)).toBeNull();
        // A pong after a long stall is capped
        connection.ping(2000);
        expect(connection.pongRtt(ws.lastPing!, 60_000)).toBe(10_000);
    });
});
