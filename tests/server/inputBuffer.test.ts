import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mapFor } from '../../src/server/maps.js';
import { InputBuffer } from '../../src/server/rooms/InputBuffer.js';
import { RoomManager } from '../../src/server/rooms/lobby.js';
import { INPUT_MAX_AHEAD } from '../../src/shared/net/constants.js';
import { stopInput } from '../../src/shared/sim/inputs.js';
import { createFlatWorld, forwardSpeed, spawnCar } from '../../src/shared/sim/scenarios.js';
import { createVehicleInput } from '../../src/shared/sim/types.js';
import { stepVehicle } from '../../src/shared/sim/world.js';
import { feed, fakeSession, ready, steps } from './helpers.js';

// Inputs on the server (docs/phase-1b-design.md, 5.2, 5.3 and 15.1).

const gas = { steer: 0, throttle: 255, brake: 0, buttons: 0 };

describe('InputBuffer', () => {
    it('drops late, far-future and duplicate inputs', () => {
        const buffer = new InputBuffer();
        buffer.lastStepped = 100;
        // Newest first: ticks 103, 102, 101, 100 (100 is late)
        buffer.accept({ flags: 0, seq: 13, tick: 103, inputs: [gas, gas, gas, gas] }, 100, 0);
        expect([buffer.accepted, buffer.late]).toEqual([3, 1]);
        // 102 and 103 again (redundancy), 104 new
        buffer.accept({ flags: 0, seq: 14, tick: 104, inputs: [gas, gas, gas] }, 100, 16);
        expect([buffer.accepted, buffer.duplicates]).toEqual([4, 2]);
        buffer.accept({ flags: 0, seq: 99, tick: 100 + INPUT_MAX_AHEAD + 1, inputs: [gas] }, 100, 32);
        expect(buffer.early).toBe(1);
        expect(buffer.take(101)?.seq).toBe(11);
        expect(buffer.take(102)?.seq).toBe(12);
        expect(buffer.take(105)).toBeNull();
        // After take, the tick counts as simulated
        buffer.accept({ flags: 0, seq: 20, tick: 105, inputs: [gas] }, 105, 48);
        expect(buffer.late).toBe(2);
    });

    it('still reports the slack after inputs far in the future (the old room right after a switch)', () => {
        const buffer = new InputBuffer();
        // Ticks of the room the client just left, 3000 ahead of this one
        buffer.accept({ flags: 0, seq: 1, tick: 3100, inputs: [gas, gas, gas] }, 100, 0);
        expect(buffer.early).toBe(3);
        expect(buffer.takeWindow().slack).toBe(2998);
        // The client's first inputs for this room: 2 ticks early, and seen
        buffer.accept({ flags: 0, seq: 2, tick: 102, inputs: [gas] }, 100, 16);
        buffer.accept({ flags: 0, seq: 3, tick: 103, inputs: [gas, gas] }, 101, 32);
        expect(buffer.takeWindow().slack).toBe(2);
        // Once past what the far packet could have reached, new ones count again
        buffer.accept({ flags: 0, seq: 4, tick: 100 + INPUT_MAX_AHEAD + 1, inputs: [gas] }, 100 + INPUT_MAX_AHEAD - 1, 48);
        expect(buffer.takeWindow().slack).toBe(2);
    });

    it('clamps the values into the quantised ranges', () => {
        const buffer = new InputBuffer();
        buffer.accept({ flags: 0, seq: 1, tick: 1, inputs: [{ steer: -128, throttle: 255, brake: 0, buttons: 0xff }] }, 0, 0);
        // Only handbrake, boost and reset (1 | 2 | 8) are left: bit 4 was the
        // removed jump (docs/phase-1a-design.md, 26)
        expect(buffer.take(1)!.input).toEqual({ steer: -127, throttle: 255, brake: 0, buttons: 0x0b });
    });

    it('reports the smallest lead of the window and the jitter target', () => {
        const buffer = new InputBuffer();
        buffer.accept({ flags: 0, seq: 3, tick: 13, inputs: [gas, gas, gas] }, 9, 0);
        buffer.accept({ flags: 0, seq: 4, tick: 14, inputs: [gas, gas, gas] }, 10, 16);
        expect(buffer.takeWindow()).toEqual({ slack: 2, missed: 0 });
        expect(buffer.takeWindow()).toEqual({ slack: null, missed: 0 });
        // A new input that comes too late: negative slack
        buffer.accept({ flags: 0, seq: 5, tick: 15, inputs: [gas] }, 17, 32);
        expect(buffer.takeWindow().slack).toBe(-2);
        // Redundant copies of inputs that arrived before do not count, even
        // late; a late new one behind a timely newest one does
        buffer.accept({ flags: 0, seq: 7, tick: 20, inputs: [gas, gas, gas, gas] }, 18, 48);
        expect(buffer.takeWindow().slack).toBe(-1);
        buffer.accept({ flags: 0, seq: 8, tick: 21, inputs: [gas, gas, gas] }, 18, 64);
        expect(buffer.takeWindow().slack).toBe(3);

        // Regular arrivals every 16.7 ms: 1 tick; bursts of 50 ms: 3
        const regular = new InputBuffer();
        for (let i = 0; i < 60; i++) regular.accept({ flags: 0, seq: i + 1, tick: i + 2, inputs: [gas] }, i, i * 16.7);
        expect(regular.updateBufferTarget()).toBe(1);
        const bursty = new InputBuffer();
        for (let i = 0; i < 60; i++) bursty.accept({ flags: 0, seq: i + 1, tick: i + 2, inputs: [gas] }, i, i * 16.7 + (i % 3 === 0 ? 40 : 0));
        expect(bursty.updateBufferTarget()).toBe(3);
    });
});

describe('stopInput', () => {
    it('brakes a car from 30 m/s to a standstill without reversing', () => {
        const world = createFlatWorld();
        const car = spawnCar(world, 'a', 'bulli', 0, 0, 0, 30);
        for (let t = 0; t < 600; t++) {
            stopInput(car.state, car.input);
            stepVehicle(car, world);
            expect(forwardSpeed(car.state)).toBeGreaterThanOrEqual(-0.01);
        }
        expect(Math.abs(forwardSpeed(car.state))).toBeLessThan(0.05);
    });

    it('stops a car reversing at 10 m/s and does not drive off', () => {
        const world = createFlatWorld();
        const car = spawnCar(world, 'a', 'bulli', 0, 0, 0, -10);
        for (let t = 0; t < 600; t++) {
            stopInput(car.state, car.input);
            stepVehicle(car, world);
            expect(forwardSpeed(car.state)).toBeLessThanOrEqual(0.01);
        }
        expect(Math.abs(forwardSpeed(car.state))).toBeLessThan(0.05);
        const input = stopInput(car.state, createVehicleInput());
        expect(input).toEqual({ steer: 0, throttle: 0, brake: 0, buttons: 0 });
    });
});

describe('InputBuffer rules in detail', () => {
    const one = (tick: number, seq = tick) => ({ flags: 0, seq, tick, inputs: [gas] });

    it('counts an input as late once its tick was stepped or the room is past it', () => {
        // Stepped further than the room tick says (a take ran ahead)
        const stepped = new InputBuffer();
        stepped.lastStepped = 105;
        stepped.accept(one(103), 100, 0);
        expect([stepped.late, stepped.accepted]).toEqual([1, 0]);
        // Never stepped, but the room already ran tick 100
        const behind = new InputBuffer();
        behind.accept(one(100), 100, 0);
        behind.accept(one(101), 100, 0);
        expect([behind.late, behind.accepted]).toEqual([1, 1]);
    });

    it('takes inputs up to 60 ticks ahead (docs/phase-1b-design.md, 4 and 20.5)', () => {
        const buffer = new InputBuffer();
        buffer.accept(one(160), 100, 0);
        buffer.accept(one(161), 100, 0);
        expect([buffer.accepted, buffer.early]).toEqual([1, 1]);
        expect(buffer.take(160)?.seq).toBe(160);
    });

    it('forgets every stored input on clear()', () => {
        const buffer = new InputBuffer();
        buffer.accept({ flags: 0, seq: 3, tick: 3, inputs: [gas, gas, gas] }, 0, 0);
        buffer.clear();
        expect([buffer.take(1), buffer.take(2), buffer.take(3)]).toEqual([null, null, null]);
    });

    // 10 or more arrival gaps (ms) -> bufferTarget from p90 - p10:
    // < 8 ms -> 1, < 25 ms -> 2, else 3 (5.2)
    function targetFor(gaps: number[]): number {
        const buffer = new InputBuffer();
        let t = 0;
        buffer.accept(one(1), 0, t);
        gaps.forEach((gap, i) => {
            t += gap;
            buffer.accept(one(i + 2), i + 1, t);
        });
        return buffer.updateBufferTarget();
    }

    it('turns the arrival jitter into the lead target at 8 and 25 ms', () => {
        // 10 gaps: p90 is rank 8, p10 rank 0 of the sorted gaps
        const spread = (jitter: number) => [...Array(8).fill(10), 10 + jitter, 10 + jitter];
        expect(targetFor(spread(7.9))).toBe(1);
        expect(targetFor(spread(8))).toBe(2);
        expect(targetFor(spread(24.9))).toBe(2);
        expect(targetFor(spread(25))).toBe(3);
        expect(targetFor(spread(500))).toBe(3);
    });

    it('needs 10 gaps, the first one counted from an arrival at 0 ms', () => {
        const bursty = [...Array(8).fill(10), 60, 60];
        expect(targetFor(bursty)).toBe(3);
        // 9 gaps: too few, the target stays at 1
        expect(targetFor(bursty.slice(1))).toBe(1);
    });

    it('takes p10 and p90 by rank, so one outlier on each side does not count', () => {
        // 20 gaps: p10 is rank floor(0.1 · 19) = 1, p90 rank floor(0.9 · 19) = 17
        const gaps = [0, ...Array(17).fill(10), 60, 60];
        expect(targetFor(gaps)).toBe(1);
    });
});

describe('Room: missing inputs', () => {
    let lobby: RoomManager;
    beforeEach(() => {
        lobby = new RoomManager(mapFor(), { maxPlayersPerRoom: 32, emptyRoomTtlMs: 60_000 });
    });
    afterEach(() => {
        for (const room of lobby.list()) room.dispose();
    });

    it('repeats the last input for exactly 15 ticks, then stops the car', () => {
        const alice = fakeSession();
        lobby.join(alice, 'freeroam');
        ready(lobby, alice);
        const room = alice.room!;
        steps(room, 1);
        const car = alice.member!.car!;
        for (let i = 0; i < 30; i++) {
            feed(room, alice, gas);
            steps(room, 1);
        }
        expect(car.input.throttle).toBe(255);
        // 15 ticks (250 ms, docs/phase-1b-design.md, 4 and 15.1) with the last input
        for (let i = 1; i <= 15; i++) {
            steps(room, 1);
            expect(car.input.throttle, `repeat ${i}`).toBe(255);
        }
        steps(room, 1);
        expect(car.input).toEqual({ steer: 0, throttle: 0, brake: 255, buttons: 0 });
        // The snapshots count the missed ticks and keep the last applied seq
        steps(room, 6);
        const snap = alice.transport.lastSnapshot!;
        expect(snap.lastProcessedSeq).toBe(31);
        expect(snap.missedInputs).toBeGreaterThan(0);
    });
});
