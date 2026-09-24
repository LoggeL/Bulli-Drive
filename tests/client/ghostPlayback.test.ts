import { describe, expect, it } from 'vitest';
import { GhostPlayback } from '../../src/client/race/ghostPlayback.js';
import { createGhostPose, GhostTrackWriter, toBase64 } from '../../src/shared/race/ghostTrack.js';

// Playback of a time trial ghost (src/client/race/ghostPlayback.ts,
// docs/phase-2-design.md 15.4): sample j is the car after tick S + 3 j.
// A cubic Hermite with Catmull-Rom tangents reproduces a straight line at
// constant speed exactly, so the expected values are the line's own. All
// sample values are exact in the track's quantisation (1/4096 m, 1 cm).

const S = 600;

function track(samples: { x: number; z?: number; y?: number; yaw?: number }[]): Uint8Array {
    const writer = new GhostTrackWriter();
    const pose = createGhostPose();
    for (const s of samples) {
        pose.x = s.x;
        pose.z = s.z ?? 0;
        pose.y = s.y ?? 0;
        pose.yaw = s.yaw ?? 0;
        writer.push(pose);
    }
    return writer.finish();
}

describe('GhostPlayback', () => {
    it('moves along a straight track at constant speed exactly, between and on the samples', () => {
        // 1.5 m per 3 ticks along x, z rising 0.25 m per sample
        const bytes = track([0, 1, 2, 3, 4].map(j => ({ x: 1.5 * j, z: 10 + 0.25 * j, y: 2 })));
        const ghost = new GhostPlayback(bytes, S, 3);
        const pose = createGhostPose();
        for (const t of [S, S + 1, S + 4.5, S + 7, S + 11.25, S + 12]) {
            ghost.sample(t, pose);
            expect(pose.x).toBeCloseTo(0.5 * (t - S), 9);
            expect(pose.z).toBeCloseTo(10 + 0.25 * (t - S) / 3, 9);
            expect(pose.y).toBeCloseTo(2, 9);
        }
    });

    it('waits on the first sample before the start and stays on the last one after the finish', () => {
        const ghost = new GhostPlayback(track([{ x: 5 }, { x: 6 }, { x: 8 }]), S, 3);
        const pose = createGhostPose();
        expect(ghost.sample(S - 200, pose).x).toBe(5);
        expect(ghost.sample(S + 6, pose).x).toBe(8);
        expect(ghost.sample(S + 600, pose).x).toBe(8);
        expect(ghost.finished(S + 5.9)).toBe(false);
        expect(ghost.finished(S + 6)).toBe(true);
    });

    it('turns the short way round across ±π', () => {
        const ghost = new GhostPlayback(track([{ x: 0, yaw: 3.1 }, { x: 1, yaw: -3.1 }]), S, 3);
        const yaw = ghost.sample(S + 1.5, createGhostPose()).yaw;
        // Halfway between 3.1 and -3.1 the short way is ±π, not 0
        expect(Math.abs(yaw)).toBeCloseTo(Math.PI, 3);
    });

    it('reads the ghostData message: 20 Hz at 60 ticks is a sample every 3 ticks; a broken track is none', () => {
        const bytes = track([{ x: 0 }, { x: 3 }]);
        const ghost = GhostPlayback.fromMessage(toBase64(bytes), 20, 60, S)!;
        expect(ghost.count).toBe(2);
        // 1.5 ticks in: halfway
        expect(ghost.sample(S + 1.5, createGhostPose()).x).toBeCloseTo(1.5, 9);
        expect(GhostPlayback.fromMessage('not base64!', 20, 60, S)).toBeNull();
        expect(GhostPlayback.fromMessage('', 20, 60, S)).toBeNull();
    });
});
