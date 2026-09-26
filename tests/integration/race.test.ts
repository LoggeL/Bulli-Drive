import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { rates } from '../../tools/bots/bot.js';
import { BotSwarm, fetchHealth } from '../../tools/bots/swarm.js';
import { parseNetsimFlag } from '../../src/shared/net/netsim.js';
import { trackDef } from '../../src/shared/race/tracks/index.js';
import { mapFor } from '../../src/server/maps.js';
import { startServer, type ServerProcess } from './serverProcess.js';

const HILL_SPRINT = trackDef(mapFor(), 'hill-sprint');

// The race over real WebSockets (docs/phase-2-design.md, 20.2): four
// WebSocket bots in a race room behind the netsim of the exit criterion,
// the server fills the field with two bots of its own. Two of the
// WebSocket bots bump into each other after the start ghost, one sends
// inputs from the future and malformed packets in the countdown. The race
// ends with the same, correct result for everyone. Beside it a time trial:
// a run, a reload within the grace time, and the ghost of that run at the
// next countdown. On Bulli Bay the Ridge Climb takes about a minute (the
// phase 2 Hill Sprint half that), so both run at the same time, each in
// its own room of the one server (the integration job stays in its budget,
// CLAUDE.md).

const NETSIM = parseNetsimFlag('150,30,3')!;
const GRACE_MS = 5000;

let server: ServerProcess;
let failed = false;

beforeAll(async () => {
    server = await startServer({ GRACE_MS: String(GRACE_MS) });
});

afterEach(context => {
    if (context.task.result?.state === 'fail') failed = true;
});

afterAll(async () => {
    if (failed) console.log(`Server output:\n${server.output()}`);
    // An error the server caught and logged fails the run, even when the
    // bots saw nothing of it
    const problems = server.problems();
    await server?.stop();
    expect(problems, 'errors in the server log').toEqual([]);
});

// A swarm for one test, stopped however the test ends
async function withSwarm(options: ConstructorParameters<typeof BotSwarm>[0], run: (s: BotSwarm) => Promise<void>): Promise<void> {
    const s = new BotSwarm(options);
    try {
        await run(s);
    } finally {
        await s.stop();
    }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function errorsOf(s: BotSwarm): string[] {
    return s.bots.flatMap(bot => bot.stats.errors.map(e => `${bot.name}: ${e}`));
}

describe('a race of 4 WebSocket bots and 2 server bots behind netsim 150/30/3, and a time trial', () => {
    it.concurrent('runs from the lobby to the results with a bump, shrugs off a manipulating client and ranks everyone alike', () => withSwarm({
        url: server.url,
        mix: [{ mode: 'race', count: 4 }],
        netsim: NETSIM,
        namePrefix: 'Racer',
        staggerMs: 150,
        // Join order = grid order in the first race: B on the pole, A behind it
        bot: { track: 'hill-sprint', serverBotLevel: 'hard', driverLevel: 'medium', carType: 'sport' }
    }, async s => {
        const [b, a, c, d] = s.bots;
        let aBumped = false;

        // B waits on the grid for 5 s; A waits out the start ghost, then
        // drives into B for up to 2 s (or until the bump), then both race
        b.raceOverride = (tick, S, _s, input) => {
            if (tick >= S + 300) return false;
            input.steer = input.throttle = input.brake = input.buttons = 0;
            return true;
        };
        a.raceOverride = (tick, S, s, input) => {
            if (tick < S + 180) {
                input.steer = input.throttle = input.brake = input.buttons = 0;
                return true;
            }
            aBumped ||= a.stats.contacts.some(k => k.other === b.playerId);
            if (aBumped || tick >= S + 300) return false;
            const target = a.seen.get(b.playerId!);
            if (!target) return false;
            const heading = Math.atan2(target.x - s.x, target.z - s.z);
            const alpha = heading - s.yaw;
            input.steer = Math.round(Math.max(-1, Math.min(1, Math.sin(alpha) * 3)) * 127);
            input.throttle = 255;
            input.brake = 0;
            input.buttons = 0;
            return true;
        };
        // D: inputs 100 ticks ahead and malformed packets during the countdown
        // Every 5th tick it runs, from the moment it knows the start tick, not
        // on fixed tick numbers: a bot that skips ahead after a stall of its
        // process would miss those (on a busy CI runner, with the time trial
        // beside it, the old window of the last 200 ticks and every 10th tick
        // once saw only two)
        let dSent = 0;
        let dLastSent = -Infinity;
        d.raceOverride = (tick, S, _s, input) => {
            if (tick >= S) return false;
            if (tick - dLastSent >= 5 && dSent < 6) {
                dSent++;
                dLastSent = tick;
                d.sendInputAhead(100, { steer: 127, throttle: 255, brake: 0, buttons: 2 });
                if (dSent <= 3) d.sendRawBinary(new Uint8Array([1, 9, 0, 0]));
            }
            input.steer = input.throttle = input.brake = input.buttons = 0;
            return true;
        };

        await s.start();
        await s.waitFor(() => s.bots.every(bot => bot.race.state?.phase === 'countdown'), 30_000, 'the countdown');
        const state = s.bots[0].race.state!;
        const S = state.startTick!;
        expect(state.trackId).toBe('hill-sprint');
        expect(state.racers).toHaveLength(6);
        expect(state.racers.filter(r => r.bot)).toHaveLength(2);
        expect(state.racers.slice(0, 4).map(r => r.id)).toEqual([b, a, c, d].map(bot => bot.playerId));

        // Until the start every car stands on its grid slot: D whatever it
        // sent, C although its line driver presses the throttle in the countdown
        const drift = s.bots.map(() => [] as number[]);
        const snapshotsBefore = new Map(s.bots.map(bot => [bot, bot.stats.counters.snapshots]));
        await s.waitFor(() => {
            s.bots.forEach((bot, i) => {
                const snap = bot.lastSnapshot, grid = HILL_SPRINT.grid[i];
                if (snap?.self && snap.serverTick < S) drift[i].push(Math.hypot(snap.self.state.x - grid.x, snap.self.state.z - grid.z));
            });
            return s.bots.every(bot => (bot.lastSnapshot?.serverTick ?? 0) >= S);
        }, 15_000, 'the start');
        const dSeen = drift[3];
        expect(dSent).toBeGreaterThanOrEqual(3);
        expect(dSeen.length).toBeGreaterThan(10);
        expect(Math.max(...dSeen)).toBe(0);
        for (const [i, seen] of drift.entries()) expect(Math.max(0, ...seen), s.bots[i].name).toBe(0);
        // The others kept getting their snapshots
        for (const bot of s.bots) expect(bot.stats.counters.snapshots - snapshotsBefore.get(bot)!).toBeGreaterThan(50);
        expect(d.stats.kicked).toBeNull();

        const window = s.bots.map(bot => bot.sample());
        await s.waitFor(() => aBumped && b.stats.contacts.some(k => k.other === a.playerId), 15_000, 'the bump');
        await s.waitFor(() => s.bots.every(bot => bot.raceMessages('raceResults').length > 0), 150_000, 'the results');
        const downlink = s.bots.map((bot, i) => rates(window[i], bot.sample()).bytesInPerSec);

        const results = s.bots.map(bot => bot.raceMessages('raceResults').at(-1)!);
        const entries = results[0].entries;
        const health = await fetchHealth(server.url);
        console.log(`Race: ${entries.map(e => `${e.pos}. ${e.name}${e.bot ? ' (bot)' : ''} ${e.finishTicks === null ? e.status : `${(e.finishTicks / 60).toFixed(2)} s`}`).join(', ')}; `
            + `downlink ${downlink.map(v => (v / 1024).toFixed(1)).join('/')} kB/s; tick p99 ${health?.tickP99Ms} ms`);
        for (const r of results) expect(r.entries).toEqual(entries);
        expect(entries.map(e => e.pos)).toEqual([1, 2, 3, 4, 5, 6]);
        // Every player through the finish and at least one server bot (a
        // server bot still out when the last player finishes is DNF, 6.1;
        // in six local runs both server bots finished), finishers in the order of
        // their times, DNF behind them
        expect(entries.filter(e => !e.bot).map(e => e.status)).toEqual(Array(4).fill('finished'));
        const finished = entries.filter(e => e.status === 'finished');
        expect(finished.filter(e => e.bot).length).toBeGreaterThanOrEqual(1);
        expect(entries.slice(0, finished.length)).toEqual(finished);
        expect(entries.slice(finished.length).every(e => e.bot && e.status === 'dnf')).toBe(true);
        const times = finished.map(e => e.finishTicks!);
        expect(times).toEqual([...times].sort((x, y) => x - y));
        // The Ridge Climb: 56-65 s estimated from the fastest to the slowest
        // class (docs/phase-3-design.md, 4), bots driving their share of it,
        // A and B 5 s late after the bump
        expect(times[0] / 60).toBeGreaterThan(45);
        expect(times.at(-1)! / 60).toBeLessThan(110);
        // Every bot saw the same finishes with the same positions, and the
        // last race status lists the result's order
        for (const bot of s.bots) {
            const finishes = bot.raceEvents('finish');
            for (const e of finished) expect(finishes.find(f => f.id === e.id)).toMatchObject({ pos: e.pos, time: e.finishTicks });
            expect(bot.raceMessages('raceStatus').at(-1)!.order.map(o => o.id)).toEqual(entries.map(e => e.id));
        }
        // Both saw the bump, strong enough for sparks
        const aContact = a.stats.contacts.find(k => k.other === b.playerId)!;
        const bContact = b.stats.contacts.find(k => k.other === a.playerId)!;
        expect(Math.max(aContact.dv, bContact.dv)).toBeGreaterThanOrEqual(3);
        // Within the downlink budget in the race (19)
        for (const [i, bytes] of downlink.entries()) expect(bytes / 1024, s.bots[i].name).toBeLessThanOrEqual(16);
        expect(health!.tickP99Ms).toBeGreaterThan(0);
        expect(health!.tickP99Ms).toBeLessThan(4);
        expect(errorsOf(s)).toEqual([]);
    }), 200_000);

    it.concurrent('keeps a finished time trial run and sends it as the ghost after a reload', () => withSwarm({
        url: server.url,
        mix: [{ mode: 'timetrial', count: 1 }],
        namePrefix: 'Trial',
        bot: { track: 'hill-sprint', driverLevel: 'hard', carType: 'bulli' }
    }, async s => {
        const [t] = s.bots;
        await s.start();
        await s.waitFor(() => t.raceMessages('raceResults').length > 0, 150_000, 'the run');
        const run = t.raceMessages('raceResults')[0];
        const own = run.entries[0];
        expect(own).toMatchObject({ id: t.playerId, status: 'finished', pos: 1 });
        expect(run.personal).toEqual({ finishTicks: own.finishTicks, improved: false });
        const firstRoom = t.room!.id;

        // A reload: the same session on a new page within the grace time
        t.connId = `${t.connId}-reload`;
        t.dropConnection(300);
        await s.waitFor(() => t.stats.rooms.length >= 2 && t.room!.id !== firstRoom, 15_000, 'the new room');
        await s.waitFor(() => t.raceMessages('ghostData').length > 0, 15_000, 'the ghost');
        const ghost = t.raceMessages('ghostData')[0];
        expect(ghost).toMatchObject({ kind: 'personal', finishTicks: own.finishTicks, name: t.name, carType: 'bulli', hz: 20 });
        expect(t.stats.welcomes.at(-1)!.playerId).toBe(t.stats.welcomes[0].playerId);
        await sleep(50);
        expect(errorsOf(s)).toEqual([]);
    }), 200_000);
});
