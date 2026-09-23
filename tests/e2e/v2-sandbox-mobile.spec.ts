import type { CDPSession, Page } from '@playwright/test';
import { test, expect, v2, openSandbox } from './fixtures.js';

// Runs in the "mobile" project: the sandbox on an iPhone 13 with touch.
// Its buttons stay clear of the touch controls and auto-gas drives.

async function center(page: Page, selector: string): Promise<{ x: number; y: number }> {
    const box = (await page.locator(selector).boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', points: Array<{ x: number; y: number; id: number }>) {
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
}

test('the sandbox works with touch controls', async ({ openPlayer }) => {
    const player = await openPlayer('phone-sandbox');
    const { page } = player;
    await openSandbox(player);

    expect((await v2(page)).profile).toBe('touch');
    const banner = (await page.locator('#sandbox-banner').boundingBox())!;
    for (const selector of ['#joystick-move', '#btn-drift', '#btn-boost', '#btn-autogas', '#btn-flip', '#drive-meter']) {
        const box = (await page.locator(selector).boundingBox())!;
        const overlaps = banner.x < box.x + box.width && box.x < banner.x + banner.width
            && banner.y < box.y + box.height && box.y < banner.y + banner.height;
        expect(overlaps, `banner overlaps ${selector}`).toBe(false);
    }

    // A touch of the stick starts auto-gas
    const cdp = await page.context().newCDPSession(page);
    const stick = await center(page, '#joystick-move');
    await touch(cdp, 'touchStart', [{ ...stick, id: 1 }]);
    await touch(cdp, 'touchMove', [{ x: stick.x, y: stick.y - 4, id: 1 }]);
    await page.waitForTimeout(100);
    await touch(cdp, 'touchEnd', []);
    await expect.poll(async () => (await v2(page)).u).toBeGreaterThan(8);

    // The banner's buttons work by touch as well
    const classBefore = (await v2(page)).classId;
    await page.locator('#sandbox-banner button', { hasText: 'Switch car' }).tap();
    await expect.poll(async () => (await v2(page)).classId).not.toBe(classBefore);
});
