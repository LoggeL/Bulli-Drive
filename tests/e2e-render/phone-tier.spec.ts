import type { Page } from '@playwright/test';
import { test, expect, joinGame, snapshot, waitFrames, meanColor, debugCall } from '../e2e/fixtures.js';
import type { MapWorldStats, WorldInfo } from '../../src/client/e2eHook.js';
import { mapFor } from '../../src/server/maps.js';
import { heightAt } from '../../src/shared/map/heightfield.js';

// Render checks of the phone tier (graphics G1, docs/cars.md,
// docs/phase-3-design.md 10 and 15): only a renderer can count draw calls
// or show what the placeholders look like, so these stay browser tests, but
// they are measurements, not user paths. They run as their own Playwright
// project ('render', npm run test:e2e:render) in their own CI job, beside
// the E2E suite. SwiftShader renders them; ?tier=low forces the phone tier.
// The rules behind the budget are unit-tested: other players' cars LOD >= 1
// without shadow casting on the phone tier (tests/client/gltfCarBody.test.ts),
// the map world's detail levels (worldQuality.test.ts), the kit cells
// (kitCells.test.ts), the placeholder texels (worldTextures.test.ts).

interface WorldHook {
    worldSettled(): Promise<WorldInfo>;
    spawnCar(type: string, color: number, x: number, z: number, yaw?: number): unknown;
    carModels(): { gltf: boolean; lod: number; local: boolean; shadowCasters: number }[];
    worldInfo(): WorldInfo;
    mapWorldStats(): MapWorldStats | null;
    placeLocalCar(x: number, z: number, angle: number): void;
}

// Half the desktop project's 1280 x 800 at the same aspect ratio: the camera
// frustum, and with it the draw calls and triangles, stay the same, while
// software WebGL shades a quarter of the pixels.
test.use({ viewport: { width: 640, height: 400 } });

function settled(page: Page): Promise<WorldInfo> {
    return page.evaluate(() => (window as unknown as { __bulliDebug: WorldHook }).__bulliDebug.worldSettled());
}

// Three fixed chase camera points of Bulli Bay (design 15): Main Street
// between 1st and 2nd Avenue looking east (the densest view: shop rows on
// both sides, palms, the town beyond), the harbour's Harbor Boulevard with
// its halls, a hairpin of the Ridge Road with the hills round it
const MAIN_STREET = { x: -446, z: -20, yaw: Math.PI / 2 };
const VIEWS = [MAIN_STREET, { x: -250, z: 298, yaw: 1.546 }, { x: 471.3, z: -390.1, yaw: -3.133 }];
const ground = (() => {
    const hf = mapFor().hf;
    return (x: number, z: number) => heightAt(hf, x, z);
})();

async function place(page: Page, view: { x: number; z: number; yaw: number }): Promise<void> {
    await page.evaluate(({ x, z, yaw }) => (window as unknown as { __bulliDebug: WorldHook }).__bulliDebug.placeLocalCar(x, z, yaw), view);
    // Placed by the server (debugPlace): wait until the car is there
    await expect.poll(async () => {
        const local = (await snapshot(page)).local!;
        return Math.hypot(local.x - view.x, local.z - view.z);
    }).toBeLessThan(0.5);
}

test('the phone tier stays within 150 draw calls and 500 k triangles including shadows on Bulli Bay', async ({ openPlayer }) => {
    const player = await openPlayer('world-low');
    await joinGame(player, 'E2E World Low', '&tier=low', 'freeroam');
    const { page } = player;

    const info = await settled(page);
    expect(info.tier).toBe('mobile');
    expect(info.textures.failed).toBe(0);
    expect(info.environment).not.toBeNull();

    for (const view of VIEWS) {
        await place(page, view);
        // The kit cells round a new spot are merged over a few frames; once
        // they are ready the counts settle within two frames (measured at
        // all three views), four leave room
        await expect.poll(async () => (await page.evaluate(() => (window as unknown as { __bulliDebug: WorldHook }).__bulliDebug.mapWorldStats()))?.kit).toBe('ready');
        await waitFrames(page, 4);
        const { render } = await snapshot(page);
        const stats = await page.evaluate(() => (window as unknown as { __bulliDebug: WorldHook }).__bulliDebug.mapWorldStats());
        expect(stats?.detail).toBe('low');
        expect(render.shadowCalls, `shadow pass at ${view.x}, ${view.z}`).toBeGreaterThan(0);
        expect(render.calls, `calls at ${view.x}, ${view.z}`).toBeLessThanOrEqual(150);
        expect(render.triangles, `triangles at ${view.x}, ${view.z}`).toBeLessThanOrEqual(500_000);
    }
    // Palms beyond 110 m (the phone tier's impostor distance) are cards
    await place(page, MAIN_STREET);
    await waitFrames(page, 4);
    const { palms } = await page.evaluate(() => (window as unknown as { __bulliDebug: WorldHook }).__bulliDebug.worldInfo());
    expect(palms?.impostors).toBeGreaterThan(0);
    expect(palms?.near).toBeGreaterThan(0);

    // A party on Main Street ahead: seven other cars (all five types) 8 to
    // 38 m in front of the camera. Other players' cars are cheap on the
    // phone (LOD1 with baked wheels or LOD2, no shadow casting), so the
    // budget holds with them in view.
    const alone = (await snapshot(page)).render.calls;
    await page.evaluate(({ x, z }) => {
        const debug = (window as unknown as { __bulliDebug: WorldHook }).__bulliDebug;
        const types = ['bulli', 'beetle', 'pickup', 'sport', 'jeep', 'bulli', 'beetle'];
        // Main Street runs east (+x) here: ahead is +x, the lanes at z ± 3
        types.forEach((type, i) => debug.spawnCar(type, 0x3366aa + i * 0x101010, x + 8 + i * 5, z + (i % 2 ? 3 : -3), Math.PI / 2));
    }, MAIN_STREET);
    await waitFrames(page, 5);
    const party = (await snapshot(page)).render;
    const cars = await page.evaluate(() => (window as unknown as { __bulliDebug: WorldHook }).__bulliDebug.carModels());
    const others = cars.filter(car => !car.local);
    expect(others).toHaveLength(7);
    expect(others.every(car => car.gltf && car.lod >= 1 && car.shadowCasters === 0)).toBe(true);
    expect(party.calls, `${alone} calls alone`).toBeLessThanOrEqual(150);
    expect(party.triangles).toBeLessThanOrEqual(500_000);
});

test('without its KTX2 textures the world is plainly shaded, not black', async ({ openPlayer }) => {
    const player = await openPlayer('world-no-textures', { allowedProblems: /\.ktx2|Failed to load resource|net::ERR_FAILED/ });
    const { page } = player;
    // Every world texture fails (network, CDN, transcoder all end up here)
    await page.route(/\/textures\/.*\.ktx2/, route => route.abort());
    await joinGame(player, 'E2E No Textures', '&tier=low');

    const info = await settled(page);
    expect(info.tier).toBe('mobile');
    expect(info.textures.requested).toBeGreaterThan(5);
    expect(info.textures.failed).toBe(info.textures.requested);

    // Looking down Main Street: road, sidewalks and shop fronts fill the view
    const { x, z } = MAIN_STREET;
    const y = ground(x, z);
    await debugCall(page, 'placeLocalCar', x, z, MAIN_STREET.yaw);
    await debugCall(page, 'setCameraOverride', { position: [x - 14, y + 6, z - 4], lookAt: [x + 20, y + 2, z + 2], fov: 55 });
    await waitFrames(page, 3);
    const [r, g, b] = await meanColor(page);
    // The placeholders are the mean albedo of each material. Measured on
    // SwiftShader: about 101 mean brightness with them, 64 when the colour
    // placeholders are black texels (sky and lit untextured parts keep it
    // above 45, the old threshold, which let exactly that pass)
    expect((r + g + b) / 3, `mean color ${r}, ${g}, ${b}`).toBeGreaterThan(80);
});
