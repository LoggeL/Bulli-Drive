import { describe, expect, it } from 'vitest';
import { draftStrength, updateDrafts } from '../../../src/shared/sim/slipstream.js';
import { forwardSpeed, spawnCar } from '../../../src/shared/sim/scenarios.js';
import type { SimCar } from '../../../src/shared/sim/types.js';
import { stepWorld } from '../../../src/shared/sim/world.js';
import { createLongWorld, DEG } from './helpers.js';

// Slipstream (docs/phase-2-design.md, 13). Cone behind the car ahead:
// DRAFT_MIN 3 <= along <= DRAFT_RANGE 30, lat <= 1.2 + 0.05·along,
// strength (1 - along/30)·(1 - lat/halfWidth); heading within 20°, both
// cars at 15 m/s or more, neither a ghost. For yaw 0 forward is +z and the
// left axis +x.

const world = createLongWorld();

function pair(bx: number, bz: number, byaw = 0, speedA = 20, speedB = 20): [SimCar, SimCar] {
    return [spawnCar(world, 'a', 'bulli', 0, 0, 0, speedA), spawnCar(world, 'b', 'bulli', bx, bz, byaw, speedB)];
}

describe('draftStrength', () => {
    it('falls off with the distance ahead and to the side', () => {
        expect(draftStrength(...pair(0, 15))).toBeCloseTo(0.5, 15);
        expect(draftStrength(...pair(0, 3))).toBeCloseTo(0.9, 15);
        // along 10: half width 1.7; lat 0.5: (2/3)·(1 - 0.5/1.7)
        expect(draftStrength(...pair(0.5, 10))).toBeCloseTo((2 / 3) * (1 - 0.5 / 1.7), 15);
        expect(draftStrength(...pair(-0.5, 10))).toBeCloseTo((2 / 3) * (1 - 0.5 / 1.7), 15);
    });

    it('turns with the car: heading +x (yaw π/2), left is -z', () => {
        const a = spawnCar(world, 'a', 'bulli', 100, 50, Math.PI / 2, 20);
        // 15 m ahead along +x, 0.5 m to the right (+z); half width 1.2 + 0.75
        const b = spawnCar(world, 'b', 'bulli', 115, 50.5, Math.PI / 2, 20);
        expect(draftStrength(a, b)).toBeCloseTo(0.5 * (1 - 0.5 / 1.95), 12);
        // Behind along +x gives nothing, ahead along +z is off to the side
        expect(draftStrength(b, a)).toBe(0);
        const side = spawnCar(world, 'c', 'bulli', 100, 65, Math.PI / 2, 20);
        expect(draftStrength(a, side)).toBe(0);
        // Heading north-east: 10 m ahead and 0.5 m to the left
        const f = { x: Math.SQRT1_2, z: Math.SQRT1_2 }, l = { x: Math.SQRT1_2, z: -Math.SQRT1_2 };
        const ne = spawnCar(world, 'f', 'bulli', 0, 0, Math.PI / 4, 20);
        const neAhead = spawnCar(world, 'g', 'bulli', 10 * f.x + 0.5 * l.x, 10 * f.z + 0.5 * l.z, Math.PI / 4, 20);
        expect(draftStrength(ne, neAhead)).toBeCloseTo((2 / 3) * (1 - 0.5 / 1.7), 12);
        // Both heading -x (yaw -π/2): still one direction, 3° apart
        const west = spawnCar(world, 'd', 'bulli', 0, 0, -Math.PI / 2, 20);
        const westAhead = spawnCar(world, 'e', 'bulli', -10, 0, -Math.PI / 2 + 3 * DEG, 20);
        expect(draftStrength(west, westAhead)).toBeCloseTo(2 / 3, 12);
    });

    it('is 0 outside the cone', () => {
        expect(draftStrength(...pair(0, 2.9))).toBe(0);
        expect(draftStrength(...pair(0, 30))).toBe(0);
        expect(draftStrength(...pair(0, 30.1))).toBe(0);
        expect(draftStrength(...pair(1.71, 10))).toBe(0);
        expect(draftStrength(...pair(1.69, 10))).toBeGreaterThan(0);
        // Behind is no slipstream
        expect(draftStrength(...pair(0, -10))).toBe(0);
    });

    it('needs matching headings (20°) and 15 m/s on both cars', () => {
        expect(draftStrength(...pair(0, 10, 19 * DEG))).toBeGreaterThan(0);
        expect(draftStrength(...pair(0, 10, 21 * DEG))).toBe(0);
        expect(draftStrength(...pair(0, 10, -21 * DEG))).toBe(0);
        // Across the wrap: 359° and 1° are 2° apart
        const [a, b] = pair(0, 10, 1 * DEG);
        a.state.yaw = 2 * Math.PI - 1 * DEG;
        expect(draftStrength(a, b)).toBeGreaterThan(0);
        a.state.yaw = 1 * DEG;
        b.state.yaw = 2 * Math.PI - 1 * DEG;
        expect(draftStrength(a, b)).toBeGreaterThan(0);
        expect(draftStrength(...pair(0, 10, 0, 15, 15))).toBeGreaterThan(0);
        expect(draftStrength(...pair(0, 10, 0, 14.9, 20))).toBe(0);
        expect(draftStrength(...pair(0, 10, 0, 20, 14.9))).toBe(0);
    });

    it('is 0 with a ghost on either side, and from a car to itself (along 0)', () => {
        const [a, b] = pair(0, 10);
        b.state.ghostTicks = 1;
        expect(draftStrength(a, b)).toBe(0);
        b.state.ghostTicks = 0;
        a.mods.ghost = true;
        expect(draftStrength(a, b)).toBe(0);
        a.mods.ghost = false;
        expect(draftStrength(a, a)).toBe(0);
    });
});

describe('updateDrafts', () => {
    it('rises by 1/s and falls by 2/s towards the strongest target', () => {
        const [a, b] = pair(0, 15);
        const c = spawnCar(world, 'c', 'bulli', 0, 24, 0, 20);   // target 0.2 for a
        const cars = [a, b, c];
        updateDrafts(cars);
        expect(a.state.draft).toBeCloseTo(1 / 60, 15);
        for (let i = 1; i < 30; i++) updateDrafts(cars);
        expect(a.state.draft).toBeCloseTo(0.5, 12);
        for (let i = 0; i < 10; i++) updateDrafts(cars);
        expect(a.state.draft).toBeCloseTo(0.5, 12);
        // b drafts behind c, 9 m ahead of it (target 1 - 9/30 = 0.7), still
        // rising after 40 ticks
        expect(b.state.draft).toBeCloseTo(40 / 60, 12);
        b.state.x = 50;
        updateDrafts(cars);
        expect(a.state.draft).toBeCloseTo(0.5 - 2 / 60, 12);
        for (let i = 0; i < 9; i++) updateDrafts(cars);
        // Falls to c's 0.2 and stays there
        expect(a.state.draft).toBeCloseTo(0.2, 12);
    });

    it('handles a long column of cars: each drafts behind the next, the leader gets nothing', () => {
        const column = Array.from({ length: 12 }, (_, i) => spawnCar(world, `car-${String(i).padStart(2, '0')}`, 'beetle', 0, 10 * i, 0, 30));
        for (let tick = 0; tick < 60; tick++) updateDrafts(column);
        // 10 m to the car ahead: 1 - 10/30
        for (const car of column.slice(0, 11)) expect(car.state.draft).toBeCloseTo(2 / 3, 12);
        expect(column[11].state.draft).toBe(0);
    });

    it('takes every target from the positions before any draft changes, and leaves kinematic cars alone', () => {
        const [a, b] = pair(0, 15);
        b.kinematic = true;
        b.state.draft = 0.4;
        updateDrafts([b, a]);
        expect(a.state.draft).toBeCloseTo(1 / 60, 15);
        expect(b.state.draft).toBe(0.4);
    });
});

describe('slipstream in stepWorld', () => {
    function run(slipstream: boolean, follower: boolean, ticks: number) {
        const w = createLongWorld();
        if (slipstream) w.slipstream = true;
        const lead = spawnCar(w, 'b', 'bulli', 0, -3000, 0, 50);
        const cars = [lead];
        if (follower) cars.push(spawnCar(w, 'a', 'bulli', 0, -3015, 0, 50));
        let peak = 0, gap = 15;
        for (let tick = 0; tick < ticks; tick++) {
            for (const car of cars) car.input.throttle = 255;
            stepWorld(cars, w);
            if (follower) {
                const a = cars.find(car => car.id === 'a')!;
                peak = Math.max(peak, forwardSpeed(a.state));
                gap = Math.min(gap, lead.state.z - a.state.z);
            }
        }
        return { lead, peak, gap };
    }

    it('lets the car 15 m behind run faster than vtop + 2 m/s and close up (bulli, vtop 50)', () => {
        const { peak, gap } = run(true, true, 400);
        expect(peak).toBeGreaterThan(52);
        // Never more than vtop + 4 m/s (DRAFT_TOP_ADD at draft 1)
        expect(peak).toBeLessThan(54);
        expect(gap).toBeLessThan(8);
    });

    it('keeps a car alone at vtop (± 0.01) and changes nothing without world.slipstream', () => {
        const alone = run(true, false, 600).lead.state;
        expect(Math.abs(forwardSpeed(alone) - 50)).toBeLessThan(0.01);
        expect(alone.draft).toBe(0);
        const without = run(false, true, 400);
        expect(without.peak).toBeLessThan(50.01);
        expect(without.gap).toBeCloseTo(15, 1);
    });

    it('fills the boost meter with 0.08/s at draft 1', () => {
        const w = createLongWorld();
        const car = spawnCar(w, 'a', 'bulli', 0, 0, 0, 30);
        car.state.draft = 1;
        stepWorld([car], w);
        // No slipstream in this world: draft stays 1, no drift or air fill
        expect(car.state.boostMeter).toBeCloseTo(0.08 / 60, 15);
    });
});
