import { describe, expect, it } from 'vitest';
import { GHOST_POSE_CACHE_MAX, MemoryGhostStore, ReplayBudget, ghostKeyString, simHash } from '../../src/server/race/ghostStore.js';
import { GHOST_PERSONAL_MAX } from '../../src/shared/race/rules.js';
import { TRACK_IDS } from '../../src/shared/race/types.js';
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
    it('stays within 5 MB with every personal best of 150 s runs on all six tracks and all their poses asked for', () => {
        // 150 s (longer than any bot needs for the Grand Tour): 9000 ticks of
        // input (4 B) and 3000 pose samples (13 B)
        const store = new MemoryGhostStore(() => new Uint8Array(3000 * 13));
        const keys = TRACK_IDS.map(trackId => ({ ...KEY, trackId }));
        expect(keys).toHaveLength(6);
        for (const key of keys) {
            for (let i = 0; i < GHOST_PERSONAL_MAX + 10; i++) {
                const run = { ...ghostRun(`p${i}`, 9000 - i, key), inputs: new Uint8Array(9000 * 4) };
                store.submit(run);
                store.poses(run);
            }
        }
        // 6 · 20 runs of 36 000 B plus 16 pose tracks of 39 000 B: 4.9 MB
        expect(store.bytes()).toBe(6 * GHOST_PERSONAL_MAX * 36_000 + GHOST_POSE_CACHE_MAX * 39_000);
        expect(store.bytes()).toBeLessThanOrEqual(5 * 1024 * 1024);
    });

    it('frees the runs and pose tracks of the keys it drops', () => {
        const store = new MemoryGhostStore(() => new Uint8Array(1000));
        const old = { ...KEY, trackVersion: 1 }, current = { ...KEY, trackVersion: 2 };
        for (const key of [old, current]) {
            const run = { ...ghostRun('a', 1500, key), inputs: new Uint8Array(400) };
            store.submit(run);
            store.poses(run);
        }
        expect(store.bytes()).toBe(2 * (400 + 1000));
        store.retain([current]);
        expect(store.bytes()).toBe(400 + 1000);
    });
});
