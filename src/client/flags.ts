// URL feature flags, read once at startup.

function queryFlag(name: string): string | null {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get(name);
}

// ?sandbox=1 opens the offline test pad of the v2 physics instead of the
// city: ramps, walls, cones and dummy cars, no server connection
// (docs/phase-1a-design.md, 12.7). Always runs the v2 physics.
export const SANDBOX = queryFlag('sandbox') === '1';

// The local car drives with the fixed-step v2 simulation in src/shared/sim
// (docs/phase-1a-design.md). ?physics=legacy switches back to the old
// per-frame physics, camera, HUD and controls as an escape hatch until the
// legacy code is deleted; ?physics=v2 is still accepted and changes nothing.
export const PHYSICS_LEGACY = queryFlag('physics') === 'legacy' && !SANDBOX;
export const PHYSICS_V2 = !PHYSICS_LEGACY;

// ?tune=1 loads the lil-gui tuning panel with live telemetry (section 13).
// Only together with the v2 physics; the panel is its own lazy chunk.
export const TUNE_PANEL = queryFlag('tune') === '1' && PHYSICS_V2;
