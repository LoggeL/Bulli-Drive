import { describe, expect, it } from 'vitest';
import { contactShadowLook } from '../../src/client/render/lighting.js';

// The contact shadow under a car (src/client/render/lighting.ts): whole on
// the ground and on its springs, paler and smaller the higher the car flies
// (docs/phase-1a-design.md, 26.8).

describe('the contact shadow in the air', () => {
    it('is whole on the ground and below it (a compressed spring)', () => {
        expect(contactShadowLook(0)).toEqual({ fade: 1, size: 1 });
        expect(contactShadowLook(-0.1)).toEqual({ fade: 1, size: 1 });
    });

    it('gets paler and smaller as the car rises, nearly gone at 10 m', () => {
        let last = contactShadowLook(0);
        for (const lift of [0.2, 0.5, 1, 2, 4, 8, 10]) {
            const look = contactShadowLook(lift);
            expect(look.fade, `${lift} m`).toBeLessThan(last.fade);
            expect(look.size, `${lift} m`).toBeLessThan(last.size);
            last = look;
        }
        // A short hop (half a metre) still shows a clear shadow
        expect(contactShadowLook(0.5).fade).toBeGreaterThan(0.7);
        expect(contactShadowLook(10).fade).toBeLessThan(0.1);
        expect(contactShadowLook(10).size).toBeGreaterThan(0.5);
    });
});
