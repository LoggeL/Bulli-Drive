import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    cameraStateOf, cutPitch, directPose, fitDistance, heroAngleFor, SHOWROOM_DISTANCE, SHOWROOM_FRAMING, SHOWROOM_PERIOD_S, SHOWROOM_SPOT, showroomPose, showroomStartPose, showroomSwing,
    TRANSITION, transitionKind, transitionPose, type CameraState
} from '../../src/client/camera/showroom.js';

// The showroom's start pose (docs/ui.md 4.1), which the loading screen's key
// art is rendered from (tools/ui/keyart.ts): the camera has to stand on the
// pier deck, clear of its rails, three-quarter in front of the car.

const ROADS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/shared/maps/bulli-bay/roads.json');
const pier = (JSON.parse(readFileSync(ROADS, 'utf8')) as { areas: Array<{ id: string; polygon: [number, number][]; y: number }> })
    .areas.find(area => area.id === 'pier')!;
const xs = pier.polygon.map(p => p[0]);
const zs = pier.polygon.map(p => p[1]);

describe('the showroom start pose', () => {
    it('puts the landscape camera 10 m from the car, 1.4 m above the deck', () => {
        const pose = showroomStartPose(SHOWROOM_FRAMING.landscape, 5);
        // 10 m out the hero angle stops at the rail: cos(direction) = -5.8 / 10,
        // so z = -18 - 5.8 and x = -745 + 10 * sqrt(1 - 0.58²) = -745 + 8.14616
        expect(pose.position[0]).toBeCloseTo(-745 + 8.14616, 4);
        expect(pose.position[1]).toBeCloseTo(6.4, 12);
        expect(pose.position[2]).toBeCloseTo(-23.8, 9);
        expect(pose.lookAt).toEqual([-745, 5.8, -18]);
        expect(pose.fov).toBe(35);
        expect(pose.center).toEqual([0.64, 0.38]);
    });

    it('comes round from the front when a wide shot would stand over the rail', () => {
        // Up to acos(-5.8 / d) - 1.75: at 10 m 2.1882 - 1.75 = 0.438 < 0.45
        expect(heroAngleFor(8)).toBe(0.45);
        expect(heroAngleFor(10)).toBeCloseTo(Math.acos(-0.58) - 1.75, 12);
        expect(heroAngleFor(15)).toBeCloseTo(Math.acos(-5.8 / 15) - 1.75, 12);
        expect(heroAngleFor(15)).toBeLessThan(heroAngleFor(10));
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

describe('the showroom swing', () => {
    it('starts at the key art pose and swings 30 degrees towards the nose at half the period', () => {
        for (const framing of Object.values(SHOWROOM_FRAMING)) {
            expect(showroomPose(0, framing, 5)).toEqual(showroomStartPose(framing, 5));
        }
        expect(showroomSwing(0)).toBeCloseTo(0, 15);
        expect(showroomSwing(SHOWROOM_PERIOD_S / 2)).toBeCloseTo(-30 * Math.PI / 180, 12);
        expect(showroomSwing(SHOWROOM_PERIOD_S)).toBeCloseTo(0, 12);
        // A quarter period: half way, (1 - cos 90°) / 2 = 0.5
        expect(showroomSwing(SHOWROOM_PERIOD_S / 4)).toBeCloseTo(-15 * Math.PI / 180, 12);
        expect(SHOWROOM_PERIOD_S).toBe(40);
    });

    it('keeps the camera still with reduced motion', () => {
        expect(showroomSwing(13, true)).toBe(0);
        expect(showroomPose(13, SHOWROOM_FRAMING.landscape, 5, { reducedMotion: true })).toEqual(showroomStartPose(SHOWROOM_FRAMING.landscape, 5));
    });

    it('stays on the deck, a metre inside the rails, over the whole swing in every framing', () => {
        for (const framing of Object.values(SHOWROOM_FRAMING)) {
            for (let t = 0; t <= SHOWROOM_PERIOD_S; t += 0.5) {
                const [x, , z] = showroomPose(t, framing, pier.y).position;
                expect(z, `${framing.distance} m at ${t} s`).toBeGreaterThan(Math.min(...zs) + 1);
                expect(z, `${framing.distance} m at ${t} s`).toBeLessThan(Math.max(...zs) - 1);
                expect(x).toBeLessThan(Math.max(...xs) - 1);
            }
        }
    });

    it('puts the car where the menu asks, the camera as far out as asked', () => {
        const pose = showroomPose(0, SHOWROOM_FRAMING.landscape, 5, { center: [0.3, 0.5], distance: 12 });
        expect(pose.center).toEqual([0.3, 0.5]);
        expect(Math.hypot(pose.position[0] + 745, pose.position[2] + 18)).toBeCloseTo(12, 9);
    });

    it('stays on the deck at every distance the menu can ask for', () => {
        for (let distance = SHOWROOM_DISTANCE.min; distance <= SHOWROOM_DISTANCE.max; distance += 0.5) {
            for (let t = 0; t <= SHOWROOM_PERIOD_S; t += 1) {
                const z = showroomPose(t, SHOWROOM_FRAMING.portrait, 5, { distance }).position[2];
                expect(z, `${distance} m at ${t} s`).toBeGreaterThan(Math.min(...zs) + 1);
                expect(z, `${distance} m at ${t} s`).toBeLessThan(Math.max(...zs) - 1);
            }
        }
    });
});

describe('fitting the car into the menu\'s free box', () => {
    // The Bulli is 0.54 of the frame high at 8 m and 35°, so at d it is
    // 4.32 / d (times tan 17.5° / tan(fov / 2) for another FOV)
    it('stands back until the car fills 70 % of the box height', () => {
        // Desktop 16:10, a box of 80 % x 71 %: 4.32 / (0.7 * 0.71) = 8.69 m
        // (the width would do with 4.32 * 1.5 / 1.6 / (0.72 * 0.8) = 7.03 m)
        expect(fitDistance(SHOWROOM_FRAMING.landscape, [0.8, 0.71], 1.6)).toBeCloseTo(4.32 / (0.7 * 0.71), 9);
    });

    it('stands further back when the box is narrow (the car is 1.5 times as wide as high)', () => {
        // Upright, 9:16, FOV 55°: lens tan 17.5° / tan 27.5° = 0.60659; the
        // width asks 4.32 * 0.60659 * 1.5 / 0.5625 / (0.72 * 1) = 9.71 m,
        // the height only 4.32 * 0.60659 / (0.7 * 0.66) = 5.67 m
        const lens = Math.tan(17.5 * Math.PI / 180) / Math.tan(27.5 * Math.PI / 180);
        expect(fitDistance(SHOWROOM_FRAMING.portrait, [1, 0.66], 0.5625)).toBeCloseTo(4.32 * lens * 1.5 / 0.5625 / 0.72, 9);
    });

    it('keeps the camera between 7 and 15 m', () => {
        expect(fitDistance(SHOWROOM_FRAMING.landscape, [1, 1], 1.6)).toBe(7);
        expect(fitDistance(SHOWROOM_FRAMING.portrait, [1, 0.05], 0.46)).toBe(15);
    });
});

describe('the way into the game', () => {
    const from = cameraStateOf(showroomStartPose(SHOWROOM_FRAMING.landscape, 5));
    // The chase camera behind a car at the Party arena, 600 m away
    const to: CameraState = { position: [-160, 14, 520], yaw: 1.2, pitch: -0.12, fov: 62, center: [0.5, 0.5] };

    it('looks from the showroom camera at the car', () => {
        // Camera 10 m out at 1.4 m, looking at 0.8 m: 0.6 m down over 10 m
        expect(from.pitch).toBeCloseTo(Math.atan2(-0.6, 10), 12);
        expect(from.yaw).toBeCloseTo(1.75 + heroAngleFor(10) - Math.PI, 12);
    });

    it('starts at the showroom and ends at the chase camera', () => {
        expect(transitionPose(0, from, to, 1)).toEqual(from);
        const end = transitionPose(1 + TRANSITION.descend, from, to, 1);
        end.position.forEach((v, i) => expect(v).toBeCloseTo(to.position[i], 9));
        expect(end.yaw).toBeCloseTo(to.yaw, 9);
        expect(end.pitch).toBeCloseTo(to.pitch, 9);
        expect(end.fov).toBeCloseTo(to.fov, 9);
    });

    it('sees only sky at the cut: the lower frame edge 10 degrees above the horizon, no shifted projection', () => {
        // 35° FOV: 17.5° + 10° = 27.5°
        expect(cutPitch(35)).toBeCloseTo(27.5 * Math.PI / 180, 12);
        for (const t of [TRANSITION.rise, 1.5, 2.49]) {
            const pose = transitionPose(t, from, to, 2.5);
            expect(pose.pitch - pose.fov / 2 * Math.PI / 180).toBeGreaterThanOrEqual(10 * Math.PI / 180 - 1e-9);
            expect(pose.center).toEqual([0.5, 0.5]);
            expect(pose.position[1]).toBeCloseTo(from.position[1] + TRANSITION.height, 9);
        }
        // Right after the cut: over the spawn, the same view direction
        const after = transitionPose(2.5, from, to, 2.5);
        expect(after.position[0]).toBeCloseTo(to.position[0], 9);
        expect(after.position[1]).toBeCloseTo(to.position[1] + TRANSITION.height, 9);
        expect([after.yaw, after.pitch, after.fov]).toEqual([from.yaw, cutPitch(from.fov), from.fov]);
    });

    it('never cuts before the camera is up, even when the spawn is there at once', () => {
        const early = transitionPose(TRANSITION.rise - 0.01, from, to, 0);
        expect(early.position[0]).toBeCloseTo(from.position[0], 9);
        // At the top the cut comes, and the flight down starts from there
        const top = transitionPose(TRANSITION.rise, from, to, 0);
        expect(top.position[0]).toBeCloseTo(to.position[0], 9);
        expect(top.position[1]).toBeCloseTo(to.position[1] + TRANSITION.height, 9);
    });

    it('moves without jumps between 1 ms samples except at the cut', () => {
        const cutAt = 1.3;
        let previous = transitionPose(0, from, to, cutAt);
        for (let ms = 1; ms <= (cutAt + TRANSITION.descend) * 1000 + 50; ms++) {
            const t = ms / 1000;
            const pose = transitionPose(t, from, to, cutAt);
            const step = Math.hypot(...pose.position.map((v, i) => v - previous.position[i]) as [number, number, number]);
            const crossesCut = t >= cutAt && t - 0.001 < cutAt;
            if (!crossesCut) {
                // 45 m in 0.7 s peaks at 1.5 x 45 / 0.7 = 96 m/s: under 0.1 m per ms
                expect(step, `${ms} ms`).toBeLessThan(0.1 + 600 * 1.5 / 1100);
                expect(Math.abs(pose.pitch - previous.pitch), `${ms} ms`).toBeLessThan(0.01);
                expect(Math.abs(Math.atan2(Math.sin(pose.yaw - previous.yaw), Math.cos(pose.yaw - previous.yaw))), `${ms} ms`).toBeLessThan(0.01);
            } else {
                // The cut keeps the view direction: only the position jumps
                expect(pose.pitch).toBeCloseTo(previous.pitch, 9);
                expect(pose.yaw).toBeCloseTo(previous.yaw, 9);
            }
            previous = pose;
        }
    });

    it('turns the short way round to the chase camera', () => {
        const behind: CameraState = { ...to, yaw: from.yaw + 2 * Math.PI - 0.2 };
        const mid = transitionPose(1 + TRANSITION.descend / 2, from, behind, 1);
        // Half of the -0.2 rad turn, not half of a full circle
        expect(mid.yaw).toBeCloseTo(from.yaw - 0.1, 9);
    });

    it('flies directly to a near spawn, crossfades with reduced motion and in lite graphics', () => {
        expect(transitionKind({ reducedMotion: false, lite: false, spawnDistance: 600 })).toBe('crane');
        expect(transitionKind({ reducedMotion: false, lite: false, spawnDistance: null })).toBe('crane');
        expect(transitionKind({ reducedMotion: false, lite: false, spawnDistance: 149 })).toBe('direct');
        expect(transitionKind({ reducedMotion: true, lite: false, spawnDistance: 600 })).toBe('fade');
        expect(transitionKind({ reducedMotion: false, lite: true, spawnDistance: 20 })).toBe('fade');
        expect(directPose(0, from, to)).toEqual(from);
        expect(directPose(TRANSITION.direct, from, to).position).toEqual(to.position);
    });
});

