import { describe, expect, it } from 'vitest';
import {
    CAR_FLIPPING, CAR_GHOST_EXIT, CAR_GROUNDED, CAR_IDLE, COMPACT_BYTES, decodeInputPacket, decodeRemoteState,
    decodeSnapshot, encodeInputPacket, encodeSnapshot, INPUT_FROZEN, inputPacketSize, SELF_BLOCK_BYTES, SELF_BLOCK_KEYS,
    SNAPSHOT_HEADER_BYTES, bitsToMods, modsToBits, type CompactCar, type InputPacket, type Snapshot
} from '../../../src/shared/net/codec.js';
import { POS_STEP, quantYaw, unquantYaw } from '../../../src/shared/net/quant.js';
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
