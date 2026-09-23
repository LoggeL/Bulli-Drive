import type { Page } from '@playwright/test';
import { test, expect, joinGame, snapshot, distance, placeOnClearRunway, v2 } from './fixtures.js';

// Two v2 players (the default physics): each sees the other, and a bump
// pushes the car that is hit. In 1a the remote car is a kinematic proxy in
// each client's own sim, so each side only pushes its own car
// (docs/phase-1a-design.md, 8.5).

test.use({ viewport: { width: 800, height: 500 } });

async function place(page: Page, x: number, z: number) {
    await page.evaluate(({ x, z }) => (window as unknown as {
        __bulliDebug: { placeLocalCar(x: number, z: number, angle: number): void };
    }).__bulliDebug.placeLocalCar(x, z, 0), { x, z });
}

test('two v2 players see each other and bump into each other', async ({ openPlayer }) => {
    const alice = await openPlayer('alice-v2');
    const bob = await openPlayer('bob-v2');
    const aliceId = await joinGame(alice, 'E2E Alice V2');
    const bobId = await joinGame(bob, 'E2E Bob V2');

    await expect.poll(async () => (await snapshot(bob.page)).remotes[aliceId]?.name).toBe('E2E Alice V2');
    await expect.poll(async () => (await snapshot(alice.page)).remotes[bobId]?.name).toBe('E2E Bob V2');
    // Each sim has the other car as a contact partner
    await expect.poll(async () => (await v2(alice.page)).proxies).toBe(1);
    await expect.poll(async () => (await v2(bob.page)).proxies).toBe(1);

    // Bob waits on a free road, Alice lines up 25 m behind him
    const runway = await placeOnClearRunway(alice.page);
    const bobStart = { x: runway.x, z: runway.z + 25 };
    await place(bob.page, bobStart.x, bobStart.z);
    await expect.poll(async () => distance(bobStart, (await snapshot(alice.page)).remotes[bobId])).toBeLessThan(0.1);
    await expect.poll(async () => distance(runway, (await snapshot(bob.page)).remotes[aliceId])).toBeLessThan(0.1);

    // Alice drives into him and keeps pushing
    await alice.page.keyboard.down('w');
    await expect.poll(async () => {
        const view = await snapshot(alice.page);
        return distance(view.local!, view.remotes[bobId]);
    }, { timeout: 30_000 }).toBeLessThan(6);
    // Closest approach over the next seconds in Alice's sim: the cars touch
    // (circles 1.1-1.4 m) but never drive through each other
    const closest = await alice.page.evaluate(async (bobId) => {
        const debug = (window as unknown as { __bulliDebug: { snapshot(): {
            local: { x: number; z: number }; remotes: Record<string, { x: number; z: number }>;
        } } }).__bulliDebug;
        let min = Infinity;
        const until = performance.now() + 2500;
        while (performance.now() < until) {
            await new Promise(resolve => requestAnimationFrame(resolve));
            const view = debug.snapshot();
            const remote = view.remotes[bobId];
            if (remote) min = Math.min(min, Math.hypot(view.local.x - remote.x, view.local.z - remote.z));
        }
        return min;
    }, bobId);
    test.info().annotations.push({ type: 'bump', description: `closest centre distance ${closest.toFixed(2)} m` });
    expect(closest).toBeGreaterThan(1.5);

    // Bob's own sim pushed his car forward
    await expect.poll(async () => (await v2(bob.page)).z - bobStart.z, { timeout: 30_000 }).toBeGreaterThan(0.5);
    await alice.page.keyboard.up('w');

    // Both views of Alice agree again once she stands
    await expect.poll(async () => {
        const [aliceView, bobView] = await Promise.all([snapshot(alice.page), snapshot(bob.page)]);
        return distance(aliceView.local!, bobView.remotes[aliceId]);
    }, { timeout: 30_000 }).toBeLessThan(0.5);
});
