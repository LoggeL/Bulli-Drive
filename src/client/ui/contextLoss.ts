import { releaseKeyboardInputs } from '../controls/keyboard.js';
import { resetMobileControls } from '../controls/mobile.js';
import { sendClientReport } from '../net/clientReport.js';
import { isSafeMode, markGraphicsTrouble } from '../render/safeMode.js';
import { stopLoadingScreen } from './loadingScreen.js';

// The browser can take the WebGL context away at any time (GPU reset, driver
// update, a mobile tab backgrounded under memory pressure). three.js already
// rebuilds its GL state on 'webglcontextrestored'; this module makes the gap
// visible, stops rendering meanwhile and offers a reload if the context
// never comes back.

const RELOAD_OFFER_DELAY_MS = 5000;

let contextLost = false;
let overlay: HTMLElement | null = null;
let reloadButton: HTMLButtonElement | null = null;
let reloadOfferTimeout = 0;

/** True between 'webglcontextlost' and 'webglcontextrestored'. */
export function isWebGLContextLost(): boolean {
    return contextLost;
}

export function watchWebGLContext(canvas: HTMLCanvasElement) {
    canvas.addEventListener('webglcontextlost', (event) => {
        // Without preventDefault the browser never restores the context.
        event.preventDefault();
        if (contextLost) return;
        contextLost = true;
        console.warn('WebGL context lost, waiting for the browser to restore it');
        // Phones usually lose it for want of GPU memory: the next loads use
        // lite graphics (render/safeMode.ts)
        markGraphicsTrouble();
        sendClientReport('context-lost');

        // Drop held keys and touches: nobody can see where the car is going.
        releaseKeyboardInputs();
        resetMobileControls();
        showOverlay();
    }, false);

    canvas.addEventListener('webglcontextrestored', () => {
        if (!contextLost) return;
        contextLost = false;
        console.info('WebGL context restored');
        sendClientReport('context-restored');
        hideOverlay();
    }, false);
}

function showOverlay() {
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'context-lost';
        overlay.setAttribute('role', 'alertdialog');
        overlay.setAttribute('aria-labelledby', 'context-lost-title');

        const card = document.createElement('div');
        card.className = 'context-lost-card';

        const title = document.createElement('h2');
        title.id = 'context-lost-title';
        title.textContent = 'Graphics paused';

        const text = document.createElement('p');
        text.textContent = 'The browser reset the 3D graphics. Restoring…';

        reloadButton = document.createElement('button');
        reloadButton.type = 'button';
        reloadButton.className = 'context-lost-reload';
        reloadButton.textContent = isSafeMode() ? 'Reload game' : 'Reload with lite graphics';
        reloadButton.addEventListener('click', () => {
            markGraphicsTrouble();
            window.location.reload();
        });

        card.append(title, text, reloadButton);
        overlay.appendChild(card);
        document.body.appendChild(overlay);
    }

    overlay.classList.remove('hidden');
    reloadButton!.hidden = true;
    clearTimeout(reloadOfferTimeout);
    reloadOfferTimeout = window.setTimeout(() => {
        if (reloadButton) reloadButton.hidden = false;
    }, RELOAD_OFFER_DELAY_MS);
}

function hideOverlay() {
    clearTimeout(reloadOfferTimeout);
    reloadOfferTimeout = 0;
    overlay?.classList.add('hidden');
}

/**
 * The browser refused a WebGL context (no GPU, WebGL switched off, or
 * blocked for the site after a GPU crash): instead of a loading bar that
 * never ends, say so over the stopped loading screen and offer lite graphics.
 */
export function showGraphicsUnavailable(error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    markGraphicsTrouble();
    sendClientReport('webgl-unavailable', detail);
    // The loading screen's key art stays behind the notice
    stopLoadingScreen('3D graphics unavailable');

    const screen = document.createElement('div');
    screen.id = 'context-lost';
    screen.setAttribute('role', 'alertdialog');
    screen.setAttribute('aria-labelledby', 'graphics-unavailable-title');
    const card = document.createElement('div');
    card.className = 'context-lost-card';
    const title = document.createElement('h2');
    title.id = 'graphics-unavailable-title';
    title.textContent = '3D graphics unavailable';
    const text = document.createElement('p');
    text.textContent = 'Your browser did not allow 3D graphics right now. This often happens after the graphics crashed: close this tab (or the browser) completely, open the game again, and it starts with lite graphics.';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'context-lost-reload';
    retry.textContent = 'Try again';
    retry.addEventListener('click', () => window.location.reload());
    card.append(title, text, retry);
    screen.appendChild(card);
    document.body.appendChild(screen);
}
