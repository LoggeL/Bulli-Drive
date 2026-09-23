import type { Page } from '@playwright/test';
import { test, expect, joinGame, snapshot, v2 } from './fixtures.js';

// The v2 physics is the only one: the game drives with it, shows its HUD and
// key hints and uses the race camera. An old ?physics= parameter changes
// nothing.

async function openSplash(page: Page, query: string): Promise<void> {
    await page.goto(`/?e2e=1${query}`);
    await expect(page.locator('#loading-screen')).toHaveCount(0, { timeout: 60_000 });
    await expect(page.locator('#splash-screen')).toBeVisible();
}

test('the game runs the v2 physics, with or without an old ?physics= parameter', async ({ openPlayer }) => {
    const player = await openPlayer('default-physics');
    const { page } = player;

    for (const query of ['&physics=legacy', '']) {
        await openSplash(page, query);
        await expect(page.locator('body')).toHaveClass(/\bphysics-v2\b/);

        // Splash: the v2 keys (innerText only has what is rendered)
        const keys = page.locator('.preview-keyboard');
        await expect(keys).toBeVisible();
        const shown = await keys.innerText();
        expect(shown).toMatch(/SPACE\s+drift/);
        expect(shown).toMatch(/SHIFT\s+boost/);
        expect(shown).toMatch(/Q\s+jump/);
        expect(shown).not.toMatch(/SPACE\s+jump/);
        // Keyboard, not touch, on the desktop
        await expect(page.locator('.preview-touch')).toBeHidden();
    }

    // About: the v2 keys and the touch section
    await page.locator('#about-link').click();
    const modal = page.locator('#modal-container');
    await expect(modal).toBeVisible();
    for (const text of ['Handbrake / drift', 'Boost (fills while drifting)', 'Hold to reset onto the road', 'Auto-gas on / off']) {
        await expect(modal.getByText(text, { exact: true }), text).toBeVisible();
    }
    await expect(modal.getByText('Jump / flip; recover when stuck')).toBeHidden();
    await page.locator('#modal-close').click();
    // It fades out (opacity), so check the state rather than the visibility
    await expect(modal).toHaveClass(/\bhidden\b/);

    // In the game: the sim car and the low race camera
    await joinGame(player, 'E2E Default');
    expect((await v2(page)).classId).toBeTruthy();
    await expect(page.locator('#drive-meter')).toBeVisible();
    await expect.poll(async () => {
        const { camera, local } = await snapshot(page);
        return camera.y - local!.y;
    }).toBeLessThan(10);
});
