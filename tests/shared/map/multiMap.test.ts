import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
    BILLBOARD_TEXTURES, HERO_PROP_MODELS, billboardReservedBox, boostPadReservedBox, heroPropColliders,
    heroPropReservedBoxes, parseDiscoveriesFile, type DiscoveriesFile, type HeroPropDef
} from '../../../src/shared/map/discoverySchema.js';
import { pieceFoundation } from '../../../src/shared/map/buildings.js';
import { pointInPolygon } from '../../../src/shared/map/geometry.js';
import { decodeHeightfield, heightAt, surfaceAt, waterDepth } from '../../../src/shared/map/heightfield.js';
import { buildMapFromRaw, fetchMapData, importMapSources, type MapManifestJson } from '../../../src/shared/map/loadMap.js';
import { createMapData } from '../../../src/shared/map/mapData.js';
import type { RawMapSources } from '../../../src/shared/map/mapSources.js';
import {
    DEFAULT_MAP_ID, MAP_GRIDS, MAP_IDS, MAP_REGISTRY, isMapId, mapDescriptor, mapGrid, type MapId
} from '../../../src/shared/map/registry.js';
import { roadSurfaceIdAt } from '../../../src/shared/map/roadNetwork.js';
import { boxSamples, placementBox } from '../../../src/shared/map/structures.js';
import { SURFACE, SURFACE_GRIP, SURFACE_PRIORITY, SURFACE_ROLL } from '../../../src/shared/map/types.js';
import { createCourse, createRaceProgress, passGate } from '../../../src/shared/race/progress.js';
import { createRaceWorld } from '../../../src/shared/race/raceWorld.js';
import { buildRacingLine } from '../../../src/shared/race/racingLine.js';
import { MAX_RACERS } from '../../../src/shared/race/rules.js';
import { isTrackId, mapTracks, nextTrack, trackDef, trackIdsForMap } from '../../../src/shared/race/tracks/index.js';
import { ALL_TRACK_IDS, MAP_TRACK_IDS, TRACK_IDS } from '../../../src/shared/race/types.js';
import { readSources, sourceHash } from '../../../tools/map/bake.js';
import { WALL_FLAT_EXTRA, corridorLine } from '../../../tools/map/bakeTerrain.js';
import { toHex } from '../../../tools/map/hash.js';
import { loadMapBundle } from '../../../tools/map/mapBundle.js';
import { leftNormal, pointAt } from '../../../src/shared/map/spline.js';
import {
    checkBoostPads, checkDuplicateRamps, checkSheerCliffs, checkStructureGrounding, validateMap
} from '../../../tools/map/validateMap.js';

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
        // Billboard width=12, yaw=0 at (10,20): hw=12/2+2.5=8.5, back=2.5, front=2.5+8=10.5 => shift=+4 (z=24), hd=6.5
        expect(billboardReservedBox(validFile.billboards[0])).toEqual({ x: 10, z: 24, hw: 8.5, hd: 6.5, ux: 0, uz: 1 });
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

        // Quality 6 is ~100x faster than 11 on CI runners and strictly larger,
        // so passing <= 600 KB here guarantees production Brotli-11 stays well under budget.
        const brotli = brotliCompressSync(bytes, {
            params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 }
        });
        expect(brotli.length).toBeLessThanOrEqual(600 * 1024);
    }, 20_000);

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
    }, 20_000);

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

    it('gates tropical palms and lake-ice trees out of alpen-pass and pins bulli-bay BAKE_VERSION=4 worldHash', () => {
        const bulli = buildMapFromRaw('bulli-bay', readRawSources('bulli-bay'), readTerrainBytes('bulli-bay'));
        // Updated for BAKE_VERSION=4 polish: corridorLine retaining-wall flat clamp (+0.8 m beyond sidewalk),
        // addArea boundary surface stamping, deepened 2.0 m kit foundations (0.3 m beach_w8_f1) + LOT_MAX_RELIEF=2.2
        // restoring hillside residential density (359 -> 430 buildings, 0 floating/buried).
        expect(bulli.worldHash).toBe('7eeec622');
        expect(bulli.plants.filter(p => p.kind === 'palm')).toHaveLength(131);

        const alpen = buildMapFromRaw('alpen-pass', readRawSources('alpen-pass'), readTerrainBytes('alpen-pass'));
        expect(alpen.plants.filter(p => p.kind === 'palm')).toEqual([]);
        expect(alpen.plants.filter(p => p.kind === 'cypress').length).toBeGreaterThan(200);
        expect(alpen.plants.filter(p => surfaceAt(alpen.hf, p.x, p.z) === SURFACE.ice)).toEqual([]);
        // Snowy slopes grow alpine evergreen cypresses, never broad-leaf oaks
        const snowyOaks = alpen.plants.filter(p => p.kind === 'oak' && surfaceAt(alpen.hf, p.x, p.z) === SURFACE.snow);
        expect(snowyOaks).toEqual([]);
    });

    it('clears monument beams on logge-forge billboards (bb-lmf-welcome & bb-bands-marquee)', () => {
        const forge = buildMapFromRaw('logge-forge', readRawSources('logge-forge'), readTerrainBytes('logge-forge'));
        const propManifest = JSON.parse(
            readFileSync(path.join(ROOT, 'public/models/props/manifest.json'), 'utf8')
        ) as { props: Record<string, { bounds: { min: [number, number, number]; max: [number, number, number] }; billboardNode?: string }> };

        // bb-lmf-welcome must stay within < 3 m of hp-forge-arch so heroProps mounts it on the arch,
        // while clearing the full arch depth (Z[-2.2..2.2] / upper beam + badge <= 1.72) and 7.6 m vault opening
        const arch = forge.heroProps.find(p => p.id === 'hp-forge-arch')!;
        const welcome = forge.billboards.find(b => b.id === 'bb-lmf-welcome')!;
        const archBounds = propManifest.props[arch.model].bounds;
        const distToArch = Math.hypot(welcome.x - arch.x, welcome.z - arch.z);
        expect(distToArch).toBeLessThan(3.0);
        // Frame back sits at localZ - 0.25; must clear the arch's Z face without clipping
        const welcomeLocalZ = welcome.z - arch.z; // arch.yaw === 0
        expect(welcomeLocalZ - 0.25).toBeGreaterThan(1.75);
        expect(welcomeLocalZ).toBeGreaterThan(archBounds.max[2]);
        expect((welcome.yOffset ?? 0) - welcome.height / 2).toBeGreaterThanOrEqual(7.6);
        expect((welcome.yOffset ?? 0) + welcome.height / 2).toBeLessThan(archBounds.max[1]);

        // bb-bands-marquee sits clear of lmf_festival_stage's upper front truss (localZ <= 4.75) & stage deck
        const stage = forge.heroProps.find(p => p.id === 'hp-festival-stage')!;
        const marquee = forge.billboards.find(b => b.id === 'bb-bands-marquee')!;
        const stageLocalZ = -(marquee.z - stage.z); // stage.yaw === pi
        expect(stageLocalZ - 0.25).toBeGreaterThan(4.8);
        expect((marquee.yOffset ?? 0) - marquee.height / 2).toBeGreaterThan(8.0);
    });

    it('guarantees zero floating/buried structures, clean harbor water, open stunt-bowl gates, and flat Eissee ice across all 4 maps', () => {
        for (const id of MAP_IDS) {
            const m = buildMapFromRaw(id, readRawSources(id), readTerrainBytes(id));
            // Every procedural building sits within its foundation skirt and burial cap
            for (const b of m.buildings) {
                const y0 = heightAt(m.hf, b.x, b.z);
                let minH = Infinity, maxH = -Infinity;
                for (const [x, z] of boxSamples(placementBox(b), 2)) {
                    const h = heightAt(m.hf, x, z);
                    if (h < minH) minH = h;
                    if (h > maxH) maxH = h;
                }
                expect(y0 - minH - pieceFoundation(b.piece), `${id} bldg float ${b.edge}`).toBeLessThanOrEqual(0.05);
                expect(maxH - y0, `${id} bldg burial ${b.edge}`).toBeLessThanOrEqual(0.5);
            }
            // Every ramp has zero terrain poke and grounded rear edge
            for (const r of m.ramps) {
                const fx = Math.sin(r.yaw), fz = Math.cos(r.yaw);
                const lx = fz, lz = -fx;
                const base = heightAt(m.hf, r.x - fx * r.length / 2, r.z - fz * r.length / 2);
                for (let u = 0; u <= 1; u += 0.2) {
                    const deckY = base + u * r.height;
                    for (const s of [-0.5, 0, 0.5]) {
                        const gh = heightAt(m.hf, r.x + fx * (u - 0.5) * r.length + lx * s * r.width, r.z + fz * (u - 0.5) * r.length + lz * s * r.width);
                        expect(gh - deckY, `${id} ramp ${r.id} poke`).toBeLessThanOrEqual(0.12);
                        if (u === 0) expect(Math.abs(gh - base), `${id} ramp ${r.id} rear gap`).toBeLessThanOrEqual(0.15);
                    }
                }
            }
        }

        // logge-forge: sailboat floats in genuine open harbor water (h < -3 m), ijsselmeer-pier is a wooden area
        // whose far tip boundary cells (z = 560) are stamped SURFACE.wood (eliminating seabed rock pillar),
        // and dec-saalplan faces east (yaw = -pi/2) toward hp-theater-facade.
        const forge = buildMapFromRaw('logge-forge', readRawSources('logge-forge'), readTerrainBytes('logge-forge'));
        const boat = forge.heroProps.find(p => p.id === 'hp-sailboat')!;
        expect(heightAt(forge.hf, boat.x, boat.z)).toBeLessThan(-3);
        expect(forge.net.areas.some(a => a.id === 'ijsselmeer-pier' && a.surface === 'wood')).toBe(true);
        expect(surfaceAt(forge.hf, -460, 560)).toBe(SURFACE.wood);
        expect(surfaceAt(forge.hf, -464, 560)).toBe(SURFACE.wood);
        expect(surfaceAt(forge.hf, -456, 560)).toBe(SURFACE.wood);
        expect(surfaceAt(forge.hf, -466, 560)).toBe(SURFACE.water);
        const saalplan = forge.billboards.find(b => b.id === 'dec-saalplan')!;
        expect(saalplan.yaw).toBeCloseTo(-Math.PI / 2, 3);

        // bulli-bay: corridorLine clamps walled flat margins so concrete retaining walls (5.0..6.5 m)
        // on laurel-court and cypress-court are exposed (>0.5 m drop at 6.5 m) while asphalt (3.5 m) stays flat (<= 5 cm)
        const bulli = buildMapFromRaw('bulli-bay', readRawSources('bulli-bay'), readTerrainBytes('bulli-bay'));
        for (const edgeId of ['laurel-court', 'cypress-court'] as const) {
            const edge = bulli.net.edgeById.get(edgeId)!;
            const heights = new Map([[edge.id, new Float64Array(edge.samples.length).fill(15)]]);
            const fwd = corridorLine(bulli.net, { parts: [{ edge: edge.index, reversed: false }], startNode: edge.from, endNode: edge.to, closed: false, length: edge.length }, heights);
            const rev = corridorLine(bulli.net, { parts: [{ edge: edge.index, reversed: true }], startNode: edge.to, endNode: edge.from, closed: false, length: edge.length }, heights);
            const clampedHalf = edge.halfWidth + edge.profile.sidewalk.left + edge.profile.shoulder + WALL_FLAT_EXTRA;
            // Forward & reversed wall samples clamp to 5.8 m; unwalled samples keep full flat width (7.5 m)
            const fwdWallLeft = Array.from(fwd.wallLeft ?? []);
            const revWallRight = Array.from(rev.wallRight ?? []);
            const walledIdx = fwdWallLeft.indexOf(1);
            const unwalledIdx = fwdWallLeft.indexOf(0);
            expect(walledIdx).toBeGreaterThanOrEqual(0);
            expect(fwd.halfLeft[walledIdx]).toBeCloseTo(clampedHalf, 6);
            if (unwalledIdx >= 0) expect(fwd.halfLeft[unwalledIdx]).toBeCloseTo(7.5, 6);
            // When reversed, edge's left wall maps to corridor's right wall and clamps halfRight
            const revWalledIdx = revWallRight.indexOf(1);
            expect(revWalledIdx).toBeGreaterThanOrEqual(0);
            expect(rev.halfRight[revWalledIdx]).toBeCloseTo(clampedHalf, 6);

            for (const wall of edge.def.walls ?? []) {
                const to = wall.to < 0 ? edge.length : wall.to;
                const side = wall.side === 'left' ? 1 : -1;
                for (let s = wall.from + 4; s <= to - 4; s += 4) {
                    const pt = pointAt(edge.samples, s);
                    const [nx, nz] = leftNormal(pt.tx, pt.tz);
                    const h0 = heightAt(bulli.hf, pt.x, pt.z);
                    const hAsph = heightAt(bulli.hf, pt.x + nx * side * edge.halfWidth, pt.z + nz * side * edge.halfWidth);
                    const hWallOut = heightAt(bulli.hf, pt.x + nx * side * 6.5, pt.z + nz * side * 6.5);
                    expect(Math.abs(hAsph - h0), `${edgeId} ${wall.side} asphalt at s=${s}`).toBeLessThanOrEqual(0.05);
                    expect(hWallOut - h0, `${edgeId} ${wall.side} wall face exposed at s=${s}`).toBeLessThan(-0.5);
                }
            }
        }

        // alpen-pass: Eissee frozen lake is flat (< 0.5 m relief) and has zero beach surf shacks
        const alpen = buildMapFromRaw('alpen-pass', readRawSources('alpen-pass'), readTerrainBytes('alpen-pass'));
        let iceMin = Infinity, iceMax = -Infinity;
        const { cols, rows, heightOffset, heightScale } = alpen.hf.spec;
        for (let k = 0; k < cols * rows; k++) {
            if (alpen.hf.surface[k] === SURFACE.ice) {
                const h = heightOffset + alpen.hf.q[k] * heightScale;
                if (h < iceMin) iceMin = h;
                if (h > iceMax) iceMax = h;
            }
        }
        expect(iceMax - iceMin).toBeLessThan(0.5);
        expect(alpen.buildings.filter(b => b.piece.startsWith('beach_'))).toEqual([]);

        // stunt-forge: all 4 bowl access roads (N/S/E/W) are open in free-roam simWorld, zero coastal buildings/oaks/cypresses
        const stunt = buildMapFromRaw('stunt-forge', readRawSources('stunt-forge'), readTerrainBytes('stunt-forge'));
        expect(stunt.buildings).toEqual([]);
        expect(stunt.plants.filter(p => p.kind === 'oak' || p.kind === 'cypress' || p.kind === 'palm')).toEqual([]);
        const segments = stunt.colliders.filter(c => c.kind === 'segment');
        for (const [gx, gz] of [[0, -100], [0, 100], [120, 0], [-120, 0]]) {
            const blocked = segments.some(s => {
                const ex = s.bx - s.ax, ez = s.bz - s.az;
                const t = Math.max(0, Math.min(1, ((gx - s.ax) * ex + (gz - s.az) * ez) / (ex * ex + ez * ez)));
                return Math.hypot(gx - (s.ax + t * ex), gz - (s.az + t * ez)) < s.r + 1.5;
            });
            expect(blocked, `stunt-bowl entry (${gx},${gz}) blocked by fence`).toBe(false);
        }
    });

    it('validateMap catches injected floating props, road billboards, off-road boostPads, duplicate ramps, and sheer cliff steps', () => {
        const bundle = loadMapBundle('stunt-forge');
        // 1. Injected floating heroProp on a steep cliff edge
        const badProp = { ...bundle.discoveries!.heroProps[0], id: 'bad-prop', x: 520, z: 0 };
        expect(checkStructureGrounding(bundle.net, bundle.hf, bundle.map, bundle.pois, {
            ...bundle.discoveries!, heroProps: [badProp]
        }).some(f => f.message.includes('bad-prop'))).toBe(true);

        // 2. Injected billboard standing on a road carriageway
        const roadBb = { ...bundle.discoveries!.billboards[2], id: 'road-bb', x: 0, z: -260 };
        expect(checkStructureGrounding(bundle.net, bundle.hf, bundle.map, bundle.pois, {
            ...bundle.discoveries!, billboards: [roadBb]
        }).some(f => f.message.includes('road carriageway'))).toBe(true);

        // 3. Injected skewed/off-road boost pad
        const badPad = { ...bundle.discoveries!.boostPads[0], id: 'bad-pad', x: 435, z: 160, yaw: 0 };
        expect(checkBoostPads(bundle.net, bundle.pois, { ...bundle.discoveries!, boostPads: [badPad] })
            .some(f => f.message.includes('bad-pad'))).toBe(true);

        // 4. Injected duplicate ramp overlapping canyon-gap-launch
        const dupPois = { ...bundle.pois, jumps: [...(bundle.pois.jumps ?? []), { ...bundle.pois.jumps![0], id: 'dup-jump' }] };
        expect(checkDuplicateRamps(bundle.net, dupPois, []).some(f => f.message.includes('dup-jump'))).toBe(true);

        // 5. Injected sheer 12 m 1-cell cliff step inside non-rock terrain
        const badHf = { ...bundle.hf, q: new Uint16Array(bundle.hf.q), surface: new Uint8Array(bundle.hf.surface) };
        const idx = 200 * badHf.spec.cols + 200;
        badHf.surface[idx] = SURFACE.grass;
        badHf.surface[idx + 1] = SURFACE.grass;
        badHf.surface[idx + badHf.spec.cols] = SURFACE.grass;
        badHf.q[idx + 1] = Math.min(65535, badHf.q[idx] + Math.round(12 / badHf.spec.heightScale));
        expect(checkSheerCliffs(bundle.net, badHf).some(f => f.message.includes('sheer 1-cell cliff'))).toBe(true);
    });
});
