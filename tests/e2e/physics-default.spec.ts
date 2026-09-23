import type { Page } from '@playwright/test';
import { test, expect, joinGame, snapshot, v2 } from './fixtures.js';

// The v2 physics is live: without a URL parameter the game drives with it,
// shows its HUD and key hints and uses the race camera. ?physics=legacy is
// the escape hatch back to the old physics, ?physics=v2 is still accepted.

async function openSplash(page: Page, query: string): Promise<void> {
    await page.goto(`/?e2e=1${query}`);
    await expect(page.locator('#loading-screen')).toHaveCount(0, { timeout: 60_000 });
    await expect(page.locator('#splash-screen')).toBeVisible();
}

test('without a URL parameter the game runs the v2 physics', async ({ openPlayer }) => {
    const player = await openPlayer('default-physics');
    const { page } = player;

    for (const query of ['&physics=v2', '']) {
        await openSplash(page, query);
        expect((await snapshot(page)).physics, `physics with "${query}"`).toBe('v2');
        await expect(page.locator('body')).toHaveClass(/\bphysics-v2\b/);

        // Splash: the v2 keys, not the legacy "SPACE jump" (innerText only
        // has what is rendered, textContent would include the hidden spans)
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

test('?physics=legacy switches the old physics back on', async ({ openPlayer }) => {
    const player = await openPlayer('legacy-physics');
    const { page } = player;
    await openSplash(page, '&physics=legacy');

    expect((await snapshot(page)).physics).toBe('legacy');
    await expect(page.locator('body')).not.toHaveClass(/\bphysics-v2\b/);
    const shown = await page.locator('.preview-keyboard').innerText();
    expect(shown).toMatch(/SPACE\s+jump/);
    expect(shown).toMatch(/F\s+honk/);
    expect(shown).not.toMatch(/SHIFT|drift/);

    await joinGame(player, 'E2E Legacy', '&physics=legacy');
    const state = await snapshot(page);
    expect(state.physics).toBe('legacy');
    expect(state.v2).toBeNull();
    await expect(page.locator('#drive-meter')).toBeHidden();
    // The old high camera (23 m up)
    await expect.poll(async () => {
        const { camera, local } = await snapshot(page);
        return camera.y - local!.y;
    }).toBeGreaterThan(15);
});
