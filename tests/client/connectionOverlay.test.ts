// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    connectionOverlayText, hideConnectionOverlay, loaderWaitingText, reconnectingText, showConnectionNotice, showReconnecting
} from '../../src/client/ui/connectionOverlay.js';
import { CLOSE_FULL, CLOSE_RESTART } from '../../src/shared/net/constants.js';
import { closeAction } from '../../src/shared/net/reconnect.js';

// The connection banner (src/client/ui/connectionOverlay.ts,
// docs/phase-1b-design.md 11.1): what it says while the client tries again,
// when it shows (after a second without a connection) and when it offers a
// reload (after 30 s). A first connection that fails (a deploy restarting
// the server) is retried like a lost one; the backoff is tested in
// tests/shared/net/netsim.test.ts ('reconnect policy').

const button = () => document.querySelector<HTMLButtonElement>('#net-notice button')!;

describe('the connection banner', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        hideConnectionOverlay();
        vi.useRealTimers();
    });

    it('says whether the page is connecting for the first time or reconnecting', () => {
        // A server restarting during a deploy closes the first sockets
        // with 1011 or 1012 before any welcome: retried, the loader stays
        for (const code of [1006, 1011, CLOSE_RESTART]) {
            expect(closeAction(code), String(code)).toBe('reconnect');
            expect(reconnectingText(code, false)).toBe('Connecting to the server…');
            expect(reconnectingText(code, true)).toBe('Reconnecting…');
        }
        expect(reconnectingText(CLOSE_FULL, false)).toBe('The server is full, retrying…');
        expect(reconnectingText(CLOSE_FULL, true)).toBe('The server is full, retrying…');
        // The loading screen's status line says it instead of the banner (ui/loadingScreen.ts)
        expect(loaderWaitingText(1006)).toBe('Waiting for the server · retrying');
        expect(loaderWaitingText(CLOSE_FULL)).toBe('The server is full · retrying');
    });

    it('shows a second after the connection went, and offers a reload after 30 s', () => {
        const since = performance.now();
        showReconnecting(since, 'Reconnecting…');
        vi.advanceTimersByTime(999);
        expect(connectionOverlayText()).toBeNull();
        vi.advanceTimersByTime(1);
        expect(connectionOverlayText()).toBe('Reconnecting…');
        expect(button().hidden).toBe(true);
        vi.advanceTimersByTime(29_000);
        expect(button().hidden).toBe(false);
        expect(button().textContent).toBe('Reload');
        hideConnectionOverlay();
        expect(connectionOverlayText()).toBeNull();
    });

    it('shows at once when the connection has been gone for a while already', () => {
        showReconnecting(performance.now() - 5000, 'Connecting to the server…');
        expect(connectionOverlayText()).toBe('Connecting to the server…');
    });

    it('keeps a notice with its own button, and a new banner cancels the old timers', () => {
        const action = vi.fn();
        showReconnecting(performance.now(), 'Reconnecting…');
        showConnectionNotice('Playing in another tab', 'Reconnect', action);
        expect(connectionOverlayText()).toBe('Playing in another tab');
        // The pending banner of the reconnect does not overwrite the notice
        vi.advanceTimersByTime(31_000);
        expect(connectionOverlayText()).toBe('Playing in another tab');
        expect(button().textContent).toBe('Reconnect');
        button().click();
        expect(action).toHaveBeenCalledTimes(1);
    });
});
