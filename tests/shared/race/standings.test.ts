import { describe, expect, it } from 'vitest';
import { createRaceProgress, type RaceProgress } from '../../../src/shared/race/progress.js';
import { computeStandings, gapAhead, type StandingEntry } from '../../../src/shared/race/standings.js';

// Race order (docs/phase-2-design.md, 9): finished before racing before DNF
// before left; finishers by time; the rest by gates passed (more first),
// then remaining distance (less first); ties by slot.

function racer(slot: number, patch: Partial<RaceProgress>): StandingEntry {
    return { slot, progress: { ...createRaceProgress(), ...patch } };
}

const order = (entries: StandingEntry[]) => computeStandings(entries).map(e => e.slot);

describe('computeStandings', () => {
    it('puts finishers first by time, then racers, DNF and left', () => {
        expect(order([
            racer(0, { status: 'left', passed: 20 }),
            racer(1, { status: 'dnf', passed: 12 }),
            racer(2, { status: 'racing', passed: 3, remaining: 50 }),
            racer(3, { status: 'finished', passed: 25, finishTicks: 5000.5 }),
            racer(4, { status: 'finished', passed: 25, finishTicks: 4999.75 })
        ])).toEqual([4, 3, 2, 1, 0]);
    });

    it('orders racers by gates passed, then by the distance still to go', () => {
        expect(order([
            racer(0, { passed: 4, remaining: 80 }),
            racer(1, { passed: 5, remaining: 90 }),
            racer(2, { passed: 4, remaining: 10 }),
            // Past its next gate without crossing it: negative, still ahead on the road
            racer(3, { passed: 4, remaining: -5 })
        ])).toEqual([1, 3, 2, 0]);
    });

    it('orders DNF racers by how far they got, and breaks every tie by slot', () => {
        expect(order([
            racer(5, { status: 'dnf', passed: 2, remaining: 30 }),
            racer(1, { status: 'dnf', passed: 7, remaining: 30 }),
            racer(3, { passed: 4, remaining: 10 }),
            racer(2, { passed: 4, remaining: 10 }),
            racer(4, { status: 'left', passed: 9 }),
            racer(0, { status: 'left', passed: 1 })
        ])).toEqual([2, 3, 1, 5, 0, 4]);
        expect(order([
            racer(6, { status: 'finished', finishTicks: 100 }),
            racer(2, { status: 'finished', finishTicks: 100 })
        ])).toEqual([2, 6]);
    });

    it('returns a sorted copy', () => {
        const entries = [racer(1, { passed: 1 }), racer(0, { passed: 2 })];
        const sorted = computeStandings(entries);
        expect(sorted.map(e => e.slot)).toEqual([0, 1]);
        expect(entries.map(e => e.slot)).toEqual([1, 0]);
    });
});

describe('gapAhead', () => {
    it('is the difference of the same crossing, positive when behind', () => {
        const ahead = { ...createRaceProgress(), gateTimes: [10, 200.25, 400] };
        const me = { ...createRaceProgress(), gateTimes: [12.5, 201] };
        expect(gapAhead(me, ahead, 0)).toBe(2.5);
        expect(gapAhead(me, ahead, 1)).toBe(0.75);
        // The car ahead sees the same value with the other sign
        expect(gapAhead(ahead, me, 1)).toBe(-0.75);
        expect(gapAhead(me, ahead, 2)).toBeNull();
        expect(gapAhead(ahead, me, 2)).toBeNull();
        expect(gapAhead(me, ahead, -1)).toBeNull();
    });
});
