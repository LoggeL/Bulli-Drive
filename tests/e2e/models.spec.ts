import { test, expect, joinGame, snapshot, type Player } from './fixtures.js';
import type { BulliDebugSnapshot, ModelInfo, TextureProbe } from '../../src/client/e2eHook.js';

// The asset pipeline end to end in the production build: the model cache
// (src/client/assets/ModelCache.ts) loads the meshopt + KTX2 GLBs from
// public/models while the splash screen is up, the Basis transcoder comes from
// the hashed assets/basis-* directory, and standalone KTX2 textures from
// public/textures decode through the same loader. Headless Chromium renders
// with SwiftShader, i.e. the 'software' tier, which preloads LOD1 and LOD2.

type ModelsSnapshot = BulliDebugSnapshot['models'];

interface ModelHook {
    modelsSettled(): Promise<ModelsSnapshot>;
    modelInfo(id: string, lod: number): ModelInfo | null;
    loadTextureProbe(url: string): Promise<TextureProbe>;
}

async function openGame(player: Player): Promise<void> {
    await player.page.goto('/?e2e=1');
    await expect(player.page.locator('#loading-screen')).toHaveCount(0, { timeout: 60_000 });
    await expect(player.page.locator('#splash-screen')).toBeVisible();
}

function settled(player: Player): Promise<ModelsSnapshot> {
    return player.page.evaluate(() =>
        (window as unknown as { __bulliDebug: ModelHook }).__bulliDebug.modelsSettled());
}

test('car models load, decode and warm up during the splash screen', async ({ openPlayer }) => {
    const player = await openPlayer('models');
    const transcoder: string[] = [];
    player.page.on('response', response => {
        if (/\/assets\/basis-[0-9a-f]+\/basis_transcoder\.(js|wasm)$/.test(response.url()) && response.ok()) {
            transcoder.push(response.url().split('/').pop()!);
        }
    });
    await openGame(player);

    const models = await settled(player);
    expect(models.errors).toEqual([]);
    expect(models.status).toBe('ready');
    expect(models.loaded).toEqual(['bulli:1', 'bulli:2']);
    expect(models.warmedUp).toBe(true);
    // The splash screen is still up: loading does not wait for the player
    await expect(player.page.locator('#splash-screen')).toBeVisible();
    expect(transcoder.sort()).toEqual(['basis_transcoder.js', 'basis_transcoder.wasm']);

    const info = await player.page.evaluate(() =>
        (window as unknown as { __bulliDebug: ModelHook }).__bulliDebug.modelInfo('bulli', 1));
    expect(info).not.toBeNull();
    expect(info!.triangles).toBe(7965);
    for (const node of ['body', 'wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr', 'wheel_fl_geo', 'socket_nametag', 'accessory_surfboard']) {
        expect(info!.nodes).toContain(node);
    }
    expect(info!.materials).toEqual(expect.arrayContaining(['paint_primary', 'paint_secondary', 'bulli_atlas', 'glass']));
    // Every texture came in as KTX2 and was transcoded
    expect(info!.compressedTextures).toBeGreaterThan(0);
    expect(info!.otherTextures).toBe(0);
    expect(info!.hiddenNodes).toContain('accessory_surfboard');
    // Real size in metres (opaque parts): ~2.1 m wide with mirrors, ~2 m high, 4.28 m long (three +Z)
    expect(info!.size[0]).toBeGreaterThan(1.7);
    expect(info!.size[0]).toBeLessThan(2.2);
    expect(info!.size[1]).toBeGreaterThan(1.8);
    expect(info!.size[1]).toBeLessThan(2.1);
    expect(info!.size[2]).toBeGreaterThan(4.1);
    expect(info!.size[2]).toBeLessThan(4.4);

    // LOD0 is not preloaded on the software tier
    expect(await player.page.evaluate(() =>
        (window as unknown as { __bulliDebug: ModelHook }).__bulliDebug.modelInfo('bulli', 0))).toBeNull();

    // Standalone textures from public/textures through the same KTX2Loader
    const probe = (url: string) => player.page.evaluate(u =>
        (window as unknown as { __bulliDebug: ModelHook }).__bulliDebug.loadTextureProbe(u), url);
    const albedo = await probe('/textures/pbr/asphalt_albedo.ktx2');
    expect(albedo).toMatchObject({ width: 1024, height: 1024, compressed: true, mipmaps: 11, colorSpace: 'srgb' });
    const normal = await probe('/textures/pbr/asphalt_normal.ktx2');
    expect(normal).toMatchObject({ width: 512, height: 512, compressed: true, mipmaps: 10 });
    expect(normal.colorSpace).not.toBe('srgb');
});

test('the game falls back to the procedural cars without the models', async ({ openPlayer }) => {
    const player = await openPlayer('no-models', { allowedProblems: /\/models\/manifest\.json/ });
    await player.page.route('**/models/manifest.json', route => route.fulfill({ status: 404, body: 'gone' }));
    // Joining still works, with the procedural car
    await joinGame(player, 'Fallback');

    const models = await settled(player);
    expect(models.status).toBe('failed');
    expect(models.loaded).toEqual([]);
    expect(models.errors.join()).toMatch(/HTTP 404/);
    expect((await snapshot(player.page)).local).not.toBeNull();
});
