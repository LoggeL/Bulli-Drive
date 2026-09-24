// @vitest-environment happy-dom
import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { gameHooks } from '../../src/client/game/hooks.js';
import { state } from '../../src/client/state.js';
import { SANDBOX } from '../../src/shared/world/sandbox.js';
import { CAR_CLASS_IDS, VEHICLE_CLASSES } from '../../src/shared/sim/vehicleClasses.js';
import { resetTuning } from '../../src/shared/sim/tuning.js';

// The client side of the offline sandbox (?sandbox=1, src/client/sandbox/
// sandbox.ts, docs/phase-1a-design.md 12.7 and 13): it hands its world and
// five dummy cars to the local car's stepWorld, N puts the dummies back,
// C and the banner's button switch the body, and the tuning panel's
// import / reset reach the local car and the dummies. The sim of the
// dummies (laps, rams, determinism) is tested in tests/shared/sim/sandbox.test.ts.

// The KTX2 transcoder is a virtual module of the client build; nothing
// here loads a model or a texture
vi.mock('../../src/client/assets/gltfLoader.js', () => ({
    createGltfModelLoader: () => Promise.reject(new Error('no models in this test')),
    getKTX2Loader: () => null
}));

// The procedural car bodies paint a 2D canvas (the VW logo); happy-dom has
// none, so every drawing call is a no-op here
const noopContext = new Proxy({}, { get: () => () => undefined });

let driveLocalCar: typeof import('../../src/client/vehicle/v2Driver.js').driveLocalCar;
let tuningActions: typeof import('../../src/client/debug/tuningPanel.js').tuningActions;

const dummyCars = () => gameHooks.extraCars;
const DT = 1 / 60;

function frames(count: number): void {
    for (let i = 0; i < count; i++) driveLocalCar(state.bulli, DT);
}

function keyDown(key: string): void {
    window.dispatchEvent(new KeyboardEvent('keydown', { key }));
}

describe('the sandbox page', () => {
    beforeAll(async () => {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => noopContext as never);
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const overlay = document.createElement('div');
        overlay.id = 'ui-overlay';
        document.body.appendChild(overlay);
        state.scene = new THREE.Scene();
        ({ driveLocalCar } = await import('../../src/client/vehicle/v2Driver.js'));
        ({ tuningActions } = await import('../../src/client/debug/tuningPanel.js'));
        const { startSandbox } = await import('../../src/client/sandbox/sandbox.js');
        startSandbox();
        frames(1);
    });

    afterAll(() => {
        resetTuning();
        vi.restoreAllMocks();
    });

    it('steps five dummies of five bodies with the local car in the sandbox world', () => {
        expect(gameHooks.world).not.toBeNull();
        expect(state.bulli.vehicle.world).toBe(gameHooks.world);
        expect(dummyCars()).toHaveLength(5);
        expect(dummyCars().map(car => car.id)).toEqual(SANDBOX.dummies.map(spec => spec.id));
        expect(new Set(SANDBOX.dummies.map(spec => spec.classId))).toEqual(new Set(CAR_CLASS_IDS));
        // Each dummy drives with its own body's parameters
        dummyCars().forEach((car, i) => expect(car.params.mass).toBe(VEHICLE_CLASSES[SANDBOX.dummies[i].classId].mass));
        expect(document.body.classList.contains('sandbox')).toBe(true);
        expect([...document.querySelectorAll('#sandbox-banner button')].map(button => button.textContent?.trim()))
            .toEqual(['N Reset dummies', 'C Switch car']);
    });

    it('N puts the dummies back on their spots', () => {
        frames(120);
        const moved = dummyCars().filter((car, i) => Math.hypot(car.state.x - SANDBOX.dummies[i].x, car.state.z - SANDBOX.dummies[i].z) > 5);
        // The lapping ones are under way
        expect(moved.length).toBeGreaterThan(0);
        keyDown('n');
        dummyCars().forEach((car, i) => {
            expect(car.id).toBe(SANDBOX.dummies[i].id);
            expect(car.state.x).toBeCloseTo(SANDBOX.dummies[i].x, 9);
            expect(car.state.z).toBeCloseTo(SANDBOX.dummies[i].z, 9);
            expect(Math.hypot(car.state.vx, car.state.vz)).toBe(0);
        });
    });

    it('C and the Switch car button change the body, and the sim car follows', () => {
        expect(state.bulli.carType).toBe('bulli');
        const button = [...document.querySelectorAll<HTMLButtonElement>('#sandbox-banner button')]
            .find(candidate => candidate.textContent?.includes('Switch car'))!;
        button.click();
        expect(state.bulli.carType).toBe('pickup');
        frames(1);
        expect(state.bulli.vehicle.classId).toBe('pickup');
        keyDown('c');
        expect(state.bulli.carType).toBe('sport');
        frames(1);
        expect(state.bulli.vehicle.classId).toBe('sport');
        expect(localStorage.getItem('bulli-car-type')).toBe('sport');
    });

    it('takes an imported tuning into the local car and the dummies, and the reset back', () => {
        const classId = state.bulli.vehicle.classId as keyof typeof VEHICLE_CLASSES;
        const defaultTop = VEHICLE_CLASSES[classId].topSpeed;
        const dummy = dummyCars()[SANDBOX.dummies.findIndex(spec => spec.classId === classId)];
        tuningActions.import(JSON.stringify({ format: 1, classes: { [classId]: { topSpeed: 61 } } }));
        // The effective parameters follow with the next tick
        frames(1);
        expect(state.bulli.vehicle.car.params.topSpeed).toBe(61);
        expect(dummy.params.topSpeed).toBe(61);
        expect(JSON.parse(tuningActions.export()).classes).toEqual({ [classId]: { topSpeed: 61 } });
        tuningActions.reset();
        frames(1);
        expect(state.bulli.vehicle.car.params.topSpeed).toBe(defaultTop);
        expect(dummy.params.topSpeed).toBe(defaultTop);
    });
});
