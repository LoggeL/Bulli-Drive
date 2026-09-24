import type { Page } from '@playwright/test';
import { test, expect, joinGame, snapshot, v2 } from './fixtures.js';

// The drive controls of the physics (phase 1a): the splash and About show
// its keys, the game its HUD and the low race camera. The old
// ?physics=legacy switch is gone and changes nothing.

async function openSplash(page: Page, query: string): Promise<void> {
    await page.goto(`/?e2e=1${query}`);
    await expect(page.locator('#loading-screen')).toHaveCount(0, { timeout: 60_000 });
    await expect(page.locator('#splash-screen')).toBeVisible();
}

test('splash, About and HUD show the drive controls, also with an old ?physics=legacy', async ({ openPlayer }) => {
    const player = await openPlayer('drive-controls');
    const { page } = player;

    for (const query of ['&physics=legacy', '']) {
        await openSplash(page, query);

        // Splash: the drive keys (innerText only has what is rendered)
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

    // About: the drive keys and the touch section
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
