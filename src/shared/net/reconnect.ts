// Reconnect policy of the client (docs/phase-1b-design.md, 11.1): what a
// close code means and how long to wait before the next attempt. Pure, so
// the browser and the bots decide the same way and the tests can check it.

import {
    CLOSE_FULL, CLOSE_HELLO, CLOSE_IDLE, CLOSE_POLICY, CLOSE_RESTART, CLOSE_TAKEN_OVER, CLOSE_VERSION
} from './constants.js';
import type { RandomSource } from '../math/rng.js';

// Waits before attempt n (0-based): 0.5 s, 1 s, 2 s, 4 s, then every 8 s,
// each ±20 %, without end
export const RECONNECT_STEPS_MS = [500, 1000, 2000, 4000, 8000] as const;
export const RECONNECT_JITTER = 0.2;
// A restart announced by 'shutdown' without a time
export const RESTART_RECONNECT_MS = 1500;
// The overlay shows after this long without a connection, and offers a
// reload after RELOAD_OFFER_MS
export const OVERLAY_AFTER_MS = 1000;
export const RELOAD_OFFER_MS = 30_000;
// While disconnected the own car is predicted this far, then held (11.1)
export const OFFLINE_PREDICT_MS = 250;

export function reconnectDelayMs(attempt: number, random: RandomSource): number {
    const base = RECONNECT_STEPS_MS[Math.min(Math.max(0, attempt), RECONNECT_STEPS_MS.length - 1)];
    return Math.round(base * (1 + (random() * 2 - 1) * RECONNECT_JITTER));
}

/**
 * What the client does after a close:
 * - 'reconnect': on its own, with backoff (lost connection, restart, the
 *   server full for now, anything unknown)
 * - 'reload': the version check handles it (4000)
 * - 'manual': only by a button (policy kick, session taken over by
 *   another page, a hello the server did not take)
 * - 'continue': the idle kick; a button reconnects
 */
export type CloseAction = 'reconnect' | 'reload' | 'manual' | 'continue';

export function closeAction(code: number): CloseAction {
    switch (code) {
        case CLOSE_VERSION: return 'reload';
        case CLOSE_POLICY:
        case CLOSE_TAKEN_OVER:
        case CLOSE_HELLO: return 'manual';
        case CLOSE_IDLE: return 'continue';
        case CLOSE_FULL:
        case CLOSE_RESTART:
        default: return 'reconnect';
    }
}
