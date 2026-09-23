import { test, expect, joinGame, snapshot, distance } from './fixtures.js';

// Runs in the "mobile" project: iPhone 13 viewport with touch, in Chromium.
test('touch controls drive the car on a phone', async ({ openPlayer }) => {
    const player = await openPlayer('phone');
    const { page } = player;
    await joinGame(player, 'E2E Phone');

    // Mobile HUD: joystick and action buttons instead of keyboard hints and speedometer.
    await expect(page.locator('#mobile-controls')).toBeVisible();
    for (const selector of ['#joystick-move', '#btn-honk', '#btn-shoot', '#btn-flip', '#score-container', '#map-panel']) {
        await expect(page.locator(selector), selector).toBeVisible();
    }
    await expect(page.locator('.controls-hint')).toBeHidden();
    await expect(page.locator('#speedometer')).toBeHidden();

    // Push the joystick up with a real touch sequence.
    const start = (await snapshot(page)).local!;
    const joystick = (await page.locator('#joystick-move').boundingBox())!;
    const x = joystick.x + joystick.width / 2;
    const y = joystick.y + joystick.height / 2;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 10; step++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - step * 5 }] });
        await page.waitForTimeout(20);
    }
    await expect.poll(async () => (await snapshot(page)).local!.speed).toBeGreaterThan(0.1);
    await expect.poll(async () => distance(start, (await snapshot(page)).local!)).toBeGreaterThan(1);
    // Letting go of the stick releases throttle and steering; the car slows down.
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(async () => {
        const { inputs } = await snapshot(page);
        return Math.abs(inputs.throttle) + Math.abs(inputs.steer);
    }).toBe(0);
    const releasedSpeed = Math.abs((await snapshot(page)).local!.speed);
    await expect.poll(async () => Math.abs((await snapshot(page)).local!.speed)).toBeLessThan(releasedSpeed);

    // Action buttons: jump and honk reach the car (and the server).
    await page.locator('#btn-flip').tap();
    await expect.poll(() => player.sentMessages.some(message => message.type === 'update' && message.isFlipping === true))
        .toBe(true);
    await page.locator('#btn-honk').tap();
    await expect.poll(() => player.sentMessages.some(message => message.type === 'honk')).toBe(true);
});
