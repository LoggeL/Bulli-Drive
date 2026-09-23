import type { Page } from '@playwright/test';
import { test, expect, joinGame, snapshot, distance, placeOnClearRunway, v2, netState } from './fixtures.js';
import { CAR_IDLE, CAR_LAGGY } from '../../src/shared/net/codec.js';

// Two players: each sees the other, and a bump pushes the car that is hit.
// The server simulates both cars (docs/phase-1b-design.md, 5); each client
// predicts its own car and, once they are close, the other one in its
// contact set (8.5), so the bump acts on both sides.

test.use({ viewport: { width: 800, height: 500 } });

async function place(page: Page, x: number, z: number) {
    await page.evaluate(({ x, z }) => (window as unknown as {
        __bulliDebug: { placeLocalCar(x: number, z: number, angle: number): void };
    }).__bulliDebug.placeLocalCar(x, z, 0), { x, z });
}

// Neither car is an idle or lag ghost (a stalled software-rendered page is
// one for a few seconds, 5.4); the server lets ghosts drive through
async function waitUntilSolid(pages: Page[]) {
    for (const page of pages) {
        await expect.poll(async () => (await netState(page)).selfFlags & (CAR_IDLE | CAR_LAGGY), { timeout: 30_000 }).toBe(0);
    }
}

test('two v2 players see each other and bump into each other', async ({ openPlayer }) => {
    const alice = await openPlayer('alice-v2');
    const bob = await openPlayer('bob-v2');
    const aliceId = await joinGame(alice, 'E2E Alice V2');
    const bobId = await joinGame(bob, 'E2E Bob V2');

    await expect.poll(async () => (await snapshot(bob.page)).remotes[aliceId]?.name).toBe('E2E Alice V2');
    await expect.poll(async () => (await snapshot(alice.page)).remotes[bobId]?.name).toBe('E2E Bob V2');

    // Bob waits on a free road, Alice lines up 25 m behind him and drives
    // into him. A run in which one of the pages stalled into a lag ghost on
    // the way does not count and is driven again
    const runway = await placeOnClearRunway(alice.page);
    const bobStart = { x: runway.x, z: runway.z + 25 };
    let approach = { min: 0, proxies: 0, flags: CAR_LAGGY };
    for (let attempt = 0; attempt < 3 && (approach.flags & (CAR_IDLE | CAR_LAGGY)) !== 0; attempt++) {
        if (attempt > 0) {
            await place(alice.page, runway.x, runway.z);
            await expect.poll(async () => distance(runway, (await snapshot(alice.page)).local!)).toBeLessThan(0.1);
        }
        await place(bob.page, bobStart.x, bobStart.z);
        await expect.poll(async () => distance(bobStart, (await snapshot(alice.page)).remotes[bobId])).toBeLessThan(0.1);
        await expect.poll(async () => distance(runway, (await snapshot(bob.page)).remotes[aliceId])).toBeLessThan(0.1);
        await waitUntilSolid([alice.page, bob.page]);

        await alice.page.keyboard.down('w');
        await expect.poll(async () => {
            const view = await snapshot(alice.page);
            return distance(view.local!, view.remotes[bobId]);
        }, { timeout: 30_000 }).toBeLessThan(6);
        // Closest approach over the next seconds on Alice's screen: the cars
        // touch (circles 1.1-1.4 m) but never drive through each other, and
        // Bob is in her contact set while they are close
        approach = await alice.page.evaluate(async (bobId) => {
            const debug = (window as unknown as { __bulliDebug: { snapshot(): {
                local: { x: number; z: number }; remotes: Record<string, { x: number; z: number }>;
                v2: { proxies: number };
            } } }).__bulliDebug;
            const net = (window as unknown as { __bulliNet: { snapshot(): { selfFlags: number; remoteFlags: Record<string, number> } } }).__bulliNet;
            let min = Infinity, proxies = 0, flags = 0;
            const until = performance.now() + 2500;
            while (performance.now() < until) {
                await new Promise(resolve => requestAnimationFrame(resolve));
                const view = debug.snapshot();
                const remote = view.remotes[bobId];
                if (remote) min = Math.min(min, Math.hypot(view.local.x - remote.x, view.local.z - remote.z));
                proxies = Math.max(proxies, view.v2.proxies);
                const n = net.snapshot();
                flags |= n.selfFlags | (n.remoteFlags[bobId] ?? 0);
            }
            return { min, proxies, flags };
        }, bobId);
        test.info().annotations.push({ type: 'bump', description: `attempt ${attempt + 1}: closest centre distance ${approach.min.toFixed(2)} m, flags ${approach.flags}` });
        if ((approach.flags & (CAR_IDLE | CAR_LAGGY)) !== 0) await alice.page.keyboard.up('w');
    }
    expect(approach.flags & (CAR_IDLE | CAR_LAGGY), 'a car was a lag ghost in every attempt').toBe(0);
    expect(approach.min).toBeGreaterThan(1.5);
    expect(approach.proxies).toBe(1);

    // The server pushed Bob's car forward, and his screen shows it
    await expect.poll(async () => (await v2(bob.page)).z - bobStart.z, { timeout: 30_000 }).toBeGreaterThan(0.5);
    await alice.page.keyboard.up('w');

    // Both views of Alice agree again once she stands
    await expect.poll(async () => {
        const [aliceView, bobView] = await Promise.all([snapshot(alice.page), snapshot(bob.page)]);
        return distance(aliceView.local!, bobView.remotes[aliceId]);
    }, { timeout: 30_000 }).toBeLessThan(0.5);
});
