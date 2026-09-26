// Gamepad with the W3C standard mapping (docs/phase-1a-design.md, 11.2):
// RT gas, LT brake/reverse (analog), left stick steers; A handbrake, B boost,
// X shoot, LB honk, View/Back held resets; Y is free. The mapping itself is
// pure so it can be tested without a browser.

export const PAD_STICK_DEADZONE = 0.12;
export const PAD_STEER_CURVE = 1.6;
export const PAD_TRIGGER_DEADZONE = 0.05;

// Button indices of the standard mapping
export const PAD_BUTTON = {
    A: 0,
    B: 1,
    X: 2,
    Y: 3,
    LB: 4,
    RB: 5,
    LT: 6,
    RT: 7,
    BACK: 8
} as const;

export interface PadButtonLike {
    pressed: boolean;
    value: number;
}

export interface PadLike {
    connected: boolean;
    mapping: string;
    axes: readonly number[];
    buttons: readonly PadButtonLike[];
}

export interface PadState {
    steer: number;      // -1..1, + = left
    throttle: number;   // 0..1
    brake: number;      // 0..1
    handbrake: boolean;
    boost: boolean;
    reset: boolean;
    shoot: boolean;
    honk: boolean;
}

export function createPadState(): PadState {
    return {
        steer: 0, throttle: 0, brake: 0,
        handbrake: false, boost: false, reset: false, shoot: false, honk: false
    };
}

// Radial deadzone on the stick: the magnitude below dz maps to 0 and the
// rest is stretched back to 0..1 along the same direction. Returns the
// scale factor for (x, y).
export function radialDeadzoneScale(x: number, y: number, deadzone: number): number {
    const magnitude = Math.hypot(x, y);
    if (magnitude <= deadzone) return 0;
    const remapped = Math.min(1, (magnitude - deadzone) / (1 - deadzone));
    return remapped / magnitude;
}

// Stick x (right = +1) to steer (left = +1) with the |x|^1.6 curve
export function padSteer(stickX: number, stickY: number): number {
    const x = stickX * radialDeadzoneScale(stickX, stickY, PAD_STICK_DEADZONE);
    const steer = -Math.sign(x) * Math.pow(Math.min(1, Math.abs(x)), PAD_STEER_CURVE);
    return steer + 0;
}

function trigger(button: PadButtonLike | undefined): number {
    if (!button) return 0;
    const value = Number.isFinite(button.value) ? button.value : (button.pressed ? 1 : 0);
    if (value <= PAD_TRIGGER_DEADZONE) return 0;
    return Math.min(1, (value - PAD_TRIGGER_DEADZONE) / (1 - PAD_TRIGGER_DEADZONE));
}

function pressed(pad: PadLike, index: number): boolean {
    return pad.buttons[index]?.pressed ?? false;
}

export function readPad(pad: PadLike, out: PadState): PadState {
    const stickX = Number.isFinite(pad.axes[0]) ? pad.axes[0] : 0;
    const stickY = Number.isFinite(pad.axes[1]) ? pad.axes[1] : 0;
    out.steer = padSteer(stickX, stickY);
    out.throttle = trigger(pad.buttons[PAD_BUTTON.RT]);
    out.brake = trigger(pad.buttons[PAD_BUTTON.LT]);
    out.handbrake = pressed(pad, PAD_BUTTON.A);
    out.boost = pressed(pad, PAD_BUTTON.B);
    out.reset = pressed(pad, PAD_BUTTON.BACK);
    out.shoot = pressed(pad, PAD_BUTTON.X);
    out.honk = pressed(pad, PAD_BUTTON.LB);
    return out;
}

export function clearPadState(out: PadState): PadState {
    out.steer = out.throttle = out.brake = 0;
    out.handbrake = out.boost = out.reset = out.shoot = out.honk = false;
    return out;
}

// First connected pad with the standard mapping, or null
export function findStandardPad(pads: ReadonlyArray<PadLike | null> | null | undefined): PadLike | null {
    if (!pads) return null;
    for (const pad of pads) {
        if (pad && pad.connected && pad.mapping === 'standard') return pad;
    }
    return null;
}
