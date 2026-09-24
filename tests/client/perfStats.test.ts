import { describe, expect, it } from 'vitest';
import {
    countSocketTraffic, emptyWsTotals, formatOverlay, netOverlayLines, summarize,
    type FrameSample, type NetOverlayInput, type OverlayWindow, type ServerHealth, type WsTotals
} from '../../src/client/debug/perfStats.js';
import type { NetStats } from '../../src/shared/net/client.js';

// The ?debug=perf / ?debug=net overlay and the baseline recording
// (src/client/debug/perfStats.ts): the WebSocket byte counter, the summary
// of a recording and the overlay text, fed with hand-made numbers. The
// expected values are worked out by hand in the comments.

class FakeSocket {
    readonly sent: unknown[] = [];
    private listeners: Array<(event: { data: unknown }) => void> = [];
    addEventListener(_type: 'message', listener: (event: { data: unknown }) => void): void {
        this.listeners.push(listener);
    }
    send(data: unknown): void {
        this.sent.push(data);
    }
    receive(data: unknown): void {
        for (const listener of this.listeners) listener({ data });
    }
}

describe('the WebSocket counter', () => {
    it('counts text as UTF-8 bytes and binary frames apart, both ways, and still sends', () => {
        const socket = new FakeSocket();
        const totals = emptyWsTotals();
        countSocketTraffic(socket as never, totals);

        // 'hello' = 5 bytes; 'Grüße' = G r ü(2) ß(2) e = 7 bytes; an emoji
        // (surrogate pair) = 4 bytes
        socket.send('hello');
        socket.send(new Uint8Array(12));
        socket.receive('Grüße');
        socket.receive('🚐');
        socket.receive(new ArrayBuffer(40));

        expect(totals).toEqual({
            bytesOut: 5 + 12, messagesOut: 2, binaryBytesOut: 12, binaryMessagesOut: 1,
            bytesIn: 7 + 4 + 40, messagesIn: 3, binaryBytesIn: 40, binaryMessagesIn: 1
        } satisfies WsTotals);
        // The wrapped send still hands the data to the socket
        expect(socket.sent).toHaveLength(2);
        expect(socket.sent[0]).toBe('hello');
    });
});

function frame(frameMs: number, extra: Partial<FrameSample> = {}): FrameSample {
    return { frameMs, cpuMs: 2, drawCalls: 50, triangles: 1000, simMs: -1, simTicks: 0, simCars: 0, ...extra };
}

describe('a recording', () => {
    it('sums up frames, draw calls and the socket over its duration', () => {
        const frames = [
            frame(10, { drawCalls: 40, cpuMs: 1 }),
            frame(20, { drawCalls: 80, cpuMs: 3 }),
            frame(30, { drawCalls: 60, cpuMs: 2 }),
            frame(40, { drawCalls: 20, cpuMs: 6 })
        ];
        const start = emptyWsTotals();
        const end = { ...emptyWsTotals(), bytesIn: 3000, bytesOut: 500, messagesIn: 30, messagesOut: 10, binaryBytesIn: 2000 };
        const recording = summarize(frames, 2000, start, end, {
            calls: 0, triangles: 0, geometries: 7, textures: 9, programs: 3, pixelRatio: 2
        });

        // 4 frames in 2 s
        expect(recording.frames).toBe(4);
        expect(recording.fps).toBe(2);
        // Frame times 10, 20, 30, 40: mean 25, p50 = sorted[2] = 30, max 40
        expect(recording.frameMs).toEqual({ avg: 25, p50: 30, p95: 40, p99: 40, max: 40 });
        expect(recording.cpuMs.avg).toBe(3);
        expect(recording.drawCalls.max).toBe(80);
        expect(recording.drawCalls.avg).toBe(50);
        // 3000 bytes in over 2 s
        expect(recording.ws.bytesIn).toBe(3000);
        expect(recording.ws.bytesInPerSec).toBe(1500);
        expect(recording.ws.messagesOutPerSec).toBe(5);
        expect(recording.ws.binaryBytesInPerSec).toBe(1000);
        expect(recording).toMatchObject({ geometries: 7, textures: 9, programs: 3, pixelRatio: 2 });
        // No v2 car in any frame
        expect(recording.sim).toBeNull();
    });

    it('counts the sim ticks per frame and the cars in the step', () => {
        const frames = [
            // Before the car existed
            frame(16, { simMs: -1 }),
            frame(16, { simMs: 0.6, simTicks: 2, simCars: 6 }),
            // A frame without a tick
            frame(16, { simMs: 0, simTicks: 0, simCars: 6 }),
            frame(16, { simMs: 0.9, simTicks: 3, simCars: 5 })
        ];
        const sim = summarize(frames, 64, emptyWsTotals(), emptyWsTotals(), null).sim!;
        // 5 ticks over the 3 frames with a car, 2 of them ticking
        expect(sim.ticks).toBe(5);
        expect(sim.frames).toBe(2);
        expect(sim.ticksPerFrame).toBeCloseTo(5 / 3, 2);
        // 1.5 ms for 5 ticks
        expect(sim.msPerTick).toBe(0.3);
        expect(sim.msPerFrame.max).toBe(0.9);
        expect(sim.cars.max).toBe(6);
        expect(sim.cars.avg).toBeCloseTo(17 / 3, 2);
    });
});

function stats(overrides: Partial<NetStats> = {}): NetStats {
    return {
        snapshots: 0, corrections: 0, correctionSum: 0, correctionMax: 0, contactCorrections: 0, contactCorrectionSum: 0,
        snaps: 0, replayedTicks: 0, lostInputs: 0, resyncs: 0, exactMatches: 0, missedInputs: 0, lastSlack: 0,
        frames: 0, bytesOut: 0, offsetMax: 0, renderSnaps: 0, ownStalls: 0, ...overrides
    };
}

const HEALTH: ServerHealth = {
    ok: true, players: 3, rooms: 2, tickMeanMs: 0.4, tickP95Ms: 0.8, tickP99Ms: 1.25, overruns: 0, bytesOutPerSec: 0
};

describe('the overlay text', () => {
    const window: OverlayWindow = {
        seconds: 0.5,
        frames: 30,
        frameMs: 480,
        maxFrameMs: 33.3,
        cpuMs: 90,
        simMs: 3,
        sim: { simMs: 0.1, simCars: 1 },
        renderer: { calls: 120, triangles: 250_000, geometries: 40, textures: 12, programs: 9, pixelRatio: 1.5 },
        wsBefore: emptyWsTotals(),
        // 1 kB in and 0.5 kB out in half a second, 2 kB/s and 1 kB/s
        wsNow: { ...emptyWsTotals(), bytesIn: 1024, bytesOut: 512, messagesIn: 10, messagesOut: 30, binaryBytesIn: 512 }
    };

    it('shows the frame rate, the sim, the renderer and the socket of the window', () => {
        const text = formatOverlay(window, []);
        // 30 frames in 0.5 s, 16 ms each on average, 3 ms / 30 frames sim
        expect(text).toContain('FPS    60.0');
        expect(text).toContain('frame  16.0 ms (max 33.3)');
        expect(text).toContain('cpu    3.00 ms');
        expect(text).toContain('sim    0.100 ms  1 cars');
        expect(text).toContain('calls  120');
        expect(text).toContain('tris   250000');
        expect(text).toContain('ws in  2.00 kB/s  20.0 msg/s  (bin 1.00)');
        expect(text).toContain('ws out 1.00 kB/s  60.0 msg/s  (bin 0.00)');
        // Without a v2 car there is no sim line
        expect(formatOverlay({ ...window, sim: { simMs: -1, simCars: 0 } }, [])).not.toContain('sim ');
    });

    it('adds the netcode lines online, and only the netsim offline', () => {
        const netsim = { rttMs: 150, jitterMs: 30, loss: 0, mode: 'tcp' as const };
        expect(netOverlayLines(null, 0.5, null, HEALTH)).toEqual([]);
        expect(netOverlayLines(null, 0.5, netsim, HEALTH)).toEqual(['netsim 150/30/0% tcp']);

        const net: NetOverlayInput = {
            tick: 1234, lead: 7.26, rate: 1.0126, rttMs: 151.6, jitterMs: 12.2, bufferTarget: 3, contactSet: 1,
            // 10 snapshots in 0.5 s; 4 corrections, 1 of them in contact,
            // the other 3 add up to 0.3 m: 10 cm each
            before: stats({ snapshots: 100, corrections: 2, contactCorrections: 1, correctionSum: 0.2, replayedTicks: 10 }),
            now: stats({ snapshots: 110, corrections: 6, contactCorrections: 2, correctionSum: 0.5, replayedTicks: 30, snaps: 1, lastSlack: 2 }),
            lostSeconds: null, reconnects: 1, resumed: true
        };
        const lines = netOverlayLines(net, 0.5, netsim, HEALTH);
        expect(lines).toEqual([
            'net    C 1234  lead 7.3  slack 2  rate 1.013',
            'rtt    152 ms  jitter 12 ms  buf 3',
            // 4 replays of 20 ticks: 5 per replay
            'snap   20.0/s  corr 10.0 cm  snaps 1',
            'pred   set 1  replay 5.0 t  missed 0',
            'link   ok  reconnects 1 (resumed)',
            'netsim 150/30/0% tcp',
            'server tick 0.80/1.25 ms p95/p99  3 pl  2 rooms'
        ]);
        // A lost connection shows how long it is gone
        expect(netOverlayLines({ ...net, lostSeconds: 2.04, resumed: false }, 0.5, null, null))
            .toContain('link   lost 2.0 s  reconnects 1');
    });
});
