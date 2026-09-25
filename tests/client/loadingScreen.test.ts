// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { loadingScreenCovers } from '../../src/client/ui/loadingScreen.js';

// The render loop draws nothing under the opaque loading screen
// (src/client/ui/loadingScreen.ts): it covers the page from the start until
// removeLoader fades it out, then it is gone.

describe('the loading screen', () => {
    it('covers the page until it starts to fade, then no longer', () => {
        document.body.innerHTML = '<div id="loading-screen"></div>';
        expect(loadingScreenCovers()).toBe(true);
        // removeLoader: opacity 0 (the fade), then the element goes
        document.getElementById('loading-screen')!.style.opacity = '0';
        expect(loadingScreenCovers()).toBe(false);
        document.getElementById('loading-screen')!.remove();
        expect(loadingScreenCovers()).toBe(false);
    });
});
