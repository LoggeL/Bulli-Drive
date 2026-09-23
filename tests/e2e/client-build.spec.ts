import { test, expect, type Player } from './fixtures.js';

// Stale-client guards (src/client/buildVersion.ts and the inline asset guard
// in index.html) and the ?e2e=1 gate of the test hook, all against the real
// production build.

function countPageLoads(player: Player): () => number {
    let loads = 0;
    player.page.on('load', () => loads++);
    return () => loads;
}

test('current build starts without reload, test hook or perf overlay', async ({ openPlayer }) => {
    const player = await openPlayer('plain');
    const loads = countPageLoads(player);
    await player.page.goto('/');

    await expect(player.page.locator('#loading-screen')).toHaveCount(0, { timeout: 60_000 });
    await expect(player.page.locator('#splash-screen')).toBeVisible();
    const pageVersion = await player.page.locator('meta[name="bulli-build-version"]').getAttribute('content');
    const serverVersion = (await (await player.page.request.get('/build-version.txt')).text()).trim();
    expect(pageVersion).toMatch(/^[a-f0-9]{16}$/);
    expect(pageVersion).toBe(serverVersion);
    expect(loads()).toBe(1);
    expect(await player.page.evaluate(() => '__bulliDebug' in window)).toBe(false);
    // Nor the ?debug=perf overlay
    expect(await player.page.evaluate(() => '__bulliPerf' in window)).toBe(false);
    await expect(player.page.locator('#perf-overlay')).toHaveCount(0);
});

test('a stale page reloads exactly once, then starts', async ({ openPlayer }) => {
    const player = await openPlayer('stale');
    // Pretend a newer build was deployed while this page was open.
    await player.page.route('**/build-version.txt', route =>
        route.fulfill({ status: 200, contentType: 'text/plain', body: 'ffffffffffffffff\n' }));
    const loads = countPageLoads(player);
    const warnings: string[] = [];
    player.page.on('console', message => {
        if (message.type() === 'warning') warnings.push(message.text());
    });

    await player.page.goto('/?e2e=1');
    await expect(player.page.locator('#loading-screen')).toHaveCount(0, { timeout: 60_000 });
    await expect(player.page.locator('#splash-screen')).toBeVisible();
    expect(loads()).toBe(2);
    expect(warnings.some(text => text.includes('Running stale client build'))).toBe(true);
});

// An index.html from an older deploy references hashed assets the current
// server no longer has (404). The inline guard in index.html reloads once.
const MISSING_ENTRY = '/assets/index-0ldBu1ld.js';

function countDocumentLoads(player: Player): () => number {
    let loads = 0;
    player.page.on('response', response => {
        if (response.request().resourceType() === 'document') loads++;
    });
    return () => loads;
}

function serveStaleIndex(player: Player, times?: number) {
    return player.page.route(url => url.pathname === '/', async route => {
        const response = await route.fetch();
        const html = (await response.text()).replace(/\/assets\/index-[\w-]+\.js/, MISSING_ENTRY);
        await route.fulfill({ response, body: html });
    }, { times });
}

test('a page whose assets are gone reloads once and starts', async ({ openPlayer }) => {
    const player = await openPlayer('stale-assets', { allowedProblems: /index-0ldBu1ld|404 \(Not Found\)/ });
    await serveStaleIndex(player, 1);
    const loads = countDocumentLoads(player);

    await player.page.goto('/');
    await expect(player.page.locator('#loading-screen')).toHaveCount(0, { timeout: 60_000 });
    await expect(player.page.locator('#splash-screen')).toBeVisible();
    expect(loads()).toBe(2);
});

test('missing assets reload the page only once', async ({ openPlayer }) => {
    const player = await openPlayer('broken-assets', { allowedProblems: /index-0ldBu1ld|404 \(Not Found\)/ });
    // Every index.html points at the missing entry, e.g. a broken deploy.
    await serveStaleIndex(player);
    const loads = countDocumentLoads(player);
    const gaveUp = player.page.waitForEvent('console', {
        predicate: message => message.type() === 'warning' && message.text().includes('failed to load again'),
        timeout: 30_000
    });

    await player.page.goto('/');
    await gaveUp;
    expect(loads()).toBe(2);
    await expect(player.page.locator('#loading-screen')).toBeVisible();
});
