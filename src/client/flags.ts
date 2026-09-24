// URL feature flags, read once at startup.

function queryFlag(name: string): string | null {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get(name);
}

// ?sandbox=1 opens the offline test pad of the v2 physics instead of the
// city: ramps, walls, cones and dummy cars, no server connection
// (docs/phase-1a-design.md, 12.7). Always runs the v2 physics.
export const SANDBOX = queryFlag('sandbox') === '1';

// ?tune=1 loads the lil-gui tuning panel with live telemetry
// (docs/phase-1a-design.md, 13), its own lazy chunk. Online the server
// simulates with the default tuning, so the panel only loads in the
// offline sandbox (docs/phase-1b-design.md, 7); elsewhere the page shows
// a short hint instead.
export const TUNE_REQUESTED = queryFlag('tune') === '1';
export const TUNE_PANEL = TUNE_REQUESTED && SANDBOX;

// ?e2e=1&drawfps=N (tests only): the page draws at most N frames a second,
// while the game, the netcode and the HUD still run every frame. Two pages
// with software WebGL on one CI runner otherwise fall to a few frames a
// second, too few to drive (tests/e2e/net-contact.spec.ts). 0 = no limit.
function e2eDrawIntervalMs(): number {
    if (queryFlag('e2e') !== '1') return 0;
    const fps = Number(queryFlag('drawfps'));
    return Number.isFinite(fps) && fps > 0 ? 1000 / fps : 0;
}
export const E2E_DRAW_INTERVAL_MS = e2eDrawIntervalMs();
