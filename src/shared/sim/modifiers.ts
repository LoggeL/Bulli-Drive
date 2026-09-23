// Powerup modifiers (docs/phase-1a-design.md, section 10). The powerup
// timers stay a Party rule outside the sim; each tick the sim only gets
// the active flags and derives the effective params from them.

import type { VehicleModifiers, VehicleParams } from './types.js';

export const TURBO_TOP_SPEED = 1.3;
export const TURBO_ACCEL = 1.5;
export const SUPER_JUMP_SPEED = 20;       // 10 m apex, 2.0 s flight
export const MEGA_CONTACT_MASS = 3;
export const MEGA_MASS_RATIO_CAP = 3.5;
export const SHIELD_CONTACT_MASS = 2;

// Writes base + modifiers into out without allocating. scale is the eased
// VehicleState.scale; the collision circles follow it (also while Mega
// shrinks back), the driving behaviour does not.
export function applyModifiers(base: VehicleParams, mods: VehicleModifiers, scale: number, out: VehicleParams): VehicleParams {
    Object.assign(out, base);
    // Always from the mass, so the tuning panel's mass reaches the contacts
    out.contactMass = base.mass;
    if (mods.turbo) {
        out.topSpeed = base.topSpeed * TURBO_TOP_SPEED;
        out.accel = base.accel * TURBO_ACCEL;
    }
    if (mods.superJump) out.jumpSpeed = SUPER_JUMP_SPEED;
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
