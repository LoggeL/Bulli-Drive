// Central registry of all playable curated maps in Bulli Drive: grid specs,
// atmospheric lighting/biome presets, race track rosters, showroom spawn spots,
// and UI metadata. Shared cleanly by server, client, bake tools, and tests.

import {
    ALPEN_PASS_TRACK_IDS, BULLI_BAY_TRACK_IDS, LOGGE_FORGE_TRACK_IDS, STUNT_FORGE_TRACK_IDS, type TrackId
} from '../race/types.js';
import { BULLI_BAY_GRID, type GridSpec } from './heightfield.js';

export const MAP_IDS = ['bulli-bay', 'alpen-pass', 'stunt-forge', 'logge-forge'] as const;
export type MapId = typeof MAP_IDS[number];

export const DEFAULT_MAP_ID: MapId = 'bulli-bay';

export function isMapId(value: unknown): value is MapId {
    return typeof value === 'string' && (MAP_IDS as readonly string[]).includes(value);
}

// 1.6 × 1.6 km alpine pass, 2 m grid, 1 cm steps from -20 m up to +635 m
export const ALPEN_PASS_GRID: GridSpec = {
    cols: 801,
    rows: 801,
    cellSize: 2,
    originX: -800,
    originZ: -800,
    heightOffset: -20,
    heightScale: 0.01,
    waterLevel: 0,
    zoneCell: 8
};

// 1.2 × 1.2 km gravel quarry & stunt bowl, 2 m grid, dry pit down to -12 m
export const STUNT_FORGE_GRID: GridSpec = {
    cols: 601,
    rows: 601,
    cellSize: 2,
    originX: -600,
    originZ: -600,
    heightOffset: -20,
    heightScale: 0.01,
    waterLevel: -18,
    zoneCell: 8
};

// 2.0 × 2.0 km flagship discovery island, 2 m grid, 0..125 m relief
export const LOGGE_FORGE_GRID: GridSpec = {
    cols: 1001,
    rows: 1001,
    cellSize: 2,
    originX: -1000,
    originZ: -1000,
    heightOffset: -20,
    heightScale: 0.01,
    waterLevel: 0,
    zoneCell: 8
};

export const MAP_GRIDS: Readonly<Record<MapId, GridSpec>> = {
    'bulli-bay': BULLI_BAY_GRID,
    'alpen-pass': ALPEN_PASS_GRID,
    'stunt-forge': STUNT_FORGE_GRID,
    'logge-forge': LOGGE_FORGE_GRID
};

export interface MapAtmosphereSpec {
    biome: 'coastal' | 'alpine' | 'quarry' | 'forge';
    hdri: string;
    sunAzimuth: number;
    sunElevation: number;
    sunColor: number;
    sunIntensity: number;
    exposure: number;
    hemiSky: number;
    hemiGround: number;
    hemiIntensity: number;
    fogColor: number;
    fogNear: number;
    fogFar: number;
    skyZenith: number;
    skyHorizon: number;
    skyGlow: number;
    waterColor: number;
    waterDeepColor: number;
    hasSea: boolean;
    biomeTextures: readonly string[];
}

export interface MapDescriptor {
    id: MapId;
    name: string;
    subtitle: string;
    description: string;
    sizeMeters: number;
    elevationRange: readonly [number, number];
    grid: GridSpec;
    trackIds: readonly TrackId[];
    defaultTrackId: TrackId;
    hasDiscoveries: boolean;
    discoveryCount: number;
    previewImage: string;
    featured?: boolean;
    showroomSpot: { x: number; z: number; yaw: number };
    atmosphere: MapAtmosphereSpec;
}

export const MAP_REGISTRY: Readonly<Record<MapId, MapDescriptor>> = {
    'bulli-bay': {
        id: 'bulli-bay',
        name: 'Bulli Bay',
        subtitle: 'Coastal California Classic',
        description: 'Sunny 2 × 2 km coastal city with palm boulevards, beach dunes, harbor arena, and the 133 m Bulli Ridge climb.',
        sizeMeters: 2000,
        elevationRange: [0, 133],
        grid: BULLI_BAY_GRID,
        trackIds: BULLI_BAY_TRACK_IDS,
        defaultTrackId: 'downtown-loop',
        hasDiscoveries: true,
        discoveryCount: 4,
        previewImage: '/ui/map-bulli-bay.webp',
        showroomSpot: { x: -350, z: -17, yaw: 1.5708 },
        atmosphere: {
            biome: 'coastal',
            hdri: '/textures/hdri/qwantani_sunset_puresky_1k.hdr',
            sunAzimuth: 285,
            sunElevation: 17,
            sunColor: 0xffe0b8,
            sunIntensity: 3.2,
            exposure: 0.95,
            hemiSky: 0xffe3c6,
            hemiGround: 0x947258,
            hemiIntensity: 0.6,
            fogColor: 0xffc9a0,
            fogNear: 120,
            fogFar: 620,
            skyZenith: 0x4a78b8,
            skyHorizon: 0xffc9a0,
            skyGlow: 0xffb070,
            waterColor: 0x1e6f8c,
            waterDeepColor: 0x0c344a,
            hasSea: true,
            biomeTextures: []
        }
    },
    'alpen-pass': {
        id: 'alpen-pass',
        name: 'Portes du Bulli',
        subtitle: 'Alpine Ski Pass & Hairpin Touge',
        description: 'Inspired by seven legendary ski aftermovies: climb 210 m from Ramsen-Tal through hairpin switchbacks, snow pistes, and a driveable frozen alpine lake.',
        sizeMeters: 1600,
        elevationRange: [0, 210],
        grid: ALPEN_PASS_GRID,
        trackIds: ALPEN_PASS_TRACK_IDS,
        defaultTrackId: 'alpen-touge-descent',
        hasDiscoveries: true,
        discoveryCount: 4,
        previewImage: '/ui/map-alpen-pass.webp',
        showroomSpot: { x: -320, z: 460, yaw: 0.4 },
        atmosphere: {
            biome: 'alpine',
            hdri: '/textures/hdri/victoria_sunset_1k.hdr',
            sunAzimuth: 135,
            sunElevation: 24,
            sunColor: 0xfff0dc,
            sunIntensity: 3.4,
            exposure: 1.0,
            hemiSky: 0xcbe4ff,
            hemiGround: 0x8ea2b8,
            hemiIntensity: 0.72,
            fogColor: 0xd9e8f6,
            fogNear: 150,
            fogFar: 740,
            skyZenith: 0x28569c,
            skyHorizon: 0xead8d0,
            skyGlow: 0xffcf9e,
            waterColor: 0x3b7fa8,
            waterDeepColor: 0x1b3f5e,
            hasSea: false,
            biomeTextures: ['alpine_snow', 'alpine_ice', 'alpine_rock']
        }
    },
    'stunt-forge': {
        id: 'stunt-forge',
        name: 'Kiesgrube Stunt Park',
        subtitle: 'Quarry Bowl & Rallycross',
        description: 'Compact 1.2 × 1.2 km gravel quarry packed with twin crossover ramps, a 35 m canyon gap jump, a Bomberman-spiral drift pad, and loose rally rim stages.',
        sizeMeters: 1200,
        elevationRange: [-12, 68],
        grid: STUNT_FORGE_GRID,
        trackIds: STUNT_FORGE_TRACK_IDS,
        defaultTrackId: 'quarry-rallycross',
        hasDiscoveries: true,
        discoveryCount: 3,
        previewImage: '/ui/map-stunt-forge.webp',
        showroomSpot: { x: 0, z: -130, yaw: 0 },
        atmosphere: {
            biome: 'quarry',
            hdri: '/textures/hdri/qwantani_sunset_puresky_1k.hdr',
            sunAzimuth: 245,
            sunElevation: 26,
            sunColor: 0xffe2ad,
            sunIntensity: 3.5,
            exposure: 0.98,
            hemiSky: 0xffe6c0,
            hemiGround: 0xa67850,
            hemiIntensity: 0.62,
            fogColor: 0xe8c79b,
            fogNear: 110,
            fogFar: 560,
            skyZenith: 0x3f6fa6,
            skyHorizon: 0xecc99a,
            skyGlow: 0xffb362,
            waterColor: 0x4b747d,
            waterDeepColor: 0x2a454d,
            hasSea: false,
            biomeTextures: ['quarry_gravel', 'quarry_red_rock', 'concrete_bowl']
        }
    },
    'logge-forge': {
        id: 'logge-forge',
        name: "Logge's Discovery World",
        subtitle: 'Forge Island · 22 LMF Easter Eggs',
        description: 'Aus Neugier. Gemacht. Explore four alloy quadrants — Ramsen & Web, Purpur Arcade, AI Lab, and Film Peak — packed with 22 interactive Logge Media Forge easter eggs.',
        sizeMeters: 2000,
        elevationRange: [0, 125],
        grid: LOGGE_FORGE_GRID,
        trackIds: LOGGE_FORGE_TRACK_IDS,
        defaultTrackId: 'forge-grand-circuit',
        hasDiscoveries: true,
        discoveryCount: 22,
        previewImage: '/ui/map-logge-forge.webp',
        featured: true,
        showroomSpot: { x: 0, z: 58, yaw: Math.PI },
        atmosphere: {
            biome: 'forge',
            hdri: '/textures/hdri/victoria_sunset_1k.hdr',
            sunAzimuth: 295,
            sunElevation: 14,
            sunColor: 0xffb673,
            sunIntensity: 3.0,
            exposure: 0.96,
            hemiSky: 0x9b92c7,
            hemiGround: 0x5c3c2e,
            hemiIntensity: 0.65,
            fogColor: 0x382a3d,
            fogNear: 140,
            fogFar: 680,
            skyZenith: 0x1a1530,
            skyHorizon: 0xf2600c,
            skyGlow: 0xffb347,
            waterColor: 0x1d3f59,
            waterDeepColor: 0x0b1a29,
            hasSea: true,
            biomeTextures: ['forge_cobble', 'tulip_meadow', 'alpine_snow', 'alpine_rock']
        }
    }
};

export function mapDescriptor(id: MapId): MapDescriptor {
    return MAP_REGISTRY[id];
}

export function mapGrid(id: string): GridSpec {
    if (isMapId(id)) return MAP_GRIDS[id];
    throw new Error(`unknown map ${id}`);
}
