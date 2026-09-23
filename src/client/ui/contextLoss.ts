import { releaseKeyboardInputs } from '../controls/keyboard.js';
import { resetMobileControls } from '../controls/mobile.js';

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

        // Drop held keys and touches: nobody can see where the car is going.
        releaseKeyboardInputs();
        resetMobileControls();
        showOverlay();
    }, false);

    canvas.addEventListener('webglcontextrestored', () => {
        if (!contextLost) return;
        contextLost = false;
        console.info('WebGL context restored');
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
        reloadButton.textContent = 'Reload game';
        reloadButton.addEventListener('click', () => window.location.reload());

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
