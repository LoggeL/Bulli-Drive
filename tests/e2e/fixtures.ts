import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import type { BulliDebugSnapshot, V2Snapshot } from '../../src/client/e2eHook.js';
import type { Obstacle } from '../../src/client/types.js';
import { CITY_BOUNDS, CITY_CONFIG, roadLineCenter } from '../../src/shared/world/cityGen.js';
import { MEGA_SCALE } from '../../src/shared/constants.js';

export { expect };

export interface Player {
    page: Page;
    // Client -> server messages this page sent over the game WebSocket
    sentMessages: Array<{ type: string; [key: string]: unknown }>;
}

interface PlayerOptions {
    // Console errors, page errors and failed requests that this test expects,
    // matched against the problem text (which includes the URL).
    allowedProblems?: RegExp;
}

interface Fixtures {
    // Opens the game in a fresh browser context (own storage, own WebSocket),
    // i.e. one more player. Console errors on any of them fail the test.
    openPlayer: (label: string, options?: PlayerOptions) => Promise<Player>;
}

export const test = base.extend<Fixtures>({
    openPlayer: async ({ browser, baseURL, viewport, userAgent, isMobile, hasTouch, deviceScaleFactor }, use) => {
        const contexts: BrowserContext[] = [];
        const problems: string[] = [];

        await use(async (label: string, options: PlayerOptions = {}) => {
            const context = await browser.newContext({
                baseURL, viewport, userAgent, isMobile, hasTouch, deviceScaleFactor
            });
            // Keep the run hermetic: the web fonts come from Google, which is
            // neither under test nor always reachable from CI.
            await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route =>
                route.fulfill({ status: 200, contentType: 'text/css', body: '' }));

            const page = await context.newPage();
            const player: Player = { page, sentMessages: [] };
            const report = (problem: string) => {
                if (!options.allowedProblems?.test(problem)) problems.push(`[${label}] ${problem}`);
            };
            page.on('console', message => {
                if (message.type() === 'error') report(`console.error: ${message.text()} (${message.location().url})`);
            });
            page.on('pageerror', error => report(`page error: ${error.message}`));
            page.on('response', response => {
                if (response.status() >= 400) report(`HTTP ${response.status()} ${response.url()}`);
            });
            page.on('websocket', socket => {
                socket.on('framesent', frame => {
                    try {
                        player.sentMessages.push(JSON.parse(String(frame.payload)));
                    } catch { /* not JSON, not ours */ }
                });
            });

            contexts.push(context);
            return player;
        });

        // Playwright records traces and failure screenshots for these contexts
        // too (see "use" in playwright.config.ts) before they are closed.
        for (const context of contexts) {
            await context.close().catch(() => undefined);
        }

        expect(problems, 'console errors, page errors or failed requests').toEqual([]);
    }
});

export function snapshot(page: Page): Promise<BulliDebugSnapshot> {
    return page.evaluate(() => (window as unknown as {
        __bulliDebug: { snapshot(): BulliDebugSnapshot };
    }).__bulliDebug.snapshot());
}

// The local v2 sim car (created with the car's first frame); fails when the
// page runs the legacy physics
export async function v2(page: Page): Promise<V2Snapshot> {
    let state = await snapshot(page);
    if (!state.v2) {
        expect(state.physics, 'the page runs the legacy physics (?physics=legacy)').toBe('v2');
        await expect.poll(async () => (state = await snapshot(page)).v2).not.toBeNull();
    }
    return state.v2!;
}

/**
 * Walks through the real join flow: loading screen, splash screen with the
 * road name, START ENGINE. Resolves with the player's server id.
 * extraQuery is appended to the URL, e.g. '&debug=perf'.
 */
export async function joinGame(player: Player, name: string, extraQuery = ''): Promise<string> {
    const { page } = player;
    await page.goto(`/?e2e=1${extraQuery}`);

    // The loader is removed once the server's init message has built the world.
    await expect(page.locator('#loading-screen')).toHaveCount(0, { timeout: 60_000 });
    const splash = page.locator('#splash-screen');
    await expect(splash).toBeVisible();
    await expect(splash).not.toHaveClass(/\bhidden\b/);

    await page.locator('#splash-name-input').fill(name);
    const startButton = page.locator('#start-btn');
    if (await page.evaluate(() => navigator.maxTouchPoints > 0)) {
        await startButton.tap();
    } else {
        await startButton.click();
    }

    // The start waits for the world textures and car models (ui/assetGate.ts)
    await expect(splash).toHaveClass(/\bhidden\b/, { timeout: 45_000 });
    await expect.poll(async () => {
        const state = await snapshot(page);
        return state.connected && !!state.local && state.myId;
    }).toBeTruthy();
    expect(player.sentMessages.map(message => message.type)).toContain('playerReady');

    return (await snapshot(page)).myId!;
}

/** Opens the sandbox and starts from the splash screen, without a server connection. */
export async function openSandbox(player: Player, extraQuery = ''): Promise<void> {
    const { page } = player;
    await page.goto(`/?e2e=1&sandbox=1${extraQuery}`);
    await expect(page.locator('#loading-screen')).toHaveCount(0, { timeout: 60_000 });
    const splash = page.locator('#splash-screen');
    await expect(splash).toBeVisible();
    await page.locator('#splash-name-input').fill('Sandbox E2E');
    const startButton = page.locator('#start-btn');
    if (await page.evaluate(() => navigator.maxTouchPoints > 0)) await startButton.tap();
    else await startButton.click();
    await expect(splash).toHaveClass(/\bhidden\b/, { timeout: 45_000 });
    await v2(page);
}

export function distance(a: { x: number; z: number }, b: { x: number; z: number }): number {
    return Math.hypot(a.x - b.x, a.z - b.z);
}

// Collision radius of the car (CAR_HALF in entities/Bulli.ts), grown by the
// Mega powerup it might pick up on the way, plus some room to spare.
const RUNWAY_CLEARANCE = 1.5 * MEGA_SCALE + 1;

/**
 * Free length ahead of a car at (x, z0) driving towards +z (angle 0) until an
 * obstacle (grown by RUNWAY_CLEARANCE) blocks the line x = const.
 */
function freeRunway(obstacles: Obstacle[], x: number, z0: number): number {
    let free = CITY_BOUNDS.maxZ - z0;
    for (const obstacle of obstacles) {
        let halfAcross: number;
        let halfAlong: number;
        if (obstacle.type === 'rect') {
            halfAcross = obstacle.halfWidth + RUNWAY_CLEARANCE;
            halfAlong = obstacle.halfDepth + RUNWAY_CLEARANCE;
        } else {
            const dx = Math.abs(obstacle.x - x);
            const reach = obstacle.radius + RUNWAY_CLEARANCE;
            if (dx >= reach) continue;
            halfAcross = reach;
            halfAlong = Math.sqrt(reach * reach - dx * dx);
        }
        if (Math.abs(obstacle.x - x) >= halfAcross) continue;
        const nearEdge = obstacle.z - halfAlong;
        const farEdge = obstacle.z + halfAlong;
        if (farEdge <= z0) continue;
        if (nearEdge <= z0) return 0;
        free = Math.min(free, nearEdge - z0);
    }
    return free;
}

/**
 * The server spawns the car at a random spot, facing +z, and some spots face
 * a wall or a planter a few metres ahead. Driving tests start from the longest
 * free stretch of the north-south roads instead, so they do not depend on luck.
 * Returns where the car was put and how much room it has ahead.
 */
export async function placeOnClearRunway(page: Page, minLength = 120): Promise<{ x: number; z: number; free: number }> {
    const obstacles = await page.evaluate(() => (window as unknown as {
        __bulliDebug: { obstacles(): Obstacle[] };
    }).__bulliDebug.obstacles());
    expect(obstacles.length, 'city obstacles').toBeGreaterThan(0);

    let best = { x: 0, z: 0, free: -1 };
    const laneOffset = CITY_CONFIG.roadWidth / 4;
    for (let line = 0; line <= CITY_CONFIG.gridSize; line++) {
        for (const lane of [-laneOffset, 0, laneOffset]) {
            const x = roadLineCenter(line, 'x') + lane;
            for (let z = CITY_BOUNDS.minZ + 5; z < CITY_BOUNDS.maxZ; z += 2) {
                const free = freeRunway(obstacles, x, z);
                if (free > best.free) best = { x, z, free };
            }
        }
    }
    expect(best.free, 'free runway on a north-south road').toBeGreaterThanOrEqual(minLength);

    await page.evaluate(({ x, z }) => (window as unknown as {
        __bulliDebug: { placeLocalCar(x: number, z: number, angle: number): void };
    }).__bulliDebug.placeLocalCar(x, z, 0), best);
    await expect.poll(async () => distance(best, (await snapshot(page)).local!)).toBeLessThan(0.01);
    return best;
}
