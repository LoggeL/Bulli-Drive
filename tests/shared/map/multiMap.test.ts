import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
    BILLBOARD_TEXTURES, HERO_PROP_MODELS, billboardReservedBox, boostPadReservedBox, heroPropColliders,
    heroPropReservedBoxes, parseDiscoveriesFile, type DiscoveriesFile, type HeroPropDef
} from '../../../src/shared/map/discoverySchema.js';
import { pointInPolygon } from '../../../src/shared/map/geometry.js';
import { decodeHeightfield, heightAt, surfaceAt, waterDepth } from '../../../src/shared/map/heightfield.js';
import { buildMapFromRaw, fetchMapData, importMapSources, type MapManifestJson } from '../../../src/shared/map/loadMap.js';
import { createMapData } from '../../../src/shared/map/mapData.js';
import type { RawMapSources } from '../../../src/shared/map/mapSources.js';
import {
    DEFAULT_MAP_ID, MAP_GRIDS, MAP_IDS, MAP_REGISTRY, isMapId, mapDescriptor, mapGrid, type MapId
} from '../../../src/shared/map/registry.js';
import { roadSurfaceIdAt } from '../../../src/shared/map/roadNetwork.js';
import { SURFACE, SURFACE_GRIP, SURFACE_PRIORITY, SURFACE_ROLL } from '../../../src/shared/map/types.js';
import { createCourse, createRaceProgress, passGate } from '../../../src/shared/race/progress.js';
import { createRaceWorld } from '../../../src/shared/race/raceWorld.js';
import { buildRacingLine } from '../../../src/shared/race/racingLine.js';
import { MAX_RACERS } from '../../../src/shared/race/rules.js';
import { isTrackId, mapTracks, nextTrack, trackDef, trackIdsForMap } from '../../../src/shared/race/tracks/index.js';
import { ALL_TRACK_IDS, MAP_TRACK_IDS, TRACK_IDS } from '../../../src/shared/race/types.js';
import { readSources, sourceHash } from '../../../tools/map/bake.js';
import { toHex } from '../../../tools/map/hash.js';
import { loadMapBundle } from '../../../tools/map/mapBundle.js';
import { validateMap } from '../../../tools/map/validateMap.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function readMapJson(mapId: MapId, file: string): unknown {
    return JSON.parse(readFileSync(path.join(ROOT, 'src/shared/maps', mapId, file), 'utf8')) as unknown;
}

function readRawSources(mapId: MapId): RawMapSources {
    return {
        roads: readMapJson(mapId, 'roads.json'),
        map: readMapJson(mapId, 'map.json'),
        zones: readMapJson(mapId, 'zones.json'),
        pois: readMapJson(mapId, 'pois.json'),
        tracks: readMapJson(mapId, 'tracks.json'),
        discoveries: readMapJson(mapId, 'discoveries.json')
    };
}

function readTerrainBytes(mapId: MapId): Uint8Array {
    return new Uint8Array(readFileSync(path.join(ROOT, 'public/maps', mapId, 'terrain.bhf')));
}

describe('multi-map registry and surface additions', () => {
    it('registers all four curated maps with consistent grids, tracks, and metadata', () => {
        expect(MAP_IDS).toEqual(['bulli-bay', 'alpen-pass', 'stunt-forge', 'logge-forge']);
        expect(DEFAULT_MAP_ID).toBe('bulli-bay');
        for (const id of MAP_IDS) {
            expect(isMapId(id)).toBe(true);
            const desc = mapDescriptor(id);
            expect(desc.id).toBe(id);
            expect(desc.grid).toEqual(MAP_GRIDS[id]);
            expect(mapGrid(id)).toEqual(MAP_GRIDS[id]);
            expect(desc.trackIds).toEqual(MAP_TRACK_IDS[id]);
            expect(desc.trackIds).toContain(desc.defaultTrackId);
            expect(desc.previewImage).toBe(`/ui/map-${id}.webp`);
        }
        expect(isMapId('monaco')).toBe(false);
        expect(isMapId(42)).toBe(false);
        expect(() => mapGrid('no-such-map')).toThrow('unknown map no-such-map');
        expect(MAP_REGISTRY['logge-forge'].featured).toBe(true);
        // Legacy TRACK_IDS keeps Bulli Bay's 6 tracks for backward compatibility
        expect(TRACK_IDS).toEqual(MAP_TRACK_IDS['bulli-bay']);
        expect(ALL_TRACK_IDS).toHaveLength(14);
    });

    it('appends snow (10) and ice (11) without shifting existing surface IDs', () => {
        expect(SURFACE.asphalt).toBe(0);
        expect(SURFACE.concrete).toBe(1);
        expect(SURFACE.wood).toBe(2);
        expect(SURFACE.water).toBe(9);
        expect(SURFACE.snow).toBe(10);
        expect(SURFACE.ice).toBe(11);
        expect(SURFACE_GRIP[SURFACE.ice]).toBeLessThan(SURFACE_GRIP[SURFACE.snow]);
        expect(SURFACE_GRIP[SURFACE.snow]).toBeLessThan(SURFACE_GRIP[SURFACE.asphalt]);
        expect(SURFACE_ROLL[SURFACE.ice]).toBeLessThan(SURFACE_ROLL[SURFACE.snow]);
        expect(SURFACE_PRIORITY[SURFACE.ice]).toBeGreaterThan(SURFACE_PRIORITY[SURFACE.snow]);
    });
});

describe('discoverySchema validation and deterministic colliders', () => {
    const validFile: DiscoveriesFile = {
        format: 'bulli-discoveries',
        version: 1,
        mapId: 'test-map',
        discoveries: [
            {
                id: 'd-prox', title: 'Prox', subtitle: 'Sub', alloy: 'forge',
                x: 10, z: 20, hint: 'Go there', codexEntry: 'Entry', toast: 'Found!',
                rewardEffect: 'sparks', trigger: { kind: 'proximity', radius: 15 },
                heroPropId: 'p-arch'
            },
            {
                id: 'd-horn', title: 'Horn', subtitle: 'Sub', alloy: 'web',
                x: -10, z: 30, hint: 'Honk', codexEntry: 'Entry', toast: 'Beep!',
                rewardEffect: 'flash', trigger: { kind: 'horn', radius: 18 }
            },
            {
                id: 'd-park', title: 'Park', subtitle: 'Sub', alloy: 'games',
                x: 30, z: -20, hint: 'Stop', codexEntry: 'Entry', toast: 'Parked!',
                rewardEffect: 'confetti', trigger: { kind: 'park', radius: 16, holdSec: 1.5, maxSpeed: 2 }
            },
            {
                id: 'd-air', title: 'Air', subtitle: 'Sub', alloy: 'stunt',
                x: 50, z: 10, hint: 'Jump', codexEntry: 'Entry', toast: 'Air!',
                rewardEffect: 'bubbles', trigger: { kind: 'airtime', radius: 30, minAirSec: 0.7 }
            },
            {
                id: 'd-speed', title: 'Speed', subtitle: 'Sub', alloy: 'alpine',
                x: -40, z: -40, hint: 'Fast', codexEntry: 'Entry', toast: 'Fast!',
                rewardEffect: 'shockwave', trigger: { kind: 'speed', radius: 25, minSpeedKmh: 90 }
            }
        ],
        heroProps: [
            {
                id: 'p-arch', model: 'lmf_forge_arch', x: 10, z: 20, yaw: 0, scale: 1,
                colliders: [
                    { kind: 'obox', dx: -8, dz: 0, hw: 1.2, hd: 1.5, top: 'infinity' },
                    { kind: 'obox', dx: 8, dz: 0, hw: 1.2, hd: 1.5, top: 'infinity' }
                ],
                clearRadius: 12, discoveryId: 'd-prox'
            }
        ],
        billboards: [
            {
                id: 'bb-1', texture: 'sign_lmf_welcome', kind: 'gantry',
                x: 10, z: 20, yOffset: 8, yaw: 0, width: 12, height: 4, emissive: true,
                discoveryId: 'd-prox'
            }
        ],
        boostPads: [
            {
                id: 'bp-1', x: 0, z: -20, yaw: 0, width: 7, length: 14,
                impulseSpeed: 14, boostFill: 0.5, cooldownTicks: 90
            }
        ]
    };

    it('accepts all five discovery trigger types and cross-referenced entities', () => {
        const parsed = parseDiscoveriesFile(structuredClone(validFile));
        expect(parsed).toEqual({ ok: true, value: validFile });
    });

    it('rejects duplicate IDs, broken cross-references, unknown models/textures, and non-positive radii', () => {
        const dup = structuredClone(validFile);
        dup.discoveries.push(structuredClone(dup.discoveries[0]));
        expect(parseDiscoveriesFile(dup)).toEqual({ ok: false, errors: ['discovery d-prox: duplicate id'] });

        const brokenPropRef = structuredClone(validFile);
        brokenPropRef.discoveries[0].heroPropId = 'missing-prop';
        expect(parseDiscoveriesFile(brokenPropRef)).toEqual({
            ok: false,
            errors: ['discovery d-prox: unknown heroPropId missing-prop']
        });

        const brokenDiscoveryRef = structuredClone(validFile);
        brokenDiscoveryRef.billboards[0].discoveryId = 'missing-disc';
        expect(parseDiscoveriesFile(brokenDiscoveryRef)).toEqual({
            ok: false,
            errors: ['billboard bb-1: unknown discoveryId missing-disc']
        });

        const badSchema = structuredClone(validFile) as unknown as {
            discoveries: { trigger: { radius: number } }[];
            heroProps: { model: string }[];
            billboards: { texture: string }[];
        };
        badSchema.discoveries[0].trigger.radius = 0;
        badSchema.heroProps[0].model = 'not_a_real_model';
        badSchema.billboards[0].texture = 'not_a_real_texture';
        const res = parseDiscoveriesFile(badSchema);
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.errors.some(e => e.includes('radius'))).toBe(true);
            expect(res.errors.some(e => e.includes('model'))).toBe(true);
            expect(res.errors.some(e => e.includes('texture'))).toBe(true);
        }
    });

    it('transforms rotated and scaled heroProp colliders to exact hand-calculated world coordinates', () => {
        // yaw = pi/2 => yawAxis = (ux=1, uz=0); local +x points (uz, -ux) = (0, -1), local +z points (1, 0)
        // scale = 2:
        //   obox (dx=-3, dz=1) => scaled (-6, 2) => world x = 100 + 2 = 102, z = 200 - (-6) = 206, hw=1, hd=1.5, top=8
        //   circle (dx=4, dz=0) => scaled (8, 0) => world x = 100, z = 200 - 8 = 192, r=3, top=Infinity
        const prop: HeroPropDef = {
            id: 'arch-test',
            model: 'lmf_forge_arch',
            x: 100,
            z: 200,
            yaw: Math.PI / 2,
            scale: 2,
            colliders: [
                { kind: 'obox', dx: -3, dz: 1, hw: 0.5, hd: 0.75, top: 4 },
                { kind: 'circle', dx: 4, dz: 0, r: 1.5, top: 'infinity' }
            ],
            clearRadius: 6
        };
        const colliders = heroPropColliders(prop);
        expect(colliders).toEqual([
            { kind: 'obox', x: 102, z: 206, hw: 1, hd: 1.5, ux: 1, uz: 0, top: 8 },
            { kind: 'circle', x: 100, z: 192, r: 3, top: Infinity }
        ]);

        const boxes = heroPropReservedBoxes(prop);
        expect(boxes).toHaveLength(3);
        expect(boxes[0]).toEqual({ x: 100, z: 200, hw: 12, hd: 12, ux: 1, uz: 0 });
        expect(billboardReservedBox(validFile.billboards[0])).toEqual({ x: 10, z: 20, hw: 7, hd: 2.5, ux: 0, uz: 1 });
        expect(boostPadReservedBox(validFile.boostPads[0])).toEqual({ x: 0, z: -20, hw: 5.5, hd: 11, ux: 0, uz: 1 });
    });

    it('integrates heroProp colliders and boostPads into SimWorld and worldHash', async () => {
        const sources = await importMapSources('stunt-forge');
        const hf = decodeHeightfield(readTerrainBytes('stunt-forge'), MAP_GRIDS['stunt-forge']);
        const withExtras = createMapData(sources, hf);
        const withoutExtras = createMapData({ ...sources, discoveries: undefined }, hf);

        expect(withExtras.heroProps.length).toBeGreaterThan(0);
        expect(withExtras.boostPads.length).toBeGreaterThan(0);
        const simWithPads = withExtras.simWorld as { boostPads?: readonly unknown[] };
        const partyWithPads = withExtras.partyWorld as { boostPads?: readonly unknown[] };
        const simWithoutPads = withoutExtras.simWorld as { boostPads?: readonly unknown[] };
        expect(simWithPads.boostPads).toEqual(withExtras.boostPads);
        expect(partyWithPads.boostPads).toEqual(withExtras.boostPads);
        expect(simWithoutPads.boostPads ?? []).toEqual([]);
        expect(withExtras.worldHash).not.toBe(withoutExtras.worldHash);
        expect(withExtras.colliders.length).toBeGreaterThan(withoutExtras.colliders.length);
    });
});

describe.each(MAP_IDS.map(id => [id] as const))('curated map %s', mapId => {
    const raw = readRawSources(mapId);
    const bytes = readTerrainBytes(mapId);
    const mapData = buildMapFromRaw(mapId, raw, bytes);
    const desc = mapDescriptor(mapId);

    it('matches its baked terrain.bhf sourceHash and stays within the 600 KB Brotli budget', () => {
        const bakedSources = readSources(mapId);
        expect(toHex(mapData.hf.sourceHash)).toBe(toHex(sourceHash(bakedSources)));
        expect(mapData.hf.mapVersion).toBe(mapData.mapVersion);

        const manifest = JSON.parse(
            readFileSync(path.join(ROOT, 'public/maps', mapId, 'manifest.json'), 'utf8')
        ) as MapManifestJson;
        expect(manifest.mapId).toBe(mapId);
        expect(manifest.files.terrain.path).toBe('terrain.bhf');

        const brotli = brotliCompressSync(bytes, {
            params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 }
        });
        expect(brotli.length).toBeLessThanOrEqual(600 * 1024);
    });

    it('builds deterministically via importMapSources and fetchMapData with identical worldHash', async () => {
        const imported = await importMapSources(mapId);
        const rebuilt = createMapData(imported, decodeHeightfield(bytes, MAP_GRIDS[mapId]));
        expect(rebuilt.worldHash).toBe(mapData.worldHash);
        expect(rebuilt.discoveries).toEqual(mapData.discoveries);
        expect(rebuilt.atmosphere).toEqual(desc.atmosphere);

        const manifestText = readFileSync(path.join(ROOT, 'public/maps', mapId, 'manifest.json'), 'utf8');
        const mockFetch: typeof fetch = async input => {
            const url = String(input);
            if (url.includes('manifest.json')) {
                return new Response(manifestText, { status: 200, headers: { 'content-type': 'application/json' } });
            }
            if (url.includes('terrain.bhf')) {
                return new Response(bytes.slice(), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
            }
            return new Response('not found', { status: 404 });
        };
        const fetched = await fetchMapData(mapId, { fetchFn: mockFetch });
        expect(fetched.worldHash).toBe(mapData.worldHash);
    });

    it('passes tools/map/validateMap with zero errors and has a dry in-bounds showroomSpot', () => {
        const bundle = loadMapBundle(mapId);
        const errors = validateMap(bundle).findings
            .filter(f => f.severity === 'error')
            .map(f => `[${f.check}] ${f.message}${f.x !== undefined ? ` (${f.x} | ${f.z})` : ''}`);
        expect(errors).toEqual([]);

        expect(pointInPolygon(mapData.sources.map.boundary, desc.showroomSpot.x, desc.showroomSpot.z)).toBe(true);
        expect(waterDepth(mapData.hf, desc.showroomSpot.x, desc.showroomSpot.z)).toBeLessThanOrEqual(0);
        expect(mapData.discoveries).toHaveLength(desc.discoveryCount);
    }, 20_000);

    it('builds and completes every track declared for the map and rotates cleanly via nextTrack', () => {
        const tracks = mapTracks(mapData);
        const expectedIds = MAP_TRACK_IDS[mapId];
        expect(trackIdsForMap(mapData)).toEqual(expectedIds);
        expect(Object.keys(tracks)).toEqual([...expectedIds]);

        for (let i = 0; i < expectedIds.length; i++) {
            const id = expectedIds[i];
            expect(isTrackId(id)).toBe(true);
            expect(nextTrack(id, mapData)).toBe(expectedIds[(i + 1) % expectedIds.length]);

            const track = trackDef(mapData, id);
            const line = buildRacingLine(track);
            const world = createRaceWorld(mapData, track);
            const course = createCourse(track, line);

            expect(track.grid.length).toBeGreaterThanOrEqual(MAX_RACERS);
            for (const slot of track.grid) {
                expect(roadSurfaceIdAt(mapData.net, slot.x, slot.z), `${id} grid slot`).toBeGreaterThanOrEqual(0);
            }
            for (let k = 1; k < course.gateS.length; k++) {
                expect(course.gateS[k], `${id} gate ${k}`).toBeGreaterThan(course.gateS[k - 1]);
            }

            // Drive racing line through every gate in order to finish
            const progress = createRaceProgress();
            const pts = line.points;
            let tick = 1;
            const laps = track.kind === 'circuit' ? track.laps + 1 : 1;
            for (let lap = 0; lap < laps && progress.status === 'racing'; lap++) {
                const count = track.kind === 'circuit' ? pts.length : pts.length - 1;
                for (let p = 0; p < count && progress.status === 'racing'; p++) {
                    const a = pts[p], b = pts[(p + 1) % pts.length];
                    passGate(progress, course, tick++, 0, a.x, a.z, b.x, b.z);
                }
            }
            expect(progress.status, id).toBe('finished');
            expect(world.colliders.length).toBeGreaterThan(0);
        }
    }, 20_000);
});

describe('biome features and flagship Logge Forge easter-egg catalog', () => {
    it('bakes alpine snow and frozen lake ice on alpen-pass and dry pit on stunt-forge', () => {
        const alpenHf = decodeHeightfield(readTerrainBytes('alpen-pass'), MAP_GRIDS['alpen-pass']);
        let snowCells = 0, iceCells = 0;
        for (let i = 0; i < alpenHf.surface.length; i++) {
            if (alpenHf.surface[i] === SURFACE.snow) snowCells++;
            if (alpenHf.surface[i] === SURFACE.ice) iceCells++;
        }
        expect(snowCells).toBeGreaterThan(50_000);
        expect(iceCells).toBeGreaterThan(10_000);
        expect(heightAt(alpenHf, 0, -620)).toBeGreaterThan(170);
        expect(surfaceAt(alpenHf, 380, 450)).toBe(SURFACE.ice);

        const stuntHf = decodeHeightfield(readTerrainBytes('stunt-forge'), MAP_GRIDS['stunt-forge']);
        expect(heightAt(stuntHf, 0, 0)).toBeLessThan(0);
        expect(waterDepth(stuntHf, 0, 0)).toBeLessThanOrEqual(0);
        expect(heightAt(stuntHf, 590, 0)).toBeGreaterThan(50);
    });

    it('packs all 22 verified LMF discoveries and exercises every contracted heroProp model and billboard texture', () => {
        const forge = buildMapFromRaw('logge-forge', readRawSources('logge-forge'), readTerrainBytes('logge-forge'));
        expect(forge.discoveries).toHaveLength(22);
        // Mount Aftermovie flanks are snowy high ground; outer ocean is water
        expect(surfaceAt(forge.hf, -700, 680)).toBe(SURFACE.snow);
        expect(heightAt(forge.hf, -650, 650)).toBeGreaterThan(95);
        expect(surfaceAt(forge.hf, -980, -980)).toBe(SURFACE.water);

        // Every contracted heroProp model (24) and billboard/decal texture (20) is used across the map roster
        const usedModels = new Set<string>();
        const usedTextures = new Set<string>();
        for (const id of MAP_IDS) {
            const m = buildMapFromRaw(id, readRawSources(id), readTerrainBytes(id));
            for (const p of m.heroProps) usedModels.add(p.model);
            for (const b of m.billboards) usedTextures.add(b.texture);
        }
        expect([...usedModels].sort()).toEqual([...HERO_PROP_MODELS].sort());
        expect([...usedTextures].sort()).toEqual([...BILLBOARD_TEXTURES].sort());
    });
});
