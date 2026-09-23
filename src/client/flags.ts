// URL feature flags, read once at startup.

function queryFlag(name: string): string | null {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get(name);
}

// ?sandbox=1 opens the offline test pad of the v2 physics instead of the
// city: ramps, walls, cones and dummy cars, no server connection
// (docs/phase-1a-design.md, 12.7). Implies ?physics=v2.
export const SANDBOX = queryFlag('sandbox') === '1';

// ?physics=v2 drives the local car with the fixed-step v2 simulation in
// src/shared/sim (docs/phase-1a-design.md). Without it the game behaves
// exactly as before.
export const PHYSICS_V2 = queryFlag('physics') === 'v2' || SANDBOX;

// ?tune=1 loads the lil-gui tuning panel with live telemetry (section 13).
// Only together with the v2 physics; the panel is its own lazy chunk.
export const TUNE_PANEL = queryFlag('tune') === '1' && PHYSICS_V2;
