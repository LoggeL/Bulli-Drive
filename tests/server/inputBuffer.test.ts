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
        expect(buffer.take(1)!.input).toEqual({ steer: -127, throttle: 255, brake: 0, buttons: 0x0f });
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
