import type { CDPSession, Page } from '@playwright/test';
import {
    test, expect, openGame, joinFromSplash, snapshot, netState, distance, placeOnClearRunway, v2
} from './fixtures.js';

// Runs in the "mobile" project: iPhone 13 with touch. The critical path on
// a phone: the splash screen with the touch controls and thumb-sized mode
// options, Free Roam from the splash, real touch events on the stick and
// the buttons (docs/phase-1a-design.md, 11.2), the room chip back to the
// Party, a HUD that nothing overlaps in eight viewports, and a lost
// connection that comes back as a new player after the grace time. The
// touch rules themselves (brake threshold, DRIFT bit, auto-gas, flip held =
// reset) are unit-tested in tests/client/input.test.ts.

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

// Touch HUD elements that must never cover each other, with the reset
// prompt shown: it appears exactly when the player is stuck
const HUD = [
    '#btn-drift', '#btn-boost', '#btn-autogas', '#btn-flip', '#btn-shoot', '#btn-honk',
    '#joystick-move', '#interaction-prompt', '#drive-meter', '#map-panel', '#score-container', '#player-list'
];
// Touch controls, which must also stay off the car itself (standing at
// spawn) and clear of the sandbox banner (?sandbox=1, same CSS everywhere)
const CONTROLS = ['#btn-drift', '#btn-boost', '#btn-autogas', '#btn-flip', '#btn-shoot', '#btn-honk', '#joystick-move'];
interface CarBox { left: number; right: number; top: number; bottom: number }

// The car's screen box in CSS pixels, once the camera has caught up with
// the new viewport (two reads in a row agree)
async function carBox(page: Page, width: number, height: number): Promise<CarBox> {
    const read = () => page.evaluate(() => (window as unknown as {
        __bulliDebug: { localCarScreenBox(): CarBox | null };
    }).__bulliDebug.localCarScreenBox());
    const reads: Array<CarBox | null> = [];
    await expect.poll(async () => {
        reads.push(await read());
        const [previous, box] = reads.slice(-2);
        return !!box && !!previous && Math.abs(box.left - previous.left) * width < 1 && Math.abs(box.top - previous.top) * height < 1;
    }, { intervals: [150] }).toBe(true);
    const done = reads[reads.length - 1]!;
    return { left: done.left * width, right: done.right * width, top: done.top * height, bottom: done.bottom * height };
}

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
// The phones the reconnect banner is checked on, portrait and landscape
const PHONES = VIEWPORTS.filter(viewport => ['iPhone 13', 'iPhone SE', 'iPhone 13 landscape', 'iPhone SE landscape'].includes(viewport.name));

test('touch on a phone: splash, Free Roam, stick and buttons, room chip, HUD layout and a lost connection', async ({ openPlayer }) => {
    const player = await openPlayer('phone');
    const { page } = player;

    // ---- Splash screen: touch controls, big enough options ----
    await openGame(player);
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

    // ---- The Party HUD in eight viewports ----
    // With the reset prompt and the sandbox banner (injected: the sandbox
    // page has it, with the same CSS)
    await page.evaluate(() => {
        const banner = document.createElement('div');
        banner.id = 'sandbox-banner';
        banner.innerHTML = '<span class="sandbox-title">SANDBOX</span>'
            + '<button type="button"><span class="key">N</span> Reset dummies</button>'
            + '<button type="button"><span class="key">C</span> Switch car</button>';
        document.getElementById('ui-overlay')!.appendChild(banner);
    });
    // The final layout counts: .control-btn animates its size (transition:
    // all 0.1s), which a slow CI runner can still be in after a resize
    await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; }' });
    const problems: string[] = [];
    for (const viewport of VIEWPORTS) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        // Auto-gas is off, but a powerup picked up meanwhile could put its
        // own, longer text into the prompt; the reset hint is what is measured
        await page.evaluate(() => {
            const prompt = document.getElementById('interaction-prompt')!;
            prompt.textContent = 'HOLD JUMP TO RESET';
            prompt.style.transition = 'none';
            prompt.classList.remove('hidden');
        });
        const car = await carBox(page, viewport.width, viewport.height);
        const boxes = await Promise.all(HUD.map(async selector => ({ selector, box: await page.locator(selector).boundingBox() })));
        for (const { selector, box } of boxes) {
            if (!box) problems.push(`${viewport.name}: ${selector} not shown`);
            else if (box.x < 0 || box.x + box.width > viewport.width) problems.push(`${viewport.name}: ${selector} off screen ${round(box)}`);
        }
        for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) {
                const a = boxes[i].box, b = boxes[j].box;
                if (a && b && overlaps(a, b)) problems.push(`${viewport.name}: ${boxes[i].selector} ${round(a)} overlaps ${boxes[j].selector} ${round(b)}`);
            }
        }
        // The room chip (inside #player-list) stays clear of the map and the controls
        const chip = (await page.locator('#room-chip').boundingBox())!;
        if (chip.x < 0 || chip.x + chip.width > viewport.width) problems.push(`${viewport.name}: #room-chip off screen ${round(chip)}`);
        for (const { selector, box } of boxes) {
            if (box && (selector === '#map-panel' || CONTROLS.includes(selector)) && overlaps(chip, box)) {
                problems.push(`${viewport.name}: #room-chip ${round(chip)} overlaps ${selector} ${round(box)}`);
            }
        }
        const banner = (await page.locator('#sandbox-banner').boundingBox())!;
        const carRect = { x: car.left, y: car.top, width: car.right - car.left, height: car.bottom - car.top };
        for (const { selector, box } of boxes) {
            if (!box || !CONTROLS.includes(selector)) continue;
            if (overlaps(box, carRect)) problems.push(`${viewport.name}: ${selector} ${round(box)} covers the car ${round(carRect)}`);
            if (overlaps(box, banner)) problems.push(`${viewport.name}: the sandbox banner ${round(banner)} covers ${selector} ${round(box)}`);
        }
    }
    expect(problems).toEqual([]);
    await page.evaluate(() => {
        document.getElementById('sandbox-banner')?.remove();
        document.getElementById('interaction-prompt')!.classList.add('hidden');
    });

    // ---- A lost connection ----
    // Drop the socket and keep the reconnect back past the grace time of
    // the e2e server (3 s): the banner shows after a second and leaves the
    // controls and the HUD free, the car holds still meanwhile
    const id = (await snapshot(page)).myId;
    await page.evaluate(() => (window as unknown as { __bulliDebug: { dropConnection(holdMs: number): void } })
        .__bulliDebug.dropConnection(5000));
    const notice = page.locator('#net-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Reconnecting');
    await expect.poll(async () => (await netState(page)).suspended).toBe(true);
    for (const viewport of PHONES) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        const own = (await notice.boundingBox())!;
        if (own.x < 0 || own.x + own.width > viewport.width || own.y < 0) problems.push(`${viewport.name}: banner off screen`);
        for (const selector of [...HUD.filter(selector => selector !== '#interaction-prompt'), '#room-chip']) {
            const box = await page.locator(selector).boundingBox();
            if (box && overlaps(own, box)) problems.push(`${viewport.name}: the reconnect banner ${round(own)} covers ${selector} ${round(box)}`);
        }
    }
    expect(problems).toEqual([]);

    // Back after the hold as a new session: the banner gone, the car
    // spawned again without the splash screen
    await expect.poll(async () => (await netState(page)).reconnects, { timeout: 20_000 }).toBe(1);
    expect((await netState(page)).resumed).toBe(false);
    await expect(notice).toBeHidden();
    await expect.poll(async () => (await netState(page)).spawned).toBe(true);
    const state = await snapshot(page);
    expect(state.myId).not.toBe(id);
    expect(state.connected).toBe(true);
    await expect(page.locator('#splash-screen')).toHaveClass(/\bhidden\b/);
});
