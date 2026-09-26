import { models, whenModelsReady } from '../assets/gameModels.js';
import { whenWorldTexturesLoaded, worldTextureProgress } from '../world/textures.js';
import { whenKitReady } from '../world/mapScene.js';
import { loadProgress } from './loadingScreen.js';

// The start button waits for the world textures and the car models (loaded
// and compiled), so nobody starts driving through an untextured world in a
// placeholder box car on a slow connection. The button shows the progress;
// after ASSET_WAIT_MS the game starts anyway (placeholders are neutral, and
// the cars swap to their models once those arrive).

export const ASSET_WAIT_MS = 20_000;

let ready = false;

/** Resolves when the world textures and car models are in (or the wait timed out). */
export async function waitForGameAssets(button: HTMLElement | null, timeoutMs = ASSET_WAIT_MS): Promise<'ready' | 'timeout'> {
    if (ready) return 'ready';
    const assets = Promise.all([whenWorldTexturesLoaded(), whenModelsReady(), whenKitReady()]).then(() => { ready = true; });
    const label = button?.querySelector('.btn-label') as HTMLElement | null;
    const original = label?.textContent ?? '';
    const show = () => {
        if (!label) return;
        // Every step of the loader and the menu (the other cars) from the
        // loading screen's progress; without one, textures three quarters
        // and the models the rest
        const progress = loadProgress();
        const modelShare = models.status === 'ready' || models.status === 'failed' ? 1 : 0;
        const percent = progress ? progress.percent('menu') : Math.round((worldTextureProgress() * 0.75 + modelShare * 0.25) * 100);
        label.textContent = `LOADING ${Math.min(99, percent)}%`;
    };
    // Only show the loading state when there is something to wait for
    const quick = await Promise.race([assets.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 50))]);
    if (quick) return 'ready';
    button?.classList.add('loading');
    button?.setAttribute('aria-busy', 'true');
    show();
    const timer = setInterval(show, 200);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
        assets.then(() => 'ready' as const),
        new Promise<'timeout'>(resolve => { timeout = setTimeout(() => resolve('timeout'), timeoutMs); })
    ]);
    clearTimeout(timeout);
    clearInterval(timer);
    if (label) label.textContent = original;
    button?.classList.remove('loading');
    button?.removeAttribute('aria-busy');
    if (outcome === 'timeout') console.warn('[assets] starting without all world textures and car models');
    return outcome;
}
