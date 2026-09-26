import type { CDPSession, Page } from '@playwright/test';
import {
    test, expect, FLOW_DRAW_FPS, openGame, joinFromSplash, snapshot, netState, distance, placeOnClearRunway, v2
} from './fixtures.js';

// Runs in the "mobile" project: iPhone 13 with touch. The critical path on
// a phone: the splash screen with the touch controls and thumb-sized mode
// options, Free Roam from the splash, real touch events on the stick and
// the buttons (docs/phase-1a-design.md, 11.2), a bump taken at speed (the
// car leaves the ground and lands, 26), the RESET button held, the room
// chip back to the Party, a short drop that resumes the same player, and a
// lost connection that comes back as a new player after the grace time,
// with a reconnect banner that leaves the HUD free. The HUD layout in eight
// viewports is a measurement in the render job
// (tests/e2e-render/touch-hud.spec.ts). The touch rules (brake threshold,
// auto-gas) are tested on InputManager in tests/client/input.test.ts, the
// DOM wiring on the real markup (DRIFT, BOOST and RESET bits, a second
// finger, the stick's Y axis) in tests/client/mobileControls.test.ts, the
// flight itself in the sim (tests/shared/sim/ground.test.ts).

type Box = { x: number; y: number; width: number; height: number };

// The edge of a raised stretch of road on Bulli Bay, east-bound: the road
// climbs 0.8 m within 4 m at x -564. Measured in the sim (all five classes,
// full throttle from 30 m west): 55-59 ticks in the air, 2.4-2.8 m over the
// ground at 38 m/s, landing at 10 m/s on the road beyond, clear for a
// second after it (docs/phase-1a-design.md 26.8)
const BUMP = { x: -596, z: 300, yaw: Math.PI / 2, speed: 38 };

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
    '#btn-drift', '#btn-boost', '#btn-autogas', '#btn-reset', '#btn-shoot', '#btn-honk',
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
    for (const selector of ['#joystick-move', '#btn-reset', '#btn-honk', '#btn-drift', '#btn-boost', '#btn-autogas', '#drive-meter', '#room-chip']) {
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

    // ---- A bump at speed: off the ground, and down again cleanly ----
    // The server puts the car 30 m before the edge at 38 m/s; auto-gas
    // keeps the throttle open, the stick is free (straight on)
    const flightsBefore = (await v2(page)).flights.count;
    const resetsAtBump = (await v2(page)).resets;
    await page.evaluate(({ x, z, yaw, speed }) => (window as unknown as {
        __bulliDebug: { placeLocalCar(x: number, z: number, angle: number, speed: number): void };
    }).__bulliDebug.placeLocalCar(x, z, yaw, speed), BUMP);
    // In the air on screen: the drawn body over the ground (every frame)
    await page.waitForFunction(() => ((window as unknown as {
        __bulliDebug: { snapshot(): { v2: { body: { airHeight: number } } | null } };
    }).__bulliDebug.snapshot().v2?.body.airHeight ?? 0) > 1, undefined, { polling: 'raf', timeout: 20_000 });
    await expect.poll(async () => (await v2(page)).flights.count).toBeGreaterThan(flightsBefore);
    const landed = await v2(page);
    // Half the measured flight at least, over a metre high, a soft landing
    expect(landed.flights.last.ticks).toBeGreaterThanOrEqual(30);
    expect(landed.flights.last.height).toBeGreaterThan(1);
    expect(landed.flights.last.landing).toBeLessThan(15);
    expect(landed.grounded).toBe(true);
    expect(landed.resets).toBe(resetsAtBump);
    // Still rolling on: no crash on the way down
    expect(landed.u).toBeGreaterThan(25);

    // The auto-gas button switches it off
    await page.locator('#btn-autogas').tap();
    await expect(page.locator('#btn-autogas')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => (await v2(page)).input.throttle).toBe(0);

    // No jump any more (docs/phase-1a-design.md 26): holding the RESET
    // button puts the car back onto the road
    await expect(page.getByRole('button', { name: /jump|flip/i })).toHaveCount(0);
    await expect(page.locator('#btn-reset')).toHaveAttribute('aria-label', 'Hold to reset onto the road');
    const resetsBefore = (await v2(page)).resets;
    const reset = await center(page, '#btn-reset');
    await touch(cdp, 'touchStart', [{ ...reset, id: 2 }]);
    await expect.poll(async () => (await v2(page)).resets).toBe(resetsBefore + 1);
    await touch(cdp, 'touchEnd', []);
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
    // the e2e server (3 s): the banner shows after a second and leaves the
    // controls and the HUD free, the car holds still meanwhile
    await page.evaluate(() => (window as unknown as { __bulliDebug: { dropConnection(holdMs: number): void } })
        .__bulliDebug.dropConnection(5000));
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
