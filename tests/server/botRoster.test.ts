import { describe, expect, it } from 'vitest';
import { BOT_NAMES, BotSession, drawBots } from '../../src/server/race/botRoster.js';
import { mulberry32 } from '../../src/shared/math/rng.js';
import { CAR_CLASS_IDS } from '../../src/shared/sim/vehicleClasses.js';

// The race bots' identities and sessions (docs/phase-2-design.md, 6.3).

describe('drawBots', () => {
    it('gives distinct names while there are enough, and the same bots for the same seed', () => {
        const bots = drawBots(7, mulberry32(5));
        expect(new Set(bots.map(b => b.name)).size).toBe(7);
        expect(bots.map(b => b.name).sort()).toEqual([...BOT_NAMES].sort());
        expect(drawBots(7, mulberry32(5))).toEqual(bots);
        expect(drawBots(7, mulberry32(6)).map(b => b.name)).not.toEqual(bots.map(b => b.name));
        for (const bot of bots) expect(CAR_CLASS_IDS).toContain(bot.carType);
    });

    it('spreads names, classes and colours over the seeds', () => {
        const draws = Array.from({ length: 40 }, (_, seed) => drawBots(1, mulberry32(seed))[0]);
        expect(new Set(draws.map(d => d.name)).size).toBe(BOT_NAMES.length);
        expect(new Set(draws.map(d => d.carType)).size).toBe(CAR_CLASS_IDS.length);
        expect(new Set(draws.map(d => d.color)).size).toBeGreaterThan(4);
    });
});

describe('BotSession', () => {
    it('is an open, connected session with no round trip and a standard profile', () => {
        const session = new BotSession('bot-1', 'Kalle', 0xff0000, 'sport');
        expect(session.open).toBe(true);
        expect(session.connected).toBe(true);
        expect(session.rttMs).toBe(0);
        expect([session.name, session.carType, session.profile]).toEqual(['Kalle', 'sport', 'standard']);
        // Never backed up: a bot's snapshots always "go out" (into nothing)
        expect(session.sendSnapshot(new Uint8Array(10))).toBe(true);
        expect(() => session.send({ type: 'kicked', reason: 'idle' })).not.toThrow();
    });
});
