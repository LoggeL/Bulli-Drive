import { describe, expect, it } from 'vitest';
import { CAR_GROUNDED, type CompactCar } from '../../../src/shared/net/codec.js';
import { EXTRAPOLATE_MAX_TICKS } from '../../../src/shared/net/constants.js';
import { AdaptiveDelay, createRemotePose, RemoteTrack } from '../../../src/shared/net/interpolation.js';
import { DT } from '../../../src/shared/sim/constants.js';

// Remote cars outside the contact set (8.6, 15.1).

function car(x: number, z: number, yaw: number, vx: number, vz: number, yawRate = 0): CompactCar {
    return {
        slot: 1, flags: CAR_GROUNDED, x, y: 0, z, yaw, vx, vy: 0, vz, yawRate, steerAngle: 0,
        input: { steer: 0, throttle: 0, brake: 0, buttons: 0 }, scale: 1, flipAngle: 0, boostMeter: 0,
        rearGrip: 1, loadX: 0, ghostTicks: 0
    };
}

describe('RemoteTrack', () => {
    it('hits the samples exactly and interpolates between them', () => {
        const track = new RemoteTrack();
        track.push(100, car(0, 0, 0, 0, 30));
        track.push(103, car(0, 1.5, 0, 0, 30));
        track.push(106, car(0, 3, 0, 0, 30));
        const pose = createRemotePose();
        for (const [tick, z] of [[100, 0], [103, 1.5], [106, 3]]) {
            track.sample(tick, pose);
            expect(pose.z).toBeCloseTo(z, 12);
            expect(pose.extrapolated).toBe(false);
        }
        // Constant speed: Hermite is linear
        track.sample(101.5, pose);
        expect(pose.z).toBeCloseTo(0.75, 9);
    });

    it('turns the short way across ±π', () => {
        const track = new RemoteTrack();
        track.push(0, car(0, 0, Math.PI - 0.1, 0, 0, 2 / (3 * DT) * 0.1));
        track.push(3, car(0, 0, -Math.PI + 0.1, 0, 0, 2 / (3 * DT) * 0.1));
        const pose = createRemotePose();
        track.sample(1.5, pose);
        expect(Math.abs(Math.abs(pose.yaw) - Math.PI)).toBeLessThan(0.02);
    });

    it('extrapolates at most 250 ms past the newest sample, then holds', () => {
        const track = new RemoteTrack();
        track.push(10, car(0, 0, 0, 0, 20));
        track.push(13, car(0, 1, 0, 0, 20));
        const pose = createRemotePose();
        track.sample(13 + 6, pose);
        expect(pose.extrapolated).toBe(true);
        expect(pose.z).toBeCloseTo(1 + 20 * 6 * DT, 9);
        track.sample(13 + 100, pose);
        expect(pose.z).toBeCloseTo(1 + 20 * EXTRAPOLATE_MAX_TICKS * DT, 9);
    });

    it('snaps after a jump of more than 20 m', () => {
        const track = new RemoteTrack();
        track.push(0, car(0, 0, 0, 0, 0));
        track.push(3, car(0, 50, 0, 0, 0));
        expect(track.teleported).toBe(true);
        const pose = createRemotePose();
        track.sample(1, pose);
        expect(pose.z).toBe(50);
    });
});

describe('RemoteTrack after running out of samples', () => {
    it('keeps the extrapolated picture when the late sample comes in and fades to the samples', () => {
        const track = new RemoteTrack();
        track.push(10, car(0, 0, 0, 0, 20));
        track.push(13, car(0, 1, 0, 0, 20));
        const pose = createRemotePose();
        // Frames past the newest sample (a stalled snapshot)
        track.sample(18, pose);
        expect(pose.extrapolated).toBe(true);
        const shown = pose.z;
        // The car braked meanwhile: the late sample lies behind the extrapolation
        track.push(16, car(0, 1.6, 0, 0, 5));
        track.push(19, car(0, 1.8, 0, 0, 5));
        track.sample(18, pose);
        expect(pose.z).toBeCloseTo(shown, 9);
        expect(track.offset.active).toBe(true);
        // Fades over a few frames; no frame moves the picture by more than
        // the offset's decay at tau 100 ms plus the car's own motion
        let last = pose.z;
        let r = 18;
        for (let frame = 0; frame < 60; frame++) {
            track.decay(1000 / 60);
            r += 1;
            track.sample(Math.min(r, 19), pose);
            expect(Math.abs(pose.z - last)).toBeLessThan(0.1);
            last = pose.z;
        }
        expect(track.offset.active).toBe(false);
        track.sample(19, pose);
        expect(pose.z).toBeCloseTo(1.8, 9);
    });

    it('adds no offset while the render time stays between samples', () => {
        const track = new RemoteTrack();
        track.push(10, car(0, 0, 0, 0, 20));
        track.push(13, car(0, 1, 0, 0, 20));
        const pose = createRemotePose();
        track.sample(12, pose);
        track.push(16, car(0, 5, 0, 0, 20));
        expect(track.offset.active).toBe(false);
    });

    it('drops the offset on a teleport', () => {
        const track = new RemoteTrack();
        track.push(10, car(0, 0, 0, 0, 20));
        const pose = createRemotePose();
        track.sample(14, pose);
        track.push(13, car(0, 0.5, 0, 0, 20));
        expect(track.offset.active).toBe(true);
        track.push(16, car(0, 80, 0, 0, 0));
        expect(track.offset.active).toBe(false);
        track.sample(16, pose);
        expect(pose.z).toBe(80);
    });
});

describe('AdaptiveDelay', () => {
    it('grows while frames extrapolate and shrinks after a calm while', () => {
        const delay = new AdaptiveDelay();
        const start = delay.delay;
        for (let i = 0; i < 60; i++) delay.frame(16, i % 10 === 0);
        expect(delay.delay).toBe(start + 1);
        for (let i = 0; i < 60 * 12; i++) delay.frame(16, false);
        expect(delay.delay).toBe(start);
    });
});
