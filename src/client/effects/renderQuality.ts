import type { WebGLRenderer } from 'three';
import { highGraphics, isSafeMode } from '../render/safeMode.js';

const MIN_PIXEL_RATIO = 0.75;
const MAX_PIXEL_RATIO = 2;
const PIXEL_RATIO_STEP = 0.25;
const WARMUP_MS = 3000;
const SAMPLE_WINDOW_MS = 4000;
const SETTLE_MS = 2000;
const SLOW_FRAME_MS = 20;
const HEADROOM_FRAME_MS = 16.5;
const MAX_SAMPLE_FRAME_MS = 250;
// Slow sample windows at the lowest pixel ratio before the GPU counts as
// struggling (the map world then drops to its mid detail level)
const STRUGGLE_WINDOWS = 2;

// Quality tiers of the world look (docs/graphics.md): 'desktop' is the high
// tier, 'mobile' the low tier (phones: 1024 shadow map, no normal maps,
// pixel ratio at most 1.5), 'software' the cheapest one for CPU rasterizers
// (SwiftShader in the e2e tests: Lambert materials, no environment map).
export type RenderTier = 'desktop' | 'mobile' | 'software';

// ?tier=high|low|software (or desktop|mobile) forces a tier, e.g. to look at
// the phone tier on a desktop
const TIER_OVERRIDE: Record<string, RenderTier> = {
    high: 'desktop', desktop: 'desktop', low: 'mobile', mobile: 'mobile', software: 'software'
};

function tierOverride(): RenderTier | null {
    if (typeof window === 'undefined' || !window.location) return null;
    return TIER_OVERRIDE[new URLSearchParams(window.location.search).get('tier') ?? ''] ?? null;
}

// Renderer names of CPU rasterizers (Chrome without a usable GPU, Mesa,
// Windows' fallback driver)
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render/i;

/**
 * Static device class for fixed-cost settings such as the shadow map size.
 * Software WebGL (no GPU) gets the cheapest tier, phones and tablets (coarse
 * primary pointer) the mobile tier.
 */
export function detectRenderTier(renderer?: WebGLRenderer): RenderTier {
    const forced = tierOverride();
    if (forced) return forced;
    // Lite graphics after a lost or refused WebGL context, or picked in the
    // menu (render/safeMode.ts)
    if (isSafeMode()) return 'software';
    // High picked in the menu: the desktop look on any device (docs/ui.md 7)
    if (highGraphics()) return 'desktop';
    if (renderer && isSoftwareRendererName(glRendererName(renderer.getContext()))) return 'software';
    const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    return coarse ? 'mobile' : 'desktop';
}

/** Whether a WebGL renderer name (WEBGL_debug_renderer_info) is a CPU rasterizer. */
export function isSoftwareRendererName(name: string): boolean {
    return SOFTWARE_RENDERER.test(name);
}

function glRendererName(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
}

/**
 * Multisampling for the page's renderer, decided before it exists (its
 * canvas fixes it): not on a CPU rasterizer, where it costs a third of every
 * frame (SwiftShader, measured with the map world; docs/phase-3-design.md
 * A64). A throwaway context tells the rasterizer.
 */
export function wantsAntialias(): boolean {
    if (typeof document === 'undefined') return true;
    // High picked in the menu: MSAA whatever the device (docs/ui.md 7)
    if (highGraphics()) return true;
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return true;
    const software = isSoftwareRendererName(glRendererName(gl));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return !software;
}

// The low (mobile) tier renders at most 1.5 device pixels per CSS pixel: the
// textured world costs more per pixel than the flat colors did. A CPU
// rasterizer draws half a pixel per CSS pixel on each axis: a softer picture
// at a third less time per frame (SwiftShader with Bulli Bay,
// docs/phase-3-design.md A64)
const MAX_PIXEL_RATIO_BY_TIER: Record<RenderTier, number> = { desktop: MAX_PIXEL_RATIO, mobile: 1.5, software: 0.5 };
const MIN_PIXEL_RATIO_BY_TIER: Record<RenderTier, number> = { desktop: MIN_PIXEL_RATIO, mobile: MIN_PIXEL_RATIO, software: 0.5 };
let tierPixelRatioCap = MAX_PIXEL_RATIO;
let tierPixelRatioFloor = MIN_PIXEL_RATIO;

function maximumPixelRatio(): number {
    return Math.max(tierPixelRatioFloor, Math.min(window.devicePixelRatio || 1, tierPixelRatioCap));
}

/**
 * Adjusts drawing-buffer resolution only after sustained performance samples.
 * CSS sizing remains owned by resize(), so quality changes do not affect layout.
 */
export class AdaptiveRenderQuality {
    private pixelRatio: number;
    private width: number;
    private height: number;
    private previousFrameTime = -1;
    private warmupUntil = 0;
    private sampleWindowStart = 0;
    private sampledFrameTime = 0;
    private sampledFrames = 0;
    private slowAtFloor = 0;
    /** Slow even at the lowest pixel ratio for a while: less detail is the only way left. */
    struggling = false;

    constructor(
        private readonly renderer: WebGLRenderer,
        width: number,
        height: number,
        tier: RenderTier = 'desktop',
        lite: boolean = isSafeMode()
    ) {
        // Lite graphics (render/safeMode.ts) use the software tier's look on a
        // real GPU: one device pixel per CSS pixel, a quarter of the pixels of
        // 2x, not the CPU rasterizer's blurry half pixel
        tierPixelRatioCap = lite ? 1 : MAX_PIXEL_RATIO_BY_TIER[tier];
        tierPixelRatioFloor = lite ? MIN_PIXEL_RATIO : MIN_PIXEL_RATIO_BY_TIER[tier];
        this.width = width;
        this.height = height;
        this.pixelRatio = maximumPixelRatio();
        renderer.setPixelRatio(this.pixelRatio);
        renderer.setSize(width, height);
    }

    resize(width: number, height: number): void {
        this.width = width;
        this.height = height;

        const maximum = maximumPixelRatio();
        if (this.pixelRatio > maximum) {
            this.pixelRatio = maximum;
            this.renderer.setPixelRatio(this.pixelRatio);
        }
        this.renderer.setSize(width, height);
    }

    update(frameTime: number): void {
        if (this.previousFrameTime < 0) {
            this.previousFrameTime = frameTime;
            this.warmupUntil = frameTime + WARMUP_MS;
            return;
        }

        const elapsed = frameTime - this.previousFrameTime;
        this.previousFrameTime = frameTime;

        if (frameTime < this.warmupUntil) {
            this.sampleWindowStart = 0;
            return;
        }

        if (elapsed <= 0 || elapsed > MAX_SAMPLE_FRAME_MS) {
            this.resetSampleWindow(frameTime);
            return;
        }

        if (this.sampleWindowStart === 0) this.sampleWindowStart = frameTime;
        this.sampledFrameTime += elapsed;
        this.sampledFrames++;

        if (frameTime - this.sampleWindowStart < SAMPLE_WINDOW_MS) return;

        const averageFrameTime = this.sampledFrameTime / this.sampledFrames;
        const maximum = maximumPixelRatio();
        let nextPixelRatio = Math.min(this.pixelRatio, maximum);

        if (averageFrameTime > SLOW_FRAME_MS) {
            if (nextPixelRatio <= tierPixelRatioFloor && ++this.slowAtFloor >= STRUGGLE_WINDOWS) this.struggling = true;
            nextPixelRatio = Math.max(tierPixelRatioFloor, nextPixelRatio - PIXEL_RATIO_STEP);
        } else if (averageFrameTime < HEADROOM_FRAME_MS) {
            nextPixelRatio = Math.min(maximum, nextPixelRatio + PIXEL_RATIO_STEP);
        }

        if (averageFrameTime <= SLOW_FRAME_MS) this.slowAtFloor = 0;
        if (nextPixelRatio !== this.pixelRatio) {
            this.pixelRatio = nextPixelRatio;
            this.renderer.setDrawingBufferSize(this.width, this.height, this.pixelRatio);
            this.warmupUntil = frameTime + SETTLE_MS;
        }

        this.resetSampleWindow(frameTime);
    }

    /**
     * A frame that is no measure of the GPU (the menu holds the frame rate
     * down): nothing is sampled, and the next measured frame starts over
     * with the warm-up.
     */
    pause(): void {
        this.previousFrameTime = -1;
        this.sampleWindowStart = 0;
        this.sampledFrameTime = 0;
        this.sampledFrames = 0;
    }

    private resetSampleWindow(frameTime: number): void {
        this.sampleWindowStart = frameTime;
        this.sampledFrameTime = 0;
        this.sampledFrames = 0;
    }
}
