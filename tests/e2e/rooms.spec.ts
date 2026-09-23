import { test, expect, joinGame, snapshot } from './fixtures.js';

// Party and Free Roam (docs/phase-1b-design.md, 2 and 9): the mode chosen on
// the splash screen, what Free Roam hides, rooms that do not see each other,
// and the switch back to the Party from the room chip.

test.use({ viewport: { width: 1000, height: 640 } });

test('Free Roam from the splash, then back to the Party from the room menu', async ({ openPlayer }) => {
    const roamer = await openPlayer('roamer');
    const partier = await openPlayer('partier');
    const roamerId = await joinGame(roamer, 'E2E Roamer', '', 'freeroam');
    const partierId = await joinGame(partier, 'E2E Partier');
    const { page } = roamer;

    // The switch went out before the car was shown
    const types = roamer.sentMessages.map(message => message.type);
    expect(types.indexOf('joinRoom')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('joinRoom')).toBeLessThan(types.indexOf('playerReady'));
    expect(roamer.sentMessages.find(message => message.type === 'joinRoom')).toEqual({ type: 'joinRoom', kind: 'freeroam' });

    // Free Roam: no score, HP, scoreboard, shooting or items
    let view = await snapshot(page);
    expect(view.room).toEqual(expect.objectContaining({ kind: 'freeroam' }));
    expect(view.items).toEqual({ coins: 0, powerups: 0 });
    await expect(page.locator('body')).toHaveClass(/\broom-freeroam\b/);
    for (const selector of ['#score-container', '#scoreboard-toggle', '#powerup-panel', '.hint-row.party-only']) {
        await expect(page.locator(selector), selector).toBeHidden();
    }
    await expect(page.locator('#room-chip')).toBeVisible();
    await expect(page.locator('#room-chip-mode')).toHaveText('FREE ROAM');
    await expect(page.locator('#room-chip-index')).toHaveText(`ROOM ${view.room!.index}`);

    // The Party player is in another room: neither sees the other
    const partyView = await snapshot(partier.page);
    expect(partyView.room).toEqual({ id: 'party-1', kind: 'party', index: 1 });
    expect(partyView.items.coins).toBeGreaterThan(0);
    await expect(partier.page.locator('body')).toHaveClass(/\broom-party\b/);
    await expect(partier.page.locator('#score-container')).toBeVisible();
    await expect(partier.page.locator('#room-chip-mode')).toHaveText('PARTY');
    expect(view.remotes[partierId]).toBeUndefined();
    expect(partyView.remotes[roamerId]).toBeUndefined();

    // Back to the Party with the room chip
    await page.locator('#room-chip').click();
    await expect(page.locator('#room-panel')).toBeVisible();
    await expect(page.locator('.room-option[data-room="freeroam"]')).toBeDisabled();
    await page.locator('.room-option[data-room="party"]').click();
    await expect.poll(async () => (await snapshot(page)).room?.id).toBe('party-1');
    await expect(page.locator('#room-panel')).toBeHidden();
    await expect(page.locator('body')).toHaveClass(/\broom-party\b/);
    await expect(page.locator('#score-container')).toBeVisible();
    await expect(page.locator('#scoreboard-toggle')).toBeVisible();
    await expect(page.locator('#room-chip-mode')).toHaveText('PARTY');
    view = await snapshot(page);
    expect(view.items.coins).toBeGreaterThan(0);
    expect(view.items.powerups).toBe(25);

    // Now they meet, with nametags and on the scoreboard
    await expect.poll(async () => (await snapshot(page)).remotes[partierId]?.name).toBe('E2E Partier');
    await expect.poll(async () => (await snapshot(partier.page)).remotes[roamerId]?.name).toBe('E2E Roamer');
    await expect(partier.page.locator('#scoreboard-list .player-name', { hasText: 'E2E Roamer' })).toHaveCount(1);

    // The mode is remembered: a reload joins the Party directly
    await page.reload();
    await expect(page.locator('#loading-screen')).toHaveCount(0, { timeout: 60_000 });
    await expect(page.locator('.mode-option[data-room="party"]')).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => (await snapshot(page)).room?.kind).toBe('party');
});

test('a Free Roam player who leaves disappears for the others in the room', async ({ openPlayer }) => {
    const first = await openPlayer('roam-a');
    const second = await openPlayer('roam-b');
    const firstId = await joinGame(first, 'E2E Roam A', '', 'freeroam');
    await joinGame(second, 'E2E Roam B', '', 'freeroam');
    const [a, b] = [await snapshot(first.page), await snapshot(second.page)];
    // Both land in the fullest Free Roam room
    expect(b.room).toEqual(a.room);
    await expect.poll(async () => (await snapshot(second.page)).remotes[firstId]?.name).toBe('E2E Roam A');
    await first.page.context().close();
    await expect.poll(async () => (await snapshot(second.page)).remotes[firstId]).toBeUndefined();
});
