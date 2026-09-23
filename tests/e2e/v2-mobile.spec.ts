import type { CDPSession, Page } from '@playwright/test';
import { test, expect, joinGame, snapshot, distance, placeOnClearRunway, v2 } from './fixtures.js';

// Runs in the "mobile" project: iPhone 13 with touch, v2 physics (the
// default). Auto-gas
// drives, the stick steers, DRIFT holds the handbrake and the flip button
// jumps on a tap and resets when held (docs/phase-1a-design.md, 11.2/14.8).

async function center(page: Page, selector: string): Promise<{ x: number; y: number }> {
    const box = (await page.locator(selector).boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', points: Array<{ x: number; y: number; id: number }>) {
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
}

test('the splash shows the touch controls instead of the keys', async ({ openPlayer }) => {
    const { page } = await openPlayer('phone-splash');
    await page.goto('/?e2e=1');
    await expect(page.locator('#loading-screen')).toHaveCount(0, { timeout: 60_000 });
    await expect(page.locator('#splash-screen')).toBeVisible();
    const touch = page.locator('.preview-touch');
    await expect(touch).toBeVisible();
    for (const label of ['STICK', 'AUTO', 'DRIFT', 'BOOST']) await expect(touch).toContainText(label);
    await expect(page.locator('.preview-keyboard')).toBeHidden();
});

test('v2 touch controls: auto-gas, steering, drift, jump and reset', async ({ openPlayer }) => {
    const player = await openPlayer('phone-v2');
    const { page } = player;
    await joinGame(player, 'E2E Phone V2');

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

// Touch HUD elements that must never cover each other, with the reset and
// powerup prompt shown: it appears exactly when the player is stuck
const HUD = [
    '#btn-drift', '#btn-boost', '#btn-autogas', '#btn-flip', '#btn-shoot', '#btn-honk',
    '#joystick-move', '#interaction-prompt', '#drive-meter', '#map-panel', '#score-container', '#player-list'
];
const VIEWPORTS = [
    { name: 'iPhone 13', width: 390, height: 664 },
    { name: 'iPhone SE', width: 320, height: 568 },
    { name: 'Galaxy S9+', width: 320, height: 658 },
    { name: 'Android 360', width: 360, height: 640 },
    { name: 'iPhone 13 landscape', width: 750, height: 342 },
    { name: 'iPhone SE landscape', width: 568, height: 320 },
    { name: 'iPad portrait', width: 768, height: 1024 },
    { name: 'iPad landscape', width: 1024, height: 768 }
];

test('v2 touch HUD: nothing overlaps on narrow phones and in landscape, prompt included', async ({ openPlayer }) => {
    const player = await openPlayer('phone-v2-layout');
    const { page } = player;
    await joinGame(player, 'E2E Phone Layout');
    await page.evaluate(() => {
        const prompt = document.getElementById('interaction-prompt')!;
        prompt.textContent = 'HOLD JUMP TO RESET';
        prompt.style.transition = 'none';
        prompt.classList.remove('hidden');
    });
    // All problems of all viewports at once in the message
    const problems: string[] = [];
    for (const viewport of VIEWPORTS) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.waitForTimeout(100);
        const boxes = await Promise.all(HUD.map(async selector => ({ selector, box: await page.locator(selector).boundingBox() })));
        const round = (box: { x: number; y: number; width: number; height: number }) =>
            `[${Math.round(box.x)}..${Math.round(box.x + box.width)}]x[${Math.round(box.y)}..${Math.round(box.y + box.height)}]`;
        for (const { selector, box } of boxes) {
            if (!box) problems.push(`${viewport.name}: ${selector} not shown`);
            else if (box.x < 0 || box.x + box.width > viewport.width) problems.push(`${viewport.name}: ${selector} off screen ${round(box)}`);
        }
        for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) {
                const a = boxes[i].box, b = boxes[j].box;
                if (!a || !b) continue;
                const overlaps = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
                if (overlaps) problems.push(`${viewport.name}: ${boxes[i].selector} ${round(a)} overlaps ${boxes[j].selector} ${round(b)}`);
            }
        }
    }
    expect(problems).toEqual([]);
});
