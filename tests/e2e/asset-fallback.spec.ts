import { test, expect, FLOW_DRAW_FPS, joinGame, snapshot, debugCall, placeOnClearRunway, distance, v2 } from './fixtures.js';
import type { BulliDebugSnapshot, CarInfo, WorldInfo } from '../../src/client/e2eHook.js';

// A page whose assets do not arrive (CDN, network, transcoder all end up
// here) must still be playable: without the car models the procedural car
// drives, without the KTX2 world textures the world keeps its placeholders.
// The fallbacks themselves are unit-tested (tests/client/modelCache.test.ts,
// worldTextures.test.ts); that the placeholders shade the world instead of
// black is a render check on the phone tier (tests/e2e-render), because the
// software tier here shades with the mean albedo anyway.

test('without the car models and the world textures the game still joins and drives', async ({ openPlayer }) => {
    const player = await openPlayer('no-assets', {
        allowedProblems: /\/models\/manifest\.json|\.ktx2|Failed to load resource|net::ERR_FAILED/
    });
    const { page } = player;
    await page.route('**/models/manifest.json', route => route.fulfill({ status: 404, body: 'gone' }));
    await page.route(/\/textures\/.*\.ktx2/, route => route.abort());
    await joinGame(player, 'E2E No Assets', FLOW_DRAW_FPS);

    // The procedural car
    const models = await debugCall<BulliDebugSnapshot['models']>(page, 'modelsSettled');
    expect(models.status).toBe('failed');
    expect(models.loaded).toEqual([]);
    expect(models.errors.join()).toMatch(/HTTP 404/);
    expect((await snapshot(page)).local).not.toBeNull();
    expect(await debugCall<CarInfo | null>(page, 'localCarInfo')).toMatchObject({ carType: 'bulli', gltf: false, lod: -1 });

    // Every world texture failed
    const world = await debugCall<WorldInfo>(page, 'worldSettled');
    expect(world.textures.requested).toBeGreaterThan(5);
    expect(world.textures.loaded).toBe(0);
    expect(world.textures.failed).toBe(world.textures.requested);


    // And the procedural car drives
    await placeOnClearRunway(page);
    const start = (await snapshot(page)).local!;
    await page.keyboard.down('w');
    await expect.poll(async () => (await v2(page)).u).toBeGreaterThan(5);
    await expect.poll(async () => distance(start, (await snapshot(page)).local!)).toBeGreaterThan(3);
    await page.keyboard.up('w');
});
