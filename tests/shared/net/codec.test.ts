import { describe, expect, it } from 'vitest';
import {
    CAR_BOOSTING, CAR_DRIFTING, CAR_FLIPPING, CAR_GHOST, CAR_GHOST_EXIT, CAR_GROUNDED, CAR_IDLE, CAR_MEGA,
    CAR_RESPAWN_SHIELD, CAR_SHIELD, CAR_SUPER_JUMP, CAR_TURBO, CAR_WAS_GHOST, COMPACT_BYTES, decodeInputPacket,
    decodeRemoteState, decodeSnapshot, encodeInputPacket, encodeSnapshot, flagsToMods, FRAME_INPUT, INPUT_FROZEN,
    inputPacketSize, MOD_MEGA, MOD_SUPER_JUMP, MOD_TURBO, SELF_BLOCK_BYTES, SELF_BLOCK_KEYS, SNAPSHOT_HEADER_BYTES,
    bitsToMods, modsToBits, stateFlags, type CompactCar, type InputPacket, type Snapshot
} from '../../../src/shared/net/codec.js';
import {
    POS_STEP, quantByte, quantFlip, quantHeight, quantLoad, quantPos, quantScale, quantSpeed, quantSteer, quantUnit,
    quantYaw, quantYawRate, unquantFlip, unquantYaw
} from '../../../src/shared/net/quant.js';
import { mulberry32 } from '../../../src/shared/math/rng.js';
import { createVehicleModifiers, createVehicleState, type VehicleInput, type VehicleState } from '../../../src/shared/sim/types.js';

// Binary frames of protocol v2 (docs/phase-1b-design.md, 3.3, 3.4, 15.1).

function input(steer: number, throttle: number, brake: number, buttons: number): VehicleInput {
    return { steer, throttle, brake, buttons };
}

describe('input packets', () => {
    it('round-trip 1 to 8 inputs, newest first, with the extremes', () => {
        const all = [input(-127, 255, 0, 15), input(127, 0, 255, 0), input(0, 128, 1, 8), input(-1, 1, 254, 4),
            input(5, 6, 7, 1), input(-50, 60, 70, 2), input(100, 200, 50, 3), input(-127, 0, 0, 12)];
        for (let n = 1; n <= 8; n++) {
            const packet: InputPacket = { flags: INPUT_FROZEN, seq: 0xfffffff0 + n, tick: 123456 + n, inputs: all.slice(0, n) };
            const bytes = encodeInputPacket(packet);
            expect(bytes.byteLength).toBe(inputPacketSize(n));
            expect(decodeInputPacket(bytes)).toEqual(packet);
        }
        // 3 inputs are 23 bytes (3.3)
        expect(inputPacketSize(3)).toBe(23);
    });

    it('rejects broken frames', () => {
        const good = encodeInputPacket({ flags: 0, seq: 1, tick: 2, inputs: [input(0, 0, 0, 0), input(0, 0, 0, 0)] });
        expect(decodeInputPacket(good.subarray(0, good.byteLength - 1))).toBeNull();
        expect(decodeInputPacket(new Uint8Array([...good, 0]))).toBeNull();
        const wrongKind = good.slice();
        wrongKind[0] = 0x02;
        expect(decodeInputPacket(wrongKind)).toBeNull();
        const tooMany = good.slice();
        tooMany[1] = 9;
        expect(decodeInputPacket(tooMany)).toBeNull();
        const none = good.slice();
        none[1] = 0;
        expect(decodeInputPacket(none)).toBeNull();
        expect(decodeInputPacket(new Uint8Array(0))).toBeNull();
        expect(() => encodeInputPacket({ flags: 0, seq: 0, tick: 0, inputs: [] })).toThrow();
    });
});

// A car in the middle of a drifting jump with every field off its default
function busyState(random: () => number): VehicleState {
    const s = createVehicleState();
    for (const key of Object.keys(s) as (keyof VehicleState)[]) {
        const value = s[key];
        if (typeof value === 'boolean') (s as unknown as Record<string, boolean>)[key] = random() < 0.5;
        else (s as unknown as Record<string, number>)[key] = value + (random() - 0.5) * 40;
    }
    // Counters are integers in their ranges
    s.airTicks = 200; s.driftTicks = 4000; s.driftLowTicks = 7; s.wallTicks = 255; s.jumpCooldown = 19;
    s.resetHold = 31; s.reverseHold = 8; s.ghostTicks = 180; s.ghostExit = 179; s.prevButtons = 13;
    s.x = -1234.56789; s.z = 987.654321; s.yaw = 17.5;
    return s;
}

function compactOf(slot: number, s: VehicleState, flags: number, last: VehicleInput): CompactCar {
    return {
        slot, flags, x: s.x, y: s.y, z: s.z, yaw: s.yaw, vx: s.vx, vy: s.vy, vz: s.vz, yawRate: s.yawRate,
        steerAngle: s.steerAngle, input: last, scale: s.scale, flipAngle: s.flipAngle, boostMeter: s.boostMeter,
        rearGrip: s.rearGrip, loadX: s.loadX, ghostTicks: s.ghostTicks
    };
}

function randomCar(slot: number, random: () => number): CompactCar {
    const s = createVehicleState();
    s.x = (random() - 0.5) * 1000; s.z = (random() - 0.5) * 1000; s.y = random() * 30;
    s.yaw = (random() - 0.5) * 20; s.vx = (random() - 0.5) * 170; s.vy = (random() - 0.5) * 40; s.vz = (random() - 0.5) * 170;
    s.yawRate = (random() - 0.5) * 12; s.steerAngle = (random() - 0.5) * 1.2; s.scale = 1 + random() * 1.5;
    s.flipAngle = random() < 0.5 ? 0 : random() * 6; s.boostMeter = random(); s.rearGrip = random();
    s.loadX = (random() - 0.5) * 60; s.ghostTicks = Math.floor(random() * 255);
    return compactOf(slot, s, CAR_GROUNDED | (s.flipAngle > 0 ? CAR_FLIPPING : 0), input(3, 200, 0, 2));
}

function snapshotWith(cars: CompactCar[], self: Snapshot['self']): Snapshot {
    return {
        serverTick: 4_000_000_001, lastProcessedSeq: 77, inputSlack: -3, bufferTarget: 2, carCount: cars.length,
        missedInputs: 4, self, cars
    };
}

describe('snapshots', () => {
    it('lists every VehicleState key in the self block exactly once', () => {
        const keys = Object.keys(createVehicleState()).sort();
        expect([...SELF_BLOCK_KEYS].sort()).toEqual(keys);
        expect(new Set(SELF_BLOCK_KEYS).size).toBe(SELF_BLOCK_KEYS.length);
        // About 150 bytes (3.4), 32 per other car
        expect(SELF_BLOCK_BYTES).toBe(149);
        expect(COMPACT_BYTES).toBe(32);
        expect(SNAPSHOT_HEADER_BYTES).toBe(16);
    });

    it('carries the own car bit for bit', () => {
        const random = mulberry32(7);
        for (let i = 0; i < 20; i++) {
            const state = busyState(random);
            const self = { slot: 9, state, flags: CAR_IDLE | CAR_GROUNDED, mods: 21, input: input(-127, 255, 3, 15) };
            const decoded = decodeSnapshot(encodeSnapshot(snapshotWith([], self)))!;
            expect(decoded.self).toEqual(self);
            for (const key of Object.keys(state) as (keyof VehicleState)[]) {
                expect(Object.is(decoded.self!.state[key], state[key]), key).toBe(true);
            }
        }
    });

    it('round-trips the header and 0, 1 and 32 cars within half a quantisation step', () => {
        const random = mulberry32(11);
        for (const count of [0, 1, 32]) {
            const cars = Array.from({ length: count }, (_, i) => randomCar(i * 7 % 256, random));
            const snap = snapshotWith(cars, null);
            const bytes = encodeSnapshot(snap);
            expect(bytes.byteLength).toBe(SNAPSHOT_HEADER_BYTES + count * COMPACT_BYTES);
            const decoded = decodeSnapshot(bytes)!;
            expect({ ...decoded, cars: [] }).toEqual({ ...snap, cars: [] });
            decoded.cars.forEach((car, i) => {
                const original = cars[i];
                expect(car.slot).toBe(original.slot);
                expect(car.flags).toBe(original.flags);
                expect(car.input).toEqual(original.input);
                expect(Math.abs(car.x - original.x)).toBeLessThanOrEqual(POS_STEP / 2 + 1e-9);
                expect(Math.abs(car.z - original.z)).toBeLessThanOrEqual(POS_STEP / 2 + 1e-9);
                expect(Math.abs(car.y - original.y)).toBeLessThanOrEqual(0.005 + 1e-9);
                for (const key of ['vx', 'vy', 'vz'] as const) expect(Math.abs(car[key] - original[key])).toBeLessThanOrEqual(0.005 + 1e-9);
                const dyaw = Math.atan2(Math.sin(car.yaw - original.yaw), Math.cos(car.yaw - original.yaw));
                expect(Math.abs(dyaw)).toBeLessThanOrEqual(Math.PI / 65536 + 1e-9);
                expect(Math.abs(car.yawRate - original.yawRate)).toBeLessThanOrEqual(0.0005 + 1e-9);
                expect(Math.abs(car.steerAngle - original.steerAngle)).toBeLessThanOrEqual(0.0025 + 1e-9);
                expect(Math.abs(car.scale - original.scale)).toBeLessThanOrEqual(0.005 + 1e-9);
                expect(Math.abs(car.boostMeter - original.boostMeter)).toBeLessThanOrEqual(0.5 / 255 + 1e-9);
                expect(Math.abs(car.loadX - original.loadX)).toBeLessThanOrEqual(0.125 + 1e-9);
                expect(car.flipAngle > 0).toBe(original.flipAngle > 0);
            });
        }
    });

    it('wraps the yaw onto one turn', () => {
        for (const yaw of [0, Math.PI, -Math.PI, 7 * Math.PI, -0.0001, 1e6]) {
            const back = unquantYaw(quantYaw(yaw));
            expect(Math.abs(Math.atan2(Math.sin(back - yaw), Math.cos(back - yaw)))).toBeLessThan(1e-4);
        }
    });

    it('rejects broken frames and non-finite self blocks', () => {
        const random = mulberry32(3);
        const self = { slot: 1, state: busyState(random), flags: 0, mods: 0, input: input(0, 0, 0, 0) };
        const good = encodeSnapshot(snapshotWith([randomCar(2, random)], self));
        expect(decodeSnapshot(good)).not.toBeNull();
        expect(decodeSnapshot(good.subarray(0, good.byteLength - 1))).toBeNull();
        const moreCars = good.slice();
        moreCars[12] = 5;
        expect(decodeSnapshot(moreCars)).toBeNull();
        const noSelf = good.slice();
        noSelf[1] = 0;
        expect(decodeSnapshot(noSelf)).toBeNull();
        const nan = { ...self, state: { ...self.state, vx: NaN } };
        expect(decodeSnapshot(encodeSnapshot(snapshotWith([], nan)))).toBeNull();
        const inf = { ...self, state: { ...self.state, x: Infinity } };
        expect(decodeSnapshot(encodeSnapshot(snapshotWith([], inf)))).toBeNull();
        expect(decodeSnapshot(new Uint8Array([2, 0, 0]))).toBeNull();
    });

    it('encodes "no seq yet" and "no slack" distinctly', () => {
        const decoded = decodeSnapshot(encodeSnapshot({ ...snapshotWith([], null), lastProcessedSeq: -1, inputSlack: null }))!;
        expect(decoded.lastProcessedSeq).toBe(-1);
        expect(decoded.inputSlack).toBeNull();
    });
});

describe('modifier bits', () => {
    it('round-trip every combination', () => {
        for (let bits = 0; bits < 32; bits++) {
            const mods = bitsToMods(bits, createVehicleModifiers());
            expect(modsToBits(mods)).toBe(bits);
        }
    });
});

describe('decodeRemoteState', () => {
    it('fills a complete, finite state that neither jumps again nor boosts from nothing', () => {
        const random = mulberry32(5);
        for (let i = 0; i < 50; i++) {
            const car = randomCar(i, random);
            car.flags |= (i % 2 ? CAR_GHOST_EXIT : 0);
            const out = decodeRemoteState(car, busyState(random));
            for (const [key, value] of Object.entries(out)) {
                if (typeof value === 'number') expect(Number.isFinite(value), key).toBe(true);
            }
            expect(Object.keys(out).sort()).toEqual(Object.keys(createVehicleState()).sort());
            expect(out.prevButtons).toBe(car.input.buttons);
            expect(out.wallTicks).toBe(255);
            expect(out.grounded).toBe(true);
            expect(out.airTicks).toBe(0);
            expect(out.ghostExit).toBe(i % 2);
            expect(out.flipRate > 0).toBe(car.flipAngle > 0);
        }
    });
});

describe('quantisation (3.4)', () => {
    it('saturates every field at its range and maps non-finite values to 0', () => {
        // x/z: i24 in 1/4096 m, ±2048 m
        expect(quantPos(1e6)).toBe((1 << 23) - 1);
        expect(quantPos(-1e6)).toBe(-(1 << 23));
        expect(quantPos(1)).toBe(4096);
        // y: i16 in cm; speeds: i16 in cm/s; yaw rate: i16 in mrad/s
        expect(quantHeight(400)).toBe(32767);
        expect(quantHeight(-400)).toBe(-32768);
        expect(quantHeight(1.234)).toBe(123);
        expect(quantSpeed(1000)).toBe(32767);
        expect(quantSpeed(-1000)).toBe(-32768);
        expect(quantYawRate(40)).toBe(32767);
        expect(quantYawRate(-40)).toBe(-32768);
        // steer: i8 in 1/200 rad, symmetric ±127; load: i8 in 1/4
        expect(quantSteer(2)).toBe(127);
        expect(quantSteer(-2)).toBe(-127);
        expect(quantLoad(100)).toBe(127);
        expect(quantLoad(-100)).toBe(-127);
        // 0..1 in 1/255; scale 1..3.55 in 1/100; bytes 0..255
        expect(quantUnit(1.5)).toBe(255);
        expect(quantUnit(-0.5)).toBe(0);
        expect(quantUnit(0.5)).toBe(128);
        expect(quantScale(0.5)).toBe(0);
        expect(quantScale(9)).toBe(255);
        expect(quantScale(1.35)).toBe(35);
        expect(quantByte(300)).toBe(255);
        expect(quantByte(-3)).toBe(0);
        for (const bad of [NaN, Infinity, -Infinity]) {
            for (const quant of [quantPos, quantHeight, quantSpeed, quantYawRate, quantSteer, quantLoad, quantUnit, quantScale, quantByte, quantYaw, quantFlip]) {
                expect(quant(bad), `${quant.name}(${bad})`).toBe(0);
            }
        }
    });

    it('maps the yaw onto 0..65535 and back onto -π..π', () => {
        expect(quantYaw(0)).toBe(0);
        expect(quantYaw(Math.PI / 2)).toBe(16384);
        expect(quantYaw(-Math.PI / 2)).toBe(49152);
        // Just under a full turn rounds up to 65536, which is 0 again
        expect(quantYaw(2 * Math.PI - 1e-9)).toBe(0);
        expect(quantYaw(-1e-9)).toBe(0);
        expect(unquantYaw(16384)).toBeCloseTo(Math.PI / 2, 12);
        // Half a turn stays +π, one step more is just above -π
        expect(unquantYaw(32768)).toBeCloseTo(Math.PI, 12);
        expect(unquantYaw(32769)).toBeCloseTo(-Math.PI + 2 * Math.PI / 65536, 12);
        expect(unquantYaw(49152)).toBeCloseTo(-Math.PI / 2, 12);
    });

    it('keeps a running flip non-zero and wraps it onto one turn', () => {
        // 0 means "no flip", so a started flip is at least one step
        expect(quantFlip(0)).toBe(0);
        expect(quantFlip(-1)).toBe(0);
        expect(quantFlip(1e-6)).toBe(1);
        expect(quantFlip(Math.PI)).toBe(128);
        expect(quantFlip(Math.PI / 2)).toBe(64);
        // Just under a full turn stays on the last step, one and a half turns wrap
        expect(quantFlip(2 * Math.PI - 1e-6)).toBe(255);
        expect(quantFlip(3 * Math.PI)).toBe(128);
        expect(unquantFlip(64)).toBeCloseTo(Math.PI / 2, 12);
        expect(unquantFlip(255)).toBeCloseTo(2 * Math.PI * 255 / 256, 12);
    });
});

describe('car flags', () => {
    it('turn each powerup flag into its modifier, both shields into shield', () => {
        const none = { turbo: false, mega: false, superJump: false, ghost: false, shield: false };
        const mods = (flags: number) => flagsToMods(flags, createVehicleModifiers());
        expect(mods(0)).toEqual(none);
        expect(mods(CAR_TURBO)).toEqual({ ...none, turbo: true });
        expect(mods(CAR_MEGA)).toEqual({ ...none, mega: true });
        expect(mods(CAR_SUPER_JUMP)).toEqual({ ...none, superJump: true });
        expect(mods(CAR_GHOST)).toEqual({ ...none, ghost: true });
        expect(mods(CAR_SHIELD)).toEqual({ ...none, shield: true });
        expect(mods(CAR_RESPAWN_SHIELD)).toEqual({ ...none, shield: true });
        // Flags that are no modifier leave them all off
        expect(mods(CAR_GROUNDED | CAR_BOOSTING | CAR_IDLE | CAR_FLIPPING)).toEqual(none);
        // Bits the same flags would have as modifier bits do not leak in
        expect(mods(MOD_TURBO | MOD_MEGA | MOD_SUPER_JUMP)).toEqual(none);
    });

    it('derive each state flag from its own field', () => {
        const flagsOf = (patch: Partial<VehicleState>) => stateFlags({ ...createVehicleState(), grounded: false, ...patch });
        expect(flagsOf({})).toBe(0);
        expect(flagsOf({ grounded: true })).toBe(CAR_GROUNDED);
        expect(flagsOf({ boosting: true })).toBe(CAR_BOOSTING);
        expect(flagsOf({ driftTicks: 1 })).toBe(CAR_DRIFTING);
        expect(flagsOf({ flipAngle: 0.1 })).toBe(CAR_FLIPPING);
        expect(flagsOf({ wasGhost: true })).toBe(CAR_WAS_GHOST);
        expect(flagsOf({ ghostExit: 1 })).toBe(CAR_GHOST_EXIT);
        expect(flagsOf({ grounded: true, boosting: true, driftTicks: 30, flipAngle: 3, wasGhost: true, ghostExit: 9 }))
            .toBe(CAR_GROUNDED | CAR_BOOSTING | CAR_DRIFTING | CAR_FLIPPING | CAR_WAS_GHOST | CAR_GHOST_EXIT);
    });
});

describe('decodeRemoteState derives what the record does not carry', () => {
    function record(flags: number, patch: Partial<CompactCar> = {}): CompactCar {
        return {
            slot: 3, flags, x: 1, y: 2, z: 3, yaw: 0, vx: 10, vy: 0, vz: 10, yawRate: 0.5, steerAngle: 0.1,
            input: input(0, 0, 0, 4), scale: 1, flipAngle: 0, boostMeter: 0.5, rearGrip: 0.7, loadX: 2, ghostTicks: 0,
            ...patch
        };
    }

    it('slip angle from the velocity along and across the heading', () => {
        // Heading +z at 10 m/s, sliding 10 m/s towards +x: β = atan2(10, 10)
        expect(decodeRemoteState(record(CAR_GROUNDED), createVehicleState()).betaPrev).toBeCloseTo(Math.PI / 4, 12);
        // Heading +x (yaw π/2) at 10 m/s, sliding towards +z: -π/4
        expect(decodeRemoteState(record(CAR_GROUNDED, { yaw: Math.PI / 2, vx: 10, vz: 10 }), createVehicleState()).betaPrev)
            .toBeCloseTo(-Math.PI / 4, 12);
        // At 1 m/s or less along the heading there is no slip angle
        expect(decodeRemoteState(record(CAR_GROUNDED, { vz: 1 }), createVehicleState()).betaPrev).toBe(0);
    });

    it('air, boost, drift, ghost and flip from the flags', () => {
        const flying = decodeRemoteState(record(CAR_BOOSTING | CAR_DRIFTING | CAR_WAS_GHOST | CAR_FLIPPING, { flipAngle: 1 }), createVehicleState());
        // In the air past the coyote time (6 ticks): no jump from the ground
        expect(flying.grounded).toBe(false);
        expect(flying.airTicks).toBe(7);
        expect(flying.boosting).toBe(true);
        expect(flying.driftTicks).toBe(1);
        expect(flying.wasGhost).toBe(true);
        expect(flying.ghostExit).toBe(0);
        // One turn in 1.1 s (the standard jump)
        expect(flying.flipRate).toBeCloseTo(2 * Math.PI / 1.1, 12);
        expect(flying.flipAngle).toBe(1);
        const plain = decodeRemoteState(record(CAR_GROUNDED), createVehicleState());
        expect(plain.boosting).toBe(false);
        expect(plain.driftTicks).toBe(0);
        expect(plain.wasGhost).toBe(false);
        expect(plain.flipRate).toBe(0);
        expect({ x: plain.x, y: plain.y, z: plain.z, yawRate: plain.yawRate, steerAngle: plain.steerAngle, loadX: plain.loadX, rearGrip: plain.rearGrip, boostMeter: plain.boostMeter, scale: plain.scale })
            .toEqual({ x: 1, y: 2, z: 3, yawRate: 0.5, steerAngle: 0.1, loadX: 2, rearGrip: 0.7, boostMeter: 0.5, scale: 1 });
    });
});

describe('snapshot header edge cases', () => {
    it('keeps seq 0 apart from "none yet" and clamps the slack short of NO_SLACK', () => {
        const at = (patch: Partial<Snapshot>) => decodeSnapshot(encodeSnapshot({ ...snapshotWith([], null), ...patch }))!;
        expect(at({ lastProcessedSeq: 0 }).lastProcessedSeq).toBe(0);
        expect(at({ inputSlack: 0 }).inputSlack).toBe(0);
        expect(at({ inputSlack: 500 }).inputSlack).toBe(127);
        expect(at({ inputSlack: -500 }).inputSlack).toBe(-127);
        expect(at({ inputSlack: 2.6 }).inputSlack).toBe(3);
    });

    it('rejects an input frame, a short header and a count that does not match the length', () => {
        const input1 = encodeInputPacket({ flags: 0, seq: 1, tick: 2, inputs: [input(0, 0, 0, 0)] });
        expect(decodeSnapshot(input1)).toBeNull();
        const good = encodeSnapshot(snapshotWith([randomCar(1, mulberry32(1))], null));
        expect(decodeSnapshot(good.subarray(0, 15))).toBeNull();
        const wrongKind = good.slice();
        wrongKind[0] = FRAME_INPUT;
        expect(decodeSnapshot(wrongKind)).toBeNull();
        const fewerCars = good.slice();
        fewerCars[12] = 0;
        expect(decodeSnapshot(fewerCars)).toBeNull();
        // An input decoder handed a snapshot says no as well
        expect(decodeInputPacket(good)).toBeNull();
    });

    it('carries rear grip, flip angle and ghost ticks of the other cars', () => {
        const car = { ...randomCar(4, mulberry32(2)), rearGrip: 0.3, flipAngle: 2, ghostTicks: 77, flags: CAR_FLIPPING };
        const back = decodeSnapshot(encodeSnapshot(snapshotWith([car], null)))!.cars[0];
        expect(Math.abs(back.rearGrip - 0.3)).toBeLessThanOrEqual(0.5 / 255);
        expect(Math.abs(back.flipAngle - 2)).toBeLessThanOrEqual(Math.PI / 256);
        expect(back.ghostTicks).toBe(77);
        // Full grip comes back as exactly 1
        const full = decodeSnapshot(encodeSnapshot(snapshotWith([{ ...car, rearGrip: 1, boostMeter: 1 }], null)))!.cars[0];
        expect(full.rearGrip).toBe(1);
        expect(full.boostMeter).toBe(1);
    });
});
