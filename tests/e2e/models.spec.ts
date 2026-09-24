import { test, expect, joinGame, snapshot, type Player } from './fixtures.js';
import type { BulliDebugSnapshot, CarInfo, ModelInfo, SpawnCarOptions, TextureProbe } from '../../src/client/e2eHook.js';

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
    localCarInfo(): CarInfo | null;
    carModels(): CarInfo[];
    spawnCar(type: string, color: number, x: number, z: number, yaw?: number, options?: SpawnCarOptions): CarInfo | null;
    clearModels(): void;
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
    // Software tier: LOD1 and LOD2 of all five cars
    expect(models.loaded).toEqual(['beetle', 'bulli', 'jeep', 'pickup', 'sport'].flatMap(id => [`${id}:1`, `${id}:2`]));
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
    const car = await player.page.evaluate(() =>
        (window as unknown as { __bulliDebug: ModelHook }).__bulliDebug.localCarInfo());
    expect(car).toMatchObject({ carType: 'bulli', gltf: false, lod: -1 });
});

test('all five cars drive as GLB models with their own materials and distance LODs', async ({ openPlayer }) => {
    const player = await openPlayer('glb-car');
    await joinGame(player, 'Samba');
    await settled(player);
    const debug = () => player.page.evaluate(() => (window as unknown as { __bulliDebug: ModelHook }).__bulliDebug.localCarInfo());

    // The local car shows the GLB body; LOD0 is not loaded on the software
    // tier, so the chase camera (~12 m) gets LOD1. None of its materials is a
    // shared template material (paint colour, lamps, ghost and AFK looks)
    await expect.poll(async () => (await debug())?.gltf).toBe(true);
    const car = (await debug())!;
    expect(car).toMatchObject({ carType: 'bulli', lods: [1, 2], lod: 1, sharedMaterials: 0 });
    expect(car.scale).toBeCloseTo(1.15, 5);
    // Sim hull 2.6 x 4.0 m: the scaled T1 is 2.07 x 4.92 x 2.23 m
    expect(car.size![0]).toBeCloseTo(2.07, 1);
    expect(car.size![2]).toBeCloseTo(4.92, 1);
    expect(car.footprint[0]).toBeCloseTo(car.size![0], 5);
    expect(car.nametagHeight).toBeGreaterThan(2.5);
    expect(car.nametagHeight).toBeLessThan(3.5);

    // A car 100 m from the camera switches to LOD2, one 3 m away back to the
    // most detailed loaded LOD; each spawned car has its own materials too
    const snap = await snapshot(player.page);
    const local = snap.local!;
    const far = await player.page.evaluate(({ x, z }) =>
        (window as unknown as { __bulliDebug: ModelHook }).__bulliDebug.spawnCar('bulli', 0x3366aa, x, z, 0, { brake: true }),
    { x: snap.camera.x + 100, z: snap.camera.z });
    expect(far?.gltf).toBe(true);
    await expect.poll(async () => {
        const cars = await player.page.evaluate(() => (window as unknown as { __bulliDebug: ModelHook }).__bulliDebug.carModels());
        return cars.map(c => c.lod).sort();
    }).toEqual([1, 2]);
    const cars = await player.page.evaluate(() => (window as unknown as { __bulliDebug: ModelHook }).__bulliDebug.carModels());
    expect(cars.every(c => c.sharedMaterials === 0)).toBe(true);

    // The other four types are Blender models too, scaled into their unchanged
    // sim hulls (docs/cars.md), each with its own materials
    const expected: Record<string, { scale: number; width: number; length: number }> = {
        beetle: { scale: 1.1, width: 1.69, length: 4.49 },
        pickup: { scale: 1.15, width: 2.01, length: 4.92 },
        sport: { scale: 1.15, width: 1.92, length: 4.61 },
        jeep: { scale: 1.15, width: 1.89, length: 4.35 }
    };
    let offset = 8;
    for (const [type, want] of Object.entries(expected)) {
        const other = await player.page.evaluate(({ t, x, z }) =>
            (window as unknown as { __bulliDebug: ModelHook }).__bulliDebug.spawnCar(t, 0xaa3333, x, z),
        { t: type, x: local.x + offset, z: local.z });
        offset += 6;
        expect(other, type).toMatchObject({ carType: type, gltf: true, sharedMaterials: 0 });
        expect(other!.scale, type).toBeCloseTo(want.scale, 5);
        expect(other!.size![0], type).toBeCloseTo(want.width, 1);
        expect(other!.size![2], type).toBeCloseTo(want.length, 1);
    }
    await player.page.evaluate(() => (window as unknown as { __bulliDebug: ModelHook }).__bulliDebug.clearModels());
    expect(await player.page.evaluate(() => (window as unknown as { __bulliDebug: ModelHook }).__bulliDebug.carModels())).toHaveLength(1);
});
