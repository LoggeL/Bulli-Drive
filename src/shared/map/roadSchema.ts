// valibot schema of the road network roads.json
// (docs/phase-3-design.md, 5.2) plus the checks a schema cannot express
// (references between nodes and edges, node kinds, Bézier segment ends).
// The files are edited by hand and by the spline editor, so unknown keys
// are rejected: a typo like "shoulders" must not silently fall back to a
// default.

import * as v from 'valibot';

export const Finite = v.pipe(v.number(), v.finite());
export const NonNegative = v.pipe(v.number(), v.finite(), v.minValue(0));
export const Positive = v.pipe(v.number(), v.finite(), v.gtValue(0));
export const Point = v.tuple([Finite, Finite]);
export const Id = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]*$/, 'IDs are lower-case kebab-case'));
const LaneCount = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(4));
const Side = v.picklist(['left', 'right']);

export const ROAD_SURFACES = ['asphalt', 'concrete', 'dirt', 'gravel', 'sand', 'wood'] as const;
const RoadSurfaceSchema = v.picklist(ROAD_SURFACES);

export const RoadProfileSchema = v.strictObject({
    // Drivable width between the curbs or road edges
    width: Positive,
    // Lanes forward / backward (0 backward on a one-way road)
    lanes: v.tuple([LaneCount, LaneCount]),
    surface: RoadSurfaceSchema,
    markings: v.strictObject({
        center: v.picklist(['none', 'dashedWhite', 'dashedYellow', 'solidYellow', 'doubleYellow']),
        lanes: v.picklist(['none', 'dashed']),
        edges: v.boolean(),
        parking: v.optional(v.picklist(['none', 'parallel', 'angled']))
    }),
    curb: v.strictObject({ left: v.boolean(), right: v.boolean(), height: NonNegative }),
    sidewalk: v.strictObject({ left: NonNegative, right: NonNegative }),
    // Drivable verge outside the road edge (surface of the surroundings)
    shoulder: NonNegative,
    // 0..1, looks only (patches, cracks, tyre tracks)
    wear: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
    // Speed (km/h) every curve of the road must allow for the weakest car
    // class in its lane (drivability check, tools/map/validate.ts); default
    // DEFAULT_DESIGN_SPEED in drivability.ts
    designSpeed: v.optional(v.pipe(v.number(), v.gtValue(0), v.maxValue(250)))
});

const JunctionSchema = v.strictObject({
    shape: v.picklist(['auto', 'roundabout']),
    // Trim radius; auto = half the widest incident road + 2 m
    radius: v.optional(Positive),
    control: v.picklist(['signal', 'stop', 'yield', 'none']),
    crosswalks: v.boolean(),
    cornerRadius: v.optional(NonNegative)
});

const RoadNodeSchema = v.strictObject({
    id: Id,
    x: Finite,
    z: Finite,
    // Fixed height; otherwise taken from the terrain when baking (6.4)
    y: v.optional(Finite),
    // joint: exactly two edge ends, passed through tangent-continuously
    // junction: a crossing (or explicitly marked as one)
    // end: a dead end with exactly one edge end
    kind: v.picklist(['junction', 'joint', 'end']),
    junction: v.optional(JunctionSchema)
});

const CurveSchema = v.variant('type', [
    // Inner support points between the edge's from and to node
    v.strictObject({ type: v.literal('catmullRom'), points: v.array(Point) }),
    // Piecewise cubic; every segment but the last ends at `to`, the last
    // one at the edge's `to` node
    v.strictObject({
        type: v.literal('bezier'),
        segments: v.pipe(
            v.array(v.strictObject({ c1: Point, c2: Point, to: v.optional(Point) })),
            v.minLength(1)
        )
    })
]);

export const RAIL_KINDS = ['wbeam', 'concrete', 'wood', 'fence'] as const;

const RailRangeSchema = v.strictObject({
    // Left / right in edge direction
    side: Side,
    // Station s in m; to = -1 runs to the end of the edge
    from: NonNegative,
    to: Finite,
    kind: v.picklist(RAIL_KINDS),
    // Distance from the road edge, default 0.5 m
    offset: v.optional(NonNegative)
});

const WallRangeSchema = v.strictObject({ side: Side, from: NonNegative, to: Finite });

const RoadEdgeSchema = v.strictObject({
    id: Id,
    name: v.optional(v.string()),
    from: Id,
    to: Id,
    curve: CurveSchema,
    profile: v.string(),
    // Replaces whole top-level fields of the profile (a nested object such
    // as markings is replaced as a whole, not merged)
    overrides: v.optional(v.partial(RoadProfileSchema)),
    oneWay: v.optional(v.boolean()),
    // Longitudinal grade limit, default 0.08
    maxGrade: v.optional(v.pipe(v.number(), v.gtValue(0), v.maxValue(0.3))),
    elevation: v.optional(v.array(v.strictObject({ s: NonNegative, y: Finite }))),
    rails: v.optional(v.array(RailRangeSchema)),
    // Retaining walls: a vertical step instead of an embankment on that side
    walls: v.optional(v.array(WallRangeSchema)),
    tags: v.optional(v.array(v.string()))
});

// Railing along the outline of an area (5.5, 7): the polygon's sides from
// vertex `from` to vertex `to` (wrapping past the last vertex; from = to is
// the whole outline), `offset` metres inside it
const AreaRailSchema = v.strictObject({
    from: v.pipe(v.number(), v.integer(), v.minValue(0)),
    to: v.pipe(v.number(), v.integer(), v.minValue(0)),
    kind: v.picklist(RAIL_KINDS),
    offset: v.optional(NonNegative)
});

const RoadAreaSchema = v.strictObject({
    id: Id,
    polygon: v.pipe(v.array(Point), v.minLength(3)),
    // Fixed height; otherwise the mean of the terrain inside the polygon
    y: v.optional(Finite),
    surface: RoadSurfaceSchema,
    curb: v.boolean(),
    markings: v.optional(v.picklist(['none', 'parking', 'plazaPavers'])),
    connects: v.array(Id),
    // Vertical sides instead of embankments and no flat margin around the
    // polygon (the pier: a deck over the water, not a dam)
    walls: v.optional(v.boolean()),
    // Railings and guard rails along the outline (pier, lookouts, quays)
    rails: v.optional(v.array(AreaRailSchema)),
    tags: v.optional(v.array(v.string()))
});

export const RoadNetworkSchema = v.strictObject({
    format: v.literal('bulli-roads'),
    version: v.literal(1),
    mapId: Id,
    profiles: v.record(v.string(), RoadProfileSchema),
    nodes: v.array(RoadNodeSchema),
    edges: v.array(RoadEdgeSchema),
    areas: v.array(RoadAreaSchema)
});

export type RoadNetworkFile = v.InferOutput<typeof RoadNetworkSchema>;
export type RoadProfile = v.InferOutput<typeof RoadProfileSchema>;
export type RoadNode = v.InferOutput<typeof RoadNodeSchema>;
export type RoadEdge = v.InferOutput<typeof RoadEdgeSchema>;
export type RoadArea = v.InferOutput<typeof RoadAreaSchema>;
export type Curve = v.InferOutput<typeof CurveSchema>;
export type RailRange = v.InferOutput<typeof RailRangeSchema>;
export type AreaRail = v.InferOutput<typeof AreaRailSchema>;
export type RailKind = typeof RAIL_KINDS[number];
export type WallRange = v.InferOutput<typeof WallRangeSchema>;
export type RoadSurfaceName = typeof ROAD_SURFACES[number];
export type AreaMarkings = NonNullable<RoadArea['markings']>;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function schemaErrors(issues: readonly v.BaseIssue<unknown>[]): string[] {
    return issues.map(issue => {
        const path = issue.path?.map(item => String(item.key)).join('.') ?? '';
        return path ? `${path}: ${issue.message}` : issue.message;
    });
}

// Minimum distance between consecutive support points of a curve. Closer
// points make the centripetal Catmull-Rom knot interval vanish.
export const MIN_POINT_SPACING = 0.5;

function distance(a: readonly [number, number], b: readonly [number, number]): number {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    return Math.sqrt(dx * dx + dz * dz);
}

// The checks between objects: unique IDs, references, node kinds against
// the number of edge ends, Bézier segment ends, point spacing, station
// ranges. Returns every problem with the ID it concerns; an empty list
// means the network can be built.
export function validateRoadNetwork(file: RoadNetworkFile): string[] {
    const errors: string[] = [];
    const nodes = new Map<string, RoadNode>();
    for (const node of file.nodes) {
        if (nodes.has(node.id)) errors.push(`node ${node.id}: duplicate id`);
        nodes.set(node.id, node);
    }
    const ends = new Map<string, number>();
    const edgeIds = new Set<string>();
    for (const edge of file.edges) {
        if (edgeIds.has(edge.id)) errors.push(`edge ${edge.id}: duplicate id`);
        edgeIds.add(edge.id);
        const from = nodes.get(edge.from);
        const to = nodes.get(edge.to);
        if (!from) errors.push(`edge ${edge.id}: unknown from node ${edge.from}`);
        if (!to) errors.push(`edge ${edge.id}: unknown to node ${edge.to}`);
        if (!(edge.profile in file.profiles)) errors.push(`edge ${edge.id}: unknown profile ${edge.profile}`);
        ends.set(edge.from, (ends.get(edge.from) ?? 0) + 1);
        ends.set(edge.to, (ends.get(edge.to) ?? 0) + 1);
        if (!from || !to) continue;

        const start: [number, number] = [from.x, from.z];
        const end: [number, number] = [to.x, to.z];
        if (edge.curve.type === 'catmullRom') {
            const points = [start, ...edge.curve.points, end];
            for (let i = 1; i < points.length; i++) {
                if (distance(points[i - 1], points[i]) < MIN_POINT_SPACING) {
                    errors.push(`edge ${edge.id}: support points ${i - 1} and ${i} closer than ${MIN_POINT_SPACING} m`);
                }
            }
        } else {
            const segments = edge.curve.segments;
            segments.forEach((segment, i) => {
                const last = i === segments.length - 1;
                if (last && segment.to) errors.push(`edge ${edge.id}: the last Bézier segment ends at node ${edge.to}, drop its "to"`);
                if (!last && !segment.to) errors.push(`edge ${edge.id}: Bézier segment ${i} needs "to"`);
            });
        }
        for (const range of [...(edge.rails ?? []), ...(edge.walls ?? [])]) {
            if (range.to !== -1 && range.to <= range.from) {
                errors.push(`edge ${edge.id}: range ${range.from}..${range.to} is empty (use to = -1 for the edge end)`);
            }
        }
    }
    for (const node of file.nodes) {
        const count = ends.get(node.id) ?? 0;
        if (node.kind === 'joint' && count !== 2) errors.push(`node ${node.id}: a joint needs exactly 2 edge ends, has ${count}`);
        if (node.kind === 'end' && count !== 1) errors.push(`node ${node.id}: an end needs exactly 1 edge end, has ${count}`);
        if (node.kind === 'junction' && count === 0) errors.push(`node ${node.id}: junction without edges`);
        if (node.junction && node.kind !== 'junction') errors.push(`node ${node.id}: junction settings on a ${node.kind}`);
    }
    const areaIds = new Set<string>();
    for (const area of file.areas) {
        if (areaIds.has(area.id)) errors.push(`area ${area.id}: duplicate id`);
        areaIds.add(area.id);
        for (const rail of area.rails ?? []) {
            if (rail.from >= area.polygon.length || rail.to >= area.polygon.length) {
                errors.push(`area ${area.id}: rail ${rail.from}..${rail.to} names a vertex the polygon does not have (${area.polygon.length})`);
            }
        }
        for (const id of area.connects) {
            if (!nodes.has(id)) errors.push(`area ${area.id}: unknown node ${id} in connects`);
        }
    }
    return errors;
}

// Schema check plus validateRoadNetwork
export function parseRoadNetwork(value: unknown): ParseResult<RoadNetworkFile> {
    const parsed = v.safeParse(RoadNetworkSchema, value);
    if (!parsed.success) return { ok: false, errors: schemaErrors(parsed.issues) };
    const errors = validateRoadNetwork(parsed.output);
    return errors.length ? { ok: false, errors } : { ok: true, value: parsed.output };
}
