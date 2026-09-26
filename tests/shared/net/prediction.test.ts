import { describe, expect, it } from 'vitest';
import { CAR_IDLE, CAR_RACE_GHOST, INPUT_FROZEN, type CompactCar, type Snapshot } from '../../../src/shared/net/codec.js';
import { Prediction, type SlotInfo } from '../../../src/shared/net/prediction.js';
import { createFlatWorld } from '../../../src/shared/sim/scenarios.js';
import { createVehicleInput, createVehicleState, type VehicleInput, type VehicleState } from '../../../src/shared/sim/types.js';
import { createSimCar } from '../../../src/shared/sim/vehicle.js';

// Prediction and reconciliation of the own car and the contact set
// (docs/phase-1b-design.md, 8.4 and 8.5), driven with hand-made snapshots.
// Values from the design: a correction below 1 mm, 1 mm/s and 1e-4 rad is
// none; from 4 m or 45° the car jumps; remote cars within
// 15 m + |v_rel| · lead (at most 45 m, 5 m more to leave) are predicted
// along, at most 6, input repeated up to 15 ticks past the snapshot, full
// contact up to 9 ticks of lead, down to half at 15.

const gas: VehicleInput = { steer: 20, throttle: 255, brake: 0, buttons: 0 };

function setup(slots: Record<number, SlotInfo> = {}) {
    const world = createFlatWorld();
    const car = createSimCar('me', 'bulli', 'standard');
    const p = new Prediction(car, world, slot => slots[slot] ?? null);
    return { p, world };
}

// Spawned at the origin at the end of tick 0, then `ticks` ticks with gas
function driving(ticks: number, slots: Record<number, SlotInfo> = {}) {
    const s = setup(slots);
    s.p.startAt(1);
    s.p.spawnAt(0, 0, 0, 0);
    for (let i = 0; i < ticks; i++) s.p.advance(gas, 0);
    return s;
}

function snapshot(serverTick: number, self: VehicleState | null, cars: CompactCar[] = [], lastProcessedSeq = -1, flags = 0): Snapshot {
    return {
        serverTick, lastProcessedSeq, inputSlack: null, bufferTarget: 1, carCount: cars.length, missedInputs: 0,
        self: self ? { slot: 0, state: self, flags, mods: 0, input: createVehicleInput() } : null,
        cars
    };
}

function predicted(p: Prediction, tick: number): VehicleState {
    const s = createVehicleState();
    expect(p.stateAt(tick, s)).toBe(true);
    return s;
}

function record(slot: number, x: number, z: number, patch: Partial<CompactCar> = {}): CompactCar {
    return {
        slot, flags: 1, x, y: 0, z, yaw: 0, vx: 0, vy: 0, vz: 0, yawRate: 0, steerAngle: 0,
        input: { steer: 0, throttle: 0, brake: 0, buttons: 0 }, scale: 1, susp: 0, boostMeter: 0,
        rearGrip: 1, loadX: 0, ghostTicks: 0, ...patch
    };
}

const info = (slot: number, classId: SlotInfo['classId'] = 'beetle'): SlotInfo => ({ id: `r${slot}`, classId, profile: 'standard' });

describe('reconcile: when a snapshot counts as a correction', () => {
    it('takes the first snapshot as a snap, then matches the prediction exactly', () => {
        const { p } = driving(12);
        const first = p.reconcile(snapshot(2, predicted(p, 2)))!;
        expect(first).toEqual(expect.objectContaining({ matched: false, snapped: true, replayedTicks: 10, error: 0, yawError: 0 }));
        const second = p.reconcile(snapshot(5, predicted(p, 5)))!;
        expect(second.matched).toBe(true);
        // An old or repeated snapshot is ignored
        expect(p.reconcile(snapshot(5, predicted(p, 5)))).toBeNull();
        expect(p.reconcile(snapshot(4, predicted(p, 4)))).toBeNull();
    });

    it('corrects a difference of 1.5 mm, 1.5 mm/s or 1.5e-4 rad in any single axis, not one of a third of that', () => {
        const fields: [keyof VehicleState, number][] = [
            ['x', 1e-3], ['y', 1e-3], ['z', 1e-3], ['vx', 1e-3], ['vy', 1e-3], ['vz', 1e-3], ['yaw', 1e-4]
        ];
        for (const [key, tolerance] of fields) {
            const { p } = driving(40);
            p.reconcile(snapshot(2, predicted(p, 2)));
            let ts = 3;
            const withOffset = (factor: number) => {
                const s = predicted(p, ts);
                (s as unknown as Record<string, number>)[key] += factor * tolerance;
                return p.reconcile(snapshot(ts++, s))!;
            };
            expect(withOffset(0.3).matched, `${key} +0.3`).toBe(true);
            expect(withOffset(-0.3).matched, `${key} -0.3`).toBe(true);
            const over = withOffset(1.5);
            expect(over.matched, `${key} +1.5`).toBe(false);
            expect(over.replayedTicks).toBe(40 - (ts - 1));
            expect(withOffset(-1.5).matched, `${key} -1.5`).toBe(false);
            if (key === 'yaw') expect(over.yawError).toBeCloseTo(1.5e-4, 9);
            if (key === 'x' || key === 'z' || key === 'y') expect(over.error).toBeCloseTo(1.5e-3, 9);
        }
    });

    it('snaps from 4 m or 45°, smooths below', () => {
        const at = (dx: number, dyaw: number) => {
            const { p } = driving(20);
            p.reconcile(snapshot(2, predicted(p, 2)));
            const s = predicted(p, 5);
            s.x += dx;
            s.yaw += dyaw;
            return p.reconcile(snapshot(5, s))!;
        };
        expect(at(3.9, 0).snapped).toBe(false);
        expect(at(3.9, 0).error).toBeCloseTo(3.9, 9);
        expect(at(4, 0).snapped).toBe(true);
        expect(at(0, Math.PI / 4 - 0.01).snapped).toBe(false);
        expect(at(0, Math.PI / 4 + 0.01).snapped).toBe(true);
        expect(at(0, Math.PI / 4 + 0.01).yawError).toBeCloseTo(Math.PI / 4 + 0.01, 9);
    });

    it('reports inputs the server repeated or stopped', () => {
        const { p } = driving(20);
        p.reconcile(snapshot(2, predicted(p, 2)));
        // Tick 6 went out with seq 6 (seq counts the advanced ticks)
        expect(p.entry(6)!.seq).toBe(6);
        expect(p.reconcile(snapshot(6, predicted(p, 6), [], 5))!.lostInputs).toBe(true);
        expect(p.reconcile(snapshot(7, predicted(p, 7), [], 7))!.lostInputs).toBe(false);
        expect(p.reconcile(snapshot(8, predicted(p, 8), [], -1))!.lostInputs).toBe(false);
    });

    it('takes the server state as it is when the snapshot is ahead of the prediction', () => {
        const { p } = driving(5);
        const server = predicted(p, 5);
        const x5 = server.x;
        server.x = 7;
        const result = p.reconcile(snapshot(9, server))!;
        expect(result.replayedTicks).toBe(0);
        expect(p.tick).toBe(9);
        expect(p.car.state.x).toBe(7);
        // Measured against the car as it was (after tick 5)
        expect(result.error).toBeCloseTo(7 - x5, 9);
    });
});

describe('prediction lifecycle', () => {
    it('ignores the own car before the spawn, adopts it after a resume, forgets it after a despawn', () => {
        const { p } = setup();
        p.startAt(1);
        for (let i = 0; i < 5; i++) p.advance(gas, 0);
        const server = createVehicleState();
        server.x = 12;
        // Not spawned: nothing to reconcile
        expect(p.reconcile(snapshot(2, server))).toBeNull();
        expect(p.spawned).toBe(false);
        // A resumed session takes the car from the next snapshot with it
        p.adoptNext = true;
        p.reconcile(snapshot(3, server));
        expect(p.spawned).toBe(true);
        expect(p.car.state.x).toBeCloseTo(12, 1);
        p.despawn();
        expect(p.reconcile(snapshot(4, server))).toBeNull();
        expect(p.stateAt(3, createVehicleState())).toBe(false);
        // Adopted again where the car already is: still a snap, not a smoothed 0
        p.adoptNext = true;
        const again = p.reconcile(snapshot(5, { ...p.car.state }))!;
        expect(again.error).toBe(0);
        expect(again.snapped).toBe(true);
    });

    it('jumps forward only, and restarts the count with startAt', () => {
        const { p } = driving(5);
        expect(p.tick).toBe(5);
        p.jumpTo(4);
        p.jumpTo(6);
        expect(p.tick).toBe(5);
        p.jumpTo(10);
        expect(p.tick).toBe(9);
        p.reconcile(snapshot(3, predicted(p, 3)));
        expect(p.lead).toBe(6);
        p.startAt(100);
        expect(p.tick).toBe(99);
        expect(p.stateAt(3, createVehicleState())).toBe(false);
        // After startAt the next snapshot snaps again
        p.advance(gas, 0);
        p.advance(gas, 0);
        const s = predicted(p, 101);
        expect(p.reconcile(snapshot(101, s))!.snapped).toBe(true);
    });

    it('repeats the last input for 15 ticks over a gap in the history, then stops', () => {
        const { p } = driving(3);
        p.reconcile(snapshot(1, predicted(p, 1)));
        // Ticks 4..24 got no input (the client skipped ahead)
        p.jumpTo(25);
        p.advance(gas, 0);
        const server = predicted(p, 2);
        server.x += 0.01;
        p.reconcile(snapshot(2, server));
        // Repeat for tick - 2 <= 15, i.e. up to tick 17; then the stop input
        expect(p.entry(10)!.input).toEqual(gas);
        expect(p.entry(17)!.input).toEqual(gas);
        expect(p.entry(18)!.input).toEqual({ steer: 0, throttle: 0, brake: 255, buttons: 0 });
    });

    it('holds the idle ghost for a frozen or idle own car and hands over 60 ghost ticks after it', () => {
        // Without the spawn's contact ghost
        const { p } = driving(3);
        p.car.state.ghostTicks = 0;
        p.advance(gas, INPUT_FROZEN);
        expect(p.car.state.ghostTicks).toBeGreaterThanOrEqual(1);
        p.advance(gas, 0);
        // 60 set before the tick, one counted down in it
        expect(p.car.state.ghostTicks).toBe(59);
        const idle = driving(3);
        const server = predicted(idle.p, 3);
        server.ghostTicks = 0;
        idle.p.reconcile(snapshot(3, server, [], -1, CAR_IDLE));
        idle.p.advance(gas, 0);
        expect(idle.p.car.state.ghostTicks).toBeGreaterThanOrEqual(1);
        const plain = driving(3);
        plain.p.car.state.ghostTicks = 0;
        plain.p.advance(gas, 0);
        expect(plain.p.car.state.ghostTicks).toBe(0);
    });

    it('holds the contact ghost while the server flags the own car a race ghost (wrong way, finished; phase 2, 11)', () => {
        const race = driving(3);
        const server = predicted(race.p, 3);
        server.ghostTicks = 0;
        race.p.reconcile(snapshot(3, server, [], -1, CAR_RACE_GHOST));
        race.p.advance(gas, 0);
        expect(race.p.car.state.ghostTicks).toBeGreaterThanOrEqual(1);
    });
});

describe('contact set', () => {
    const slots = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i + 1, info(i + 1)]));

    // Own car resting at the origin, lead = ticks - 2
    function atRest(ticks: number) {
        const s = setup(slots);
        s.p.startAt(1);
        s.p.spawnAt(0, 0, 0, 0);
        for (let i = 0; i < ticks; i++) s.p.advance(createVehicleInput(), 0);
        return s;
    }

    it('takes cars within 15 m plus the relative speed times the lead, at most 45 m', () => {
        // Lead 10 ticks = 1/6 s
        const { p } = atRest(12);
        p.reconcile(snapshot(2, predicted(p, 2), [
            record(1, 14.9, 0),                        // within 15 m
            record(2, 0, 20),                          // 20 m, standing: out
            record(3, 0, -24.9, { vz: 60 }),           // 15 + 60/6 = 25 m: in
            record(4, -30, 0, { vx: 600 }),            // capped at 45 m: in
            record(5, 0, 46, { vz: -600 }),            // capped at 45 m: out
            record(6, 30, 30, { flags: 1 })            // unknown to nobody, 42 m, standing: out
        ]));
        expect([...p.remotes.keys()].sort()).toEqual([1, 3, 4]);
    });

    it('keeps a car in the set up to 5 m further out', () => {
        const { p } = atRest(20);
        p.reconcile(snapshot(2, predicted(p, 2), [record(1, 10, 0), record(2, 17, 0)]));
        expect([...p.remotes.keys()]).toEqual([1]);
        p.reconcile(snapshot(3, predicted(p, 3), [record(1, 19.9, 0), record(2, 17, 0)]));
        expect([...p.remotes.keys()]).toEqual([1]);
        p.reconcile(snapshot(4, predicted(p, 4), [record(1, 20.1, 0)]));
        expect(p.remotes.size).toBe(0);
    });

    it('keeps the 6 nearest cars', () => {
        const { p } = atRest(12);
        const cars = [9, 3, 8, 4, 7, 5, 6, 2].map((d, i) => {
            const angle = i * Math.PI / 4;
            return record(i + 1, d * Math.cos(angle), d * Math.sin(angle));
        });
        p.reconcile(snapshot(2, predicted(p, 2), cars));
        // The two farthest (9 m: slot 1, 8 m: slot 3) are left out
        expect([...p.remotes.keys()].sort()).toEqual([2, 4, 5, 6, 7, 8]);
    });

    it('reuses the sim car of a remote that left and came back, unless its car changed', () => {
        const { p } = atRest(12);
        p.reconcile(snapshot(2, predicted(p, 2), [record(1, 10, 0)]));
        const first = p.remotes.get(1)!;
        p.reconcile(snapshot(3, predicted(p, 3), []));
        expect(p.remotes.size).toBe(0);
        p.reconcile(snapshot(4, predicted(p, 4), [record(1, 10, 0)]));
        expect(p.remotes.get(1)).toBe(first);
        // Now a jeep behind the same slot and id, in the set
        slots[1] = info(1, 'jeep');
        p.reconcile(snapshot(5, predicted(p, 5), [record(1, 10, 0)]));
        const jeep = p.remotes.get(1)!;
        expect(jeep).not.toBe(first);
        expect(jeep.classId).toBe('jeep');
        // Out of the set, back as a beetle: the spare jeep is not taken
        p.reconcile(snapshot(6, predicted(p, 6), []));
        slots[1] = info(1);
        p.reconcile(snapshot(7, predicted(p, 7), [record(1, 10, 0)]));
        expect(p.remotes.get(1)).not.toBe(jeep);
        expect(p.remotes.get(1)!.classId).toBe('beetle');
    });

    it('softens the contact with the lead and stops repeating gas after 15 ticks', () => {
        const scaleAt = (lead: number) => {
            const { p } = atRest(2 + lead);
            p.reconcile(snapshot(2, predicted(p, 2), [record(1, 10, 0, { input: { steer: 30, throttle: 255, brake: 0, buttons: 0 } })]));
            return p.remotes.get(1)!.car;
        };
        expect(scaleAt(5).contactScale).toBe(1);
        expect(scaleAt(9).contactScale).toBe(1);
        // 1 - 0.5 · (12 - 9) / 6
        expect(scaleAt(12).contactScale).toBeCloseTo(0.75, 12);
        expect(scaleAt(15).contactScale).toBe(0.5);
        expect(scaleAt(20).contactScale).toBe(0.5);
        // Up to 15 ticks ahead the last input is repeated; beyond, it rolls
        expect(scaleAt(15).input.throttle).toBe(255);
        expect(scaleAt(16).input).toEqual({ steer: 30, throttle: 0, brake: 0, buttons: 0 });
    });

    it('treats an idle remote as a contact ghost', () => {
        const { p } = atRest(12);
        p.reconcile(snapshot(2, predicted(p, 2), [record(1, 10, 0, { flags: 1 | CAR_IDLE }), record(2, -10, 0)]));
        expect(p.remotes.get(1)!.car.state.ghostTicks).toBeGreaterThanOrEqual(1);
        expect(p.remotes.get(2)!.car.state.ghostTicks).toBe(0);
    });

    it('treats a race ghost remote (wrong way, finished, DNF) as a contact ghost', () => {
        const { p } = atRest(12);
        p.reconcile(snapshot(2, predicted(p, 2), [record(1, 10, 0, { flags: 1 | CAR_RACE_GHOST }), record(2, -10, 0)]));
        expect(p.remotes.get(1)!.car.state.ghostTicks).toBeGreaterThanOrEqual(1);
        expect(p.remotes.get(2)!.car.state.ghostTicks).toBe(0);
    });

    it('reports a contact when a remote touches the own car in the replay', () => {
        const { p } = atRest(12);
        // Without the spawn's contact ghost
        const own = (tick: number) => ({ ...predicted(p, tick), ghostTicks: 0 });
        const apart = p.reconcile(snapshot(2, own(2), [record(1, 12, 0)]))!;
        expect(apart.contact).toBe(false);
        const touching = p.reconcile(snapshot(3, own(3), [record(1, 2.2, 0, { vx: -8 })]))!;
        expect(touching.contact).toBe(true);
    });
});

describe('race hooks (docs/phase-2-design.md, 17.1)', () => {
    it('filters the input the car takes, keeps the raw one for the packets, and filters replays too', () => {
        const { p } = setup();
        // Frozen before tick 20: no pedals
        p.filterInput = (tick, input) => { if (tick < 20) input.throttle = input.brake = input.steer = 0; };
        p.startAt(1);
        p.spawnAt(0, 0, 0, 0);
        for (let i = 0; i < 18; i++) p.advance(gas, 0);
        expect(p.car.state.z).toBe(0);
        expect(p.entry(18)!.input).toEqual(gas);
        for (let i = 0; i < 20; i++) p.advance(gas, 0);
        expect(p.car.state.z).toBeGreaterThan(0.1);
        // A correction (the car 5 cm to the side at tick 10) replays through
        // the filter: still standing until tick 20, so as far along z
        const server = predicted(p, 10);
        server.x += 0.05;
        const before = predicted(p, 38);
        const result = p.reconcile(snapshot(10, server, [], p.entry(10)!.seq))!;
        expect(result.matched).toBe(false);
        expect(predicted(p, 19).z).toBe(0);
        expect(predicted(p, 38).z).toBeCloseTo(before.z, 6);
    });

    it('applies the ghost floor to the own car and the contact set before every tick', () => {
        const { p } = setup({ 3: info(3) });
        const floored: string[] = [];
        p.ghostFloor = (tick, car) => { if (tick === 5) floored.push(car.id); car.state.ghostTicks = Math.max(car.state.ghostTicks, 2); };
        p.startAt(1);
        p.spawnAt(0, 0, 0, 0);
        for (let i = 0; i < 3; i++) p.advance(gas, 0);
        p.reconcile(snapshot(3, predicted(p, 3), [record(3, 3, 0)], p.entry(3)!.seq));
        p.advance(gas, 0);
        p.advance(gas, 0);
        expect(floored.sort()).toEqual(['me', 'r3']);
        expect(p.car.state.ghostTicks).toBeGreaterThan(0);
    });
});
