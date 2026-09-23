import { test, expect, joinGame, snapshot, distance, placeOnClearRunway } from './fixtures.js';

// Two software-rendered games at once; a smaller window keeps them fluid.
test.use({ viewport: { width: 800, height: 500 } });

test('two legacy players see each other and position updates arrive', async ({ openPlayer }) => {
    const alice = await openPlayer('alice');
    const bob = await openPlayer('bob');
    // The old physics (?physics=legacy); two v2 players: v2-multiplayer.spec.ts
    const aliceId = await joinGame(alice, 'E2E Alice', '&physics=legacy');
    const bobId = await joinGame(bob, 'E2E Bob', '&physics=legacy');

    // Both scoreboards list both drivers.
    for (const [viewer, me, other] of [[alice, 'E2E Alice', 'E2E Bob'], [bob, 'E2E Bob', 'E2E Alice']] as const) {
        const names = viewer.page.locator('#scoreboard-list .player-name');
        await expect(names.filter({ hasText: `${me} (You)` })).toHaveCount(1);
        await expect(names.filter({ hasText: other })).toHaveCount(1);
    }
    await bob.page.locator('#scoreboard-toggle').click();
    await expect(bob.page.locator('#scoreboard-panel')).toBeVisible();

    // Each game has the other car in its scene, with a nametag.
    await expect.poll(async () => (await snapshot(bob.page)).remotes[aliceId]?.name).toBe('E2E Alice');
    await expect.poll(async () => (await snapshot(alice.page)).remotes[bobId]?.name).toBe('E2E Bob');
    await expect(bob.page.locator('.nametag-name', { hasText: 'E2E Alice' })).toHaveCount(1);

    // Alice drives down a free stretch of road until she has covered some
    // ground (software WebGL runs at a few FPS).
    await placeOnClearRunway(alice.page);
    const aliceAtStart = (await snapshot(alice.page)).local!;
    await expect.poll(async () => distance(aliceAtStart, (await snapshot(bob.page)).remotes[aliceId]))
        .toBeLessThan(0.1);
    await alice.page.keyboard.down('w');
    await expect.poll(async () => distance(aliceAtStart, (await snapshot(alice.page)).local!), { timeout: 30_000 })
        .toBeGreaterThan(1.5);
    await alice.page.keyboard.up('w');

    // Bob's copy of her car followed and catches up with where she really is.
    await expect.poll(async () => {
        const [aliceView, bobView] = await Promise.all([snapshot(alice.page), snapshot(bob.page)]);
        return distance(aliceView.local!, bobView.remotes[aliceId]);
    }).toBeLessThan(0.1);
    expect(distance(aliceAtStart, (await snapshot(bob.page)).remotes[aliceId])).toBeGreaterThan(1.5);

    // Alice leaves: she disappears from Bob's scene and scoreboard.
    await alice.page.context().close();
    await expect.poll(async () => (await snapshot(bob.page)).remotes[aliceId]).toBeUndefined();
    await expect(bob.page.locator('#scoreboard-list .player-name', { hasText: 'E2E Alice' })).toHaveCount(0);
});
