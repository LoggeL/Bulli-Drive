import { test, expect, joinGame, snapshot, distance } from './fixtures.js';

test('two players see each other and position updates arrive', async ({ openPlayer }) => {
    const alice = await openPlayer('alice');
    const bob = await openPlayer('bob');
    const aliceId = await joinGame(alice, 'E2E Alice');
    const bobId = await joinGame(bob, 'E2E Bob');

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

    // Alice drives; Bob's copy of her car follows.
    const aliceAtStart = (await snapshot(bob.page)).remotes[aliceId];
    await alice.page.keyboard.down('w');
    await expect.poll(async () => distance(aliceAtStart, (await snapshot(bob.page)).remotes[aliceId]))
        .toBeGreaterThan(3);
    await alice.page.keyboard.up('w');

    // Once she has stopped, both views agree on where she is.
    await expect.poll(async () => (await snapshot(alice.page)).local!.speed, { timeout: 20_000 }).toBe(0);
    const aliceStopped = (await snapshot(alice.page)).local!;
    await expect.poll(async () => distance(aliceStopped, (await snapshot(bob.page)).remotes[aliceId]))
        .toBeLessThan(0.01);

    // Alice leaves: she disappears from Bob's scene and scoreboard.
    await alice.page.context().close();
    await expect.poll(async () => (await snapshot(bob.page)).remotes[aliceId]).toBeUndefined();
    await expect(bob.page.locator('#scoreboard-list .player-name', { hasText: 'E2E Alice' })).toHaveCount(0);
});
