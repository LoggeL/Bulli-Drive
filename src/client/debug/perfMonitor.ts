import { state } from '../state.js';
import type { LocalVehicle } from '../vehicle/LocalVehicle.js';
import { netDriver } from '../net/netDriver.js';
import { NETSIM } from '../net/netsim.js';
import { connectionInfo } from '../network/websocket.js';
import {
    countSocketTraffic, emptyWsTotals, formatOverlay, isPerfDebugEnabled, netOverlayLines, round, summarize,
    type FrameSample, type NetCost, type NetOverlayInput, type PerfHook, type RendererCounters,
    type ServerHealth, type WsTotals
} from './perfStats.js';

export { isPerfDebugEnabled };
export type { Distribution, NetCost, PerfHook, PerfRecording, ServerHealth, SimCost, WsTotals } from './perfStats.js';

// Performance overlay for baseline measurements, only active with ?debug=perf
// or ?debug=net (installPerfMonitor returns null otherwise, so the game loop
// pays nothing). It shows FPS, frame time, main-loop CPU time, three.js
// renderer counters and the WebSocket payload bandwidth (JSON text and
// binary frames apart), and exposes window.__bulliPerf so
// scripts/perf-baseline.ts can record the same numbers headlessly. With the
// v2 physics it adds the CPU time of the sim ticks per frame. Online it adds
// the netcode (docs/phase-1b-design.md, 12): tick, lead, round trip,
// snapshots, corrections, the connection and the netsim, and the server's
// tick times from /healthz every two seconds.

const OVERLAY_REFRESH_MS = 500;
const MAX_RECORDED_FRAMES = 100_000;

export interface PerfMonitor {
    beginFrame(): void;
    endFrame(frameTime: number): void;
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

const HEALTH_POLL_MS = 2000;

export function installPerfMonitor(): PerfMonitor | null {
    if (!isPerfDebugEnabled(window.location.search)) return null;

    const ws: WsTotals = emptyWsTotals();
    let trackedSocket: WebSocket | null = null;

    // Counts every socket the page opens (a reconnect makes a new one)
    function trackSocket(socket: WebSocket | null) {
        if (!socket || socket === trackedSocket) return;
        trackedSocket = socket;
        countSocketTraffic(socket, ws);
    }

    // The server's tick times (only when online; the sandbox has no server)
    let serverHealth: ServerHealth | null = null;
    const pollHealth = () => {
        if (!state.ws) return;
        fetch('/healthz', { cache: 'no-store' })
            .then(response => response.json() as Promise<ServerHealth>)
            .then(report => { serverHealth = report; })
            .catch(() => { /* offline or dev without the proxy */ });
    };
    window.setInterval(pollHealth, HEALTH_POLL_MS);
    window.setTimeout(pollHealth, 500);
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
    let windowNet = { ...netDriver.stats };
    const simMeter = new SimMeter();
    const sim = { simMs: -1, simTicks: 0, simCars: 0 };

    // Recording for the baseline script
    let recording: FrameSample[] | null = null;
    let recordingStart = 0;
    let recordingWs: WsTotals = { ...ws };
    let recordingNet = { ...netDriver.stats };

    const overlay = document.createElement('pre');
    overlay.id = 'perf-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.textContent = 'perf: waiting for frames…';
    document.body.appendChild(overlay);

    const hook: PerfHook = {
        wsTotals: () => ({ ...ws }),
        serverHealth: () => serverHealth,
        gpu: () => rendererName(),
        startRecording() {
            recording = [];
            recordingStart = performance.now();
            recordingWs = { ...ws };
            recordingNet = { ...netDriver.stats };
        },
        stopRecording() {
            if (!recording) return null;
            const durationMs = performance.now() - recordingStart;
            const result = summarize(recording, durationMs, recordingWs, ws, rendererCounters());
            result.net = netCost(recordingNet, durationMs);
            result.server = serverHealth;
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
            const netLines = netOverlayLines(netOverlayInput(windowNet), seconds, NETSIM, serverHealth);
            windowNet = { ...netDriver.stats };
            overlay.textContent = formatOverlay({
                seconds,
                frames: windowFrames,
                frameMs: windowFrameMs,
                maxFrameMs: windowMaxFrameMs,
                cpuMs: windowCpuMs,
                simMs: windowSimMs,
                sim,
                renderer: rendererCounters(),
                wsBefore: windowWs,
                wsNow: ws
            }, netLines);

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

type NetTotals = typeof netDriver.stats;

// The page's netcode for the overlay, null offline and in the sandbox
function netOverlayInput(before: NetTotals): NetOverlayInput | null {
    const p = netDriver.prediction;
    if (!p || !state.room) return null;
    return {
        tick: p.tick,
        lead: netDriver.lead.lead,
        rate: netDriver.lead.rate,
        rttMs: netDriver.clock.rtt,
        jitterMs: netDriver.clock.jitter,
        bufferTarget: netDriver.bufferTarget,
        contactSet: p.remotes.size,
        before,
        now: netDriver.stats,
        lostSeconds: netDriver.suspended ? (performance.now() - connectionInfo.disconnectedAt) / 1000 : null,
        reconnects: connectionInfo.reconnects,
        resumed: connectionInfo.resumed
    };
}

// renderer.info now, null before the renderer exists
function rendererCounters(): RendererCounters | null {
    const renderer = state.renderer;
    if (!renderer) return null;
    const info = renderer.info;
    return {
        calls: info.render.calls,
        triangles: info.render.triangles,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        programs: info.programs?.length ?? 0,
        pixelRatio: renderer.getPixelRatio()
    };
}

function netCost(before: NetTotals, durationMs: number): NetCost | null {
    if (!netDriver.prediction || !state.room) return null;
    const s = netDriver.stats;
    const seconds = Math.max(durationMs, 1) / 1000;
    const corrections = s.corrections - s.contactCorrections - (before.corrections - before.contactCorrections);
    return {
        snapshotsPerSec: round((s.snapshots - before.snapshots) / seconds),
        corrections,
        correctionMeanCm: corrections > 0 ? round((s.correctionSum - before.correctionSum) / corrections * 100) : 0,
        correctionMaxCm: round(s.correctionMax * 100),
        snaps: s.snaps - before.snaps,
        missedInputs: s.missedInputs - before.missedInputs,
        rttMs: round(netDriver.clock.rtt),
        leadTicks: round(netDriver.lead.lead)
    };
}

function rendererName(): string {
    const gl = state.renderer?.getContext();
    if (!gl) return 'unknown';
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(debugInfo ? debugInfo.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
}
