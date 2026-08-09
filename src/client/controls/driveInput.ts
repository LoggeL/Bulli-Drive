import { state } from '../state.js';

interface DriveAxes {
    throttle: number;
    steer: number;
}

const keyboardAxes: DriveAxes = { throttle: 0, steer: 0 };
const touchAxes: DriveAxes = { throttle: 0, steer: 0 };
let touchActive = false;

function clampAxis(value: number): number {
    return Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
}

function commitDriveAxes() {
    const source = touchActive ? touchAxes : keyboardAxes;
    state.inputs.throttle = source.throttle;
    state.inputs.steer = source.steer;
}

/** Map digital keyboard state into the same axes used by the analog joystick. */
export function setKeyboardDriveAxes(throttle: number, steer: number) {
    keyboardAxes.throttle = clampAxis(throttle);
    keyboardAxes.steer = clampAxis(steer);
    commitDriveAxes();
}

/** Touch input takes precedence only while a finger/pointer owns the joystick. */
export function setTouchDriveAxes(throttle: number, steer: number, active: boolean) {
    touchAxes.throttle = clampAxis(throttle);
    touchAxes.steer = clampAxis(steer);
    touchActive = active;
    commitDriveAxes();
}

export function releaseTouchDriveAxes() {
    setTouchDriveAxes(0, 0, false);
}
