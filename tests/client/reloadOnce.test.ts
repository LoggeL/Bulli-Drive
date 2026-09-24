import { afterEach, describe, expect, it, vi } from 'vitest';
import { reloadOnce } from '../../src/client/network/reloadOnce.js';

// The reload guard of the connection (src/client/network/reloadOnce.ts): a
// server with a newer protocol (or build, or world) reloads the page once
// per value; the reloaded page, rejected again, stays and says why instead
// of reloading in a loop.

function page(storageThrows = false) {
    const storage = new Map<string, string>();
    const state = { reloads: 0, storage };
    vi.stubGlobal('sessionStorage', {
        getItem: (key: string) => {
            if (storageThrows) throw new Error('SecurityError');
            return storage.get(key) ?? null;
        },
        setItem: (key: string, value: string) => {
            if (storageThrows) throw new Error('SecurityError');
            storage.set(key, value);
        }
    });
    vi.stubGlobal('window', { location: { reload: () => { state.reloads++; } } });
    return state;
}

describe('reloadOnce', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('reloads once per server protocol, then holds', () => {
        const p = page();
        expect(reloadOnce('bulli-protocol-reload', '4')).toBe(true);
        expect(p.reloads).toBe(1);
        // The reloaded page is rejected by the same server again
        expect(reloadOnce('bulli-protocol-reload', '4')).toBe(false);
        expect(p.reloads).toBe(1);
        // A yet newer protocol reloads again
        expect(reloadOnce('bulli-protocol-reload', '5')).toBe(true);
        expect(p.reloads).toBe(2);
    });

    it('keeps the guards of different reasons apart', () => {
        const p = page();
        expect(reloadOnce('bulli-protocol-reload', 'x')).toBe(true);
        expect(reloadOnce('bulli-world-reload', 'x')).toBe(true);
        expect(p.reloads).toBe(2);
    });

    it('never reloads without sessionStorage, so it cannot loop', () => {
        const p = page(true);
        expect(reloadOnce('bulli-protocol-reload', '4')).toBe(false);
        expect(p.reloads).toBe(0);
    });
});
