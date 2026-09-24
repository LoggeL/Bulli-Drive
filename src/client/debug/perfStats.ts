import { describeNetsim, type NetsimOptions } from '../../shared/net/netsim.js';
import type { NetStats } from '../../shared/net/client.js';

// The pure half of the performance overlay (perfMonitor.ts): the URL gate,
// the WebSocket byte counter, the recording summary and the overlay text.
// No page state here, so the unit tests can feed in hand-made numbers.

export interface Distribution {
    avg: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
}

export interface WsTotals {
    bytesIn: number;
    bytesOut: number;
    messagesIn: number;
    messagesOut: number;
    // The binary share (snapshots in, input packets out)
    binaryBytesIn: number;
    binaryBytesOut: number;
    binaryMessagesIn: number;
    binaryMessagesOut: number;
}

// What /healthz said last (src/server/health.ts), null before the first answer
export interface ServerHealth {
    ok: boolean;
    players: number;
    rooms: number;
    tickMeanMs: number;
    tickP95Ms: number;
    tickP99Ms: number;
    overruns: number;
    bytesOutPerSec: number;
}

// The netcode over a recording
export interface NetCost {
    snapshotsPerSec: number;
    corrections: number;
    // Mean and largest correction without car contact (cm)
    correctionMeanCm: number;
    correctionMaxCm: number;
    snaps: number;
    missedInputs: number;
    rttMs: number;
    leadTicks: number;
}

// Sim ticks of the local v2 car, sandbox dummies included.
// performance.now() is coarsened in the browser (100 µs with jitter without
// cross-origin isolation), so single frames are coarse; the averages over
// many frames are not.
export interface SimCost {
    // Frames that ran at least one tick
    frames: number;
    ticks: number;
    ticksPerFrame: number;
    // All sim ticks of a frame (input, proxies, stepWorld, hooks)
    msPerFrame: Distribution;
    msPerTick: number;
    // Cars in stepWorld: local car, remote proxies and sandbox dummies
    cars: { avg: number; max: number };
}

export interface PerfRecording {
    durationMs: number;
    frames: number;
    fps: number;
    // Time between two animation frames (what the player sees)
    frameMs: Distribution;
    // Time spent inside the game loop, render call included
    cpuMs: Distribution;
    drawCalls: Distribution;
    triangles: Distribution;
    // null before the local car drives
    sim: SimCost | null;
    // renderer.info.memory / programs at the end of the recording
    geometries: number;
    textures: number;
    programs: number;
    pixelRatio: number;
    // WebSocket payload (JSON text and binary frames, without framing overhead)
    ws: WsTotals & {
        bytesInPerSec: number;
        bytesOutPerSec: number;
        messagesInPerSec: number;
        messagesOutPerSec: number;
        binaryBytesInPerSec: number;
        binaryBytesOutPerSec: number;
    };
    // null offline and in the sandbox
    net: NetCost | null;
    server: ServerHealth | null;
}

export interface PerfHook {
    // Payload totals since the page loaded
    wsTotals(): WsTotals;
    // The server's last /healthz answer
    serverHealth(): ServerHealth | null;
    // WebGL renderer string, e.g. SwiftShader in headless Chromium
    gpu(): string;
    startRecording(): void;
    stopRecording(): PerfRecording | null;
}

export interface FrameSample {
    frameMs: number;
    cpuMs: number;
    drawCalls: number;
    triangles: number;
    // -1 without a v2 car
    simMs: number;
    simTicks: number;
    simCars: number;
}

// renderer.info at the end of a recording or overlay window
export interface RendererCounters {
    calls: number;
    triangles: number;
    geometries: number;
    textures: number;
    programs: number;
    pixelRatio: number;
}

function debugFlags(search: string): string[] {
    return new URLSearchParams(search).getAll('debug').flatMap(value => value.split(','));
}

/** ?debug=perf or ?debug=net (also in a comma list) turns the overlay on. */
export function isPerfDebugEnabled(search: string): boolean {
    const flags = debugFlags(search);
    return flags.includes('perf') || flags.includes('net');
}

export function emptyWsTotals(): WsTotals {
    return {
        bytesIn: 0, bytesOut: 0, messagesIn: 0, messagesOut: 0,
        binaryBytesIn: 0, binaryBytesOut: 0, binaryMessagesIn: 0, binaryMessagesOut: 0
    };
}

// The parts of a WebSocket the counter touches
export interface CountableSocket {
    addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
    send(data: WsPayload): void;
}

type WsPayload = string | ArrayBufferLike | ArrayBufferView | Blob;

/**
 * Counts what arrives on and goes out of the socket into totals: every
 * message event, and every send (the socket's send is wrapped).
 */
export function countSocketTraffic(socket: CountableSocket, totals: WsTotals): void {
    socket.addEventListener('message', (event) => {
        const size = payloadSize(event.data);
        totals.bytesIn += size;
        totals.messagesIn++;
        if (typeof event.data !== 'string') {
            totals.binaryBytesIn += size;
            totals.binaryMessagesIn++;
        }
    });
    const send = socket.send.bind(socket);
    socket.send = (data: WsPayload) => {
        const size = payloadSize(data);
        totals.bytesOut += size;
        totals.messagesOut++;
        if (typeof data !== 'string') {
            totals.binaryBytesOut += size;
            totals.binaryMessagesOut++;
        }
        send(data);
    };
}

// Byte size of a WebSocket payload; text frames are UTF-8 on the wire.
export function payloadSize(data: unknown): number {
    if (typeof data === 'string') return utf8Length(data);
    if (data instanceof ArrayBuffer) return data.byteLength;
    if (ArrayBuffer.isView(data)) return data.byteLength;
    if (typeof Blob !== 'undefined' && data instanceof Blob) return data.size;
    return 0;
}

function utf8Length(text: string): number {
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code < 0x80) bytes += 1;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xD800 && code <= 0xDBFF) { bytes += 4; i++; }
        else bytes += 3;
    }
    return bytes;
}

// Rounded to 1/scale (0.01 by default, 0.001 for the sim times)
export function round(value: number, scale = 100): number {
    return Math.round(value * scale) / scale;
}

export function distribution(values: number[], scale = 100): Distribution {
    if (values.length === 0) return { avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    const sorted = [...values].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    const sum = sorted.reduce((total, value) => total + value, 0);
    return {
        avg: round(sum / sorted.length, scale),
        p50: round(at(0.5), scale),
        p95: round(at(0.95), scale),
        p99: round(at(0.99), scale),
        max: round(sorted[sorted.length - 1], scale)
    };
}

/** A recording's frames and socket totals as the baseline script reads them. */
export function summarize(
    frames: FrameSample[], durationMs: number, wsStart: WsTotals, wsEnd: WsTotals, renderer: RendererCounters | null
): PerfRecording {
    const seconds = Math.max(durationMs, 1) / 1000;
    const delta: WsTotals = {
        bytesIn: wsEnd.bytesIn - wsStart.bytesIn,
        bytesOut: wsEnd.bytesOut - wsStart.bytesOut,
        messagesIn: wsEnd.messagesIn - wsStart.messagesIn,
        messagesOut: wsEnd.messagesOut - wsStart.messagesOut,
        binaryBytesIn: wsEnd.binaryBytesIn - wsStart.binaryBytesIn,
        binaryBytesOut: wsEnd.binaryBytesOut - wsStart.binaryBytesOut,
        binaryMessagesIn: wsEnd.binaryMessagesIn - wsStart.binaryMessagesIn,
        binaryMessagesOut: wsEnd.binaryMessagesOut - wsStart.binaryMessagesOut
    };
    return {
        durationMs: round(durationMs),
        frames: frames.length,
        fps: round(frames.length / seconds),
        frameMs: distribution(frames.map(frame => frame.frameMs)),
        cpuMs: distribution(frames.map(frame => frame.cpuMs)),
        drawCalls: distribution(frames.map(frame => frame.drawCalls)),
        triangles: distribution(frames.map(frame => frame.triangles)),
        sim: simCost(frames),
        geometries: renderer?.geometries ?? 0,
        textures: renderer?.textures ?? 0,
        programs: renderer?.programs ?? 0,
        pixelRatio: renderer?.pixelRatio ?? 0,
        ws: {
            ...delta,
            bytesInPerSec: round(delta.bytesIn / seconds),
            bytesOutPerSec: round(delta.bytesOut / seconds),
            messagesInPerSec: round(delta.messagesIn / seconds),
            messagesOutPerSec: round(delta.messagesOut / seconds),
            binaryBytesInPerSec: round(delta.binaryBytesIn / seconds),
            binaryBytesOutPerSec: round(delta.binaryBytesOut / seconds)
        },
        net: null,
        server: null
    };
}

export function simCost(frames: FrameSample[]): SimCost | null {
    const v2 = frames.filter(frame => frame.simMs >= 0);
    if (v2.length === 0) return null;
    const ticking = v2.filter(frame => frame.simTicks > 0);
    const ticks = v2.reduce((total, frame) => total + frame.simTicks, 0);
    const ms = v2.reduce((total, frame) => total + frame.simMs, 0);
    return {
        frames: ticking.length,
        ticks,
        ticksPerFrame: round(ticks / v2.length),
        msPerFrame: distribution(ticking.map(frame => frame.simMs), 1000),
        msPerTick: ticks > 0 ? round(ms / ticks, 10000) : 0,
        cars: {
            avg: round(v2.reduce((total, frame) => total + frame.simCars, 0) / v2.length),
            max: v2.reduce((most, frame) => Math.max(most, frame.simCars), 0)
        }
    };
}

// The netcode of the page at the end of an overlay window
export interface NetOverlayInput {
    tick: number;
    lead: number;
    rate: number;
    rttMs: number;
    jitterMs: number;
    bufferTarget: number;
    contactSet: number;
    // Totals at the start and at the end of the window
    before: NetStats;
    now: NetStats;
    // Seconds since the connection went away, null while connected
    lostSeconds: number | null;
    reconnects: number;
    resumed: boolean;
}

/** The netcode lines of the overlay over the last window (just the netsim offline). */
export function netOverlayLines(
    net: NetOverlayInput | null, seconds: number, netsim: NetsimOptions | null, server: ServerHealth | null
): string[] {
    if (!net) return netsim ? [`netsim ${describeNetsim(netsim)}`] : [];
    const { before, now: s } = net;
    const snapshots = s.snapshots - before.snapshots;
    const corrections = s.corrections - s.contactCorrections - (before.corrections - before.contactCorrections);
    const correctionCm = corrections > 0 ? (s.correctionSum - before.correctionSum) / corrections * 100 : 0;
    const replays = s.corrections - before.corrections;
    const replayTicks = replays > 0 ? (s.replayedTicks - before.replayedTicks) / replays : 0;
    const link = net.lostSeconds !== null ? `lost ${net.lostSeconds.toFixed(1)} s` : 'ok';
    const lines = [
        `net    C ${net.tick}  lead ${net.lead.toFixed(1)}  slack ${s.lastSlack}  rate ${net.rate.toFixed(3)}`,
        `rtt    ${net.rttMs.toFixed(0)} ms  jitter ${net.jitterMs.toFixed(0)} ms  buf ${net.bufferTarget}`,
        `snap   ${(snapshots / seconds).toFixed(1)}/s  corr ${correctionCm.toFixed(1)} cm  snaps ${s.snaps}`,
        `pred   set ${net.contactSet}  replay ${replayTicks.toFixed(1)} t  missed ${s.missedInputs}`,
        `link   ${link}  reconnects ${net.reconnects}${net.resumed ? ' (resumed)' : ''}`
    ];
    if (netsim) lines.push(`netsim ${describeNetsim(netsim)}`);
    if (server) {
        lines.push(`server tick ${server.tickP95Ms.toFixed(2)}/${server.tickP99Ms.toFixed(2)} ms p95/p99  ${server.players} pl  ${server.rooms} rooms`);
    }
    return lines;
}

// One refresh window of the overlay
export interface OverlayWindow {
    seconds: number;
    frames: number;
    // Sums over the window's frames, and the longest frame
    frameMs: number;
    maxFrameMs: number;
    cpuMs: number;
    simMs: number;
    // The last frame's sim sample (simMs < 0: no v2 car)
    sim: { simMs: number; simCars: number };
    renderer: RendererCounters | null;
    // Socket totals at the start and at the end of the window
    wsBefore: WsTotals;
    wsNow: WsTotals;
}

/** The overlay text of one window. */
export function formatOverlay(w: OverlayWindow, netLines: string[]): string {
    const { seconds, wsBefore: b, wsNow: ws, renderer: r } = w;
    const kbIn = (ws.bytesIn - b.bytesIn) / 1024 / seconds;
    const kbOut = (ws.bytesOut - b.bytesOut) / 1024 / seconds;
    const msgIn = (ws.messagesIn - b.messagesIn) / seconds;
    const msgOut = (ws.messagesOut - b.messagesOut) / seconds;
    const binIn = (ws.binaryBytesIn - b.binaryBytesIn) / 1024 / seconds;
    const binOut = (ws.binaryBytesOut - b.binaryBytesOut) / 1024 / seconds;
    return [
        `FPS    ${(w.frames / seconds).toFixed(1)}`,
        `frame  ${(w.frameMs / w.frames).toFixed(1)} ms (max ${w.maxFrameMs.toFixed(1)})`,
        `cpu    ${(w.cpuMs / w.frames).toFixed(2)} ms`,
        ...(w.sim.simMs >= 0 ? [`sim    ${(w.simMs / w.frames).toFixed(3)} ms  ${w.sim.simCars} cars`] : []),
        `calls  ${r?.calls ?? 0}`,
        `tris   ${r?.triangles ?? 0}`,
        `geom   ${r?.geometries ?? 0}  tex ${r?.textures ?? 0}`,
        `prog   ${r?.programs ?? 0}  dpr ${(r?.pixelRatio ?? 0).toFixed(2)}`,
        `ws in  ${kbIn.toFixed(2)} kB/s  ${msgIn.toFixed(1)} msg/s  (bin ${binIn.toFixed(2)})`,
        `ws out ${kbOut.toFixed(2)} kB/s  ${msgOut.toFixed(1)} msg/s  (bin ${binOut.toFixed(2)})`,
        ...netLines
    ].join('\n');
}
