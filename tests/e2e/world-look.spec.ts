import { createHash } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect, joinGame, snapshot } from './fixtures.js';
import type { CameraPose, WorldInfo } from '../../src/client/e2eHook.js';
import type { Obstacle } from '../../src/client/types.js';
import { roadLineCenter } from '../../src/shared/world/cityGen.js';

// The realistic world look (graphics G1) in the production build: world
// textures (KTX2) and sky, the draw call budget of the phone tier, the
// unchanged collision layout, and a lost WebGL context that has to bring the
// environment map and the textures back. Headless Chromium renders with
// SwiftShader; ?tier=low forces the phone tier on it.

interface WorldHook {
    worldSettled(): Promise<WorldInfo>;
    spawnCar(type: string, color: number, x: number, z: number, yaw?: number): unknown;
    carModels(): { gltf: boolean; lod: number; local: boolean; shadowCasters: number }[];
    worldInfo(): WorldInfo;
    obstacles(): Obstacle[];
    placeLocalCar(x: number, z: number, angle: number): void;
    setCameraOverride(pose: CameraPose | null): void;
}

function settled(page: Page): Promise<WorldInfo> {
    return page.evaluate(() => (window as unknown as { __bulliDebug: WorldHook }).__bulliDebug.worldSettled());
}

// sha1 of the client's obstacle list (JSON) as it was before the world look
// changed: 241 obstacles (trees, rocks, buildings, park, plaza, lamps, palms,
// signs). A visual change of the world must not move a single collider.
const OBSTACLES_SHA1 = '3622d9d9cbbf5f9c3232f3486244cc7da18b5d1a';

// The chase camera on the middle road looking north (the screenshot "street")
const STREET = { x: roadLineCenter(2, 'x'), z: -60 };

async function waitFrames(page: Page, frames: number): Promise<void> {
    const start = (await snapshot(page)).render.frame;
    await expect.poll(async () => (await snapshot(page)).render.frame, { timeout: 60_000 }).toBeGreaterThan(start + frames);
}

test('the world loads its textures and sky and keeps every collider', async ({ openPlayer }) => {
    const player = await openPlayer('world');
    await joinGame(player, 'E2E World');
    const { page } = player;

    const info = await settled(page);
    expect(info.tier).toBe('software');
    expect(info.textures.failed).toBe(0);
    expect(info.textures.requested).toBeGreaterThan(5);
    expect(info.textures.loaded).toBe(info.textures.requested);
    expect(info.groups).toEqual(expect.arrayContaining(['city', 'environment', 'sky-dome']));
    // The software tier renders without the environment map
    expect(info.environment).toBeNull();

    const obstacles = await page.evaluate(() => (window as unknown as { __bulliDebug: WorldHook }).__bulliDebug.obstacles());
    expect(obstacles).toHaveLength(241);
    expect(createHash('sha1').update(JSON.stringify(obstacles)).digest('hex')).toBe(OBSTACLES_SHA1);

    // Instanced street furniture (streetLayout.ts) inside those colliders,
    // and the 12 palms with a baked impostor atlas
    expect(info.furniture).toEqual({ lamp: 12, signal: 20, hydrant: 6, trashCan: 7, bench: 4 });
    expect(info.palms?.baked).toBe(true);
    expect((info.palms?.near ?? 0) + (info.palms?.impostors ?? 0)).toBe(12);
});

test('the phone tier stays within 150 draw calls including shadows', async ({ openPlayer }) => {
    const player = await openPlayer('world-low');
    await joinGame(player, 'E2E World Low', '&tier=low');
    const { page } = player;

    const info = await settled(page);
    expect(info.tier).toBe('mobile');
    expect(info.textures.failed).toBe(0);
    expect(info.environment).not.toBeNull();

    await page.evaluate(({ x, z }) => (window as unknown as { __bulliDebug: WorldHook }).__bulliDebug.placeLocalCar(x, z, 0), STREET);
    await waitFrames(page, 5);
    const { render } = await snapshot(page);
    expect(render.shadowCalls).toBeGreaterThan(0);
    expect(render.calls).toBeLessThanOrEqual(150);
    expect(render.triangles).toBeLessThanOrEqual(500_000);
    // Palms beyond 110 m (the phone tier's impostor distance) are cards
    const { palms } = await page.evaluate(() => (window as unknown as { __bulliDebug: WorldHook }).__bulliDebug.worldInfo());
    expect(palms?.impostors).toBeGreaterThan(0);
    expect(palms?.near).toBeGreaterThan(0);

    // A party on the road ahead: seven other cars (all five types) 8 to 38 m
    // in front of the camera. Other players' cars are cheap on the phone
    // (LOD1 with baked wheels or LOD2, no shadow casting), so the budget
    // holds with them in view.
    const alone = render.calls;
    await page.evaluate(({ x, z }) => {
        const debug = (window as unknown as { __bulliDebug: WorldHook }).__bulliDebug;
        const types = ['bulli', 'beetle', 'pickup', 'sport', 'jeep', 'bulli', 'beetle'];
        types.forEach((type, i) => debug.spawnCar(type, 0x3366aa + i * 0x101010, x + (i % 2 ? 3 : -3), z + 8 + i * 5, 0));
    }, STREET);
    await waitFrames(page, 5);
    const party = (await snapshot(page)).render;
    const cars = await page.evaluate(() => (window as unknown as { __bulliDebug: WorldHook }).__bulliDebug.carModels());
    const others = cars.filter(car => !car.local);
    expect(others).toHaveLength(7);
    expect(others.every(car => car.gltf && car.lod >= 1 && car.shadowCasters === 0)).toBe(true);
    expect(party.calls, `${alone} calls alone`).toBeLessThanOrEqual(150);
    expect(party.triangles).toBeLessThanOrEqual(500_000);
});

// Mean color of the rendered view without the HUD, decoded in the page (no
// image library)
async function meanColor(page: Page): Promise<[number, number, number]> {
    await page.addStyleTag({ content: 'body.world-look-shot > *:not(canvas) { visibility: hidden !important; }' });
    await page.evaluate(() => document.body.classList.add('world-look-shot'));
    const png = (await page.screenshot()).toString('base64');
    await page.evaluate(() => document.body.classList.remove('world-look-shot'));
    return page.evaluate(async data => {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(image, 0, 0);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const sum = [0, 0, 0];
        for (let i = 0; i < pixels.length; i += 4) {
            sum[0] += pixels[i];
            sum[1] += pixels[i + 1];
            sum[2] += pixels[i + 2];
        }
        const n = pixels.length / 4;
        return [sum[0] / n, sum[1] / n, sum[2] / n] as [number, number, number];
    }, png);
}

test('a restored WebGL context rebuilds the environment map and the textures', async ({ openPlayer }) => {
    const player = await openPlayer('world-context');
    await joinGame(player, 'E2E World Context', '&tier=low');
    const { page } = player;
    const before = await settled(page);
    expect(before.environment).not.toBeNull();

    // A fixed view of the textured street
    await page.evaluate(({ x, z }) => {
        const debug = (window as unknown as { __bulliDebug: WorldHook }).__bulliDebug;
        debug.placeLocalCar(x, z, 0);
        debug.setCameraOverride({ position: [x - 4, 6, z - 14], lookAt: [x + 2, 2, z + 20], fov: 55 });
    }, STREET);
    await waitFrames(page, 3);
    const colorBefore = await meanColor(page);

    await page.evaluate(() => {
        const canvas = document.querySelector('body > canvas') as HTMLCanvasElement;
        const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
        const ext = gl!.getExtension('WEBGL_lose_context')!;
        (window as unknown as { __loseContext: WEBGL_lose_context }).__loseContext = ext;
        ext.loseContext();
    });
    await expect(page.locator('#context-lost')).toBeVisible();
    await page.evaluate(() => (window as unknown as { __loseContext: WEBGL_lose_context }).__loseContext.restoreContext());
    await expect(page.locator('#context-lost')).toBeHidden();
    await waitFrames(page, 3);

    const after = await page.evaluate(() => (window as unknown as { __bulliDebug: WorldHook }).__bulliDebug.worldInfo());
    // A new PMREM render target was rendered on the restored context
    expect(after.environment).not.toBeNull();
    expect(after.environment).not.toBe(before.environment);
    // Textures, sky and environment are back: the view looks the same (a
    // lost texture samples black, a lost environment map darkens the shading)
    const colorAfter = await meanColor(page);
    for (let channel = 0; channel < 3; channel++) {
        expect(Math.abs(colorAfter[channel] - colorBefore[channel]), `channel ${channel}: ${colorBefore} -> ${colorAfter}`).toBeLessThan(6);
    }
});

test('without its KTX2 textures the world is plainly shaded, not black', async ({ openPlayer }) => {
    const player = await openPlayer('world-no-textures', { allowedProblems: /\.ktx2|Failed to load resource|net::ERR_FAILED/ });
    const { page } = player;
    // Every world texture fails (network, CDN, transcoder all end up here)
    await page.route(/\/textures\/.*\.ktx2/, route => route.abort());
    await joinGame(player, 'E2E No Textures', '&tier=low');

    const info = await settled(page);
    expect(info.textures.requested).toBeGreaterThan(5);
    expect(info.textures.loaded).toBe(0);
    expect(info.textures.failed).toBe(info.textures.requested);

    await page.evaluate(({ x, z }) => {
        const debug = (window as unknown as { __bulliDebug: WorldHook }).__bulliDebug;
        debug.placeLocalCar(x, z, 0);
        // Looking down the street: road, sidewalks and facades fill the view
        debug.setCameraOverride({ position: [x - 4, 6, z - 14], lookAt: [x + 2, 2, z + 20], fov: 55 });
    }, STREET);
    await waitFrames(page, 3);
    const [r, g, b] = await meanColor(page);
    // The placeholders are the mean albedo of each material: a black world
    // (unloaded textures sampled as black) averages far below this
    expect(Math.min(r, g, b), `mean color ${r}, ${g}, ${b}`).toBeGreaterThan(45);
});
