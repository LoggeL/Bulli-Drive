import { afterEach, describe, expect, it } from 'vitest';
import { TICK_MS } from '../../../src/shared/net/constants.js';
import { statesEqual } from '../../../src/shared/net/prediction.js';
import { copyVehicleState, createVehicleState, type VehicleState } from '../../../src/shared/sim/types.js';
import { createSimCar } from '../../../src/shared/sim/vehicle.js';
import { stepWorld } from '../../../src/shared/sim/world.js';
import { mapFor } from '../../../src/server/maps.js';
import { input, run, TestClient, TestServer, type LinkOptions } from './harness.js';

// Reconciliation with simulated latency (docs/phase-1b-design.md, 15.1):
// the real rooms and the shared client code, messages delayed in a seeded
// queue. Without contact and without lost inputs the prediction must match
// the server bit for bit (same JS engine), so every correction is exactly 0.

let server: TestServer;

afterEach(() => server?.dispose());

// Drives around on the open terrain north of the city: gas, a slow slalom,
// a handbrake flick and a boost now and then
function slalom(tick: number) {
    const phase = Math.floor(tick / 90) % 4;
    const steer = Math.round(Math.sin(tick / 40) * 90);
    return input(phase === 3 ? 60 : 255, steer, 0, tick % 300 < 12 ? 1 : (tick % 500 < 40 ? 2 : 0));
}

function start(client: TestClient, x: number, z: number, yaw = 0): void {
    client.sendJson({ type: 'ready' });
    run(server, [client], 400);
    client.sendJson({ type: 'debugPlace', x, z, yaw });
    run(server, [client], 200);
}

// Corrections (position error at T_s) of the snapshots after `from`
function errorsAfter(client: TestClient, fromTick: number): number[] {
    return client.results.filter(r => r.tick > fromTick).map(r => r.result.error);
}

function measure(net: LinkOptions, seconds: number, warmupSeconds: number) {
    server = new TestServer();
    const client = new TestClient(server, 'solo', 'sport', net, 17);
    start(client, 300, 300, 0.3);
    client.script = tick => slalom(tick);
    run(server, [client], warmupSeconds * 1000);
    const from = client.session.room!.tick;
    const missedBefore = client.net.stats.missedInputs;
    run(server, [client], seconds * 1000);
    return { client, from, errors: errorsAfter(client, from), missed: client.net.stats.missedInputs - missedBefore };
}

describe('prediction against the server', () => {
    it('with 0 latency: every correction is exactly 0 over 1000 ticks', () => {
        const { client, errors, missed } = measure({ latencyMs: 0, jitterMs: 0, loss: 0 }, 1000 * TICK_MS / 1000, 2);
        expect(missed).toBe(0);
        expect(errors.length).toBeGreaterThan(300);
        expect(errors.every(e => e === 0)).toBe(true);
        expect(client.results.every(r => !r.result.snapped || r.tick < 200)).toBe(true);
        // The server car moved: this was not a car standing still
        expect(Math.hypot(client.serverCar!.state.x - 300, client.serverCar!.state.z - 300)).toBeGreaterThan(50);
    });

    it('with 9 ticks each way and ±2 ticks of jitter: still exactly 0, bit for bit', () => {
        const tickMs = TICK_MS;
        const { client, errors, missed } = measure({ latencyMs: 9 * tickMs, jitterMs: 4 * tickMs, loss: 0 }, 20, 5);
        expect(missed).toBe(0);
        expect(errors.length).toBeGreaterThan(300);
        expect(errors.every(e => e === 0)).toBe(true);
        // The replayed state at T_s is the server's: compare the last one
        const p = client.net.prediction!;
        const last = client.results.at(-1)!;
        const predicted = createVehicleState();
        expect(p.stateAt(last.tick, predicted)).toBe(true);
        expect(last.result.matched).toBe(true);
    });

    it('at the exit criterion (RTT 150 ms, 30 ms jitter, 3 % loss, TCP): mean correction under 10 cm, snaps rare', () => {
        const { client, errors, from } = measure({ latencyMs: 75, jitterMs: 30, loss: 0.03 }, 30, 5);
        const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
        expect(mean).toBeLessThan(0.1);
        // A lost packet holds everything behind it for 200 ms + RTT (head of
        // line): past the 250 ms of input repeat the server stops the car,
        // which can take more than a smooth correction (20.2)
        const snaps = client.results.filter(r => r.result.snapped && r.tick > from).length;
        expect(snaps).toBeLessThanOrEqual(Math.ceil(errors.length * 0.01));
    });

    it('jumps back on track after the client clock jumps', () => {
        const tickMs = TICK_MS;
        server = new TestServer();
        const client = new TestClient(server, 'jumpy', 'bulli', { latencyMs: 3 * tickMs, jitterMs: 0, loss: 0 }, 5);
        start(client, 300, 300);
        client.script = tick => slalom(tick);
        run(server, [client], 3000);
        const resyncs = client.net.lead.resyncs;
        client.clockSkewMs = 500;
        run(server, [client], 4000);
        expect(client.net.lead.resyncs).toBeGreaterThan(resyncs);
        const from = client.session.room!.tick;
        const missed = client.net.stats.missedInputs;
        run(server, [client], 3000);
        expect(client.net.stats.missedInputs).toBe(missed);
        expect(errorsAfter(client, from).every(e => e === 0)).toBe(true);
    });
});

describe('powerups with latency', () => {
    it('corrects once when a Turbo is picked up, then matches exactly again', () => {
        const tickMs = TICK_MS;
        server = new TestServer();
        const client = new TestClient(server, 'turbo', 'bulli', { latencyMs: 9 * tickMs, jitterMs: 0, loss: 0 }, 31, 'party');
        const turbo = mapFor().world.powerups.find(p => p.type === 'speed' && Math.hypot(p.x, p.z) > 120)!;
        start(client, turbo.x, turbo.z - 30);
        // Past the spawn ghost and the respawn shield standing still
        run(server, [client], 2000);
        client.script = () => input(255);
        const from = client.session.room!.tick;
        run(server, [client], 6000);
        const pickup = client.events.flatMap(m => (m.type === 'events' ? m.list : []))
            .find(e => e.type === 'pickup' && e.kind === 'powerup' && e.itemId === turbo.id);
        expect(pickup).toBeDefined();
        expect(client.net.powerupActive('speed', (pickup as { startTick: number }).startTick)).toBe(true);
        const corrections = client.results.filter(r => r.tick > from && r.result.error > 0);
        expect(corrections.length).toBeGreaterThanOrEqual(1);
        expect(corrections.length).toBeLessThanOrEqual(2);
        // After the window started: exact again (the end of the window is known too)
        const settled = corrections.at(-1)!.tick;
        const after = client.results.filter(r => r.tick > settled);
        expect(after.length).toBeGreaterThan(40);
        expect(after.every(r => r.result.error === 0)).toBe(true);
        expect(client.results.filter(r => r.tick > from).some(r => r.result.snapped)).toBe(false);
    });
});

describe('bumping with latency', () => {
    it('both clients see the head-on hit in their own prediction, and the server matches a run without net', () => {
        const tickMs = TICK_MS;
        server = new TestServer();
        const net = { latencyMs: 5 * tickMs, jitterMs: 2 * tickMs, loss: 0 };
        const a = new TestClient(server, 'a', 'bulli', net, 21);
        const b = new TestClient(server, 'b', 'pickup', net, 22);
        a.sendJson({ type: 'ready' });
        b.sendJson({ type: 'ready' });
        run(server, [a, b], 600);
        // Head-on on the open terrain, 60 m apart; after 2 s the spawn ghost is gone
        a.sendJson({ type: 'debugPlace', x: 300, z: 240, yaw: 0 });
        b.sendJson({ type: 'debugPlace', x: 300.5, z: 300, yaw: Math.PI });
        run(server, [a, b], 2500);
        const missedBefore = a.net.stats.missedInputs + b.net.stats.missedInputs;
        a.script = () => input(255);
        b.script = () => input(255);
        const aCar = a.serverCar!, bCar = b.serverCar!;
        const room = a.session.room!;
        // The server states once both drive at full throttle, 30 m apart
        const before: VehicleState[] = [];
        let beforeTick = -1;
        let aSawIt = -1, bSawIt = -1;
        run(server, [a, b], 4000, 4, () => {
            if (aSawIt < 0 && a.car.events.carImpact > 0) aSawIt = a.net.tick;
            if (bSawIt < 0 && b.car.events.carImpact > 0) bSawIt = b.net.tick;
            if (beforeTick < 0 && Math.abs(aCar.state.z - bCar.state.z) < 30 && aCar.input.throttle === 255 && bCar.input.throttle === 255) {
                beforeTick = room.tick;
                before.push(copyVehicleState(createVehicleState(), aCar.state), copyVehicleState(createVehicleState(), bCar.state));
            }
        });
        expect(beforeTick).toBeGreaterThan(0);
        // Both clients predicted the other car into the hit: their own car
        // took the impulse in a forward tick, not only after a correction
        expect(aSawIt).toBeGreaterThan(0);
        expect(bSawIt).toBeGreaterThan(0);
        expect(a.results.some(r => r.result.contact)).toBe(true);
        expect(b.results.some(r => r.result.contact)).toBe(true);
        // The server bounced them: both slowed well below their free speed
        expect(Math.abs(aCar.state.vz)).toBeLessThan(15);
        expect(Math.abs(bCar.state.vz)).toBeLessThan(15);
        expect(a.net.stats.missedInputs + b.net.stats.missedInputs).toBe(missedBefore);
        // After the contact the predictions converge again: exact corrections
        const late = server.lobby.list().find(r => r.members.size > 0)!.tick - 30;
        for (const client of [a, b]) {
            const tail = errorsAfter(client, late);
            expect(tail.length).toBeGreaterThan(0);
            for (const e of tail) expect(e).toBeLessThan(1e-9);
        }
        // The same two cars without any net, from the same states with the
        // same inputs: the server ends up exactly there (1a golden logic)
        const world = mapFor().simWorld;
        const offA = createSimCar(aCar.id, 'bulli'), offB = createSimCar(bCar.id, 'pickup');
        copyVehicleState(offA.state, before[0]);
        copyVehicleState(offB.state, before[1]);
        offA.input.throttle = offB.input.throttle = 255;
        for (let t = beforeTick; t < room.tick; t++) stepWorld([offA, offB], world);
        for (const [offline, online] of [[offA, aCar], [offB, bCar]] as const) {
            for (const key of ['x', 'z', 'yaw', 'vx', 'vz', 'yawRate'] as const) {
                expect(Math.abs(offline.state[key] - online.state[key]), key).toBeLessThanOrEqual(1e-9);
            }
        }
        expect(statesEqual(offA.state, aCar.state)).toBe(true);
    });
});
