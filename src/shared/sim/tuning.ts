// Live tuning of the v2 sim (docs/phase-1a-design.md, section 13). The
// global SIM_TUNING, the five class parameter sets and the assist profiles
// are plain mutable objects; the lil-gui panel in the sandbox writes into
// them. This module keeps the shipped defaults, exports the changed values
// as JSON, imports them back and resets everything. The server never tunes.

import { SIM_TUNING, SIM_TUNING_DEFAULTS, type SimTuning } from './constants.js';
import type { AssistProfile, CarClassId, SimCar } from './types.js';
import {
    ASSIST_PROFILES, CAR_CLASS_IDS, VEHICLE_CLASSES, createVehicleParams,
    type AssistSettings, type ClassParams
} from './vehicleClasses.js';

export const TUNING_FORMAT = 1;

const PROFILE_IDS: readonly AssistProfile[] = ['standard', 'touch'];
const DRIVE_LAYOUTS: readonly string[] = ['rear', 'all'];

const CLASS_DEFAULTS = Object.fromEntries(
    CAR_CLASS_IDS.map(id => [id, Object.freeze({ ...VEHICLE_CLASSES[id] })])
) as Record<CarClassId, Readonly<ClassParams>>;
const PROFILE_DEFAULTS = Object.fromEntries(
    PROFILE_IDS.map(id => [id, Object.freeze({ ...ASSIST_PROFILES[id] })])
) as Record<AssistProfile, Readonly<AssistSettings>>;

// Only the values that differ from the defaults. Angles are in radians,
// like everywhere in the sim.
export interface TuningSnapshot {
    format: number;
    global: Partial<Record<keyof SimTuning, number>>;
    classes: Partial<Record<CarClassId, Partial<ClassParams>>>;
    profiles: Partial<Record<AssistProfile, Partial<AssistSettings>>>;
}

export function classDefaults(classId: CarClassId): Readonly<ClassParams> {
    return CLASS_DEFAULTS[classId];
}

export function profileDefaults(profile: AssistProfile): Readonly<AssistSettings> {
    return PROFILE_DEFAULTS[profile];
}

function changed<T extends object>(current: T, defaults: Readonly<T>): Partial<T> | null {
    const diff: Partial<T> = {};
    let any = false;
    for (const key of Object.keys(defaults) as (keyof T)[]) {
        if (current[key] !== defaults[key]) {
            diff[key] = current[key];
            any = true;
        }
    }
    return any ? diff : null;
}

export function exportTuning(): TuningSnapshot {
    const snapshot: TuningSnapshot = { format: TUNING_FORMAT, global: {}, classes: {}, profiles: {} };
    snapshot.global = changed(SIM_TUNING, SIM_TUNING_DEFAULTS) ?? {};
    for (const id of CAR_CLASS_IDS) {
        const diff = changed(VEHICLE_CLASSES[id], CLASS_DEFAULTS[id]);
        if (diff) snapshot.classes[id] = diff;
    }
    for (const id of PROFILE_IDS) {
        const diff = changed(ASSIST_PROFILES[id], PROFILE_DEFAULTS[id]);
        if (diff) snapshot.profiles[id] = diff;
    }
    return snapshot;
}

export function resetTuning(): void {
    Object.assign(SIM_TUNING, SIM_TUNING_DEFAULTS);
    for (const id of CAR_CLASS_IDS) Object.assign(VEHICLE_CLASSES[id], CLASS_DEFAULTS[id]);
    for (const id of PROFILE_IDS) Object.assign(ASSIST_PROFILES[id], PROFILE_DEFAULTS[id]);
}

export function tuningIsDefault(): boolean {
    const snapshot = exportTuning();
    return Object.keys(snapshot.global).length === 0
        && Object.keys(snapshot.classes).length === 0
        && Object.keys(snapshot.profiles).length === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Checks one group of values against its defaults: known keys only, and
// each value of the default's type (numbers finite, drive a known layout)
function checkValues(where: string, values: unknown, defaults: object, errors: string[]): void {
    if (!isRecord(values)) {
        errors.push(`${where} is not an object`);
        return;
    }
    const known = defaults as Record<string, unknown>;
    for (const [key, value] of Object.entries(values)) {
        if (!(key in known)) errors.push(`${where}.${key} is unknown`);
        else if (key === 'drive') {
            if (typeof value !== 'string' || !DRIVE_LAYOUTS.includes(value)) errors.push(`${where}.drive must be 'rear' or 'all'`);
        } else if (typeof value !== 'number' || !Number.isFinite(value)) {
            errors.push(`${where}.${key} must be a finite number`);
        }
    }
}

function checkGroups(where: string, groups: unknown, ids: readonly string[], defaults: Record<string, object>, errors: string[]): void {
    if (groups === undefined) return;
    if (!isRecord(groups)) {
        errors.push(`${where} is not an object`);
        return;
    }
    for (const [id, values] of Object.entries(groups)) {
        if (!ids.includes(id)) errors.push(`${where}.${id} is unknown`);
        else checkValues(`${where}.${id}`, values, defaults[id], errors);
    }
}

/**
 * Replaces the whole tuning with the defaults plus the snapshot's values
 * (the output of exportTuning, as an object or JSON text). Checks
 * everything first and throws without changing anything on an error.
 */
export function importTuning(input: unknown): void {
    let data = input;
    if (typeof input === 'string') {
        try {
            data = JSON.parse(input);
        } catch {
            throw new Error('tuning is not valid JSON');
        }
    }
    const errors: string[] = [];
    if (!isRecord(data)) throw new Error('tuning is not an object');
    if (data.format !== TUNING_FORMAT) errors.push(`format must be ${TUNING_FORMAT}`);
    for (const key of Object.keys(data)) {
        if (!['format', 'global', 'classes', 'profiles'].includes(key)) errors.push(`${key} is unknown`);
    }
    if (data.global !== undefined) checkValues('global', data.global, SIM_TUNING_DEFAULTS, errors);
    checkGroups('classes', data.classes, CAR_CLASS_IDS, CLASS_DEFAULTS, errors);
    checkGroups('profiles', data.profiles, PROFILE_IDS, PROFILE_DEFAULTS, errors);
    if (errors.length > 0) throw new Error(`invalid tuning: ${errors.join('; ')}`);

    const snapshot = data as unknown as Partial<TuningSnapshot>;
    resetTuning();
    Object.assign(SIM_TUNING, snapshot.global ?? {});
    for (const [id, values] of Object.entries(snapshot.classes ?? {})) {
        Object.assign(VEHICLE_CLASSES[id as CarClassId], values);
    }
    for (const [id, values] of Object.entries(snapshot.profiles ?? {})) {
        Object.assign(ASSIST_PROFILES[id as AssistProfile], values);
    }
}

// Rebuilds a live car's base params from the current class and profile
// values, so a tuning change reaches cars that already exist
export function refreshCarParams(car: SimCar, classId: CarClassId, profile: AssistProfile): void {
    Object.assign(car.base, createVehicleParams(classId, profile));
}
