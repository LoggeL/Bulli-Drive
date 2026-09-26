import type * as THREE from 'three';
import type { LoadProgress } from '../ui/loadProgress.js';
import { onLoadPoll } from '../ui/loadingScreen.js';
import { models, whenModelsReady } from './gameModels.js';
import { textureStats, whenWorldTexturesLoaded } from '../world/textures.js';
import { kitProgress, whenKitReady } from '../world/mapScene.js';
import { whenSkyReady } from '../render/lighting.js';
import { ASSET_WAIT_MS } from '../ui/assetGate.js';

// Wires the page's loaders to the loading screen's steps (docs/ui.md 3.2).
// The connection and the map report from network/websocket.ts; everything
// else from here: world textures (counted once the map's world asks for
// them), the building kit (per group file), the chosen car's model files
// and the other cars' (the menu phase), the HDRI (desktop tier) and the
// shader warmup for the first frame.

export interface LoadStepEnv {
    tier: string;
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.Camera;
    /** The car the player drove last (the menu shows it first) */
    carType: string;
}

const CAR_TYPES = ['bulli', 'beetle', 'pickup', 'sport', 'jeep'];

export function trackLoadSteps(progress: LoadProgress, env: LoadStepEnv): void {
    // Building kit: starts with the renderer (main.ts)
    progress.start('kit');
    onLoadPoll(() => {
        const [settled, total] = kitProgress();
        if (total > 0) progress.report('kit', settled / total, [settled, total]);
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
        if (requested > 0) progress.report('textures', (loaded + failed) / requested, [loaded + failed, requested]);
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
            await env.renderer.compileAsync(env.scene, env.camera);
        } catch (error) {
            console.warn('[load] shader warmup failed', error);
        }
        progress.done('warmup');
    });
    window.setTimeout(() => progress.expire('loader'), ASSET_WAIT_MS);
}
