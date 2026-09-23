import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mulberry32 } from '../../../src/shared/math/rng.js';
import { CAR_IDLE } from '../../../src/shared/net/codec.js';
import { TICK_MS } from '../../../src/shared/net/constants.js';
import { OFFLINE_PREDICT_MS } from '../../../src/shared/net/reconnect.js';
import { input, run, TestClient, TestServer } from './harness.js';

// A lost connection and the resume (docs/phase-1b-design.md, 11.1) with the
// real rooms and the shared client: the car waits on the server as an idle
// ghost, the client holds its prediction after 250 ms, and back on a new
// socket the client takes the car from the next snapshot and predicts it
// bit for bit again.

let server: TestServer;

beforeEach(() => {
    vi.spyOn(Math, 'random').mockImplementation(mulberry32(5));
});

afterEach(() => {
    server?.dispose();
    vi.restoreAllMocks();
});

const NET = { latencyMs: 5 * TICK_MS, jitterMs: 0, loss: 0 };

describe('resume after a lost connection', () => {
    it('holds the prediction, then takes the car back and predicts it exactly again', () => {
        server = new TestServer();
        const client = new TestClient(server, 'resume', 'sport', NET, 23, 'party');
        const watcher = new TestClient(server, 'watcher', 'bulli', NET, 24, 'party');
        client.sendJson({ type: 'ready' });
        watcher.sendJson({ type: 'ready' });
        run(server, [client, watcher], 400);
        client.sendJson({ type: 'debugPlace', x: 300, z: 300, yaw: 0.3 });
        run(server, [client, watcher], 200);
        client.script = tick => input(255, Math.round(Math.sin(tick / 40) * 60));
        run(server, [client, watcher], 3000);
        expect(client.net.prediction!.spawned).toBe(true);

        // The socket breaks
        client.disconnect();
        const tickAtDrop = client.net.tick;
        run(server, [client, watcher], 2000);
        // The client predicted about 250 ms more, then held the car
        const heldTicks = client.net.tick - tickAtDrop;
        expect(heldTicks).toBeGreaterThan(0);
        expect(heldTicks).toBeLessThanOrEqual(Math.ceil(OFFLINE_PREDICT_MS / TICK_MS) + 2);
        // The server stopped the car and made it an idle ghost
        const member = client.session.member!;
        expect(member.idle).toBe(true);
        expect(Math.hypot(member.car!.state.vx, member.car!.state.vz)).toBeLessThan(0.5);

        // Back on a new socket
        const resultsBefore = client.results.length;
        client.reconnect();
        run(server, [client, watcher], 1000);
        const after = client.results.slice(resultsBefore);
        expect(after.length).toBeGreaterThan(3);
        // The first snapshot brings the car (a hard take-over, no smoothing)
        expect(after[0].result.snapped).toBe(true);
        expect(client.net.prediction!.spawned).toBe(true);
        run(server, [client, watcher], 3000);
        // Driving again: the server car moves, it is no ghost, and the
        // prediction matches the server exactly
        expect(member.idle).toBe(false);
        expect(Math.hypot(member.car!.state.vx, member.car!.state.vz)).toBeGreaterThan(5);
        const late = client.results.slice(resultsBefore).filter(r => r.tick > client.session.room!.tick - 120);
        expect(late.length).toBeGreaterThan(10);
        expect(late.every(r => r.result.error === 0)).toBe(true);
        expect((client.net.selfFlags & CAR_IDLE)).toBe(0);
        // The same player and slot for everybody else
        expect(client.session.member).toBe(member);
    });
});
