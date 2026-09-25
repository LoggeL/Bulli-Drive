// Progress of one racer (docs/phase-2-design.md, 5.1, 9 and 10): gates
// passed, lap, lap and finish times, the position on the racing line, the
// remaining distance to the next gate, wrong-way and missed-gate state.
// The server runs it for every racer after each stepWorld; the functions
// are pure apart from writing into the progress object.

import type { VehicleState } from '../sim/types.js';
import { placeVehicle } from '../sim/vehicle.js';
import type { SimWorld } from '../world/colliders.js';
import { createProjection, lineDelta, pointAt, projectGlobal, projectNear, type Polyline, type Projection } from './geometry.js';
import { crossGate, crossingTicks, gateArcLengths } from './gates.js';
import { racingLine } from './racingLine.js';
import {
    MISSED_GATE_DISTANCE, OFF_LINE_DISTANCE, RESET_BEFORE_GATE, WRONG_WAY_BACKTRACK, WRONG_WAY_DOT, WRONG_WAY_ENTER_TICKS,
    WRONG_WAY_EXIT_DOT, WRONG_WAY_EXIT_TICKS, WRONG_WAY_MIN_SPEED
} from './rules.js';
import type { RacerStatus, TrackDef } from './types.js';

/** A track with its racing line and each gate's place on it, built once per track. */
export interface Course {
    track: TrackDef;
    line: Polyline;
    // Arc length of each gate on the line
    gateS: number[];
    // Distance along the line from the gate before to gate k (circuit: gate
    // n-1 before gate 0; sprint: the line's start before gate 0)
    legLength: number[];
    // Surface ID under each point of the line (SURFACE in map/types.ts),
    // null where the course was built without its world (the bots plan
    // their speed with it, docs/phase-3-design.md, 8.1)
    surfaces: Uint8Array | null;
}

/**
 * A track's course. With the surface of the world it is raced in (the
 * race world's surfaceAt), the course knows the surface under every point
 * of its line.
 */
export function createCourse(track: TrackDef, line: Polyline = racingLine(track), surfaceAt?: (x: number, z: number) => number): Course {
    const gateS = gateArcLengths(track, line);
    const n = gateS.length;
    const legLength = gateS.map((s, k) => {
        if (k > 0) return s - gateS[k - 1];
        return track.kind === 'circuit' ? s - gateS[n - 1] + line.length : s;
    });
    const surfaces = surfaceAt ? Uint8Array.from(line.points, p => surfaceAt(p.x, p.z)) : null;
    return { track, line, gateS, legLength, surfaces };
}

export interface RaceProgress {
    passed: number;             // gate crossings counted
    lap: number;
    status: RacerStatus;
    gateTimes: number[];        // float ticks since startTick, one per crossing
    lapTimes: number[];
    bestLap: number | null;
    finishTicks: number | null;
    // Racing line: projection hint (-1 = search globally), arc length, distance
    lineIndex: number;
    sLine: number;
    lineDist: number;
    // Distance along the line to the next gate; negative once past it.
    // Off the line (> OFF_LINE_DISTANCE) the straight distance to the gate.
    remaining: number;
    // Farthest progress along the line since the last gate (m from that
    // gate), for the backtrack test of the wrong-way rule
    maxSSinceGate: number;
    wrongWay: boolean;
    wrongWayTicks: number;      // ticks the entry condition has held
    rightWayTicks: number;      // ticks the exit condition has held
    missedGate: boolean;
}

export function createRaceProgress(): RaceProgress {
    return {
        passed: 0, lap: 1, status: 'racing',
        gateTimes: [], lapTimes: [], bestLap: null, finishTicks: null,
        lineIndex: -1, sLine: 0, lineDist: 0, remaining: 0,
        maxSSinceGate: -Infinity,
        wrongWay: false, wrongWayTicks: 0, rightWayTicks: 0,
        missedGate: false
    };
}

/** Crossings needed to finish: circuit laps · n + 1 (the first starts lap 1), sprint n. */
export function finishPassed(track: TrackDef): number {
    return track.kind === 'circuit' ? track.laps * track.gates.length + 1 : track.gates.length;
}

/** Index of the gate that counts next, or -1 once the racer has finished. */
export function nextGateIndex(track: TrackDef, passed: number): number {
    if (passed >= finishPassed(track)) return -1;
    return track.kind === 'circuit' ? passed % track.gates.length : passed;
}

/** Lap shown for a crossing count: circuit min(laps, floor((passed - 1) / n) + 1), lap 1 before the first; sprint 1. */
export function lapFor(track: TrackDef, passed: number): number {
    if (track.kind === 'sprint' || passed < 1) return 1;
    return Math.min(track.laps, Math.floor((passed - 1) / track.gates.length) + 1);
}

/**
 * Counts a crossing of the next gate in tick T (move from (x0, z0) to
 * (x1, z1)). Returns the crossing's race time in float ticks, or -1.
 * Lap times are the differences between crossings of gates[0]; lap 1 runs
 * from startTick. The last required crossing finishes the race.
 */
export function passGate(
    p: RaceProgress, course: Course, tick: number, startTick: number,
    x0: number, z0: number, x1: number, z1: number
): number {
    if (p.status !== 'racing') return -1;
    const track = course.track;
    const k = nextGateIndex(track, p.passed);
    if (k < 0) return -1;
    const t = crossGate(track.gates[k], x0, z0, x1, z1);
    if (t < 0) return -1;
    const time = crossingTicks(tick, t, startTick);
    p.gateTimes.push(time);
    p.passed++;
    p.lap = lapFor(track, p.passed);
    const n = track.gates.length;
    const lapEnds = track.kind === 'circuit' ? k === 0 && p.passed > 1 : p.passed === n;
    if (lapEnds) {
        const lapStart = p.lapTimes.length === 0 ? 0 : p.gateTimes[p.lapTimes.length * n];
        const lapTime = time - lapStart;
        p.lapTimes.push(lapTime);
        if (p.bestLap === null || lapTime < p.bestLap) p.bestLap = lapTime;
    }
    p.maxSSinceGate = -Infinity;
    p.missedGate = false;
    if (p.passed === finishPassed(track)) {
        p.finishTicks = time;
        p.status = 'finished';
        p.wrongWay = false;
        p.wrongWayTicks = p.rightWayTicks = 0;
        p.remaining = 0;
    }
    return time;
}

const projection: Projection = createProjection();

/**
 * Projects the car onto the racing line (windowed around the last index,
 * globally after a teleport, nearest to the last progress) and updates the
 * remaining distance to the next gate, the backtrack maximum and the
 * missed-gate flag.
 */
export function trackLine(p: RaceProgress, course: Course, x: number, z: number, teleported: boolean): Projection {
    const line = course.line;
    if (teleported || p.lineIndex < 0) projectGlobal(line, x, z, projection, p.lineIndex < 0 ? undefined : p.sLine);
    else projectNear(line, x, z, p.lineIndex, projection);
    p.lineIndex = projection.index;
    p.sLine = projection.s;
    p.lineDist = projection.dist;
    const k = nextGateIndex(course.track, p.passed);
    if (k < 0) {
        p.remaining = 0;
        return projection;
    }
    const gate = course.track.gates[k];
    const leg = course.legLength[k];
    // Along the line to the gate; on a circuit taken in the window centred
    // on this leg, so a car just past either gate reads correctly
    let along = course.gateS[k] - p.sLine;
    if (line.closed) along = leg / 2 + lineDelta(line, p.sLine, course.gateS[k] - leg / 2);
    const onLine = projection.dist <= OFF_LINE_DISTANCE;
    p.remaining = onLine ? along : Math.hypot(gate.x - x, gate.z - z);
    if (onLine) {
        const sinceGate = leg - along;
        if (sinceGate > p.maxSSinceGate) p.maxSSinceGate = sinceGate;
    }
    p.missedGate = onLine && along < -MISSED_GATE_DISTANCE;
    return projection;
}

/**
 * Wrong-way hysteresis (10.1). Enters after WRONG_WAY_ENTER_TICKS in a row
 * of either driving against the line (speed >= WRONG_WAY_MIN_SPEED and
 * v̂ · t̂ < WRONG_WAY_DOT) or having fallen back more than
 * WRONG_WAY_BACKTRACK along the line since the last gate. Leaves after
 * WRONG_WAY_EXIT_TICKS of v̂ · t̂ > WRONG_WAY_EXIT_DOT at speed, or on a
 * reset; leaving restarts the backtrack maximum where the car is, so a car
 * that turned round is not caught again by the distance it lost.
 */
export function updateWrongWay(p: RaceProgress, course: Course, tx: number, tz: number, vx: number, vz: number, reset: boolean): void {
    if (p.status !== 'racing' || reset) {
        p.wrongWay = false;
        p.wrongWayTicks = p.rightWayTicks = 0;
        if (reset) p.maxSSinceGate = -Infinity;
        return;
    }
    const speed = Math.hypot(vx, vz);
    const dot = speed > 0 ? (vx * tx + vz * tz) / speed : 0;
    const fast = speed >= WRONG_WAY_MIN_SPEED;
    const k = nextGateIndex(course.track, p.passed);
    // Progress since the last gate along the line; unknown off the line
    const sinceGate = k >= 0 && p.lineDist <= OFF_LINE_DISTANCE ? course.legLength[k] - p.remaining : NaN;
    if (!p.wrongWay) {
        const backtracked = p.maxSSinceGate - sinceGate > WRONG_WAY_BACKTRACK;
        p.wrongWayTicks = (fast && dot < WRONG_WAY_DOT) || backtracked ? p.wrongWayTicks + 1 : 0;
        if (p.wrongWayTicks >= WRONG_WAY_ENTER_TICKS) {
            p.wrongWay = true;
            p.rightWayTicks = 0;
        }
        return;
    }
    p.rightWayTicks = fast && dot > WRONG_WAY_EXIT_DOT ? p.rightWayTicks + 1 : 0;
    if (p.rightWayTicks >= WRONG_WAY_EXIT_TICKS) {
        p.wrongWay = false;
        p.wrongWayTicks = 0;
        p.maxSSinceGate = Number.isNaN(sinceGate) ? -Infinity : sinceGate;
    }
}

/**
 * One tick of a racer's progress after stepWorld: gate test for the move
 * p0 -> p1 (skipped in a tick with a teleport or sim reset), then line
 * tracking and the wrong-way rule. Returns the crossing time or -1.
 */
export function advanceProgress(
    p: RaceProgress, course: Course, tick: number, startTick: number,
    x0: number, z0: number, x1: number, z1: number, vx: number, vz: number, teleported: boolean
): number {
    const time = teleported ? -1 : passGate(p, course, tick, startTick, x0, z0, x1, z1);
    if (p.status !== 'racing') return time;
    const hit = trackLine(p, course, x1, z1, teleported);
    updateWrongWay(p, course, hit.tx, hit.tz, vx, vz, teleported);
    return time;
}

const resetScratch: Projection = createProjection();

/**
 * The server's check of a reset onto the racing line (10.3): the sim puts
 * a reset car on the nearest point of the line, which may lie past the
 * next gate (a shortcut over a parallel leg). Then the car goes back to
 * RESET_BEFORE_GATE before that gate, facing along the line, at rest.
 * Returns whether it moved the car. The room and the ghost replay run it
 * in the same place of the tick.
 */
export function resetBeforeNextGate(p: RaceProgress, course: Course, s: VehicleState, world: SimWorld): boolean {
    if (p.status !== 'racing') return false;
    const k = nextGateIndex(course.track, p.passed);
    if (k < 0) return false;
    const line = course.line;
    const at = projectGlobal(line, s.x, s.z, resetScratch).s;
    const gateS = course.gateS[k];
    const past = line.closed ? lineDelta(line, gateS, at) > 0 : at > gateS;
    if (!past) return false;
    const back = pointAt(line, gateS - RESET_BEFORE_GATE, resetScratch);
    placeVehicle(s, world, back.x, back.z, Math.atan2(back.tx, back.tz));
    return true;
}

/**
 * E2E only (docs/phase-2-design.md, 20.3): a car put at (x, z) by
 * debugPlace counts every gate before that point on the line as passed,
 * without times (NaN), so a test can finish a race right away. Never
 * takes gates away. Only gates of the first lap count, so the lap stays 1.
 */
export function skipToPoint(p: RaceProgress, course: Course, x: number, z: number): void {
    if (p.status !== 'racing') return;
    const at = projectGlobal(course.line, x, z, resetScratch).s;
    let passed = 0;
    while (passed < course.gateS.length && course.gateS[passed] < at && passed + 1 < finishPassed(course.track)) passed++;
    while (p.passed < passed) {
        p.gateTimes.push(NaN);
        p.passed++;
    }
    p.lineIndex = -1;
    p.maxSSinceGate = -Infinity;
    p.missedGate = false;
}
