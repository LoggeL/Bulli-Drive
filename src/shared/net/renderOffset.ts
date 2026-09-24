// Render offset of a corrected car (docs/phase-1b-design.md, 8.4 and 8.6).
// A correction moves the sim state at once; what is on screen must not
// jump. The offset holds the difference between the pose shown before the
// correction and the new sim pose at the same render time, and fades out:
// τ = 100 ms + 100 ms · clamp(|offset| / 2 m, 0, 1), gone below 1 mm. The
// offset of a correction with car contact is gone at the latest 300 ms
// after that correction: on top of the fade it may be at most a linear ramp
// from its size at the correction down to 0 at the deadline, so it never
// vanishes in one frame. Only the picture uses it, never the sim.

import { CONTACT_SMOOTH_MAX_MS, SMOOTH_TAU_MAX_MS, SMOOTH_TAU_MIN_MS, SNAP_DISTANCE, SNAP_YAW } from './constants.js';
import type { VehicleState } from '../sim/types.js';

const TWO_PI = Math.PI * 2;
// Below this the offset counts as gone (m, rad)
export const OFFSET_EPSILON = 1e-3;

export interface Pose {
    x: number;
    y: number;
    z: number;
    yaw: number;
}

export function createPose(): Pose {
    return { x: 0, y: 0, z: 0, yaw: 0 };
}

export function wrapAngle(angle: number): number {
    return angle - TWO_PI * Math.floor((angle + Math.PI) / TWO_PI);
}

/** The pose between the states before and after a tick, alpha in 0..1 (no offset). */
export function interpolatePose(prev: VehicleState, curr: VehicleState, alpha: number, out: Pose): Pose {
    out.x = prev.x + (curr.x - prev.x) * alpha;
    out.y = prev.y + (curr.y - prev.y) * alpha;
    out.z = prev.z + (curr.z - prev.z) * alpha;
    out.yaw = prev.yaw + wrapAngle(curr.yaw - prev.yaw) * alpha;
    return out;
}

export class RenderOffset implements Pose {
    x = 0;
    y = 0;
    z = 0;
    yaw = 0;
    // Deadline of the last contact correction (ms), -1 = none, and the
    // size and yaw the offset had at that correction (the top of the ramp)
    private contactUntil = -1;
    private rampSize = 0;
    private rampYaw = 0;
    // Tau the offset used last (ms), for the debug numbers
    tauMs = 0;

    get size(): number {
        return Math.hypot(this.x, this.y, this.z);
    }

    get active(): boolean {
        return this.size >= OFFSET_EPSILON || Math.abs(this.yaw) >= OFFSET_EPSILON;
    }

    clear(): void {
        this.x = this.y = this.z = this.yaw = 0;
        this.contactUntil = -1;
    }

    /**
     * A correction: shown is the pose on screen before it (sim pose plus
     * this offset), after the new sim pose at the same render time. The
     * offset takes the difference, so the picture stays where it was.
     * Returns false (and clears) when the difference is too large to
     * smooth: then the car jumps (4 m or 45°).
     */
    correct(shown: Pose, after: Pose, contact: boolean, now: number): boolean {
        const x = shown.x - after.x, y = shown.y - after.y, z = shown.z - after.z;
        const yaw = wrapAngle(shown.yaw - after.yaw);
        if (!Number.isFinite(x + y + z + yaw) || Math.hypot(x, y, z) >= SNAP_DISTANCE || Math.abs(yaw) >= SNAP_YAW) {
            this.clear();
            return false;
        }
        this.x = x; this.y = y; this.z = z; this.yaw = yaw;
        if (contact) {
            // Each contact correction gets its own 300 ms
            this.contactUntil = now + CONTACT_SMOOTH_MAX_MS;
            this.rampSize = this.size;
            this.rampYaw = Math.abs(yaw);
        } else {
            // A correction without contact takes over the whole offset,
            // with what is left of an earlier one: it fades normally
            this.contactUntil = -1;
        }
        if (!this.active) this.clear();
        return true;
    }

    /** Fades the offset for a frame of dtMs at time now (ms). */
    decay(dtMs: number, now: number): void {
        if (!this.active) {
            this.clear();
            return;
        }
        if (this.contactUntil >= 0 && now >= this.contactUntil) {
            // The ramp ends here: what is left is at most one frame of it
            this.clear();
            return;
        }
        const tau = SMOOTH_TAU_MIN_MS + (SMOOTH_TAU_MAX_MS - SMOOTH_TAU_MIN_MS) * Math.min(1, this.size / 2);
        this.tauMs = tau;
        const k = Math.exp(-Math.max(0, dtMs) / tau);
        this.x *= k; this.y *= k; this.z *= k; this.yaw *= k;
        if (this.contactUntil >= 0) {
            const left = Math.min(1, (this.contactUntil - now) / CONTACT_SMOOTH_MAX_MS);
            const size = this.size, maxSize = this.rampSize * left;
            if (size > maxSize) {
                const f = size > 0 ? maxSize / size : 0;
                this.x *= f; this.y *= f; this.z *= f;
            }
            const maxYaw = this.rampYaw * left;
            if (Math.abs(this.yaw) > maxYaw) this.yaw = Math.sign(this.yaw) * maxYaw;
        }
        if (!this.active) this.clear();
    }

    /** Adds the offset to a pose. */
    applyTo(pose: Pose): Pose {
        pose.x += this.x; pose.y += this.y; pose.z += this.z; pose.yaw += this.yaw;
        return pose;
    }
}
