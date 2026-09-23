import { test, expect, joinGame, snapshot, netState, distance, placeOnClearRunway } from './fixtures.js';

// The dev netsim of the client and the net lines of the overlay
// (docs/phase-1b-design.md, 11.5 and 12): ?netsim=150,30,0 delays this
// tab's socket both ways, the game still drives, and ?debug=net shows the
// round trip, the netsim and the server's tick times.

test.use({ viewport: { width: 900, height: 600 } });

test('?netsim delays the own socket, the car still drives, ?debug=net shows it', async ({ openPlayer }) => {
    const player = await openPlayer('netsim');
    const { page } = player;
    await joinGame(player, 'E2E Netsim', '&netsim=150,30,0&debug=net');

    const net = await netState(page);
    expect(net.netsim).toEqual({ rttMs: 150, jitterMs: 30, loss: 0, mode: 'tcp' });
    // The clock sees the simulated round trip
    await expect.poll(async () => (await netState(page)).rtt, { timeout: 20_000 }).toBeGreaterThan(120);
    // Far enough ahead of the server for the inputs to arrive in time
    await expect.poll(async () => (await netState(page)).lead, { timeout: 20_000 }).toBeGreaterThan(6);

    await placeOnClearRunway(page);
    const start = (await snapshot(page)).local!;
    await page.keyboard.down('w');
    await expect.poll(async () => distance(start, (await snapshot(page)).local!)).toBeGreaterThan(8);
    await page.keyboard.up('w');

    const overlay = page.locator('#perf-overlay');
    await expect(overlay).toContainText('netsim 150/30/0% tcp');
    await expect(overlay).toContainText(/rtt\s+\d+ ms/);
    await expect(overlay).toContainText(/snap\s+\d+(\.\d)?\/s/);
    await expect(overlay).toContainText(/ws in .*\(bin \d/);
    // The server's tick times, from /healthz
    await expect(overlay).toContainText(/server tick \d+\.\d+\/\d+\.\d+ ms p95\/p99/, { timeout: 10_000 });
});
