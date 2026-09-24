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
});
