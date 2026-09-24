import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Bot } from '../../tools/bots/bot.js';
import { longestRunway } from '../../tools/bots/runway.js';
import { BotSwarm, formatReport, type MixEntry, type SwarmOptions } from '../../tools/bots/swarm.js';
import { CAR_IDLE, CAR_LAGGY } from '../../src/shared/net/codec.js';
import { parseNetsimFlag } from '../../src/shared/net/netsim.js';
import { createMapData } from '../../src/shared/world/mapData.js';
import { startServer, type ServerProcess } from './serverProcess.js';

// Headless bots against a real server process over real WebSockets
// (docs/phase-1b-design.md, 15.2): a scripted bump seen by both cars,
// reconnect within the grace time, a room switch, a flood kick, and 16 bots
// for 30 s behind the netsim of the exit criterion (150 ms RTT, 30 ms
// jitter, 3 % loss, TCP) with the bandwidth and tick budgets.

const NETSIM = parseNetsimFlag('150,30,3')!;
const GRACE_MS = 5000;

let server: ServerProcess;
let swarm: BotSwarm | null = null;

beforeAll(async () => {
    server = await startServer({ GRACE_MS: String(GRACE_MS) });
});

afterEach(async (context) => {
    await swarm?.stop();
    swarm = null;
    // A failed test shows what the server said meanwhile (CI has no other log)
    if (context.task.result?.state === 'fail') console.log(`Server output:\n${server.output()}`);
    // An error the server caught and logged fails the test, even when the
    // bots saw nothing of it
    expect(server.problems(), 'errors in the server log').toEqual([]);
});

afterAll(async () => {
    await server?.stop();
});

async function launch(mix: MixEntry[], options: Partial<SwarmOptions> = {}): Promise<BotSwarm> {
    swarm = new BotSwarm({ url: server.url, mix, staggerMs: 20, ...options });
    await swarm.start();
    return swarm;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function speed(bot: Bot): number {
    const self = bot.lastSnapshot?.self;
    return self ? Math.hypot(self.state.vx, self.state.vz) : 0;
}

function serverPos(bot: Bot): { x: number; z: number } | null {
    const self = bot.lastSnapshot?.self;
    return self ? { x: self.state.x, z: self.state.z } : null;
}

const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

function errorsOf(s: BotSwarm): string[] {
    return s.bots.flatMap(bot => bot.stats.errors.map(e => `${bot.name}: ${e}`));
}

describe.each([
    ['without netsim', null],
    ['with netsim 150/30/3', NETSIM]
] as const)('a head-on bump %s', (_label, netsim) => {
    it('shows on both sides: both get the contact, the rammed car is pushed, the rammer slows', async () => {
        const s = await launch([{ mode: 'manual', count: 2 }], { room: 'freeroam', netsim, namePrefix: `Bump ${netsim ? 'ns' : 'direct'}` });
        const [a, b] = s.bots;
        await s.waitFor(() => a.driving && b.driving && !!a.lastSnapshot?.self && !!b.lastSnapshot?.self, 20_000, 'both cars');

        // A and B 20 m apart on a free road, facing each other; B stands
        const runway = longestRunway(createMapData().colliders);
        expect(runway.free).toBeGreaterThan(60);
        const aStart = { x: runway.x, z: runway.z + 5 };
        const bStart = { x: runway.x, z: runway.z + 25 };
        a.place(aStart.x, aStart.z, 0);
        b.place(bStart.x, bStart.z, Math.PI);
        const solid = (bot: Bot) => {
            const self = bot.lastSnapshot!.self!;
            return self.state.ghostTicks === 0 && (self.flags & (CAR_IDLE | CAR_LAGGY)) === 0;
        };
        await s.waitFor(() => {
            const pa = serverPos(a), pb = serverPos(b);
            const bSeen = a.seen.get(b.playerId!), aSeen = b.seen.get(a.playerId!);
            return !!pa && !!pb && dist(pa, aStart) < 0.1 && dist(pb, bStart) < 0.1
                && !!bSeen && !!aSeen && dist(bSeen, bStart) < 0.1 && dist(aSeen, aStart) < 0.1
                && solid(a) && solid(b);
        }, 20_000, 'the placement on both sides');

        // A: full throttle into B
        a.manualInput.throttle = 255;
        let aTop = 0, aAfter = Infinity, bTop = 0;
        let contactAt = -1;
        const until = performance.now() + 8000;
        while (performance.now() < until) {
            await sleep(10);
            const touched = a.stats.contacts.some(c => c.other === b.playerId) && b.stats.contacts.some(c => c.other === a.playerId);
            if (contactAt < 0) aTop = Math.max(aTop, speed(a));
            if (touched && contactAt < 0) contactAt = performance.now();
            if (contactAt >= 0) {
                aAfter = Math.min(aAfter, speed(a));
                bTop = Math.max(bTop, speed(b));
                if (performance.now() - contactAt > 1000) break;
            }
        }
        a.manualInput.throttle = 0;
        await s.waitFor(() => speed(b) < 0.2 && b.seen.get(a.playerId!) !== undefined, 10_000, 'B to come to rest');

        expect(contactAt, `no contact event on both sides: ${JSON.stringify([a.stats.contacts, b.stats.contacts])}`).toBeGreaterThan(0);
        const aContact = a.stats.contacts.find(c => c.other === b.playerId)!;
        const bContact = b.stats.contacts.find(c => c.other === a.playerId)!;
        expect(Math.max(aContact.dv, bContact.dv)).toBeGreaterThanOrEqual(3);
        // Momentum went from A to B: A slowed down, B was knocked backwards
        expect(aTop).toBeGreaterThan(8);
        expect(aAfter).toBeLessThan(aTop * 0.7);
        expect(bTop).toBeGreaterThanOrEqual(3);
        // The rammed car moved, on its own screen and on the rammer's
        const bNow = serverPos(b)!, bSeenByA = a.seen.get(b.playerId!)!;
        expect(dist(bNow, bStart)).toBeGreaterThan(1);
        expect(dist(bSeenByA, bStart)).toBeGreaterThan(1);
        expect(dist(bSeenByA, bNow)).toBeLessThan(2);
        expect(errorsOf(s)).toEqual([]);
    });
});

describe('reconnect', () => {
    it('within the grace time keeps the player, the slot and the car; after it the car leaves', async () => {
        const s = await launch([{ mode: 'drive', count: 2 }], { namePrefix: 'Resume' });
        const [r, o] = s.bots;
        await s.waitFor(() => r.driving && o.driving && o.seen.has(r.playerId!), 20_000, 'both driving');
        const id = r.playerId!, slot = r.slot, room = r.room!.id;
        const left: string[] = [];
        const watch = setInterval(() => { if (!o.net.members.has(id)) left.push('gone'); }, 20);

        r.dropConnection(1500);
        await s.waitFor(() => r.stats.welcomes.length === 2 && r.driving, 15_000, 'the resume');
        const welcome = r.stats.welcomes[1];
        expect(welcome).toEqual(expect.objectContaining({ playerId: id, resumed: true }));
        const entered = r.stats.rooms.at(-1)!;
        expect(entered).toEqual(expect.objectContaining({ resumed: true, slot }));
        expect(entered.room.id).toBe(room);
        // It drives on, and the other bot kept seeing the same player
        const distance = r.driver.distance;
        await s.waitFor(() => r.driver.distance > distance + 10 && o.seen.has(id), 10_000, 'driving on');
        clearInterval(watch);
        expect(left).toEqual([]);

        // Gone for good: the car waits the grace time, then leaves
        const droppedAt = performance.now();
        r.dropConnection(Infinity);
        await s.waitFor(() => !o.net.members.has(id) && !o.seen.has(id), GRACE_MS + 5000, 'the car to leave');
        const waited = performance.now() - droppedAt;
        expect(waited).toBeGreaterThan(GRACE_MS - 500);
        expect(errorsOf(s)).toEqual([]);
    });
});

describe('room switch', () => {
    it('the bot shows up in the new room and is gone from the old room\'s snapshots', async () => {
        const party = await launch([{ mode: 'drive', count: 2 }], { namePrefix: 'Hop party' });
        const [h, o1] = party.bots;
        const other = new BotSwarm({ url: server.url, mix: [{ mode: 'drive', count: 1 }], room: 'freeroam', namePrefix: 'Hop freeroam' });
        await other.start();
        try {
            const o2 = other.bots[0];
            await party.waitFor(() => h.driving && o1.driving && o2.driving && o1.seen.has(h.playerId!), 20_000, 'all driving');
            const id = h.playerId!;
            h.switchRoom('freeroam');
            await party.waitFor(() => h.room?.kind === 'freeroam' && h.driving, 10_000, 'the switch');
            expect(h.room!.id).toBe(o2.room!.id);
            await party.waitFor(() => !o1.net.members.has(id) && !o1.seen.has(id) && o2.seen.has(id), 10_000, 'the other rooms to follow');
            // Stays gone from the party's next ten snapshots
            const seenAt = o1.stats.counters.snapshots;
            let back = false;
            await party.waitFor(() => {
                back ||= o1.seen.has(id);
                return o1.stats.counters.snapshots >= seenAt + 10;
            }, 5000, 'ten more party snapshots');
            expect(back).toBe(false);
            expect(h.playerId).toBe(id);
            expect([...errorsOf(party), ...errorsOf(other)]).toEqual([]);
        } finally {
            await other.stop();
        }
    });
});

describe('flood', () => {
    it('kicks a flooding bot; the others keep their snapshot rate', async () => {
        const s = await launch([{ mode: 'drive', count: 3 }, { mode: 'flood', count: 1 }], { namePrefix: 'Flood', room: 'freeroam' });
        const flood = s.bots[3];
        await s.waitFor(() => s.bots.slice(0, 3).every(bot => bot.driving), 20_000, 'the drivers');
        s.markWindow();
        // The close, not the 'kicked' message before it: the close handshake
        // takes a few turns of the event loop more
        await s.waitFor(() => flood.stats.closes.some(close => !close.own), 15_000, 'the kick');
        expect(flood.stats.kicked).toBe('policy');
        expect(flood.stats.closes.find(close => !close.own)!.code).toBe(4003);
        // Two more seconds' worth of snapshots for everyone after the kick
        const after = s.bots.slice(0, 3).map(bot => bot.stats.counters.snapshots + 40);
        await s.waitFor(() => s.bots.slice(0, 3).every((bot, i) => bot.stats.counters.snapshots >= after[i]), 10_000, 'snapshots after the kick');
        const report = await s.report();
        for (const bot of report.bots.slice(0, 3)) expect(bot.snapshotsPerSec, bot.name).toBeGreaterThanOrEqual(18);
        expect(report.server!.kicks).toBeGreaterThanOrEqual(1);
        expect(errorsOf(s)).toEqual([]);
    });
});

describe('16 bots for 30 s behind netsim 150/30/3', () => {
    it('run without errors within the bandwidth and tick budgets, and bump into each other', async () => {
        const s = await launch(
            [{ mode: 'drive', count: 10 }, { mode: 'ram', count: 4 }, { mode: 'reconnect', count: 1 }, { mode: 'hop', count: 1 }],
            { netsim: NETSIM, namePrefix: 'Load', bot: { dropEveryMs: 10_000, reconnectMinMs: 1000, reconnectMaxMs: 3000, hopEveryMs: 10_000 } }
        );
        await s.waitFor(() => s.bots.every(bot => bot.driving), 30_000, 'every bot driving');
        // The lead settles within the first seconds (the first stalls raise
        // it): every bot 100 snapshots in, and none a lag ghost any more
        await s.waitFor(() => s.bots.every(bot => bot.stats.counters.snapshots >= 100
            && ((bot.lastSnapshot?.self?.flags ?? 0) & CAR_LAGGY) === 0), 30_000, 'the leads to settle');
        s.markWindow();
        // 30 s at 20 snapshots a second for the bots that stay put
        const from = new Map(s.bots.map(bot => [bot, bot.stats.counters.snapshots]));
        const steadyBots = s.bots.filter(bot => bot.mode === 'drive' || bot.mode === 'ram');
        await s.waitFor(() => steadyBots.every(bot => bot.stats.counters.snapshots - from.get(bot)! >= 600), 60_000, '600 snapshots each');
        const report = await s.report();
        console.log(formatReport(report));

        expect(report.errors).toEqual([]);
        for (const bot of report.bots) {
            // Every client within the downlink budget (13.1)
            expect(bot.kbInPerSec, bot.name).toBeLessThanOrEqual(30);
            const steady = bot.mode === 'drive' || bot.mode === 'ram';
            expect(bot.snapshotsPerSec, bot.name).toBeGreaterThanOrEqual(steady ? 18 : 12);
            if (steady) expect(bot.distanceM, bot.name).toBeGreaterThan(100);
        }
        expect(s.bots.every(bot => bot.stats.nonFinite === 0 && bot.stats.malformed === 0)).toBe(true);
        // Exit criterion: mean correction without contact under 10 cm (16)
        expect(report.correctionMeanCm).toBeLessThan(10);
        // The server tick stays well inside the budget (5.7)
        expect(report.server!.tickP95Ms).toBeLessThan(4);
        // Bumps that both cars felt: at least one (how many depends on when
        // the ram bots meet, 3-19 in 25 runs; the scripted head-on tests
        // above check the bump itself)
        expect(report.mutualContacts).toBeGreaterThanOrEqual(1);
        // The reconnect bot came back as the same player, the hop bot switched
        const reconnect = s.bots.find(bot => bot.mode === 'reconnect')!;
        expect(reconnect.stats.welcomes.filter(w => w.resumed).length).toBeGreaterThanOrEqual(1);
        expect(new Set(reconnect.stats.welcomes.map(w => w.playerId)).size).toBe(1);
        const hop = s.bots.find(bot => bot.mode === 'hop')!;
        expect(new Set(hop.stats.rooms.map(r => r.room.kind)).size).toBe(2);
    });
});
