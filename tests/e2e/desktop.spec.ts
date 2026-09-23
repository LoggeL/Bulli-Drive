import { test, expect, joinGame, snapshot, distance, placeOnClearRunway } from './fixtures.js';

interface Cruise {
    // Covered ground per second, in km/h (1 u = 1 m)
    kmh: number;
    // Speedometer at the end of the run
    shown: number;
    // Share of the real time the car physics simulated. Bulli.ts caps a frame
    // at 1/30 s, so below 30 FPS the car covers less ground than its speed
    // (and the speedometer) says.
    simulatedShare: number;
    fps: number;
}

// Runs in the page: waits until the car holds a steady speed, then records its
// position every frame for about a second.
async function measureCruise(): Promise<Cruise> {
    type Local = { x: number; z: number; speed: number };
    const debug = (window as unknown as {
        __bulliDebug: { snapshot(): { local: Local } };
    }).__bulliDebug;
    const nextFrame = () => new Promise<number>(resolve => requestAnimationFrame(resolve));

    const deadline = performance.now() + 30_000;
    let lastSpeed = NaN;
    for (let steadyFrames = 0; steadyFrames < 3;) {
        await nextFrame();
        const { speed } = debug.snapshot().local;
        steadyFrames = speed !== 0 && speed === lastSpeed ? steadyFrames + 1 : 0;
        lastSpeed = speed;
        if (performance.now() > deadline) throw new Error('the car never reached a steady speed');
    }

    const samples: Array<Local & { time: number }> = [];
    do {
        const time = await nextFrame();
        samples.push({ ...debug.snapshot().local, time });
    } while (samples[samples.length - 1].time - samples[0].time < 1000);

    const first = samples[0];
    const last = samples[samples.length - 1];
    if (samples.some(sample => sample.speed !== first.speed)) throw new Error('the speed changed while measuring');
    let simulated = 0;
    for (let i = 1; i < samples.length; i++) {
        simulated += Math.min(samples[i].time - samples[i - 1].time, 1000 / 30);
    }
    const seconds = (last.time - first.time) / 1000;
    return {
        kmh: Math.hypot(last.x - first.x, last.z - first.z) / seconds * 3.6,
        shown: Number(document.getElementById('speedo-value')!.textContent),
        simulatedShare: simulated / 1000 / seconds,
        fps: (samples.length - 1) / seconds
    };
}

test('loads, joins and drives on desktop', async ({ openPlayer }) => {
    const player = await openPlayer('desktop');
    const { page } = player;
    const myId = await joinGame(player, 'E2E Solo');

    // The three.js canvas fills the window and keeps rendering the scene.
    const canvas = page.locator('body > canvas');
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box?.width).toBe(1280);
    expect(box?.height).toBe(800);
    const firstFrame = (await snapshot(page)).render.frame;
    await expect.poll(async () => (await snapshot(page)).render.frame).toBeGreaterThan(firstFrame + 5);
    expect((await snapshot(page)).render.calls).toBeGreaterThan(10);

    // Desktop HUD, no touch controls
    for (const selector of ['#score-container', '#speedometer', '.controls-hint', '#map-panel', '#scoreboard-toggle']) {
        await expect(page.locator(selector), selector).toBeVisible();
    }
    await expect(page.locator('#mobile-controls')).toBeHidden();
    await expect(page.locator('#score-display')).toHaveText('0');
    await expect(page.locator('#speedo-value')).toHaveText('0');

    // The scoreboard lists us
    await page.locator('#scoreboard-toggle').click();
    await expect(page.locator('#scoreboard-panel')).toBeVisible();
    await expect(page.locator('#scoreboard-list .scoreboard-row.me .player-name')).toHaveText('E2E Solo (You)');
    await page.keyboard.press('Escape');
    await expect(page.locator('#scoreboard-panel')).toBeHidden();

    // Hold W on a free stretch of road: the car speeds up, the speedometer
    // shows it and the car moves.
    await placeOnClearRunway(page);
    const start = (await snapshot(page)).local!;
    await page.keyboard.down('w');
    await expect.poll(async () => Number(await page.locator('#speedo-value').textContent())).toBeGreaterThan(10);
    // Software rendering can stall for a moment, so wait for the distance
    // instead of holding W for a fixed time.
    await expect.poll(async () => distance(start, (await snapshot(page)).local!)).toBeGreaterThan(2);
    // The HUD shows carSpeedToKmh() of the car's speed, i.e. its
    // units-per-1/60-s-tick speed times 60 * 3.6. Read both in the same task.
    const reading = await page.evaluate(() => ({
        shown: Number(document.getElementById('speedo-value')!.textContent),
        speed: (window as unknown as { __bulliDebug: { snapshot(): { local: { speed: number } } } })
            .__bulliDebug.snapshot().local.speed
    }));
    expect(Math.abs(reading.shown - Math.abs(reading.speed) * 216)).toBeLessThanOrEqual(1);
    // 1 u = 1 m: at a steady speed the speedometer matches the ground the car
    // really covers per second - at 30 FPS and more. Below that the physics
    // runs slower than real time (simulatedShare < 1), software WebGL
    // included, and the car covers correspondingly less.
    const cruise = await page.evaluate(measureCruise);
    test.info().annotations.push({
        type: 'speedometer',
        description: `shown ${cruise.shown} km/h, covered ${cruise.kmh.toFixed(1)} km/h at ${cruise.fps.toFixed(1)} FPS ` +
            `(physics share ${cruise.simulatedShare.toFixed(2)})`
    });
    expect(cruise.shown).toBeGreaterThan(100);
    expect(Math.abs(cruise.kmh - cruise.shown * cruise.simulatedShare))
        .toBeLessThanOrEqual(cruise.shown * cruise.simulatedShare * 0.05);
    await page.keyboard.up('w');
    expect(player.sentMessages.some(message => message.type === 'update')).toBe(true);

    // Letting go of W releases the throttle and the car slows down.
    const releasedAt = await snapshot(page);
    expect(Math.abs(releasedAt.inputs.throttle)).toBe(0);
    await expect.poll(async () => Math.abs((await snapshot(page)).local!.speed))
        .toBeLessThan(Math.abs(releasedAt.local!.speed));
    expect((await snapshot(page)).myId).toBe(myId);
});
