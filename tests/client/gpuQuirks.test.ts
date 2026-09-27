import { describe, expect, it } from 'vitest';
import { shadowMapAllowed } from '../../src/client/effects/renderQuality.js';

// GPUs that lose the WebGL context on the shadow pass
// (src/client/effects/renderQuality.ts). The names are what the devices
// reported to /api/client-reports or what these GPUs report in Chrome.

const POWERVR_PIXEL = 'ANGLE (Imagination Technologies, PowerVR D-Series DXT-48-1536, OpenGL ES 3.2)';

describe('shadowMapAllowed', () => {
    it('keeps the shadow map off on the PowerVR GPU that crashed on it', () => {
        expect(shadowMapAllowed(POWERVR_PIXEL, '')).toBe(false);
    });

    it('keeps it on for other phone and desktop GPUs', () => {
        for (const name of [
            'ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)',
            'ANGLE (ARM, Mali-G715, OpenGL ES 3.2)',
            'Apple GPU',
            'ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)'
        ]) {
            expect(shadowMapAllowed(name, ''), name).toBe(true);
        }
    });

    it('follows ?shadows=1 and ?shadows=0 over the list', () => {
        expect(shadowMapAllowed(POWERVR_PIXEL, '?shadows=1')).toBe(true);
        expect(shadowMapAllowed('Apple GPU', '?shadows=0')).toBe(false);
        expect(shadowMapAllowed('Apple GPU', '?shadows=maybe')).toBe(true);
    });
});
