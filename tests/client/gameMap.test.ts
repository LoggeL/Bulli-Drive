import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadGameMap, MapVersionError, reloadForMap } from '../../src/client/map/gameMap.js';
import mapFile from '../../src/shared/maps/bulli-bay/map.json';

// Loading the map (src/client/map/gameMap.ts) against a server of another
// deploy: a manifest of a newer map version fails the load with a
// MapVersionError (every retry would fail the same way), which reloads the
// page once per served version.

function serve(manifest: object, terrain: number) {
    vi.stubGlobal('fetch', async (url: string) => {
        if (url.endsWith('/manifest.json')) return new Response(JSON.stringify(manifest), { status: 200 });
        return new Response('', { status: terrain });
    });
}

function page() {
    const storage = new Map<string, string>();
    const state = { reloads: 0 };
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) });
    vi.stubGlobal('window', { location: { reload: () => { state.reloads++; } } });
    return state;
}

const files = { terrain: { path: 'terrain.bhf', hash: 'abc' } };

describe('loading the map from another deploy', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('fails with a MapVersionError on a manifest of another map version, before downloading the terrain', async () => {
        const next = mapFile.mapVersion + 1;
        serve({ mapVersion: next, files }, 200);
        const error = await loadGameMap().catch(e => e);
        expect(error).toBeInstanceOf(MapVersionError);
        expect(error.served).toBe(String(next));
    });

    it('fails like any download on its own version (the retries go on)', async () => {
        serve({ mapVersion: mapFile.mapVersion, files }, 502);
        const p = page();
        const error = await loadGameMap().catch(e => e);
        expect(error).not.toBeInstanceOf(MapVersionError);
        expect(String(error)).toContain('HTTP 502');
        expect(reloadForMap(error)).toBe(false);
        expect(p.reloads).toBe(0);
    });

    it('reloads once per served version, not in a loop', () => {
        const p = page();
        expect(reloadForMap(new MapVersionError('9'))).toBe(true);
        expect(reloadForMap(new MapVersionError('9'))).toBe(false);
        expect(reloadForMap(new MapVersionError('10'))).toBe(true);
        expect(p.reloads).toBe(2);
    });
});
