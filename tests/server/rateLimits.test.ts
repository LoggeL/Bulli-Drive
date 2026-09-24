import { describe, expect, it } from 'vitest';
import { Session } from '../../src/server/session.js';
import { FakeTransport } from './helpers.js';

// Per-session limits for JSON messages (docs/phase-1b-design.md, 5.2): a
// budget for every message type, so one without a limit of its own cannot
// be multiplied to a whole room.

function session(): Session {
    return new Session('s', new FakeTransport(), 'Rate', 0);
}

describe('admitMessage', () => {
    it('lets a real client through: a burst of clock pings, then a few per second', () => {
        const s = session();
        // Five clock pings right after joining, ready, setCar, rename
        for (let i = 0; i < 8; i++) expect(s.admitMessage(1000 + i)).toBe('ok');
        // Then honks, shots and pings, about 5 per second for a minute
        for (let t = 2000; t < 62_000; t += 200) expect(s.admitMessage(t)).toBe('ok');
    });

    it('drops what goes over 40 at once or 20 per second', () => {
        const s = session();
        const burst = Array.from({ length: 60 }, () => s.admitMessage(1000));
        expect(burst.filter(r => r === 'ok')).toHaveLength(40);
        expect(burst.slice(40).every(r => r === 'drop')).toBe(true);
        // Half a second later ten more tokens
        const later = Array.from({ length: 15 }, () => s.admitMessage(1500));
        expect(later.filter(r => r === 'ok')).toHaveLength(10);
    });

    it('kicks a sustained flood after its first two seconds', () => {
        const s = session();
        let kickedAt = -1;
        // 1000 messages a second
        for (let t = 0; t <= 5000 && kickedAt < 0; t++) {
            if (s.admitMessage(1000 + t) === 'kick') kickedAt = t;
        }
        expect(kickedAt).toBe(2000);
    });

    it('does not kick 50 messages per second (dropped, not a flood)', () => {
        const s = session();
        for (let t = 0; t < 10_000; t += 20) expect(s.admitMessage(1000 + t)).not.toBe('kick');
    });
});
