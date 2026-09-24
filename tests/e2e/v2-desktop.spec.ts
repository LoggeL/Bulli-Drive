import { test, expect, joinGame, snapshot, distance, placeOnClearRunway, v2 } from './fixtures.js';

// The v2 physics (the default, no URL parameter) on the desktop: the
// fixed-step sim drives, steers, jumps, drifts and resets the local car
// (docs/phase-1a-design.md, 14.8).

test('the v2 physics drives, steers, jumps, drifts and resets', async ({ openPlayer }) => {
    const player = await openPlayer('desktop-v2');
    const { page } = player;
    await joinGame(player, 'E2E V2');

    const initial = await v2(page);
    expect(initial.classId).toBeTruthy();
    expect(initial.profile).toBe('standard');
    // The race camera sits low and close behind the car (the old camera: 23 m up)
    await expect.poll(async () => {
        const { camera, local } = await snapshot(page);
        return Math.hypot(camera.x - local!.x, camera.z - local!.z);
    }).toBeLessThan(15);
    const { camera, local } = await snapshot(page);
    expect(camera.y - local!.y).toBeLessThan(10);

    // W: the car speeds up, the speedometer follows the sim speed (u in km/h)
    await placeOnClearRunway(page);
    const start = (await snapshot(page)).local!;
    await page.keyboard.down('w');
    await expect.poll(async () => (await v2(page)).u).toBeGreaterThan(12);
    await expect.poll(async () => distance(start, (await snapshot(page)).local!)).toBeGreaterThan(10);
    const reading = await page.evaluate(() => ({
        shown: Number(document.getElementById('speedo-value')!.textContent),
        // The speed the last frame showed (u / 60 per tick): online the sim
        // also ticks between frames, so the live state may be ahead of it
        u: (window as unknown as { __bulliDebug: { snapshot(): { local: { speed: number } } } }).__bulliDebug.snapshot().local.speed * 60
    }));
    expect(Math.abs(reading.shown - reading.u * 3.6)).toBeLessThanOrEqual(1);
    // Online the car sends inputs (binary), never positions
    expect(player.binarySent).toBeGreaterThan(0);
    expect(player.sentMessages.some(message => message.type === 'update')).toBe(false);

    // Handbrake (Space) plus A at speed: the tail steps out, the car slides
    // with a slip angle and turns left (yaw grows)
    const beforeDrift = await v2(page);
    await page.keyboard.down('Space');
    await page.keyboard.down('a');
    // 1.5 s of sim time (90 ticks), not wall-clock time: below 7.5 fps
    // (software WebGL on a CI runner) the fixed-step loop caps the ticks per
    // frame and the sim runs slower than real time.
    const peak = await page.evaluate(async () => {
        const debug = (window as unknown as { __bulliDebug: { snapshot(): { v2: { beta: number; yaw: number; ticks: number } } } }).__bulliDebug;
        let maxBeta = 0;
        const endTick = debug.snapshot().v2.ticks + 90;
        const deadline = performance.now() + 15000;
        while (debug.snapshot().v2.ticks < endTick && performance.now() < deadline) {
            await new Promise(resolve => requestAnimationFrame(resolve));
            maxBeta = Math.max(maxBeta, Math.abs(debug.snapshot().v2.beta));
        }
        return { maxBeta, yaw: debug.snapshot().v2.yaw };
    });
    await page.keyboard.up('a');
    await page.keyboard.up('Space');
    await page.keyboard.up('w');
    test.info().annotations.push({ type: 'drift', description: `peak slip angle ${(peak.maxBeta * 180 / Math.PI).toFixed(1)}°` });
    expect(peak.maxBeta).toBeGreaterThan(5 * Math.PI / 180);
    expect(peak.yaw).toBeGreaterThan(beforeDrift.yaw + 0.1);

    // Brake to a stop with S. Held on, S reverses after 8 ticks at a
    // standstill, so the page watches every frame for the stop instead of
    // polling (a poll can miss the short standstill and see the reverse).
    // Below 7.5 fps (software WebGL on a CI runner) one frame runs more than
    // 8 ticks and can hold the stop and the start of the reverse, so a
    // speed that turned against the one before braking counts as a stop too
    await page.keyboard.down('s');
    const stopped = await page.evaluate(async () => {
        const debug = (window as unknown as { __bulliDebug: { snapshot(): { v2: { u: number } } } }).__bulliDebug;
        const before = Math.sign(debug.snapshot().v2.u);
        const until = performance.now() + 15_000;
        while (performance.now() < until) {
            const u = debug.snapshot().v2.u;
            if (Math.abs(u) < 1 || Math.sign(u) === -before) return true;
            await new Promise(resolve => requestAnimationFrame(resolve));
        }
        return false;
    });
    await page.keyboard.up('s');
    expect(stopped, 'the car came to a stop').toBe(true);

    // Q jumps: the car leaves the ground and comes back down
    const jumpsBefore = (await v2(page)).jumps;
    await page.keyboard.press('q');
    await expect.poll(async () => (await v2(page)).jumps).toBe(jumpsBefore + 1);
    await expect.poll(async () => (await v2(page)).grounded).toBe(true);

    // Holding R resets the car (onto the nearest road, with a short contact ghost)
    const resetsBefore = (await v2(page)).resets;
    await page.keyboard.down('r');
    await expect.poll(async () => (await v2(page)).resets).toBe(resetsBefore + 1);
    await page.keyboard.up('r');
    const afterReset = await v2(page);
    expect(Math.abs(afterReset.u)).toBeLessThan(0.5);
    expect(afterReset.ghostTicks).toBeGreaterThan(0);

    // A quick tap of R does nothing
    await page.keyboard.press('r');
    await page.waitForTimeout(300);
    expect((await v2(page)).resets).toBe(resetsBefore + 1);
});
