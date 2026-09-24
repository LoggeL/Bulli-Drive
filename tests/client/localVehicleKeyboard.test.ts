import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { driveKeyFor } from '../../src/client/controls/keyboard.js';
import { inputManager, type DriveKey } from '../../src/client/input/InputManager.js';
import { assistProfileForDevice, LocalVehicle, type VehicleHost } from '../../src/client/vehicle/LocalVehicle.js';
import { DT } from '../../src/shared/sim/constants.js';
import { createFlatWorld } from '../../src/shared/sim/scenarios.js';

// The desktop keyboard on the v2 physics (docs/phase-1a-design.md, 11.2 and
// 14.8), through the client's own path: KeyboardEvent.key -> drive key ->
// InputManager -> LocalVehicle's fixed-step tick, one tick per 60 Hz frame
// on flat ground. Ticks, not wall-clock time, so the outcome is the same on
// any machine.

function createHost(): VehicleHost {
    const off = () => ({ active: false, timer: 0 });
    return {
        group: new THREE.Group(),
        flipGroup: new THREE.Group(),
        carType: 'bulli',
        powerups: { speed: off(), size: off(), jump: off(), shield: off(), magnet: off(), ghost: off() },
        speed: 0,
        maxSpeed: 0,
        angle: 0,
        isFlipping: false,
        canRecover: false
    };
}

function drive() {
    const vehicle = new LocalVehicle('local', 'bulli', 'standard', createFlatWorld());
    vehicle.place(0, 0, 0);
    const host = createHost();
    let now = 0;
    const tick = (count = 1, each?: () => void) => {
        for (let i = 0; i < count; i++) {
            now += DT * 1000;
            vehicle.update(DT, host, now);
            each?.();
        }
    };
    // The keys as the page gets them (KeyboardEvent.key)
    const press = (key: string) => inputManager.keyDown(driveKeyFor(key)!);
    const release = (key: string) => inputManager.keyUp(driveKeyFor(key)!);
    return { vehicle, tick, press, release };
}

const degrees = (rad: number) => rad * 180 / Math.PI;

describe('the drive keys', () => {
    it('map WASD, the arrows, Space, Shift, Q and R', () => {
        const expected: Record<string, DriveKey> = {
            w: 'up', W: 'up', ArrowUp: 'up',
            s: 'down', ArrowDown: 'down',
            a: 'left', ArrowLeft: 'left',
            d: 'right', ArrowRight: 'right',
            ' ': 'handbrake', Shift: 'boost', q: 'jump', Q: 'jump', r: 'reset'
        };
        for (const [key, drive] of Object.entries(expected)) expect(driveKeyFor(key), key).toBe(drive);
        // Shoot and honk are actions, not drive keys; the rest does nothing
        for (const key of ['e', 'f', 'Enter', 'Escape', 'x', 'Tab']) expect(driveKeyFor(key), key).toBeUndefined();
    });
});

describe('driving with the keyboard', () => {
    afterEach(() => inputManager.releaseAll());

    it('W speeds the car up along its heading, letting go slows it down', () => {
        const { vehicle, tick, press, release } = drive();
        press('w');
        tick(120);
        // 2 s of full throttle from a standstill: well past 40 km/h, straight ahead
        expect(vehicle.forwardSpeed).toBeGreaterThan(12);
        expect(vehicle.car.state.z).toBeGreaterThan(10);
        expect(Math.abs(vehicle.car.state.x)).toBeLessThan(0.01);
        release('w');
        const released = vehicle.forwardSpeed;
        tick(30);
        expect(vehicle.car.input.throttle).toBe(0);
        expect(vehicle.forwardSpeed).toBeLessThan(released);
    });

    it('Space and A at speed drift: the tail steps out and the car turns left', () => {
        const { vehicle, tick, press } = drive();
        press('w');
        tick(150);
        const yaw = vehicle.car.state.yaw;
        press(' ');
        press('a');
        let peak = 0;
        tick(90, () => { peak = Math.max(peak, Math.abs(vehicle.slipAngle)); });
        expect(degrees(peak)).toBeGreaterThan(5);
        // + yaw = to the left
        expect(vehicle.car.state.yaw - yaw).toBeGreaterThan(0.1);
    });

    it('S brakes to a stop and reverses only after 8 ticks at a standstill', () => {
        const { vehicle, tick, press } = drive();
        press('w');
        tick(120);
        inputManager.keyUp('up');
        press('s');
        const speeds: number[] = [];
        tick(240, () => speeds.push(vehicle.forwardSpeed));
        // Standstill: at or below 0.5 m/s forward; reverse: rolling backwards
        const stopped = speeds.findIndex(u => u <= 0.5);
        const reversing = speeds.findIndex(u => u < -0.05);
        expect(stopped).toBeGreaterThan(0);
        expect(reversing - stopped).toBeGreaterThanOrEqual(8);
        expect(Math.min(...speeds.slice(stopped, reversing))).toBeGreaterThan(-0.05);
        expect(speeds.at(-1)!).toBeLessThan(-1);
    });

    it('Q jumps once and the car lands again', () => {
        const { vehicle, tick, press, release } = drive();
        tick(10);
        // Pressed and released between two ticks: still exactly one jump
        press('q');
        release('q');
        let airborne = 0;
        tick(120, () => { if (!vehicle.car.state.grounded) airborne++; });
        expect(vehicle.jumps).toBe(1);
        expect(airborne).toBeGreaterThan(10);
        expect(vehicle.car.state.grounded).toBe(true);
    });

    it('R held for half a second resets the car at rest with a contact ghost, a tap does nothing', () => {
        const { vehicle, tick, press, release } = drive();
        press('w');
        tick(90);
        release('w');
        // A tap of 5 ticks, then long past the hold time
        press('r');
        tick(5);
        release('r');
        tick(40);
        expect(vehicle.resets).toBe(0);

        press('r');
        tick(29);
        expect(vehicle.resets).toBe(0);
        tick(1);
        expect(vehicle.resets).toBe(1);
        expect(Math.abs(vehicle.forwardSpeed)).toBeLessThan(0.5);
        expect(vehicle.car.state.ghostTicks).toBeGreaterThan(0);
        // Held on, it does not reset again
        tick(60);
        expect(vehicle.resets).toBe(1);
    });
});

describe('the assist profile', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('is touch on a coarse pointer (phones, tablets), standard otherwise', () => {
        const withPointer = (coarse: boolean) => vi.stubGlobal('window', {
            matchMedia: (query: string) => ({ matches: coarse && query === '(pointer: coarse)' })
        });
        withPointer(true);
        expect(assistProfileForDevice()).toBe('touch');
        withPointer(false);
        expect(assistProfileForDevice()).toBe('standard');
        vi.stubGlobal('window', {});
        expect(assistProfileForDevice()).toBe('standard');
    });
});
