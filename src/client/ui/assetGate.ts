import { models, whenModelsReady } from '../assets/gameModels.js';
import { whenWorldTexturesLoaded, worldTextureProgress } from '../world/textures.js';
import { whenKitReady } from '../world/mapScene.js';
import { loadProgress } from './loadingScreen.js';

// The start waits for the world textures, the building kit and the car
// models (loaded and compiled), so nobody starts driving through an
// untextured world in a placeholder box car on a slow connection. The
// menu's DRIVE button shows the progress (ui/menu/menu.ts); after
// ASSET_WAIT_MS the game starts anyway (placeholders are neutral, and the
// cars swap to their models once those arrive).

export const ASSET_WAIT_MS = 20_000;

let ready = false;
let assets: Promise<void> | null = null;

function whenAssets(): Promise<void> {
    assets ??= Promise.all([whenWorldTexturesLoaded(), whenModelsReady(), whenKitReady()]).then(() => { ready = true; });
    return assets;
}

/** Whether everything the start waits for is in. */
export function gameAssetsReady(): boolean {
    void whenAssets();
    return ready;
}

/**
 * How far the start's assets are (0..100): the loading screen's progress
 * of the loader and menu phases (the other cars), or without it the
 * textures three quarters and the models the rest.
 */
export function gameAssetsPercent(): number {
    if (gameAssetsReady()) return 100;
    const progress = loadProgress();
    if (progress) return Math.min(99, progress.percent('menu'));
    const modelShare = models.status === 'ready' || models.status === 'failed' ? 1 : 0;
    return Math.min(99, Math.round((worldTextureProgress() * 0.75 + modelShare * 0.25) * 100));
}

/** Resolves when the world textures and car models are in (or the wait timed out). */
export async function waitForGameAssets(timeoutMs = ASSET_WAIT_MS): Promise<'ready' | 'timeout'> {
    if (gameAssetsReady()) return 'ready';
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
        whenAssets().then(() => 'ready' as const),
        new Promise<'timeout'>(resolve => { timeout = setTimeout(() => resolve('timeout'), timeoutMs); })
    ]);
    clearTimeout(timeout);
    if (outcome === 'timeout') console.warn('[assets] starting without all world textures and car models');
    return outcome;
}
