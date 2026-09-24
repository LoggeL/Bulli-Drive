import { describe, expect, it } from 'vitest';
import { ClockSync } from '../../../src/shared/net/clock.js';
import { TICK_MS } from '../../../src/shared/net/constants.js';
import { EARLY_JUMP_TICKS, LeadControl, MAX_LATE_MARGIN_TICKS, RESYNC_TICKS } from '../../../src/shared/net/leadControl.js';
import { mulberry32 } from '../../../src/shared/math/rng.js';

// Clock sync (3.7) and lead control (8.3), docs/phase-1b-design.md 15.1.

// A server whose tick 0 was at local time offsetMs
function serverTick(localMs: number, offsetMs: number): number {
    return (localMs - offsetMs) / TICK_MS;
}

describe('ClockSync', () => {
    it('estimates the server tick from pongs with the smallest round trip', () => {
        const clock = new ClockSync();
        const random = mulberry32(1);
        const offset = -123_456;
        let now = 1000;
        for (let i = 0; i < 12; i++) {
            const up = 20 + random() * 60, down = 20 + (i === 5 ? 0 : random() * 60);
            const atServer = now + up;
            const tick = Math.floor(serverTick(atServer, offset));
            const sub = serverTick(atServer, offset) - tick;
            now = atServer + down;
            clock.addSample(now - up - down, now, tick, sub);
            now += 100;
        }
        expect(clock.ready).toBe(true);
        // Asymmetric delays make the estimate off by at most half the spread
        expect(Math.abs(clock.serverTickAt(now) - serverTick(now, offset))).toBeLessThan(40 / TICK_MS);
        expect(clock.rtt).toBeGreaterThanOrEqual(40);
        expect(clock.jitter).toBeGreaterThan(0);
    });

    it('is exact with symmetric delays and follows a server that moved (a hang)', () => {
        const clock = new ClockSync();
        let offset = 5000;
        let now = 10_000;
        const ping = () => {
            const atServer = now + 30;
            const t = serverTick(atServer, offset);
            clock.addSample(now, now + 60, Math.floor(t), t - Math.floor(t));
            now += 1000;
        };
        for (let i = 0; i < 5; i++) ping();
        expect(clock.serverTickAt(now)).toBeCloseTo(serverTick(now, offset), 6);
        // The server hung for 300 ms and skipped the ticks: the newest of the
        // equally fast samples counts, the offset follows (eased, 0.1 per pong)
        offset += 300;
        for (let i = 0; i < 60; i++) ping();
        expect(Math.abs(clock.serverTickAt(now) - serverTick(now, offset))).toBeLessThan(0.5);
    });
});

describe('ClockSync samples', () => {
    // A server at tick = local ms / TICK_MS (offset 0); a pong with the
    // given round trip, split evenly, so every sample says offset 0
    function pong(clock: ClockSync, now: number, rtt: number): void {
        const t = (now - rtt / 2) / TICK_MS;
        clock.addSample(now - rtt, now, Math.floor(t), t - Math.floor(t));
    }

    it('keeps the last 8 samples for the round trip and counts every pong', () => {
        const clock = new ClockSync();
        expect(clock.rtt).toBe(0);
        pong(clock, 1000, 10);
        for (let i = 1; i < 8; i++) pong(clock, 1000 + i * 1000, 50);
        // 8 samples: the 10 ms one is still in
        expect(clock.rtt).toBe(10);
        expect(clock.count).toBe(8);
        pong(clock, 9000, 50);
        expect(clock.rtt).toBe(50);
        expect(clock.count).toBe(9);
        clock.reset();
        expect(clock.ready).toBe(false);
        expect(clock.count).toBe(0);
        expect(clock.rtt).toBe(0);
    });

    it('reports the jitter as p90 - p10 of the kept round trips', () => {
        const clock = new ClockSync();
        pong(clock, 1000, 70);
        expect(clock.jitter).toBe(0);
        pong(clock, 2000, 30);
        // Two samples: the larger minus the smaller
        expect(clock.jitter).toBe(40);
        // 10 pongs of 100, 90, ... 10 ms: the last 8 are 80 ... 10 ms;
        // sorted, p90 is rank round(0.9 · 7) = 6 (70 ms), p10 rank 1 (20 ms)
        const many = new ClockSync();
        for (let i = 0; i < 10; i++) pong(many, 1000 + i * 1000, 100 - i * 10);
        expect(many.jitter).toBe(50);
    });

    it('eases a small offset change in and takes one past the margin at once', () => {
        // Round trips of 0 ms: the tolerance is the margin of 1 tick alone
        const clock = new ClockSync();
        clock.addSample(1000, 1000, 100, 0);
        expect(clock.serverTickAt(1000)).toBeCloseTo(100, 9);
        // 0.5 ticks later than expected: eased in by a tenth
        clock.addSample(2000, 2000, 100 + 1000 / TICK_MS + 0.5, 0);
        expect(clock.jumps).toBe(0);
        expect(clock.serverTickAt(2000)).toBeCloseTo(100 + 1000 / TICK_MS + 0.05, 9);
        // 2 ticks off (1.95 from the eased offset): the server's clock moved, taken as it is
        clock.addSample(3000, 3000, 100 + 2000 / TICK_MS + 2, 0);
        expect(clock.jumps).toBe(1);
        expect(clock.serverTickAt(3000)).toBeCloseTo(100 + 2000 / TICK_MS + 2, 9);
    });
});

describe('ClockSync after a server hang', () => {
    // A server that skipped `skipMs` of ticks at local time hangAt; pongs
    // once a second with random asymmetric delays around rttMs
    function simulate(rttMs: number, jitterMs: number, skipMs: number, seed: number) {
        const clock = new ClockSync();
        const random = mulberry32(seed);
        let offset = -50_000;
        const hangAt = 30_000;
        let skipped = false;
        const errors: { at: number; error: number }[] = [];
        for (let now = 1000; now < 60_000; now += 1000) {
            if (!skipped && now >= hangAt) {
                offset += skipMs;
                skipped = true;
            }
            const up = rttMs / 2 + (random() - 0.5) * jitterMs, down = rttMs / 2 + (random() - 0.5) * jitterMs;
            const t = serverTick(now + up, offset);
            clock.addSample(now, now + up + down, Math.floor(t), t - Math.floor(t));
            const at = now + up + down;
            errors.push({ at, error: clock.serverTickAt(at) - serverTick(at, offset) });
        }
        return { clock, errors, hangAt };
    }

    it('takes the moved clock within two pongs of a 400 ms hang (it eased in over 20 s before)', () => {
        for (const rtt of [40, 100, 200]) {
            const { clock, errors, hangAt } = simulate(rtt, 10, 400 - 4 * TICK_MS, 7);
            const after = errors.filter(e => e.at > hangAt + 2100);
            // Within the uncertainty of a sample (half its round trip) from 2 s on
            for (const e of after) expect(Math.abs(e.error), `rtt ${rtt}`).toBeLessThan((rtt / 2 + 10) / TICK_MS);
            expect(clock.jumps).toBe(1);
        }
    });

    it('never jumps on ordinary jitter, even at 300 ms with 100 ms of it', () => {
        for (const seed of [1, 2, 3, 4, 5]) {
            const { clock } = simulate(300, 100, 0, seed);
            expect(clock.jumps).toBe(0);
        }
    });
});

describe('LeadControl', () => {
    it('starts half a round trip plus the buffer ahead', () => {
        const lead = new LeadControl();
        lead.start(100, 2);
        expect(lead.lead).toBeCloseTo(50 / TICK_MS + 2, 9);
        expect(LeadControl.startTick(1000.2, 100, 2)).toBe(Math.ceil(1000.2 + 50 / TICK_MS + 2));
    });

    it('converges on the buffer target in under 3 s with RTT 20-300 ms, moving at most 5 %', () => {
        for (const rtt of [20, 80, 150, 300]) {
            const lead = new LeadControl();
            // Start 4 ticks too early: the server reports slack = lead - way there
            lead.start(rtt, 2);
            lead.lead += 4;
            const way = (rtt / 2) / TICK_MS;
            const target = 2;
            let now = 0;
            let converged = -1;
            for (let snapshot = 0; snapshot < 60 * 5 / 3; snapshot++) {
                now += 3 * TICK_MS;
                // The report describes inputs sent a round trip ago
                const slack = Math.round(lead.lead - way);
                const before = lead.lead;
                lead.onSnapshot(slack, target, now, rtt);
                expect(Math.abs(lead.lead - before)).toBeLessThanOrEqual(0.05 * 3 + 1e-9);
                expect(lead.rate).toBeGreaterThanOrEqual(0.95);
                expect(lead.rate).toBeLessThanOrEqual(1.05);
                if (converged < 0 && Math.abs(lead.lead - way - target) < 0.6) converged = now;
            }
            expect(converged, `rtt ${rtt}`).toBeGreaterThanOrEqual(0);
            expect(converged).toBeLessThan(3000);
        }
    });

    it('jumps on a large error and then waits for its effect', () => {
        const lead = new LeadControl();
        lead.start(40, 1);
        const before = lead.lead;
        expect(lead.onSnapshot(-(RESYNC_TICKS + 4), 1, 1000, 40)).toBe(true);
        expect(lead.lead).toBeCloseTo(before + RESYNC_TICKS + 5, 9);
        // Reports of inputs sent before the jump are ignored
        const jumped = lead.lead;
        expect(lead.onSnapshot(-(RESYNC_TICKS + 4), 1, 1050, 40)).toBe(false);
        expect(lead.lead).toBe(jumped);
    });

    it('keeps the lead a stall needed instead of taking it back as a clock jump (20.5)', () => {
        // Found with the bots under netsim 150/30/3 TCP: an 18-tick raise made
        // the next reports 18 ticks early, which counted as a clock jump; the
        // lead swung between 7 and 27 ticks and a third of the inputs came late
        const lead = new LeadControl();
        lead.start(150, 3);
        // 75 ms one way (4.5 ticks) plus the buffer of 3
        expect(lead.lead).toBeCloseTo(7.5, 9);
        // A stall: the inputs came 15 ticks late, 18 short of the buffer
        expect(lead.onSnapshot(-15, 3, 1000, 150)).toBe(true);
        expect(lead.lead).toBeCloseTo(25.5, 9);
        // Now they come 18 ticks early: 21 slow steps of 5 % of the 3 ticks
        // between snapshots, no jump back
        let t = 2000;
        for (let i = 0; i < 21; i++) expect(lead.onSnapshot(21, 3, t += 50, 150)).toBe(false);
        expect(lead.lead).toBeCloseTo(25.5 - 21 * 0.15, 6);
        // Early far beyond what the stall added: the clock jumped after all
        lead.onSnapshot(3 + 40, 3, t += 50, 150);
        expect(lead.lead).toBeCloseTo(25.5 - 21 * 0.15 - 40, 6);
    });

    it('makes up any lateness at once, and lets early reports count as a clock jump only past the margin', () => {
        expect(MAX_LATE_MARGIN_TICKS).toBe(40);
        const lead = new LeadControl();
        lead.start(100, 1);
        // 50 ms one way (3 ticks) plus the buffer of 1
        expect(lead.lead).toBeCloseTo(4, 9);
        let t = 0;
        // The clock offset was 50 ticks off at the start: 52 short of the
        // buffer, made up in one go (a cap here left a car without inputs
        // for seconds in an e2e run)
        lead.onSnapshot(1 - 52, 1, t += 1000, 100);
        expect(lead.lead).toBeCloseTo(4 + 52, 9);
        // Early by 50 now counts as coming down slowly: the margin is 40
        // (capped), so up to 16 + 40 = 56 ticks early is no clock jump
        const raised = lead.lead;
        lead.onSnapshot(1 + 50, 1, t += 1000, 100);
        expect(lead.lead).toBeCloseTo(raised - 0.15, 9);
        // Early by 60: past the margin, a clock jump
        lead.onSnapshot(1 + 60, 1, t += 1000, 100);
        expect(lead.lead).toBeCloseTo(raised - 0.15 - 60, 9);
    });

    it('never gets stuck late when the inputs come in bursts (20.5)', () => {
        const lead = new LeadControl();
        lead.start(40, 2);
        let t = 0;
        // A stall raised the lead by 20, and the inputs then arrived 30 ticks early
        lead.onSnapshot(-18, 2, t += 1000, 40);
        lead.onSnapshot(30, 2, t += 1000, 40);
        // Now the page renders slowly and sends its inputs in bursts; the
        // report holds only the latest of them, 8 ticks short. Late reports
        // keep raising the lead until the bursts are covered (a cap on the
        // reported slack stopped here and left the car without inputs)
        let slack = -6;
        for (let i = 0; i < 20 && slack < 1; i++) {
            const before = lead.lead;
            lead.onSnapshot(slack, 2, t += 1000, 40);
            slack += lead.lead - before;
        }
        expect(slack).toBeGreaterThanOrEqual(1);
    });

    it('restarts when no input arrives for a second', () => {
        const lead = new LeadControl();
        lead.start(40, 1);
        lead.lead = 30;
        expect(lead.onSnapshot(null, 1, 0, 40)).toBe(false);
        expect(lead.onSnapshot(null, 1, 900, 40)).toBe(false);
        expect(lead.onSnapshot(null, 1, 1100, 40)).toBe(true);
        expect(lead.lead).toBeCloseTo(20 / TICK_MS + 1, 9);
    });

    // 8.3 and 20.5: after a jump the reports are ignored for a round trip
    // plus 250 ms (plus the ticks it moved the lead down); a stall of the
    // page longer than 600 ms makes them ignored for 2 round trips + 250 ms
    // + the stall
    it('ignores the reports for a round trip plus 250 ms after a late jump', () => {
        const lead = new LeadControl();
        lead.start(40, 1);
        lead.onSnapshot(-11, 1, 1000, 40);   // 12 short: a jump
        const jumped = lead.lead;
        lead.onSnapshot(-11, 1, 1000 + 40 + 249, 40);
        expect(lead.lead).toBe(jumped);
        lead.onSnapshot(-11, 1, 1000 + 40 + 250, 40);
        expect(lead.lead).toBeCloseTo(jumped + 12, 9);
    });

    it('waits the ticks an early jump took back on top', () => {
        const lead = new LeadControl();
        lead.start(40, 1);
        lead.lead = 40;
        lead.onSnapshot(1 + 20, 1, 1000, 40);   // 20 early: a clock jump
        expect(lead.lead).toBeCloseTo(20, 9);
        lead.onSnapshot(1 + 20, 1, 1000 + 40 + 250 + 20 * TICK_MS - 1, 40);
        expect(lead.lead).toBeCloseTo(20, 9);
        lead.onSnapshot(1 + 20, 1, 1000 + 40 + 250 + 20 * TICK_MS, 40);
        expect(lead.lead).toBeCloseTo(0, 9);
    });

    it('counts a jump of more than 8 ticks as a resync, smaller ones not', () => {
        const lead = new LeadControl();
        lead.start(40, 1);
        expect(lead.onSnapshot(1 - 8, 1, 1000, 40)).toBe(false);
        expect(lead.resyncs).toBe(0);
        expect(lead.onSnapshot(1 - 9, 1, 5000, 40)).toBe(true);
        expect(lead.resyncs).toBe(1);
        // Exactly 16 early (no margin left after the start) is no jump yet
        const fresh = new LeadControl();
        fresh.start(40, 1);
        const before = fresh.lead;
        fresh.onSnapshot(1 + 16, 1, 1000, 40);
        expect(fresh.lead).toBeCloseTo(before - 0.15, 9);
    });

    it('slows the ticks for an early report and speeds them up for a late one', () => {
        const early = new LeadControl();
        early.start(40, 1);
        early.onSnapshot(1 + 1, 1, 1000, 40);
        // Step -0.1 of the 3 ticks between snapshots
        expect(early.rate).toBeCloseTo(1 - 0.1 / 3, 12);
        const late = new LeadControl();
        late.start(40, 1);
        late.onSnapshot(1 - 1, 1, 1000, 40);
        expect(late.rate).toBeCloseTo(1 + 0.1 / 3, 12);
    });

    it('takes back only the late margin with the slow steps down', () => {
        const lead = new LeadControl();
        lead.start(40, 1);
        lead.onSnapshot(1 - 10, 1, 1000, 40);       // 10 short: margin 10
        expect(lead.margin).toBe(10);
        lead.onSnapshot(1 - 1, 1, 5000, 40);        // a little late: step up, margin stays
        expect(lead.margin).toBe(10);
        lead.onSnapshot(1 + 3, 1, 6000, 40);        // early: steps down eat the margin
        expect(lead.margin).toBeLessThan(10);
    });

    it('holds the reports after a stall of its own of more than 600 ms', () => {
        const short = new LeadControl();
        short.start(40, 1);
        short.holdAfterStall(1000, 40, 600);
        const before = short.lead;
        short.onSnapshot(1 - 12, 1, 1001, 40);
        expect(short.lead).toBeCloseTo(before + 12, 9);

        const long = new LeadControl();
        long.start(40, 1);
        long.holdAfterStall(1000, 40, 700);
        const held = long.lead;
        // Until 1000 + 2 · 40 + 250 + 700
        long.onSnapshot(1 - 12, 1, 2029, 40);
        expect(long.lead).toBe(held);
        long.onSnapshot(1 - 12, 1, 2030, 40);
        expect(long.lead).toBeCloseTo(held + 12, 9);
    });

    it('waits a round trip plus 250 ms after restarting a silent client', () => {
        const lead = new LeadControl();
        lead.start(40, 1);
        lead.onSnapshot(null, 1, 0, 40);
        expect(lead.onSnapshot(null, 1, 1001, 40)).toBe(true);
        expect(lead.resyncs).toBe(1);
        const restarted = lead.lead;
        lead.onSnapshot(1 - 12, 1, 1001 + 289, 40);
        expect(lead.lead).toBe(restarted);
        lead.onSnapshot(1 - 12, 1, 1001 + 290, 40);
        expect(lead.lead).toBeCloseTo(restarted + 12, 9);
    });
});
