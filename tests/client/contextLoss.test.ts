// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { isWebGLContextLost, watchWebGLContext } from '../../src/client/ui/contextLoss.js';
import { inputManager } from '../../src/client/input/InputManager.js';
import { createVehicleInput } from '../../src/shared/sim/types.js';

// A lost WebGL context (GPU reset, driver update, a phone tab backgrounded
// under memory pressure) - src/client/ui/contextLoss.ts: the page pauses
// with a notice, lets go of every held input, offers a reload only if the
// context stays away for 5 s, and goes on once the browser restores it.
// The real loss and restore in a browser are a step of
// tests/e2e/desktop.spec.ts.

// Graphics trouble reports (net/clientReport.ts) go out as a beacon; the
// test page has no server to send them to
Object.defineProperty(navigator, 'sendBeacon', { value: () => true, configurable: true });

const canvas = document.createElement('canvas');

function lose(): Event {
    const event = new Event('webglcontextlost', { cancelable: true });
    canvas.dispatchEvent(event);
    return event;
}

function restore(): void {
    canvas.dispatchEvent(new Event('webglcontextrestored'));
}

const notice = () => document.getElementById('context-lost');
const reloadButton = () => notice()?.querySelector<HTMLButtonElement>('button') ?? null;

describe('a lost WebGL context', () => {
    beforeAll(() => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'info').mockImplementation(() => {});
        watchWebGLContext(canvas);
    });

    afterEach(() => {
        if (isWebGLContextLost()) restore();
        vi.useRealTimers();
        inputManager.releaseAll();
    });

    it('pauses with a notice and asks the browser to restore it', () => {
        expect(notice()).toBeNull();
        const event = lose();
        // Without preventDefault the browser never restores the context
        expect(event.defaultPrevented).toBe(true);
        expect(isWebGLContextLost()).toBe(true);
        expect(notice()!.classList.contains('hidden')).toBe(false);
        expect(notice()!.querySelector('h2')!.textContent).toBe('Graphics paused');
        restore();
        expect(isWebGLContextLost()).toBe(false);
        expect(notice()!.classList.contains('hidden')).toBe(true);
    });

    it('offers a reload only after 5 s without the context', () => {
        vi.useFakeTimers();
        lose();
        expect(reloadButton()!.hidden).toBe(true);
        vi.advanceTimersByTime(4999);
        expect(reloadButton()!.hidden).toBe(true);
        vi.advanceTimersByTime(1);
        expect(reloadButton()!.hidden).toBe(false);
        expect(reloadButton()!.textContent).toBe('Reload game');

        // Restored in time the next time: no reload offer shows up later
        restore();
        lose();
        expect(reloadButton()!.hidden).toBe(true);
        vi.advanceTimersByTime(3000);
        restore();
        vi.advanceTimersByTime(5000);
        expect(reloadButton()!.hidden).toBe(true);
    });

    it('lets go of held keys and touches, so the car does not drive on unseen', () => {
        inputManager.keyDown('up');
        inputManager.keyDown('left');
        inputManager.touchUi = true;
        inputManager.setStick(0.5, -1, true);
        const held = inputManager.sampleTick(createVehicleInput());
        expect(held.throttle).toBe(255);
        expect(held.steer).not.toBe(0);

        lose();
        const input = inputManager.sampleTick(createVehicleInput());
        expect(input).toMatchObject({ throttle: 0, steer: 0, brake: 0, buttons: 0 });
        // Auto-gas waits for the next touch of the stick as well
        expect(inputManager.autoGasActive).toBe(false);
        inputManager.touchUi = false;
    });

    it('ignores a second loss event and a restore without a loss', () => {
        vi.useFakeTimers();
        restore();
        expect(isWebGLContextLost()).toBe(false);
        lose();
        vi.advanceTimersByTime(3000);
        // A second event must not start the 5 s over
        lose();
        vi.advanceTimersByTime(2000);
        expect(reloadButton()!.hidden).toBe(false);
        expect(document.querySelectorAll('#context-lost')).toHaveLength(1);
    });
});

describe('WebGL refused at start', () => {
    it('stops the loading screen behind an explanation and switches to lite graphics', async () => {
        const { showGraphicsUnavailable } = await import('../../src/client/ui/contextLoss.js');
        const { isSafeMode } = await import('../../src/client/render/safeMode.js');
        localStorage.clear();
        const loader = document.createElement('div');
        loader.id = 'loading-screen';
        loader.innerHTML = '<p class="loader-status">Loading the game</p>';
        document.body.appendChild(loader);

        showGraphicsUnavailable(new Error('Error creating WebGL context.'));

        // The key art stays as the backdrop, its bar stops and says why
        expect(loader.isConnected).toBe(true);
        expect(loader.classList.contains('loader-stopped')).toBe(true);
        expect(loader.querySelector('.loader-status')!.textContent).toBe('3D graphics unavailable');
        const dialog = document.querySelector('[role="alertdialog"][aria-labelledby="graphics-unavailable-title"]');
        expect(dialog?.textContent).toContain('3D graphics unavailable');
        // A first refusal: WebGL is off, a crash is not the likely cause
        expect(dialog?.textContent).toContain('hardware acceleration');
        expect(dialog?.textContent).not.toContain('crashed');
        // Over the loader: later in the page at the same position (z-index in style.css)
        expect(loader.compareDocumentPosition(dialog!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(isSafeMode()).toBe(true);
        dialog?.remove();
        // Refused again within the lite days after that trouble: the crash is the likely cause
        showGraphicsUnavailable(new Error('Error creating WebGL context.'));
        const again = document.querySelector('[aria-labelledby="graphics-unavailable-title"]');
        expect(again?.textContent).toContain('crashed');
        expect(again?.textContent).not.toContain('hardware acceleration');
        again?.remove();
        loader.remove();
        localStorage.clear();
    });
});
