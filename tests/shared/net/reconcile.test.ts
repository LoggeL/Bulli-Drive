import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mulberry32 } from '../../../src/shared/math/rng.js';
import { CONTACT_SMOOTH_MAX_MS, SMOOTH_TAU_MAX_MS, SNAP_DISTANCE, TICK_MS } from '../../../src/shared/net/constants.js';
import { statesEqual } from '../../../src/shared/net/prediction.js';
import { copyVehicleState, createVehicleState, type VehicleState } from '../../../src/shared/sim/types.js';
import { createSimCar } from '../../../src/shared/sim/vehicle.js';
import { stepWorld } from '../../../src/shared/sim/world.js';
import { mapFor } from '../../../src/server/maps.js';
import { FrameProbe, input, run, TestClient, TestServer, type LinkOptions } from './harness.js';

// Reconciliation with simulated latency (docs/phase-1b-design.md, 15.1):
// the real rooms and the shared client code, messages delayed in a seeded
// queue. Without contact and without lost inputs the prediction must match
// the server bit for bit (same JS engine), so every correction is exactly 0.

let server: TestServer;

// Spawn points are random: the same ones in every run
beforeEach(() => {
    vi.spyOn(Math, 'random').mockImplementation(mulberry32(99));
});

afterEach(() => {
    server?.dispose();
    vi.restoreAllMocks();
});

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
        const { client, errors, from, missed } = measure({ latencyMs: 75, jitterMs: 30, loss: 0.03 }, 30, 5);
        const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
        expect(mean).toBeLessThan(0.1);
        // The lead covers the stalls (20.5): before the fix a third of the
        // inputs came too late, and the mean was up to 11 cm
        expect(missed).toBeLessThan(0.05 * 30 * 60);
        // A lost packet holds everything behind it for 200 ms + RTT (head of
        // line): past the 250 ms of input repeat the server stops the car,
        // which can take more than a smooth correction (20.2)
        const snaps = client.results.filter(r => r.result.snapped && r.tick > from).length;
        expect(snaps).toBeLessThanOrEqual(Math.ceil(errors.length * 0.01));
    });

    it('behind 150/30/3, a page that stalled while joining is never idle once it runs smoothly (20.5)', () => {
        // Found in loaded e2e runs: a page that hangs for 1.5 s every 2 s
        // (another page loading next to it) sends nothing and, with the
        // netsim in the page, delivers nothing; its inputs arrive 90 ticks
        // late. Raising the lead for that inflated it to 100-180 ticks, the
        // jump back left C waiting and the car an idle ghost for seconds
        for (const seed of [1, 3]) {
            server?.dispose();
            server = new TestServer();
            const client = new TestClient(server, 'stall', 'bulli', { latencyMs: 75, jitterMs: 30, loss: 0.03 }, seed);
            client.script = () => input(0);
            let t = 0;
            const step = (ms: number, stalled: (t: number) => boolean, each?: () => void) => {
                const end = t + ms;
                while (t < end) {
                    t += 4;
                    server.advance(t);
                    if (!stalled(t)) client.pump();
                    each?.();
                }
            };
            client.sendJson({ type: 'ready' });
            step(10_000, at => at % 2000 < 1500);
            const member = client.session.member!;
            let idle = 0;
            step(3000, () => false, () => { if (member.idle) idle++; });
            const missed = client.net.stats.missedInputs;
            step(7000, () => false, () => { if (member.idle) idle++; });
            expect(idle, `seed ${seed}`).toBe(0);
            expect(client.net.stats.missedInputs - missed, `seed ${seed}`).toBeLessThan(0.05 * 420);
        }
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

// What the player sees (8.4, 8.6): a correction moves the sim at once, the
// picture fades over to it. A frame never moves the picture further than
// one frame's fade of the largest offset that is smoothed (4 m at tau
// 200 ms); larger corrections are snaps, rare and counted.
const FRAME_MS = 1000 / 60;
const JUMP_LIMIT = SNAP_DISTANCE * (1 - Math.exp(-FRAME_MS / SMOOTH_TAU_MAX_MS)) + 1e-3;

describe('smoothing on screen', () => {
    it('at the exit criterion no frame jumps, and it converges to exact once the net is clean', () => {
        let rawMax = 0;
        for (const seed of [3, 44]) {
            server?.dispose();
            server = new TestServer();
            const net = { latencyMs: 75, jitterMs: 30, loss: 0.03 };
            const client = new TestClient(server, 'smooth', 'sport', net, seed);
            start(client, 300, 300, 0.3);
            client.script = tick => slalom(tick);
            run(server, [client], 5000);
            const probe = new FrameProbe(client);
            run(server, [client], 30_000, 4, () => probe.update(server.time));
            expect(probe.jumps.length).toBeGreaterThan(1700);
            expect(Math.max(...probe.jumps)).toBeLessThanOrEqual(JUMP_LIMIT);
            expect(probe.snaps).toBeLessThanOrEqual(Math.ceil(probe.jumps.length * 0.01));
            rawMax = Math.max(rawMax, ...probe.rawJumps);

            // The net gets clean: the offset fades out, the prediction is exact again
            net.jitterMs = 0;
            net.loss = 0;
            run(server, [client], 2000, 4, () => probe.update(server.time));
            const from = client.session.room!.tick;
            const jumpsFrom = probe.jumps.length;
            run(server, [client], 2000, 4, () => probe.update(server.time));
            expect(errorsAfter(client, from).every(e => e === 0)).toBe(true);
            expect(client.net.offset.active).toBe(false);
            expect(Math.max(...probe.jumps.slice(jumpsFrom))).toBeLessThan(1e-9);
        }
        // Without the offset the picture would have jumped (by metres before
        // the lead covered the stalls, 20.5; now by decimetres)
        expect(rawMax).toBeGreaterThan(0.25);
    });

    it('a car of the contact set that steers unpredictably moves smoother than its corrections', () => {
        server = new TestServer();
        const net = { latencyMs: 75, jitterMs: 30, loss: 0 };
        const a = new TestClient(server, 'a', 'bulli', net, 21);
        const b = new TestClient(server, 'b', 'bulli', net, 22);
        a.sendJson({ type: 'ready' });
        b.sendJson({ type: 'ready' });
        run(server, [a, b], 600);
        // Side by side, 10 m apart; b weaves every 12 ticks
        a.sendJson({ type: 'debugPlace', x: 300, z: 240, yaw: 0 });
        b.sendJson({ type: 'debugPlace', x: 310, z: 240, yaw: 0 });
        run(server, [a, b], 2500);
        a.script = () => input(200);
        b.script = tick => input(200, Math.floor(tick / 12) % 2 === 0 ? 80 : -80);
        const probe = new FrameProbe(a);
        run(server, [a, b], 5000, 4, () => probe.update(server.time));
        // b stayed in a's contact set nearly all the time
        expect(probe.remoteJumps.length).toBeGreaterThan(250);
        const p99 = (values: number[]) => [...values].sort((x, y) => x - y)[Math.floor(0.99 * (values.length - 1))];
        expect(p99(probe.remoteJumps)).toBeLessThan(0.5 * p99(probe.remoteRawJumps));
        expect(Math.max(...probe.remoteJumps)).toBeLessThanOrEqual(JUMP_LIMIT);
    });

    it('after a bump the offset is gone within 300 ms, and neither car jumps on screen', () => {
        server = new TestServer();
        const net = { latencyMs: 75, jitterMs: 30, loss: 0 };
        const a = new TestClient(server, 'a', 'bulli', net, 21);
        const b = new TestClient(server, 'b', 'pickup', net, 22);
        a.sendJson({ type: 'ready' });
        b.sendJson({ type: 'ready' });
        run(server, [a, b], 600);
        a.sendJson({ type: 'debugPlace', x: 300, z: 240, yaw: 0 });
        b.sendJson({ type: 'debugPlace', x: 300.5, z: 300, yaw: Math.PI });
        run(server, [a, b], 2500);
        a.script = () => input(255);
        b.script = () => input(255);
        const probes = [new FrameProbe(a), new FrameProbe(b)];
        const contactAt: number[][] = [[], []];
        const seen = [0, 0];
        run(server, [a, b], 5000, 4, () => {
            [a, b].forEach((client, i) => {
                probes[i].update(server.time);
                for (; seen[i] < client.results.length; seen[i]++) {
                    if (client.results[seen[i]].result.contact) contactAt[i].push(server.time);
                }
            });
        });
        for (const i of [0, 1]) {
            const probe = probes[i];
            // Both predicted the hit and corrected with contact
            expect(contactAt[i].length).toBeGreaterThan(0);
            // The first frame of the probe may carry the snap of the placement
            expect(probe.snaps).toBeLessThanOrEqual(1);
            expect(Math.max(...probe.jumps)).toBeLessThanOrEqual(JUMP_LIMIT);
            expect(Math.max(0, ...probe.remoteJumps)).toBeLessThanOrEqual(JUMP_LIMIT);
            // 300 ms after each contact correction the offset of that
            // correction is gone (a newer one may have started meanwhile)
            const last = contactAt[i].at(-1)!;
            probe.times.forEach((t, k) => {
                if (t > last + CONTACT_SMOOTH_MAX_MS + FRAME_MS) expect(probe.offsets[k]).toBe(0);
            });
        }
    });

    // Behind loss the lead grows past EXTRAPOLATE_MAX_TICKS (15): the
    // contact set is predicted further than the input repeat reaches. Its
    // cars stay dynamic there, so a bump splits between both cars as on the
    // server; a kinematic car would stop the own car like a wall and the
    // correction would come metres later (up to 1.8 m in one frame, other
    // cars snapping 4-9 m before this was fixed).
    it.each([
        { mode: 'rear-end', net: { latencyMs: 75, jitterMs: 30, loss: 0.03 }, seed: 5 },
        { mode: 'head-on', net: { latencyMs: 75, jitterMs: 30, loss: 0.03 }, seed: 17 },
        { mode: 'head-on', net: { latencyMs: 50, jitterMs: 10, loss: 0.01 }, seed: 9 }
    ])('$mode behind $net.latencyMs ms each way and $net.loss loss: no frame jumps, for neither car', ({ mode, net, seed }) => {
        server = new TestServer();
        const a = new TestClient(server, 'a', 'bulli', net, seed);
        const b = new TestClient(server, 'b', 'bulli', net, seed + 1);
        a.sendJson({ type: 'ready' });
        b.sendJson({ type: 'ready' });
        run(server, [a, b], 600);
        a.script = () => input(0);
        b.script = () => input(0);
        const headOn = mode === 'head-on';
        a.sendJson({ type: 'debugPlace', x: 300, z: 240, yaw: 0 });
        b.sendJson({ type: 'debugPlace', x: 300.3, z: 290, yaw: headOn ? Math.PI : 0 });
        // Long enough for the lead to settle behind the loss
        run(server, [a, b], 12_000);
        a.script = () => input(255);
        if (headOn) b.script = () => input(255);
        const probes = [new FrameProbe(a), new FrameProbe(b)];
        const bCar = b.serverCar!;
        let leadAtContact = -1;
        run(server, [a, b], 4000, 4, () => {
            for (const probe of probes) probe.update(server.time);
            if (leadAtContact < 0 && bCar.events.carImpactId !== '') leadAtContact = Math.min(a.net.lead.lead, b.net.lead.lead);
        });
        // The case this is about: both predict more than 15 ticks ahead
        expect(leadAtContact).toBeGreaterThan(15);
        // The server bumped them (b was pushed or both bounced)
        expect(a.results.some(r => r.result.contact)).toBe(true);
        for (const probe of probes) {
            // Only the placement before the probe started may snap
            expect(probe.snaps).toBeLessThanOrEqual(1);
            expect(Math.max(...probe.jumps)).toBeLessThanOrEqual(JUMP_LIMIT);
            expect(probe.remoteJumps.length).toBeGreaterThan(30);
            expect(Math.max(...probe.remoteJumps)).toBeLessThanOrEqual(JUMP_LIMIT);
        }
    });
});
