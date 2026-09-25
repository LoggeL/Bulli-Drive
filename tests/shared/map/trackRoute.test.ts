import { describe, expect, it } from 'vitest';
import type { TrackRoute } from '../../../src/shared/map/mapFiles.js';
import { buildRoadNetwork, type RoadNetwork } from '../../../src/shared/map/roadNetwork.js';
import {
    gateAllowed, GRID_FIRST, GRID_SLOTS, GRID_STEP, junctionAt, resolveRoute, routePointAt, yawOf,
    type ResolvedRoute
} from '../../../src/shared/map/trackRoute.js';
import { edge, network, node } from './fixtures.js';

// Race routes over a hand-built network (docs/phase-3-design.md, 13.2 and
// 15): a 200 m square A-B-C-D (north edge z = 0, east edge x = 200) with a
// cross street M1-M2 at x = 100. All roads are 10 m wide, so every junction
// trims 5 + 2 = 7 m. Expected stations and positions are worked out by hand
// from that geometry.

const TRIM = 7;
const HALF = 5;

function squareNetwork(extra: Parameters<typeof edge>[4] = {}): RoadNetwork {
    return buildRoadNetwork(network(
        [
            node('a', 0, 0, 'junction'), node('m1', 100, 0, 'junction'), node('b', 200, 0, 'junction'),
            node('c', 200, 200, 'junction'), node('m2', 100, 200, 'junction'), node('d', 0, 200, 'junction')
        ],
        [
            edge('ab1', 'a', 'm1'), edge('ab2', 'm1', 'b'), edge('bc', 'b', 'c', [], extra),
            edge('cd1', 'c', 'm2'), edge('cd2', 'm2', 'd'), edge('da', 'd', 'a'),
            edge('cross', 'm1', 'm2')
        ]
    ));
}

function track(over: Partial<TrackRoute>): TrackRoute {
    return {
        id: 'test', name: 'Test', kind: 'circuit', laps: 3, trackVersion: 1,
        route: ['ab1', 'ab2', 'bc', 'cd1', 'cd2', 'da'],
        start: { edge: 'ab1', s: 60 }, gateSpacing: 1000, minCornerSpeed: 10,
        ...over
    };
}

function resolved(net: RoadNetwork, over: Partial<TrackRoute> = {}): ResolvedRoute {
    const result = resolveRoute(net, track(over));
    if (!result.ok) throw new Error(result.errors.join('\n'));
    return result.route;
}

function errorsOf(net: RoadNetwork, over: Partial<TrackRoute>): string[] {
    const result = resolveRoute(net, track(over));
    return result.ok ? [] : result.errors;
}

describe('resolveRoute: checks of 13.2, step 1', () => {
    it('reports an unknown edge, an edge used twice and a gap with the IDs', () => {
        const net = squareNetwork();
        expect(errorsOf(net, { route: ['ab1', 'nope'] })).toEqual(['unknown edge nope']);
        expect(errorsOf(net, { kind: 'sprint', finish: { edge: 'ab2', s: 50 }, route: ['ab1', 'ab2', 'ab2'] }))
            .toContain('edge ab2 appears twice');
        expect(errorsOf(net, { kind: 'sprint', finish: { edge: 'bc', s: 50 }, route: ['ab1', 'bc'] }))
            .toEqual(['gap between ab1 (ends at m1) and bc (starts at b)']);
    });

    it('refuses a circuit that does not end where it starts', () => {
        expect(errorsOf(squareNetwork(), { route: ['ab1', 'ab2', 'bc'] }))
            .toEqual(['circuit is not closed: ends at c, starts at a']);
    });

    it('refuses to drive a one-way edge backwards, but forwards is fine', () => {
        const net = squareNetwork({ oneWay: true });
        expect(errorsOf(net, { route: ['-da', '-cd2', '-cd1', '-bc', '-ab2', '-ab1'], start: { edge: 'da', s: 100 } }))
            .toEqual(['edge bc is one-way and cannot be driven backwards']);
        expect(errorsOf(net, {})).toEqual([]);
    });

    it('refuses a route that passes a node twice (it would cross itself)', () => {
        // A → M1 → M2 → C → B → M1: M1 twice
        expect(errorsOf(squareNetwork(), {
            kind: 'sprint', laps: 1, route: ['ab1', 'cross', '-cd1', '-bc', '-ab2'],
            start: { edge: 'cross', s: 100 }, finish: { edge: 'bc', s: 100 }
        })).toEqual(['passes node m1 2 times (the route crosses itself)']);
    });

    it('refuses start and finish in a junction, off the route, or a finish before the start', () => {
        const net = squareNetwork();
        // ab1 keeps s = 7 .. 93 between the trims at A and M1
        expect(errorsOf(net, { start: { edge: 'ab1', s: 95 } }))
            .toEqual(['start at s = 95 on ab1 lies in a junction or beyond the edge']);
        expect(errorsOf(net, { start: { edge: 'cross', s: 50 } }))
            .toEqual(['start on edge cross, which is not on the route']);
        expect(errorsOf(net, {
            kind: 'sprint', laps: 1, route: ['ab1', 'ab2', 'bc'], start: { edge: 'bc', s: 100 }, finish: { edge: 'ab2', s: 60 }
        })).toEqual([expect.stringMatching(/^finish \(160 m\) is not after the start \(29[5-8] m\)$/)]);
    });

    it('needs room for the grid behind the start of a sprint', () => {
        // Sprint from A: route station = s, slot k stands 6 + 4·k m behind
        // the start, so at s = 28 slot 7 (k = 6) reaches -2 m and slot 8 -6 m
        expect(errorsOf(squareNetwork(), {
            kind: 'sprint', laps: 1, route: ['ab1', 'ab2'], start: { edge: 'ab1', s: 28 }, finish: { edge: 'ab2', s: 60 }
        })).toEqual(['grid slot 7 needs 2 m more route before the start', 'grid slot 8 needs 6 m more route before the start']);
    });
});

describe('resolveRoute: centre line (13.2, step 2)', () => {
    it('keeps the edges between the junction trims and joins them through each junction', () => {
        const route = resolved(squareNetwork());
        expect(route.closed).toBe(true);
        // Kept straights: 4 × (100 - 14) + 2 × (200 - 14) = 716 m; straight
        // through M1 and M2: 14 m each. A 90° corner joins two trimmed ends
        // 7√2 m apart with a cubic whose handles are a third of that, so its
        // length lies between the chord (9.90 m) and the control polygon
        // (2 · 3.30 + √2 · (7 - 3.30) = 11.83 m).
        const chord = TRIM * Math.SQRT2;
        const handle = chord / 3;
        const polygon = 2 * handle + Math.hypot(TRIM - handle, TRIM - handle);
        expect(route.length).toBeGreaterThan(716 + 28 + 4 * chord);
        expect(route.length).toBeLessThan(716 + 28 + 4 * polygon);
        // Resampled every 2 m around the closed loop
        const steps = route.points.map((p, i) => i ? p.s - route.points[i - 1].s : 0).slice(1);
        expect(Math.min(...steps)).toBeCloseTo(route.length / route.points.length, 9);
        expect(Math.max(...steps)).toBeCloseTo(route.length / route.points.length, 9);
        expect(route.length / route.points.length).toBeCloseTo(2, 1);
    });

    it('starts the lap after the first junction and follows the edges in driving direction', () => {
        const route = resolved(squareNetwork());
        // Station 0 = ab1 at s = 7, heading east
        expect(route.points[0].x).toBeCloseTo(TRIM, 6);
        expect(route.points[0].z).toBeCloseTo(0, 6);
        expect(route.points[0].tx).toBeCloseTo(1, 6);
        // Station 50 on ab1: x = 57; the east side (bc) runs south (+z)
        const p = routePointAt(route, 50);
        expect(p.x).toBeCloseTo(57, 6);
        expect(p.z).toBeCloseTo(0, 6);
        const east = route.points.find(q => q.x > 199 && q.z > 90 && q.z < 110)!;
        expect(east.tz).toBeCloseTo(1, 6);
        // Right-hand corners of a clockwise lap (on screen) bend to the right:
        // negative curvature, as the left normal points outwards
        const corner = route.points.reduce((a, b) => (Math.abs(b.curvature) > Math.abs(a.curvature) ? b : a));
        expect(corner.curvature).toBeLessThan(0);
    });

    it('maps start stations on edges driven backwards from the edge start', () => {
        // Sprint C → B → M1 → A: bc and the ab edges driven backwards. bc at
        // s = 50 (measured from B) is 150 m from C, the route start.
        const route = resolved(squareNetwork(), {
            kind: 'sprint', laps: 1, route: ['-bc', '-ab2', '-ab1'],
            start: { edge: 'bc', s: 50 }, finish: { edge: 'ab1', s: 40 }
        });
        expect(route.startS).toBeCloseTo(150, 6);
        const start = routePointAt(route, route.startS);
        expect(start.x).toBeCloseTo(200, 6);
        expect(start.z).toBeCloseTo(50, 6);
        expect(start.tz).toBeCloseTo(-1, 6);
        expect(route.closed).toBe(false);
        // Heading north the right lane is east: pole at x = 200 + 2.5, 6 m
        // behind the start, i.e. further south
        expect(route.grid[0].x).toBeCloseTo(200 + HALF / 2, 6);
        expect(route.grid[0].z).toBeCloseTo(50 + GRID_FIRST, 6);
        expect(route.grid[1].x).toBeCloseTo(200 - HALF / 2, 6);
        // A sprint ends exactly at its last node (A)
        const last = route.points[route.points.length - 1];
        expect(last.x).toBeCloseTo(0, 6);
        expect(last.z).toBeCloseTo(0, 6);
        expect(last.s).toBeCloseTo(route.length, 9);
    });

    it('keeps the resampled tangents unit length, also through the corners', () => {
        const route = resolved(squareNetwork());
        for (const p of route.points) expect(Math.hypot(p.tx, p.tz)).toBeCloseTo(1, 9);
    });

    it('refuses an edge shorter than the junction trims at its two ends', () => {
        const net = buildRoadNetwork(network(
            [node('o', -100, 0), node('p', 0, 0, 'junction'), node('q', 10, 0, 'junction'), node('r', 110, 0),
                node('p2', 0, 100), node('q2', 10, -100)],
            [edge('op', 'o', 'p'), edge('pq', 'p', 'q'), edge('qr', 'q', 'r'), edge('pp2', 'p', 'p2'), edge('qq2', 'q', 'q2')]
        ));
        // pq is 10 m, the trims take 7 + 7
        expect(errorsOf(net, { kind: 'sprint', route: ['op', 'pq', 'qr'], start: { edge: 'op', s: 50 }, finish: { edge: 'qr', s: 50 } }))
            .toEqual(['edge pq is shorter than the junctions at its ends take']);
    });
});

describe('routePointAt', () => {
    it('interpolates between the points and wraps around a circuit', () => {
        const route = resolved(squareNetwork());
        expect(routePointAt(route, 51).x).toBeCloseTo(58, 6);
        expect(routePointAt(route, route.length + 50).x).toBeCloseTo(57, 6);
        // 30 m before the lap start: on da (x = 0, heading north), 30 - T m
        // before its trimmed end at z = 7, T = the corner at A (9.9 .. 11.8 m)
        const before = routePointAt(route, -30);
        expect(before.x).toBeCloseTo(0, 6);
        expect(before.z).toBeGreaterThan(7 + 30 - 11.83);
        expect(before.z).toBeLessThan(7 + 30 - 9.9);
        expect(before.tz).toBeCloseTo(-1, 6);
        // Inside a corner the tangent stays a unit vector
        const corner = route.points.reduce((a, b) => (Math.abs(b.curvature) > Math.abs(a.curvature) ? b : a));
        const mid = routePointAt(route, corner.s + 0.7);
        expect(Math.hypot(mid.tx, mid.tz)).toBeCloseTo(1, 9);
    });

    it('clamps a sprint to its first and last point', () => {
        const route = resolved(squareNetwork(), {
            kind: 'sprint', laps: 1, route: ['ab1', 'ab2'], start: { edge: 'ab1', s: 50 }, finish: { edge: 'ab2', s: 60 }
        });
        expect(routePointAt(route, -5).x).toBeCloseTo(0, 9);
        expect(routePointAt(route, route.length + 5).x).toBeCloseTo(200, 9);
    });
});

describe('resolveRoute: gates and grid (13.2, steps 3 and 4)', () => {
    it('puts a gate 25 m after each junction where the route could turn, facing the driving direction', () => {
        const route = resolved(squareNetwork());
        // Start/finish at ab1 s = 60 (station 53), then after M1 and after
        // M2; the corners A to D have no other branch
        expect(route.gates.map(g => g.visual)).toEqual(['startFinish', 'arch', 'arch']);
        const [start, afterM1, afterM2] = route.gates;
        expect(start.x).toBeCloseTo(60, 6);
        expect(start.yaw).toBeCloseTo(Math.PI / 2, 6);
        // M1's trim ends at x = 107, the gate stands 25 m on (the first
        // station of the 2 m search that is clear of the 25 m): x = 132..134
        expect(afterM1.x).toBeGreaterThanOrEqual(107 + 25 - 1e-6);
        expect(afterM1.x).toBeLessThanOrEqual(107 + 27 + 1e-6);
        expect(afterM1.z).toBeCloseTo(0, 6);
        expect(afterM1.yaw).toBeCloseTo(Math.PI / 2, 6);
        // M2 is passed westwards: trim end x = 93, gate at x = 66..68, heading -x
        expect(afterM2.x).toBeLessThanOrEqual(93 - 25 + 1e-6);
        expect(afterM2.x).toBeGreaterThanOrEqual(93 - 27 - 1e-6);
        expect(afterM2.z).toBeCloseTo(200, 6);
        expect(afterM2.yaw).toBeCloseTo(-Math.PI / 2, 6);
        // Road width + 2 m
        for (const gate of route.gates) expect(gate.width).toBe(2 * HALF + 2);
        // Gates in driving order
        const stations = route.gates.map(g => g.s);
        expect(stations[1]).toBeGreaterThan(stations[0]);
        expect(stations[2]).toBeGreaterThan(stations[1]);
    });

    it('fills long stretches without junctions every gateSpacing metres', () => {
        const few = resolved(squareNetwork()).gates.length;
        const many = resolved(squareNetwork(), { gateSpacing: 100 }).gates;
        expect(many.length).toBeGreaterThan(few);
        const stations = many.map(g => g.s).sort((a, b) => a - b);
        const lap = resolved(squareNetwork()).length;
        const gaps = stations.map((s, i) => (i + 1 < stations.length ? stations[i + 1] : stations[0] + lap) - s);
        // No gap longer than the spacing plus the search step for an allowed station
        expect(Math.max(...gaps)).toBeLessThanOrEqual(100 + 25);
    });

    it('records the branches the route does not use at each junction it passes', () => {
        const route = resolved(squareNetwork());
        const net = squareNetwork();
        const cross = net.edgeById.get('cross')!.index;
        const withBranches = route.junctions.filter(j => j.others.length > 0);
        expect(withBranches.map(j => j.node.id)).toEqual(['m1', 'm2']);
        expect(withBranches[0].others).toEqual([{ edge: cross, atStart: true }]);
        expect(withBranches[1].others).toEqual([{ edge: cross, atStart: false }]);
    });

    it('lines the grid up behind the start on alternating lanes, pole on the right', () => {
        const route = resolved(squareNetwork());
        expect(route.grid).toHaveLength(GRID_SLOTS);
        route.grid.forEach((slot, k) => {
            // Heading east along z = 0: the right lane is south (+z)
            expect(slot.x).toBeCloseTo(60 - GRID_FIRST - GRID_STEP * k, 6);
            expect(slot.z).toBeCloseTo(k % 2 === 0 ? HALF / 2 : -HALF / 2, 6);
            expect(slot.yaw).toBeCloseTo(Math.PI / 2, 6);
        });
    });

    it('places a sprint\'s gates up to the finish and drops one too close to it', () => {
        // Start ab1 s = 50 (station 50), finish bc s = 150 = (200 | 150),
        // heading south; M2 lies beyond the finish, B has no other branch
        const sprint = resolved(squareNetwork(), {
            kind: 'sprint', laps: 1, route: ['ab1', 'ab2', 'bc', 'cd1', 'cd2'],
            start: { edge: 'ab1', s: 50 }, finish: { edge: 'bc', s: 150 }
        });
        expect(sprint.gates.map(g => g.visual)).toEqual(['start', 'arch', 'finish']);
        const finish = sprint.gates[2];
        expect(finish.x).toBeCloseTo(200, 6);
        expect(finish.z).toBeCloseTo(150, 6);
        expect(finish.yaw).toBeCloseTo(0, 6);
        expect(sprint.gates[1].x).toBeGreaterThanOrEqual(132 - 1e-6);
        expect(sprint.gates[1].x).toBeLessThanOrEqual(134 + 1e-6);
        // Finish at ab2 s = 40 (station 140): the gate after M1 (125 .. 127)
        // would stand less than 20 m before it
        const short = resolved(squareNetwork(), {
            kind: 'sprint', laps: 1, route: ['ab1', 'ab2'], start: { edge: 'ab1', s: 50 }, finish: { edge: 'ab2', s: 40 }
        });
        expect(short.gates.map(g => g.visual)).toEqual(['start', 'finish']);
    });

    it('keeps every filled gate on an allowed station, in driving order, 20 m apart', () => {
        const route = resolved(squareNetwork(), { gateSpacing: 100 });
        const rel = route.gates.map(g => (g.s - route.startS + route.length) % route.length);
        for (let i = 1; i < rel.length; i++) {
            expect(rel[i]).toBeGreaterThan(rel[i - 1] + 20 - 1e-9);
            expect(gateAllowed(route, route.gates[i].s)).toBe(true);
        }
    });

    it('refuses a start in the junction at the beginning of an edge and a finish just before a junction', () => {
        const net = squareNetwork();
        expect(errorsOf(net, { start: { edge: 'ab2', s: 3 } }))
            .toEqual(['start at s = 3 on ab2 lies in a junction or beyond the edge']);
        // Finish ab2 s = 88: station 107 + 81 = 188, 5 m before B's corner
        expect(errorsOf(net, {
            kind: 'sprint', laps: 1, route: ['ab1', 'ab2', 'bc'], start: { edge: 'ab1', s: 50 }, finish: { edge: 'ab2', s: 88 }
        })).toEqual(['finish at 188 m is in a junction or a hairpin']);
    });

    it('refuses a grid slot inside a junction', () => {
        // Start at ab2 s = 30: station 100 + 30 - 7 = 123, 23 m after M1's
        // transition (stations 86 .. 100). Slots 6 to 8 stand at 97, 93, 89.
        expect(errorsOf(squareNetwork(), { start: { edge: 'ab2', s: 30 } })).toEqual([
            'start at 123 m is in or next to a junction or in a hairpin',
            'grid slot 6 lies in junction m1', 'grid slot 7 lies in junction m1', 'grid slot 8 lies in junction m1'
        ]);
    });
});

describe('gateAllowed, junctionAt, yawOf', () => {
    it('keeps gates out of junctions and 25 m after them, 10 m before them', () => {
        const route = resolved(squareNetwork());
        // M1 transition: stations 86 .. 100
        expect(junctionAt(route, 90)?.node.id).toBe('m1');
        expect(junctionAt(route, 110)).toBeNull();
        expect(gateAllowed(route, 90)).toBe(false);
        expect(gateAllowed(route, 120)).toBe(false);
        expect(gateAllowed(route, 127)).toBe(true);
        // 10 m before M1: stations 76 .. 86
        expect(gateAllowed(route, 78)).toBe(false);
        expect(gateAllowed(route, 70)).toBe(true);
    });

    it('keeps gates out of hairpins (curvature above 1/30 m within ±4 m) and off the ends of a sprint', () => {
        // One edge: 100 m east, a half circle of R = 20 (two Bézier quarter
        // circles, bend from s = 100 to s ≈ 162.8), 100 m back west
        const k = 0.5523 * 20;
        const hairpin = buildRoadNetwork(network([node('u0', 0, 0), node('u1', 0, 40)], [edge('u', 'u0', 'u1', [], {
            curve: {
                type: 'bezier', segments: [
                    { c1: [33, 0], c2: [67, 0], to: [100, 0] },
                    { c1: [100 + k, 0], c2: [120, 20 - k], to: [120, 20] },
                    { c1: [120, 20 + k], c2: [100 + k, 40], to: [100, 40] },
                    { c1: [67, 40], c2: [33, 40] }
                ]
            }
        })]));
        const route = resolved(hairpin, { kind: 'sprint', laps: 1, route: ['u'], start: { edge: 'u', s: 60 }, finish: { edge: 'u', s: 250 } });
        expect(gateAllowed(route, 50)).toBe(true);
        expect(gateAllowed(route, 130)).toBe(false);
        // 2 m before and 2 m after the bend: the ±4 m window reaches into it
        // (the route points every 2 m blur the step at s = 100 over 2 m)
        expect(gateAllowed(route, 98)).toBe(false);
        expect(gateAllowed(route, 165)).toBe(false);
        expect(gateAllowed(route, 175)).toBe(true);
        expect(gateAllowed(route, -1)).toBe(false);
        expect(gateAllowed(route, route.length + 1)).toBe(false);
        expect(errorsOf(hairpin, { kind: 'sprint', laps: 1, route: ['u'], start: { edge: 'u', s: 130 }, finish: { edge: 'u', s: 250 } }))
            .toEqual(['start at 130 m is in or next to a junction or in a hairpin']);
    });

    it('turns a direction into the sim yaw: forward = (sin yaw, cos yaw), rounded to a micro-radian', () => {
        expect(yawOf(0, 1)).toBe(0);
        // π/2 = 1.5707963… and π = 3.1415926…, rounded to 6 decimals
        expect(yawOf(1, 0)).toBe(1.570796);
        expect(yawOf(-1, 0)).toBe(-1.570796);
        expect(Math.abs(yawOf(0, -1))).toBe(3.141593);
        // 45°: 0.7853981… → 0.785398
        expect(yawOf(1, 1)).toBe(0.785398);
    });
});
