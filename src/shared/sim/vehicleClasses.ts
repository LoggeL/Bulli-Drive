// The five car classes of the v2 driving simulation and the assist profiles
// (docs/phase-1a-design.md, sections 6.1 and 9). Body sizes come from the
// meshes in client/entities/Bulli.ts; the collision circles are
// r = width/2 - 0.1 and c = length/2 - r.

import { DEG } from './constants.js';
import type { AssistProfile, CarClassId, VehicleParams } from './types.js';

export const CAR_CLASS_IDS: readonly CarClassId[] = ['bulli', 'pickup', 'sport', 'beetle', 'jeep'];

export interface AssistSettings {
    counterSteer: number;     // K_CS
    spinGuardAngle: number;   // β0 (rad)
}

export const ASSIST_PROFILES: Record<AssistProfile, AssistSettings> = {
    standard: { counterSteer: 0.5, spinGuardAngle: 35 * DEG },
    touch: { counterSteer: 0.7, spinGuardAngle: 30 * DEG }
};

// Everything except the assist values, which come from the profile
type ClassParams = Omit<VehicleParams, 'counterSteer' | 'spinGuardAngle'>;

function carClass(p: Omit<ClassParams, 'contactMass' | 'massRatioCap' | 'restitutionWall' | 'jumpSpeed'>): ClassParams {
    return { ...p, contactMass: p.mass, massRatioCap: 1.8, restitutionWall: 0.15, jumpSpeed: 11 };
}

export const VEHICLE_CLASSES: Record<CarClassId, ClassParams> = {
    // Balanced, a little playful from the rear engine
    bulli: carClass({
        mass: 1500, wheelbase: 2.4, cgFront: 0.55, cgHeight: 0.9, yawRadius: 1.35, drive: 'rear',
        topSpeed: 50, accel: 8.5, brakeDecel: 20,
        gripFront: 2.1, gripRear: 2.2, aeroGrip: 0.25,
        slipPeakFront: 7 * DEG, slipPeakRear: 6 * DEG, slideFront: 0.92, slideRear: 0.80,
        handbrakeGrip: 0.45, steerLock: 32 * DEG, steerFalloff: 16, driftFill: 1.0,
        offroadGrip: 0.90, offroadDrag: 0.8, colliderRadius: 1.3, colliderOffset: 0.7
    }),
    // Heavy and stable, pushes the most
    pickup: carClass({
        mass: 2000, wheelbase: 3.2, cgFront: 0.45, cgHeight: 0.8, yawRadius: 1.6, drive: 'rear',
        topSpeed: 47, accel: 8.0, brakeDecel: 18,
        gripFront: 2.0, gripRear: 2.3, aeroGrip: 0.20,
        slipPeakFront: 7.5 * DEG, slipPeakRear: 6 * DEG, slideFront: 0.92, slideRear: 0.85,
        handbrakeGrip: 0.50, steerLock: 30 * DEG, steerFalloff: 16, driftFill: 0.9,
        offroadGrip: 0.92, offroadDrag: 0.6, colliderRadius: 1.4, colliderOffset: 1.1
    }),
    // Fast and grippy, drifts deep
    sport: carClass({
        mass: 1200, wheelbase: 2.8, cgFront: 0.52, cgHeight: 0.5, yawRadius: 1.3, drive: 'rear',
        topSpeed: 55, accel: 10.5, brakeDecel: 24,
        gripFront: 2.5, gripRear: 2.6, aeroGrip: 0.35,
        slipPeakFront: 6 * DEG, slipPeakRear: 5.5 * DEG, slideFront: 0.92, slideRear: 0.80,
        handbrakeGrip: 0.42, steerLock: 31 * DEG, steerFalloff: 17, driftFill: 1.0,
        offroadGrip: 0.85, offroadDrag: 1.0, colliderRadius: 1.2, colliderOffset: 1.05
    }),
    // Light, best acceleration, likes to drift, gets pushed around
    beetle: carClass({
        mass: 900, wheelbase: 2.0, cgFront: 0.58, cgHeight: 0.6, yawRadius: 1.05, drive: 'rear',
        topSpeed: 48, accel: 11.0, brakeDecel: 21,
        gripFront: 2.3, gripRear: 2.3, aeroGrip: 0.25,
        slipPeakFront: 7 * DEG, slipPeakRear: 6 * DEG, slideFront: 0.92, slideRear: 0.75,
        handbrakeGrip: 0.42, steerLock: 34 * DEG, steerFalloff: 15, driftFill: 1.15,
        offroadGrip: 0.90, offroadDrag: 0.8, colliderRadius: 1.1, colliderOffset: 0.65
    }),
    // All-wheel drive, drifts flat, barely slowed off-road
    jeep: carClass({
        mass: 1750, wheelbase: 2.8, cgFront: 0.48, cgHeight: 0.9, yawRadius: 1.4, drive: 'all',
        topSpeed: 49, accel: 9.5, brakeDecel: 19,
        gripFront: 2.1, gripRear: 2.2, aeroGrip: 0.20,
        slipPeakFront: 9 * DEG, slipPeakRear: 8 * DEG, slideFront: 0.94, slideRear: 0.85,
        handbrakeGrip: 0.50, steerLock: 32 * DEG, steerFalloff: 16, driftFill: 0.9,
        offroadGrip: 1.00, offroadDrag: 0.2, colliderRadius: 1.4, colliderOffset: 0.7
    })
};

export function isCarClassId(value: unknown): value is CarClassId {
    return typeof value === 'string' && (CAR_CLASS_IDS as readonly string[]).includes(value);
}

// Fresh base params for a class and assist profile (SimCar.base)
export function createVehicleParams(classId: CarClassId, profile: AssistProfile = 'standard'): VehicleParams {
    return { ...VEHICLE_CLASSES[classId], ...ASSIST_PROFILES[profile] };
}
