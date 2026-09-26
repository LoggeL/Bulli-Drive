// Shared types of the curated map (docs/phase-3-design.md, sections 5, 6, 8
// and 11). The shapes of the JSON sources come from the valibot schemas in
// roadSchema.ts; this module adds the runtime types and the fixed ID tables
// that the baked heightfield stores per grid point.

export type {
    AreaMarkings,
    Curve,
    RailKind,
    RailRange,
    RoadArea,
    RoadEdge,
    RoadNetworkFile,
    RoadNode,
    RoadProfile,
    RoadSurfaceName,
    WallRange
} from './roadSchema.js';
export type { MapFile, MapZone, PoisFile, TrackRoute, TracksFile, ZonesFile } from './mapFiles.js';

// A point of an edge's centre line, resampled to 1 m of arc length
// (section 5.3). (tx, tz) is the unit tangent in edge direction, s the
// arc length from the edge's `from` node. curvature is 1/radius, positive
// when the road turns left (towards the left normal, see leftNormal in
// spline.ts).
export interface RoadSample {
    x: number;
    z: number;
    tx: number;
    tz: number;
    s: number;
    curvature: number;
}

// Surface IDs of the heightfield's surface layer (table 8.1). The values
// are part of the file format: never renumber, only append.
export const SURFACE = {
    asphalt: 0,
    concrete: 1,
    wood: 2,
    gravel: 3,
    dirt: 4,
    grass: 5,
    sand: 6,
    wetSand: 7,
    rock: 8,
    water: 9
} as const;
export type SurfaceId = typeof SURFACE[keyof typeof SURFACE];
export type SurfaceName = keyof typeof SURFACE;

// Rasterising priority per surface ID (table 8.1): where two sources claim
// the same grid point, the higher priority wins (the pier's wood over the
// road it starts from, any road over the ground next to it).
export const SURFACE_PRIORITY: readonly number[] = [9, 8, 10, 6, 5, 2, 3, 4, 1, 0];

// Grip factor g and rolling resistance d (m/s²) per surface ID (table 8.1,
// start values). The sim applies them per axle (vehicle.ts, unpaved ones
// scaled by the class's offroad values); the map validation estimates
// corner speeds with them (drivability.ts). Water is the sea floor under
// shallow water, driven through like soft sand with a wading drag; deeper
// than WATER_DEPTH the car stops and is reset (section 7).
export const SURFACE_GRIP: readonly number[] = [1.0, 0.97, 0.9, 0.8, 0.75, 0.7, 0.6, 0.72, 0.85, 0.55];
export const SURFACE_ROLL: readonly number[] = [0, 0, 0.1, 0.4, 0.5, 0.8, 1.6, 0.9, 0.3, 3.0];

// Paved surfaces: the car's class-specific offroad factors do not apply
export function isPaved(surface: number): boolean {
    return surface === SURFACE.asphalt || surface === SURFACE.concrete || surface === SURFACE.wood;
}

// Zone IDs of the zone layer (table 11.1), same rules as SURFACE
export const ZONE = {
    wild: 0,
    downtown: 1,
    residential: 2,
    industrial: 3,
    beach: 4,
    dunes: 5,
    hills: 6,
    cliffs: 7,
    arena: 8,
    park: 9,
    ranch: 10
} as const;
export type ZoneId = typeof ZONE[keyof typeof ZONE];
export type ZoneName = keyof typeof ZONE;
