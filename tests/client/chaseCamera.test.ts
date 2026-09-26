// @vitest-environment happy-dom
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ChaseCamera, RACE_CAMERA, type ChaseTarget } from '../../src/client/camera/ChaseCamera.js';

// The low race camera (docs/phase-1a-design.md, 12.5) of
// src/client/camera/ChaseCamera.ts: it sits low and close behind the car -
// the old camera hung 23 m up - swings in behind it after a turn and does
// not trail far behind at speed. The window is a desktop one (happy-dom has
// no coarse pointer), 16:9 unless a test says otherwise.

function horizontal(a: THREE.Vector3, b: THREE.Vector3): number {
    return Math.hypot(a.x - b.x, a.z - b.z);
}

// Signed distance of the camera ahead of the car along its heading
function ahead(camera: THREE.Vector3, target: ChaseTarget): number {
    return (camera.x - target.position.x) * Math.sin(target.yaw) + (camera.z - target.position.z) * Math.cos(target.yaw);
}

function run(chase: ChaseCamera, camera: THREE.PerspectiveCamera, target: ChaseTarget, seconds: number, speed = 0): void {
    const dt = 1 / 60;
    for (let t = 0; t < seconds; t += dt) {
        target.position.x += Math.sin(target.yaw) * speed * dt;
        target.position.z += Math.cos(target.yaw) * speed * dt;
        chase.update(dt, camera, target, false);
    }
}

describe('the race camera', () => {
    it('snaps low and close behind a standing car', () => {
        const chase = new ChaseCamera(RACE_CAMERA);
        const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
        const target: ChaseTarget = { position: new THREE.Vector3(120, 2, -40), yaw: 0, speedRatio: 0, boost: false };
        expect(chase.update(1 / 60, camera, target, true)).toBe(true);
        const height = camera.position.y - target.position.y;
        expect(height).toBeGreaterThan(2);
        expect(height).toBeLessThan(10);
        expect(horizontal(camera.position, target.position)).toBeGreaterThan(6);
        expect(horizontal(camera.position, target.position)).toBeLessThan(15);
        // Straight behind, looking at the car: the car is in front of the
        // camera and near the middle of the picture
        expect(ahead(camera.position, target)).toBeLessThan(-6);
        expect(Math.abs(camera.position.x - target.position.x)).toBeLessThan(1e-9);
        camera.updateMatrixWorld();
        const onScreen = target.position.clone().project(camera);
        expect(onScreen.z).toBeLessThan(1);
        expect(Math.abs(onScreen.x)).toBeLessThan(0.05);
        expect(Math.abs(onScreen.y)).toBeLessThan(0.5);
    });

    it('follows a car at speed without trailing far behind', () => {
        const chase = new ChaseCamera(RACE_CAMERA);
        const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
        const target: ChaseTarget = { position: new THREE.Vector3(0, 0, 0), yaw: 0, speedRatio: 0, boost: false };
        chase.update(1 / 60, camera, target, true);
        // 50 m/s, the top speed, with boost
        target.speedRatio = 1;
        target.boost = true;
        run(chase, camera, target, 3, 50);
        expect(camera.position.y - target.position.y).toBeLessThan(10);
        expect(horizontal(camera.position, target.position)).toBeLessThan(18);
        expect(ahead(camera.position, target)).toBeLessThan(0);
        // Wider at speed than standing, never beyond the cap
        expect(camera.fov).toBeGreaterThan(RACE_CAMERA.baseFov);
        expect(camera.fov).toBeLessThanOrEqual(RACE_CAMERA.maxFov);
    });

    it('swings in behind the car after a turn, the short way round', () => {
        const chase = new ChaseCamera(RACE_CAMERA);
        const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
        const target: ChaseTarget = { position: new THREE.Vector3(0, 0, 0), yaw: 3.0, speedRatio: 0.3, boost: false };
        chase.update(1 / 60, camera, target, true);
        // From 3.0 rad to -3.0 rad is 0.28 rad across ±π, not 6 rad back
        target.yaw = -3.0;
        chase.update(1 / 60, camera, target, false);
        const firstStep = camera.position.clone();
        run(chase, camera, target, 2, 10);
        expect(ahead(camera.position, target)).toBeLessThan(-6);
        const side = (camera.position.x - target.position.x) * Math.cos(target.yaw) - (camera.position.z - target.position.z) * Math.sin(target.yaw);
        expect(Math.abs(side)).toBeLessThan(1);
        // The first frame moved only a little (no whip around the car)
        expect(horizontal(firstStep, new THREE.Vector3(Math.sin(3) * -11, 0, Math.cos(3) * -11))).toBeLessThan(1);
    });

    it('snaps after a teleport instead of flying across the map', () => {
        const chase = new ChaseCamera(RACE_CAMERA);
        const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
        const target: ChaseTarget = { position: new THREE.Vector3(0, 0, 0), yaw: 0, speedRatio: 0, boost: false };
        chase.update(1 / 60, camera, target, true);
        target.position.set(5, 0, 0);
        expect(chase.update(1 / 60, camera, target, false)).toBe(false);
        target.position.set(300, 0, 300);
        expect(chase.update(1 / 60, camera, target, false)).toBe(true);
        expect(horizontal(camera.position, target.position)).toBeLessThan(15);
    });

    it('follows a steady climb without falling behind in height', () => {
        // 30 m/s up a 20 % grade: 6 m/s upwards for 3 s. Only the camera's
        // own position damping remains (6 m/s over 12/s: 0.5 m below)
        const chase = new ChaseCamera(RACE_CAMERA);
        const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
        const target: ChaseTarget = { position: new THREE.Vector3(0, 0, 0), yaw: 0, speedRatio: 0.5, boost: false };
        chase.update(1 / 60, camera, target, true);
        const standing = camera.position.y - target.position.y;
        for (let frame = 0; frame < 180; frame++) {
            target.position.z += 30 / 60;
            target.position.y += 6 / 60;
            chase.update(1 / 60, camera, target, false);
        }
        expect(camera.position.y - target.position.y).toBeGreaterThan(standing - 0.6);
        expect(camera.position.y - target.position.y).toBeLessThan(standing + 0.1);
    });

    it('rises with a car in the air and eases the landing instead of jolting', () => {
        // A hop: 8 m/s up at take-off, gravity 20 m/s², 0.8 s in the air,
        // down at 8 m/s onto the flat again, then 1.5 s on the ground
        const chase = new ChaseCamera(RACE_CAMERA);
        const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
        const target: ChaseTarget = { position: new THREE.Vector3(0, 0, 0), yaw: 0, speedRatio: 0.5, boost: false };
        chase.update(1 / 60, camera, target, true);
        const standing = camera.position.y;
        const heights: number[] = [];
        let top = 0;
        for (let frame = 0; frame < 138; frame++) {
            const t = (frame + 1) / 60;
            target.position.y = t < 0.8 ? 8 * t - 10 * t * t : 0;
            target.position.z += 30 / 60;
            chase.update(1 / 60, camera, target, false);
            heights.push(camera.position.y);
            if (Math.abs(t - 0.4) < 1e-9) top = camera.position.y;
        }
        // At the top of the hop (1.6 m) the camera has come up most of it
        expect(top - standing).toBeGreaterThan(0.8);
        // The car's vertical speed jumps by 8 m/s at take-off and landing;
        // the camera's changes by at most 0.8 m/s from one frame to the next
        // (following the height directly, only the position damping would
        // smooth it: 8 · (1 - e^(-12/60)) = 1.45 m/s)
        let maxStep = 0;
        for (let i = 2; i < heights.length; i++) {
            const step = Math.abs((heights[i] - heights[i - 1]) - (heights[i - 1] - heights[i - 2])) * 60;
            maxStep = Math.max(maxStep, step);
        }
        expect(maxStep).toBeLessThan(0.8);
        // No deep dip below its standing height, and back there afterwards
        expect(Math.min(...heights)).toBeGreaterThan(standing - 0.6);
        expect(heights[heights.length - 1]).toBeCloseTo(standing, 1);
    });

    it('backs off in a portrait window, where the car would fill half the width', () => {
        const target: ChaseTarget = { position: new THREE.Vector3(0, 0, 0), yaw: 0, speedRatio: 0, boost: false };
        const wide = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
        const tall = new THREE.PerspectiveCamera(60, 390 / 664, 0.1, 1000);
        new ChaseCamera(RACE_CAMERA).update(1 / 60, wide, target, true);
        new ChaseCamera(RACE_CAMERA).update(1 / 60, tall, target, true);
        expect(horizontal(tall.position, target.position)).toBeGreaterThan(horizontal(wide.position, target.position) * 1.3);
        // But no higher than 5 m: the signal heads over the lanes hang from
        // 5.06 m, a camera above them looks down through their arms
        expect(tall.position.y).toBeLessThanOrEqual(5 + 1e-9);
        expect(tall.position.y).toBeGreaterThanOrEqual(wide.position.y - 1e-9);
    });
});
