import { devices, type Page } from '@playwright/test';
import type { RaceDebugSnapshot } from '../../src/client/e2eHook.js';
import { test, expect, joinGame, placeOnClearRunway, waitFrames, debugCall } from '../e2e/fixtures.js';

// The touch HUD of the Party in eight phone and tablet viewports: no
// control, panel or prompt covers another or leaves the screen, the room
// chip stays clear of the map and the controls, and the controls stay off
// the standing car and clear of the sandbox banner (?sandbox=1, same
// CSS). The same for the race HUD (docs/phase-2-design.md, 17.5): the race
// pill, BRAKE, and the countdown, the banner and the GO zone clear of the
// controls. A layout measurement rather than a user path, so it runs in
// the render job beside the E2E suite; the touch paths themselves are
// tests/e2e/mobile.spec.ts and race.mobile.spec.ts.

// iPhone 13 with touch, rendered by Chromium like the rest of the project
const { defaultBrowserType: _browser, ...iPhone13 } = devices['iPhone 13'];
test.use(iPhone13);

type Box = { x: number; y: number; width: number; height: number };

const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const round = (box: Box) => `[${Math.round(box.x)}..${Math.round(box.x + box.width)}]x[${Math.round(box.y)}..${Math.round(box.y + box.height)}]`;

// Touch HUD elements that must never cover each other, with the reset
// prompt shown: it appears exactly when the player is stuck
const HUD = [
    '#btn-drift', '#btn-boost', '#btn-autogas', '#btn-flip', '#btn-shoot', '#btn-honk',
    '#joystick-move', '#interaction-prompt', '#drive-meter', '#map-panel', '#score-container', '#player-list'
];
// Touch controls, which must also stay off the car itself (standing on
// the runway of the driving tests) and clear of the sandbox banner
const CONTROLS = ['#btn-drift', '#btn-boost', '#btn-autogas', '#btn-flip', '#btn-shoot', '#btn-honk', '#joystick-move'];
interface CarBox { left: number; right: number; top: number; bottom: number }

// The car's screen box in CSS pixels, once the camera has caught up with
// the new viewport: two reads with rendered frames between them agree (on
// a busy runner two reads a fixed time apart can see the same frame,
// before the camera took the new aspect)
async function carBox(page: Page, width: number, height: number): Promise<CarBox> {
    const read = () => page.evaluate(() => (window as unknown as {
        __bulliDebug: { localCarScreenBox(): CarBox | null };
    }).__bulliDebug.localCarScreenBox());
    let previous: CarBox | null = null;
    let done: CarBox | null = null;
    await expect.poll(async () => {
        await waitFrames(page, 2);
        const box = await read();
        const stable = !!box && !!previous
            && Math.abs(box.left - previous.left) * width < 1 && Math.abs(box.right - previous.right) * width < 1
            && Math.abs(box.top - previous.top) * height < 1 && Math.abs(box.bottom - previous.bottom) * height < 1;
        previous = box;
        done = box;
        return stable;
    }, { intervals: [0], timeout: 60_000 }).toBe(true);
    const box = done!;
    return { left: box.left * width, right: box.right * width, top: box.top * height, bottom: box.bottom * height };
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

test('the Party touch HUD in eight viewports: nothing overlaps, the car stays free', async ({ openPlayer }) => {
    const player = await openPlayer('touch-hud');
    const { page } = player;
    await joinGame(player, 'E2E Touch HUD', '', 'party');
    await expect(page.locator('#btn-shoot')).toBeVisible();
    await expect(page.locator('#score-container')).toBeVisible();
    // The server spawns the car at a random spot, and the terrain and the
    // buildings there shift its screen box by a few pixels; measured on
    // the same flat stretch of road, facing +z, the layout check does not
    // depend on where the car happened to spawn
    await placeOnClearRunway(page);

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
        // The car stands (auto-gas starts with the first touch of the
        // stick), and the reset hint is what is measured, not a powerup's
        // own, longer text
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
});

// The race: the pill instead of the score, BRAKE instead of shooting
const RACE_HUD = [
    '#btn-drift', '#btn-boost', '#btn-autogas', '#btn-flip', '#btn-brake', '#btn-honk',
    '#joystick-move', '#drive-meter', '#map-panel', '#race-hud', '#player-list'
];
const RACE_CONTROLS = ['#btn-drift', '#btn-boost', '#btn-autogas', '#btn-flip', '#btn-brake', '#btn-honk', '#joystick-move'];
// Shown for moments (the countdown, a banner, the GO zone before green):
// never over a control, the pill, the map or the room chip
const RACE_TRANSIENT = ['#race-countdown', '#race-banner', '#race-go'];

test('the race touch HUD in eight viewports: nothing overlaps, the car stays free', async ({ openPlayer }) => {
    const player = await openPlayer('race-hud');
    const { page } = player;
    await joinGame(player, 'E2E Race HUD', '', 'race');
    await expect(page.locator('#race-lobby')).toBeVisible();
    // Auto-gas off: the car stands on the grid while the bots race the
    // Downtown Loop (three laps, time enough for the eight viewports)
    await page.evaluate(() => document.getElementById('btn-autogas')!.click());
    await expect(page.locator('#btn-autogas')).toHaveAttribute('aria-pressed', 'false');
    await page.locator('#race-ready').tap();
    await expect.poll(async () => {
        const race = await debugCall<RaceDebugSnapshot | null>(page, 'race');
        return !!race && race.phase === 'racing' && race.tick > race.startTick! + 60;
    }, { timeout: 30_000 }).toBe(true);
    await expect(page.locator('#race-hud')).toBeVisible();
    await expect(page.locator('#btn-brake')).toBeVisible();
    await expect(page.locator('#btn-shoot')).toBeHidden();
    await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; }' });
    // The transient parts as they look at their fullest (the race client
    // hides them again every frame, so the style keeps them up)
    await page.addStyleTag({
        content: '#race-countdown[hidden], #race-banner[hidden] { display: flex !important; } #race-go[hidden] { display: block !important; }'
    });
    await page.evaluate(() => {
        document.querySelectorAll('.race-lights span').forEach(light => light.classList.add('on'));
        document.getElementById('race-count-label')!.textContent = '1';
        document.getElementById('race-banner')!.textContent = 'PERFECT START!';
    });
    const problems: string[] = [];
    for (const viewport of VIEWPORTS) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        const car = await carBox(page, viewport.width, viewport.height);
        const boxes = await Promise.all(RACE_HUD.map(async selector => ({ selector, box: await page.locator(selector).boundingBox() })));
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
        const carRect = { x: car.left, y: car.top, width: car.right - car.left, height: car.bottom - car.top };
        for (const { selector, box } of boxes) {
            if (box && RACE_CONTROLS.includes(selector) && overlaps(box, carRect)) {
                problems.push(`${viewport.name}: ${selector} ${round(box)} covers the car ${round(carRect)}`);
            }
        }
        const chip = (await page.locator('#room-chip').boundingBox())!;
        for (const selector of RACE_TRANSIENT) {
            const own = await page.locator(selector).boundingBox();
            if (!own) {
                problems.push(`${viewport.name}: ${selector} not shown`);
                continue;
            }
            if (own.x < 0 || own.x + own.width > viewport.width) problems.push(`${viewport.name}: ${selector} off screen ${round(own)}`);
            if (overlaps(own, chip)) problems.push(`${viewport.name}: ${selector} ${round(own)} overlaps #room-chip`);
            for (const { selector: other, box } of boxes) {
                // The boost bar is hidden while the lights are on
                if (!box || other === '#drive-meter' || other === '#player-list') continue;
                if (overlaps(own, box)) problems.push(`${viewport.name}: ${selector} ${round(own)} overlaps ${other} ${round(box)}`);
            }
        }
    }
    expect(problems).toEqual([]);
});
