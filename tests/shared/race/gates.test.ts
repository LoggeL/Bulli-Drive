import { describe, expect, it } from 'vitest';
import { crossGate, crossingTicks, gateSide } from '../../../src/shared/race/gates.js';
import type { GateDef } from '../../../src/shared/race/types.js';

// Gate crossing with a sub-tick fraction (docs/phase-2-design.md, 8), by
// hand: a gate through the origin facing +z (yaw 0), 10 m wide; its left
// axis (cos yaw, -sin yaw) is +x, GATE_TOLERANCE 1 m.

const gate: GateDef = { x: 0, z: 0, yaw: 0, width: 10, visual: 'arch' };

describe('crossGate', () => {
    it('counts (0,-1) -> (0,2) at a third of the tick', () => {
        expect(crossGate(gate, 0, -1, 0, 2)).toBeCloseTo(1 / 3, 15);
        expect(crossGate(gate, 3, -3, 3, 1)).toBeCloseTo(0.75, 15);
    });

    it('never counts backwards or a move that stays on one side', () => {
        expect(crossGate(gate, 0, 2, 0, -1)).toBe(-1);
        expect(crossGate(gate, 0, -3, 0, -1)).toBe(-1);
        expect(crossGate(gate, 0, 1, 0, 3)).toBe(-1);
    });

    it('counts within w/2 + 1 m of the centre, not beyond', () => {
        // Crossing point at x = ±6 exactly, and a diagonal whose crossing is
        // at x = 5.5 although both ends are farther out
        expect(crossGate(gate, 6, -1, 6, 1)).toBe(0.5);
        expect(crossGate(gate, -6, -1, -6, 1)).toBe(0.5);
        expect(crossGate(gate, 6.001, -1, 6.001, 1)).toBe(-1);
        expect(crossGate(gate, -6.001, -1, -6.001, 1)).toBe(-1);
        expect(crossGate(gate, 4, -1, 7, 1)).toBe(0.5);
        // ... and one crossing at x = 7 although it starts inside
        expect(crossGate(gate, 5, -1, 9, 1)).toBe(-1);
    });

    it('counts a car that stops on the line exactly once over two ticks', () => {
        expect(crossGate(gate, 0, -1, 0, 0)).toBe(1);
        expect(crossGate(gate, 0, 0, 0, 1)).toBe(-1);
    });

    it('turns with the gate: facing +x (yaw π/2), left is -z', () => {
        const east: GateDef = { x: 10, z: 20, yaw: Math.PI / 2, width: 10, visual: 'arch' };
        expect(gateSide(east, 8, 20)).toBeCloseTo(-2, 12);
        expect(crossGate(east, 8, 23, 12, 23)).toBeCloseTo(0.5, 12);
        expect(crossGate(east, 8, 26.5, 12, 26.5)).toBe(-1);
        expect(crossGate(east, 12, 23, 8, 23)).toBe(-1);
        // A diagonal crossing at z = 26.5, 6.5 m to the side, although it starts at z = 24
        expect(crossGate(east, 8, 24, 12, 29)).toBe(-1);
    });

    it('works at any angle: a gate facing north-east (yaw π/4)', () => {
        const diagonal: GateDef = { x: 0, z: 0, yaw: Math.PI / 4, width: 10, visual: 'arch' };
        const f = { x: Math.SQRT1_2, z: Math.SQRT1_2 }, l = { x: Math.SQRT1_2, z: -Math.SQRT1_2 };
        // Along f from -1 to +3 at 5.5 m to the left: t = 1/4, inside
        const at = (along: number, across: number): [number, number] => [f.x * along + l.x * across, f.z * along + l.z * across];
        expect(crossGate(diagonal, ...at(-1, 5.5), ...at(3, 5.5))).toBeCloseTo(0.25, 12);
        expect(crossGate(diagonal, ...at(-1, -5.5), ...at(3, -5.5))).toBeCloseTo(0.25, 12);
        expect(crossGate(diagonal, ...at(-1, 6.5), ...at(3, 6.5))).toBe(-1);
        expect(crossGate(diagonal, ...at(-1, -6.5), ...at(3, -6.5))).toBe(-1);
    });
});

describe('crossingTicks', () => {
    it('is T - 1 + t - startTick in float ticks', () => {
        expect(crossingTicks(100, 1 / 3, 40)).toBeCloseTo(59 + 1 / 3, 12);
        // A crossing in the very first tick of the race
        expect(crossingTicks(41, 0.5, 40)).toBe(0.5);
    });
});
