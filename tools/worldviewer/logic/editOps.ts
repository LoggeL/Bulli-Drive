// The spline editor's operations on roads.json (docs/phase-3-design.md, 5.2).
// Every operation is a pure function: it takes the file and returns a new
// one, sharing the objects it did not touch (cheap undo history), and never
// mutates its input. Positions are rounded to COORD_STEP so the exported
// JSON stays short. The operations keep node kinds consistent with the
// number of edge ends (joint = 2, end = 1, junction otherwise); whether the
// result is a valid network (point spacing, ranges) is checked once for all
// of them by commitEdit.

import { MIN_POINT_SPACING, RoadNetworkSchema, schemaErrors, validateRoadNetwork } from '../../../src/shared/map/roadSchema.js';
import type {
    RailKind, RailRange, RoadEdge, RoadNetworkFile, RoadNode, RoadProfile, RoadSurfaceName, WallRange
} from '../../../src/shared/map/roadSchema.js';
import * as v from 'valibot';

export class EditError extends Error {}

export type Vec = [number, number];
type Junction = NonNullable<RoadNode['junction']>;
type Side = RailRange['side'];

// Grid of the stored coordinates and stations (m)
export const COORD_STEP = 0.1;
// Nearest distance of a new node to an existing support point before the
// split reuses that point
export const SNAP_TO_POINT = 1;
// Junction settings of a node that becomes a junction by an edit
export const DEFAULT_JUNCTION: Junction = { shape: 'auto', control: 'stop', crosswalks: false };

// Schema order of the keys: a key an edit adds goes to its schema place, so
// new objects look like the hand-written ones
const NODE_KEYS = ['id', 'x', 'z', 'y', 'kind', 'junction'];
const EDGE_KEYS = ['id', 'name', 'from', 'to', 'curve', 'profile', 'overrides', 'oneWay', 'maxGrade',
    'elevation', 'rails', 'walls', 'tags'];

export type Selection =
    | { kind: 'node'; id: string }
    | { kind: 'edge'; id: string }
    // Inner support point of a Catmull-Rom edge (index into curve.points)
    | { kind: 'point'; edge: string; index: number }
    // Handle of a Bézier edge ('to' only on segments before the last)
    | { kind: 'handle'; edge: string; segment: number; handle: 'c1' | 'c2' | 'to' }
    | null;

export interface EditResult {
    file: RoadNetworkFile;
    select?: Selection;
    // What the editor should tell the user (a merge that dropped settings)
    notes: string[];
}

// ---- Helpers ----

export function roundCoord(value: number, step = COORD_STEP): number {
    const decimals = Math.max(0, Math.ceil(-Math.log10(step)));
    // toFixed drops the binary noise of the product (0.30000000000000004)
    // and writes -0 as 0
    return Number((Math.round(value / step) * step).toFixed(decimals));
}

function roundVec(x: number, z: number): Vec {
    return [roundCoord(x), roundCoord(z)];
}

// Sets, replaces or (value undefined) removes keys. A new key goes before
// the first existing key that comes after it in `order`; existing keys keep
// their place, so an edit changes as little of the JSON line as possible.
export function withKeys<T extends object>(obj: T, patch: Record<string, unknown>, order: readonly string[]): T {
    const entries = Object.entries(obj).filter(([key]) => !(key in patch) || patch[key] !== undefined);
    const rank = (key: string) => {
        const i = order.indexOf(key);
        return i < 0 ? order.length : i;
    };
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        const at = entries.findIndex(([existing]) => existing === key);
        if (at >= 0) {
            entries[at] = [key, value];
            continue;
        }
        const before = entries.findIndex(([existing]) => rank(existing) > rank(key));
        if (before < 0) entries.push([key, value]);
        else entries.splice(before, 0, [key, value]);
    }
    return Object.fromEntries(entries) as T;
}

// First free `${prefix}-${n}`, n = 1, 2, ...
export function numberedId(prefix: string, taken: ReadonlySet<string>): string {
    for (let n = 1; ; n++) {
        const id = `${prefix}-${n}`;
        if (!taken.has(id)) return id;
    }
}

function findNode(file: RoadNetworkFile, id: string): RoadNode {
    const node = file.nodes.find(n => n.id === id);
    if (!node) throw new EditError(`unknown node ${id}`);
    return node;
}

function findEdge(file: RoadNetworkFile, id: string): RoadEdge {
    const edge = file.edges.find(e => e.id === id);
    if (!edge) throw new EditError(`unknown edge ${id}`);
    return edge;
}

function replaceEdge(file: RoadNetworkFile, id: string, next: RoadEdge): RoadNetworkFile {
    return { ...file, edges: file.edges.map(e => e.id === id ? next : e) };
}

function replaceNode(file: RoadNetworkFile, id: string, next: RoadNode): RoadNetworkFile {
    return { ...file, nodes: file.nodes.map(n => n.id === id ? next : n) };
}

function catmullPoints(edge: RoadEdge): Vec[] {
    if (edge.curve.type !== 'catmullRom') {
        throw new EditError(`edge ${edge.id} is a Bézier edge: only its handles can be moved`);
    }
    return edge.curve.points as Vec[];
}

function withPoints(edge: RoadEdge, points: Vec[]): RoadEdge {
    return { ...edge, curve: { type: 'catmullRom', points } };
}

// Number of edge ends at a node (an edge from the node to itself counts twice)
export function endCount(file: RoadNetworkFile, nodeId: string): number {
    let count = 0;
    for (const edge of file.edges) {
        if (edge.from === nodeId) count++;
        if (edge.to === nodeId) count++;
    }
    return count;
}

// Brings the kinds of the given nodes in line with their edge ends: without
// ends the node goes (also from the areas' connects), one end makes a dead
// end, a dead end with two ends becomes a joint, three or more ends make a
// junction. A junction with two ends stays one (explicitly marked).
export function reconcileNodes(file: RoadNetworkFile, ids: readonly string[]): RoadNetworkFile {
    let next = file;
    for (const id of new Set(ids)) {
        const node = next.nodes.find(n => n.id === id);
        if (!node) continue;
        const count = endCount(next, id);
        if (count === 0) {
            next = {
                ...next,
                nodes: next.nodes.filter(n => n.id !== id),
                areas: next.areas.map(a => a.connects.includes(id) ? { ...a, connects: a.connects.filter(c => c !== id) } : a)
            };
        } else if (count === 1 && node.kind !== 'end') {
            next = replaceNode(next, id, withKeys(node, { kind: 'end', junction: undefined }, NODE_KEYS));
        } else if (count === 2 && node.kind === 'end') {
            next = replaceNode(next, id, withKeys(node, { kind: 'joint' }, NODE_KEYS));
        } else if (count >= 3 && node.kind !== 'junction') {
            next = replaceNode(next, id, withKeys(node, { kind: 'junction', junction: { ...DEFAULT_JUNCTION } }, NODE_KEYS));
        }
    }
    return next;
}

function distance(a: readonly [number, number], b: readonly [number, number]): number {
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function segmentDistance(p: Vec, a: readonly [number, number], b: readonly [number, number]): number {
    const ex = b[0] - a[0], ez = b[1] - a[1];
    const len2 = ex * ex + ez * ez;
    let t = len2 > 0 ? ((p[0] - a[0]) * ex + (p[1] - a[1]) * ez) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - a[0] - ex * t, p[1] - a[1] - ez * t);
}

// Index k of the control polygon's leg polygon[k] → polygon[k + 1] nearest
// to p (the first on a tie)
export function nearestLeg(polygon: readonly (readonly [number, number])[], p: Vec): number {
    let best = 0, bestDistance = Infinity;
    for (let k = 0; k + 1 < polygon.length; k++) {
        const d = segmentDistance(p, polygon[k], polygon[k + 1]);
        if (d < bestDistance) { bestDistance = d; best = k; }
    }
    return best;
}

function controlPolygon(file: RoadNetworkFile, edge: RoadEdge): Vec[] {
    const from = findNode(file, edge.from), to = findNode(file, edge.to);
    return [[from.x, from.z], ...catmullPoints(edge), [to.x, to.z]];
}

// ---- Validity ----

export type CommitResult = { ok: true; result: EditResult } | { ok: false; errors: string[] };

// Applies an operation and keeps the result only when it is a network the
// game can build (schema plus validateRoadNetwork); otherwise the errors.
// The editor never holds an invalid file.
export function commitEdit(file: RoadNetworkFile, op: (file: RoadNetworkFile) => EditResult): CommitResult {
    let result: EditResult;
    try {
        result = op(file);
    } catch (error) {
        if (error instanceof EditError) return { ok: false, errors: [error.message] };
        throw error;
    }
    const parsed = v.safeParse(RoadNetworkSchema, result.file);
    if (!parsed.success) return { ok: false, errors: schemaErrors(parsed.issues) };
    const errors = validateRoadNetwork(result.file);
    return errors.length ? { ok: false, errors } : { ok: true, result };
}

// ---- Nodes ----

// Moves a node. The Bézier handles next to it move along, so the tangent
// there keeps its direction.
export function moveNode(file: RoadNetworkFile, id: string, x: number, z: number): EditResult {
    const node = findNode(file, id);
    const [nx, nz] = roundVec(x, z);
    const dx = nx - node.x, dz = nz - node.z;
    const shift = (p: readonly [number, number]): Vec => roundVec(p[0] + dx, p[1] + dz);
    let next = replaceNode(file, id, { ...node, x: nx, z: nz });
    for (const edge of next.edges) {
        if (edge.curve.type !== 'bezier' || (edge.from !== id && edge.to !== id)) continue;
        const segments = edge.curve.segments.map(s => ({ ...s }));
        if (edge.from === id) segments[0].c1 = shift(segments[0].c1);
        if (edge.to === id) segments[segments.length - 1].c2 = shift(segments[segments.length - 1].c2);
        next = replaceEdge(next, edge.id, { ...edge, curve: { type: 'bezier', segments } });
    }
    return { file: next, select: { kind: 'node', id }, notes: [] };
}

export interface NodePatch {
    // Fixed height, null = from the terrain
    y?: number | null;
    control?: Junction['control'];
}

export function setNodeProps(file: RoadNetworkFile, id: string, patch: NodePatch): EditResult {
    const node = findNode(file, id);
    const changes: Record<string, unknown> = {};
    if (patch.y !== undefined) changes.y = patch.y === null ? undefined : roundCoord(patch.y, 0.01);
    if (patch.control !== undefined) {
        if (node.kind !== 'junction') throw new EditError(`node ${id} is no junction`);
        changes.junction = { ...(node.junction ?? DEFAULT_JUNCTION), control: patch.control };
    }
    return { file: replaceNode(file, id, withKeys(node, changes, NODE_KEYS)), select: { kind: 'node', id }, notes: [] };
}

// ---- Edges ----

export type Endpoint = { node: string } | { at: Vec };

export interface AddEdgeOptions {
    profile?: string;
}

// Adds a straight edge between two endpoints, each an existing node or a
// new dead end at a position. The profile is the given one, else the one of
// the first road at an existing endpoint, else the file's first. Continuing
// a dead end also continues its road's name. Selects the `to` node (the
// next click of the draw tool continues from there).
export function addEdge(file: RoadNetworkFile, from: Endpoint, to: Endpoint, options: AddEdgeOptions = {}): EditResult {
    const nodeIds = new Set(file.nodes.map(n => n.id));
    const nodes = [...file.nodes];
    const resolve = (end: Endpoint): RoadNode => {
        if ('node' in end) return findNode(file, end.node);
        const [x, z] = roundVec(end.at[0], end.at[1]);
        const node: RoadNode = { id: numberedId('node', nodeIds), x, z, kind: 'end' };
        nodeIds.add(node.id);
        nodes.push(node);
        return node;
    };
    const a = resolve(from), b = resolve(to);
    if (a.id === b.id) throw new EditError('an edge needs two different nodes');
    if (distance([a.x, a.z], [b.x, b.z]) < MIN_POINT_SPACING) {
        throw new EditError(`the ends are closer than ${MIN_POINT_SPACING} m`);
    }
    const existing = [a, b].filter(n => file.nodes.includes(n));
    const roadsAt = (id: string) => file.edges.filter(e => e.from === id || e.to === id);
    const profile = options.profile ?? existing.map(n => roadsAt(n.id)[0]?.profile).find(p => p !== undefined)
        ?? Object.keys(file.profiles)[0];
    if (!profile || !(profile in file.profiles)) throw new EditError(`unknown profile ${profile}`);
    const continued = existing.map(n => roadsAt(n.id)).find(roads => roads.length === 1)?.[0];
    const edge = withKeys({
        id: numberedId('road', new Set(file.edges.map(e => e.id))),
        from: a.id,
        to: b.id,
        curve: { type: 'catmullRom', points: [] },
        profile
    } as RoadEdge, { name: continued?.name }, EDGE_KEYS);
    const next = reconcileNodes({ ...file, nodes, edges: [...file.edges, edge] }, existing.map(n => n.id));
    return { file: next, select: { kind: 'node', id: b.id }, notes: [] };
}

interface Range { from: number; to: number }

// Splits station ranges (rails, walls; to = -1 = up to the end) at station
// `at`: the part before stays on the first edge (a range reaching the split
// then runs to its end), the part after moves to the second edge, shifted
// to start at 0.
export function splitRanges<T extends Range>(ranges: readonly T[], at: number): [T[], T[]] {
    const first: T[] = [], second: T[] = [];
    for (const range of ranges) {
        const reaches = range.to === -1 || range.to >= at;
        if (range.from < at) first.push({ ...range, to: reaches ? -1 : range.to });
        if (range.to === -1 || range.to > at) {
            second.push({
                ...range,
                from: Math.max(0, roundCoord(range.from - at)),
                to: range.to === -1 ? -1 : roundCoord(range.to - at)
            });
        }
    }
    return [first, second];
}

function optionalList<T>(list: T[]): T[] | undefined {
    return list.length ? list : undefined;
}

// Splits a Catmull-Rom edge at a point of its centre line (x, z at station
// s, as nearestRoad reports it) with a new joint. An inner support point
// within SNAP_TO_POINT becomes the joint instead of a new point next to it.
// The first part keeps the edge's id, the second is `<id>-b` (or the next
// free variant) and follows it in the file. Rails, walls and elevation pins
// are split by station.
export function splitEdge(file: RoadNetworkFile, edgeId: string, at: { x: number; z: number; s: number }): EditResult {
    const edge = findEdge(file, edgeId);
    const points = catmullPoints(edge);
    const polygon = controlPolygon(file, edge);
    let p: Vec = roundVec(at.x, at.z);
    if (distance(p, polygon[0]) < SNAP_TO_POINT || distance(p, polygon[polygon.length - 1]) < SNAP_TO_POINT) {
        throw new EditError(`split point is at a node of ${edgeId}; split further along the road`);
    }
    let before: Vec[], after: Vec[];
    const snapped = points.findIndex(q => distance(p, q) < SNAP_TO_POINT);
    if (snapped >= 0) {
        p = points[snapped];
        before = points.slice(0, snapped);
        after = points.slice(snapped + 1);
    } else {
        const k = nearestLeg(polygon, p);
        before = points.slice(0, k);
        after = points.slice(k);
    }
    const nodeIds = new Set(file.nodes.map(n => n.id));
    const node: RoadNode = { id: numberedId('node', nodeIds), x: p[0], z: p[1], kind: 'joint' };
    const edgeIds = new Set(file.edges.map(e => e.id));
    let secondId = `${edgeId}-b`;
    if (edgeIds.has(secondId)) secondId = numberedId(`${edgeId}-b`, edgeIds);

    const s = roundCoord(at.s);
    const [railsA, railsB] = splitRanges<RailRange>(edge.rails ?? [], s);
    const [wallsA, wallsB] = splitRanges<WallRange>(edge.walls ?? [], s);
    const pins = edge.elevation ?? [];
    const first = withKeys(withPoints(edge, before), {
        to: node.id, rails: optionalList(railsA), walls: optionalList(wallsA),
        elevation: optionalList(pins.filter(pin => pin.s < s))
    }, EDGE_KEYS);
    const second = withKeys(withPoints(edge, after), {
        id: secondId, from: node.id,
        rails: optionalList(railsB), walls: optionalList(wallsB),
        elevation: optionalList(pins.filter(pin => pin.s >= s).map(pin => ({ ...pin, s: roundCoord(pin.s - s) })))
    }, EDGE_KEYS);

    const edges = file.edges.flatMap(e => e.id === edgeId ? [first, second] : [e]);
    const fromIndex = file.nodes.findIndex(n => n.id === edge.from);
    const nodes = [...file.nodes.slice(0, fromIndex + 1), node, ...file.nodes.slice(fromIndex + 1)];
    return { file: { ...file, nodes, edges }, select: { kind: 'node', id: node.id }, notes: [] };
}

// Reverses an edge's direction. `length` is its centre-line length (from
// the built network): stations s become length - s, left and right swap.
export function reverseEdge(file: RoadNetworkFile, edgeId: string, length: number): EditResult {
    const edge = findEdge(file, edgeId);
    return { file: replaceEdge(file, edgeId, reversed(edge, length)), select: { kind: 'edge', id: edgeId }, notes: [] };
}

function reverseRange<T extends Range & { side: Side }>(range: T, length: number): T {
    const to = range.to === -1 ? length : range.to;
    return {
        ...range,
        side: range.side === 'left' ? 'right' : 'left',
        from: Math.max(0, roundCoord(length - to)),
        to: range.from === 0 ? -1 : roundCoord(length - range.from)
    };
}

function reversed(edge: RoadEdge, length: number): RoadEdge {
    let curve: RoadEdge['curve'];
    if (edge.curve.type === 'catmullRom') {
        curve = { type: 'catmullRom', points: [...edge.curve.points].reverse() };
    } else {
        // Segment k runs from P(k) to P(k+1) with handles c1, c2; reversed
        // it runs from P(k+1) to P(k) with c2, c1
        const segs = edge.curve.segments;
        const starts = segs.map((_, k) => k === 0 ? null : segs[k - 1].to!);
        const segments = segs.map((_, i) => {
            const k = segs.length - 1 - i;
            const start = starts[k];
            return start ? { c1: segs[k].c2, c2: segs[k].c1, to: start } : { c1: segs[k].c2, c2: segs[k].c1 };
        });
        curve = { type: 'bezier', segments };
    }
    return withKeys(edge, {
        from: edge.to, to: edge.from, curve,
        rails: edge.rails?.map(r => reverseRange(r, length)),
        walls: edge.walls?.map(w => reverseRange(w, length)),
        elevation: edge.elevation && [...edge.elevation].reverse().map(pin => ({ ...pin, s: roundCoord(length - pin.s) }))
    }, EDGE_KEYS);
}

export function deleteEdge(file: RoadNetworkFile, edgeId: string): EditResult {
    const edge = findEdge(file, edgeId);
    const next = { ...file, edges: file.edges.filter(e => e.id !== edgeId) };
    return { file: reconcileNodes(next, [edge.from, edge.to]), select: null, notes: [] };
}

// Deletes a node. A joint (two roads meeting) is dissolved: its two edges
// become one through the joint's position, keeping the id and settings of
// the one earlier in the file (the curve does not change: the joint was
// tangent-continuous). Any other node goes with all its edges.
// lengthOf gives an edge's centre-line length (for the stations).
export function deleteNode(file: RoadNetworkFile, nodeId: string, lengthOf: (edgeId: string) => number): EditResult {
    const node = findNode(file, nodeId);
    const incident = file.edges.filter(e => e.from === nodeId || e.to === nodeId);
    if (node.kind === 'joint' && incident.length === 2) return mergeAtJoint(file, node, incident, lengthOf);
    const removed = new Set(incident.map(e => e.id));
    const neighbours = incident.flatMap(e => [e.from, e.to]).filter(id => id !== nodeId);
    const next: RoadNetworkFile = {
        ...file,
        nodes: file.nodes.filter(n => n.id !== nodeId),
        edges: file.edges.filter(e => !removed.has(e.id)),
        areas: file.areas.map(a => a.connects.includes(nodeId) ? { ...a, connects: a.connects.filter(c => c !== nodeId) } : a)
    };
    return { file: reconcileNodes(next, neighbours), select: null, notes: [] };
}

function shiftRange<T extends Range>(range: T, by: number): T {
    return { ...range, from: roundCoord(range.from + by), to: range.to === -1 ? -1 : roundCoord(range.to + by) };
}

function mergeAtJoint(file: RoadNetworkFile, node: RoadNode, incident: RoadEdge[], lengthOf: (id: string) => number): EditResult {
    // Two edges, each with one end here (a joint has exactly two ends).
    // catmullPoints below refuses Bézier edges.
    const [e1, e2] = incident;
    // Keep e1's direction: first → joint → second
    const e1EndsHere = e1.to === node.id;
    const other = e1EndsHere
        ? (e2.from === node.id ? e2 : reversed(e2, lengthOf(e2.id)))
        : (e2.to === node.id ? e2 : reversed(e2, lengthOf(e2.id)));
    const first = e1EndsHere ? e1 : other;
    const second = e1EndsHere ? other : e1;
    const firstLength = lengthOf(e1EndsHere ? e1.id : e2.id);
    // A range of the first part up to its end now ends at the joint
    const closeRange = <T extends Range>(r: T): T => r.to === -1 ? { ...r, to: roundCoord(firstLength) } : r;
    const rails = [...(first.rails ?? []).map(closeRange), ...(second.rails ?? []).map(r => shiftRange(r, firstLength))];
    const walls = [...(first.walls ?? []).map(closeRange), ...(second.walls ?? []).map(r => shiftRange(r, firstLength))];
    const pins = [...(first.elevation ?? []), ...(second.elevation ?? []).map(pin => ({ ...pin, s: roundCoord(pin.s + firstLength) }))];
    const merged = withKeys(e1, {
        from: first.from,
        to: second.to,
        curve: { type: 'catmullRom', points: [...catmullPoints(first), [node.x, node.z], ...catmullPoints(second)] },
        rails: optionalList(rails), walls: optionalList(walls), elevation: optionalList(pins)
    }, EDGE_KEYS);

    const notes: string[] = [];
    for (const key of ['name', 'profile', 'overrides', 'oneWay', 'maxGrade', 'tags'] as const) {
        if (JSON.stringify(e1[key]) !== JSON.stringify(e2[key])) notes.push(`${e2.id}: ${key} of ${e1.id} applies to the merged road`);
    }
    const next: RoadNetworkFile = {
        ...file,
        nodes: file.nodes.filter(n => n.id !== node.id),
        edges: file.edges.filter(e => e.id !== e2.id).map(e => e.id === e1.id ? merged : e),
        areas: file.areas.map(a => a.connects.includes(node.id) ? { ...a, connects: a.connects.filter(c => c !== node.id) } : a)
    };
    return { file: next, select: { kind: 'edge', id: e1.id }, notes };
}

export interface EdgePatch {
    name?: string | null;
    profile?: string;
    // Overrides of the profile; null (or the profile's own value) removes one
    width?: number | null;
    surface?: RoadSurfaceName | null;
    oneWay?: boolean;
    maxGrade?: number | null;
}

// Changes an edge's settings. Width and surface are stored as overrides of
// its profile, and only while they differ from it.
export function setEdgeProps(file: RoadNetworkFile, edgeId: string, patch: EdgePatch): EditResult {
    const edge = findEdge(file, edgeId);
    const profileName = patch.profile ?? edge.profile;
    const profile: RoadProfile | undefined = file.profiles[profileName];
    if (!profile) throw new EditError(`unknown profile ${profileName}`);
    const overrides: Record<string, unknown> = { ...(edge.overrides ?? {}) };
    if (patch.width !== undefined) overrides.width = patch.width === null ? undefined : roundCoord(patch.width);
    if (patch.surface !== undefined) overrides.surface = patch.surface ?? undefined;
    for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined || JSON.stringify(value) === JSON.stringify(profile[key as keyof RoadProfile])) delete overrides[key];
    }
    const changes: Record<string, unknown> = {
        profile: profileName,
        overrides: Object.keys(overrides).length ? withKeys({}, overrides, Object.keys(profile)) : undefined
    };
    if (patch.name !== undefined) changes.name = patch.name ? patch.name : undefined;
    if (patch.oneWay !== undefined) changes.oneWay = patch.oneWay ? true : undefined;
    if (patch.maxGrade !== undefined) changes.maxGrade = patch.maxGrade === null ? undefined : patch.maxGrade;
    return { file: replaceEdge(file, edgeId, withKeys(edge, changes, EDGE_KEYS)), select: { kind: 'edge', id: edgeId }, notes: [] };
}

// ---- Guard rails ----

export type SideRail = 'none' | RailKind | 'mixed';

// What one side of an edge carries: nothing, one rail over the whole edge,
// or anything else (partial or several ranges)
export function sideRail(edge: RoadEdge, side: Side): SideRail {
    const ranges = (edge.rails ?? []).filter(r => r.side === side);
    if (ranges.length === 0) return 'none';
    if (ranges.length === 1 && ranges[0].from === 0 && ranges[0].to === -1) return ranges[0].kind;
    return 'mixed';
}

// Replaces one side's rails by a single rail over the whole edge, or
// removes them (kind null). The offset of a rail already there is kept.
export function setSideRail(file: RoadNetworkFile, edgeId: string, side: Side, kind: RailKind | null): EditResult {
    const edge = findEdge(file, edgeId);
    const rails = edge.rails ?? [];
    const keep = rails.filter(r => r.side !== side);
    const offset = rails.find(r => r.side === side)?.offset;
    const rail: RailRange | null = kind ? withKeys({ side, from: 0, to: -1, kind } as RailRange, { offset }, ['side', 'from', 'to', 'kind', 'offset']) : null;
    const next = rail ? (side === 'left' ? [rail, ...keep] : [...keep, rail]) : keep;
    return { file: replaceEdge(file, edgeId, withKeys(edge, { rails: optionalList(next) }, EDGE_KEYS)), select: { kind: 'edge', id: edgeId }, notes: [] };
}

export function updateRail(file: RoadNetworkFile, edgeId: string, index: number, patch: Partial<Pick<RailRange, 'from' | 'to' | 'kind'>>): EditResult {
    const edge = findEdge(file, edgeId);
    const rails = edge.rails ?? [];
    if (!rails[index]) throw new EditError(`edge ${edgeId} has no rail ${index}`);
    const rounded = { ...patch };
    if (rounded.from !== undefined) rounded.from = roundCoord(rounded.from);
    if (rounded.to !== undefined && rounded.to !== -1) rounded.to = roundCoord(rounded.to);
    const next = rails.map((r, i) => i === index ? { ...r, ...rounded } : r);
    return { file: replaceEdge(file, edgeId, { ...edge, rails: next }), select: { kind: 'edge', id: edgeId }, notes: [] };
}

export function removeRail(file: RoadNetworkFile, edgeId: string, index: number): EditResult {
    const edge = findEdge(file, edgeId);
    const rails = edge.rails ?? [];
    if (!rails[index]) throw new EditError(`edge ${edgeId} has no rail ${index}`);
    const next = rails.filter((_, i) => i !== index);
    return { file: replaceEdge(file, edgeId, withKeys(edge, { rails: optionalList(next) }, EDGE_KEYS)), select: { kind: 'edge', id: edgeId }, notes: [] };
}

// ---- Support points and handles ----

// Inserts a support point into a Catmull-Rom edge, between the two control
// points whose leg is nearest to (x, z)
export function insertPoint(file: RoadNetworkFile, edgeId: string, x: number, z: number): EditResult {
    const edge = findEdge(file, edgeId);
    const points = catmullPoints(edge);
    const p = roundVec(x, z);
    const k = nearestLeg(controlPolygon(file, edge), p);
    const next = [...points.slice(0, k), p, ...points.slice(k)];
    return { file: replaceEdge(file, edgeId, withPoints(edge, next)), select: { kind: 'point', edge: edgeId, index: k }, notes: [] };
}

export function movePoint(file: RoadNetworkFile, edgeId: string, index: number, x: number, z: number): EditResult {
    const edge = findEdge(file, edgeId);
    const points = catmullPoints(edge);
    if (!points[index]) throw new EditError(`edge ${edgeId} has no support point ${index}`);
    const next = points.map((q, i) => i === index ? roundVec(x, z) : q);
    return { file: replaceEdge(file, edgeId, withPoints(edge, next)), select: { kind: 'point', edge: edgeId, index }, notes: [] };
}

export function deletePoint(file: RoadNetworkFile, edgeId: string, index: number): EditResult {
    const edge = findEdge(file, edgeId);
    const points = catmullPoints(edge);
    if (!points[index]) throw new EditError(`edge ${edgeId} has no support point ${index}`);
    return { file: replaceEdge(file, edgeId, withPoints(edge, points.filter((_, i) => i !== index))), select: { kind: 'edge', id: edgeId }, notes: [] };
}

export function moveHandle(file: RoadNetworkFile, edgeId: string, segment: number, handle: 'c1' | 'c2' | 'to', x: number, z: number): EditResult {
    const edge = findEdge(file, edgeId);
    if (edge.curve.type !== 'bezier') throw new EditError(`edge ${edgeId} is no Bézier edge`);
    const segments = edge.curve.segments;
    if (!segments[segment]) throw new EditError(`edge ${edgeId} has no segment ${segment}`);
    if (handle === 'to' && segment === segments.length - 1) throw new EditError('the last segment ends at the node: move the node');
    const next = segments.map((s, i) => i === segment ? { ...s, [handle]: roundVec(x, z) } : s);
    return {
        file: replaceEdge(file, edgeId, { ...edge, curve: { type: 'bezier', segments: next } }),
        select: { kind: 'handle', edge: edgeId, segment, handle }, notes: []
    };
}

// Removes whatever is selected
export function deleteSelection(file: RoadNetworkFile, selection: Selection, lengthOf: (edgeId: string) => number): EditResult {
    if (!selection) throw new EditError('nothing selected');
    switch (selection.kind) {
        case 'node': return deleteNode(file, selection.id, lengthOf);
        case 'edge': return deleteEdge(file, selection.id);
        case 'point': return deletePoint(file, selection.edge, selection.index);
        case 'handle': throw new EditError('Bézier handles cannot be deleted');
    }
}
