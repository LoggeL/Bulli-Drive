import { describe, expect, it } from 'vitest';
import type { GhostKey, GhostRun, GhostStore } from '../../src/server/race/ghostStore.js';

// The contract of every ghost store (docs/phase-2-design.md, 15.3): phase 2
// runs it against MemoryGhostStore, phase 4 unchanged against the SQLite
// store. make gets posesOf (the pose track of a run) and the number of
// personal bests kept per key.

export type MakeStore = (posesOf: (run: GhostRun) => Uint8Array, personalMax: number) => GhostStore;

export const KEY: GhostKey = { trackId: 'hill-sprint', trackVersion: 1, mapVersion: 3, simHash: 'abc123' };

export function ghostRun(playerKey: string, finishTicks: number, key: GhostKey = KEY): GhostRun {
    return {
        key, carType: 'bulli', profile: 'standard', playerKey, playerName: `Name ${playerKey}`,
        finishTicks, gateTicks: [0, finishTicks / 2, finishTicks], spawnToStart: 270,
        inputs: new Uint8Array([0, 255, 0, 0]), recordedAt: 1
    };
}

export function ghostStoreContract(name: string, make: MakeStore): void {
    describe(`${name}: the GhostStore contract`, () => {
        const plain = () => make(() => new Uint8Array(13), 64);

        it('keeps the track record: only a faster run replaces it', () => {
            const store = plain();
            expect(store.best(KEY)).toBeNull();
            expect(store.submit(ghostRun('a', 1500))).toEqual({ record: true, personal: true });
            expect(store.submit(ghostRun('b', 1600))).toEqual({ record: false, personal: true });
            expect(store.best(KEY)!.playerKey).toBe('a');
            // Equal is not faster
            expect(store.submit(ghostRun('c', 1500)).record).toBe(false);
            expect(store.submit(ghostRun('b', 1400))).toEqual({ record: true, personal: true });
            expect(store.best(KEY)).toMatchObject({ playerKey: 'b', finishTicks: 1400 });
        });

        it('keeps a personal best per player, replaced only by a faster run of the same player', () => {
            const store = plain();
            store.submit(ghostRun('a', 1500));
            expect(store.submit(ghostRun('a', 1550))).toEqual({ record: false, personal: false });
            expect(store.personalBest(KEY, 'a')!.finishTicks).toBe(1500);
            expect(store.submit(ghostRun('a', 1450)).personal).toBe(true);
            expect(store.personalBest(KEY, 'a')!.finishTicks).toBe(1450);
            expect(store.personalBest(KEY, 'nobody')).toBeNull();
        });

        it('finds nothing under another sim hash, track version or map version', () => {
            const store = plain();
            store.submit(ghostRun('a', 1500));
            for (const key of [{ ...KEY, simHash: 'other' }, { ...KEY, trackVersion: 2 }, { ...KEY, mapVersion: 4 }, { ...KEY, trackId: 'downtown-loop' as const }]) {
                expect(store.best(key)).toBeNull();
                expect(store.personalBest(key, 'a')).toBeNull();
            }
        });

        it('keeps personal bests up to the limit, dropping the least recently used', () => {
            const store = make(() => new Uint8Array(13), 3);
            for (const player of ['a', 'b', 'c']) store.submit(ghostRun(player, 1500));
            // a is used, so b is the oldest when d comes
            expect(store.personalBest(KEY, 'a')).not.toBeNull();
            store.submit(ghostRun('d', 1500));
            expect(store.personalBest(KEY, 'b')).toBeNull();
            expect(['a', 'c', 'd'].map(p => store.personalBest(KEY, p)?.playerKey)).toEqual(['a', 'c', 'd']);
            // Now a, c, d by last use; a slower run of a still counts as a use
            store.submit(ghostRun('a', 1900));
            store.submit(ghostRun('e', 1500));
            expect(store.personalBest(KEY, 'c')).toBeNull();
            expect(store.personalBest(KEY, 'a')!.finishTicks).toBe(1500);
        });

        it('computes the pose track of a run once', () => {
            let calls = 0;
            const store = make(run => { calls++; return new Uint8Array([run.finishTicks & 0xff]); }, 64);
            const run = ghostRun('a', 1500);
            store.submit(run);
            expect(Array.from(store.poses(run))).toEqual([1500 & 0xff]);
            store.poses(run);
            expect(calls).toBe(1);
        });
    });
}
