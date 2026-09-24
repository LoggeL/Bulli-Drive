import { describe, expect, it } from 'vitest';
import { GHOST_POSE_CACHE_MAX, MemoryGhostStore, ReplayBudget, ghostKeyString, simHash } from '../../src/server/race/ghostStore.js';
import { GHOST_PERSONAL_MAX } from '../../src/shared/race/rules.js';
import { SIM_TUNING } from '../../src/shared/sim/constants.js';
import { resetTuning } from '../../src/shared/sim/tuning.js';
import { VEHICLE_CLASSES } from '../../src/shared/sim/vehicleClasses.js';
import { ghostRun, ghostStoreContract, KEY } from './ghostStore.contract.js';

// The in-memory ghost store of phase 2 against the shared contract, plus
// the ghost key: the sim hash follows the shipped defaults only.

ghostStoreContract('MemoryGhostStore', (posesOf, personalMax) => new MemoryGhostStore(posesOf, personalMax));

describe('ghost keys', () => {
    it('name the track, its version, the map version and the sim hash', () => {
        expect(ghostKeyString(KEY)).toBe('hill-sprint|1|3|abc123');
    });

    it('hash the shipped defaults, so live tuning in the sandbox does not change them', () => {
        const before = simHash();
        expect(before).toMatch(/^[0-9a-f]{8}$/);
        SIM_TUNING.G_TIRE += 1;
        VEHICLE_CLASSES.bulli.topSpeed += 1;
        try {
            expect(simHash()).toBe(before);
        } finally {
            resetTuning();
        }
    });

});

describe('MemoryGhostStore memory', () => {
    it('stays within 5 MB with every personal best of 100 s runs on both tracks and all their poses asked for', () => {
        // 100 s: 6000 ticks of input (4 B) and 2000 pose samples (13 B)
        const store = new MemoryGhostStore(() => new Uint8Array(2000 * 13));
        const keys = [KEY, { ...KEY, trackId: 'downtown-loop' as const }];
        for (const key of keys) {
            for (let i = 0; i < GHOST_PERSONAL_MAX + 10; i++) {
                const run = { ...ghostRun(`p${i}`, 6000 - i, key), inputs: new Uint8Array(6000 * 4) };
                store.submit(run);
                store.poses(run);
            }
        }
        // 2 · 64 runs of 24 000 B plus 16 pose tracks of 26 000 B
        expect(store.bytes()).toBe(2 * GHOST_PERSONAL_MAX * 24_000 + GHOST_POSE_CACHE_MAX * 26_000);
        expect(store.bytes()).toBeLessThanOrEqual(5 * 1024 * 1024);
    });
});

describe('ReplayBudget', () => {
    it('allows the burst at once, then perSecond replays a second', () => {
        const budget = new ReplayBudget(2, 2);
        const t0 = 10_000;
        expect([budget.take(t0), budget.take(t0), budget.take(t0)]).toEqual([true, true, false]);
        // Half a second brings one back (2 per second), a quarter only half of one
        expect(budget.take(t0 + 250)).toBe(false);
        expect(budget.take(t0 + 500)).toBe(true);
        expect(budget.take(t0 + 500)).toBe(false);
        // A long pause fills it up to the burst, not beyond
        expect([budget.take(t0 + 60_000), budget.take(t0 + 60_000), budget.take(t0 + 60_000)]).toEqual([true, true, false]);
    });
});

