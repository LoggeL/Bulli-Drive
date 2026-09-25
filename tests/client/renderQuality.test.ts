import { describe, expect, it, vi } from 'vitest';
import { AdaptiveRenderQuality } from '../../src/client/effects/renderQuality.js';

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
