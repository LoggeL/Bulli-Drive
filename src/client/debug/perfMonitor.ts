import { state } from '../state.js';

// Performance overlay for baseline measurements, only active with ?debug=perf
// (installPerfMonitor returns null otherwise, so the game loop pays nothing).
// It shows FPS, frame time, main-loop CPU time, three.js renderer counters and
// the WebSocket payload bandwidth, and exposes window.__bulliPerf so
// scripts/perf-baseline.ts can record the same numbers headlessly.

const OVERLAY_REFRESH_MS = 500;
const MAX_RECORDED_FRAMES = 100_000;

export interface PerfMonitor {
    beginFrame(): void;
    endFrame(frameTime: number): void;
}

interface Distribution {
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
    // renderer.info.memory / programs at the end of the recording
    geometries: number;
    textures: number;
    programs: number;
    pixelRatio: number;
    // WebSocket payload (JSON text, without framing overhead)
    ws: WsTotals & {
        bytesInPerSec: number;
        bytesOutPerSec: number;
        messagesInPerSec: number;
        messagesOutPerSec: number;
    };
}

export interface PerfHook {
    // Payload totals since the page loaded (includes the big init message)
    wsTotals(): WsTotals;
    // WebGL renderer string, e.g. SwiftShader in headless Chromium
    gpu(): string;
    startRecording(): void;
    stopRecording(): PerfRecording | null;
}

interface FrameSample {
    frameMs: number;
    cpuMs: number;
    drawCalls: number;
    triangles: number;
}

export function isPerfDebugEnabled(search = window.location.search): boolean {
    return new URLSearchParams(search).getAll('debug')
        .some(value => value.split(',').includes('perf'));
}

export function installPerfMonitor(): PerfMonitor | null {
    if (!isPerfDebugEnabled()) return null;

    const ws: WsTotals = { bytesIn: 0, bytesOut: 0, messagesIn: 0, messagesOut: 0 };
    let trackedSocket: WebSocket | null = null;

    function trackSocket(socket: WebSocket | null) {
        if (!socket || socket === trackedSocket) return;
        trackedSocket = socket;
        socket.addEventListener('message', (event) => {
            ws.bytesIn += payloadSize(event.data);
            ws.messagesIn++;
        });
        const send = socket.send.bind(socket);
        socket.send = (data) => {
            ws.bytesOut += payloadSize(data);
            ws.messagesOut++;
            send(data);
        };
    }
    // Called right after initWebSocket(), before any message can arrive
    trackSocket(state.ws);

    // Overlay window
    let frameStart = 0;
    let previousFrameTime = -1;
    let windowStart = performance.now();
    let windowFrames = 0;
    let windowFrameMs = 0;
    let windowMaxFrameMs = 0;
    let windowCpuMs = 0;
    let windowWs: WsTotals = { ...ws };

    // Recording for the baseline script
    let recording: FrameSample[] | null = null;
    let recordingStart = 0;
    let recordingWs: WsTotals = { ...ws };

    const overlay = document.createElement('pre');
    overlay.id = 'perf-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.textContent = 'perf: waiting for frames…';
    document.body.appendChild(overlay);

    const hook: PerfHook = {
        wsTotals: () => ({ ...ws }),
        gpu: () => rendererName(),
        startRecording() {
            recording = [];
            recordingStart = performance.now();
            recordingWs = { ...ws };
        },
        stopRecording() {
            if (!recording) return null;
            const result = summarize(recording, performance.now() - recordingStart, recordingWs, ws);
            recording = null;
            return result;
        }
    };
    (window as unknown as { __bulliPerf: PerfHook }).__bulliPerf = hook;

    return {
        beginFrame() {
            frameStart = performance.now();
        },

        endFrame(frameTime: number) {
            const now = performance.now();
            trackSocket(state.ws);
            const info = state.renderer?.info;
            const cpuMs = now - frameStart;
            const frameMs = previousFrameTime < 0 ? 0 : frameTime - previousFrameTime;
            previousFrameTime = frameTime;
            if (frameMs <= 0) return;

            windowFrames++;
            windowFrameMs += frameMs;
            windowMaxFrameMs = Math.max(windowMaxFrameMs, frameMs);
            windowCpuMs += cpuMs;
            if (recording && recording.length < MAX_RECORDED_FRAMES) {
                recording.push({
                    frameMs,
                    cpuMs,
                    drawCalls: info?.render.calls ?? 0,
                    triangles: info?.render.triangles ?? 0
                });
            }

            const elapsed = now - windowStart;
            if (elapsed < OVERLAY_REFRESH_MS) return;
            const seconds = elapsed / 1000;
            const kbIn = (ws.bytesIn - windowWs.bytesIn) / 1024 / seconds;
            const kbOut = (ws.bytesOut - windowWs.bytesOut) / 1024 / seconds;
            const msgIn = (ws.messagesIn - windowWs.messagesIn) / seconds;
            const msgOut = (ws.messagesOut - windowWs.messagesOut) / seconds;
            overlay.textContent = [
                `FPS    ${(windowFrames / seconds).toFixed(1)}`,
                `frame  ${(windowFrameMs / windowFrames).toFixed(1)} ms (max ${windowMaxFrameMs.toFixed(1)})`,
                `cpu    ${(windowCpuMs / windowFrames).toFixed(2)} ms`,
                `calls  ${info?.render.calls ?? 0}`,
                `tris   ${info?.render.triangles ?? 0}`,
                `geom   ${info?.memory.geometries ?? 0}  tex ${info?.memory.textures ?? 0}`,
                `prog   ${info?.programs?.length ?? 0}  dpr ${(state.renderer?.getPixelRatio() ?? 0).toFixed(2)}`,
                `ws in  ${kbIn.toFixed(2)} kB/s  ${msgIn.toFixed(1)} msg/s`,
                `ws out ${kbOut.toFixed(2)} kB/s  ${msgOut.toFixed(1)} msg/s`
            ].join('\n');

            windowStart = now;
            windowFrames = 0;
            windowFrameMs = 0;
            windowMaxFrameMs = 0;
            windowCpuMs = 0;
            windowWs = { ...ws };
        }
    };
}

// Byte size of a WebSocket payload; text frames are UTF-8 on the wire.
function payloadSize(data: unknown): number {
    if (typeof data === 'string') return utf8Length(data);
    if (data instanceof ArrayBuffer) return data.byteLength;
    if (ArrayBuffer.isView(data)) return data.byteLength;
    if (data instanceof Blob) return data.size;
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

function rendererName(): string {
    const gl = state.renderer?.getContext();
    if (!gl) return 'unknown';
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(debugInfo ? debugInfo.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
}

function distribution(values: number[]): Distribution {
    if (values.length === 0) return { avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    const sorted = [...values].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    const sum = sorted.reduce((total, value) => total + value, 0);
    return {
        avg: round(sum / sorted.length),
        p50: round(at(0.5)),
        p95: round(at(0.95)),
        p99: round(at(0.99)),
        max: round(sorted[sorted.length - 1])
    };
}

function summarize(frames: FrameSample[], durationMs: number, wsStart: WsTotals, wsEnd: WsTotals): PerfRecording {
    const info = state.renderer?.info;
    const seconds = Math.max(durationMs, 1) / 1000;
    const delta: WsTotals = {
        bytesIn: wsEnd.bytesIn - wsStart.bytesIn,
        bytesOut: wsEnd.bytesOut - wsStart.bytesOut,
        messagesIn: wsEnd.messagesIn - wsStart.messagesIn,
        messagesOut: wsEnd.messagesOut - wsStart.messagesOut
    };
    return {
        durationMs: round(durationMs),
        frames: frames.length,
        fps: round(frames.length / seconds),
        frameMs: distribution(frames.map(frame => frame.frameMs)),
        cpuMs: distribution(frames.map(frame => frame.cpuMs)),
        drawCalls: distribution(frames.map(frame => frame.drawCalls)),
        triangles: distribution(frames.map(frame => frame.triangles)),
        geometries: info?.memory.geometries ?? 0,
        textures: info?.memory.textures ?? 0,
        programs: info?.programs?.length ?? 0,
        pixelRatio: state.renderer?.getPixelRatio() ?? 0,
        ws: {
            ...delta,
            bytesInPerSec: round(delta.bytesIn / seconds),
            bytesOutPerSec: round(delta.bytesOut / seconds),
            messagesInPerSec: round(delta.messagesIn / seconds),
            messagesOutPerSec: round(delta.messagesOut / seconds)
        }
    };
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}
