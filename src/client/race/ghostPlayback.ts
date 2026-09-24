import { createGhostPose, fromBase64, ghostSampleCount, readGhostPose, type GhostPose } from '../../shared/race/ghostTrack.js';

// Playback of a time trial ghost (docs/phase-2-design.md, 15.4): the pose
// track from the server, one sample every `every` ticks from startTick on
// (sample j is the car after tick S + every · j). Between samples a cubic
// Hermite curve with Catmull-Rom tangents (the track carries no speeds), so
// a 20 Hz track moves as smoothly as the 60 Hz car beside it. Before the
// start the ghost waits on its first sample, after the last it stays on it.
// No DOM, no three.

const TWO_PI = Math.PI * 2;

function wrapAngle(angle: number): number {
    return angle - TWO_PI * Math.floor((angle + Math.PI) / TWO_PI);
}

function hermite(p0: number, m0: number, p1: number, m1: number, s: number): number {
    const s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * m1;
}

export class GhostPlayback {
    readonly count: number;
    private readonly bytes: Uint8Array;
    private readonly a = createGhostPose();
    private readonly b = createGhostPose();
    private readonly c = createGhostPose();
    private readonly d = createGhostPose();

    constructor(bytes: Uint8Array, private readonly startTick: number, private readonly every: number) {
        this.bytes = bytes;
        this.count = ghostSampleCount(bytes);
    }

    /** From the ghostData message (Base64 poses, samples per second); null for a broken track. */
    static fromMessage(poses: string, hz: number, tickRate: number, startTick: number): GhostPlayback | null {
        const bytes = fromBase64(poses);
        const every = Math.round(tickRate / hz);
        if (!bytes || every < 1 || ghostSampleCount(bytes) === 0) return null;
        return new GhostPlayback(bytes, startTick, every);
    }

    /** Whether the run is over at render tick t (the ghost reached the finish). */
    finished(t: number): boolean {
        return (t - this.startTick) / this.every >= this.count - 1;
    }

    /** The ghost at render tick t (float). */
    sample(t: number, out: GhostPose): GhostPose {
        const f = (t - this.startTick) / this.every;
        const last = this.count - 1;
        if (f <= 0 || last === 0) return readGhostPose(this.bytes, 0, out);
        if (f >= last) return readGhostPose(this.bytes, last, out);
        const i = Math.floor(f);
        const s = f - i;
        const a = readGhostPose(this.bytes, Math.max(0, i - 1), this.a);
        const b = readGhostPose(this.bytes, i, this.b);
        const c = readGhostPose(this.bytes, i + 1, this.c);
        const d = readGhostPose(this.bytes, Math.min(last, i + 2), this.d);
        // Catmull-Rom tangents per sample interval; one-sided at the ends
        const span0 = i > 0 ? 2 : 1, span1 = i + 2 <= last ? 2 : 1;
        const tangent = (p: number, q: number, span: number) => (q - p) / span;
        out.x = hermite(b.x, tangent(a.x, c.x, span0), c.x, tangent(b.x, d.x, span1), s);
        out.y = hermite(b.y, tangent(a.y, c.y, span0), c.y, tangent(b.y, d.y, span1), s);
        out.z = hermite(b.z, tangent(a.z, c.z, span0), c.z, tangent(b.z, d.z, span1), s);
        // Angles on the short way round
        out.yaw = wrapAngle(b.yaw + wrapAngle(c.yaw - b.yaw) * s);
        out.flipAngle = b.flipAngle + wrapAngle(c.flipAngle - b.flipAngle) * s;
        return out;
    }
}

export type { GhostPose };
