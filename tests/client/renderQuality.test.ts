import { describe, expect, it, vi } from 'vitest';
import { AdaptiveRenderQuality, isSoftwareRendererName, wantsAntialias } from '../../src/client/effects/renderQuality.js';

// The adaptive resolution (src/client/effects/renderQuality.ts) and its
// signal that even the lowest resolution is too slow, on which the map
// world drops to its mid detail level (docs/phase-3-design.md A60).
// Frame times are fed in directly; no clock involved.

function renderer() {
    return { setPixelRatio: vi.fn(), setSize: vi.fn(), setDrawingBufferSize: vi.fn() };
}

// Feeds frames of `ms` each for `seconds`, starting at t
function run(quality: AdaptiveRenderQuality, t: number, ms: number, seconds: number): number {
    const end = t + seconds * 1000;
    for (; t < end; t += ms) quality.update(t);
    return t;
}

describe('the adaptive render quality', () => {
    it('steps the pixel ratio down on slow frames, and only then calls the GPU struggling', () => {
        vi.stubGlobal('window', { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) });
        const target = renderer();
        const quality = new AdaptiveRenderQuality(target as never, 800, 600, 'desktop');
        // From 1.0 down to the floor of 0.75: one 4 s window after the 3 s warm-up
        let t = run(quality, 0, 30, 3 + 4.1 + 2.1);
        const ratios = target.setDrawingBufferSize.mock.calls.map(call => call[2]);
        expect(ratios[0]).toBe(0.75);
        expect(quality.struggling).toBe(false);
        // Still slow at the floor for two more windows (after the 2 s settle)
        t = run(quality, t, 30, 4.1);
        expect(quality.struggling).toBe(false);
        t = run(quality, t, 30, 4.1);
        expect(quality.struggling).toBe(true);
        vi.unstubAllGlobals();
    });

    it('draws half a pixel per CSS pixel on a CPU rasterizer, however fast its frames', () => {
        vi.stubGlobal('window', { devicePixelRatio: 2, matchMedia: () => ({ matches: false }) });
        const target = renderer();
        const quality = new AdaptiveRenderQuality(target as never, 800, 600, 'software');
        expect(target.setPixelRatio).toHaveBeenLastCalledWith(0.5);
        // Fast frames never step it up, slow ones never below 0.5
        run(quality, run(quality, 0, 10, 3 + 4.1 * 3), 40, 4.1 * 3);
        expect(target.setDrawingBufferSize).not.toHaveBeenCalled();
        // The desktop starts at the device's ratio
        const desktop = renderer();
        new AdaptiveRenderQuality(desktop as never, 800, 600, 'desktop');
        expect(desktop.setPixelRatio).toHaveBeenLastCalledWith(2);
        vi.unstubAllGlobals();
    });

    it('draws one pixel per CSS pixel in lite graphics, not the CPU rasterizer\'s half', () => {
        vi.stubGlobal('window', { devicePixelRatio: 3, matchMedia: () => ({ matches: true }) });
        const target = renderer();
        const quality = new AdaptiveRenderQuality(target as never, 400, 800, 'software', true);
        expect(target.setPixelRatio).toHaveBeenLastCalledWith(1);
        // Slow frames still step it down, but no lower than the common floor of 0.75
        run(quality, 0, 40, 3 + 4.1 * 4 + 2.1 * 4);
        const ratios = target.setDrawingBufferSize.mock.calls.map(call => call[2]);
        expect(ratios[0]).toBe(0.75);
        expect(Math.min(...ratios)).toBe(0.75);
        vi.unstubAllGlobals();
    });

    it('counts no frame while the menu holds the frame rate down, and warms up again after it', () => {
        // A phone (mobile tier, 3x screen: 1.5 at most) in the menu at 30 fps for a minute
        vi.stubGlobal('window', { devicePixelRatio: 3, matchMedia: () => ({ matches: true }) });
        const target = renderer();
        const quality = new AdaptiveRenderQuality(target as never, 390, 844, 'mobile');
        let t = 0;
        for (; t < 60_000; t += 1000 / 30) quality.pause();
        expect(target.setDrawingBufferSize).not.toHaveBeenCalled();
        expect(quality.struggling).toBe(false);
        // The game at 60 fps: the warm-up starts over, nothing stepped down
        t = run(quality, t, 1000 / 60, 3 + 4.1 * 3);
        expect(target.setDrawingBufferSize).not.toHaveBeenCalled();
        // The same 30 fps measured (as before): 1.5 steps down to the floor
        // and the GPU counts as struggling within 30 s
        const measured = renderer();
        const control = new AdaptiveRenderQuality(measured as never, 390, 844, 'mobile');
        run(control, 0, 1000 / 30, 30);
        expect(measured.setDrawingBufferSize.mock.calls.map(call => call[2])).toEqual([1.25, 1, 0.75]);
        expect(control.struggling).toBe(true);
        vi.unstubAllGlobals();
    });

    it('does not call a GPU struggling that is fast again at the floor', () => {
        vi.stubGlobal('window', { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) });
        const quality = new AdaptiveRenderQuality(renderer() as never, 800, 600, 'desktop');
        let t = run(quality, 0, 30, 3 + 4.1 + 2.1);
        // One slow window at the floor, then fast ones, then one slow again
        t = run(quality, t, 30, 4.1);
        t = run(quality, t, 18, 4.1);
        t = run(quality, t, 30, 4.1);
        expect(quality.struggling).toBe(false);
        vi.unstubAllGlobals();
    });
});

// Renderer names as browsers report them (WEBGL_debug_renderer_info)
const SWIFTSHADER = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)';
const GPUS = [
    'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)',
    'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'Apple GPU',
    'Adreno (TM) 640'
];

describe('the rasterizer', () => {
    it('counts SwiftShader, llvmpipe and the Windows fallback as software, GPUs not', () => {
        for (const name of [SWIFTSHADER, 'llvmpipe (LLVM 15.0.7, 256 bits)', 'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)']) {
            expect(isSoftwareRendererName(name), name).toBe(true);
        }
        for (const name of GPUS) expect(isSoftwareRendererName(name), name).toBe(false);
    });

    // A document whose canvases give a context of this renderer (null: no WebGL)
    function stubDocument(renderer: string | null) {
        const lost: string[] = [];
        const gl = renderer === null ? null : {
            RENDERER: 0x1f01,
            getExtension: (name: string) => name === 'WEBGL_debug_renderer_info'
                ? { UNMASKED_RENDERER_WEBGL: 0x9246 }
                : name === 'WEBGL_lose_context' ? { loseContext: () => lost.push(renderer) } : null,
            getParameter: (parameter: number) => (parameter === 0x9246 ? renderer : 'WebKit WebGL')
        };
        vi.stubGlobal('document', { createElement: () => ({ getContext: () => gl }) });
        return lost;
    }

    it('multisamples on a GPU, not on a CPU rasterizer, and gives the probe context back', () => {
        const lostSoftware = stubDocument(SWIFTSHADER);
        expect(wantsAntialias()).toBe(false);
        expect(lostSoftware).toEqual([SWIFTSHADER]);
        stubDocument(GPUS[0]);
        expect(wantsAntialias()).toBe(true);
        // Without WebGL the renderer fails anyway; the default stays
        stubDocument(null);
        expect(wantsAntialias()).toBe(true);
        vi.unstubAllGlobals();
    });
});
