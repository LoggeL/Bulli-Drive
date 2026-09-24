import type { Page } from '@playwright/test';
import { test, expect, joinGame, snapshot, waitFrames, meanColor, debugCall } from '../e2e/fixtures.js';
import type { WorldInfo } from '../../src/client/e2eHook.js';
import { roadLineCenter } from '../../src/shared/world/cityGen.js';

// Render checks of the phone tier (graphics G1, docs/cars.md): only a
// renderer can count draw calls or show what the placeholders look like,
// so these stay browser tests, but they are measurements, not user paths.
// They run as their own Playwright project ('render', npm run
// test:e2e:render) in their own CI job, beside the E2E suite. SwiftShader
// renders them; ?tier=low forces the phone tier. The rule behind the budget
// (other players' cars LOD >= 1 without shadow casting on the phone tier)
// is unit-tested in tests/client/gltfCarBody.test.ts, the placeholder
// texels in tests/client/worldTextures.test.ts.

interface WorldHook {
    worldSettled(): Promise<WorldInfo>;
    spawnCar(type: string, color: number, x: number, z: number, yaw?: number): unknown;
    carModels(): { gltf: boolean; lod: number; local: boolean; shadowCasters: number }[];
    worldInfo(): WorldInfo;
    placeLocalCar(x: number, z: number, angle: number): void;
}

// Half the desktop project's 1280 x 800 at the same aspect ratio: the camera
// frustum, and with it the draw calls and triangles, stay the same, while
// software WebGL shades a quarter of the pixels.
test.use({ viewport: { width: 640, height: 400 } });

function settled(page: Page): Promise<WorldInfo> {
    return page.evaluate(() => (window as unknown as { __bulliDebug: WorldHook }).__bulliDebug.worldSettled());
}

// The chase camera on the middle road looking north (the screenshot "street")
const STREET = { x: roadLineCenter(2, 'x'), z: -60 };

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

    // Looking down the street: road, sidewalks and facades fill the view
    await debugCall(page, 'placeLocalCar', STREET.x, STREET.z, 0);
    await debugCall(page, 'setCameraOverride', { position: [STREET.x - 4, 6, STREET.z - 14], lookAt: [STREET.x + 2, 2, STREET.z + 20], fov: 55 });
    await waitFrames(page, 3);
    const [r, g, b] = await meanColor(page);
    // The placeholders are the mean albedo of each material. Measured on
    // SwiftShader: about 101 mean brightness with them, 64 when the colour
    // placeholders are black texels (sky and lit untextured parts keep it
    // above 45, the old threshold, which let exactly that pass)
    expect((r + g + b) / 3, `mean color ${r}, ${g}, ${b}`).toBeGreaterThan(80);
});
