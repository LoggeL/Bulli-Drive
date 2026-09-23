import { test, expect, joinGame, distance, snapshot } from './fixtures.js';
import type { PerfHook, PerfRecording } from '../../src/client/debug/perfMonitor.js';

test('?debug=perf shows the overlay and records frame and bandwidth stats', async ({ openPlayer }) => {
    const player = await openPlayer('perf');
    const { page } = player;
    await joinGame(player, 'E2E Perf', '&debug=perf');

    const overlay = page.locator('#perf-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText(/FPS\s+\d/);
    await expect(overlay).toContainText(/calls\s+\d+/);
    await expect(overlay).toContainText(/ws out\s+\d/);
    // It never takes clicks or touches away from the game.
    await expect(overlay).toHaveCSS('pointer-events', 'none');

    // The init message with the whole world has already been counted.
    const totals = await page.evaluate(() =>
        (window as unknown as { __bulliPerf: PerfHook }).__bulliPerf.wsTotals());
    expect(totals.bytesIn).toBeGreaterThan(10_000);
    expect(totals.messagesOut).toBeGreaterThan(0);

    await page.evaluate(() => (window as unknown as { __bulliPerf: PerfHook }).__bulliPerf.startRecording());
    const start = (await snapshot(page)).local!;
    await page.keyboard.down('w');
    await expect.poll(async () => distance(start, (await snapshot(page)).local!)).toBeGreaterThan(5);
    await page.keyboard.up('w');
    const recording = await page.evaluate(() =>
        (window as unknown as { __bulliPerf: PerfHook }).__bulliPerf.stopRecording()) as PerfRecording;

    expect(recording.frames).toBeGreaterThan(3);
    expect(recording.fps).toBeGreaterThan(0);
    expect(recording.frameMs.avg).toBeGreaterThan(0);
    expect(recording.drawCalls.max).toBeGreaterThan(10);
    expect(recording.triangles.max).toBeGreaterThan(1000);
    expect(recording.geometries).toBeGreaterThan(0);
    expect(recording.textures).toBeGreaterThan(0);
    // Driving sends position updates
    expect(recording.ws.messagesOut).toBeGreaterThan(0);
    expect(recording.ws.bytesOut).toBeGreaterThan(0);
});
