import { describe, expect, it } from 'vitest';
import {
    ButtonLatch, InputManager, createDriveAxes, quantizeSteer, quantizeUnit, raceTouchAxes, touchDriveAxes
} from '../../src/client/input/InputManager.js';
import {
    PAD_BUTTON, createPadState, findStandardPad, padSteer, radialDeadzoneScale, readPad, type PadLike
} from '../../src/client/input/gamepad.js';
import { BTN_BOOST, BTN_HANDBRAKE, BTN_RESET, SIM_TUNING } from '../../src/shared/sim/constants.js';
import { createVehicleInput } from '../../src/shared/sim/types.js';

function pad(overrides: { axes?: number[]; buttons?: Record<number, number> } = {}): PadLike {
    const buttons = Array.from({ length: 17 }, (_, index) => {
        const value = overrides.buttons?.[index] ?? 0;
        return { pressed: value > 0.5, value };
    });
    return { connected: true, mapping: 'standard', axes: overrides.axes ?? [0, 0, 0, 0], buttons };
}

describe('quantisation', () => {
    it('maps steer to -127..127 and pedals to 0..255', () => {
        expect(quantizeSteer(1)).toBe(127);
        expect(quantizeSteer(-1)).toBe(-127);
        expect(quantizeSteer(0.5)).toBe(64);
        expect(quantizeSteer(2)).toBe(127);
        expect(Object.is(quantizeSteer(-0.001), 0)).toBe(true);
        expect(quantizeSteer(Number.NaN)).toBe(0);
        expect(quantizeUnit(1)).toBe(255);
        expect(quantizeUnit(0.5)).toBe(128);
        expect(quantizeUnit(-1)).toBe(0);
        expect(quantizeUnit(Number.POSITIVE_INFINITY)).toBe(0);
    });
});

describe('ButtonLatch', () => {
    it('keeps a press that was released before the tick', () => {
        const latch = new ButtonLatch();
        latch.press(BTN_RESET);
        latch.release(BTN_RESET);
        expect(latch.sample()).toBe(BTN_RESET);
        expect(latch.sample()).toBe(0);
    });

    it('reports held buttons every tick', () => {
        const latch = new ButtonLatch();
        latch.press(BTN_HANDBRAKE);
        expect(latch.sample()).toBe(BTN_HANDBRAKE);
        expect(latch.sample()).toBe(BTN_HANDBRAKE);
        latch.release(BTN_HANDBRAKE);
        expect(latch.sample()).toBe(0);
    });
});

describe('touch', () => {
    it('brakes below the threshold and cuts the gas', () => {
        const axes = touchDriveAxes(0.5, 0.45 + 0.55 / 2, true, createDriveAxes());
        expect(axes.brake).toBeCloseTo(0.5, 9);
        expect(axes.throttle).toBe(0);
        expect(axes.steer).toBe(-0.5);
    });

    it('drives with auto-gas or with the stick pushed up', () => {
        expect(touchDriveAxes(0, 0.3, true, createDriveAxes())).toEqual({ steer: 0, throttle: 1, brake: 0 });
        expect(touchDriveAxes(0, -0.6, false, createDriveAxes()).throttle).toBeCloseTo(0.6, 9);
        expect(touchDriveAxes(0, 0.3, false, createDriveAxes()).throttle).toBe(0);
    });

    it('starts auto-gas with the first touch of the stick', () => {
        const input = new InputManager();
        input.touchUi = true;
        const out = createVehicleInput();
        expect(input.sampleTick(out).throttle).toBe(0);
        input.setStick(0, 0, true);
        input.setStick(0, 0, false);
        expect(input.sampleTick(out).throttle).toBe(255);
        input.autoGasEnabled = false;
        expect(input.sampleTick(out).throttle).toBe(0);
        input.autoGasEnabled = true;
        input.releaseTouch();
        expect(input.sampleTick(out).throttle).toBe(0);
    });

    it('holds reset while the recover button is down, and nothing else (no jump on a tap)', () => {
        const input = new InputManager();
        input.touchUi = true;
        const out = createVehicleInput();
        input.flipDown();
        expect(input.sampleTick(out).buttons).toBe(BTN_RESET);
        input.flipUp();
        expect(input.sampleTick(out).buttons).toBe(0);

        input.flipDown();
        for (let tick = 0; tick < SIM_TUNING.RESET_HOLD_TICKS; tick++) {
            expect(input.sampleTick(out).buttons).toBe(BTN_RESET);
        }
        input.flipUp();
        expect(input.sampleTick(out).buttons).toBe(0);
    });
});

describe('touch in a race (docs/phase-2-design.md, 17.5)', () => {
    it('steers with the stick only; the BRAKE button brakes and cuts the gas', () => {
        // Stick pulled far down: no brake in a race, only steering
        expect(raceTouchAxes(0.5, 0.9, true, false, createDriveAxes())).toEqual({ steer: -0.5, throttle: 1, brake: 0 });
        expect(raceTouchAxes(-1, 0, true, true, createDriveAxes())).toEqual({ steer: 1, throttle: 0, brake: 1 });
        // Without auto-gas the stick pushed up still gives gas
        expect(raceTouchAxes(0, -0.6, false, false, createDriveAxes())).toEqual({ steer: 0, throttle: 0.6, brake: 0 });
        expect(raceTouchAxes(0, 0.6, false, false, createDriveAxes())).toEqual({ steer: 0, throttle: 0, brake: 0 });
    });

    it('holds auto-gas back until the race client arms it, whatever the stick does', () => {
        const input = new InputManager();
        input.touchUi = true;
        input.setRaceTouch(true);
        const out = createVehicleInput();
        // Steering in the countdown: no gas
        input.setStick(0.4, 0, true);
        expect(input.sampleTick(out)).toEqual({ steer: -51, throttle: 0, brake: 0, buttons: 0 });
        input.setStick(0, 0, false);
        // GO: full gas from now on, with the stick released too
        input.armRaceGas(true);
        expect(input.sampleTick(out).throttle).toBe(255);
        // BRAKE held
        input.touchBrake(true);
        expect(input.sampleTick(out)).toEqual({ steer: 0, throttle: 0, brake: 255, buttons: 0 });
        input.touchBrake(false);
        expect(input.sampleTick(out).throttle).toBe(255);
        // A respawn releases the controls but keeps the race's gas; leaving
        // the race disarms it and the stick arms plain auto-gas again
        input.releaseTouch();
        expect(input.sampleTick(out).throttle).toBe(255);
        input.setRaceTouch(false);
        expect(input.sampleTick(out).throttle).toBe(0);
        input.setStick(0, 0, true);
        input.setStick(0, 0, false);
        expect(input.sampleTick(out).throttle).toBe(255);
        // The next race starts disarmed
        input.setRaceTouch(true);
        expect(input.sampleTick(out).throttle).toBe(0);
    });

    it('brakes with the button alone when auto-gas is switched off', () => {
        const input = new InputManager();
        input.touchUi = true;
        input.autoGasEnabled = false;
        input.setRaceTouch(true);
        input.touchBrake(true);
        expect(input.sampleTick(createVehicleInput())).toEqual({ steer: 0, throttle: 0, brake: 255, buttons: 0 });
    });
});

describe('gamepad', () => {
    it('has a radial deadzone and a steering curve', () => {
        expect(radialDeadzoneScale(0.1, 0.05, 0.12)).toBe(0);
        expect(padSteer(0.1, 0)).toBe(0);
        expect(padSteer(1, 0)).toBeCloseTo(-1, 9);
        expect(padSteer(-1, 0)).toBeCloseTo(1, 9);
        // Half way out of the deadzone: 0.5^1.6
        const half = 0.12 + 0.88 / 2;
        expect(padSteer(-half, 0)).toBeCloseTo(Math.pow(0.5, 1.6), 9);
    });

    it('reads the standard mapping', () => {
        const state = readPad(pad({
            axes: [1, 0, 0, 0],
            buttons: { [PAD_BUTTON.RT]: 1, [PAD_BUTTON.LT]: 0.525, [PAD_BUTTON.A]: 1, [PAD_BUTTON.X]: 1 }
        }), createPadState());
        expect(state.steer).toBeCloseTo(-1, 9);
        expect(state.throttle).toBe(1);
        expect(state.brake).toBeCloseTo(0.5, 9);
        expect(state.handbrake).toBe(true);
        expect(state.shoot).toBe(true);
        expect(state.boost).toBe(false);
    });

    it('picks the first connected standard pad', () => {
        const other = { ...pad(), mapping: '' };
        const standard = pad();
        expect(findStandardPad([null, other, standard])).toBe(standard);
        expect(findStandardPad(null)).toBe(null);
    });

    it('turns shoot and honk into single actions', () => {
        const input = new InputManager();
        const actions: string[] = [];
        input.onAction = action => actions.push(action);
        const state = createPadState();
        state.shoot = true;
        input.setPad(state);
        input.setPad(state);
        state.shoot = false;
        state.honk = true;
        input.setPad(state);
        expect(actions).toEqual(['shoot', 'honk']);
    });
});

describe('InputManager', () => {
    it('drives with the keyboard', () => {
        const input = new InputManager();
        const out = createVehicleInput();
        input.keyDown('up');
        input.keyDown('left');
        input.keyDown('handbrake');
        expect(input.sampleTick(out)).toEqual({ steer: 127, throttle: 255, brake: 0, buttons: BTN_HANDBRAKE });
        input.keyUp('up');
        input.keyDown('down');
        input.keyDown('right');
        expect(input.sampleTick(out)).toEqual({ steer: 0, throttle: 0, brake: 255, buttons: BTN_HANDBRAKE });
        input.releaseKeys();
        expect(input.sampleTick(out)).toEqual({ steer: 0, throttle: 0, brake: 0, buttons: 0 });
    });

    it('takes key repeats for held keys, but not for reset', () => {
        const input = new InputManager();
        const out = createVehicleInput();
        input.keyDown('up');
        input.keyDown('boost');
        // Respawn, modal or blur while the keys stay held
        input.releaseKeys();
        input.keyDown('up', true);
        input.keyDown('boost', true);
        input.keyDown('reset', true);
        expect(input.sampleTick(out)).toEqual({ steer: 0, throttle: 255, brake: 0, buttons: BTN_BOOST });
    });

    it('does not lose a boost tap pressed and released between two ticks', () => {
        const input = new InputManager();
        const out = createVehicleInput();
        input.keyDown('boost');
        input.keyUp('boost');
        expect(input.sampleTick(out).buttons).toBe(BTN_BOOST);
        expect(input.sampleTick(out).buttons).toBe(0);
    });

    it('prefers touch over gamepad over keyboard and combines the buttons', () => {
        const input = new InputManager();
        const out = createVehicleInput();
        input.keyDown('up');
        input.keyDown('boost');
        const padState = createPadState();
        padState.steer = -1;
        padState.brake = 1;
        padState.handbrake = true;
        input.setPad(padState);
        expect(input.sampleTick(out)).toEqual({ steer: -127, throttle: 0, brake: 255, buttons: BTN_BOOST | BTN_HANDBRAKE });

        input.touchUi = true;
        input.setStick(-1, -1, true);
        expect(input.sampleTick(out)).toEqual({ steer: 127, throttle: 255, brake: 0, buttons: BTN_BOOST | BTN_HANDBRAKE });

        // Without a touch UI the stick does not count
        input.touchUi = false;
        input.setPad(null);
        expect(input.sampleTick(out)).toEqual({ steer: 0, throttle: 255, brake: 0, buttons: BTN_BOOST });
    });

    it('lets a gamepad or the keyboard take over from auto-gas once the stick is released', () => {
        const input = new InputManager();
        const out = createVehicleInput();
        input.touchUi = true;
        input.setStick(0.3, 0, true);
        input.setStick(0, 0, false);
        expect(input.sampleTick(out)).toEqual({ steer: 0, throttle: 255, brake: 0, buttons: 0 });
        const padState = createPadState();
        padState.steer = 1;
        padState.brake = 1;
        input.setPad(padState);
        expect(input.sampleTick(out)).toEqual({ steer: 127, throttle: 0, brake: 255, buttons: 0 });
        input.setPad(null);
        input.keyDown('right');
        expect(input.sampleTick(out)).toEqual({ steer: -127, throttle: 0, brake: 0, buttons: 0 });
        // Pad and keys idle: auto-gas is back, and a held stick always wins
        input.keyUp('right');
        expect(input.sampleTick(out).throttle).toBe(255);
        input.setPad(padState);
        input.setStick(-1, 0, true);
        expect(input.sampleTick(out)).toEqual({ steer: 127, throttle: 255, brake: 0, buttons: 0 });
    });
});
