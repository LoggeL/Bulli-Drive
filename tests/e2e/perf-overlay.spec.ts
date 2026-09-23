import { test, expect, joinGame, distance, snapshot, placeOnClearRunway, openSandbox, v2 } from './fixtures.js';
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

    // Drive on a free stretch of road: the random spawn can face a wall
    // a few metres ahead.
    await placeOnClearRunway(page);
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
    // The legacy physics has no sim ticks to count
    expect(recording.sim).toBeNull();
    await expect(overlay).not.toContainText('sim');
});

test('?debug=perf counts the v2 sim ticks with the sandbox dummies', async ({ openPlayer }) => {
    const player = await openPlayer('perf-v2');
    const { page } = player;
    await openSandbox(player, '&debug=perf');

    // Local car plus the five dummies in one stepWorld
    const overlay = page.locator('#perf-overlay');
    await expect(overlay).toContainText(/sim\s+\d+\.\d+ ms\s+6 cars/);

    await page.evaluate(() => (window as unknown as { __bulliPerf: PerfHook }).__bulliPerf.startRecording());
    const startTicks = (await v2(page)).ticks;
    await expect.poll(async () => (await v2(page)).ticks - startTicks).toBeGreaterThan(30);
    const recording = await page.evaluate(() =>
        (window as unknown as { __bulliPerf: PerfHook }).__bulliPerf.stopRecording()) as PerfRecording;

    const sim = recording.sim!;
    expect(sim).not.toBeNull();
    expect(sim.ticks).toBeGreaterThan(30);
    expect(sim.frames).toBeGreaterThan(0);
    expect(sim.ticksPerFrame).toBeGreaterThan(0);
    expect(sim.cars.max).toBe(6);
    expect(sim.msPerTick).toBeGreaterThanOrEqual(0);
    expect(sim.msPerTick).toBeLessThan(5);
});
