import { describe, expect, it } from 'vitest';
import { CAR_GROUNDED, type CompactCar } from '../../../src/shared/net/codec.js';
import { AdaptiveDelay, createRemotePose, RemoteTrack } from '../../../src/shared/net/interpolation.js';
import { DT } from '../../../src/shared/sim/constants.js';

// Remote cars outside the contact set (8.6, 15.1).

function car(x: number, z: number, yaw: number, vx: number, vz: number, yawRate = 0): CompactCar {
    return {
        slot: 1, flags: CAR_GROUNDED, x, y: 0, z, yaw, vx, vy: 0, vz, yawRate, steerAngle: 0,
        input: { steer: 0, throttle: 0, brake: 0, buttons: 0 }, scale: 1, susp: 0, boostMeter: 0,
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

    it('blends the suspension and the vertical speed between samples, holds them past the newest', () => {
        // Landing: the body 2 cm extended and falling 3 m/s at tick 0, 10 cm
        // compressed and rising 1 m/s three ticks later. Snapshots come at
        // 20 Hz; without the blend the body would step 12 cm per snapshot.
        const track = new RemoteTrack();
        track.push(0, { ...car(0, 0, 0, 0, 30), susp: 0.02, vy: -3 });
        track.push(3, { ...car(0, 1.5, 0, 0, 30), susp: -0.1, vy: 1 });
        const pose = createRemotePose();
        track.sample(1, pose);
        expect(pose.susp).toBeCloseTo(0.02 - 0.12 / 3, 12);
        expect(pose.vy).toBeCloseTo(-3 + 4 / 3, 12);
        track.sample(3, pose);
        expect(pose.susp).toBeCloseTo(-0.1, 12);
        track.sample(5, pose);
        expect(pose.susp).toBeCloseTo(-0.1, 12);
        expect(pose.vy).toBeCloseTo(1, 12);
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
        track.sample(13, pose);
        expect(pose.extrapolated).toBe(false);
        track.sample(13 + 6, pose);
        expect(pose.extrapolated).toBe(true);
        expect(pose.z).toBeCloseTo(1 + 20 * 6 / 60, 9);
        // 250 ms (docs/phase-1b-design.md, 8.6) at 20 m/s: 5 m. 15 ticks
        // still move on, the 16th holds
        track.sample(13 + 15, pose);
        expect(pose.z).toBeCloseTo(1 + 20 * 0.25, 9);
        track.sample(13 + 16, pose);
        expect(pose.z).toBeCloseTo(1 + 20 * 0.25, 9);
        track.sample(13 + 100, pose);
        expect(pose.z).toBeCloseTo(1 + 20 * 0.25, 9);
        expect(pose.extrapolated).toBe(true);
    });

    it('extrapolates x, heading and an airborne car\'s height, and reports the speed along the heading', () => {
        const track = new RemoteTrack();
        // Airborne (no CAR_GROUNDED), heading +x (yaw π/2), climbing 4 m/s,
        // turning 1 rad/s
        const flying = { ...car(10, 5, Math.PI / 2, 30, 0, 1), flags: 0, y: 2, vy: 4 };
        track.push(20, flying);
        const pose = createRemotePose();
        track.sample(20 + 6, pose); // 0.1 s ahead
        expect(pose.x).toBeCloseTo(13, 9);
        expect(pose.y).toBeCloseTo(2.4, 9);
        expect(pose.z).toBeCloseTo(5, 9);
        expect(pose.yaw).toBeCloseTo(Math.PI / 2 + 0.1, 9);
        expect(pose.speed).toBeCloseTo(30, 9);
        expect(pose.car).toBe(flying);
        // A grounded car keeps its height
        const grounded = new RemoteTrack();
        grounded.push(20, { ...car(0, 0, 0, 0, 10), y: 2, vy: 4 });
        grounded.sample(26, pose);
        expect(pose.y).toBe(2);
        // Held after 250 ms like x and z
        track.sample(20 + 60, pose);
        expect(pose.x).toBeCloseTo(10 + 30 * 0.25, 9);
        expect(pose.y).toBeCloseTo(2 + 4 * 0.25, 9);
        expect(pose.yaw).toBeCloseTo(Math.PI / 2 + 0.25, 9);
    });

    it('uses the velocities as tangents, scaled by the time between the samples', () => {
        // From standstill at x = 0 to x = 1 at 40 m/s, 3 ticks (0.05 s)
        // apart: tangents 0 and 40 * 0.05 = 2 m. Hermite at s = 1/2:
        // p1 * (-2/8 + 3/4) + m1 * (1/8 - 1/4) = 0.5 - 0.25 = 0.25
        const track = new RemoteTrack();
        const a = { ...car(0, 0, Math.PI / 2, 0, 0), y: 0, vy: 0 };
        const b = { ...car(1, 0, Math.PI / 2, 40, 0), y: 1, vy: 40 };
        track.push(30, a);
        track.push(33, b);
        const pose = createRemotePose();
        track.sample(31.5, pose);
        expect(pose.x).toBeCloseTo(0.25, 9);
        expect(pose.y).toBeCloseTo(0.25, 9);
        expect(pose.extrapolated).toBe(false);
        // Speed along the heading, blended linearly: 0 -> 40
        expect(pose.speed).toBeCloseTo(20, 9);
        // Flags and input come from the sample at or before the render time
        expect(pose.car).toBe(a);
        track.sample(33, pose);
        expect(pose.car).toBe(b);
    });

    it('ignores samples that are not newer than the newest', () => {
        const track = new RemoteTrack();
        track.push(10, car(0, 0, 0, 0, 0));
        track.push(13, car(0, 1, 0, 0, 0));
        track.push(13, car(0, 9, 0, 0, 0));
        track.push(12, car(0, 9, 0, 0, 0));
        expect(track.newest!.car.z).toBe(1);
        const pose = createRemotePose();
        track.sample(13, pose);
        expect(pose.z).toBe(1);
    });

    it('keeps the last 8 samples (8.6)', () => {
        const track = new RemoteTrack();
        for (let tick = 0; tick < 12; tick++) track.push(tick, car(0, tick, 0, 0, 0));
        const pose = createRemotePose();
        // Before the oldest kept sample (tick 4): that sample, not tick 0
        track.sample(0, pose);
        expect(pose.z).toBe(4);
    });

    it('forgets its samples, its offset and its last render time on clear()', () => {
        const track = new RemoteTrack();
        track.push(10, car(0, 3, 0, 0, 20));
        const pose = createRemotePose();
        expect(track.sample(14, pose)).toBe(true);
        // A late sample after the extrapolation: an offset
        track.push(12, car(0, 3.1, 0, 0, 5));
        expect(track.offset.active).toBe(true);
        track.clear();
        expect(track.offset.active).toBe(false);
        expect(track.newest).toBeNull();
        expect(track.sample(10, pose)).toBe(false);
        // Fresh samples after the clear start without an offset
        track.push(20, car(0, 0, 0, 0, 20));
        track.push(23, car(0, 2, 0, 0, 0));
        expect(track.offset.active).toBe(false);
    });

    it('reports the speed along the heading for any heading', () => {
        // Heading 60°: forward (sin, cos) = (0.866, 0.5); v = (10, 4):
        // 8.66 + 2 = 10.66 m/s along the heading
        const along = 10 * Math.sin(Math.PI / 3) + 4 * Math.cos(Math.PI / 3);
        const track = new RemoteTrack();
        track.push(0, car(0, 0, Math.PI / 3, 10, 4));
        track.push(3, car(0.5, 0.2, Math.PI / 3, 10, 4));
        const pose = createRemotePose();
        track.sample(1.5, pose);
        expect(pose.speed).toBeCloseTo(along, 9);
        track.sample(0, pose);
        expect(pose.speed).toBeCloseTo(along, 9);
        track.sample(5, pose);
        expect(pose.speed).toBeCloseTo(along, 9);
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

    it('blends a move of under 20 m, also away from the origin', () => {
        const track = new RemoteTrack();
        // 12 m in x and z: 17 m, no teleport
        track.push(0, car(10, 10, 0, 0, 0));
        track.push(3, car(22, 22, 0, 0, 0));
        expect(track.teleported).toBe(false);
        const pose = createRemotePose();
        track.sample(1.5, pose);
        expect(pose.x).toBeCloseTo(16, 9);
        expect(pose.z).toBeCloseTo(16, 9);
        // 21 m in x alone: a teleport
        track.push(6, car(43, 22, 0, 0, 0));
        expect(track.teleported).toBe(true);
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
    // 8.6: 100 ms (6 ticks), up one tick at a time while more than 5 % of
    // the frames extrapolate, at most 9 ticks (150 ms), down again after
    // 10 s without extrapolation
    it('grows while frames extrapolate and shrinks after a calm while', () => {
        const delay = new AdaptiveDelay();
        expect(delay.delay).toBe(6);
        for (let i = 0; i < 60; i++) delay.frame(16, i % 10 === 0);
        expect(delay.delay).toBe(7);
        for (let i = 0; i < 60 * 12; i++) delay.frame(16, false);
        expect(delay.delay).toBe(6);
    });

    it('grows above 5 % only, and stops at 9 ticks', () => {
        const delay = new AdaptiveDelay();
        // 3 of 60 frames: exactly 5 %, no change
        for (let i = 0; i < 60; i++) delay.frame(16, i % 20 === 0);
        expect(delay.delay).toBe(6);
        // 4 of 60: up
        for (let i = 0; i < 60; i++) delay.frame(16, i % 15 === 0);
        expect(delay.delay).toBe(7);
        for (let n = 0; n < 5; n++) for (let i = 0; i < 60; i++) delay.frame(16, true);
        expect(delay.delay).toBe(9);
    });

    it('shrinks only after 10 s without a single extrapolated frame', () => {
        const delay = new AdaptiveDelay();
        for (let i = 0; i < 60; i++) delay.frame(16, true);
        expect(delay.delay).toBe(7);
        // 9.6 s calm (10 windows of 60 frames at 16 ms): not yet
        for (let i = 0; i < 600; i++) delay.frame(16, false);
        expect(delay.delay).toBe(7);
        // One extrapolated frame in the next window starts the 10 s again
        for (let i = 0; i < 60; i++) delay.frame(16, i === 0);
        for (let i = 0; i < 600; i++) delay.frame(16, false);
        expect(delay.delay).toBe(7);
        // 10.56 s calm: down, never below 6 ticks
        for (let i = 0; i < 60; i++) delay.frame(16, false);
        expect(delay.delay).toBe(6);
        for (let i = 0; i < 60 * 60; i++) delay.frame(16, false);
        expect(delay.delay).toBe(6);
    });
});
