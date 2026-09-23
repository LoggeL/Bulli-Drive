// URL feature flags, read once at startup.

function queryFlag(name: string): string | null {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get(name);
}

// ?physics=v2 drives the local car with the fixed-step v2 simulation in
// src/shared/sim (docs/phase-1a-design.md). Without it the game behaves
// exactly as before.
export const PHYSICS_V2 = queryFlag('physics') === 'v2';
