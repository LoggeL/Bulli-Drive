import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../../src/shared/math/rng.js';
import {
    NETSIM_RETRANSMIT_MS, NetsimConnection, NetsimLink, describeNetsim, parseNetsimEnv, parseNetsimFlag, type NetsimOptions
} from '../../../src/shared/net/netsim.js';
import { closeAction, reconnectDelayMs } from '../../../src/shared/net/reconnect.js';

// Dev netsim (docs/phase-1b-design.md, 11.5) and the reconnect policy (11.1).

// A clock with timers that runs only when told to
class FakeClock {
    time = 0;
    private timers: { at: number; fn: () => void }[] = [];
    now = (): number => this.time;
    setTimeout = (fn: () => void, ms: number): unknown => {
        this.timers.push({ at: this.time + ms, fn });
        return null;
    };
    advance(ms: number): void {
        const end = this.time + ms;
        for (;;) {
            this.timers.sort((a, b) => a.at - b.at);
            const next = this.timers[0];
            if (!next || next.at > end) break;
            this.timers.shift();
            this.time = Math.max(this.time, next.at);
            next.fn();
        }
        this.time = end;
    }
}

function link(options: Partial<NetsimOptions>, seed = 1) {
    const clock = new FakeClock();
    const full: NetsimOptions = { rttMs: 100, jitterMs: 0, loss: 0, mode: 'tcp', ...options };
    return { clock, link: new NetsimLink(full, mulberry32(seed), clock) };
}

describe('netsim options', () => {
    it('reads the client flag RTT,JITTER,LOSS[,MODE]', () => {
        expect(parseNetsimFlag('150,30,3')).toEqual({ rttMs: 150, jitterMs: 30, loss: 0.03, mode: 'tcp' });
        expect(parseNetsimFlag('200,0,5,drop')).toEqual({ rttMs: 200, jitterMs: 0, loss: 0.05, mode: 'drop' });
        expect(parseNetsimFlag('80')).toEqual({ rttMs: 80, jitterMs: 0, loss: 0, mode: 'tcp' });
        for (const bad of [null, '', 'x', '150,30,3,udp', '-5,0,0', '150,30,90', '1e3,0,0', '0,0,0', '1,2,3,tcp,5']) {
            expect(parseNetsimFlag(bad), String(bad)).toBeNull();
        }
    });

    it('reads the server variable rtt=…,jitter=…,loss=…,mode=…', () => {
        expect(parseNetsimEnv('rtt=150,jitter=30,loss=3,mode=tcp')).toEqual({ rttMs: 150, jitterMs: 30, loss: 0.03, mode: 'tcp' });
        expect(parseNetsimEnv('rtt=300')).toEqual({ rttMs: 300, jitterMs: 0, loss: 0, mode: 'tcp' });
        for (const bad of [undefined, '', 'rtt', 'rtt=abc', 'speed=3', 'rtt=150,mode=udp']) {
            expect(parseNetsimEnv(bad), String(bad)).toBeNull();
        }
        expect(describeNetsim({ rttMs: 150, jitterMs: 30, loss: 0.03, mode: 'tcp' })).toBe('150/30/3% tcp');
    });

    it('takes spaces, upper case, decimals and the range limits 5000/2000/50', () => {
        expect(parseNetsimFlag(' 150 , 30 , 3 , DROP ')).toEqual({ rttMs: 150, jitterMs: 30, loss: 0.03, mode: 'drop' });
        expect(parseNetsimFlag('150.5,0.5,2.5')).toEqual({ rttMs: 150.5, jitterMs: 0.5, loss: 0.025, mode: 'tcp' });
        expect(parseNetsimFlag('5000,2000,50')).toEqual({ rttMs: 5000, jitterMs: 2000, loss: 0.5, mode: 'tcp' });
        // Any one of the three on its own is enough
        expect(parseNetsimFlag('0,0,1')).toEqual({ rttMs: 0, jitterMs: 0, loss: 0.01, mode: 'tcp' });
        expect(parseNetsimFlag('0,10')).toEqual({ rttMs: 0, jitterMs: 10, loss: 0, mode: 'tcp' });
        for (const bad of ['5001,0,0', '0,2001,0', '0,0,51', '150,,3', '150.,0,0', '.5,0,0', '1.5e2', '150x', 'x150', '150,3x,0', '150,3,x1']) {
            expect(parseNetsimFlag(bad), bad).toBeNull();
        }
        expect(parseNetsimEnv(' rtt = 150 , mode = DROP ')).toEqual({ rttMs: 150, jitterMs: 0, loss: 0, mode: 'drop' });
        expect(parseNetsimEnv('jitter=10,mode=drop')).toEqual({ rttMs: 0, jitterMs: 10, loss: 0, mode: 'drop' });
        expect(parseNetsimEnv('loss=2.5')).toEqual({ rttMs: 0, jitterMs: 0, loss: 0.025, mode: 'tcp' });
        expect(parseNetsimEnv('rtt=5000,jitter=2000,loss=50')).toEqual({ rttMs: 5000, jitterMs: 2000, loss: 0.5, mode: 'tcp' });
        for (const bad of ['rtt=5001', 'jitter=2001', 'loss=51', 'rtt=150x', 'rtt=x150', 'jitter=1x', 'jitter=1e1', 'loss=x1', 'loss=0x1', 'rtt=.5', 'rtt=',
            '=5', 'rtt=150,', 'mode=drop', 'rtt=-5', 'RTT=150']) {
            expect(parseNetsimEnv(bad), bad).toBeNull();
        }
    });
});

describe('NetsimLink', () => {
    it('holds each message for half the round trip', () => {
        const { clock, link: l } = link({ rttMs: 100 });
        const got: number[] = [];
        l.send(() => got.push(clock.time), false);
        clock.advance(49);
        expect(got).toEqual([]);
        clock.advance(1);
        expect(got).toEqual([50]);
    });

    it('keeps the order under jitter and stays within ±jitter/2', () => {
        const { clock, link: l } = link({ rttMs: 100, jitterMs: 40 }, 7);
        const got: { i: number; delay: number }[] = [];
        for (let i = 0; i < 200; i++) {
            const sentAt = clock.time;
            l.send(() => got.push({ i, delay: clock.time - sentAt }), i % 2 === 0);
            clock.advance(5);
        }
        clock.advance(1000);
        expect(got.map(g => g.i)).toEqual([...Array(200).keys()]);
        for (const g of got) {
            // Never earlier than the fastest message, and in order: a later
            // message may wait behind a slow one (up to one jitter)
            expect(g.delay).toBeGreaterThanOrEqual(30 - 1e-9);
            expect(g.delay).toBeLessThanOrEqual(70 + 40 + 1e-9);
        }
        expect(Math.min(...got.map(g => g.delay))).toBeLessThan(40);
    });

    it('tcp: a lost message comes 200 ms + RTT late and holds up the ones behind it', () => {
        const { clock, link: l } = link({ rttMs: 100, loss: 0.1, mode: 'tcp' }, 3);
        const sent: number[] = [], arrivals: number[] = [];
        for (let i = 0; i < 60; i++) {
            sent.push(clock.time);
            l.send(() => arrivals.push(clock.time), true);
            clock.advance(10);
        }
        clock.advance(5000);
        expect(arrivals).toHaveLength(60);
        expect(l.delayed).toBeGreaterThan(0);
        expect(l.dropped).toBe(0);
        for (let i = 1; i < arrivals.length; i++) expect(arrivals[i]).toBeGreaterThanOrEqual(arrivals[i - 1]);
        const delays = arrivals.map((t, i) => t - sent[i]);
        // The lost one: half the RTT plus a retransmit plus the RTT
        expect(Math.max(...delays)).toBeGreaterThanOrEqual(50 + NETSIM_RETRANSMIT_MS + 100 - 1e-9);
        // Messages sent right after a lost one arrive together with it
        const together = new Map<number, number>();
        for (const t of arrivals) together.set(t, (together.get(t) ?? 0) + 1);
        expect(Math.max(...together.values()), JSON.stringify(delays)).toBeGreaterThan(5);
    });

    it('drop: loses binary frames only, never the JSON messages', () => {
        const { clock, link: l } = link({ rttMs: 60, loss: 0.5, mode: 'drop' }, 11);
        let binary = 0, text = 0;
        for (let i = 0; i < 100; i++) {
            l.send(() => binary++, true);
            l.send(() => text++, false);
            clock.advance(5);
        }
        clock.advance(1000);
        expect(text).toBe(100);
        expect(binary).toBeLessThan(80);
        expect(binary + l.dropped).toBe(100);
    });

    it('lossless messages (the close) wait behind the queue but are never lost', () => {
        const { clock, link: l } = link({ rttMs: 100, loss: 0.5, mode: 'drop' }, 5);
        const order: string[] = [];
        l.send(() => order.push('a'), false);
        l.send(() => order.push('close'), true, true);
        clock.advance(1000);
        expect(order).toEqual(['a', 'close']);
    });

    it('draws one random number per message for its jitter when nothing is lost', () => {
        // Messages 1 s apart, so none waits behind another: each takes
        // 50 ms ± 20 ms with the next value of the seeded stream
        const { clock, link: l } = link({ rttMs: 100, jitterMs: 40, loss: 0 }, 7);
        const stream = mulberry32(7);
        for (let i = 0; i < 20; i++) {
            const sentAt = clock.time;
            let delay = -1;
            l.send(() => { delay = clock.time - sentAt; }, true);
            clock.advance(1000);
            expect(delay, `message ${i}`).toBeCloseTo(50 + (stream() - 0.5) * 40, 9);
        }
        expect(l.sent).toBe(20);
    });

    it('drop: a lost JSON message is neither dropped nor late', () => {
        const { clock, link: l } = link({ rttMs: 60, loss: 0.5, mode: 'drop' }, 11);
        const delays: number[] = [];
        for (let i = 0; i < 40; i++) {
            const sentAt = clock.time;
            l.send(() => delays.push(clock.time - sentAt), false);
            clock.advance(100);
        }
        expect(delays).toEqual(Array(40).fill(30));
        expect(l.delayed).toBe(0);
        expect(l.dropped).toBe(0);
    });

    it('counts the messages still waiting', () => {
        const { clock, link: l } = link({ rttMs: 100 });
        l.send(() => {}, true);
        clock.advance(10);
        l.send(() => {}, true);
        l.send(() => {}, true);
        expect(l.pending).toBe(3);
        clock.advance(40);
        expect(l.pending).toBe(2);
        clock.advance(10);
        expect(l.pending).toBe(0);
    });

    it('a connection closes both directions', () => {
        const clock = new FakeClock();
        const connection = new NetsimConnection({ rttMs: 100, jitterMs: 0, loss: 0, mode: 'tcp' }, mulberry32(1), clock);
        let n = 0;
        connection.up.send(() => n++, false);
        connection.down.send(() => n++, false);
        connection.close();
        clock.advance(1000);
        expect(n).toBe(0);
    });

    it('delivers nothing after close', () => {
        const { clock, link: l } = link({ rttMs: 100 });
        let n = 0;
        l.send(() => n++, false);
        l.close();
        l.send(() => n++, false);
        clock.advance(1000);
        expect(n).toBe(0);
        expect(l.pending).toBe(0);
    });
});

describe('reconnect policy', () => {
    it('backs off 0.5, 1, 2, 4, then every 8 s, each ±20 %', () => {
        // The steps from docs/phase-1b-design.md, 11.1, written out here
        const expected = [500, 1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000, 8000, 8000, 8000];
        for (let attempt = 0; attempt < expected.length; attempt++) {
            const base = expected[attempt];
            // Middle of the jitter range: the step itself
            expect(reconnectDelayMs(attempt, () => 0.5), `attempt ${attempt}`).toBe(base);
            // The ends of the range: -20 % and (almost) +20 %
            expect(reconnectDelayMs(attempt, () => 0), `attempt ${attempt}`).toBe(base * 0.8);
            expect(reconnectDelayMs(attempt, () => 0.999), `attempt ${attempt}`).toBe(Math.round(base * (1 + 0.998 * 0.2)));
        }
        expect(reconnectDelayMs(100, () => 0.5)).toBe(8000);
        // A negative attempt counts as the first
        expect(reconnectDelayMs(-3, () => 0.5)).toBe(500);
        // A seeded random stays inside the range for every attempt
        const random = mulberry32(9);
        for (let attempt = 0; attempt < expected.length; attempt++) {
            for (let i = 0; i < 50; i++) {
                const delay = reconnectDelayMs(attempt, random);
                expect(delay).toBeGreaterThanOrEqual(expected[attempt] * 0.8);
                expect(delay).toBeLessThanOrEqual(expected[attempt] * 1.2);
            }
        }
    });

    it('reconnects on its own after losses and restarts, not after kicks', () => {
        expect(closeAction(1006)).toBe('reconnect');
        expect(closeAction(1012)).toBe('reconnect');
        expect(closeAction(1001)).toBe('reconnect');
        expect(closeAction(1000)).toBe('reconnect');
        expect(closeAction(4002)).toBe('reconnect');
        expect(closeAction(4000)).toBe('reload');
        expect(closeAction(4001)).toBe('manual');
        expect(closeAction(4001, 'hello')).toBe('manual');
        expect(closeAction(4003)).toBe('manual');
        expect(closeAction(4005)).toBe('manual');
        expect(closeAction(4004)).toBe('continue');
    });

    it('reconnects when the server gave up waiting for the hello of a busy page', () => {
        // A page whose world build held back the open event: its hello came
        // too late, nothing was wrong with it (server index.ts, 'no hello')
        expect(closeAction(4001, 'no hello')).toBe('reconnect');
        // The reason only counts for 4001
        expect(closeAction(4003, 'no hello')).toBe('manual');
    });
});
