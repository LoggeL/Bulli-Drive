import { BTN_BOOST, BTN_HANDBRAKE, BTN_RESET } from '../../shared/sim/constants.js';
import type { VehicleInput } from '../../shared/sim/types.js';
import { clearPadState, createPadState, type PadState } from './gamepad.js';

// Input of the v2 physics (docs/phase-1a-design.md, section 11): keyboard,
// touch and gamepad become one quantised VehicleInput per sim tick. Shoot
// and honk stay events outside the sim. No DOM in here - keyboard.ts,
// mobile.ts and the frame loop feed it - so it can be tested in Node.

export type DriveKey = 'up' | 'down' | 'left' | 'right' | 'handbrake' | 'boost' | 'reset';

const KEY_BUTTONS: Partial<Record<DriveKey, number>> = {
    handbrake: BTN_HANDBRAKE,
    boost: BTN_BOOST,
    reset: BTN_RESET
};

// Joystick pulled down beyond this brakes (and reverses) instead
export const TOUCH_BRAKE_FROM = 0.45;

export interface DriveAxes {
    steer: number;      // -1..1, + = left
    throttle: number;   // 0..1
    brake: number;      // 0..1
}

export function createDriveAxes(): DriveAxes {
    return { steer: 0, throttle: 0, brake: 0 };
}

export function quantizeSteer(steer: number): number {
    const value = Number.isFinite(steer) ? Math.max(-1, Math.min(1, steer)) : 0;
    // + 0 turns -0 into 0
    return Math.round(value * 127) + 0;
}

export function quantizeUnit(value: number): number {
    const clamped = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
    return Math.round(clamped * 255);
}

/**
 * Touch stick (x right, y down, both -1..1 after deadzone and curve) to
 * drive axes: x steers, y below TOUCH_BRAKE_FROM brakes, otherwise auto-gas
 * or pushing the stick up gives gas.
 */
export function touchDriveAxes(x: number, y: number, autoGas: boolean, out: DriveAxes): DriveAxes {
    out.steer = -x + 0;
    if (y > TOUCH_BRAKE_FROM) {
        out.brake = Math.min(1, (y - TOUCH_BRAKE_FROM) / (1 - TOUCH_BRAKE_FROM));
        out.throttle = 0;
    } else {
        out.brake = 0;
        out.throttle = autoGas ? 1 : Math.max(0, -y);
    }
    return out;
}

/**
 * Touch in a race (docs/phase-2-design.md, 17.5): the stick only steers,
 * the BRAKE button brakes (and reverses at a standstill), auto-gas drives,
 * or without it the stick pushed up.
 */
export function raceTouchAxes(x: number, y: number, autoGas: boolean, brake: boolean, out: DriveAxes): DriveAxes {
    out.steer = -x + 0;
    out.brake = brake ? 1 : 0;
    out.throttle = brake ? 0 : autoGas ? 1 : Math.max(0, -y);
    return out;
}

/**
 * Held buttons plus a pulse latch: a press between two ticks reaches the
 * next tick even when the button was already released again.
 */
export class ButtonLatch {
    held = 0;
    pressed = 0;

    press(bits: number): void {
        this.held |= bits;
        this.pressed |= bits;
    }

    release(bits: number): void {
        this.held &= ~bits;
    }

    // Bits for this tick; clears the latched presses
    sample(): number {
        const bits = this.held | this.pressed;
        this.pressed = 0;
        return bits;
    }

    clear(): void {
        this.held = 0;
        this.pressed = 0;
    }
}

export type InputAction = 'shoot' | 'honk';

export class InputManager {
    // Keyboard
    private readonly keys = new Set<DriveKey>();
    private readonly keyLatch = new ButtonLatch();
    // Touch
    private stickX = 0;
    private stickY = 0;
    private stickActive = false;
    private readonly touchLatch = new ButtonLatch();
    private flipHeld = false;
    // Auto-gas starts with the first touch of the stick after a (re)spawn,
    // so the car does not drive off on its own while the player looks around
    autoGasEnabled = true;
    private autoGasArmed = false;
    // Whether the touch HUD is in use (phones, tablets)
    touchUi = false;
    // A race room: the touch layout of 17.5. Auto-gas there waits for the
    // race client instead of the stick: a tap on the GO zone or the tick
    // after green arms it (race/RaceClient.ts), so the launch stays a skill
    private raceTouchOn = false;
    private raceGasArmed = false;
    private brakeHeld = false;
    // Gamepad, polled once per frame
    private readonly pad: PadState = createPadState();
    private readonly padLatch = new ButtonLatch();
    private padShoot = false;
    private padHonk = false;
    onAction: ((action: InputAction) => void) | null = null;

    private readonly touchAxes = createDriveAxes();
    private readonly keyAxes = createDriveAxes();
    // Axes of the last tick, for the HUD and the engine sound
    readonly lastAxes = createDriveAxes();

    // ---- Keyboard ----

    // repeat: a key repeat of the browser. Held keys take it like a new
    // press, so a key still held after releaseKeys (respawn, modal, blur)
    // drives again at once; reset stays edge-triggered.
    keyDown(key: DriveKey, repeat = false): void {
        if (repeat && key === 'reset') return;
        this.keys.add(key);
        const bits = KEY_BUTTONS[key];
        if (bits) this.keyLatch.press(bits);
    }

    keyUp(key: DriveKey): void {
        this.keys.delete(key);
        const bits = KEY_BUTTONS[key];
        if (bits) this.keyLatch.release(bits);
    }

    releaseKeys(): void {
        this.keys.clear();
        this.keyLatch.clear();
    }

    // ---- Touch ----

    setStick(x: number, y: number, active: boolean): void {
        this.stickX = Number.isFinite(x) ? x : 0;
        this.stickY = Number.isFinite(y) ? y : 0;
        this.stickActive = active;
        if (active) this.autoGasArmed = true;
    }

    touchButton(bits: number, down: boolean): void {
        if (down) this.touchLatch.press(bits);
        else this.touchLatch.release(bits);
    }

    // The recover button (btn-flip): holding it for RESET_HOLD_TICKS resets
    // the car (there is no jump any more, docs/phase-1a-design.md 26)
    flipDown(): void {
        if (this.flipHeld) return;
        this.flipHeld = true;
        this.touchLatch.press(BTN_RESET);
    }

    flipUp(): void {
        if (!this.flipHeld) return;
        this.flipHeld = false;
        this.touchLatch.release(BTN_RESET);
    }

    get autoGasActive(): boolean {
        return this.touchUi && this.autoGasEnabled && (this.raceTouchOn ? this.raceGasArmed : this.autoGasArmed);
    }

    get raceTouch(): boolean {
        return this.raceTouchOn;
    }

    /** Race touch layout on or off (a race room or not); disarms the race auto-gas. */
    setRaceTouch(on: boolean): void {
        this.raceTouchOn = on;
        this.raceGasArmed = false;
        this.brakeHeld = false;
    }

    /** Race auto-gas on (the GO tap, or green passed) or off (a new countdown). */
    armRaceGas(armed: boolean): void {
        this.raceGasArmed = armed;
    }

    get raceGasOn(): boolean {
        return this.raceGasArmed;
    }

    // The BRAKE button of the race layout
    touchBrake(down: boolean): void {
        this.brakeHeld = down;
    }

    // Stick, touch buttons and auto-gas back to rest, e.g. on death/respawn
    releaseTouch(): void {
        this.stickX = this.stickY = 0;
        this.stickActive = false;
        this.flipHeld = false;
        this.touchLatch.clear();
        this.autoGasArmed = false;
        this.brakeHeld = false;
    }

    // ---- Gamepad ----

    // Called once per frame with the current pad (or null without one)
    setPad(pad: PadState | null): void {
        const next = pad ?? clearPadState(this.pad);
        if (next !== this.pad) Object.assign(this.pad, next);
        this.syncPadButton(BTN_HANDBRAKE, this.pad.handbrake);
        this.syncPadButton(BTN_BOOST, this.pad.boost);
        this.syncPadButton(BTN_RESET, this.pad.reset);
        if (this.pad.shoot && !this.padShoot) this.onAction?.('shoot');
        if (this.pad.honk && !this.padHonk) this.onAction?.('honk');
        this.padShoot = this.pad.shoot;
        this.padHonk = this.pad.honk;
    }

    private syncPadButton(bits: number, down: boolean): void {
        const held = (this.padLatch.held & bits) !== 0;
        if (down && !held) this.padLatch.press(bits);
        else if (!down && held) this.padLatch.release(bits);
    }

    // ---- Per tick ----

    /**
     * The input for one sim tick. Axes come from the active source with the
     * highest priority - touch, then gamepad, then keyboard; buttons are
     * combined from all of them. Auto-gas alone (stick released) yields to
     * a gamepad or keyboard in use, e.g. a controller on a tablet.
     */
    sampleTick(out: VehicleInput): VehicleInput {
        let axes: DriveAxes;
        const padActive = this.pad.steer !== 0 || this.pad.throttle > 0 || this.pad.brake > 0;
        const keysActive = this.keys.has('up') || this.keys.has('down') || this.keys.has('left') || this.keys.has('right');
        const touchActive = this.touchUi && (this.stickActive || this.brakeHeld || (this.autoGasActive && !padActive && !keysActive));
        if (touchActive) {
            axes = this.raceTouchOn
                ? raceTouchAxes(this.stickX, this.stickY, this.autoGasActive, this.brakeHeld, this.touchAxes)
                : touchDriveAxes(this.stickX, this.stickY, this.autoGasActive, this.touchAxes);
        } else if (padActive) {
            axes = this.pad;
        } else {
            axes = this.keyAxes;
            axes.steer = Number(this.keys.has('left')) - Number(this.keys.has('right'));
            axes.throttle = Number(this.keys.has('up'));
            axes.brake = Number(this.keys.has('down'));
        }
        out.steer = quantizeSteer(axes.steer);
        out.throttle = quantizeUnit(axes.throttle);
        out.brake = quantizeUnit(axes.brake);
        out.buttons = this.keyLatch.sample() | this.touchLatch.sample() | this.padLatch.sample();
        this.lastAxes.steer = out.steer / 127;
        this.lastAxes.throttle = out.throttle / 255;
        this.lastAxes.brake = out.brake / 255;
        return out;
    }

    releaseAll(): void {
        this.releaseKeys();
        this.releaseTouch();
        this.padLatch.clear();
    }
}

// The one input manager of the page
export const inputManager = new InputManager();
