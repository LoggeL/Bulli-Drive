import type { CDPSession, Page } from '@playwright/test';
import {
    test, expect, FLOW_DRAW_FPS, openGame, joinFromSplash, snapshot, netState, distance, placeOnClearRunway, v2
} from './fixtures.js';

// Runs in the "mobile" project: iPhone 13 with touch. The critical path on
// a phone: the splash screen with the touch controls and thumb-sized mode
// options, Free Roam from the splash, real touch events on the stick and
// the buttons (docs/phase-1a-design.md, 11.2), the room chip back to the
// Party, a short drop that resumes the same player, and a lost connection
// that comes back as a new player after the grace time, with a reconnect
// banner that leaves the HUD free. The HUD layout in eight viewports is a
// measurement in the render job (tests/e2e-render/touch-hud.spec.ts). The
// touch rules (brake threshold, auto-gas, flip held = reset) are tested on
// InputManager in tests/client/input.test.ts, the DOM wiring on the real
// markup (DRIFT and BOOST bits, a second finger, the stick's Y axis, the
// flip button's tap and hold) in tests/client/mobileControls.test.ts.

type Box = { x: number; y: number; width: number; height: number };

const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const round = (box: Box) => `[${Math.round(box.x)}..${Math.round(box.x + box.width)}]x[${Math.round(box.y)}..${Math.round(box.y + box.height)}]`;

async function center(page: Page, selector: string): Promise<{ x: number; y: number }> {
    const box = (await page.locator(selector).boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', points: Array<{ x: number; y: number; id: number }>) {
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
}

// Sim ticks of the own car from now on (instead of waiting for wall-clock time)
async function waitTicks(page: Page, ticks: number): Promise<void> {
    const start = (await v2(page)).ticks;
    await expect.poll(async () => (await v2(page)).ticks).toBeGreaterThan(start + ticks);
}

// Touch HUD elements the reconnect banner must not cover
const HUD = [
    '#btn-drift', '#btn-boost', '#btn-autogas', '#btn-flip', '#btn-shoot', '#btn-honk',
    '#joystick-move', '#drive-meter', '#map-panel', '#score-container', '#player-list'
];
// The phones the reconnect banner is checked on, portrait and landscape
// (the whole touch HUD in eight viewports: tests/e2e-render/touch-hud.spec.ts)
const PHONES = [
    { name: 'iPhone 13', width: 390, height: 664 },
    { name: 'iPhone SE', width: 320, height: 568 },
    { name: 'iPhone 13 landscape', width: 750, height: 342 },
    { name: 'iPhone SE landscape', width: 568, height: 320 }
];

test('touch on a phone: splash, Free Roam, stick and buttons, room chip and a lost connection', async ({ openPlayer }) => {
    const player = await openPlayer('phone');
    const { page } = player;

    // ---- Splash screen: touch controls, big enough options ----
    await openGame(player, FLOW_DRAW_FPS);
    const preview = page.locator('.preview-touch');
    await expect(preview).toBeVisible();
    for (const label of ['STICK', 'AUTO', 'DRIFT', 'BOOST']) await expect(preview).toContainText(label);
    await expect(page.locator('.preview-keyboard')).toBeHidden();
    for (const kind of ['party', 'freeroam']) {
        const box = (await page.locator(`.mode-option[data-room="${kind}"]`).boundingBox())!;
        expect(box.height, kind).toBeGreaterThanOrEqual(44);
    }

    // ---- Free Roam from the splash screen: no shooting, no score ----
    await joinFromSplash(player, 'E2E Phone', 'freeroam');
    expect((await v2(page)).profile).toBe('touch');
    for (const selector of ['#joystick-move', '#btn-flip', '#btn-honk', '#btn-drift', '#btn-boost', '#btn-autogas', '#drive-meter', '#room-chip']) {
        await expect(page.locator(selector), selector).toBeVisible();
    }
    await expect(page.locator('#btn-shoot')).toBeHidden();
    await expect(page.locator('#score-container')).toBeHidden();
    await expect(page.locator('#btn-autogas')).toHaveAttribute('aria-pressed', 'true');

    // ---- Real touch events ----
    // Standing still until the stick is touched for the first time
    await placeOnClearRunway(page);
    const start = (await snapshot(page)).local!;
    await waitTicks(page, 20);
    expect((await v2(page)).input.throttle).toBe(0);

    // A touch of the stick starts auto-gas, which keeps driving after release
    const cdp = await page.context().newCDPSession(page);
    const stick = await center(page, '#joystick-move');
    await touch(cdp, 'touchStart', [{ ...stick, id: 1 }]);
    await touch(cdp, 'touchMove', [{ x: stick.x, y: stick.y - 4, id: 1 }]);
    await touch(cdp, 'touchEnd', []);
    await expect.poll(async () => (await v2(page)).autoGas).toBe(true);
    await expect.poll(async () => (await v2(page)).u).toBeGreaterThan(8);
    await expect.poll(async () => distance(start, (await snapshot(page)).local!)).toBeGreaterThan(5);

    // Stick to the left steers left: positive steer, the heading grows
    const beforeTurn = await v2(page);
    await touch(cdp, 'touchStart', [{ ...stick, id: 1 }]);
    for (let step = 1; step <= 6; step++) await touch(cdp, 'touchMove', [{ x: stick.x - step * 8, y: stick.y, id: 1 }]);
    await expect.poll(async () => (await v2(page)).input.steer).toBeGreaterThan(40);
    await expect.poll(async () => (await v2(page)).yaw).toBeGreaterThan(beforeTurn.yaw + 0.05);
    await touch(cdp, 'touchEnd', []);

    // The auto-gas button switches it off
    await page.locator('#btn-autogas').tap();
    await expect(page.locator('#btn-autogas')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => (await v2(page)).input.throttle).toBe(0);

    // A tap on the flip button jumps
    const jumpsBefore = (await v2(page)).jumps;
    await page.locator('#btn-flip').tap();
    await expect.poll(async () => (await v2(page)).jumps).toBe(jumpsBefore + 1);
    await expect.poll(async () => (await v2(page)).grounded).toBe(true);

    // ---- Back to the Party from the room chip ----
    await page.locator('#room-chip').tap();
    await expect(page.locator('#room-panel')).toBeVisible();
    await page.locator('.room-option[data-room="party"]').tap();
    await expect.poll(async () => (await snapshot(page)).room?.kind).toBe('party');
    await expect(page.locator('#room-panel')).toBeHidden();
    await expect(page.locator('#btn-shoot')).toBeVisible();
    await expect(page.locator('#score-container')).toBeVisible();

    // ---- A short drop: the same player and car come back ----
    // Within the grace time the session token resumes the session (11.1)
    const id = (await snapshot(page)).myId;
    await page.evaluate(() => (window as unknown as { __bulliDebug: { dropConnection(holdMs: number): void } })
        .__bulliDebug.dropConnection(0));
    await expect.poll(async () => (await netState(page)).reconnects, { timeout: 20_000 }).toBe(1);
    expect((await netState(page)).resumed).toBe(true);
    expect((await snapshot(page)).myId).toBe(id);
    await expect.poll(async () => (await netState(page)).spawned).toBe(true);
    await expect(page.locator('#respawn-overlay')).toHaveCount(0);

    // ---- A lost connection ----
    // Drop the socket and keep the reconnect back past the grace time of
    // the e2e server (2 s): the banner shows after a second and leaves the
    // controls and the HUD free, the car holds still meanwhile
    await page.evaluate(() => (window as unknown as { __bulliDebug: { dropConnection(holdMs: number): void } })
        .__bulliDebug.dropConnection(4000));
    const notice = page.locator('#net-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Reconnecting');
    await expect.poll(async () => (await netState(page)).suspended).toBe(true);
    const problems: string[] = [];
    for (const viewport of PHONES) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        const own = (await notice.boundingBox())!;
        if (own.x < 0 || own.x + own.width > viewport.width || own.y < 0) problems.push(`${viewport.name}: banner off screen`);
        for (const selector of [...HUD, '#room-chip']) {
            const box = await page.locator(selector).boundingBox();
            if (box && overlaps(own, box)) problems.push(`${viewport.name}: the reconnect banner ${round(own)} covers ${selector} ${round(box)}`);
        }
    }
    expect(problems).toEqual([]);

    // Back after the hold as a new session: the banner gone, the car
    // spawned again without the splash screen
    await expect.poll(async () => (await netState(page)).reconnects, { timeout: 20_000 }).toBe(2);
    expect((await netState(page)).resumed).toBe(false);
    await expect(notice).toBeHidden();
    await expect.poll(async () => (await netState(page)).spawned).toBe(true);
    const state = await snapshot(page);
    expect(state.myId).not.toBe(id);
    expect(state.connected).toBe(true);
    await expect(page.locator('#splash-screen')).toHaveClass(/\bhidden\b/);
});
