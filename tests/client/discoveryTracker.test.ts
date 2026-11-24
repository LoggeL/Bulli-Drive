import { describe, expect, it, vi } from 'vitest';
import type { DiscoveryDef } from '../../src/shared/map/discoverySchema.js';
import {
    DISCOVERY_STORAGE_KEY, DiscoveryTracker, type DiscoveryStorage
} from '../../src/client/ui/discoveryTracker.js';

function memoryStorage(initial: Record<string, string> = {}): DiscoveryStorage & { store: Map<string, string> } {
    const store = new Map(Object.entries(initial));
    return {
        store,
        getItem: key => store.get(key) ?? null,
        setItem: (key, value) => { store.set(key, value); }
    };
}

const throwingStorage: DiscoveryStorage = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('QuotaExceededError'); }
};

const TEST_DEFS: readonly DiscoveryDef[] = [
    {
        id: 'prox-arch',
        title: 'Forge Arch',
        subtitle: 'Entryway',
        alloy: 'forge',
        x: 100,
        z: 0,
        hint: 'Drive through the arch.',
        codexEntry: 'Forged in curiosity.',
        toast: 'Welcome to the Forge!',
        rewardEffect: 'sparks',
        trigger: { kind: 'proximity', radius: 10 }
    },
    {
        id: 'horn-knopf',
        title: 'Red Knopf',
        subtitle: 'Honk to press',
        alloy: 'web',
        x: 200,
        z: 0,
        hint: 'Honk next to the giant red button.',
        codexEntry: 'Never press the red button.',
        toast: 'You pressed it!',
        rewardEffect: 'flash',
        trigger: { kind: 'horn', radius: 12 }
    },
    {
        id: 'park-shrine',
        title: 'Toaster Shrine',
        subtitle: 'Pay respects',
        alloy: 'games',
        x: 300,
        z: 0,
        hint: 'Park quietly for 3 seconds.',
        codexEntry: 'Warm golden toast.',
        toast: 'Toasted!',
        rewardEffect: 'confetti',
        trigger: { kind: 'park', radius: 15, holdSec: 3, maxSpeed: 2 }
    },
    {
        id: 'air-canyon',
        title: 'Canyon Soar',
        subtitle: 'Big air',
        alloy: 'stunt',
        x: 400,
        z: 0,
        hint: 'Catch 1.2s of airtime over the canyon.',
        codexEntry: 'Gravity is optional.',
        toast: 'Airborne!',
        rewardEffect: 'shockwave',
        trigger: { kind: 'airtime', radius: 20, minAirSec: 1.2 }
    },
    {
        id: 'speed-reactor',
        title: 'Jet Loop Reactor',
        subtitle: 'Full throttle',
        alloy: 'ai',
        x: 500,
        z: 0,
        hint: 'Blast past at 120 km/h.',
        codexEntry: 'Turbocharged loop.',
        toast: 'Mach Bulli!',
        rewardEffect: 'laser',
        trigger: { kind: 'speed', radius: 18, minSpeedKmh: 120 }
    }
];

describe('DiscoveryTracker trigger evaluation', () => {
    it('unlocks proximity discoveries only inside the trigger radius and never twice', () => {
        const storage = memoryStorage();
        const tracker = new DiscoveryTracker(storage);
        tracker.setMap('logge-forge', TEST_DEFS);
        const onUnlock = vi.fn();
        tracker.onUnlock(onUnlock);

        // Just outside radius (distance 10.5 > 10)
        expect(tracker.update({ x: 110.5, z: 0, speedMs: 10, airborne: false, dt: 0.1 })).toEqual([]);
        expect(tracker.isFound('prox-arch')).toBe(false);

        // On exact boundary (distance 10 <= 10)
        const hit = tracker.update({ x: 110, z: 0, speedMs: 10, airborne: false, dt: 0.1 });
        expect(hit.map(d => d.id)).toEqual(['prox-arch']);
        expect(tracker.isFound('prox-arch')).toBe(true);
        expect(onUnlock).toHaveBeenCalledTimes(1);
        expect(onUnlock).toHaveBeenCalledWith(TEST_DEFS[0], { found: 1, total: 5 });

        // Subsequent frames inside radius do not re-trigger
        expect(tracker.update({ x: 100, z: 0, speedMs: 0, airborne: false, dt: 0.1 })).toEqual([]);
        expect(onUnlock).toHaveBeenCalledTimes(1);
    });

    it('unlocks horn discoveries strictly via onHorn inside radius, never by proximity alone', () => {
        const tracker = new DiscoveryTracker(memoryStorage());
        tracker.setMap('logge-forge', TEST_DEFS);

        // Driving directly on top of it does nothing
        expect(tracker.update({ x: 200, z: 0, speedMs: 0, airborne: false, dt: 0.2 })).toEqual([]);
        // Honking outside radius (13 > 12) does nothing
        expect(tracker.onHorn(213, 0)).toEqual([]);
        // Honking inside radius unlocks once
        expect(tracker.onHorn(206, 8).map(d => d.id)).toEqual(['horn-knopf']); // dist = 10 <= 12
        expect(tracker.onHorn(200, 0)).toEqual([]);
    });

    it('requires continuous low-speed parking for holdSec and resets timer on movement or exit', () => {
        const tracker = new DiscoveryTracker(memoryStorage());
        tracker.setMap('logge-forge', TEST_DEFS);

        // Accumulate 2.0s of parking (dt clamped at 0.25s per frame -> 8 frames)
        for (let i = 0; i < 8; i++) {
            expect(tracker.update({ x: 300, z: 0, speedMs: 1.8, airborne: false, dt: 0.25 })).toEqual([]);
        }
        expect(tracker.parkProgress('park-shrine')).toBeCloseTo(2 / 3, 2);

        // Exceed maxSpeed (2.5 > 2.0) -> timer MUST reset to 0
        tracker.update({ x: 300, z: 0, speedMs: 2.5, airborne: false, dt: 0.25 });
        expect(tracker.parkProgress('park-shrine')).toBe(0);

        // Park again for 2.5s, then step outside radius -> timer MUST reset
        for (let i = 0; i < 10; i++) {
            tracker.update({ x: 305, z: 0, speedMs: 0, airborne: false, dt: 0.25 });
        }
        expect(tracker.parkProgress('park-shrine')).toBeCloseTo(2.5 / 3, 2);
        tracker.update({ x: 320, z: 0, speedMs: 0, airborne: false, dt: 0.25 });
        expect(tracker.parkProgress('park-shrine')).toBe(0);

        // Hold continuously for full 3.0s (12 * 0.25s) -> unlocks on final tick
        for (let i = 0; i < 11; i++) {
            expect(tracker.update({ x: 300, z: 0, speedMs: 0.5, airborne: false, dt: 0.25 })).toEqual([]);
        }
        const unlocked = tracker.update({ x: 300, z: 0, speedMs: 0.5, airborne: false, dt: 0.25 });
        expect(unlocked.map(d => d.id)).toEqual(['park-shrine']);
        expect(tracker.isFound('park-shrine')).toBe(true);
    });

    it('requires sustained airtime >= minAirSec inside radius and resets airtime on landing', () => {
        const tracker = new DiscoveryTracker(memoryStorage());
        tracker.setMap('logge-forge', TEST_DEFS);

        // Grounded inside radius never triggers
        expect(tracker.update({ x: 400, z: 0, speedMs: 30, airborne: false, dt: 0.2 })).toEqual([]);

        // Airborne for 1.0s (< 1.2s) then lands -> resets
        for (let i = 0; i < 5; i++) {
            expect(tracker.update({ x: 400, z: 0, speedMs: 30, airborne: true, dt: 0.2 })).toEqual([]);
        }
        expect(tracker.update({ x: 400, z: 0, speedMs: 30, airborne: false, dt: 0.2 })).toEqual([]);

        // Airborne outside radius for 1.0s, then enters radius and stays airborne 0.25s (total 1.25s >= 1.2s)
        for (let i = 0; i < 5; i++) {
            expect(tracker.update({ x: 350, z: 0, speedMs: 35, airborne: true, dt: 0.2 })).toEqual([]);
        }
        const hit = tracker.update({ x: 405, z: 0, speedMs: 35, airborne: true, dt: 0.25 });
        expect(hit.map(d => d.id)).toEqual(['air-canyon']);
    });

    it('unlocks speed discoveries only when speed (km/h) meets minSpeedKmh inside radius', () => {
        const tracker = new DiscoveryTracker(memoryStorage());
        tracker.setMap('logge-forge', TEST_DEFS);

        // 115 km/h = 31.94 m/s -> too slow
        expect(tracker.update({ x: 500, z: 0, speedMs: 115 / 3.6, airborne: false, dt: 0.1 })).toEqual([]);
        // 140 km/h outside radius (distance 22 > 18) -> too far
        expect(tracker.update({ x: 522, z: 0, speedMs: 140 / 3.6, airborne: false, dt: 0.1 })).toEqual([]);
        // 122 km/h inside radius -> unlocks
        const hit = tracker.update({ x: 505, z: 0, speedMs: 122 / 3.6, airborne: false, dt: 0.1 });
        expect(hit.map(d => d.id)).toEqual(['speed-reactor']);
    });
});

describe('DiscoveryTracker persistence, per-map isolation, and pinning', () => {
    it('persists unlocked IDs per map in localStorage and reloads cleanly', () => {
        const storage = memoryStorage();
        const first = new DiscoveryTracker(storage);
        first.setMap('logge-forge', TEST_DEFS);
        first.update({ x: 100, z: 0, speedMs: 5, airborne: false, dt: 0.1 });
        first.onHorn(200, 0);

        // Switching to bulli-bay isolates progress
        const bayDef: DiscoveryDef = { ...TEST_DEFS[0], id: 'bay-pier', alloy: 'coastal', x: 0, z: 0 };
        first.setMap('bulli-bay', [bayDef]);
        expect(first.getProgress('bulli-bay')).toEqual({ found: 0, total: 1 });
        expect(first.isFound('prox-arch', 'logge-forge')).toBe(true);
        expect(first.isFound('prox-arch', 'bulli-bay')).toBe(false);

        first.update({ x: 0, z: 0, speedMs: 5, airborne: false, dt: 0.1 });
        expect(first.getProgress('bulli-bay')).toEqual({ found: 1, total: 1 });

        // Fresh tracker reads persisted storage
        const second = new DiscoveryTracker(storage);
        second.setMap('logge-forge', TEST_DEFS);
        expect(second.getProgress('logge-forge')).toEqual({ found: 2, total: 5 });
        expect([...second.getFoundIds('logge-forge')].sort()).toEqual(['horn-knopf', 'prox-arch']);
        expect([...second.getFoundIds('bulli-bay')]).toEqual(['bay-pier']);
    });

    it('pins valid discoveries, auto-unpins on unlock, and clears pin across map changes', () => {
        const tracker = new DiscoveryTracker(memoryStorage());
        tracker.setMap('logge-forge', TEST_DEFS);

        tracker.pin('unknown-id');
        expect(tracker.getPinnedId()).toBeNull();

        tracker.pin('horn-knopf');
        expect(tracker.getPinnedId()).toBe('horn-knopf');
        expect(tracker.getPinnedDefinition()?.title).toBe('Red Knopf');

        // Unlocking the pinned discovery clears the pin automatically
        tracker.onHorn(200, 0);
        expect(tracker.getPinnedId()).toBeNull();

        // Switching map clears a pin that does not exist on the new map
        tracker.pin('speed-reactor');
        expect(tracker.getPinnedId()).toBe('speed-reactor');
        tracker.setMap('bulli-bay', []);
        expect(tracker.getPinnedId()).toBeNull();
    });

    it('handles corrupt JSON and throwing storage without crashing', () => {
        const corrupt = memoryStorage({ [DISCOVERY_STORAGE_KEY]: '{not valid json' });
        const t1 = new DiscoveryTracker(corrupt);
        t1.setMap('logge-forge', TEST_DEFS);
        expect(t1.getProgress()).toEqual({ found: 0, total: 5 });

        const t2 = new DiscoveryTracker(throwingStorage);
        t2.setMap('logge-forge', TEST_DEFS);
        expect(() => t2.update({ x: 100, z: 0, speedMs: 5, airborne: false, dt: 0.1 })).not.toThrow();
        expect(t2.isFound('prox-arch')).toBe(true);
    });
});
