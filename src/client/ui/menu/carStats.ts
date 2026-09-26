import { VEHICLE_CLASSES } from '../../../shared/sim/vehicleClasses.js';
import type { CarClassId } from '../../../shared/sim/types.js';

// The numbers of a car in the menu (docs/ui.md 4.3): top speed in km/h,
// acceleration as a bar, mass in kg and a line of character. Everything
// comes from the sim's classes (shared/sim/vehicleClasses.ts), nothing is
// copied. A bar shows where the car stands among the five classes, from a
// floor of BAR_FLOOR, so the slowest car does not look empty.

export const BAR_FLOOR = 0.35;

export const CAR_NAMES: Readonly<Record<CarClassId, string>> = {
    bulli: 'Bulli', beetle: 'Beetle', pickup: 'Pickup', sport: '356', jeep: 'Type 181'
};

// From the comments on the classes
const CHARACTER: Readonly<Record<CarClassId, string>> = {
    bulli: 'Balanced, a little playful from the rear engine.',
    beetle: 'Light and quick off the line, likes to drift.',
    pickup: 'Heavy and stable, pushes the others the most.',
    sport: 'Fast and grippy, drifts deep.',
    jeep: 'All-wheel drive, barely slowed off-road.'
};

export interface CarStats {
    name: string;
    character: string;
    /** Top speed (km/h, whole) and its bar (BAR_FLOOR..1) */
    topSpeedKmh: number;
    topSpeedBar: number;
    /** Acceleration (m/s²) and its bar (BAR_FLOOR..1) */
    accel: number;
    accelBar: number;
    /** Mass (kg) */
    mass: number;
}

const ids = Object.keys(VEHICLE_CLASSES) as CarClassId[];

function bar(value: number, values: number[]): number {
    const min = Math.min(...values), max = Math.max(...values);
    return max > min ? BAR_FLOOR + (1 - BAR_FLOOR) * (value - min) / (max - min) : 1;
}

export function carStats(id: CarClassId): CarStats {
    const params = VEHICLE_CLASSES[id];
    return {
        name: CAR_NAMES[id],
        character: CHARACTER[id],
        topSpeedKmh: Math.round(params.topSpeed * 3.6),
        topSpeedBar: bar(params.topSpeed, ids.map(car => VEHICLE_CLASSES[car].topSpeed)),
        accel: params.accel,
        accelBar: bar(params.accel, ids.map(car => VEHICLE_CLASSES[car].accel)),
        mass: params.mass
    };
}

/** What a screen reader hears when the car changes, e.g. "Beetle – 173 km/h, 900 kg". */
export function carAnnouncement(id: CarClassId): string {
    const stats = carStats(id);
    return `${stats.name} – ${stats.topSpeedKmh} km/h, ${stats.mass} kg`;
}
