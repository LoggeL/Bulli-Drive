import type { CDPSession, Page } from '@playwright/test';
import { test, expect, joinGame, snapshot, distance, placeOnClearRunway, v2 } from './fixtures.js';

// Runs in the "mobile" project: iPhone 13 with touch, ?physics=v2. Auto-gas
// drives, the stick steers, DRIFT holds the handbrake and the flip button
// jumps on a tap and resets when held (docs/phase-1a-design.md, 11.2/14.8).

async function center(page: Page, selector: string): Promise<{ x: number; y: number }> {
    const box = (await page.locator(selector).boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', points: Array<{ x: number; y: number; id: number }>) {
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
}

test('v2 touch controls: auto-gas, steering, drift, jump and reset', async ({ openPlayer }) => {
    const player = await openPlayer('phone-v2');
    const { page } = player;
    await joinGame(player, 'E2E Phone V2', '&physics=v2');

    const initial = await v2(page);
    expect(initial.profile).toBe('touch');
    for (const selector of ['#joystick-move', '#btn-flip', '#btn-shoot', '#btn-honk', '#btn-drift', '#btn-boost', '#btn-autogas', '#drive-meter']) {
        await expect(page.locator(selector), selector).toBeVisible();
    }
    // The v2 buttons do not cover the legacy ones
    const boxes = await Promise.all(['#btn-drift', '#btn-boost', '#btn-autogas', '#btn-flip', '#btn-shoot', '#btn-honk', '#joystick-move']
        .map(async selector => ({ selector, box: (await page.locator(selector).boundingBox())! })));
    for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i].box, b = boxes[j].box;
            const overlaps = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
            expect(overlaps, `${boxes[i].selector} overlaps ${boxes[j].selector}`).toBe(false);
        }
    }
    await expect(page.locator('#btn-autogas')).toHaveAttribute('aria-pressed', 'true');

    // Standing still until the stick is touched for the first time
    await placeOnClearRunway(page);
    const start = (await snapshot(page)).local!;
    await page.waitForTimeout(300);
    expect((await v2(page)).input.throttle).toBe(0);

    // A touch of the stick starts auto-gas, which keeps driving after release
    const cdp = await page.context().newCDPSession(page);
    const stick = await center(page, '#joystick-move');
    await touch(cdp, 'touchStart', [{ ...stick, id: 1 }]);
    await touch(cdp, 'touchMove', [{ x: stick.x, y: stick.y - 4, id: 1 }]);
    await page.waitForTimeout(100);
    await touch(cdp, 'touchEnd', []);
    await expect.poll(async () => (await v2(page)).autoGas).toBe(true);
    await expect.poll(async () => (await v2(page)).u).toBeGreaterThan(8);
    await expect.poll(async () => distance(start, (await snapshot(page)).local!)).toBeGreaterThan(5);

    // Stick to the left steers left: positive steer, the heading grows
    const beforeTurn = await v2(page);
    await touch(cdp, 'touchStart', [{ ...stick, id: 1 }]);
    for (let step = 1; step <= 6; step++) {
        await touch(cdp, 'touchMove', [{ x: stick.x - step * 8, y: stick.y, id: 1 }]);
        await page.waitForTimeout(20);
    }
    await expect.poll(async () => (await v2(page)).input.steer).toBeGreaterThan(40);
    await expect.poll(async () => (await v2(page)).yaw).toBeGreaterThan(beforeTurn.yaw + 0.05);

    // DRIFT (second finger) holds the handbrake while the stick steers
    const drift = await center(page, '#btn-drift');
    await touch(cdp, 'touchStart', [{ x: stick.x - 48, y: stick.y, id: 1 }, { ...drift, id: 2 }]);
    await expect.poll(async () => (await v2(page)).input.buttons & 1).toBe(1);
    await touch(cdp, 'touchEnd', []);
    await expect.poll(async () => (await v2(page)).input.buttons & 1).toBe(0);

    // Pulling the stick down brakes the car to a stop (and cuts auto-gas)
    await touch(cdp, 'touchStart', [{ ...stick, id: 1 }]);
    for (let step = 1; step <= 8; step++) {
        await touch(cdp, 'touchMove', [{ x: stick.x, y: stick.y + step * 8, id: 1 }]);
        await page.waitForTimeout(20);
    }
    await expect.poll(async () => (await v2(page)).input.brake).toBeGreaterThan(100);
    // (held on, it would go on to reverse)
    await expect.poll(async () => (await v2(page)).u).toBeLessThan(2);
    await touch(cdp, 'touchEnd', []);

    // Auto-gas can be switched off
    await page.locator('#btn-autogas').tap();
    await expect(page.locator('#btn-autogas')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => (await v2(page)).input.throttle).toBe(0);

    // A tap on the flip button jumps
    const jumpsBefore = (await v2(page)).jumps;
    await page.locator('#btn-flip').tap();
    await expect.poll(async () => (await v2(page)).jumps).toBe(jumpsBefore + 1);
    await expect.poll(async () => (await v2(page)).grounded).toBe(true);

    // Holding it resets instead, without a jump
    const flip = await center(page, '#btn-flip');
    const resetsBefore = (await v2(page)).resets;
    await touch(cdp, 'touchStart', [{ ...flip, id: 3 }]);
    await expect.poll(async () => (await v2(page)).resets).toBe(resetsBefore + 1);
    await touch(cdp, 'touchEnd', []);
    await page.waitForTimeout(300);
    expect((await v2(page)).jumps).toBe(jumpsBefore + 1);
});
