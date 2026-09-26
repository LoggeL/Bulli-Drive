import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SHOWROOM_FRAMING, SHOWROOM_SPOT, showroomStartPose } from '../../src/client/camera/showroom.js';

// The showroom's start pose (docs/ui.md 4.1), which the loading screen's key
// art is rendered from (tools/ui/keyart.ts): the camera has to stand on the
// pier deck, clear of its rails, three-quarter in front of the car.

const ROADS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/shared/maps/bulli-bay/roads.json');
const pier = (JSON.parse(readFileSync(ROADS, 'utf8')) as { areas: Array<{ id: string; polygon: [number, number][]; y: number }> })
    .areas.find(area => area.id === 'pier')!;
const xs = pier.polygon.map(p => p[0]);
const zs = pier.polygon.map(p => p[1]);

describe('the showroom start pose', () => {
    it('puts the landscape camera 8 m from the car, 1.4 m above the deck', () => {
        const pose = showroomStartPose(SHOWROOM_FRAMING.landscape, 5);
        // Direction 1.75 + 0.45 = 2.2 rad: sin 2.2 = 0.808496, cos 2.2 = -0.588501
        expect(pose.position[0]).toBeCloseTo(-745 + 8 * 0.808496, 4);
        expect(pose.position[1]).toBeCloseTo(6.4, 12);
        expect(pose.position[2]).toBeCloseTo(-18 + 8 * -0.588501, 4);
        expect(pose.lookAt).toEqual([-745, 5.8, -18]);
        expect(pose.fov).toBe(35);
        expect(pose.center).toEqual([0.68, 0.56]);
    });

    it('stands on the pier deck, at least a metre inside its rails, in every framing', () => {
        expect(pier.y).toBe(5);
        for (const framing of Object.values(SHOWROOM_FRAMING)) {
            const [x, , z] = showroomStartPose(framing, pier.y).position;
            expect(x).toBeGreaterThan(Math.min(...xs) + 1);
            expect(x).toBeLessThan(Math.max(...xs) - 1);
            expect(z).toBeGreaterThan(Math.min(...zs) + 1);
            expect(z).toBeLessThan(Math.max(...zs) - 1);
            // Looking at the car from the front: the camera is ahead of it
            const ahead = (x - SHOWROOM_SPOT.x) * Math.sin(SHOWROOM_SPOT.yaw) + (z - SHOWROOM_SPOT.z) * Math.cos(SHOWROOM_SPOT.yaw);
            expect(ahead).toBeGreaterThan(0.8 * framing.distance);
        }
    });
});
