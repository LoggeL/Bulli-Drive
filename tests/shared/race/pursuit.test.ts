import { describe, expect, it } from 'vitest';
import {
    BACKOFF_TICKS, GOING_TICKS, RESET_TICKS, STUCK_TICKS, StuckWatch, pursuitSteer, steerForAngle, wrapAngle
} from '../../../src/shared/race/pursuit.js';
import { BTN_RESET } from '../../../src/shared/sim/constants.js';
import { createVehicleInput, createVehicleState } from '../../../src/shared/sim/types.js';
import { createSimCar } from '../../../src/shared/sim/vehicle.js';

// The shared core of the bots' driving (docs/phase-2-design.md, 14): the
// angle wrap, pure pursuit and the stuck logic (back off twice, then reset).

describe('wrapAngle and pursuitSteer', () => {
    it('wraps into [-π, π)', () => {
        expect(wrapAngle(0.5)).toBe(0.5);
        expect(wrapAngle(3 * Math.PI / 2)).toBeCloseTo(-Math.PI / 2, 12);
        expect(wrapAngle(-3 * Math.PI / 2)).toBeCloseTo(Math.PI / 2, 12);
        expect(wrapAngle(Math.PI)).toBeCloseTo(-Math.PI, 12);
    });

    it('steers left (+) towards a target on the left, right (-) to the right, none straight ahead', () => {
        const p = createSimCar('p', 'bulli').params;
        const s = createVehicleState();
        // Facing +z; left of yaw 0 is +x
        expect(pursuitSteer(s, p, 10, 0, 20, 20)).toBe(0);
        expect(pursuitSteer(s, p, 10, 5, 20, 20)).toBeGreaterThan(0);
        expect(pursuitSteer(s, p, 10, -5, 20, 20)).toBeLessThan(0);
        // Behind and to the side: the full lock at walking pace
        expect(pursuitSteer(s, p, 1, 10, -5, 4)).toBe(127);
        // The wheel angle of the arc: atan(2 · L · sin α / ld), α = 45° at 20 m
        const alpha = Math.PI / 4;
        const delta = Math.atan2(2 * p.wheelbase * Math.sin(alpha), 20);
        expect(pursuitSteer(s, p, 0, 20 * Math.sin(alpha), 20 * Math.cos(alpha), 20)).toBe(steerForAngle(delta, 0, p));
    });
});

describe('StuckWatch', () => {
    const input = () => createVehicleInput();

    // Ticks of throttle at a standstill; returns what override() said each tick
    function stuckFor(watch: StuckWatch, ticks: number, steer = 30, flip = 0): string[] {
        const s = createVehicleState();
        s.flipAngle = flip;
        const said: string[] = [];
        for (let t = 0; t < ticks; t++) {
            const out = input();
            const mode = watch.override(out);
            said.push(mode);
            if (mode !== 'drive') continue;
            out.throttle = 255;
            out.steer = steer;
            watch.watch(s, 0, out);
        }
        return said;
    }

    it('backs off twice with the wheel the other way, then holds reset', () => {
        const watch = new StuckWatch();
        const said = stuckFor(watch, 3 * STUCK_TICKS + 2 * BACKOFF_TICKS + RESET_TICKS + 5);
        const firstBackoff = said.indexOf('backoff');
        expect(firstBackoff).toBe(STUCK_TICKS);
        expect(said.filter(m => m === 'backoff' || m === 'backoffDone')).toHaveLength(2 * BACKOFF_TICKS);
        expect(said.filter(m => m === 'reset' || m === 'resetDone')).toHaveLength(RESET_TICKS);
        expect(said.indexOf('reset')).toBe(3 * STUCK_TICKS + 2 * BACKOFF_TICKS);
        expect([watch.backoffCount, watch.resets]).toEqual([2, 1]);
        // The back-off steers against the last wheel and reverses
        const w = new StuckWatch();
        stuckFor(w, STUCK_TICKS);
        const out = input();
        w.override(out);
        expect([out.steer, out.throttle, out.brake]).toEqual([-127, 0, 255]);
        const left = new StuckWatch();
        stuckFor(left, STUCK_TICKS, -30);
        left.override(out);
        expect(out.steer).toBe(127);
    });

    it('holds reset straight away when the car is flipped, and not while it gets going', () => {
        const flipped = new StuckWatch();
        const said = stuckFor(flipped, STUCK_TICKS + 1, 30, 1);
        expect(said[STUCK_TICKS]).toBe('reset');
        const out = input();
        flipped.override(out);
        expect(out.buttons).toBe(BTN_RESET);
        // Faster than 4 m/s: the count starts over
        const moving = new StuckWatch();
        const s = createVehicleState();
        for (let t = 0; t < 3 * STUCK_TICKS; t++) {
            const o = input();
            expect(moving.override(o)).toBe('drive');
            o.throttle = 255;
            moving.watch(s, t % STUCK_TICKS === STUCK_TICKS - 1 ? 5 : 0, o);
        }
        expect(moving.backoffCount).toBe(0);
    });

    it('counts a standstill as stuck when the driver means to move, whatever its pedal', () => {
        const s = createVehicleState();
        // A light throttle (behind a car that stands): not stuck by the pedal ...
        const byPedal = new StuckWatch();
        for (let t = 0; t < 2 * STUCK_TICKS; t++) {
            const o = input();
            expect(byPedal.override(o)).toBe('drive');
            o.throttle = 89;
            byPedal.watch(s, 0, o);
        }
        // ... but stuck for a driver that means to move (a race bot)
        const racing = new StuckWatch();
        const said: string[] = [];
        for (let t = 0; t < STUCK_TICKS + 1; t++) {
            const o = input();
            said.push(racing.override(o));
            o.throttle = 89;
            racing.watch(s, 0, o, true);
        }
        expect(said.indexOf('backoff')).toBe(STUCK_TICKS);
        // Standing on purpose (wantsToMove false) never counts, at full throttle neither
        const parked = new StuckWatch();
        for (let t = 0; t < 2 * STUCK_TICKS; t++) {
            const o = input();
            expect(parked.override(o)).toBe('drive');
            o.throttle = 255;
            parked.watch(s, 0, o, false);
        }
    });

    it('takes a bounce off the wall for no getting going: the back-offs count on to the reset', () => {
        // Stuck, then 4.5 m/s for `going` ticks after every back-off
        function run(going: number): StuckWatch {
            const watch = new StuckWatch();
            const s = createVehicleState();
            let since = -1;
            for (let t = 0; t < 4 * (STUCK_TICKS + BACKOFF_TICKS + GOING_TICKS) && watch.resets === 0; t++) {
                const o = input();
                const mode = watch.override(o);
                if (mode === 'backoffDone') since = 0;
                if (mode !== 'drive') continue;
                o.throttle = 255;
                const u = since >= 0 && since < going ? 4.5 : 0;
                if (since >= 0) since++;
                watch.watch(s, u, o);
            }
            return watch;
        }
        // A moment (1 tick under GOING_TICKS): back off twice, then the reset
        const bounced = run(GOING_TICKS - 1);
        expect([bounced.backoffCount, bounced.resets]).toEqual([2, 1]);
        // Going for GOING_TICKS: the count starts over, no reset in this time
        const going = run(GOING_TICKS);
        expect(going.resets).toBe(0);
        expect(going.backoffCount).toBeGreaterThan(2);
    });

    it('counts a forced reset once while it is held, and ends a back-off for it', () => {
        const watch = new StuckWatch();
        stuckFor(watch, STUCK_TICKS + 3);
        watch.forceReset();
        watch.forceReset();
        expect(watch.resets).toBe(1);
        const said: string[] = [];
        for (let t = 0; t < RESET_TICKS + 1; t++) said.push(watch.override(input()));
        expect(said.slice(0, RESET_TICKS - 1).every(m => m === 'reset')).toBe(true);
        expect(said[RESET_TICKS - 1]).toBe('resetDone');
        expect(said[RESET_TICKS]).toBe('drive');
    });
});
