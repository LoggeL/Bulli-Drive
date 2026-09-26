import { isSafeMode } from '../render/safeMode.js';

// Graphics trouble reports (POST /api/client-report, src/server/clientReports.ts):
// a lost or refused WebGL context only happens on real devices, so the
// client tells the server what it ran on. No personal data: device class,
// GPU name, screen and the event.

export type ClientReportEvent = 'context-lost' | 'context-restored' | 'webgl-unavailable';

const pageStart = typeof performance !== 'undefined' ? performance.now() : 0;
let gpuName = '';

/** Remembers the GPU name while the context is still alive (lost contexts answer nothing). */
export function rememberGpu(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    try {
        const info = gl.getExtension('WEBGL_debug_renderer_info');
        gpuName = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
    } catch { /* ignore */ }
}

export function buildClientReport(event: ClientReportEvent, detail = ''): Record<string, unknown> {
    const nav = navigator as Navigator & { deviceMemory?: number };
    return {
        event,
        detail: detail.slice(0, 200),
        build: document.querySelector('meta[name="bulli-build-version"]')?.getAttribute('content') ?? '',
        userAgent: nav.userAgent.slice(0, 300),
        gpu: gpuName.slice(0, 200),
        safeMode: isSafeMode(),
        devicePixelRatio: window.devicePixelRatio || 1,
        screen: `${window.screen?.width ?? 0}x${window.screen?.height ?? 0}`,
        deviceMemory: nav.deviceMemory ?? null,
        cores: nav.hardwareConcurrency ?? null,
        secondsSinceLoad: Math.round((performance.now() - pageStart) / 1000)
    };
}

export function sendClientReport(event: ClientReportEvent, detail = ''): void {
    try {
        const body = JSON.stringify(buildClientReport(event, detail));
        const blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon?.('/api/client-report', blob)) return;
        void fetch('/api/client-report', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {});
    } catch { /* reporting must never break the game */ }
}
