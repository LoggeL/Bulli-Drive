// Surface physics table for the driving simulation (pure TS, no map-file
// coupling). Supports all base map surfaces (0..9 from shared/map/types.ts)
// plus snow (10) and ice (11) for alpine/winter maps, compiling identically
// before and after snow/ice are added to shared/map/types.ts.

import { isPaved, SURFACE_GRIP, SURFACE_ROLL } from '../map/types.js';
import type { VehicleParams } from './types.js';

export const SIM_SURFACE_SNOW = 10;
export const SIM_SURFACE_ICE = 11;

export interface SurfacePhysics {
    readonly grip: number;
    readonly roll: number;
    // Multiplier on slip-angle damping and spin guard so ice allows smooth
    // wide slides while staying controllable
    readonly yawDampScale: number;
    // Multiplier on drift boost-meter fill rate (rewarding playful snow/ice slides)
    readonly driftFillScale: number;
    readonly paved: boolean;
}

const DEFAULT_SURFACE: SurfacePhysics = {
    grip: 1.0,
    roll: 0,
    yawDampScale: 1.0,
    driftFillScale: 1.0,
    paved: true
};

const SNOW_SURFACE: SurfacePhysics = {
    grip: 0.65,
    roll: 1.1,
    yawDampScale: 0.85,
    driftFillScale: 1.15,
    paved: false
};

const ICE_SURFACE: SurfacePhysics = {
    grip: 0.35,
    roll: 0.15,
    yawDampScale: 0.45,
    driftFillScale: 1.25,
    paved: false
};

// Pre-allocated base table (indices 0..11) to guarantee zero per-tick allocation
const SURFACE_TABLE: readonly SurfacePhysics[] = (() => {
    const out: SurfacePhysics[] = [];
    for (let id = 0; id < 10; id++) {
        out.push({
            grip: SURFACE_GRIP[id] ?? 1.0,
            roll: SURFACE_ROLL[id] ?? 0,
            yawDampScale: 1.0,
            driftFillScale: 1.0,
            paved: isPaved(id)
        });
    }
    out[SIM_SURFACE_SNOW] = {
        ...SNOW_SURFACE,
        grip: SURFACE_GRIP[SIM_SURFACE_SNOW] ?? SNOW_SURFACE.grip,
        roll: SURFACE_ROLL[SIM_SURFACE_SNOW] ?? SNOW_SURFACE.roll
    };
    out[SIM_SURFACE_ICE] = {
        ...ICE_SURFACE,
        grip: SURFACE_GRIP[SIM_SURFACE_ICE] ?? ICE_SURFACE.grip,
        roll: SURFACE_ROLL[SIM_SURFACE_ICE] ?? ICE_SURFACE.roll
    };
    return out;
})();

/** Physics properties of a surface ID (allocation-free). */
export function surfacePhysics(surface: number): SurfacePhysics {
    if (surface >= 0 && surface < SURFACE_TABLE.length) return SURFACE_TABLE[surface];
    return DEFAULT_SURFACE;
}

/** Effective tyre grip multiplier on `surface` for vehicle params `p`. */
export function surfaceGrip(surface: number, p: VehicleParams): number {
    const props = surfacePhysics(surface);
    return props.paved ? props.grip : props.grip * p.offroadGrip;
}

/** Effective rolling resistance (m/s²) on `surface` for vehicle params `p`. */
export function surfaceRoll(surface: number, p: VehicleParams): number {
    const props = surfacePhysics(surface);
    return props.paved ? 0 : props.roll * p.offroadDrag;
}

/** Yaw assist damping scale on `surface` (1.0 normal, 0.85 snow, 0.45 ice). */
export function surfaceYawDamp(surface: number): number {
    return surfacePhysics(surface).yawDampScale;
}

/** Drift boost fill scale on `surface` (1.0 normal, 1.15 snow, 1.25 ice). */
export function surfaceDriftFill(surface: number): number {
    return surfacePhysics(surface).driftFillScale;
}
