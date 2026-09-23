import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import type { BulliDebugSnapshot } from '../../src/client/e2eHook.js';

export { expect };

export interface Player {
    page: Page;
    // Client -> server messages this page sent over the game WebSocket
    sentMessages: Array<{ type: string; [key: string]: unknown }>;
}

interface Fixtures {
    // Opens the game in a fresh browser context (own storage, own WebSocket),
    // i.e. one more player. Console errors on any of them fail the test.
    openPlayer: (label: string) => Promise<Player>;
}

export const test = base.extend<Fixtures>({
    openPlayer: async ({ browser, baseURL, viewport, userAgent, isMobile, hasTouch, deviceScaleFactor }, use) => {
        const contexts: BrowserContext[] = [];
        const problems: string[] = [];

        await use(async (label: string) => {
            const context = await browser.newContext({
                baseURL, viewport, userAgent, isMobile, hasTouch, deviceScaleFactor
            });
            // Keep the run hermetic: the web fonts come from Google, which is
            // neither under test nor always reachable from CI.
            await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route =>
                route.fulfill({ status: 200, contentType: 'text/css', body: '' }));

            const page = await context.newPage();
            const player: Player = { page, sentMessages: [] };
            page.on('console', message => {
                if (message.type() === 'error') problems.push(`[${label}] console.error: ${message.text()}`);
            });
            page.on('pageerror', error => problems.push(`[${label}] page error: ${error.message}`));
            page.on('response', response => {
                if (response.status() >= 400) problems.push(`[${label}] HTTP ${response.status()} ${response.url()}`);
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

/**
 * Walks through the real join flow: loading screen, splash screen with the
 * road name, START ENGINE. Resolves with the player's server id.
 */
export async function joinGame(player: Player, name: string): Promise<string> {
    const { page } = player;
    await page.goto('/?e2e=1');

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

    await expect(splash).toHaveClass(/\bhidden\b/);
    await expect.poll(async () => {
        const state = await snapshot(page);
        return state.connected && !!state.local && state.myId;
    }).toBeTruthy();
    expect(player.sentMessages.map(message => message.type)).toContain('playerReady');

    return (await snapshot(page)).myId!;
}

export function distance(a: { x: number; z: number }, b: { x: number; z: number }): number {
    return Math.hypot(a.x - b.x, a.z - b.z);
}
