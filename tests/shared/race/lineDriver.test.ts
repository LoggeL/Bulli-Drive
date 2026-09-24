import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../../src/shared/math/rng.js';
import { raceInputFilter } from '../../../src/shared/race/inputFilter.js';
import { launchResult } from '../../../src/shared/race/launch.js';
import { BOT_SKILLS, EVADE_OFFSET, LineDriver } from '../../../src/shared/race/lineDriver.js';
import { advanceProgress, createCourse, createRaceProgress, type Course } from '../../../src/shared/race/progress.js';
import { createRaceWorld } from '../../../src/shared/race/raceWorld.js';
import { buildRacingLine } from '../../../src/shared/race/racingLine.js';
import { DOWNTOWN_LOOP, HILL_SPRINT } from '../../../src/shared/race/tracks/index.js';
import type { BotLevel, TrackDef } from '../../../src/shared/race/types.js';
import { BTN_BOOST, BTN_RESET } from '../../../src/shared/sim/constants.js';
import { createSimCar, spawnVehicle } from '../../../src/shared/sim/vehicle.js';
import { stepWorld } from '../../../src/shared/sim/world.js';
import { FLAT_TERRAIN } from '../../../src/shared/sim/scenarios.js';
import { createSimWorld, type SimWorld } from '../../../src/shared/world/colliders.js';
import { createMapData } from '../../../src/shared/world/mapData.js';

// The race bots' driver (docs/phase-2-design.md, 14 and 20.1) in Node on
// the race worlds of both tracks, a Bulli from grid slot 0. Bounds from the
// track: a lap of the Downtown Loop is 767 m, the Hill Sprint 732 m; at the
// Bulli's 35 m/s top speed that is 22 s and 21 s at the very least, and
// every corner costs; order of the levels instead of exact times.

const map = createMapData();
const worlds = new Map<TrackDef, SimWorld>();
function worldFor(track: TrackDef): SimWorld {
    let world = worlds.get(track);
    if (!world) worlds.set(track, world = createRaceWorld(map, track));
    return world;
}

const START = 60;

interface Run {
    finishTicks: number | null;
    firstLap: number | null;
    resets: number;
    maxLineDistance: number;
    boosted: boolean;
    topSpeed: number;
    offsetMin: number;
    offsetMax: number;
}

// One bot alone from grid slot 0 until the finish (or the first lap);
// meter: the boost meter at the start (alone, nothing fills it)
function race(track: TrackDef, level: BotLevel, seed: number, laps = 1, meter = 0): Run {
    const world = worldFor(track);
    // Built here, not cached: the mutation run attributes it to the test
    const course: Course = createCourse(track, buildRacingLine(track));
    const car = createSimCar('bot', 'bulli');
    const slot = track.grid[0];
    spawnVehicle(car.state, world, slot.x, slot.z, slot.yaw);
    car.state.boostMeter = meter;
    const driver = new LineDriver(course, car.params, level, mulberry32(seed));
    driver.startRace(START);
    const p = createRaceProgress();
    let resets = 0, boosted = false, topSpeed = 0, offsetMin = Infinity, offsetMax = -Infinity;
    for (let t = 1; t < START + 60 * 90 && p.status === 'racing' && p.lapTimes.length < laps; t++) {
        driver.drive(car.state, car.params, t, START, [], car.input);
        boosted ||= (car.input.buttons & BTN_BOOST) !== 0;
        topSpeed = Math.max(topSpeed, Math.hypot(car.state.vx, car.state.vz));
        offsetMin = Math.min(offsetMin, driver.laneOffset);
        offsetMax = Math.max(offsetMax, driver.laneOffset);
        raceInputFilter(t < START ? 'countdown' : 'racing', t, START, car.input);
        const x0 = car.state.x, z0 = car.state.z;
        stepWorld([car], world);
        if (car.events.reset) resets++;
        if (t >= START) advanceProgress(p, course, t, START, x0, z0, car.state.x, car.state.z, car.state.vx, car.state.vz, car.events.reset);
    }
    return {
        finishTicks: p.finishTicks, firstLap: p.lapTimes[0] ?? null, resets, maxLineDistance: driver.maxLineDistance, boosted,
        topSpeed, offsetMin, offsetMax
    };
}

describe('LineDriver', () => {
    it('drives a Downtown Loop lap in a medium Bulli without a reset, in 24-40 s, never 8 m off the line', () => {
        const run = race(DOWNTOWN_LOOP, 'medium', 1);
        expect(run.firstLap).not.toBeNull();
        expect(run.firstLap! / 60).toBeGreaterThan(24);
        expect(run.firstLap! / 60).toBeLessThan(40);
        expect(run.resets).toBe(0);
        expect(run.maxLineDistance).toBeLessThan(8);
    });

    it('cruises a long straight at its level\'s share of the top speed', () => {
        // 2 km straight on flat ground, no boost (the meter stays empty)
        const straight: TrackDef = {
            ...HILL_SPRINT, centerline: [{ x: 0, z: -50 }, { x: 0, z: 2000 }],
            gates: [{ x: 0, z: 0, yaw: 0, width: 16, visual: 'start' }, { x: 0, z: 1990, yaw: 0, width: 16, visual: 'finish' }],
            grid: [{ x: 0, z: -10, yaw: 0 }]
        };
        worlds.set(straight, createSimWorld({ ...FLAT_TERRAIN, size: 8000 }, [], []));
        const vtop = createSimCar('p', 'bulli').params.topSpeed;
        for (const level of ['easy', 'hard'] as const) {
            const run = race(straight, level, 1);
            const cruise = BOT_SKILLS[level].speedScale * vtop;
            // Close to it after 2 km (the last metres per second come slowly)
            expect(run.topSpeed, level).toBeGreaterThan(cruise - 2.5);
            expect(run.topSpeed, level).toBeLessThan(cruise + 0.3);
        }
    });

    it('drifts across its lane by the level\'s noise, within its amplitude', () => {
        const run = race(DOWNTOWN_LOOP, 'easy', 2);
        const amplitude = BOT_SKILLS.easy.noise;
        expect(run.offsetMin).toBeGreaterThanOrEqual(-amplitude);
        expect(run.offsetMax).toBeLessThanOrEqual(amplitude);
        // About a dozen knots in a lap: far more than half the band is used
        expect(run.offsetMax - run.offsetMin).toBeGreaterThan(amplitude);
    });

    it('drives the Hill Sprint in a medium Bulli without a reset, in 20-40 s, never 8 m off the line', () => {
        const run = race(HILL_SPRINT, 'medium', 1);
        expect(run.finishTicks).not.toBeNull();
        expect(run.finishTicks! / 60).toBeGreaterThan(20);
        expect(run.finishTicks! / 60).toBeLessThan(40);
        expect(run.resets).toBe(0);
        expect(run.maxLineDistance).toBeLessThan(8);
    });

    it('is faster hard than medium and medium than easy (mean of three seeds), and boosts only from medium on', () => {
        const mean = (level: BotLevel) => {
            const runs = [1, 2, 3].map(seed => race(HILL_SPRINT, level, seed, 1, 1));
            for (const run of runs) expect(run.finishTicks, level).not.toBeNull();
            return { time: runs.reduce((sum, r) => sum + r.finishTicks!, 0) / 3, boosted: runs.some(r => r.boosted) };
        };
        const easy = mean('easy'), medium = mean('medium'), hard = mean('hard');
        expect(hard.time).toBeLessThan(medium.time);
        expect(medium.time).toBeLessThan(easy.time);
        expect([easy.boosted, medium.boosted, hard.boosted]).toEqual([false, true, true]);
    });

    it('times the start by level: perfect launches in the share of the level', () => {
        const course = createCourse(HILL_SPRINT, buildRacingLine(HILL_SPRINT));
        const params = createSimCar('p', 'bulli').params;
        const share = (level: BotLevel) => {
            const driver = new LineDriver(course, params, level, mulberry32(99));
            const counts = { perfect: 0, early: 0, normal: 0 };
            for (let k = 0; k < 400; k++) {
                const { pressTick } = driver.startRace(1000);
                counts[launchResult(t => (t >= pressTick ? 255 : 0), 1000)]++;
            }
            return { perfect: counts.perfect / 400, early: counts.early / 400, normal: counts.normal / 400 };
        };
        for (const level of ['easy', 'medium', 'hard'] as const) {
            const got = share(level);
            // 400 draws: within 4 standard errors of the level's chance
            const p = BOT_SKILLS[level].launchPerfect;
            expect(Math.abs(got.perfect - p), level).toBeLessThan(4 * Math.sqrt(p * (1 - p) / 400));
            // The misses split between too early and a normal start
            expect(Math.abs(got.early - got.normal), level).toBeLessThan(0.15);
        }
    });

    it('holds the throttle through green after pressing it in the countdown', () => {
        const course = createCourse(HILL_SPRINT, buildRacingLine(HILL_SPRINT));
        const car = createSimCar('bot', 'bulli');
        spawnVehicle(car.state, worldFor(HILL_SPRINT), HILL_SPRINT.grid[0].x, HILL_SPRINT.grid[0].z, HILL_SPRINT.grid[0].yaw);
        // An easy bot (12 ticks of reaction delay) that presses before green
        let seed = 1;
        while (new LineDriver(course, car.params, 'easy', mulberry32(seed)).startRace(START).pressTick > START - 5) seed++;
        const bot = new LineDriver(course, car.params, 'easy', mulberry32(seed));
        const { pressTick } = bot.startRace(START);
        for (let t = START - 60; t <= START + 5; t++) {
            const throttle = bot.drive(car.state, car.params, t, START, [], car.input).throttle;
            expect(throttle, `tick ${t - START}`).toBe(t >= pressTick ? 255 : 0);
        }
    });

    it('drives round a car standing on its line without touching it', () => {
        const track = HILL_SPRINT;
        const world = worldFor(track);
        const course = createCourse(track, buildRacingLine(track));
        const car = createSimCar('a-bot', 'bulli');
        const blocker = createSimCar('b-blocker', 'bulli');
        spawnVehicle(car.state, world, 58, 60, Math.PI);
        // 90 m down the straight south of the start, right on the line
        spawnVehicle(blocker.state, world, 58, -30, Math.PI);
        car.state.ghostTicks = blocker.state.ghostTicks = 0;
        const driver = new LineDriver(course, car.params, 'hard', mulberry32(4));
        driver.startRace(0);
        let impact = 0, passed = false;
        for (let t = 1; t < 60 * 8 && !passed; t++) {
            driver.drive(car.state, car.params, t, 0, [blocker.state], car.input);
            // No pedal at all: a brake held at a standstill would reverse
            stepWorld([car, blocker], world);
            impact = Math.max(impact, car.events.carImpact);
            passed = car.state.z < -45;
        }
        expect(passed).toBe(true);
        expect(impact).toBe(0);
    });

    describe('in traffic on a straight (the car held at 25 m/s, 100 m along)', () => {
        const straight: TrackDef = {
            ...HILL_SPRINT, centerline: [{ x: 0, z: -50 }, { x: 0, z: 2000 }],
            gates: [{ x: 0, z: 0, yaw: 0, width: 16, visual: 'start' }, { x: 0, z: 1990, yaw: 0, width: 16, visual: 'finish' }],
            grid: [{ x: 0, z: -10, yaw: 0 }], hints: []
        };
        // Facing +z: the left axis is +x, so the lateral offset is plain x
        function offsetAfter(level: BotLevel, other: { x: number; z: number; vz: number }, ticks = 45): LineDriver {
            const course = createCourse(straight, buildRacingLine(straight));
            const car = createSimCar('bot', 'bulli');
            car.state.z = 100;
            car.state.vz = 25;
            const driver = new LineDriver(course, car.params, level, mulberry32(3));
            driver.startRace(0);
            for (let t = 1; t <= ticks; t++) driver.drive(car.state, car.params, t, 0, [{ x: other.x, z: other.z, vx: 0, vz: other.vz }], car.input);
            return driver;
        }

        it('pulls 3 m out to the side away from a slower car ahead, and aims there', () => {
            const right = offsetAfter('hard', { x: 1, z: 112, vz: 10 });
            expect(right.laneOffset).toBe(-EVADE_OFFSET);
            expect(right.target.x).toBeCloseTo(-EVADE_OFFSET, 9);
            expect(offsetAfter('hard', { x: -1, z: 112, vz: 10 }).laneOffset).toBe(EVADE_OFFSET);
            // At 25 against 0 m/s the corridor reaches 2 s · 25 m/s = 50 m ahead
            expect(offsetAfter('hard', { x: 1, z: 145, vz: 0 }).laneOffset).toBe(-EVADE_OFFSET);
            // A car behind, beside or far ahead is no obstacle: the offset stays in the noise
            for (const other of [{ x: 0, z: 95, vz: 0 }, { x: 4, z: 110, vz: 0 }, { x: 0, z: 160, vz: 20 }]) {
                expect(Math.abs(offsetAfter('hard', other).laneOffset), JSON.stringify(other)).toBeLessThanOrEqual(BOT_SKILLS.hard.noise);
            }
        });

        it('takes the slipstream lane of a car 20 m ahead from medium on, not as easy, not of a slow car', () => {
            expect(offsetAfter('medium', { x: 2, z: 120, vz: 25 }).laneOffset).toBeCloseTo(2, 9);
            expect(offsetAfter('hard', { x: -2, z: 120, vz: 25 }).laneOffset).toBeCloseTo(-2, 9);
            // Beyond 25 m, or as easy: only the noise
            expect(Math.abs(offsetAfter('medium', { x: 2, z: 130, vz: 25 }).laneOffset)).toBeLessThanOrEqual(BOT_SKILLS.medium.noise);
            expect(Math.abs(offsetAfter('easy', { x: 2.4, z: 120, vz: 25 }).laneOffset - 2.4)).toBeGreaterThan(0.5);
            // Lanes farther out than the evasion offset are clamped to it
            expect(offsetAfter('medium', { x: 5, z: 120, vz: 25 }).laneOffset).toBe(EVADE_OFFSET);
            // Below 15 m/s there is no slipstream to take
            expect(offsetAfter('medium', { x: 2.8, z: 120, vz: 15 }).laneOffset).toBeCloseTo(2.8, 9);
            expect(Math.abs(offsetAfter('medium', { x: 2.8, z: 120, vz: 14.9 }).laneOffset)).toBeLessThanOrEqual(BOT_SKILLS.medium.noise);
        });
    });

    it('holds reset on request (a missed gate) and after 2 s far off the line', () => {
        const course = createCourse(HILL_SPRINT, buildRacingLine(HILL_SPRINT));
        const car = createSimCar('bot', 'bulli');
        spawnVehicle(car.state, worldFor(HILL_SPRINT), 58, 0, Math.PI);
        const driver = new LineDriver(course, car.params, 'medium', mulberry32(1));
        driver.startRace(0);
        driver.requestReset();
        const held: number[] = [];
        for (let t = 1; t <= 40; t++) {
            // Asked again while holding: no new, longer hold
            if (t === 10) driver.requestReset();
            held.push(driver.drive(car.state, car.params, t, 0, [], car.input).buttons & BTN_RESET);
        }
        // Held 34 ticks (longer than the sim's 30), requested twice counts once
        expect(held.filter(Boolean)).toHaveLength(34);
        expect(held.slice(0, 34).every(Boolean)).toBe(true);
        expect(driver.stuck.resets).toBe(1);

        // 40 m beside the line, standing: after 120 ticks the reset button
        const lost = new LineDriver(course, car.params, 'medium', mulberry32(1));
        lost.startRace(0);
        car.state.x = 98;
        const buttons: number[] = [];
        for (let t = 1; t <= 125; t++) buttons.push(lost.drive(car.state, car.params, t, 0, [], car.input).buttons & BTN_RESET);
        // The 120th tick off the line holds it already (backing off meanwhile)
        expect(buttons.slice(0, 119).some(Boolean)).toBe(false);
        expect(buttons.slice(119).every(Boolean)).toBe(true);
    });
});
