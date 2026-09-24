import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import type { BulliDebugSnapshot, NetDebugSnapshot, V2Snapshot } from '../../src/client/e2eHook.js';
import type { ColliderInput } from '../../src/shared/world/colliders.js';
import { longestRunway } from '../../tools/bots/runway.js';

export { expect };

export interface Player {
    page: Page;
    // Client -> server JSON messages this page sent over the game WebSocket
    sentMessages: Array<{ type: string; [key: string]: unknown }>;
    // Binary frames it sent (input packets) and received (snapshots)
    binarySent: number;
    binaryReceived: number;
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
            const player: Player = { page, sentMessages: [], binarySent: 0, binaryReceived: 0 };
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
                    if (typeof frame.payload !== 'string') {
                        player.binarySent++;
                        return;
                    }
                    try {
                        player.sentMessages.push(JSON.parse(frame.payload));
                    } catch { /* not JSON, not ours */ }
                });
                socket.on('framereceived', frame => {
                    if (typeof frame.payload !== 'string') player.binaryReceived++;
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

// The netcode numbers of the page (window.__bulliNet)
export function netState(page: Page): Promise<NetDebugSnapshot> {
    return page.evaluate(() => (window as unknown as {
        __bulliNet: { snapshot(): NetDebugSnapshot };
    }).__bulliNet.snapshot());
}

// The local sim car (created with the car's first frame)
export async function v2(page: Page): Promise<V2Snapshot> {
    let state = await snapshot(page);
    if (!state.v2) await expect.poll(async () => (state = await snapshot(page)).v2).not.toBeNull();
    return state.v2!;
}

async function tap(page: Page, selector: string): Promise<void> {
    if (await page.evaluate(() => navigator.maxTouchPoints > 0)) await page.locator(selector).tap();
    else await page.locator(selector).click();
}

/**
 * Opens the game up to the splash screen: the loader is removed once the
 * server's room state has built the world. extraQuery is appended to the
 * URL, e.g. '&drawfps=2'.
 */
export async function openGame(player: Player, extraQuery = '', origin = ''): Promise<void> {
    const { page } = player;
    await page.goto(`${origin}/?e2e=1${extraQuery}`);
    await expect(page.locator('#loading-screen')).toHaveCount(0, { timeout: 60_000 });
    const splash = page.locator('#splash-screen');
    await expect(splash).toBeVisible();
    await expect(splash).not.toHaveClass(/\bhidden\b/);
}

/**
 * The splash screen of an opened game: the road name (and the game mode,
 * when given), START ENGINE. Resolves with the player's server id.
 */
export async function joinFromSplash(player: Player, name: string, mode?: 'party' | 'freeroam' | 'race'): Promise<string> {
    const { page } = player;
    const splash = page.locator('#splash-screen');
    await page.locator('#splash-name-input').fill(name);
    if (mode) {
        await tap(page, `.mode-option[data-room="${mode}"]`);
        await expect(page.locator(`.mode-option[data-room="${mode}"]`)).toHaveAttribute('aria-checked', 'true');
    }
    await tap(page, '#start-btn');

    // The start waits for the world textures and car models (ui/assetGate.ts)
    await expect(splash).toHaveClass(/\bhidden\b/, { timeout: 45_000 });
    await expect.poll(async () => {
        const state = await snapshot(page);
        return state.connected && !!state.local && state.myId;
    }).toBeTruthy();
    await expect.poll(() => player.sentMessages.map(message => message.type)).toContain('ready');
    // The server spawned the car and the prediction runs
    await expect.poll(async () => {
        const net = await netState(page);
        return net.spawned && net.tick >= 0;
    }).toBe(true);
    if (mode) await expect.poll(async () => (await snapshot(page)).room?.kind).toBe(mode);

    return (await snapshot(page)).myId!;
}

/** The whole join flow: loading screen, splash screen, START ENGINE. */
export async function joinGame(player: Player, name: string, extraQuery = '', mode?: 'party' | 'freeroam' | 'race', origin = ''): Promise<string> {
    await openGame(player, extraQuery, origin);
    return joinFromSplash(player, name, mode);
}

/** Calls a function of the test hook (window.__bulliDebug) in the page. */
export function debugCall<T>(page: Page, name: string, ...args: unknown[]): Promise<T> {
    return page.evaluate(({ name, args }) => {
        const debug = (window as unknown as { __bulliDebug: Record<string, (...a: unknown[]) => unknown> }).__bulliDebug;
        return debug[name](...args);
    }, { name, args }) as Promise<T>;
}

/** Waits until the page has drawn `frames` more frames. */
export async function waitFrames(page: Page, frames: number): Promise<void> {
    const start = (await snapshot(page)).render.frame;
    await expect.poll(async () => (await snapshot(page)).render.frame, { timeout: 60_000 }).toBeGreaterThan(start + frames);
}

/**
 * Mean colour of the rendered view without the HUD, decoded in the page
 * (no image library).
 */
export async function meanColor(page: Page): Promise<[number, number, number]> {
    await page.addStyleTag({ content: 'body.mean-color-shot > *:not(canvas) { visibility: hidden !important; }' });
    await page.evaluate(() => document.body.classList.add('mean-color-shot'));
    const png = (await page.screenshot()).toString('base64');
    await page.evaluate(() => document.body.classList.remove('mean-color-shot'));
    return page.evaluate(async data => {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(image, 0, 0);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const sum = [0, 0, 0];
        for (let i = 0; i < pixels.length; i += 4) {
            sum[0] += pixels[i];
            sum[1] += pixels[i + 1];
            sum[2] += pixels[i + 2];
        }
        const n = pixels.length / 4;
        return [sum[0] / n, sum[1] / n, sum[2] / n] as [number, number, number];
    }, png);
}

/** Whether the element under the middle of `selector` belongs to it (nothing covers it). */
export async function topmostAtCenter(page: Page, selector: string): Promise<boolean> {
    return page.evaluate(sel => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const box = el.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return !!hit && el.contains(hit);
    }, selector);
}

/** Waits until no session of a closed page waits on the page's server any more. */
export async function noClosedPlayersLeft(page: Page): Promise<void> {
    const origin = new URL(page.url()).origin;
    await expect.poll(async () => {
        try {
            const response = await page.request.get(`${origin}/healthz`);
            return (await response.json() as { graceSessions: number }).graceSessions;
        } catch {
            return -1;
        }
    }, { timeout: 20_000 }).toBe(0);
}

export function distance(a: { x: number; z: number }, b: { x: number; z: number }): number {
    return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * The server spawns the car at a random spot, facing +z, and some spots face
 * a wall or a planter a few metres ahead. Driving tests start from the longest
 * free stretch of the north-south roads instead, so they do not depend on luck.
 * Returns where the car was put and how much room it has ahead.
 */
export async function placeOnClearRunway(page: Page, minLength = 120): Promise<{ x: number; z: number; free: number }> {
    // Every test drives off the same runway: the cars of the pages an
    // earlier test closed wait there as idle ghosts for the grace time
    // (docs/phase-1b-design.md, 11.1) and have to be gone first
    await noClosedPlayersLeft(page);
    const colliders = await page.evaluate(() => (window as unknown as {
        __bulliDebug: { colliders(): ColliderInput[] };
    }).__bulliDebug.colliders());
    expect(colliders.length, 'city colliders').toBeGreaterThan(0);

    const best = longestRunway(colliders);
    expect(best.free, 'free runway on a north-south road').toBeGreaterThanOrEqual(minLength);

    await page.evaluate(({ x, z }) => (window as unknown as {
        __bulliDebug: { placeLocalCar(x: number, z: number, angle: number): void };
    }).__bulliDebug.placeLocalCar(x, z, 0), best);
    await expect.poll(async () => distance(best, (await snapshot(page)).local!)).toBeLessThan(0.01);
    return best;
}
