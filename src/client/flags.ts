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
