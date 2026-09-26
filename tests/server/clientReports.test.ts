import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientReports, MAX_REPORTS, REPORTS_PER_MINUTE } from '../../src/server/clientReports.js';

// Graphics trouble reports from real devices (src/server/clientReports.ts):
// only well-formed reports are kept, each address is limited per minute,
// and only the newest MAX_REPORTS stay in memory.

function report(event = 'context-lost', extra: Record<string, unknown> = {}) {
    return {
        event, detail: '', build: 'abc', userAgent: 'Mozilla/5.0 (iPhone)', gpu: 'Apple GPU',
        safeMode: false, devicePixelRatio: 3, screen: '390x844', deviceMemory: null, cores: 6,
        secondsSinceLoad: 42, ...extra
    };
}

let now = Date.UTC(2026, 8, 26, 12);
let reports: ClientReports;

beforeEach(() => {
    now = Date.UTC(2026, 8, 26, 12);
    reports = new ClientReports(() => now);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('ClientReports', () => {
    it('keeps a valid report with its time and lists the newest first', () => {
        expect(reports.add('1.1.1.1', report('context-lost'))).toBe('stored');
        now += 5000;
        expect(reports.add('1.1.1.1', report('webgl-unavailable', { detail: 'Error creating WebGL context.' }))).toBe('stored');
        const list = reports.list();
        expect(list.map(r => r.event)).toEqual(['webgl-unavailable', 'context-lost']);
        expect(list[0].detail).toBe('Error creating WebGL context.');
        expect(list[1].at).toBe('2026-09-26T12:00:00.000Z');
    });

    it('rejects unknown events, wrong types and oversized fields without storing them', () => {
        expect(reports.add('1.1.1.1', report('shader-crash'))).toBe('invalid');
        expect(reports.add('1.1.1.1', report('context-lost', { safeMode: 'yes' }))).toBe('invalid');
        expect(reports.add('1.1.1.1', report('context-lost', { userAgent: 'x'.repeat(301) }))).toBe('invalid');
        expect(reports.add('1.1.1.1', null)).toBe('invalid');
        expect(reports.list()).toHaveLength(0);
    });

    it(`limits one address to ${REPORTS_PER_MINUTE} reports a minute, others unaffected`, () => {
        for (let i = 0; i < REPORTS_PER_MINUTE; i++) expect(reports.add('2.2.2.2', report())).toBe('stored');
        expect(reports.add('2.2.2.2', report())).toBe('limited');
        expect(reports.add('3.3.3.3', report())).toBe('stored');
        now += 60_001;
        expect(reports.add('2.2.2.2', report())).toBe('stored');
    });

    it(`keeps only the newest ${MAX_REPORTS} reports`, () => {
        for (let i = 0; i <= MAX_REPORTS; i++) {
            reports.add(`10.0.${i >> 8}.${i & 255}`, report('context-lost', { secondsSinceLoad: i }));
        }
        const list = reports.list();
        expect(list).toHaveLength(MAX_REPORTS);
        expect(list[0].secondsSinceLoad).toBe(MAX_REPORTS);
        expect(list.at(-1)!.secondsSinceLoad).toBe(1);
    });
});
