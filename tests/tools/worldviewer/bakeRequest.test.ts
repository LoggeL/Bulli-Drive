import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runBake, type BakeRequest } from '../../../tools/worldviewer/logic/bakeRequest.js';

// The worldviewer bakes in the browser with the CLI's code (design 6.4,
// deviation A21). Expected values: the committed terrain.bhf, written by
// `npx tsx tools/map/bake.ts` (regression lock: the bake of the committed
// sources must not change without a new terrain.bhf).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const source = (name: string) => readFileSync(path.join(ROOT, 'src/shared/maps/bulli-bay', name), 'utf8');

function request(): BakeRequest {
    return {
        mapId: 'bulli-bay',
        sources: { roads: source('roads.json'), map: source('map.json'), zones: source('zones.json'), base: source('base.json') }
    };
}

describe('runBake', () => {
    it('bakes the committed source texts into the committed terrain.bhf byte for byte', () => {
        const response = runBake(request());
        expect(response.ok).toBe(true);
        if (!response.ok) return;
        const committed = new Uint8Array(readFileSync(path.join(ROOT, 'public/maps/bulli-bay/terrain.bhf')));
        expect(response.bytes.length).toBe(committed.length);
        expect(Buffer.compare(Buffer.from(response.bytes), Buffer.from(committed))).toBe(0);
        // The manifest of that bake reports no corridor conflicts
        expect(response.summary.conflicts).toBe(0);
        expect(response.summary.infeasibleChains).toEqual([]);
    }, 10_000);

    it('reports elevation pins the grade limit cannot reach', () => {
        const pinned = request();
        const ocean = '{"id":"ocean-1","name":"Ocean Boulevard","from":"ocean-1","to":"ocean-2","curve":{"type":"catmullRom","points":[]},"profile":"ocean-blvd"';
        expect(pinned.sources.roads).toContain(ocean);
        pinned.sources.roads = pinned.sources.roads.replace(ocean, `${ocean},"elevation":[{"s":10,"y":0},{"s":30,"y":30}]`);
        const response = runBake(pinned);
        expect(response.ok).toBe(true);
        if (!response.ok) return;
        // 30 m up over 20 m at the default 8 %: 1.6 m reachable, 28.4 m short
        expect(response.summary.infeasibleChains).toHaveLength(1);
        expect(response.summary.infeasibleChains[0].edges).toEqual(['ocean-1']);
        expect(response.summary.infeasibleChains[0].infeasible).toBeCloseTo(28.4, 6);
    }, 10_000);

    it('reports invalid sources instead of throwing', () => {
        const broken = request();
        broken.sources.roads = broken.sources.roads.replace('"from":"pch-north"', '"from":"nowhere"');
        const response = runBake(broken);
        expect(response.ok).toBe(false);
        if (!response.ok) expect(response.error).toMatch(/^roads\.json:/);
        expect(runBake({ ...request(), mapId: 'atlantis' })).toEqual({ ok: false, error: 'no grid for map atlantis' });
        const garbage = request();
        garbage.sources.zones = '{';
        expect(runBake(garbage).ok).toBe(false);
        // Each source goes through its schema, and the error names the file
        const badMap = request();
        expect(badMap.sources.map).toContain('"mapVersion": 2');
        badMap.sources.map = badMap.sources.map.replace('"mapVersion": 2', '"mapVersion": 0');
        const mapResponse = runBake(badMap);
        expect(mapResponse.ok ? '' : mapResponse.error).toMatch(/^map\.json:/);
        const badZones = request();
        badZones.sources.zones = '{"format":"bulli-zones"}';
        const zonesResponse = runBake(badZones);
        expect(zonesResponse.ok ? '' : zonesResponse.error).toMatch(/^zones\.json:/);
    });
});
