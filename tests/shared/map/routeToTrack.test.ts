import { describe, expect, it } from 'vitest';
import type { TrackRoute } from '../../../src/shared/map/mapFiles.js';
import { buildRoadNetwork, type RoadNetwork } from '../../../src/shared/map/roadNetwork.js';
import {
    isAxisYaw, junctionBarriers, routeBends, routeRamps, routeToTrack, snapYaw, type MapTrackDef
} from '../../../src/shared/map/routeToTrack.js';
import { resolveRoute, type ResolvedRoute } from '../../../src/shared/map/trackRoute.js';
import { createCourse, createRaceProgress, passGate } from '../../../src/shared/race/progress.js';
import { trackColliders } from '../../../src/shared/race/raceWorld.js';
import { buildRacingLine } from '../../../src/shared/race/racingLine.js';
import type { TrackDef } from '../../../src/shared/race/types.js';
import { edge, network, node } from './fixtures.js';

// routeToTrack (docs/phase-3-design.md, 13.2, steps 5 and 6) on the square
// of trackRoute.test.ts: A (0 | 0) - M1 (100 | 0) - B (200 | 0) - C
// (200 | 200) - M2 (100 | 200) - D (0 | 200), cross street M1-M2, roads
// 10 m wide, junction trims 7 m, transitions from 12 m before a node.

function squareNetwork(): RoadNetwork {
    return buildRoadNetwork(network(
        [
            node('a', 0, 0, 'junction'), node('m1', 100, 0, 'junction'), node('b', 200, 0, 'junction'),
            node('c', 200, 200, 'junction'), node('m2', 100, 200, 'junction'), node('d', 0, 200, 'junction')
        ],
        [
            edge('ab1', 'a', 'm1'), edge('ab2', 'm1', 'b'), edge('bc', 'b', 'c'),
            edge('cd1', 'c', 'm2'), edge('cd2', 'm2', 'd'), edge('da', 'd', 'a'),
            edge('cross', 'm1', 'm2')
        ]
    ));
}

const LOOP: TrackRoute = {
    id: 'loop', name: 'Loop', kind: 'circuit', laps: 3, trackVersion: 4,
    route: ['ab1', 'ab2', 'bc', 'cd1', 'cd2', 'da'],
    start: { edge: 'ab1', s: 60 }, gateSpacing: 1000, minCornerSpeed: 10
};

function resolved(net: RoadNetwork, track: TrackRoute): ResolvedRoute {
    const result = resolveRoute(net, track);
    if (!result.ok) throw new Error(result.errors.join('\n'));
    return result.route;
}

// The phase 2 functions take a TrackDef; the map's IDs join TRACK_IDS at M5
function asPhase2(track: MapTrackDef): TrackDef {
    return track as unknown as TrackDef;
}

describe('routeToTrack', () => {
    it('copies the route\'s data into a phase 2 TrackDef', () => {
        const net = squareNetwork();
        const route = resolved(net, LOOP);
        const track = routeToTrack(net, route, 4);
        expect(track).toMatchObject({
            id: 'loop', name: 'Loop', kind: 'circuit', laps: 3, mapVersion: 4, trackVersion: 4,
            lineOptions: { radius: 0, apexShift: 0 }, bonus: false, ramps: []
        });
        expect(track.centerline).toHaveLength(route.points.length);
        expect(track.gates.map(g => g.visual)).toEqual(['startFinish', 'arch', 'arch']);
        expect(track.grid).toHaveLength(8);
        // The sides of the square are at x, z = 0 and 200; the corners are
        // rounded inwards, so the frame is the square plus 40 m
        expect(track.minimap).toEqual({ minX: -40, maxX: 240, minZ: -40, maxZ: 240 });
    });

    it('starts a circuit\'s centre line at its start/finish gate, so the gates lie in order along the line', () => {
        const net = squareNetwork();
        const route = resolved(net, LOOP);
        // The route itself begins where ab1 leaves the junction at a (x = 12)
        expect(route.points[0].x).toBe(12);
        const track = routeToTrack(net, route, 4);
        // The start is 60 m along ab1 from a (0 | 0): the gate at (60 | 0).
        // The line's first point is the last one (every 2 m) not past it
        expect(track.gates[0]).toMatchObject({ x: 60, z: 0 });
        const [first, second] = track.centerline;
        expect(first.z).toBe(0);
        expect(first.x).toBeGreaterThan(58);
        expect(first.x).toBeLessThanOrEqual(60);
        expect(second.x).toBeGreaterThan(60);
        // Phase 2 measures the gates from the line's origin: start/finish
        // first, then ascending (else the legs come out negative)
        const course = createCourse(asPhase2(track), buildRacingLine(asPhase2(track)));
        expect(course.gateS[0]).toBeLessThan(2);
        for (let k = 1; k < course.gateS.length; k++) expect(course.gateS[k]).toBeGreaterThan(course.gateS[k - 1]);
        expect(course.legLength.every(leg => leg > 0)).toBe(true);
    });

    it('keeps a sprint\'s points from its first edge on', () => {
        const net = squareNetwork();
        const sprint: TrackRoute = { ...LOOP, id: 'sprint', kind: 'sprint', laps: 1, route: ['ab1', 'ab2', 'bc'], finish: { edge: 'bc', s: 150 } };
        const route = resolved(net, sprint);
        const track = routeToTrack(net, route, 4);
        expect(track.centerline[0]).toEqual({ x: route.points[0].x, z: route.points[0].z });
    });

    it('rounds positions to whole millimetres', () => {
        const net = squareNetwork();
        const track = routeToTrack(net, resolved(net, LOOP), 4);
        const values = [
            ...track.centerline.flatMap(p => [p.x, p.z]),
            ...track.gates.flatMap(g => [g.x, g.z]),
            ...track.grid.flatMap(g => [g.x, g.z]),
            ...track.hints.flatMap(h => ('x' in h ? [h.x, h.z] : []))
        ];
        // The rounded corners have points off the millimetre grid before rounding
        expect(values.some(v => Math.abs(v - Math.round(v)) > 0.01)).toBe(true);
        for (const v of values) expect(Math.abs(v * 1000 - Math.round(v * 1000))).toBeLessThan(1e-6);
    });

    it('can be driven along its racing line with the phase 2 gate logic: every gate forwards, in order, to the finish', () => {
        const net = squareNetwork();
        const track = asPhase2(routeToTrack(net, resolved(net, LOOP), 4));
        const line = buildRacingLine(track);
        const course = createCourse(track, line);
        const p = createRaceProgress();
        const pts = line.points;
        let tick = 1;
        for (let lap = 0; lap < track.laps + 1 && p.status === 'racing'; lap++) {
            for (let i = 0; i < pts.length && p.status === 'racing'; i++) {
                const a = pts[i], b = pts[(i + 1) % pts.length];
                passGate(p, course, tick++, 0, a.x, a.z, b.x, b.z);
            }
        }
        expect(p.status).toBe('finished');
        expect(p.passed).toBe(track.laps * track.gates.length + 1);
    });

    it('bars both ends of the cross street, across it, as phase 2 barrier rows', () => {
        const net = squareNetwork();
        const track = routeToTrack(net, resolved(net, LOOP), 4);
        const barriers = track.hints.filter(h => h.kind === 'barrier');
        // M1: the cross street leaves southwards (+z, yaw 0), barrier 7 m in
        // (the trim); M2: it leaves northwards (-z, yaw π). 10 m roads
        // without sidewalks or verges.
        expect(barriers).toEqual([
            { kind: 'barrier', x: 100, z: 7, yaw: 0, length: 10 },
            { kind: 'barrier', x: 100, z: 193, yaw: Math.PI, length: 10 }
        ]);
        // The phase 2 race world builds them: boxes across the street
        const boxes = trackColliders(asPhase2(track)).filter(c => c.kind === 'box');
        expect(boxes).toEqual([
            { kind: 'box', x: 100, z: 7, hw: 5, hd: 0.3, top: 1 },
            { kind: 'box', x: 100, z: 193, hw: 5, hd: 0.3, top: 1 }
        ]);
    });

    it('puts a chevron straight on past each corner, facing the car, and an arrow 30 m before it', () => {
        const net = squareNetwork();
        const track = routeToTrack(net, resolved(net, LOOP), 4);
        const chevrons = track.hints.filter(h => h.kind === 'chevron');
        // Four right-hand corners (clockwise on the map); B is reached
        // heading east: the board stands 7 + 3 m past B, facing west
        expect(chevrons).toHaveLength(4);
        for (const c of chevrons) expect(c.kind === 'chevron' && c.dir).toBe('right');
        expect(chevrons).toContainEqual({ kind: 'chevron', x: 210, z: 0, yaw: -1.570796, dir: 'right' });
        // Arrow 30 m before the corner at B (its transition starts at x = 188),
        // pointing south (yaw 0) where the road goes
        const arrows = track.hints.filter(h => h.kind === 'arrow');
        expect(arrows).toHaveLength(4);
        const atB = arrows.find(a => a.kind === 'arrow' && a.z === 0 && a.x > 150)!;
        expect(atB.kind === 'arrow' && atB.x).toBeCloseTo(158, 0);
        expect(atB.kind === 'arrow' && atB.yaw).toBe(0);
    });

    it('keeps the chevron posts 2.5 m clear of the racing line (phase 2 rule)', () => {
        const net = squareNetwork();
        const track = asPhase2(routeToTrack(net, resolved(net, LOOP), 4));
        const line = buildRacingLine(track);
        const posts = trackColliders(track).filter(c => c.kind === 'circle');
        expect(posts).toHaveLength(8);
        for (const post of posts) {
            const nearest = Math.min(...line.points.map(p => Math.hypot(p.x - post.x, p.z - post.z) - (post.kind === 'circle' ? post.r : 0)));
            expect(nearest).toBeGreaterThanOrEqual(2.5);
        }
    });
});

describe('snapYaw and oblique branches', () => {
    it('snaps within the tolerance onto an exact axis, otherwise keeps the yaw', () => {
        const deg = Math.PI / 180;
        expect(snapYaw(0.5 * deg, deg)).toBe(0);
        expect(snapYaw(Math.PI / 2 + 0.9 * deg, deg)).toBe(Math.PI / 2);
        expect(snapYaw(-Math.PI + 0.5 * deg, deg)).toBe(Math.PI);
        expect(snapYaw(1.5 * deg, deg)).toBe(1.5 * deg);
        expect(isAxisYaw(Math.PI / 2)).toBe(true);
        expect(isAxisYaw(-Math.PI)).toBe(true);
        expect(isAxisYaw(0.785398)).toBe(false);
    });

    it('spans the branch\'s road, sidewalks and verges', () => {
        const net = buildRoadNetwork(network(
            [node('w', -100, 0), node('j', 0, 0, 'junction'), node('e', 100, 0), node('s', 0, 100)],
            [edge('we', 'w', 'j'), edge('ej', 'j', 'e'), edge('side', 'j', 's', [], { overrides: { sidewalk: { left: 2, right: 3 }, shoulder: 1 } })]
        ));
        const route = resolved(net, {
            ...LOOP, kind: 'sprint', laps: 1, route: ['we', 'ej'], start: { edge: 'we', s: 60 }, finish: { edge: 'ej', s: 60 }
        });
        // 10 m road + 2 + 3 m sidewalks + 2 × 1 m verge
        expect(junctionBarriers(net, route)).toEqual([{ kind: 'barrier', x: 0, z: 7, yaw: 0, length: 17 }]);
    });

    it('keeps a barrier across a 45° branch oblique, pushed into the branch until it is off the route\'s roadway', () => {
        const net = buildRoadNetwork(network(
            [node('w', -100, 0), node('j', 0, 0, 'junction'), node('e', 100, 0), node('ne', 70, -70)],
            [edge('we', 'w', 'j'), edge('ej', 'j', 'e'), edge('diag', 'j', 'ne')]
        ));
        const route = resolved(net, {
            ...LOOP, kind: 'sprint', laps: 1, route: ['we', 'ej'], start: { edge: 'we', s: 60 }, finish: { edge: 'ej', s: 60 }
        });
        const [barrier] = junctionBarriers(net, route);
        // North-east: forward (sin yaw, cos yaw) = (0.707, -0.707), yaw 3π/4
        expect(barrier).toMatchObject({ kind: 'barrier', yaw: 2.356194, length: 10 });
        expect(barrier.kind === 'barrier' && isAxisYaw(barrier.yaw)).toBe(false);
        // At the trim radius (7 m) its eastern end would stand on the straight
        // route (z > -5.5: half its 10 m width plus the 0.5 m clearance). A
        // row d m into the branch, 10 m long and 0.6 m deep, reaches up to
        // z = -0.707 d + 5 × 0.707 + 0.3 × 0.707 = -0.707 d + 3.748, off the
        // roadway from d = 9.248 / 0.707 = 13.08 m: in 0.5 m steps from 7 m, 13.5 m
        expect(barrier.kind === 'barrier' && Math.hypot(barrier.x, barrier.z)).toBeCloseTo(13.5, 3);
    });
});

describe('routeBends', () => {
    it('finds the four corners of the square with a quarter turn each', () => {
        const net = squareNetwork();
        const bends = routeBends(resolved(net, LOOP), 0.03);
        expect(bends).toHaveLength(4);
        for (const bend of bends) {
            // Right-hand quarter turns: -π/2 = -1.571 over the part of the arc
            // above the curvature limit; the route points every 2 m blur the
            // arc's ends, so a few hundredths are missing
            expect(bend.turn).toBeGreaterThan(-1.6);
            expect(bend.turn).toBeLessThan(-1.45);
            expect(bend.junction).toBe(true);
            expect(bend.to - bend.from).toBeGreaterThan(14);
        }
    });

    it('splits an S-bend into its two halves', () => {
        // A straight east, a left quarter circle of R = 20 up to heading
        // north, a right one back to east, a straight east
        const k = 0.5523 * 20;
        const net = buildRoadNetwork(network(
            [node('s0', -60, 0), node('a', 0, 0, 'joint'), node('m', 20, -20, 'joint'), node('b', 40, -40, 'joint'), node('t', 100, -40)],
            [
                edge('lead', 's0', 'a'),
                { ...edge('first', 'a', 'm'), curve: { type: 'bezier', segments: [{ c1: [k, 0], c2: [20, -20 + k] }] } },
                { ...edge('second', 'm', 'b'), curve: { type: 'bezier', segments: [{ c1: [20, -20 - k], c2: [40 - k, -40] }] } },
                edge('tail', 'b', 't')
            ]
        ));
        const route = resolved(net, {
            ...LOOP, kind: 'sprint', laps: 1, route: ['lead', 'first', 'second', 'tail'],
            start: { edge: 'lead', s: 50 }, finish: { edge: 'tail', s: 30 }
        });
        const bends = routeBends(route, 0.03);
        expect(bends.map(b => Math.sign(b.turn))).toEqual([1, -1]);
        for (const bend of bends) {
            expect(Math.abs(bend.turn)).toBeGreaterThan(1.45);
            expect(Math.abs(bend.turn)).toBeLessThan(1.6);
            expect(bend.junction).toBe(false);
        }
    });
});

describe('routeBends on hand-made route points', () => {
    // routeBends reads only the points (station, curvature, part), whether
    // the route is closed and its length
    const pointsRoute = (curvatures: number[], parts: number[] = []): ResolvedRoute => ({
        points: curvatures.map((curvature, i) => ({ x: 0, z: 0, tx: 1, tz: 0, s: 2 * i, curvature, halfWidth: 5, surface: 0, part: parts[i] ?? 0 })),
        closed: false, length: 2 * (curvatures.length - 1)
    }) as unknown as ResolvedRoute;

    it('splits where the curvature flips sign from one point to the next', () => {
        const bends = routeBends(pointsRoute([0, 0.1, 0.1, -0.1, -0.1, 0]), 0.03);
        // Each half: 2 points of 0.1 over 2 m each = 0.4 rad
        expect(bends).toEqual([
            { from: 2, to: 4, apex: 2, turn: expect.closeTo(0.4, 9), junction: false },
            { from: 6, to: 8, apex: 6, turn: expect.closeTo(-0.4, 9), junction: false }
        ]);
    });

    it('marks a bend that reaches into a junction transition and keeps the sharpest point as apex', () => {
        const bends = routeBends(pointsRoute([0, 0.05, 0.2, 0.05, 0], [0, 0, -1, 1, 1]), 0.03);
        expect(bends).toEqual([{ from: 2, to: 6, apex: 4, turn: expect.closeTo(0.6, 9), junction: true }]);
    });
});

describe('routeRamps', () => {
    it('centres a ramp on its station and turns it onto the axis of its road', () => {
        const net = squareNetwork();
        const route = resolved(net, { ...LOOP, ramps: [{ edge: 'bc', s: 100, length: 12, height: 2 }] });
        // bc runs south from B: yaw 0, 10 m road → 8 m ramp
        expect(routeRamps(route, route.track)).toEqual([{ x: 200, z: 100, yaw: 0, width: 8, length: 12, height: 2 }]);
        // Driven backwards (north) the ramp faces north
        const back = resolved(net, {
            ...LOOP, kind: 'sprint', laps: 1, route: ['-bc', '-ab2'], start: { edge: 'bc', s: 150 }, finish: { edge: 'ab2', s: 50 },
            ramps: [{ edge: 'bc', s: 100, length: 12, height: 2, width: 6 }]
        });
        expect(routeRamps(back, back.track)[0]).toMatchObject({ yaw: Math.PI, width: 6 });
    });
});
