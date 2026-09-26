import { describe, expect, it } from 'vitest';
import {
    parseMapFile, parsePoisFile, parseTracksFile, parseZonesFile, type PoisFile, type TracksFile
} from '../../../src/shared/map/mapFiles.js';

// Schemas of map.json, zones.json, pois.json and tracks.json
// (docs/phase-3-design.md 3.5, 12, 13.1, deviation A13): hand-written
// files, so typos fail loudly with their path instead of being dropped.

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const MAP = {
    format: 'bulli-map', version: 1, mapId: 'test', mapVersion: 2, name: 'Test',
    boundary: [[0, 0], [10, 0], [10, 10]]
};

describe('map.json', () => {
    it('accepts the header with a boundary polygon', () => {
        expect(parseMapFile(clone(MAP))).toEqual({ ok: true, value: MAP });
    });

    it('rejects a boundary with fewer than three points, a version 0 and unknown keys', () => {
        const bad = { ...clone(MAP), boundary: [[0, 0], [1, 1]], mapVersion: 0, zones: [] };
        const parsed = parseMapFile(bad);
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) {
            expect(parsed.errors.some(e => e.startsWith('boundary'))).toBe(true);
            expect(parsed.errors.some(e => e.startsWith('mapVersion'))).toBe(true);
            expect(parsed.errors.some(e => e.includes('zones'))).toBe(true);
        }
    });
});

describe('zones.json', () => {
    const zone = { id: 'z', zone: 'downtown', name: 'Downtown', label: [5, 5], polygon: [[0, 0], [10, 0], [0, 10]] };
    const file = { format: 'bulli-zones', version: 1, mapId: 'test', zones: [zone] };

    it('accepts named zones with a label point and rejects duplicates and unknown zone kinds', () => {
        expect(parseZonesFile(clone(file)).ok).toBe(true);
        expect(parseZonesFile({ ...clone(file), zones: [zone, zone] })).toEqual({ ok: false, errors: ['zone z: duplicate id'] });
        const parsed = parseZonesFile({ ...clone(file), zones: [{ ...zone, zone: 'moon' }] });
        expect(parsed.ok ? [] : parsed.errors[0]).toMatch(/^zones\.0\.zone/);
    });
});

const POIS: PoisFile = {
    format: 'bulli-pois', version: 1, mapId: 'test',
    landmarks: [{ id: 'pier', kind: 'pier', name: 'Pier', x: 1, z: 2 }],
    spawns: { freeRoam: [{ group: 'plaza', x: 0, z: 0, yaw: 0 }], party: [{ x: 5, z: 5, yaw: 1 }] },
    arena: {
        area: 'lot', gate: { x: 0, z: 0, yaw: 0, width: 12 },
        containers: [{ x: 1, z: 1, yaw: 0 }],
        ramps: [{ x: 2, z: 2, yaw: 0, width: 6, length: 10, height: 1.5 }],
        coins: [[3, 3]], powerups: [[4, 4]]
    }
};

describe('pois.json', () => {
    it('accepts landmarks, spawns per mode and the arena contents', () => {
        expect(parsePoisFile(clone(POIS))).toEqual({ ok: true, value: POIS });
    });

    it('rejects duplicate landmarks, unknown kinds, empty spawn lists and a flat ramp', () => {
        const dup = clone(POIS);
        dup.landmarks.push(clone(dup.landmarks[0]));
        expect(parsePoisFile(dup)).toEqual({ ok: false, errors: ['landmark pier: duplicate id'] });

        const bad = clone(POIS) as unknown as {
            landmarks: { kind: string }[]; spawns: { party: unknown[] }; arena: { ramps: { height: number }[] }
        };
        bad.landmarks[0].kind = 'volcano';
        bad.spawns.party = [];
        bad.arena.ramps[0].height = 0;
        const parsed = parsePoisFile(bad);
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) {
            expect(parsed.errors.some(e => e.startsWith('landmarks.0.kind'))).toBe(true);
            expect(parsed.errors.some(e => e.startsWith('spawns.party'))).toBe(true);
            expect(parsed.errors.some(e => e.startsWith('arena.ramps.0.height'))).toBe(true);
        }
    });

    it('takes a Party zone as a non-empty rectangle, and harbour slots only in the groups it knows', () => {
        const zone = { ...clone(POIS), party: { zone: { minX: -10, minZ: 0, maxX: 10, maxZ: 20 }, coins: [[0, 5]], powerups: [] } };
        expect(parsePoisFile(zone).ok).toBe(true);
        const empty = { ...clone(POIS), party: { zone: { minX: 10, minZ: 0, maxX: 10, maxZ: 20 }, coins: [], powerups: [] } };
        const parsed = parsePoisFile(empty);
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) expect(parsed.errors.some(e => e.startsWith('party.zone') && e.includes('empty'))).toBe(true);
        const slots = clone(POIS) as unknown as { spawns: { party: { group?: string }[] } };
        slots.spawns.party[0].group = 'harbor';
        expect(parsePoisFile(slots).ok).toBe(true);
        slots.spawns.party[0].group = 'pier';
        expect(parsePoisFile(slots).ok).toBe(false);
    });
});

const TRACKS: TracksFile = {
    format: 'bulli-tracks', version: 1, mapId: 'test',
    tracks: [
        {
            id: 'loop', name: 'Loop', kind: 'circuit', laps: 3, trackVersion: 1, route: ['a', '-b'],
            start: { edge: 'a', s: 10 }, gateSpacing: 200, minCornerSpeed: 30
        },
        {
            id: 'sprint', name: 'Sprint', kind: 'sprint', laps: 1, trackVersion: 1, bonus: true, route: ['a'],
            start: { edge: 'a', s: 10 }, finish: { edge: 'a', s: 90 }, gateSpacing: 200, minCornerSpeed: 30,
            ramps: [{ edge: 'a', s: 50, length: 10, height: 1 }], chevronCurvature: 0.03
        }
    ]
};

describe('tracks.json', () => {
    it('accepts circuits and sprints with reversed edges, ramps and bonus flags', () => {
        expect(parseTracksFile(clone(TRACKS))).toEqual({ ok: true, value: TRACKS });
    });

    it('needs a finish for a sprint, none for a circuit, one lap per sprint and unique IDs', () => {
        const file = clone(TRACKS);
        delete file.tracks[1].finish;
        file.tracks[1].laps = 2;
        file.tracks[0].finish = { edge: 'a', s: 5 };
        file.tracks.push(clone(TRACKS.tracks[0]));
        const parsed = parseTracksFile(file);
        expect(parsed.ok ? [] : parsed.errors).toEqual([
            'track loop: duplicate id',
            'track loop: a circuit finishes at its start, drop "finish"',
            'track sprint: a sprint needs a finish',
            'track sprint: a sprint has 1 lap'
        ]);
    });

    it('rejects malformed route entries and a gate spacing below 50 m', () => {
        const file = clone(TRACKS);
        file.tracks[0].route = ['a', '--b', 'C'];
        file.tracks[0].gateSpacing = 20;
        const parsed = parseTracksFile(file);
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) {
            expect(parsed.errors.filter(e => e.startsWith('tracks.0.route')).length).toBe(2);
            expect(parsed.errors.some(e => e.startsWith('tracks.0.gateSpacing'))).toBe(true);
        }
    });
});
