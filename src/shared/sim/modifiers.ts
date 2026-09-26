// Powerup modifiers (docs/phase-1a-design.md, section 10). The powerup
// timers stay a Party rule outside the sim; each tick the sim only gets
// the active flags and derives the effective params from them.

import { BOGGED_ACCEL, DRAFT_ACCEL, DRAFT_TOP_ADD, LAUNCH_ACCEL } from '../race/rules.js';
import type { VehicleModifiers, VehicleParams } from './types.js';

export const TURBO_TOP_SPEED = 1.3;
export const TURBO_ACCEL = 1.5;
export const MEGA_CONTACT_MASS = 3;
export const MEGA_MASS_RATIO_CAP = 3.5;
export const SHIELD_CONTACT_MASS = 2;

// Writes base + modifiers into out without allocating. scale is the eased
// VehicleState.scale; the collision circles follow it (also while Mega
// shrinks back), the driving behaviour does not. draft is
// VehicleState.draft: the slipstream raises the top speed, since lower
// drag alone would not change it (the drive covers the drag up to vtop),
// and the acceleration (docs/phase-2-design.md, 13). launch and bogged are
// the race start windows (12.2).
export function applyModifiers(base: VehicleParams, mods: VehicleModifiers, scale: number, out: VehicleParams, draft = 0): VehicleParams {
    Object.assign(out, base);
    // Always from the mass, so the tuning panel's mass reaches the contacts
    out.contactMass = base.mass;
    if (mods.turbo) {
        out.topSpeed = base.topSpeed * TURBO_TOP_SPEED;
        out.accel = base.accel * TURBO_ACCEL;
    }
    if (mods.launch) out.accel *= LAUNCH_ACCEL;
    if (mods.bogged) out.accel *= BOGGED_ACCEL;
    if (draft > 0) {
        out.topSpeed += DRAFT_TOP_ADD * draft;
        out.accel *= 1 + DRAFT_ACCEL * draft;
    }
    out.colliderRadius = base.colliderRadius * scale;
    out.colliderOffset = base.colliderOffset * scale;
    if (mods.mega) {
        out.contactMass *= MEGA_CONTACT_MASS;
        out.massRatioCap = MEGA_MASS_RATIO_CAP;
    }
    if (mods.shield) {
        out.contactMass *= SHIELD_CONTACT_MASS;
        out.restitutionWall = 0;
    }
    return out;
}
