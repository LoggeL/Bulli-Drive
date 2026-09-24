import { afterEach, describe, expect, it, vi } from 'vitest';

// The client side of the dev netsim (src/client/net/netsim.ts,
// docs/phase-1b-design.md 11.5): ?netsim=RTT,JITTER,LOSS delays this tab's
// own socket. The link itself (delays, loss, order) is tested in
// tests/shared/net/netsim.test.ts; here the page flag and the per-socket
// links: each direction holds a message for half the round trip ± half the
// jitter, and a new socket gets new links.

async function loadWithUrl(search: string) {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal('window', { location: { search }, setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) });
    return import('../../src/client/net/netsim.js');
}

describe('the page netsim', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('reads ?netsim=150,30,0 and delays each direction by 60 to 90 ms', async () => {
        const { NETSIM, createSocketNetsim } = await loadWithUrl('?e2e=1&netsim=150,30,0');
        expect(NETSIM).toEqual({ rttMs: 150, jitterMs: 30, loss: 0, mode: 'tcp' });

        const link = createSocketNetsim()!;
        expect(link).not.toBeNull();
        const arrivals: Array<{ dir: string; at: number }> = [];
        const start = performance.now();
        for (let i = 0; i < 20; i++) {
            link.up.send(() => arrivals.push({ dir: 'up', at: performance.now() - start }), true);
            link.down.send(() => arrivals.push({ dir: 'down', at: performance.now() - start }), false);
        }
        vi.advanceTimersByTime(59);
        expect(arrivals).toEqual([]);
        vi.advanceTimersByTime(40);
        expect(arrivals).toHaveLength(40);
        // 150 / 2 = 75 ms ± 30 / 2
        for (const { at } of arrivals) {
            expect(at).toBeGreaterThanOrEqual(60);
            expect(at).toBeLessThanOrEqual(90);
        }
    });

    it('gives every socket its own links', async () => {
        const { createSocketNetsim } = await loadWithUrl('?netsim=100');
        const first = createSocketNetsim()!;
        const second = createSocketNetsim()!;
        expect(second).not.toBe(first);
        // What the old socket still holds never arrives on the new one
        let old = 0;
        first.down.send(() => old++, true);
        first.close();
        vi.advanceTimersByTime(200);
        expect(old).toBe(0);
        expect(second.down.pending).toBe(0);
    });

    it('is off without the flag, and warns about a broken one', async () => {
        const plain = await loadWithUrl('?e2e=1');
        expect(plain.NETSIM).toBeNull();
        expect(plain.createSocketNetsim()).toBeNull();

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const broken = await loadWithUrl('?netsim=fast');
        expect(broken.NETSIM).toBeNull();
        expect(broken.createSocketNetsim()).toBeNull();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('?netsim=fast is not valid'));
    });
});
