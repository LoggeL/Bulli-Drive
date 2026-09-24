import { test, expect, joinGame, snapshot, netState } from './fixtures.js';

// The touch client on a lost connection (docs/phase-1b-design.md, 11.1 and
// 15.3): the banner shows after a second without covering the touch
// controls or the HUD. The connection stays away longer than the grace
// time of the e2e server (3 s), so the page comes back as a new player
// and drives again on its own, without the splash screen.

const HUD = [
    '#btn-drift', '#btn-boost', '#btn-autogas', '#btn-flip', '#btn-shoot', '#btn-honk',
    '#joystick-move', '#drive-meter', '#map-panel', '#score-container', '#player-list', '#room-chip'
];

const VIEWPORTS = [
    { name: 'iPhone 13', width: 390, height: 664 },
    { name: 'iPhone SE', width: 320, height: 568 },
    { name: 'iPhone 13 landscape', width: 750, height: 342 },
    { name: 'iPhone SE landscape', width: 568, height: 320 }
];

test('touch: the reconnect banner leaves the controls free, and the player comes back', async ({ openPlayer }) => {
    const player = await openPlayer('phone-reconnect');
    const { page } = player;
    const id = await joinGame(player, 'E2E Phone Reconnect');

    // Drop the socket and keep the reconnect back long enough to look
    await page.evaluate(() => (window as unknown as { __bulliDebug: { dropConnection(holdMs: number): void } })
        .__bulliDebug.dropConnection(8000));
    const banner = page.locator('#net-notice');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Reconnecting');
    // The car holds still meanwhile (the prediction stops after 250 ms)
    await expect.poll(async () => (await netState(page)).suspended).toBe(true);

    await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; }' });
    const problems: string[] = [];
    for (const viewport of VIEWPORTS) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.waitForTimeout(100);
        const own = (await banner.boundingBox())!;
        if (own.x < 0 || own.x + own.width > viewport.width || own.y < 0) problems.push(`${viewport.name}: banner off screen`);
        for (const selector of HUD) {
            const box = await page.locator(selector).boundingBox();
            if (!box) continue;
            const overlaps = own.x < box.x + box.width && box.x < own.x + own.width && own.y < box.y + box.height && box.y < own.y + own.height;
            const r = (b: { x: number; y: number; width: number; height: number }) =>
                `[${Math.round(b.x)}..${Math.round(b.x + b.width)}]x[${Math.round(b.y)}..${Math.round(b.y + b.height)}]`;
            if (overlaps) problems.push(`${viewport.name}: the banner ${r(own)} covers ${selector} ${r(box)}`);
        }
    }
    expect(problems).toEqual([]);

    // Back after the hold: a new session, the banner gone, the car spawned
    await expect.poll(async () => (await netState(page)).reconnects, { timeout: 20_000 }).toBe(1);
    expect((await netState(page)).resumed).toBe(false);
    await expect(banner).toBeHidden();
    await expect.poll(async () => (await netState(page)).spawned).toBe(true);
    const state = await snapshot(page);
    expect(state.myId).not.toBe(id);
    expect(state.connected).toBe(true);
    await expect(page.locator('#splash-screen')).toHaveClass(/\bhidden\b/);
});
