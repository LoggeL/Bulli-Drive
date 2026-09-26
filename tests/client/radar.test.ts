import { describe, expect, it } from 'vitest';
import { radarNorth, radarOffset, radarRotation } from '../../src/client/ui/radar.js';

// The heading-up radar (src/client/ui/radar.ts, docs/phase-3-design.md E2
// and 15): north = -z, east = +x; what lies left of the car appears left of
// the centre, what lies ahead above it.

describe('the radar', () => {
    it('shows what lies ahead above the car and what lies left of it on the left', () => {
        // Facing north (yaw π): ahead is -z, left is west (-x)
        const ahead = radarOffset(0, -10, Math.PI);
        expect(ahead.x).toBeCloseTo(0, 12);
        expect(ahead.y).toBeCloseTo(-10, 12);
        const west = radarOffset(-10, 0, Math.PI);
        expect(west.x).toBeCloseTo(-10, 12);
        expect(west.y).toBeCloseTo(0, 12);
        // Facing east (yaw π/2): north is on the left, south on the right
        expect(radarOffset(0, -10, Math.PI / 2).x).toBeCloseTo(-10, 12);
        expect(radarOffset(0, 10, Math.PI / 2).x).toBeCloseTo(10, 12);
        // Facing south (yaw 0): east (+x) is on the left
        expect(radarOffset(10, 0, 0).x).toBeCloseTo(-10, 12);
        expect(radarOffset(0, 10, 0).y).toBeCloseTo(-10, 12);
    });

    it('keeps the north marker on the rim where north lies', () => {
        expect(radarNorth(Math.PI).y).toBeCloseTo(-1, 12);
        expect(radarNorth(Math.PI / 2).x).toBeCloseTo(-1, 12);
        expect(radarNorth(0).y).toBeCloseTo(1, 12);
    });

    it('turns the north-up map layer by the heading less half a turn', () => {
        // The layer's own axes are the world's (px with +x, py with +z):
        // turning it by radarRotation moves the car's forward to screen up
        for (const yaw of [0, 0.7, Math.PI / 2, 2.5, Math.PI, -1.2]) {
            const r = radarRotation(yaw);
            const fx = Math.sin(yaw), fz = Math.cos(yaw);
            expect(fx * Math.cos(r) - fz * Math.sin(r)).toBeCloseTo(0, 12);
            expect(fx * Math.sin(r) + fz * Math.cos(r)).toBeCloseTo(-1, 12);
        }
    });
});
