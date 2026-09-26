import { describe, expect, it } from 'vitest';
import { mapFor } from '../../../src/server/maps.js';
import { createMapData, FOUNTAIN_RADIUS } from '../../../src/shared/map/mapData.js';

// Bulli Bay built again from changed sources (src/shared/map/mapData.ts):
// the same sources give the same world, and a coin, a height, the Party zone,
// the jumps or the fountain change it as they should. Each test builds the
// whole map once or more, so they sit in a file of their own and run beside
// the checks of mapData.test.ts instead of after them.

describe('Bulli Bay built from changed sources', () => {
    const map = mapFor();
    // A build of the whole map takes about 0.3 s here, but several seconds on
    // a 4-core CI runner with every worker busy (the default 5 s timed out
    // there)
    const WHOLE_MAP_TIMEOUT = 30_000;

    it('builds the same world twice, and a moved coin or height changes its hash', { timeout: WHOLE_MAP_TIMEOUT }, () => {
        expect(createMapData(map.sources, map.hf).worldHash).toBe(map.worldHash);
        const pois = structuredClone(map.sources.pois);
        pois.arena.coins[0][0] += 1;
        expect(createMapData({ ...map.sources, pois }, map.hf).worldHash).not.toBe(map.worldHash);
        const q = map.hf.q.slice();
        q[123456]++;
        expect(createMapData(map.sources, { ...map.hf, q }).worldHash).not.toBe(map.worldHash);
    });

    it('without a Party zone closes the arena\'s gate and plays the Party inside the arena', { timeout: WHOLE_MAP_TIMEOUT }, () => {
        const { party: _party, ...pois } = map.sources.pois;
        const arenaOnly = createMapData({ ...map.sources, pois }, map.hf);
        expect(arenaOnly.partyZone).toEqual(arenaOnly.arenaBounds);
        expect(arenaOnly.fences.some(f => f.party)).toBe(false);
        expect(arenaOnly.partyWorld.colliders).toHaveLength(arenaOnly.colliders.length + 1);
        expect(arenaOnly.partyWorld.colliders.at(-1)).toEqual(expect.objectContaining({ kind: 'segment', ax: arenaOnly.arenaGate.ax, bz: arenaOnly.arenaGate.bz }));
        expect(arenaOnly.items.coins).toHaveLength(pois.arena.coins.length);
        expect(arenaOnly.items.powerups).toHaveLength(pois.arena.powerups.length);
        expect(arenaOnly.worldHash).not.toBe(map.worldHash);
    });

    it('fences the Party zone through a container but not through a landmark, and hashes the moved zone', { timeout: WHOLE_MAP_TIMEOUT }, () => {
        // The zone's west side through the middle of container 1 (-222 | 566,
        // lengthwise along z), its east side through light mast 2 (-88 | 652)
        const pois = structuredClone(map.sources.pois);
        pois.party!.zone = { minX: -222, maxX: -88, minZ: 500, maxZ: 728 };
        const fenced = createMapData({ ...map.sources, pois }, map.hf);
        const covers = (x: number, z: number) => fenced.fences.some(f => f.party
            && f.line[0][0] === x && f.line[1][0] === x && Math.min(f.line[0][1], f.line[1][1]) < z && Math.max(f.line[0][1], f.line[1][1]) > z);
        // A container is low: the fence runs past it
        expect(covers(-222, 566)).toBe(true);
        // A landmark is a wall: the fence stops at it
        expect(covers(-88, 652)).toBe(false);
        expect(covers(-88, 640)).toBe(true);
        // A moved Party zone changes the hash
        expect(fenced.worldHash).not.toBe(map.worldHash);
    });

    it('builds a map without jumps and without a fountain', { timeout: WHOLE_MAP_TIMEOUT }, () => {
        const { jumps: _jumps, ...noJumps } = map.sources.pois;
        const pois = { ...noJumps, landmarks: noJumps.landmarks.filter(l => l.kind !== 'fountain') };
        const plain = createMapData({ ...map.sources, pois }, map.hf);
        expect(plain.ramps.map(r => r.id)).toEqual(['arena-ramp-1', 'arena-ramp-2']);
        const fountain = map.sources.pois.landmarks.find(l => l.kind === 'fountain')!;
        expect(plain.colliders.some(c => c.kind === 'circle' && c.x === fountain.x && c.z === fountain.z && c.r === FOUNTAIN_RADIUS)).toBe(false);
    });
});
