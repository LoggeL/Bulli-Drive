// valibot schemas of the map sources next to roads.json
// (docs/phase-3-design.md, 5.1, 3.5, 12 and 13.1, deviation A13):
//
//   map.json     header: map version, name, drivable boundary
//   zones.json   zone polygons (the bake rasterises them, table 11.1)
//   pois.json    landmarks, spawns per mode, the party arena's contents
//   tracks.json  race routes over the road network (trackRoute.ts)
//
// Like roads.json they are edited by hand, so unknown keys are rejected.
// Positions are [x, z] or {x, z}; yaw follows the sim: forward is
// (sin yaw, cos yaw), yaw = 0 points to +z (south), π to -z (north).

import * as v from 'valibot';
import { Finite, Id, NonNegative, Point, Positive, schemaErrors, type ParseResult } from './roadSchema.js';

const Polygon = v.pipe(v.array(Point), v.minLength(3));

export const MapFileSchema = v.strictObject({
    format: v.literal('bulli-map'),
    version: v.literal(1),
    mapId: Id,
    // Bumped on every change of the baked ground or the tracks (6.1, 13.3)
    mapVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
    name: v.string(),
    // Drivable limit (8.3): every road lies inside; the sim builds the
    // outline as a fence where it is not sea
    boundary: Polygon,
    // Light of the map (world-look.md): the sun's compass azimuth (degrees
    // from north, clockwise: 270 = west) and elevation; the client turns it
    // into its sun direction and rotates the sky HDRI to match (lighting.ts)
    lighting: v.optional(v.strictObject({
        sunAzimuth: v.pipe(v.number(), v.minValue(0), v.ltValue(360)),
        sunElevation: v.pipe(v.number(), v.gtValue(0), v.maxValue(90))
    }))
});

export const ZONE_NAMES = [
    'wild', 'downtown', 'residential', 'industrial', 'beach', 'dunes',
    'hills', 'cliffs', 'arena', 'park', 'ranch'
] as const;

export const ZonesFileSchema = v.strictObject({
    format: v.literal('bulli-zones'),
    version: v.literal(1),
    mapId: Id,
    // Later entries win where polygons overlap
    zones: v.array(v.strictObject({
        id: Id,
        zone: v.picklist(ZONE_NAMES),
        // Label for the minimap (3.5) and where it stands (else the
        // polygon's centre)
        name: v.optional(v.string()),
        label: v.optional(Point),
        polygon: Polygon
    }))
});

export const LANDMARK_KINDS = [
    'plaza', 'fountain', 'pier', 'restaurant', 'lookout', 'diner', 'gasStation', 'partyArena',
    'cannery', 'lighthouse', 'waterTower', 'lifeguardTower', 'barn', 'harbor', 'crane',
    'lightMast', 'beach', 'surfShop', 'park'
] as const;

const Pose = v.strictObject({ x: Finite, z: Finite, yaw: Finite });

// A free-roam spawn slot; `group` names the place (plaza, diner, ...). The
// server hands out the groups in turn (3.5).
const SpawnSlot = v.strictObject({ group: Id, x: Finite, z: Finite, yaw: Finite });

// Ramp as the sim's RampDef: centre, driving direction, size (m)
const RampSchema = v.strictObject({
    x: Finite, z: Finite, yaw: Finite,
    width: Positive, length: Positive, height: Positive
});

// Looks of a ramp (phase 2: steel and earth; sand on the beach and dunes)
export const RAMP_LOOKS = ['steel', 'earth', 'sand', 'wood'] as const;

export const PoisFileSchema = v.strictObject({
    format: v.literal('bulli-pois'),
    version: v.literal(1),
    mapId: Id,
    // Hand-placed landmarks (3.5); `area` names the roads.json area the
    // landmark stands on, if any
    landmarks: v.array(v.strictObject({
        id: Id,
        kind: v.picklist(LANDMARK_KINDS),
        name: v.string(),
        x: Finite,
        z: Finite,
        // Facing of the building's front, same convention as the sim's yaw
        yaw: v.optional(Finite),
        area: v.optional(Id)
    })),
    spawns: v.strictObject({
        // Groups of slots at the places of 3.5
        freeRoam: v.pipe(v.array(SpawnSlot), v.minLength(1)),
        // Slots at the arena's rim looking to the middle (12)
        party: v.pipe(v.array(Pose), v.minLength(1))
    }),
    // Jump ramps of the whole map (free roam and party; a race world adds
    // its track's ramps): the sim's RampDef with an ID and a look
    jumps: v.optional(v.array(v.strictObject({
        id: Id,
        x: Finite, z: Finite, yaw: Finite,
        width: Positive, length: Positive, height: Positive,
        look: v.picklist(RAMP_LOOKS)
    }))),
    // Party arena "Cannery Lot" (12)
    arena: v.strictObject({
        // roads.json area of the lot
        area: Id,
        // Gate to the access road, closed in the party world
        gate: v.strictObject({ x: Finite, z: Finite, yaw: Finite, width: Positive }),
        // Shipping containers as rotated boxes (obox, 8.2), 12.2 × 2.44 m
        containers: v.array(Pose),
        ramps: v.array(RampSchema),
        // Fixed coin and power-up points (replacing the random ones)
        coins: v.array(Point),
        powerups: v.array(Point)
    })
});

// A station on an edge: s is the arc length from the edge's `from` node,
// whatever the direction the route drives the edge in
const EdgeStation = v.strictObject({ edge: Id, s: NonNegative });

export const TrackRouteSchema = v.strictObject({
    id: Id,
    name: v.string(),
    kind: v.picklist(['circuit', 'sprint']),
    laps: v.pipe(v.number(), v.integer(), v.minValue(1)),
    trackVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
    // Bonus tracks (4: T5, T6) are data only and join the rotation later
    bonus: v.optional(v.boolean()),
    // Edge IDs in driving order; "-id" drives the edge against its direction
    route: v.pipe(v.array(v.pipe(v.string(), v.regex(/^-?[a-z0-9][a-z0-9-]*$/))), v.minLength(1)),
    // Start gate (circuit: start/finish) and, for a sprint, the finish
    start: EdgeStation,
    finish: v.optional(EdgeStation),
    // Largest distance between two gates (m)
    gateSpacing: v.pipe(v.number(), v.minValue(50)),
    // Every corner must allow this speed (km/h) for the weakest car class
    // (drivability check, drivability.ts)
    minCornerSpeed: v.pipe(v.number(), v.gtValue(0)),
    // Ramps on the route (race world only): station of the ramp's centre,
    // size (m), look
    ramps: v.optional(v.array(v.strictObject({
        edge: Id, s: NonNegative, length: Positive, height: Positive, width: v.optional(Positive),
        look: v.optional(v.picklist(RAMP_LOOKS))
    }))),
    // At least this many jumps (ramps with a working lip) on the route
    minJumps: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    // Chevron boards outside bends sharper than this curvature (1/m)
    chevronCurvature: v.optional(Positive)
});

export const TracksFileSchema = v.strictObject({
    format: v.literal('bulli-tracks'),
    version: v.literal(1),
    mapId: Id,
    tracks: v.array(TrackRouteSchema)
});

export type MapFile = v.InferOutput<typeof MapFileSchema>;
export type ZonesFile = v.InferOutput<typeof ZonesFileSchema>;
export type MapZone = ZonesFile['zones'][number];
export type PoisFile = v.InferOutput<typeof PoisFileSchema>;
export type Landmark = PoisFile['landmarks'][number];
export type TracksFile = v.InferOutput<typeof TracksFileSchema>;
export type TrackRoute = v.InferOutput<typeof TrackRouteSchema>;
export type EdgeStation = v.InferOutput<typeof EdgeStation>;
export type Jump = NonNullable<PoisFile['jumps']>[number];

function duplicates(kind: string, ids: readonly string[]): string[] {
    const seen = new Set<string>();
    const errors: string[] = [];
    for (const id of ids) {
        if (seen.has(id)) errors.push(`${kind} ${id}: duplicate id`);
        seen.add(id);
    }
    return errors;
}

function parseWith<T>(schema: v.GenericSchema<unknown, T>, value: unknown, check: (file: T) => string[]): ParseResult<T> {
    const parsed = v.safeParse(schema, value);
    if (!parsed.success) return { ok: false, errors: schemaErrors(parsed.issues) };
    const errors = check(parsed.output);
    return errors.length ? { ok: false, errors } : { ok: true, value: parsed.output };
}

export function parseMapFile(value: unknown): ParseResult<MapFile> {
    return parseWith(MapFileSchema, value, () => []);
}

export function parseZonesFile(value: unknown): ParseResult<ZonesFile> {
    return parseWith(ZonesFileSchema, value, file => duplicates('zone', file.zones.map(z => z.id)));
}

export function parsePoisFile(value: unknown): ParseResult<PoisFile> {
    return parseWith(PoisFileSchema, value, file => duplicates('landmark', file.landmarks.map(l => l.id)));
}

export function parseTracksFile(value: unknown): ParseResult<TracksFile> {
    return parseWith(TracksFileSchema, value, file => {
        const errors = duplicates('track', file.tracks.map(t => t.id));
        for (const track of file.tracks) {
            if (track.kind === 'sprint' && !track.finish) errors.push(`track ${track.id}: a sprint needs a finish`);
            if (track.kind === 'circuit' && track.finish) errors.push(`track ${track.id}: a circuit finishes at its start, drop "finish"`);
            if (track.kind === 'sprint' && track.laps !== 1) errors.push(`track ${track.id}: a sprint has 1 lap`);
        }
        return errors;
    });
}
