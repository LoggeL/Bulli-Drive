import { describe, expect, it } from 'vitest';
import {
    createGhostPose, fromBase64, GHOST_SAMPLE_BYTES, ghostSampleCount, GhostTrackWriter, readGhostPose, toBase64, writeGhostPose
} from '../../../src/shared/race/ghostTrack.js';
import { readRunInput, RunRecorder, RUN_INPUT_BYTES, writeRunInput } from '../../../src/shared/race/replay.js';

// The ghost's pose track and the recorded run inputs
// (docs/phase-2-design.md, 15.1 and 15.2): quantisation limits from the
// format (x, z in 1/4096 m, y in cm, yaw in 1/65536 turn, flip in 1/256
// turn), Base64 against the RFC 4648 test vectors.

const TURN = Math.PI * 2;

describe('ghost pose samples', () => {
    it('come back within the quantisation: x, z ± 1/8192 m, y ± 0.5 cm, yaw ± half a step', () => {
        const bytes = new Uint8Array(GHOST_SAMPLE_BYTES);
        const out = createGhostPose();
        const poses = [
            { x: 356.123456, y: 13.777, z: 30.000061, yaw: 0.54, flipAngle: 0 },
            { x: -97.99999, y: -0.004, z: -208.5, yaw: -2.9, flipAngle: 3.5 },
            { x: 12.5, y: -2.506, z: 0.00006, yaw: 1e-9, flipAngle: 0.02 },
            { x: 2047.9, y: 150, z: -2047.9, yaw: Math.PI - 1e-9, flipAngle: TURN - 0.01 }
        ];
        for (const pose of poses) {
            writeGhostPose(bytes, 0, pose);
            readGhostPose(bytes, 0, out);
            expect(Math.abs(out.x - pose.x)).toBeLessThanOrEqual(1 / 8192);
            expect(Math.abs(out.z - pose.z)).toBeLessThanOrEqual(1 / 8192);
            expect(Math.abs(out.y - pose.y)).toBeLessThanOrEqual(0.005 + 1e-12);
            // Yaw as the same direction (the track keeps (-π, π])
            const dYaw = Math.atan2(Math.sin(out.yaw - pose.yaw), Math.cos(out.yaw - pose.yaw));
            expect(Math.abs(dYaw)).toBeLessThanOrEqual(Math.PI / 65536 + 1e-12);
            // Kept in (-π, π], like the sim's headings
            expect(out.yaw).toBeGreaterThan(-Math.PI);
            expect(out.yaw).toBeLessThanOrEqual(Math.PI);
            const dFlip = Math.atan2(Math.sin(out.flipAngle - pose.flipAngle), Math.cos(out.flipAngle - pose.flipAngle));
            expect(Math.abs(dFlip)).toBeLessThanOrEqual(Math.PI / 256 + 1e-12);
        }
    });

    it('keeps x and z within ±2048 m (clamped beyond) and writes 13 bytes a sample', () => {
        const bytes = new Uint8Array(GHOST_SAMPLE_BYTES);
        const out = createGhostPose();
        writeGhostPose(bytes, 0, { x: 5000, y: 0, z: -5000, yaw: 0, flipAngle: 0 });
        readGhostPose(bytes, 0, out);
        expect(out.x).toBeCloseTo(2048 - 1 / 4096, 9);
        expect(out.z).toBe(-2048);
        const writer = new GhostTrackWriter();
        for (let i = 0; i < 300; i++) writer.push({ x: i, y: 0, z: -i, yaw: 0, flipAngle: 0 });
        const track = writer.finish();
        expect(track.byteLength).toBe(300 * 13);
        expect(ghostSampleCount(track)).toBe(300);
        expect(readGhostPose(track, 299, out).x).toBe(299);
        expect(out.z).toBe(-299);
    });
});

describe('Base64', () => {
    const enc = (text: string) => toBase64(new TextEncoder().encode(text));

    it('encodes the RFC 4648 vectors', () => {
        expect(['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar'].map(enc))
            .toEqual(['', 'Zg==', 'Zm8=', 'Zm9v', 'Zm9vYg==', 'Zm9vYmE=', 'Zm9vYmFy']);
        expect(toBase64(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe('+/+/');
    });

    it('decodes what it encodes, any length, and turns away what is not Base64', () => {
        for (let n = 0; n < 8; n++) {
            const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 97 + 13) & 0xff);
            expect(fromBase64(toBase64(bytes))).toEqual(bytes);
        }
        expect(new TextDecoder().decode(fromBase64('Zm9vYmE=')!)).toBe('fooba');
        for (const bad of ['Zm9', 'Zm=v', 'Zm9v!A==', 'Zm9vYmE', '====', 'Zé==']) expect(fromBase64(bad), bad).toBeNull();
    });
});

describe('run inputs', () => {
    it('keep steer (signed), throttle, brake and buttons, 4 bytes a tick', () => {
        const recorder = new RunRecorder();
        const inputs = [
            { steer: -127, throttle: 255, brake: 0, buttons: 8 },
            { steer: 127, throttle: 0, brake: 255, buttons: 3 },
            { steer: -1, throttle: 128, brake: 1, buttons: 0 }
        ];
        // Past the first buffer (3600 ticks)
        for (let i = 0; i < 5000; i++) recorder.push(inputs[i % 3]);
        const bytes = recorder.finish();
        expect(bytes.byteLength).toBe(5000 * RUN_INPUT_BYTES);
        const out = { steer: 0, throttle: 0, brake: 0, buttons: 0 };
        for (const i of [0, 1, 2, 4999]) expect(readRunInput(bytes, i, out)).toEqual(inputs[i % 3]);
        const one = new Uint8Array(4);
        writeRunInput(one, 0, { steer: -128 + 1, throttle: 7, brake: 9, buttons: 1 });
        expect(Array.from(one)).toEqual([129, 7, 9, 1]);
        recorder.clear();
        expect(recorder.finish().byteLength).toBe(0);
    });
});
