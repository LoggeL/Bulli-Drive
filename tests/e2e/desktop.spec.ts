import type { Page } from '@playwright/test';
import {
    test, expect, openGame, joinFromSplash, snapshot, distance, placeOnClearRunway, v2, debugCall, waitFrames, meanColor
} from './fixtures.js';
import type { BulliDebugSnapshot, CarInfo, TextureProbe, WorldInfo } from '../../src/client/e2eHook.js';

// The critical path on the desktop, in the production build: load, the
// assets (meshopt + KTX2 car models and world textures through the hashed
// Basis transcoder) while the splash screen is up, join, the HUD, drive
// with the keyboard, and a lost and restored WebGL context. Headless
// Chromium renders with SwiftShader, i.e. the 'software' tier. What a unit
// test can check lives in tests/client (key map, camera, HUD texts, GLB
// bodies, context-loss timers, the environment map rebuild).

type LoseContextWindow = Window & { __loseContext?: WEBGL_lose_context };

async function loseContext(page: Page): Promise<void> {
    await page.evaluate(() => {
        const canvas = document.querySelector('body > canvas') as HTMLCanvasElement;
        const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
        const ext = gl!.getExtension('WEBGL_lose_context')!;
        (window as LoseContextWindow).__loseContext = ext;
        ext.loseContext();
    });
}

// Frames the page drew over the next `callbacks` animation frames
function framesDrawnOver(page: Page, callbacks: number): Promise<number> {
    return page.evaluate(async count => {
        const debug = (window as unknown as { __bulliDebug: { snapshot(): { render: { frame: number } } } }).__bulliDebug;
        const start = debug.snapshot().render.frame;
        for (let i = 0; i < count; i++) await new Promise(resolve => requestAnimationFrame(resolve));
        return debug.snapshot().render.frame - start;
    }, callbacks);
}

test('loads, joins, drives and survives a lost WebGL context on the desktop', async ({ openPlayer }) => {
    const player = await openPlayer('desktop');
    const { page } = player;
    const transcoder: string[] = [];
    page.on('response', response => {
        // Emitted by Vite with a content hash: assets/basis_transcoder-<hash>.js/.wasm
        const file = /\/assets\/(basis_transcoder)-[\w-]+\.(js|wasm)$/.exec(response.url());
        if (file && response.ok()) transcoder.push(`${file[1]}.${file[2]}`);
    });

    // ---- Splash screen: the keys, the assets load meanwhile ----
    await openGame(player);
    await expect(page.locator('.preview-keyboard')).toBeVisible();
    await expect(page.locator('.preview-touch')).toBeHidden();
    const models = await debugCall<BulliDebugSnapshot['models']>(page, 'modelsSettled');
    expect(models.errors).toEqual([]);
    expect(models.status).toBe('ready');
    // Software tier: LOD1 and LOD2 of all five cars, shaders compiled
    expect(models.loaded).toEqual(['beetle', 'bulli', 'jeep', 'pickup', 'sport'].flatMap(id => [`${id}:1`, `${id}:2`]));
    expect(models.warmedUp).toBe(true);
    // Loading does not wait for the player
    await expect(page.locator('#splash-screen')).toBeVisible();
    expect(transcoder.sort()).toEqual(['basis_transcoder.js', 'basis_transcoder.wasm']);
    // A standalone KTX2 texture decodes through the same transcoder
    const albedo = await debugCall<TextureProbe>(page, 'loadTextureProbe', '/textures/pbr/asphalt_albedo.ktx2');
    expect(albedo).toMatchObject({ width: 1024, height: 1024, compressed: true, mipmaps: 11, colorSpace: 'srgb' });

    // ---- Join ----
    const myId = await joinFromSplash(player, 'E2E Solo');

    // The three.js canvas fills the window and keeps rendering the scene
    const canvas = page.locator('body > canvas');
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box?.width).toBe(1280);
    expect(box?.height).toBe(800);
    await waitFrames(page, 5);
    expect((await snapshot(page)).render.calls).toBeGreaterThan(10);

    // The world: textures and sky in, baked palm impostors, no environment
    // map on the software tier
    const world = await debugCall<WorldInfo>(page, 'worldSettled');
    expect(world.tier).toBe('software');
    expect(world.textures.failed).toBe(0);
    expect(world.textures.requested).toBeGreaterThan(5);
    expect(world.textures.loaded).toBe(world.textures.requested);
    expect(world.groups).toEqual(expect.arrayContaining(['city', 'environment', 'sky-dome']));
    expect(world.environment).toBeNull();
    expect(world.palms?.baked).toBe(true);
    // The own car is the GLB model
    await expect.poll(async () => (await debugCall<CarInfo | null>(page, 'localCarInfo'))?.gltf).toBe(true);

    // Desktop HUD, no touch controls
    for (const selector of ['#score-container', '#speedometer', '#drive-meter', '.controls-hint', '#map-panel', '#scoreboard-toggle']) {
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

    // ---- Drive ----
    // Hold W on a free stretch of road: the car speeds up, the speedometer
    // shows it and the car moves
    const runway = await placeOnClearRunway(page);
    const start = (await snapshot(page)).local!;
    await page.keyboard.down('w');
    await expect.poll(async () => Number(await page.locator('#speedo-value').textContent())).toBeGreaterThan(10);
    await expect.poll(async () => distance(start, (await snapshot(page)).local!)).toBeGreaterThan(2);
    // The HUD shows the sim's forward speed in km/h (1 u = 1 m). Read both in
    // the same task.
    const reading = await page.evaluate(() => ({
        shown: Number(document.getElementById('speedo-value')!.textContent),
        // The speed the last frame showed (u / 60 per tick): online the sim
        // also ticks between frames, so the live state may be ahead of it
        u: (window as unknown as { __bulliDebug: { snapshot(): { local: { speed: number } } } })
            .__bulliDebug.snapshot().local.speed * 60
    }));
    expect(Math.abs(reading.shown - Math.abs(reading.u) * 3.6)).toBeLessThanOrEqual(1);
    await page.keyboard.up('w');
    // Online the car sends inputs (binary), never positions
    expect(player.binarySent).toBeGreaterThan(0);
    expect(player.sentMessages.some(message => message.type === 'update')).toBe(false);

    // Letting go of W releases the throttle and the car slows down
    await expect.poll(async () => (await v2(page)).input.throttle).toBe(0);
    const releasedAt = await v2(page);
    await expect.poll(async () => (await v2(page)).u).toBeLessThan(releasedAt.u);
    expect((await snapshot(page)).myId).toBe(myId);

    // ---- A lost WebGL context (GPU reset) ----
    // A fixed view of the street with the car at rest
    await debugCall(page, 'placeLocalCar', runway.x, runway.z, 0);
    await expect.poll(async () => Math.abs((await v2(page)).u), { timeout: 20_000 }).toBeLessThan(0.05);
    await debugCall(page, 'setCameraOverride', { position: [runway.x - 4, 6, runway.z - 14], lookAt: [runway.x + 2, 2, runway.z + 20], fov: 55 });
    await waitFrames(page, 3);
    const colorBefore = await meanColor(page);

    const notice = page.locator('#context-lost');
    await expect(notice).toHaveCount(0);
    await loseContext(page);
    await expect(notice).toBeVisible();
    await expect(notice.getByRole('heading')).toHaveText('Graphics paused');
    // Nothing is drawn while the context is gone
    expect(await framesDrawnOver(page, 10)).toBe(0);

    await page.evaluate(() => (window as LoseContextWindow).__loseContext!.restoreContext());
    // three.js rebuilds its GL state (fresh info counters), the notice goes
    // and the full scene is drawn again
    await expect(notice).toBeHidden();
    await waitFrames(page, 5);
    await expect.poll(async () => (await snapshot(page)).render.calls).toBeGreaterThan(10);
    // Textures and sky are back: the view looks the same (a lost texture
    // samples black)
    const colorAfter = await meanColor(page);
    for (let channel = 0; channel < 3; channel++) {
        expect(Math.abs(colorAfter[channel] - colorBefore[channel]), `channel ${channel}: ${colorBefore} -> ${colorAfter}`).toBeLessThan(6);
    }
    expect((await snapshot(page)).connected).toBe(true);
});
