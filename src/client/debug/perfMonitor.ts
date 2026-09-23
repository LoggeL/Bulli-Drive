import { state } from '../state.js';
import type { LocalVehicle } from '../vehicle/LocalVehicle.js';

// Performance overlay for baseline measurements, only active with ?debug=perf
// (installPerfMonitor returns null otherwise, so the game loop pays nothing).
// It shows FPS, frame time, main-loop CPU time, three.js renderer counters and
// the WebSocket payload bandwidth, and exposes window.__bulliPerf so
// scripts/perf-baseline.ts can record the same numbers headlessly. With the
// v2 physics it adds the CPU time of the sim ticks per frame.

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

// Sim ticks of the local v2 car (?physics=v2), sandbox dummies included.
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
    // Only with the v2 physics, null with the legacy physics
    sim: SimCost | null;
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
    // -1 without a v2 car
    simMs: number;
    simTicks: number;
    simCars: number;
}

// Per-frame sim cost from the running totals of the local v2 car
class SimMeter {
    private vehicle: LocalVehicle | null = null;
    private ms = 0;
    private ticks = 0;

    // ms and ticks since the last call; ms = -1 without a v2 car
    sample(out: { simMs: number; simTicks: number; simCars: number }): void {
        const vehicle: LocalVehicle | undefined = state.bulli?.vehicle;
        if (!vehicle) {
            this.vehicle = null;
            out.simMs = -1;
            out.simTicks = out.simCars = 0;
            return;
        }
        // A rebuilt car (respawn, body switch) starts its totals at zero
        if (vehicle !== this.vehicle) {
            this.vehicle = vehicle;
            this.ms = this.ticks = 0;
        }
        out.simMs = vehicle.simMsTotal - this.ms;
        out.simTicks = vehicle.ticks - this.ticks;
        out.simCars = vehicle.simCars;
        this.ms = vehicle.simMsTotal;
        this.ticks = vehicle.ticks;
    }
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
    let windowSimMs = 0;
    let windowWs: WsTotals = { ...ws };
    const simMeter = new SimMeter();
    const sim = { simMs: -1, simTicks: 0, simCars: 0 };

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
            simMeter.sample(sim);
            if (frameMs <= 0) return;

            windowFrames++;
            windowFrameMs += frameMs;
            windowMaxFrameMs = Math.max(windowMaxFrameMs, frameMs);
            windowCpuMs += cpuMs;
            windowSimMs += Math.max(0, sim.simMs);
            if (recording && recording.length < MAX_RECORDED_FRAMES) {
                recording.push({
                    frameMs,
                    cpuMs,
                    drawCalls: info?.render.calls ?? 0,
                    triangles: info?.render.triangles ?? 0,
                    ...sim
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
                ...(sim.simMs >= 0 ? [`sim    ${(windowSimMs / windowFrames).toFixed(3)} ms  ${sim.simCars} cars`] : []),
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
            windowSimMs = 0;
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

// Rounded to 1/scale (0.01 by default, 0.001 for the sim times)
function distribution(values: number[], scale = 100): Distribution {
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
        sim: simCost(frames),
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

function simCost(frames: FrameSample[]): SimCost | null {
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

function round(value: number, scale = 100): number {
    return Math.round(value * scale) / scale;
}
