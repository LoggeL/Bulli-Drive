// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FetchTally } from '../../src/client/assets/fetchTally.js';
import { createLoadProgress, DESKTOP_LOAD_TASKS, PHONE_LOAD_TASKS } from '../../src/client/ui/loadProgress.js';

// The page's loaders as the loading screen's steps (src/client/assets/
// loadSteps.ts, docs/ui.md 3.2) and the start's wait on them
// (src/client/ui/assetGate.ts): the loaders are stand-ins the test moves,
// the steps and their fractions are the real model's. Values by hand.

const polls: Array<() => void> = [];
const loaders = vi.hoisted(() => {
    function gate() {
        let open!: () => void;
        const promise = new Promise<void>(resolve => { open = resolve; });
        return { promise, open };
    }
    return {
        gate,
        models: { status: 'loading' as string, files: new Map<string, [number, number]>() },
        modelsReady: gate(),
        texturesLoaded: gate(),
        kitReady: gate(),
        skyReady: gate(),
        textureStats: { requested: 0, loaded: 0, failed: 0 },
        progress: null as unknown
    };
});
const tallies = { kit: new FetchTally(), textures: new FetchTally() };

vi.mock('../../src/client/ui/loadingScreen.js', () => ({
    onLoadPoll: (poll: () => void) => polls.push(poll),
    loadProgress: () => loaders.progress
}));
vi.mock('../../src/client/assets/gameModels.js', () => ({
    models: {
        get status() { return loaders.models.status; },
        fileProgress: (ids: string[]) => ids.reduce<[number, number]>((sum, id) => {
            const [done, total] = loaders.models.files.get(id) ?? [0, 0];
            return [sum[0] + done, sum[1] + total];
        }, [0, 0])
    },
    whenModelsReady: () => loaders.modelsReady.promise
}));
vi.mock('../../src/client/world/textures.js', () => ({
    textureStats: loaders.textureStats,
    get textureTally() { return tallies.textures; },
    whenWorldTexturesLoaded: () => loaders.texturesLoaded.promise,
    worldTextureProgress: () => loaders.textureStats.requested
        ? (loaders.textureStats.loaded + loaders.textureStats.failed) / loaders.textureStats.requested : 1
}));
vi.mock('../../src/client/world/mapScene.js', () => ({
    kitProgress: () => tallies.kit,
    whenKitReady: () => loaders.kitReady.promise,
    updateMapScene: () => undefined
}));
vi.mock('../../src/client/world/palms.js', () => ({ updatePalms: () => undefined }));
vi.mock('../../src/client/vehicle/CarModel.js', () => ({ updateCarModels: () => undefined }));
vi.mock('../../src/client/render/lighting.js', () => ({ whenSkyReady: () => loaders.skyReady.promise }));

const clock = { now: () => 0 };
const poll = () => polls.forEach(fn => fn());
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
// The page as the steps see it (renderer, scene and camera only pass through)
const env = (tier: string) => ({ tier, renderer: { compileAsync: vi.fn(async () => undefined) }, scene: {}, camera: {}, carType: 'beetle' });

beforeEach(() => {
    vi.resetModules();
    polls.length = 0;
    loaders.models.status = 'loading';
    loaders.models.files.clear();
    Object.assign(loaders.textureStats, { requested: 0, loaded: 0, failed: 0 });
    for (const key of ['modelsReady', 'texturesLoaded', 'kitReady', 'skyReady'] as const) loaders[key] = loaders.gate();
    tallies.kit = new FetchTally();
    tallies.textures = new FetchTally();
    loaders.progress = null;
});

afterEach(() => {
    vi.useRealTimers();
});

describe('the load steps', () => {
    it('counts the chosen car for the loader, the other four for the menu, and skips the HDRI on phones', async () => {
        const { trackLoadSteps } = await import('../../src/client/assets/loadSteps.js');
        const progress = createLoadProgress(PHONE_LOAD_TASKS, clock);
        trackLoadSteps(progress, env('mobile') as never);
        expect(progress.task('hdri')).toBeUndefined();
        // The Beetle, driven last: 1 of its 4 files
        loaders.models.files.set('beetle', [1, 4]);
        loaders.models.files.set('bulli', [2, 4]);
        loaders.models.files.set('sport', [2, 4]);
        poll();
        expect(progress.task('car')!.fraction).toBeCloseTo(0.25, 12);
        expect(progress.task('car')!.count).toEqual([1, 4]);
        // The others' files are 0.8 of their step (the compile is the rest): 0.8 * 4 / 8
        expect(progress.task('cars')!.fraction).toBeCloseTo(0.4, 12);
        loaders.models.files.set('beetle', [4, 4]);
        poll();
        expect(progress.task('car')!.state).toBe('done');
    });

    it('lets the loader go on without the car when the models failed', async () => {
        const { trackLoadSteps } = await import('../../src/client/assets/loadSteps.js');
        const progress = createLoadProgress(DESKTOP_LOAD_TASKS, clock);
        trackLoadSteps(progress, env('desktop') as never);
        expect(progress.task('hdri')!.state).toBe('running');
        loaders.models.status = 'failed';
        poll();
        expect(progress.task('car')!.state).toBe('done');
    });

    it('moves the kit with its bytes, and counts its files as they come in', async () => {
        const { trackLoadSteps } = await import('../../src/client/assets/loadSteps.js');
        const progress = createLoadProgress(PHONE_LOAD_TASKS, clock);
        trackLoadSteps(progress, env('mobile') as never);
        tallies.kit.expect('kit_pier.glb', 100);
        tallies.kit.expect('kit_atlas_albedo.ktx2', 300);
        tallies.kit.listener('kit_pier.glb')({ loaded: 100, total: 100, lengthComputable: true } as ProgressEvent);
        tallies.kit.progress('kit_atlas_albedo.ktx2', 100);
        poll();
        // 200 of 400 bytes, 0.9 of the step (the parse is the rest)
        expect(progress.task('kit')!.fraction).toBeCloseTo(0.45, 12);
        expect(progress.status()).toBe('Loading the buildings 1/2');
        loaders.kitReady.open();
        await settle();
        expect(progress.task('kit')!.state).toBe('done');
    });

    it('moves the textures with their bytes and their uploads, and compiles the first view once textures, kit and car are in', async () => {
        vi.useFakeTimers();
        const { mapWorldBuilt } = await import('../../src/client/assets/loadSteps.js');
        const progress = createLoadProgress(PHONE_LOAD_TASKS, clock);
        const pageEnv = env('mobile');
        // Four textures asked for, two sized by the manifest so far, one of
        // them fetched; two uploaded (the counters run apart in the test only)
        Object.assign(loaders.textureStats, { requested: 4, loaded: 2, failed: 0 });
        tallies.textures.expect('a', 100);
        tallies.textures.expect('b', 100);
        tallies.textures.fetched('a');
        mapWorldBuilt(progress, pageEnv as never);
        expect(progress.task('map')!.state).toBe('done');
        // Bytes: 100 of 200 sized, 2 of 4 sized: 0.25; uploads 2 of 4: 0.5 -> 0.8 * 0.25 + 0.2 * 0.5
        expect(progress.task('textures')!.fraction).toBeCloseTo(0.3, 12);
        expect(progress.task('textures')!.count).toEqual([1, 4]);
        expect(pageEnv.renderer.compileAsync).not.toHaveBeenCalled();
        loaders.texturesLoaded.open();
        loaders.kitReady.open();
        progress.done('car');
        await vi.advanceTimersByTimeAsync(200);
        expect(pageEnv.renderer.compileAsync).toHaveBeenCalledTimes(1);
        expect(progress.task('warmup')!.state).toBe('done');
        expect(progress.task('textures')!.state).toBe('done');
    });

    it('gives the loader 20 s after the world is built, then lets it go', async () => {
        vi.useFakeTimers();
        const { mapWorldBuilt } = await import('../../src/client/assets/loadSteps.js');
        const progress = createLoadProgress(PHONE_LOAD_TASKS, clock);
        mapWorldBuilt(progress, env('mobile') as never);
        let gone = false;
        void progress.whenPhase('loader').then(() => { gone = true; });
        await vi.advanceTimersByTimeAsync(19_999);
        expect(gone).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(gone).toBe(true);
    });
});

describe('the start\'s wait on the assets', () => {
    it('shows the loading screen\'s progress of the loader and menu phases, 100 once all is in', async () => {
        const gate = await import('../../src/client/ui/assetGate.js');
        const progress = createLoadProgress(PHONE_LOAD_TASKS, clock);
        loaders.progress = progress;
        for (const id of ['code', 'connect', 'map', 'textures', 'kit', 'car', 'warmup'] as const) progress.done(id);
        // 95 of 100 weight done, the other cars half: 97.5 -> 97
        progress.report('cars', 0.5);
        expect(gate.gameAssetsPercent()).toBe(97);
        expect(gate.gameAssetsReady()).toBe(false);
        loaders.texturesLoaded.open();
        loaders.modelsReady.open();
        loaders.kitReady.open();
        await settle();
        expect(gate.gameAssetsReady()).toBe(true);
        expect(gate.gameAssetsPercent()).toBe(100);
    });

    it('without the loading screen: the textures three quarters, the models the rest', async () => {
        const gate = await import('../../src/client/ui/assetGate.js');
        Object.assign(loaders.textureStats, { requested: 4, loaded: 2, failed: 0 });
        expect(gate.gameAssetsPercent()).toBe(38);
        loaders.models.status = 'ready';
        expect(gate.gameAssetsPercent()).toBe(63);
    });
});
