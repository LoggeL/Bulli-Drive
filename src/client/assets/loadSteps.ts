import type * as THREE from 'three';
import type { LoadProgress } from '../ui/loadProgress.js';
import { onLoadPoll } from '../ui/loadingScreen.js';
import { models, whenModelsReady } from './gameModels.js';
import { textureStats, textureTally, whenWorldTexturesLoaded } from '../world/textures.js';
import { kitProgress, updateMapScene, whenKitReady } from '../world/mapScene.js';
import { updatePalms } from '../world/palms.js';
import { updateCarModels } from '../vehicle/CarModel.js';
import { whenSkyReady } from '../render/lighting.js';
import { ASSET_WAIT_MS } from '../ui/assetGate.js';

// Wires the page's loaders to the loading screen's steps (docs/ui.md 3.2).
// The connection and the map report from network/websocket.ts; everything
// else from here: world textures (once the map's world asks for them) and
// the building kit (GLBs and atlas), both by the bytes that are in and
// counted per file fetched (assets/fetchTally.ts), the chosen car's model
// files and the other cars' (the menu phase), the HDRI (desktop tier) and
// the shader warmup for the first frame.

export interface LoadStepEnv {
    tier: string;
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.Camera;
    /** The car the player drove last (the menu shows it first) */
    carType: string;
}

const CAR_TYPES = ['bulli', 'beetle', 'pickup', 'sport', 'jeep'];
// Shares of the download in the kit's and the textures' steps (the rest:
// parsing, transcoding and uploading after the last byte)
const KIT_FETCH_SHARE = 0.9;
const TEXTURE_FETCH_SHARE = 0.8;

export function trackLoadSteps(progress: LoadProgress, env: LoadStepEnv): void {
    // Building kit: starts with the renderer (main.ts)
    progress.start('kit');
    onLoadPoll(() => {
        // By the bytes that are in; the parse after the last byte is the rest
        const tally = kitProgress();
        const [fetched, total] = tally.count();
        if (total > 0) progress.report('kit', KIT_FETCH_SHARE * tally.fraction(), [fetched, total]);
    });
    void whenKitReady().then(() => progress.done('kit'));

    // Car models: the chosen one for the loader, the other four for the menu
    const car = CAR_TYPES.includes(env.carType) ? env.carType : 'bulli';
    const others = CAR_TYPES.filter(type => type !== car);
    progress.start('car');
    progress.start('cars');
    onLoadPoll(() => {
        const [carDone, carTotal] = models.fileProgress([car]);
        if (carTotal > 0) {
            progress.report('car', carDone / carTotal, [carDone, carTotal]);
            if (carDone === carTotal) progress.done('car');
        }
        // The files are most of it; the shader warmup of all models follows
        const [othersDone, othersTotal] = models.fileProgress(others);
        if (othersTotal > 0) progress.report('cars', 0.8 * othersDone / othersTotal, [othersDone, othersTotal]);
        if (models.status === 'failed') progress.done('car');
    });
    void whenModelsReady().then(() => {
        progress.done('car');
        progress.done('cars');
    });

    // The HDRI sky (desktop tier only; the others light from the procedural sky)
    if (env.tier === 'desktop') {
        progress.start('hdri');
        void whenSkyReady().then(() => progress.done('hdri'), () => progress.done('hdri'));
    } else {
        progress.skip('hdri');
    }
}

/**
 * The map's world is built (network/websocket.ts): its textures are all
 * asked for now, so they count from here; the shaders compile once the
 * textures, the kit and the car are in. The loader waits at most
 * ASSET_WAIT_MS for them, then the rest goes on behind the menu.
 */
export function mapWorldBuilt(progress: LoadProgress, env: Pick<LoadStepEnv, 'renderer' | 'scene' | 'camera'>): void {
    progress.done('map');
    progress.start('textures');
    const report = () => {
        const { requested, loaded, failed } = textureStats;
        if (requested === 0) return;
        // The bytes that are in (the files the manifest sized so far), then
        // the transcode and upload of each; the counter goes by the files fetched
        const [fetched, sized] = textureTally.count();
        const bytes = textureTally.fraction() * sized / requested;
        progress.report('textures', TEXTURE_FETCH_SHARE * bytes + (1 - TEXTURE_FETCH_SHARE) * (loaded + failed) / requested, [fetched, requested]);
    };
    report();
    onLoadPoll(report);
    const textures = whenWorldTexturesLoaded().then(() => {
        report();
        progress.done('textures');
    });
    const carIn = new Promise<void>(resolve => {
        const check = () => {
            const state = progress.task('car')?.state;
            if (state === 'done' || state === 'timedOut') resolve();
            else window.setTimeout(check, 100);
        };
        check();
    });
    void Promise.all([textures, whenKitReady(), carIn]).then(async () => {
        progress.start('warmup');
        try {
            // The first view as the menu will draw it (the showroom has the
            // camera already): terrain rings, kit cells, palms and car LODs
            // for it, so the warmup compiles what that frame shows
            updateMapScene(env.camera);
            updatePalms(env.camera);
            updateCarModels(env.camera, 0);
            await env.renderer.compileAsync(env.scene, env.camera);
        } catch (error) {
            console.warn('[load] shader warmup failed', error);
        }
        progress.done('warmup');
    });
    window.setTimeout(() => progress.expire('loader'), ASSET_WAIT_MS);
}
