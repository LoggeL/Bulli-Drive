import type { WebGLRenderer } from 'three';

const MIN_PIXEL_RATIO = 0.75;
const MAX_PIXEL_RATIO = 2;
const PIXEL_RATIO_STEP = 0.25;
const WARMUP_MS = 3000;
const SAMPLE_WINDOW_MS = 4000;
const SETTLE_MS = 2000;
const SLOW_FRAME_MS = 20;
const HEADROOM_FRAME_MS = 16.5;
const MAX_SAMPLE_FRAME_MS = 250;

export type RenderTier = 'desktop' | 'mobile' | 'software';

// Renderer names of CPU rasterizers (Chrome without a usable GPU, Mesa,
// Windows' fallback driver)
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render/i;

/**
 * Static device class for fixed-cost settings such as the shadow map size.
 * Software WebGL (no GPU) gets the cheapest tier, phones and tablets (coarse
 * primary pointer) the mobile tier.
 */
export function detectRenderTier(renderer?: WebGLRenderer): RenderTier {
    if (renderer && SOFTWARE_RENDERER.test(rendererName(renderer))) return 'software';
    const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    return coarse ? 'mobile' : 'desktop';
}

function rendererName(renderer: WebGLRenderer): string {
    const gl = renderer.getContext();
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
}

function maximumPixelRatio(): number {
    return Math.max(MIN_PIXEL_RATIO, Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
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

    constructor(
        private readonly renderer: WebGLRenderer,
        width: number,
        height: number
    ) {
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
            nextPixelRatio = Math.max(MIN_PIXEL_RATIO, nextPixelRatio - PIXEL_RATIO_STEP);
        } else if (averageFrameTime < HEADROOM_FRAME_MS) {
            nextPixelRatio = Math.min(maximum, nextPixelRatio + PIXEL_RATIO_STEP);
        }

        if (nextPixelRatio !== this.pixelRatio) {
            this.pixelRatio = nextPixelRatio;
            this.renderer.setDrawingBufferSize(this.width, this.height, this.pixelRatio);
            this.warmupUntil = frameTime + SETTLE_MS;
        }

        this.resetSampleWindow(frameTime);
    }

    private resetSampleWindow(frameTime: number): void {
        this.sampleWindowStart = frameTime;
        this.sampledFrameTime = 0;
        this.sampledFrames = 0;
    }
}
