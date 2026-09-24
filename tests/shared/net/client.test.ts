import { describe, expect, it } from 'vitest';
import { NetClient } from '../../../src/shared/net/client.js';
import { CAR_RESPAWN_SHIELD, decodeInputPacket, INPUT_FROZEN, type InputPacket, type Snapshot } from '../../../src/shared/net/codec.js';
import { TICK_MS } from '../../../src/shared/net/constants.js';
import type { MemberInfo } from '../../../src/shared/protocol.js';
import { createFlatWorld } from '../../../src/shared/sim/scenarios.js';
import { createVehicleInput, createVehicleState } from '../../../src/shared/sim/types.js';
import { createSimCar } from '../../../src/shared/sim/vehicle.js';

// NetClient driven directly (docs/phase-1b-design.md, 8): members and
// slots, the events about the own car, the respawn shield, the frame
// stepping and the input packets. Values from the design and the Party
// rules: at most 20 ticks per frame, C starts after 3 pongs, 250 ms of
// prediction after the connection is lost, a stall of more than 150 ms,
// the respawn shield at most 480 ticks, packets of up to 8 inputs with
// the 2 before the new ones repeated.

function member(id: string, slot: number, carType = 'bulli'): MemberInfo {
    return { id, slot, name: id, color: 0, carType, profile: 'standard', ready: true };
}

function client(party = true) {
    const sent: InputPacket[] = [];
    const net = new NetClient(bytes => sent.push(decodeInputPacket(bytes)!));
    net.enterRoom(createFlatWorld(), party, [member('me', 0), member('bob', 1)], createSimCar('me', 'bulli'), 'me');
    return { net, sent };
}

// Pongs from a server whose tick is local time / TICK_MS, 20 ms round trip
function sync(net: NetClient, pongs = 3, at = 1000): number {
    let now = at;
    for (let i = 0; i < pongs; i++) {
        const t = (now - 10) / TICK_MS;
        net.clock.addSample(now - 20, now, Math.floor(t), t - Math.floor(t));
        now += 100;
    }
    return now;
}

function snapshot(serverTick: number, flags: number, patch: Partial<Snapshot> = {}): Snapshot {
    return {
        serverTick, lastProcessedSeq: -1, inputSlack: null, bufferTarget: 1, carCount: 0, missedInputs: 0,
        self: { slot: 0, state: createVehicleState(), flags, mods: 0, input: createVehicleInput() }, cars: [], ...patch
    };
}

describe('members and slots', () => {
    it('maps slots to members, moves a member to a new slot and forgets one that left', () => {
        const { net } = client();
        expect(net.idForSlot(1)).toBe('bob');
        net.setMember(member('bob', 4));
        expect(net.idForSlot(1)).toBeUndefined();
        expect(net.idForSlot(4)).toBe('bob');
        net.removeMember('bob');
        expect(net.idForSlot(4)).toBeUndefined();
        expect(net.members.has('bob')).toBe(false);
        // Carol got slot 1 while Dave, who had it, was still listed: Dave
        // leaving does not take it from her
        net.setMember(member('dave', 1));
        net.setMember(member('carol', 1));
        net.removeMember('dave');
        expect(net.idForSlot(1)).toBe('carol');
        net.removeMember('nobody');
        expect(net.members.size).toBe(2);
    });
});

describe('events about the own car', () => {
    it('spawns and kills only the own car', () => {
        const { net } = client();
        expect(net.applyEvent({ type: 'spawn', id: 'bob', tick: 5, x: 1, z: 2, yaw: 0 })).toBe(false);
        expect(net.prediction!.spawned).toBe(false);
        expect(net.applyEvent({ type: 'spawn', id: 'me', tick: 5, x: 1, z: 2, yaw: 0 })).toBe(true);
        expect(net.prediction!.spawned).toBe(true);
        expect(net.spawnTick).toBe(5);
        expect(net.cameraSnap).toBe(true);
        expect([net.prediction!.car.state.x, net.prediction!.car.state.z]).toEqual([1, 2]);
        net.setWindow('speed', 0, 100);
        expect(net.applyEvent({ type: 'killed', target: 'bob', killer: 'me', killerName: 'me', targetName: 'bob', cause: 'shot' })).toBe(false);
        expect(net.prediction!.spawned).toBe(true);
        expect(net.applyEvent({ type: 'killed', target: 'me', killer: 'bob', killerName: 'bob', targetName: 'me', cause: 'shot' })).toBe(true);
        expect(net.prediction!.spawned).toBe(false);
        expect(net.powerupActive('speed', 50)).toBe(false);
        expect(net.applyEvent({ type: 'respawn', id: 'me', tick: 200, x: 3, z: 4, yaw: 1, health: 100 })).toBe(true);
        expect(net.spawnTick).toBe(200);
    });

    it('takes the own car out of the prediction on its despawn (a race spectator), not on another car\'s', () => {
        const { net } = client();
        net.applyEvent({ type: 'spawn', id: 'me', tick: 5, x: 1, z: 2, yaw: 0, grid: 3 });
        expect(net.applyEvent({ type: 'despawn', id: 'bob', tick: 9 })).toBe(false);
        expect(net.prediction!.spawned).toBe(true);
        expect(net.applyEvent({ type: 'despawn', id: 'me', tick: 9 })).toBe(true);
        expect(net.prediction!.spawned).toBe(false);
    });

    it('opens a powerup window only for its own powerup pickups', () => {
        const { net } = client();
        const pickup = { type: 'pickup', kind: 'powerup', itemId: 1, playerId: 'me', powerupType: 'size', startTick: 10, endTick: 70 } as const;
        expect(net.applyEvent({ ...pickup, playerId: 'bob' })).toBe(false);
        expect(net.applyEvent({ ...pickup, powerupType: 'wings' as never })).toBe(false);
        expect(net.applyEvent({ ...pickup, endTick: undefined })).toBe(false);
        expect(net.applyEvent({ type: 'pickup', kind: 'coin', itemId: 1, playerId: 'me' })).toBe(false);
        expect(net.powerupActive('size', 20)).toBe(false);
        expect(net.applyEvent(pickup)).toBe(true);
        expect([net.powerupActive('size', 9), net.powerupActive('size', 10), net.powerupActive('size', 69), net.powerupActive('size', 70)])
            .toEqual([false, true, true, false]);
    });

    it('rebuilds the body of a member whose car changed', () => {
        const { net } = client();
        expect(net.applyEvent({ type: 'carChanged', id: 'bob', carType: 'jeep', profile: 'touch', tick: 3 })).toBe(false);
        expect(net.members.get('bob')).toEqual(expect.objectContaining({ carType: 'jeep', profile: 'touch', slot: 1 }));
        expect(net.idForSlot(1)).toBe('bob');
        expect(net.applyEvent({ type: 'carChanged', id: 'me', carType: 'sport', profile: 'standard', tick: 3 })).toBe(true);
        expect(net.members.get('me')!.carType).toBe('sport');
        expect(net.applyEvent({ type: 'honk', id: 'bob' })).toBe(false);
    });

    it('takes the powerup windows, spawn tick and car of a resumed session', () => {
        const { net } = client();
        net.setWindow('ghost', 0, 1000);
        net.resumeOwn({
            alive: true, spawnTick: 42,
            powerups: [{ type: 'speed', startTick: 40, endTick: 90 }, { type: 'wings' as never, startTick: 0, endTick: 99 }]
        });
        expect(net.powerupActive('speed', 50)).toBe(true);
        expect(net.powerupActive('ghost', 50)).toBe(false);
        expect(net.spawnTick).toBe(42);
        expect(net.prediction!.adoptNext).toBe(true);
        net.resumeOwn({ alive: false, spawnTick: 42, powerups: [] });
        expect(net.prediction!.adoptNext).toBe(false);
    });
});

describe('respawn shield', () => {
    it('assumes the shield after a spawn until a snapshot says otherwise, at most 480 ticks', () => {
        const { net } = client();
        expect(net.respawnShieldAt(10)).toBe(false);     // never spawned
        net.applyEvent({ type: 'spawn', id: 'me', tick: 100, x: 0, z: 0, yaw: 0 });
        expect(net.respawnShieldAt(100)).toBe(false);    // the spawn tick itself
        expect(net.respawnShieldAt(101)).toBe(true);     // no snapshot since the spawn
        expect(net.respawnShieldAt(580)).toBe(true);
        expect(net.respawnShieldAt(581)).toBe(false);
        // A snapshot after the spawn has the last word
        net.reconcileSnapshot(snapshot(150, 0), 0);
        expect(net.respawnShieldAt(160)).toBe(false);
        net.reconcileSnapshot(snapshot(151, CAR_RESPAWN_SHIELD), 0);
        expect(net.respawnShieldAt(160)).toBe(true);
    });

    it('is no Party rule in Free Roam', () => {
        const { net } = client(false);
        net.applyEvent({ type: 'spawn', id: 'me', tick: 100, x: 0, z: 0, yaw: 0 });
        expect(net.respawnShieldAt(101)).toBe(false);
    });

    it('protects the predicted car, now and in its modifiers', () => {
        const { net } = client();
        const now = sync(net);
        net.advanceFrame(now, () => net.tickWith(createVehicleInput(), 0));
        const C = net.tick;
        net.applyEvent({ type: 'spawn', id: 'me', tick: C - 1, x: 0, z: 0, yaw: 0 });
        expect(net.respawnShieldNow).toBe(true);
        net.tickWith(createVehicleInput(), 0);
        expect(net.prediction!.car.mods.shield).toBe(true);
        net.applyEvent({ type: 'killed', target: 'me', killer: 'bob', killerName: 'bob', targetName: 'me', cause: 'ram' });
        expect(net.respawnShieldNow).toBe(false);
    });
});

describe('frame stepping', () => {
    it('starts only after 3 pongs', () => {
        const { net } = client();
        let ticks = 0;
        const run = () => { ticks++; net.tickWith(createVehicleInput(), 0); };
        const now = sync(net, 2);
        expect(net.advanceFrame(now, run)).toBe(0);
        expect(ticks).toBe(0);
        expect(net.tick).toBe(-1);
        sync(net, 1, now);
        net.advanceFrame(now + 100, run);
        expect(net.tick).toBeGreaterThan(0);
    });

    it('runs the due ticks, at most 20 a frame, and skips ahead when far behind', () => {
        const { net } = client();
        let ticks = 0;
        const run = () => { ticks++; net.tickWith(createVehicleInput(), 0); };
        const now = sync(net);
        net.advanceFrame(now, run);
        const start = net.tick;
        ticks = 0;
        // 10 ticks of time
        net.advanceFrame(now + 10 * TICK_MS, run);
        expect(ticks).toBe(10);
        expect(net.tick).toBe(start + 10);
        // 2 s later: 120 ticks due, 20 run, C jumps to the last 20
        ticks = 0;
        const resyncs = net.stats.resyncs;
        const alpha = net.advanceFrame(now + 10 * TICK_MS + 2000, run);
        expect(ticks).toBe(20);
        expect(net.stats.resyncs).toBe(resyncs + 1);
        expect(Math.floor(net.targetTick(now + 10 * TICK_MS + 2000))).toBe(net.tick);
        expect(alpha).toBeGreaterThanOrEqual(0);
        expect(alpha).toBeLessThanOrEqual(1);
    });

    it('predicts 250 ms more after the connection is lost, then holds', () => {
        const { net } = client();
        let ticks = 0;
        const run = () => { ticks++; net.tickWith(createVehicleInput(), 0); };
        const now = sync(net);
        net.advanceFrame(now, run);
        net.suspend(now);
        net.suspend(now + 100);   // the first loss counts
        expect(net.suspended).toBe(true);
        ticks = 0;
        net.advanceFrame(now + 250, run);
        expect(ticks).toBe(15);
        ticks = 0;
        net.advanceFrame(now + 300, run);
        net.advanceFrame(now + 400, run);
        expect(ticks).toBe(0);
    });

    it('counts a gap of more than 150 ms between frames as a stall of its own', () => {
        const { net } = client();
        const run = () => { net.tickWith(createVehicleInput(), 0); };
        const now = sync(net);
        net.advanceFrame(now, run);
        net.advanceFrame(now + 150, run);
        expect(net.stats.ownStalls).toBe(0);
        net.advanceFrame(now + 301, run);
        expect(net.stats.ownStalls).toBe(1);
    });
});

describe('input packets', () => {
    function running() {
        const { net, sent } = client();
        const now = sync(net);
        net.advanceFrame(now, () => net.tickWith(createVehicleInput(), 0));
        // A first tick with steer 0, already sent
        net.tickWith(createVehicleInput(), 0);
        net.flushInputs();
        sent.length = 0;
        // Ticks after it carry steer = their number since then
        const base = net.tick;
        const tick = (flags = 0) => net.tickWith({ steer: net.tick + 1 - base, throttle: 0, brake: 0, buttons: 0 }, flags);
        return { net, sent, base, tick };
    }

    it('sends the new inputs with the two before them, newest first, once', () => {
        const { net, sent, base, tick } = running();
        tick();
        tick();
        net.flushInputs();
        expect(sent).toHaveLength(1);
        expect(sent[0].tick).toBe(base + 2);
        expect(sent[0].inputs.map(i => i.steer)).toEqual([2, 1, 0]);
        net.flushInputs();
        expect(sent).toHaveLength(1);
        tick(INPUT_FROZEN);
        net.flushInputs();
        expect(sent[1].tick).toBe(base + 3);
        expect(sent[1].inputs.map(i => i.steer)).toEqual([3, 2, 1]);
        // The flags are those of the newest input
        expect(sent[1].flags).toBe(INPUT_FROZEN);
        tick();
        net.flushInputs();
        expect(sent[2].flags).toBe(0);
        expect(sent[2].seq).toBe(net.prediction!.entry(base + 4)!.seq);
    });

    it('splits a long run into packets of 6 new inputs plus 2 repeated', () => {
        const { net, sent, base, tick } = running();
        const bytesBefore = net.stats.bytesOut;
        for (let i = 0; i < 13; i++) tick();
        net.flushInputs();
        expect(sent.map(p => p.tick)).toEqual([base + 6, base + 12, base + 13]);
        expect(sent[0].inputs.map(i => i.steer)).toEqual([6, 5, 4, 3, 2, 1, 0]);
        expect(sent[1].inputs.map(i => i.steer)).toEqual([12, 11, 10, 9, 8, 7, 6, 5]);
        expect(sent[2].inputs.map(i => i.steer)).toEqual([13, 12, 11]);
        // 11 header bytes and 4 per input (3.3)
        expect(net.stats.bytesOut - bytesBefore).toBe(sent.reduce((sum, p) => sum + 11 + 4 * p.inputs.length, 0));
    });
});
