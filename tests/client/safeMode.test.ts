import { describe, expect, it } from 'vitest';
import {
    clearSafeMode, graphicsSetting, GRAPHICS_KEY, highGraphics, isSafeMode, markGraphicsTrouble, safeModeReason, SAFE_MODE_KEY,
    setGraphicsSetting, type SafeModeEnv
} from '../../src/client/render/safeMode.js';

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

    it('names why it is on: the link, or earlier trouble on this device', () => {
        expect(safeModeReason(env())).toBeNull();
        expect(safeModeReason(env('?lite=1'))).toBe('link');
        const store = new Map<string, string>();
        markGraphicsTrouble(env('', T0, store));
        expect(safeModeReason(env('', T0 + 1, store))).toBe('trouble');
        // The link wins over the stored trouble
        expect(safeModeReason(env('?lite=1', T0 + 1, store))).toBe('link');
        expect(safeModeReason(env('?lite=0', T0 + 1, store))).toBeNull();
    });

    // docs/ui.md 7: the link over the setting over the trouble timer over the automatic tier
    it('ranks the link over the menu setting over earlier trouble', () => {
        const cases: Array<[string, string | null, boolean, 'link' | 'setting' | 'trouble' | null, boolean]> = [
            // search, setting, trouble, reason, high tier forced
            ['', null, false, null, false],
            ['', 'lite', false, 'setting', false],
            ['', 'high', false, null, true],
            ['', null, true, 'trouble', false],
            ['', 'lite', true, 'setting', false],
            ['?lite=1', 'high', false, 'link', false],
            ['?lite=0', 'lite', true, null, false],
            ['?lite=0', 'high', false, null, false],
            ['', 'turbo', true, 'trouble', false]
        ];
        for (const [search, setting, trouble, reason, high] of cases) {
            const store = new Map<string, string>();
            if (trouble) store.set(SAFE_MODE_KEY, String(T0 + DAY));
            if (setting) store.set(GRAPHICS_KEY, setting);
            const label = `${search} ${setting} ${trouble}`;
            expect(safeModeReason(env(search, T0, store)), label).toBe(reason);
            expect(highGraphics(env(search, T0, store)), label).toBe(high);
        }
    });

    it('keeps High over earlier trouble, until new trouble puts it back to Auto', () => {
        const store = new Map<string, string>([[SAFE_MODE_KEY, String(T0 + DAY)]]);
        setGraphicsSetting('high', env('', T0, store));
        expect(safeModeReason(env('', T0, store))).toBeNull();
        markGraphicsTrouble(env('', T0, store));
        expect(graphicsSetting(env('', T0, store))).toBe('auto');
        expect(safeModeReason(env('', T0 + 1, store))).toBe('trouble');
        // Auto is the absence of a setting; Lite stays over new trouble
        expect(store.has(GRAPHICS_KEY)).toBe(false);
        setGraphicsSetting('lite', env('', T0, store));
        markGraphicsTrouble(env('', T0, store));
        expect(graphicsSetting(env('', T0, store))).toBe('lite');
    });
});
