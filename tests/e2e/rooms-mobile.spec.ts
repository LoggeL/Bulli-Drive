import { test, expect, joinGame, snapshot } from './fixtures.js';

// Runs in the "mobile" project (iPhone 13, touch): the mode choice and the
// room menu work with touch, and Free Roam leaves out the shoot button
// without breaking the rest of the controls (docs/phase-1b-design.md, 9).

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

test('Free Roam and the room menu on a phone', async ({ openPlayer }) => {
    const player = await openPlayer('phone-rooms');
    const { page } = player;

    // The splash options are big enough for a thumb
    await page.goto('/?e2e=1');
    await expect(page.locator('#loading-screen')).toHaveCount(0, { timeout: 60_000 });
    for (const kind of ['party', 'freeroam']) {
        const box = (await page.locator(`.mode-option[data-room="${kind}"]`).boundingBox())!;
        expect(box.height, kind).toBeGreaterThanOrEqual(44);
    }

    await joinGame(player, 'E2E Phone Roam', '', 'freeroam');
    await expect(page.locator('#btn-shoot')).toBeHidden();
    for (const selector of ['#joystick-move', '#btn-flip', '#btn-honk', '#btn-drift', '#btn-boost', '#btn-autogas', '#room-chip']) {
        await expect(page.locator(selector), selector).toBeVisible();
    }
    await expect(page.locator('#score-container')).toBeHidden();

    // The chip stays clear of the map and the controls, in portrait and landscape
    for (const viewport of [{ width: 390, height: 664 }, { width: 320, height: 568 }, { width: 750, height: 342 }]) {
        await page.setViewportSize(viewport);
        await page.waitForTimeout(100);
        const chip = (await page.locator('#room-chip').boundingBox())!;
        expect(chip.x + chip.width, `${viewport.width}x${viewport.height}`).toBeLessThanOrEqual(viewport.width);
        for (const selector of ['#map-panel', '#joystick-move', '#btn-flip', '#btn-honk', '#btn-drift', '#btn-boost', '#btn-autogas']) {
            const box = (await page.locator(selector).boundingBox())!;
            expect(overlaps(chip, box), `${selector} at ${viewport.width}x${viewport.height}`).toBe(false);
        }
    }
    await page.setViewportSize({ width: 390, height: 664 });

    // Tap the chip, tap PARTY
    await page.locator('#room-chip').tap();
    await expect(page.locator('#room-panel')).toBeVisible();
    await page.locator('.room-option[data-room="party"]').tap();
    await expect.poll(async () => (await snapshot(page)).room?.kind).toBe('party');
    await expect(page.locator('#btn-shoot')).toBeVisible();
    await expect(page.locator('#score-container')).toBeVisible();
    await expect(page.locator('#room-panel')).toBeHidden();
});
