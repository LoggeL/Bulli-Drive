import { describe, expect, it } from 'vitest';
import {
    arrowDegrees, BANNER_MS, countdownAt, RaceModel, RESULTS_DELAY_MS, SPLIT_MS, type GhostMessage, type ResultsMessage
} from '../../src/client/race/raceModel.js';
import type { MemberInfo, RaceStateBody } from '../../src/shared/protocol.js';
import { oldTrack } from './raceTracks.js';

// What the client shows of a race (src/client/race/raceModel.ts,
// docs/phase-2-design.md 17.2): countdown and launch window, position, lap,
// running time, split, banners, the next-gate arrow, lobby and results.
// Expected values by hand from the rules: 60 ticks per second, lights at
// S - 180 / - 120 / - 60, the launch window the 20 ticks before S, times as
// m:ss.mmm of round(ticks · 1000 / 60). The geometry is that of the phase 2
// tracks (raceTracks.ts), measured by hand; the model takes the tracks it
// is given.

const S = 1000;

function raceState(patch: Partial<RaceStateBody> = {}): RaceStateBody {
    return {
        mode: 'race', phase: 'countdown', trackId: 'downtown-loop', trackVersion: 1, trackHash: 'h', laps: 3,
        botLevel: 'medium', startTick: S, phaseEndTick: S, ready: [], votes: null,
        racers: [{ id: 'me', grid: 2, bot: false }, { id: 'a', grid: 0, bot: false }, { id: 'b1', grid: 1, bot: true }],
        ...patch
    };
}

function model(patch: Partial<RaceStateBody> = {}): RaceModel {
    const m = new RaceModel(oldTrack);
    m.selfId = 'me';
    m.setState(raceState(patch));
    return m;
}

function member(id: string, patch: Partial<MemberInfo> = {}): MemberInfo {
    return { id, slot: 0, name: id.toUpperCase(), color: 0, carType: 'bulli', profile: 'standard', ready: true, ...patch };
}

describe('countdownAt', () => {
    it('shows the grid, three red lights a second apart, then green and GO! for a second', () => {
        // Race preparation 60 ticks: the countdown starts at S - 240
        expect(countdownAt(S - 241, S, 60)).toBeNull();
        expect(countdownAt(S - 240, S, 60)).toMatchObject({ lights: 0, green: false, label: 'READY' });
        expect(countdownAt(S - 181, S, 60)).toMatchObject({ lights: 0, label: 'READY' });
        expect(countdownAt(S - 180, S, 60)).toMatchObject({ lights: 1, label: '3' });
        expect(countdownAt(S - 121, S, 60)).toMatchObject({ lights: 1, label: '3' });
        expect(countdownAt(S - 120, S, 60)).toMatchObject({ lights: 2, label: '2' });
        expect(countdownAt(S - 60, S, 60)).toMatchObject({ lights: 3, label: '1', lastSecond: 0 });
        expect(countdownAt(S - 30, S, 60)!.lastSecond).toBeCloseTo(0.5, 12);
        expect(countdownAt(S, S, 60)).toMatchObject({ green: true, label: 'GO!' });
        expect(countdownAt(S + 59.9, S, 60)).toMatchObject({ green: true, label: 'GO!' });
        expect(countdownAt(S + 60, S, 60)).toBeNull();
        // The time trial's shorter preparation
        expect(countdownAt(S - 211, S, 30)).toBeNull();
        expect(countdownAt(S - 210, S, 30)).toMatchObject({ label: 'READY' });
    });

    it('opens the launch window 20 ticks before green', () => {
        expect(countdownAt(S - 21, S, 60)!.windowOpen).toBe(false);
        expect(countdownAt(S - 20, S, 60)!.windowOpen).toBe(true);
        expect(countdownAt(S - 0.5, S, 60)!.windowOpen).toBe(true);
        expect(countdownAt(S, S, 60)!.windowOpen).toBe(false);
    });
});

describe('arrowDegrees', () => {
    it('points ahead, left, right and back for a camera looking along +z, and turns with the camera', () => {
        expect(arrowDegrees(0, 0, 0, 10, 0)).toBeCloseTo(0, 12);
        // +x is on the left of a camera looking along +z (yaw grows to the left):
        // the arrow turns counter-clockwise on screen
        expect(arrowDegrees(0, 0, 10, 0, 0)).toBeCloseTo(-90, 12);
        expect(arrowDegrees(0, 0, -10, 0, 0)).toBeCloseTo(90, 12);
        expect(Math.abs(arrowDegrees(0, 0, 0, -10, 0))).toBeCloseTo(180, 12);
        // Looking along +x the same target is straight ahead
        expect(arrowDegrees(0, 0, 10, 0, Math.PI / 2)).toBeCloseTo(0, 12);
        // Wrapped: a camera yaw two turns on changes nothing
        expect(arrowDegrees(5, 5, 15, 5, 4 * Math.PI)).toBeCloseTo(-90, 9);
    });
});

describe('the race HUD', () => {
    it('shows the grid position before the first standings, then the position in the order', () => {
        const m = model();
        expect(m.hud(S - 100, 0)!.position).toBe('P3/3');
        m.onStatus([{ id: 'a', passed: 1, lap: 1, status: 'racing' }, { id: 'me', passed: 1, lap: 1, status: 'racing' },
            { id: 'b1', passed: 0, lap: 1, status: 'racing' }]);
        expect(m.hud(S + 100, 0)!.position).toBe('P2/3');
        // The time trial has no position; the lobby no HUD
        expect(model({ mode: 'timetrial' }).hud(S, 0)!.position).toBeNull();
        expect(model({ phase: 'lobby', startTick: null }).hud(S, 0)).toBeNull();
    });

    it('runs the clock from the start tick and stops it at the server finish time', () => {
        const m = model({ phase: 'racing' });
        expect(m.hud(S - 30, 0)!.time).toBe('0:00.000');
        // 90 ticks = 1.5 s; 3723.3 ticks = 62.055 s
        expect(m.hud(S + 90, 0)!.time).toBe('0:01.500');
        expect(m.hud(S + 3723.3, 0)!.time).toBe('1:02.055');
        m.onEvent({ type: 'finish', id: 'me', pos: 2, time: 1234.5 }, 0);
        // 1234.5 ticks = 20.575 s, whatever the clock says
        expect(m.hud(S + 5000, 0)!.time).toBe('0:20.575');
        expect(m.hud(S + 5000, 0)!.banner).toEqual({ text: 'FINISH – P2', kind: 'good' });
    });

    it('counts the lap from the own gate events, with FINAL LAP when the last one starts', () => {
        // Downtown Loop: 8 gates, 3 laps
        const m = model({ phase: 'racing' });
        expect(m.hud(S, 0)!.lap).toBe('LAP 1/3');
        m.onEvent({ type: 'gate', id: 'me', passed: 9, gate: 0, lap: 2, tick: S + 2000, time: 2000 }, 0);
        expect(m.hud(S + 2001, 0)!.lap).toBe('LAP 2/3');
        expect(m.hud(S + 2001, 0)!.banner).toBeNull();
        // Another racer's gate changes nothing
        m.onEvent({ type: 'gate', id: 'a', passed: 17, gate: 0, lap: 3, tick: S + 3900, time: 3900 }, 0);
        expect(m.hud(S + 3901, 0)!.lap).toBe('LAP 2/3');
        m.onEvent({ type: 'gate', id: 'me', passed: 17, gate: 0, lap: 3, tick: S + 4000, time: 4000 }, 1000);
        expect(m.hud(S + 4001, 1000)!.lap).toBe('LAP 3/3');
        expect(m.hud(S + 4001, 1000 + BANNER_MS - 1)!.banner).toEqual({ text: 'FINAL LAP', kind: 'info' });
        expect(m.hud(S + 4001, 1000 + BANNER_MS)!.banner).toBeNull();
        // Only once: the next gate of the last lap shows nothing
        m.onEvent({ type: 'gate', id: 'me', passed: 18, gate: 1, lap: 3, tick: S + 4200, time: 4200 }, 5000);
        expect(m.hud(S + 4201, 5000)!.banner).toBeNull();
        // The Hill Sprint has no laps
        expect(model({ trackId: 'hill-sprint', laps: 1 }).hud(S, 0)!.lap).toBeNull();
    });

    it('shows the gap to the car ahead for 3 s after a gate, and the time trial split against the ghost', () => {
        const m = model({ phase: 'racing' });
        // 18.72 ticks = 312 ms behind
        m.onEvent({ type: 'gate', id: 'me', passed: 2, gate: 1, lap: 1, tick: S + 500, time: 500, gapAhead: 18.72 }, 5000);
        expect(m.hud(S + 501, 5000)!.split).toEqual({ text: '+0.312', ahead: false });
        expect(m.hud(S + 501, 5000 + SPLIT_MS - 1)!.split).not.toBeNull();
        expect(m.hud(S + 501, 5000 + SPLIT_MS)!.split).toBeNull();
        // The leader gets no gap, and the one before goes
        m.onEvent({ type: 'gate', id: 'me', passed: 3, gate: 2, lap: 1, tick: S + 900, time: 900 }, 6000);
        expect(m.hud(S + 901, 6000)!.split).toBeNull();

        const trial = model({ mode: 'timetrial', phase: 'racing', racers: [{ id: 'me', grid: 0, bot: false }] });
        trial.onGhost({ type: 'ghostData', kind: 'personal', name: 'ME', carType: 'bulli', finishTicks: 3000, gateTicks: [100, 400], hz: 20, poses: '' } as GhostMessage);
        // 10 ticks ahead of the ghost = 167 ms; 30 behind = 500 ms
        trial.onEvent({ type: 'gate', id: 'me', passed: 1, gate: 0, lap: 1, tick: S + 90, time: 90 }, 0);
        expect(trial.hud(S + 91, 0)!.split).toEqual({ text: '-0.167', ahead: true });
        trial.onEvent({ type: 'gate', id: 'me', passed: 2, gate: 1, lap: 1, tick: S + 430, time: 430 }, 0);
        expect(trial.hud(S + 431, 0)!.split).toEqual({ text: '+0.500', ahead: false });
    });

    it('shows WRONG WAY while the server says so, and the launch result for a moment', () => {
        const m = model({ phase: 'racing' });
        m.onEvent({ type: 'launch', id: 'me', result: 'perfect', tick: S }, 0);
        expect(m.hud(S, 10)!.banner).toEqual({ text: 'PERFECT START!', kind: 'good' });
        m.onEvent({ type: 'wrongWay', id: 'me', on: true }, 100);
        expect(m.hud(S + 50, 100 + 60_000)!.banner).toEqual({ text: 'WRONG WAY', kind: 'bad' });
        m.onEvent({ type: 'wrongWay', id: 'me', on: false }, 100);
        expect(m.hud(S + 50, 100 + 60_000)!.banner).toBeNull();
        const early = model({ phase: 'racing' });
        early.onEvent({ type: 'launch', id: 'me', result: 'early', tick: S }, 0);
        expect(early.hud(S, 0)!.banner).toEqual({ text: 'TOO EARLY', kind: 'bad' });
        const normal = model({ phase: 'racing' });
        normal.onEvent({ type: 'launch', id: 'me', result: 'normal', tick: S }, 0);
        expect(normal.hud(S, 0)!.banner).toBeNull();
    });

    it('marks a player without a car in the race as a spectator', () => {
        const m = model({ racers: [{ id: 'a', grid: 0, bot: false }] });
        expect(m.hud(S, 0)!.spectating).toBe(true);
        expect(m.hud(S, 0)!.position).toBeNull();
        expect(model().hud(S, 0)!.spectating).toBe(false);
    });

    it('starts over with a new start tick: no finish, no launch, no gates', () => {
        const m = model({ phase: 'racing' });
        m.onEvent({ type: 'gate', id: 'me', passed: 9, gate: 0, lap: 2, tick: S + 2000, time: 2000 }, 0);
        m.onEvent({ type: 'finish', id: 'me', pos: 1, time: 2000 }, 0);
        m.onEvent({ type: 'launch', id: 'me', result: 'early', tick: S }, 0);
        m.setState(raceState({ startTick: S + 5000 }));
        const hud = m.hud(S + 5000 + 60, 0)!;
        expect(hud.time).toBe('0:01.000');
        expect(hud.lap).toBe('LAP 1/3');
        expect(m.launchEvent).toBeNull();
        expect(m.progress.status).toBe('racing');
    });
});

describe('the launch of the prediction', () => {
    it('follows the rule on the own raw throttle until the server sends its word', () => {
        const m = model();
        // Pressed at S - 20 and held: perfect; pressed at S - 21: early
        expect(m.launchFor(S, t => (t >= S - 20 ? 255 : 0))).toBe('perfect');
        // Cached per start tick
        expect(m.launchFor(S, () => 0)).toBe('perfect');
        expect(m.launchFor(S + 1, t => (t >= S + 1 - 21 ? 255 : 0))).toBe('early');
        m.onEvent({ type: 'launch', id: 'me', result: 'normal', tick: S + 1 }, 0);
        expect(m.launchFor(S + 1, t => (t >= S - 20 ? 255 : 0))).toBe('normal');
    });
});

describe('the next gate', () => {
    it('measures the way along the racing line from the grid, after a gate and past a missed one', () => {
        // Hill Sprint: the line starts at (58, 104) and runs south on x = 58;
        // G0 at z = 66 (s = 38), G1 at z = -72 (s = 176)
        const m = model({ trackId: 'hill-sprint', laps: 1, phase: 'racing', racers: [{ id: 'me', grid: 0, bot: false }] });
        // Grid slot 0 at z = 72: s = 32, 6 m to G0
        expect(m.nextGate(60.8, 72)).toEqual({ gate: 0, x: 58, z: 66, distance: 6, missed: false });
        m.onEvent({ type: 'gate', id: 'me', passed: 1, gate: 0, lap: 1, tick: S + 60, time: 60 }, 0);
        // z = 60: s = 44, 132 m to G1
        expect(m.nextGate(58, 60)).toMatchObject({ gate: 1, distance: 132, missed: false });
        expect(m.gateLook(0)).toBe('passed');
        expect(m.gateLook(1)).toBe('next');
        expect(m.gateLook(2)).toBe('ahead');
        // Driving on (the line is tracked in a window around the last place)
        for (let z = 50; z > -100; z -= 10) m.nextGate(58, z);
        // z = -100 is 28 m past G1, z = -104 is 32 m past: missed from 30 m on
        expect(m.nextGate(58, -100)).toMatchObject({ distance: 0, missed: false });
        expect(m.nextGate(58, -104)).toMatchObject({ distance: 0, missed: true });
        expect(m.hud(S + 900, 0)!.banner).toEqual({ text: 'MISSED CHECKPOINT', kind: 'bad' });
        // Finished: no arrow
        m.onEvent({ type: 'finish', id: 'me', pos: 1, time: 1500 }, 0);
        expect(m.nextGate(58, -104)).toBeNull();
        // Not a racer: no arrow
        expect(model({ racers: [] }).nextGate(6, -20)).toBeNull();
    });

    it('lights the gates of a circuit by lap: those passed this lap dim, the start/finish next at the end', () => {
        const m = model({ phase: 'racing' });
        expect(m.gateLook(0)).toBe('next');
        expect(m.gateLook(3)).toBe('ahead');
        m.onEvent({ type: 'gate', id: 'me', passed: 8, gate: 7, lap: 1, tick: S + 1800, time: 1800 }, 0);
        // Lap 1 done but for the finish line: gates 1..7 passed, gate 0 next
        expect(m.gateLook(0)).toBe('next');
        expect(m.gateLook(7)).toBe('passed');
        m.onEvent({ type: 'gate', id: 'me', passed: 9, gate: 0, lap: 2, tick: S + 2000, time: 2000 }, 0);
        expect(m.gateLook(0)).toBe('passed');
        expect(m.gateLook(1)).toBe('next');
        expect(m.gateLook(7)).toBe('ahead');
    });
});

describe('lobby and results', () => {
    it('lists the humans past the splash screen with their ready state and the autostart', () => {
        const m = model({ phase: 'lobby', startTick: null, ready: ['a'], phaseEndTick: 2000 });
        const view = m.lobby([member('me', { ready: false }), member('a'), member('bot-1', { bot: true }), member('late', { ready: false })], 1101)!;
        expect(view.drivers).toEqual([
            { id: 'me', name: 'ME', ready: false, self: true },
            { id: 'a', name: 'A', ready: true, self: false }
        ]);
        expect(view.selfReady).toBe(false);
        // 899 ticks = 14.98 s: shown as 15
        expect(view.startsIn).toBe(15);
        expect(view.trackName).toBe('Downtown Loop');
        expect(m.lobby([], 3000)!.startsIn).toBe(0);
        expect(model({ phase: 'lobby', startTick: null, phaseEndTick: null }).lobby([], 0)!.startsIn).toBeNull();
        // Not in the lobby
        expect(model().lobby([], 0)).toBeNull();
    });

    it('turns the results into rows: times, DNF, left, best laps on a circuit, the vote and the time left', () => {
        const m = model({ phase: 'results', phaseEndTick: 5000, votes: { rematch: 1, next: 0 } });
        const results: ResultsMessage = {
            type: 'raceResults', trackId: 'downtown-loop',
            entries: [
                { id: 'a', name: 'A', bot: false, carType: 'sport', pos: 1, status: 'finished', finishTicks: 5400, bestLapTicks: 1770 },
                { id: 'b1', name: 'Kalle', bot: true, carType: 'beetle', pos: 2, status: 'dnf', finishTicks: null, bestLapTicks: 1800 },
                { id: 'me', name: 'ME', bot: false, carType: 'bulli', pos: 3, status: 'left', finishTicks: null, bestLapTicks: null }
            ]
        };
        m.onResults(results);
        const view = m.resultsView(4101, 0)!;
        expect(view.rows).toEqual([
            // 5400 ticks = 1:30.000, 1770 = 29.500
            { pos: 1, name: 'A', bot: false, self: false, car: 'Sport', time: '1:30.000', bestLap: '0:29.500' },
            { pos: 2, name: 'Kalle', bot: true, self: false, car: 'Beetle', time: 'DNF', bestLap: '0:30.000' },
            { pos: 3, name: 'ME', bot: false, self: true, car: 'Bulli', time: 'DNF (left)', bestLap: '–' }
        ]);
        expect(view.closesIn).toBe(15);
        expect(view.votes).toEqual({ rematch: 1, next: 0 });
        // A sprint has no best lap
        const sprint = model({ trackId: 'hill-sprint', phase: 'results' });
        sprint.onResults({ ...results, trackId: 'hill-sprint' });
        expect(sprint.resultsView(0, 0)!.rows[0].bestLap).toBeNull();
        // Gone with the next lobby
        m.setState(raceState({ phase: 'lobby', startTick: null }));
        expect(m.resultsView(0, 0)).toBeNull();
    });

    it('holds the results back for a moment after the own finish, with the FINISH banner meanwhile', () => {
        const m = model({ trackId: 'hill-sprint', phase: 'racing' });
        m.onEvent({ type: 'finish', id: 'me', pos: 3, time: 1500 }, 10_000);
        m.setState(raceState({ trackId: 'hill-sprint', phase: 'results' }));
        m.onResults({ type: 'raceResults', trackId: 'hill-sprint', entries: [] });
        expect(m.resultsView(0, 10_000 + RESULTS_DELAY_MS - 1)).toBeNull();
        expect(m.hud(S + 1600, 10_000 + RESULTS_DELAY_MS - 1)!.banner).toEqual({ text: 'FINISH – P3', kind: 'good' });
        expect(m.resultsView(0, 10_000 + RESULTS_DELAY_MS)).not.toBeNull();
        // Without an own finish (DNF, a spectator) at once
        const dnf = model({ phase: 'results' });
        dnf.onResults({ type: 'raceResults', trackId: 'downtown-loop', entries: [] });
        expect(dnf.resultsView(0, 0)).not.toBeNull();
    });

    it('shows the time trial record and the own best', () => {
        const m = model({ mode: 'timetrial', trackId: 'hill-sprint', phase: 'results' });
        m.onResults({
            type: 'raceResults', trackId: 'hill-sprint',
            entries: [{ id: 'me', name: 'ME', bot: false, carType: 'bulli', pos: 1, status: 'finished', finishTicks: 1650, bestLapTicks: 1650 }],
            record: { name: 'Uschi', finishTicks: 1560 }, personal: { finishTicks: 1650, improved: true }
        });
        const view = m.resultsView(0, 0)!;
        // 1560 ticks = 26.000 s, 1650 = 27.500 s
        expect(view.record).toBe('0:26.000 · Uschi');
        expect(view.personal).toBe('0:27.500');
        expect(view.improved).toBe(true);
    });
});
