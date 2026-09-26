import { describe, expect, it } from 'vitest';
import { FetchTally } from '../../src/client/assets/fetchTally.js';

// The downloads behind the loading screen's kit and texture steps
// (src/client/assets/fetchTally.ts): bytes by the manifests' sizes, a file
// counted once its bytes are in. Values by hand.

const progressEvent = (loaded: number, total: number) =>
    ({ loaded, total, lengthComputable: total > 0 }) as ProgressEvent;

describe('the fetch tally', () => {
    it('adds the bytes up over the expected sizes and counts a file once its last byte is in', () => {
        const tally = new FetchTally();
        expect(tally.fraction()).toBe(0);
        tally.expect('a.glb', 300);
        tally.expect('b.ktx2', 100);
        // 150 of a's 300 bytes: 150 / 400
        tally.listener('a.glb')(progressEvent(150, 300));
        expect(tally.fraction()).toBeCloseTo(0.375, 12);
        expect(tally.count()).toEqual([0, 2]);
        // b complete: 250 / 400, one file of two
        tally.listener('b.ktx2')(progressEvent(100, 100));
        expect(tally.fraction()).toBeCloseTo(0.625, 12);
        expect(tally.count()).toEqual([1, 2]);
    });

    it('never goes back, never past a file\'s size, and takes a finished or failed file as in', () => {
        const tally = new FetchTally();
        tally.expect('a', 200);
        tally.progress('a', 120);
        tally.progress('a', 80);
        expect(tally.fraction()).toBeCloseTo(0.6, 12);
        // A gzipped body can read more than its Content-Length
        tally.progress('a', 999);
        expect(tally.fraction()).toBe(1);
        expect(tally.count()).toEqual([0, 1]);
        // No length from the server: the loader's end counts it
        tally.expect('b', 200);
        tally.listener('b')(progressEvent(50, 0));
        expect(tally.count()).toEqual([0, 2]);
        tally.fetched('b');
        tally.fetched('a');
        expect(tally.count()).toEqual([2, 2]);
        expect(tally.fraction()).toBe(1);
    });

    it('keeps the first size of a file expected twice and ignores files it was not told of', () => {
        const tally = new FetchTally();
        tally.expect('a', 100);
        tally.expect('a', 900);
        tally.progress('a', 50);
        tally.progress('ghost', 50);
        tally.fetched('ghost');
        expect(tally.fraction()).toBeCloseTo(0.5, 12);
        expect(tally.count()).toEqual([0, 1]);
    });
});
