import WebSocket from 'ws';
import { test, expect, topmostAtCenter } from './fixtures.js';
import { PROTOCOL_VERSION } from '../../src/shared/protocol.js';

// Version check and health (docs/phase-1b-design.md, 3.2, 11.4, 15.3): an
// old client is turned away with 4000 and a reload; the page reloads once
// and then shows why it stops; /healthz answers for Docker.

test('an old protocol is turned away with close 4000 and a reload', async ({ baseURL }) => {
    const url = `${baseURL!.replace(/^http/, 'ws')}/ws`;
    const result = await new Promise<{ messages: unknown[]; code: number }>((resolve, reject) => {
        const ws = new WebSocket(url);
        const messages: unknown[] = [];
        ws.on('open', () => ws.send(JSON.stringify({
            type: 'hello', protocolVersion: 1, build: null, connId: 'old', name: 'Old', carType: 'bulli', profile: 'standard', room: 'party'
        })));
        ws.on('message', data => messages.push(JSON.parse(data.toString())));
        ws.on('close', code => resolve({ messages, code }));
        ws.on('error', reject);
    });
    expect(result.code).toBe(4000);
    expect(result.messages).toEqual([{ type: 'reject', reason: 'version', reload: true, serverProtocol: PROTOCOL_VERSION }]);
});

test('the page reloads once for a new protocol, then says why it stops', async ({ openPlayer }) => {
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
    // On top: the page never got a room, so the loader is still there
    // (visible alone would also pass underneath it)
    expect(await topmostAtCenter(page, '#net-notice')).toBe(true);
    // No reload loop
    await page.waitForTimeout(1500);
    expect(loads).toBe(2);
});

test('/healthz reports a running tick', async ({ request }) => {
    const response = await request.get('/healthz');
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toContain('no-store');
    const body = await response.json();
    expect(body).toEqual(expect.objectContaining({ ok: true, shuttingDown: false }));
    expect(body.lastTickAgeMs).toBeLessThan(1000);
    for (const key of ['rooms', 'players', 'tickP95Ms', 'tickP99Ms', 'uptimeS']) expect(typeof body[key]).toBe('number');
});
