import { test, expect, joinGame, snapshot, distance } from './fixtures.js';

test('loads, joins and drives on desktop', async ({ openPlayer }) => {
    const player = await openPlayer('desktop');
    const { page } = player;
    const myId = await joinGame(player, 'E2E Solo');

    // The three.js canvas fills the window and keeps rendering the scene.
    const canvas = page.locator('body > canvas');
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box?.width).toBe(1280);
    expect(box?.height).toBe(800);
    const firstFrame = (await snapshot(page)).render.frame;
    await expect.poll(async () => (await snapshot(page)).render.frame).toBeGreaterThan(firstFrame + 5);
    expect((await snapshot(page)).render.calls).toBeGreaterThan(10);

    // Desktop HUD, no touch controls
    for (const selector of ['#score-container', '#speedometer', '.controls-hint', '#map-panel', '#scoreboard-toggle']) {
        await expect(page.locator(selector), selector).toBeVisible();
    }
    await expect(page.locator('#mobile-controls')).toBeHidden();
    await expect(page.locator('#score-display')).toHaveText('0');
    await expect(page.locator('#speedo-value')).toHaveText('0');

    // The scoreboard lists us
    await page.locator('#scoreboard-toggle').click();
    await expect(page.locator('#scoreboard-panel')).toBeVisible();
    await expect(page.locator('#scoreboard-list .scoreboard-row.me .player-name')).toHaveText('E2E Solo (You)');
    await page.keyboard.press('Escape');
    await expect(page.locator('#scoreboard-panel')).toBeHidden();

    // Hold W: the car speeds up, the speedometer shows it and the car moves.
    const start = (await snapshot(page)).local!;
    await page.keyboard.down('w');
    await expect.poll(async () => Number(await page.locator('#speedo-value').textContent())).toBeGreaterThan(10);
    // Software rendering can stall for a moment, so wait for the distance
    // instead of holding W for a fixed time.
    await expect.poll(async () => distance(start, (await snapshot(page)).local!)).toBeGreaterThan(2);
    await page.keyboard.up('w');
    expect(player.sentMessages.some(message => message.type === 'update')).toBe(true);

    // Letting go of W releases the throttle and the car slows down.
    const releasedAt = await snapshot(page);
    expect(Math.abs(releasedAt.inputs.throttle)).toBe(0);
    await expect.poll(async () => Math.abs((await snapshot(page)).local!.speed))
        .toBeLessThan(Math.abs(releasedAt.local!.speed));
    expect((await snapshot(page)).myId).toBe(myId);
});
