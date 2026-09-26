import { describe, expect, it } from 'vitest';
import { clearSafeMode, isSafeMode, markGraphicsTrouble, SAFE_MODE_KEY, type SafeModeEnv } from '../../src/client/render/safeMode.js';

// Lite graphics after a lost or refused WebGL context
// (src/client/render/safeMode.ts): sticky for 7 days, ?lite=1 forces it,
// ?lite=0 clears it, and broken storage never throws.

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 26);

function env(search = '', now = T0, store = new Map<string, string>()): SafeModeEnv & { store: Map<string, string> } {
    return {
        search, now, store,
        storage: {
            getItem: key => store.get(key) ?? null,
            setItem: (key, value) => { store.set(key, value); },
            removeItem: key => { store.delete(key); }
        }
    };
}

describe('safe mode', () => {
    it('is off on a device without earlier trouble', () => {
        expect(isSafeMode(env())).toBe(false);
    });

    it('stays on for seven days after graphics trouble, then ends', () => {
        const store = new Map<string, string>();
        markGraphicsTrouble(env('', T0, store));
        expect(isSafeMode(env('', T0 + 1, store))).toBe(true);
        expect(isSafeMode(env('', T0 + 7 * DAY - 1, store))).toBe(true);
        expect(isSafeMode(env('', T0 + 7 * DAY, store))).toBe(false);
    });

    it('is forced on by ?lite=1 without touching storage', () => {
        const e = env('?lite=1');
        expect(isSafeMode(e)).toBe(true);
        expect(e.store.size).toBe(0);
    });

    it('is cleared by ?lite=0 even right after trouble', () => {
        const store = new Map<string, string>();
        markGraphicsTrouble(env('', T0, store));
        expect(isSafeMode(env('?lite=0', T0 + 1, store))).toBe(false);
        expect(store.has(SAFE_MODE_KEY)).toBe(false);
        expect(isSafeMode(env('', T0 + 2, store))).toBe(false);
    });

    it('ignores a garbled stored value', () => {
        expect(isSafeMode(env('', T0, new Map([[SAFE_MODE_KEY, 'soon']])))).toBe(false);
    });

    it('treats unavailable or throwing storage as no trouble and never throws', () => {
        const throwing: SafeModeEnv = {
            search: '', now: T0,
            storage: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } }
        };
        expect(() => markGraphicsTrouble(throwing)).not.toThrow();
        expect(() => clearSafeMode(throwing)).not.toThrow();
        expect(isSafeMode(throwing)).toBe(false);
        expect(isSafeMode({ search: '', now: T0, storage: null })).toBe(false);
    });
});
