import { METERS_PER_UNIT, MS_TO_KMH } from '../../shared/constants.js';

// The car's adapter speed (Bulli.speed, LocalVehicle) is in metres per 1/60 s
// tick, like the physics before v2; the speedometer shows it in km/h.
export const ADAPTER_TICKS_PER_SECOND = 60;

export function carSpeedToKmh(speedPerTick: number): number {
    return Math.abs(speedPerTick) * ADAPTER_TICKS_PER_SECOND * METERS_PER_UNIT * MS_TO_KMH;
}

// The dial has 10 tick intervals. Top speeds are 47-55 m/s, the boost adds
// 20 m/s and Turbo + Boost are capped at V_ABS = 85 m/s (306 km/h), so the
// dial ends at 320 km/h.
export const SPEEDO_TICK_INTERVALS = 10;
export const SPEEDO_SCALE_MAX_KMH = 320;

// Fraction of the dial arc to fill for a displayed speed
export function speedoFill(kmh: number, scaleMaxKmh: number = SPEEDO_SCALE_MAX_KMH): number {
    return Math.max(0, Math.min(kmh / scaleMaxKmh, 1));
}
