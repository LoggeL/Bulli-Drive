// URL feature flags, read once at startup. The pure functions take the
// query string (location.search), so the tests can check the gates without
// a page.

function pageSearch(): string {
    return typeof window === 'undefined' ? '' : window.location.search;
}

function queryFlag(name: string, search = pageSearch()): string | null {
    return new URLSearchParams(search).get(name);
}

// ?sandbox=1 opens the offline test pad of the v2 physics instead of the
// city: ramps, walls, cones and dummy cars, no server connection
// (docs/phase-1a-design.md, 12.7). Always runs the v2 physics.
export function isSandbox(search: string): boolean {
    return queryFlag('sandbox', search) === '1';
}

// ?tune=1 loads the lil-gui tuning panel with live telemetry
// (docs/phase-1a-design.md, 13), its own lazy chunk. Online the server
// simulates with the default tuning, so the panel only loads in the
// offline sandbox (docs/phase-1b-design.md, 7); elsewhere the page shows
// a short hint instead.
export function isTuneRequested(search: string): boolean {
    return queryFlag('tune', search) === '1';
}

export function isTunePanelEnabled(search: string): boolean {
    return isTuneRequested(search) && isSandbox(search);
}

// ?e2e=1 installs the test hook (e2eHook.ts); regular players never get it
export function isE2EEnabled(search: string): boolean {
    return queryFlag('e2e', search) === '1';
}

// ?e2e=1&drawfps=N (tests only): the page draws at most N frames a second,
// while the game, the netcode and the HUD still run every frame. Two pages
// with software WebGL on one CI runner otherwise fall to a few frames a
// second, too few to drive (tests/e2e/two-players.spec.ts). 0 = no limit.
export function e2eDrawIntervalMs(search: string): number {
    if (!isE2EEnabled(search)) return 0;
    const fps = Number(queryFlag('drawfps', search));
    return Number.isFinite(fps) && fps > 0 ? 1000 / fps : 0;
}

// ?debug=load (also in a comma list): the loading screen logs when each of
// its steps starts and ends (ui/loadingScreen.ts), to calibrate the weights
export function isLoadDebugEnabled(search: string): boolean {
    return new URLSearchParams(search).getAll('debug').flatMap(value => value.split(',')).includes('load');
}

export const SANDBOX = isSandbox(pageSearch());
export const LOAD_DEBUG = isLoadDebugEnabled(pageSearch());
export const TUNE_REQUESTED = isTuneRequested(pageSearch());
export const TUNE_PANEL = isTunePanelEnabled(pageSearch());
export const E2E_DRAW_INTERVAL_MS = e2eDrawIntervalMs(pageSearch());
