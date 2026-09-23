import {
    LEGACY_CAR_MAX_SPEED,
    LEGACY_SPEED_TICKS_PER_SECOND,
    METERS_PER_UNIT,
    MS_TO_KMH,
    SPEED_BOOST_FACTOR
} from '../../shared/constants.js';

// Real speed of the legacy car (units per 1/60 s tick, see constants.ts) in km/h.
export function carSpeedToKmh(speedPerTick: number): number {
    return Math.abs(speedPerTick) * LEGACY_SPEED_TICKS_PER_SECOND * METERS_PER_UNIT * MS_TO_KMH;
}

export const TOP_SPEED_KMH = carSpeedToKmh(LEGACY_CAR_MAX_SPEED);
export const TURBO_TOP_SPEED_KMH = carSpeedToKmh(LEGACY_CAR_MAX_SPEED * SPEED_BOOST_FACTOR);

// The dial has 10 tick intervals; its end is the Turbo top speed rounded up
// to a whole 40 km/h per interval, so even a boosted car stays on the scale.
export const SPEEDO_TICK_INTERVALS = 10;
export const SPEEDO_SCALE_MAX_KMH = Math.ceil(TURBO_TOP_SPEED_KMH / 40) * 40;

// Fraction of the dial arc to fill for a displayed speed
export function speedoFill(kmh: number): number {
    return Math.max(0, Math.min(kmh / SPEEDO_SCALE_MAX_KMH, 1));
}
