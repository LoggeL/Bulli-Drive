import { spawn, type ChildProcess } from 'node:child_process';
import type { Page } from '@playwright/test';
import { PROTOCOL_VERSION } from '../../src/shared/protocol.js';
import { test, expect, joinGame, snapshot, netState, topmostAtCenter, type Player } from './fixtures.js';

// A new deploy while pages are open (docs/phase-1b-design.md, 3.2, 11.2,
// 11.3, 15.3), against the production build: an index.html from the old
// deploy whose hashed assets are gone reloads once and starts; a page that
// speaks an older protocol reloads once and then says why it stops; a
// server restart (SIGTERM) shows the banner, the page comes back on its own
// and the resume ticket brings the Party score back. The guards' logic is
// unit-tested (tests/client/assetGuard, buildVersion, reloadOnce); the
// server's side in tests/server and tests/integration.

test.use({ viewport: { width: 800, height: 500 } });

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

test('an old page whose assets are gone reloads once and starts', async ({ openPlayer }) => {
    const player = await openPlayer('stale-assets', { allowedProblems: /index-0ldBu1ld|404 \(Not Found\)/ });
    // Only the first index.html is the old one
    await player.page.route(url => url.pathname === '/', async route => {
        const response = await route.fetch();
        const html = (await response.text()).replace(/\/assets\/index-[\w-]+\.js/, MISSING_ENTRY);
        await route.fulfill({ response, body: html });
    }, { times: 1 });
    const loads = countDocumentLoads(player);

    await player.page.goto('/');
    await expect(player.page.locator('#loading-screen')).toHaveCount(0, { timeout: 60_000 });
    await expect(player.page.locator('#splash-screen')).toBeVisible();
    expect(loads()).toBe(2);
});

test('a page with an old protocol reloads once, then says why it stops', async ({ openPlayer }) => {
    const { page } = await openPlayer('version');
    // A server that speaks a newer protocol than this page
    await page.routeWebSocket(/\/ws$/, ws => {
        ws.onMessage(message => {
            const msg = JSON.parse(String(message)) as { type: string };
            if (msg.type !== 'hello') return;
            ws.send(JSON.stringify({ type: 'reject', reason: 'version', reload: true, serverProtocol: PROTOCOL_VERSION + 1 }));
            ws.close({ code: 4000, reason: 'version' });
        });
    });
    let loads = 0;
    page.on('load', () => loads++);
    await page.goto('/?e2e=1');
    await expect.poll(() => loads, { timeout: 30_000 }).toBe(2);
    const notice = page.locator('#net-notice');
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expect(notice).toContainText('A new version is out');
    await expect(notice.locator('button')).toHaveText('Reload');
    // The notice only shows once the reload guard held on the reloaded
    // page: no second reload, no loop
    expect(loads).toBe(2);
    // On top: the page never got a room, so the loader is still there
    // (visible alone would also pass underneath it)
    expect(await topmostAtCenter(page, '#net-notice')).toBe(true);
});

// The browser logs every refused WebSocket while the server is down
const RECONNECT_NOISE = /WebSocket connection to .* failed|ERR_CONNECTION_REFUSED/;

async function coins(page: Page): Promise<{ id: number; x: number; z: number; collected: boolean }[]> {
    return page.evaluate(() => (window as unknown as {
        __bulliDebug: { coins(): { id: number; x: number; z: number; collected: boolean }[] };
    }).__bulliDebug.coins());
}

async function place(page: Page, x: number, z: number) {
    await page.evaluate(({ x, z }) => (window as unknown as {
        __bulliDebug: { placeLocalCar(x: number, z: number, angle: number): void };
    }).__bulliDebug.placeLocalCar(x, z, 0), { x, z });
}

// The own server of this test: started, stopped with SIGTERM and started
// again on the same port
function startServer(port: number): ChildProcess {
    const child = spawn(process.execPath, ['dist/server/index.js'], {
        env: { ...process.env, PORT: String(port), E2E: '1', SESSION_SECRET: 'e2e secret for the restart test' },
        stdio: ['ignore', 'ignore', 'pipe']
    });
    child.stderr?.on('data', (data: Buffer) => process.stderr.write(`[restart-server] ${data}`));
    return child;
}

async function waitHealthy(port: number): Promise<void> {
    await expect.poll(async () => {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/healthz`);
            return response.ok && (await response.json()).ok === true;
        } catch {
            return false;
        }
    }, { timeout: 30_000 }).toBe(true);
}

function stopped(child: ChildProcess): Promise<number | null> {
    return new Promise(resolve => {
        if (child.exitCode !== null) resolve(child.exitCode);
        else child.once('exit', code => resolve(code));
    });
}

test('a server restart: the banner shows, the page comes back on its own with its score', async ({ openPlayer }) => {
    const port = (Number(process.env.E2E_PORT) || 8799) + 1;
    let server = startServer(port);
    try {
        await waitHealthy(port);
        const player = await openPlayer('restart', { allowedProblems: RECONNECT_NOISE });
        const { page } = player;
        const firstId = await joinGame(player, 'E2E Restart', '', undefined, `http://127.0.0.1:${port}`);

        // Collect a coin: the server counts it (+10)
        const coin = (await coins(page)).find(c => !c.collected)!;
        expect(coin).toBeDefined();
        await place(page, coin.x, coin.z);
        await expect.poll(async () => (await snapshot(page)).score, { timeout: 20_000 }).toBeGreaterThanOrEqual(10);
        const score = (await snapshot(page)).score;
        // The coin pill of the Party HUD shows it (it stayed at 0 before)
        await expect(page.locator('#score-display')).toHaveText(String(score));

        // A deploy: SIGTERM, the process says goodbye and exits with 0 in time
        const stopStarted = Date.now();
        server.kill('SIGTERM');
        expect(await stopped(server)).toBe(0);
        expect(Date.now() - stopStarted).toBeLessThan(6000);
        await expect.poll(async () => (await netState(page)).lastCloseCode).toBe(1012);
        await expect.poll(async () => (await netState(page)).overlay, { timeout: 5000 }).toBe('Reconnecting…');
        await expect(page.locator('#net-notice')).toBeVisible();

        // The new process
        server = startServer(port);
        await waitHealthy(port);
        const upAt = Date.now();
        await expect.poll(async () => {
            const state = await snapshot(page);
            const net = await netState(page);
            return state.connected && net.spawned && net.reconnects >= 1 && state.myId !== firstId;
        }, { timeout: 10_000 }).toBe(true);
        expect(Date.now() - upAt).toBeLessThan(5000);
        // A new session (new process), with the score from the resume ticket
        expect((await netState(page)).resumed).toBe(false);
        await expect.poll(async () => (await snapshot(page)).score).toBe(score);
        await expect(page.locator('#score-display')).toHaveText(String(score));
        await expect(page.locator('#net-notice')).toBeHidden();
        await expect.poll(async () => (await snapshot(page)).room?.kind).toBe('party');
    } finally {
        if (server.exitCode === null) {
            server.kill('SIGTERM');
            await stopped(server);
        }
    }
});
