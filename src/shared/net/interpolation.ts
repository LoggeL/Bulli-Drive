// Remote cars outside the contact set (docs/phase-1b-design.md, 8.6): a
// short buffer of snapshot samples per car, shown a little in the past
// with cubic Hermite interpolation (the velocities are the tangents), a
// short linear extrapolation when the samples run out, then a hold.

import { DT } from '../sim/constants.js';
import { CAR_GROUNDED, type CompactCar } from './codec.js';
import { EXTRAPOLATE_MAX_TICKS, INTERP_DELAY_MAX_TICKS, INTERP_DELAY_TICKS } from './constants.js';

const BUFFER = 8;
const TWO_PI = Math.PI * 2;
// A jump farther than this between two samples is a teleport: no blending
export const TELEPORT_DISTANCE = 20;

export interface RemoteSample {
    tick: number;
    car: CompactCar;
}

export interface RemotePose {
    x: number; y: number; z: number;
    yaw: number;
    // Speed along the heading (m/s), for wheels and sound
    speed: number;
    // The newest sample at or before the render time (flags, input, scale ...)
    car: CompactCar | null;
    // Past the newest sample (extrapolated or held)
    extrapolated: boolean;
}

function wrapAngle(angle: number): number {
    return angle - TWO_PI * Math.floor((angle + Math.PI) / TWO_PI);
}

// Cubic Hermite between p0 and p1 with tangents m0, m1 (per unit of s), s in 0..1
function hermite(p0: number, m0: number, p1: number, m1: number, s: number): number {
    const s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * m1;
}

export function createRemotePose(): RemotePose {
    return { x: 0, y: 0, z: 0, yaw: 0, speed: 0, car: null, extrapolated: false };
}

export class RemoteTrack {
    private readonly samples: RemoteSample[] = [];
    // Set when the last sample jumped (teleport, respawn): show it at once
    teleported = false;

    get newest(): RemoteSample | null {
        return this.samples.length ? this.samples[this.samples.length - 1] : null;
    }

    clear(): void {
        this.samples.length = 0;
    }

    push(tick: number, car: CompactCar): void {
        const last = this.newest;
        if (last && tick <= last.tick) return;
        if (last && Math.hypot(car.x - last.car.x, car.z - last.car.z) > TELEPORT_DISTANCE) {
            this.samples.length = 0;
            this.teleported = true;
        }
        this.samples.push({ tick, car });
        if (this.samples.length > BUFFER) this.samples.shift();
    }

    /** The pose at server tick r (with fraction); false before the first sample. */
    sample(r: number, out: RemotePose): boolean {
        const samples = this.samples;
        if (samples.length === 0) return false;
        const newest = samples[samples.length - 1];
        if (r >= newest.tick || samples.length === 1) {
            const ahead = Math.min(Math.max(0, r - newest.tick), EXTRAPOLATE_MAX_TICKS) * DT;
            const c = newest.car;
            out.x = c.x + c.vx * ahead;
            out.y = c.y + ((c.flags & CAR_GROUNDED) !== 0 ? 0 : c.vy * ahead);
            out.z = c.z + c.vz * ahead;
            out.yaw = wrapAngle(c.yaw + c.yawRate * ahead);
            out.speed = c.vx * Math.sin(c.yaw) + c.vz * Math.cos(c.yaw);
            out.car = c;
            out.extrapolated = r > newest.tick;
            return true;
        }
        let i = samples.length - 2;
        while (i > 0 && samples[i].tick > r) i--;
        const a = samples[i], b = samples[i + 1];
        if (r <= a.tick) {
            const c = a.car;
            out.x = c.x; out.y = c.y; out.z = c.z; out.yaw = c.yaw;
            out.speed = c.vx * Math.sin(c.yaw) + c.vz * Math.cos(c.yaw);
            out.car = c;
            out.extrapolated = false;
            return true;
        }
        const span = b.tick - a.tick;
        const s = (r - a.tick) / span;
        const h = span * DT;   // seconds between the samples: tangent scale
        const ca = a.car, cb = b.car;
        out.x = hermite(ca.x, ca.vx * h, cb.x, cb.vx * h, s);
        out.z = hermite(ca.z, ca.vz * h, cb.z, cb.vz * h, s);
        out.y = hermite(ca.y, ca.vy * h, cb.y, cb.vy * h, s);
        const yawB = ca.yaw + wrapAngle(cb.yaw - ca.yaw);
        out.yaw = wrapAngle(hermite(ca.yaw, ca.yawRate * h, yawB, cb.yawRate * h, s));
        const ua = ca.vx * Math.sin(ca.yaw) + ca.vz * Math.cos(ca.yaw);
        const ub = cb.vx * Math.sin(cb.yaw) + cb.vz * Math.cos(cb.yaw);
        out.speed = ua + (ub - ua) * s;
        out.car = s < 1 ? ca : cb;
        out.extrapolated = false;
        return true;
    }
}

/**
 * Interpolation delay that grows while too many frames run out of samples
 * (jitter, TCP stalls) and shrinks again after a calm while (8.6).
 */
export class AdaptiveDelay {
    delay = INTERP_DELAY_TICKS;
    private frames = 0;
    private extrapolated = 0;
    private calmMs = 0;

    /** One rendered frame of dt seconds; extrapolated: some remote ran past its samples. */
    frame(dtMs: number, extrapolated: boolean): void {
        this.frames++;
        if (extrapolated) this.extrapolated++;
        this.calmMs += dtMs;
        if (this.frames < 60) return;
        const share = this.extrapolated / this.frames;
        if (share > 0.05 && this.delay < INTERP_DELAY_MAX_TICKS) {
            this.delay++;
            this.calmMs = 0;
        } else if (share === 0 && this.calmMs > 10_000 && this.delay > INTERP_DELAY_TICKS) {
            this.delay--;
            this.calmMs = 0;
        }
        if (share > 0) this.calmMs = 0;
        this.frames = 0;
        this.extrapolated = 0;
    }
}
