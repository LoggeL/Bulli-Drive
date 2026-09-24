import { spawn, type ChildProcess } from 'node:child_process';
import type { Page } from '@playwright/test';
import { test, expect, joinGame, snapshot, netState, distance, placeOnClearRunway, topmostAtCenter } from './fixtures.js';

// A lost connection and a server restart (docs/phase-1b-design.md, 11.1 to
// 11.3, 15.3): within the grace time the page comes back as the same player
// with the same car; after a restart (SIGTERM, as on a deploy) the banner
// shows, the page reconnects on its own and the resume ticket brings the
// Party score back.

test.use({ viewport: { width: 800, height: 500 } });

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

test('a dropped connection comes back as the same player with the same car', async ({ openPlayer }) => {
    const alice = await openPlayer('alice-drop');
    const bob = await openPlayer('bob-watch');
    const aliceId = await joinGame(alice, 'E2E Drop Alice');
    await joinGame(bob, 'E2E Drop Bob');
    await expect.poll(async () => (await snapshot(bob.page)).remotes[aliceId]?.name).toBe('E2E Drop Alice');

    const before = (await snapshot(alice.page)).local!;
    await alice.page.evaluate(() => (window as unknown as { __bulliDebug: { dropConnection(): void } }).__bulliDebug.dropConnection());
    await expect.poll(async () => (await netState(alice.page)).reconnects).toBe(1);
    const net = await netState(alice.page);
    expect(net.resumed).toBe(true);
    expect(net.lastCloseCode).toBe(4999);
    const state = await snapshot(alice.page);
    expect(state.myId).toBe(aliceId);
    expect(state.connected).toBe(true);
    // The car went on from where it stood, and Bob never lost it
    expect(distance(before, state.local!)).toBeLessThan(5);
    expect((await snapshot(bob.page)).remotes[aliceId]).toBeDefined();
    await expect.poll(async () => (await netState(alice.page)).spawned).toBe(true);
    await expect.poll(async () => (await netState(alice.page)).overlay).toBeNull();

    // And it drives
    await placeOnClearRunway(alice.page);
    const start = (await snapshot(alice.page)).local!;
    await alice.page.keyboard.down('w');
    await expect.poll(async () => distance(start, (await snapshot(alice.page)).local!)).toBeGreaterThan(5);
    await alice.page.keyboard.up('w');
});

test('killed and back before the respawn event came: the car shows again, the overlay is gone', async ({ openPlayer }) => {
    const alice = await openPlayer('alice-killed', { allowedProblems: RECONNECT_NOISE });
    const { page } = alice;
    // The real server behind a route that can add a message of its own
    let socket: import('@playwright/test').WebSocketRoute | null = null;
    await page.routeWebSocket(/\/ws$/, ws => {
        socket = ws;
        ws.connectToServer();
    });
    const aliceId = await joinGame(alice, 'E2E Killed', '', 'party');
    // Shot down (the event as the server sends it), then the connection
    // drops before the respawn event: the server respawns the car meanwhile
    // and the event is lost
    socket!.send(JSON.stringify({ type: 'events', tick: 0, list: [
        { type: 'killed', target: aliceId, killer: 'nobody', killerName: 'E2E Shooter', targetName: 'E2E Killed', cause: 'shot' }
    ] }));
    await expect(page.locator('#respawn-overlay')).toBeVisible();
    await expect.poll(async () => (await snapshot(page)).local?.visible).toBe(false);
    await page.evaluate(() => (window as unknown as { __bulliDebug: { dropConnection(holdMs?: number): void } }).__bulliDebug.dropConnection(1000));
    await expect.poll(async () => (await netState(page)).reconnects, { timeout: 20_000 }).toBe(1);
    expect((await netState(page)).resumed).toBe(true);
    // The server says the car lives: it is drawn and drives again
    await expect(page.locator('#respawn-overlay')).toBeHidden();
    await expect.poll(async () => (await snapshot(page)).local?.visible).toBe(true);
    await expect.poll(async () => (await netState(page)).spawned).toBe(true);
    await placeOnClearRunway(page);
    const start = (await snapshot(page)).local!;
    await page.keyboard.down('w');
    await expect.poll(async () => distance(start, (await snapshot(page)).local!)).toBeGreaterThan(5);
    await page.keyboard.up('w');
});

test('a first connection that fails is retried, with the reason over the loader', async ({ openPlayer }) => {
    const player = await openPlayer('first-fail', { allowedProblems: RECONNECT_NOISE });
    const { page } = player;
    // The first three sockets close at once (a deploy restarting the
    // server): 0.5 + 1 + 2 s of backoff, then the real server
    let attempts = 0;
    await page.routeWebSocket(/\/ws$/, ws => {
        attempts++;
        if (attempts <= 3) {
            ws.close({ code: 1011, reason: 'restarting' });
            return;
        }
        ws.connectToServer();
    });
    await page.goto('/?e2e=1');
    const notice = page.locator('#net-notice');
    await expect(notice).toContainText('Connecting to the server', { timeout: 15_000 });
    expect(await topmostAtCenter(page, '#net-notice')).toBe(true);
    // Then it joins like any page: the world is built, the splash shows
    await expect(page.locator('#loading-screen')).toHaveCount(0, { timeout: 60_000 });
    await expect(page.locator('#splash-screen')).toBeVisible();
    await expect(notice).toBeHidden();
    expect(attempts).toBe(4);
    expect((await snapshot(page)).room).not.toBeNull();
});

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
