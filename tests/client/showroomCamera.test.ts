// @vitest-environment happy-dom
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ShowroomCamera, type ShowroomEnv } from '../../src/client/camera/ShowroomCamera.js';
import { spawnHintFor, SHOWROOM_SPOT, TRANSITION } from '../../src/client/camera/showroom.js';

// The menu's showroom on the game camera (src/client/camera/ShowroomCamera.ts,
// docs/ui.md 4.1 and 6) with a scripted clock: which frames it draws (lite
// still, the phones' 30 fps), and that every way into the game ends, also
// when the spawn never comes (a race that runs already: the player watches).
// The poses themselves: showroom.test.ts.

function setup(overrides: Partial<ShowroomEnv> = {}) {
    const clock = { t: 0 };
    let spawned = false;
    const env: ShowroomEnv = {
        groundHeight: () => 5,
        carFree: () => !spawned,
        spawned: () => spawned,
        frame: () => null,
        spawnHint: () => null,
        reducedMotion: () => false,
        lite: false,
        maxFps: 0,
        now: () => clock.t,
        ...overrides
    };
    const showroom = new ShowroomCamera(env);
    const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 2600);
    // The chase camera behind the spawned car, far from the pier
    const chase = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2600);
    chase.position.set(400, 8, 300);
    chase.lookAt(400, 2, 310);
    chase.updateMatrixWorld();
    const canvas = document.createElement('canvas');
    // One frame of the game loop (main.ts): update, draw if it may, the still after drawing
    const frame = (ms = 1000 / 60): boolean => {
        clock.t += ms;
        showroom.update(camera, null, chase);
        const drawn = showroom.shouldDraw(clock.t);
        if (drawn) showroom.afterRender(canvas);
        return drawn;
    };
    return { showroom, camera, chase, clock, frame, spawn: () => { spawned = true; } };
}

// Runs frames until the way into the game ends (or `seconds` pass): the seconds it took
async function drive(scene: ReturnType<typeof setup>, seconds: number): Promise<number | null> {
    let ended = false;
    void scene.showroom.startTransition(scene.camera).then(() => { ended = true; });
    const start = scene.clock.t;
    while (scene.clock.t - start < seconds * 1000) {
        scene.frame();
        await Promise.resolve();
        if (ended) return (scene.clock.t - start) / 1000;
    }
    return null;
}

describe('the showroom\'s frames', () => {
    it('draws a lite still for 0.7 s after a change, then nothing until the next change', () => {
        const scene = setup({ lite: true });
        const drawn = () => Array.from({ length: 60 }, () => scene.frame()).filter(Boolean).length;
        // One second at 60 fps: the first 0.7 s of it
        expect(drawn()).toBe(42);
        expect(drawn()).toBe(0);
        scene.showroom.invalidate();
        expect(drawn()).toBe(42);
        expect(scene.showroom.paced).toBe(true);
    });

    it('draws at most 30 fps on phones, every frame on the desktop', () => {
        const phone = setup({ maxFps: 30 });
        expect(Array.from({ length: 60 }, () => phone.frame()).filter(Boolean).length).toBe(30);
        expect(phone.showroom.paced).toBe(true);
        const desktop = setup();
        expect(Array.from({ length: 60 }, () => desktop.frame()).filter(Boolean).length).toBe(60);
        expect(desktop.showroom.paced).toBe(false);
    });

    it('draws every frame of the way into the game, and counts them for the adaptive resolution again', async () => {
        const phone = setup({ maxFps: 30 });
        phone.spawn();
        void phone.showroom.startTransition(phone.camera);
        expect(phone.showroom.paced).toBe(false);
        expect(Array.from({ length: 30 }, () => phone.frame()).every(Boolean)).toBe(true);
    });
});

describe('the way into the game', () => {
    it('cranes into the sky, cuts to the spawn and lands on the chase camera', async () => {
        const scene = setup();
        scene.spawn();
        const seconds = await drive(scene, 10);
        // Up in 0.7 s, down in 1.1 s
        expect(seconds).toBeCloseTo(TRANSITION.rise + TRANSITION.descend, 1);
        expect(scene.showroom.busy).toBe(false);
        expect(scene.camera.position.distanceTo(scene.chase.position)).toBeLessThan(1e-6);
    });

    it('comes down after waiting 2 s in the sky when the spawn never comes', async () => {
        const scene = setup();
        const seconds = await drive(scene, 10);
        expect(seconds).toBeCloseTo(TRANSITION.rise + TRANSITION.maxHold + TRANSITION.descend, 1);
    });

    it('flies directly to a near spawn, and after the same wait when the spawn never comes', async () => {
        const near = { x: SHOWROOM_SPOT.x + 100, z: SHOWROOM_SPOT.z };
        const spawned = setup({ spawnHint: () => near });
        spawned.spawn();
        expect(await drive(spawned, 10)).toBeCloseTo(TRANSITION.direct, 1);
        // No spawn (a race that runs already): the menu must not hang
        const waiting = setup({ spawnHint: () => near });
        expect(await drive(waiting, 10)).toBeCloseTo(TRANSITION.rise + TRANSITION.maxHold + TRANSITION.direct, 1);
        expect(waiting.showroom.busy).toBe(false);
    });

    it('cross-fades from a still with reduced motion, also when the spawn never comes', async () => {
        const scene = setup({ reducedMotion: () => true });
        const seconds = await drive(scene, 10);
        expect(seconds).toBeCloseTo(TRANSITION.rise + TRANSITION.maxHold + TRANSITION.fade, 1);
        // The still is gone with it
        expect(document.querySelector('.showroom-still')).toBeNull();
    });
});

describe('the spawn the way into the game may count on', () => {
    const preview = { x: -700, z: -30 };

    it('is the room\'s preview in a Party or Free Roam room the menu goes on with', () => {
        expect(spawnHintFor('party', 'party', preview)).toEqual(preview);
        expect(spawnHintFor('freeroam', 'freeroam', preview)).toEqual(preview);
    });

    it('is unknown in a race room (its preview is a free-roam spot), on a switch of the room, and before the room', () => {
        expect(spawnHintFor('race', 'race', preview)).toBeNull();
        expect(spawnHintFor('timetrial', 'race', preview)).toBeNull();
        expect(spawnHintFor('party', 'freeroam', preview)).toBeNull();
        expect(spawnHintFor(null, 'party', preview)).toBeNull();
        expect(spawnHintFor('party', 'party', null)).toBeNull();
    });
});
