import { state } from '../state.js';
import { inputManager, type DriveKey } from '../input/InputManager.js';

export function initKeyboard() {
    window.addEventListener('keydown', onKeyDown, false);
    window.addEventListener('keyup', onKeyUp, false);
    window.addEventListener('blur', releaseKeyboardInputs, false);
    window.addEventListener('pagehide', releaseKeyboardInputs, false);
    window.addEventListener('orientationchange', releaseKeyboardInputs, false);
    document.addEventListener('visibilitychange', releaseKeyboardInputsWhenHidden, false);
}

function releaseKeyboardInputsWhenHidden() {
    if (document.hidden) releaseKeyboardInputs();
}

function spaceActivatesButton(e: KeyboardEvent): boolean {
    return e.key === ' '
        && e.target instanceof HTMLElement
        && !!e.target.closest('button, [role="button"]');
}

// Driving keys (docs/phase-1a-design.md, 11.2): arrows as well as WASD,
// Space handbrake, Shift boost, R held resets
const DRIVE_KEYS: Record<string, DriveKey> = {
    w: 'up', arrowup: 'up',
    s: 'down', arrowdown: 'down',
    a: 'left', arrowleft: 'left',
    d: 'right', arrowright: 'right',
    ' ': 'handbrake',
    shift: 'boost',
    r: 'reset'
};

/** The drive key a KeyboardEvent.key stands for, if any. */
export function driveKeyFor(key: string): DriveKey | undefined {
    return DRIVE_KEYS[key.toLowerCase()];
}

function onKeyDown(e: KeyboardEvent) {
    if (document.activeElement?.tagName === 'INPUT') return;
    // Don't register new driving inputs while a modal/overlay or the menu
    // is open (the arrows walk the menu there)
    if (state.isModalOpen || state.inMenu) return;
    // Let focused native/custom buttons handle Space themselves. Otherwise the
    // same press could both activate the button and queue vehicle recovery.
    if (spaceActivatesButton(e)) return;

    const key = e.key.toLowerCase();
    const driveKey = driveKeyFor(e.key);
    if (driveKey) {
        inputManager.keyDown(driveKey, e.repeat);
        e.preventDefault();
    } else if (key === 'e' && !e.repeat) {
        state.inputs.e = true;
    } else if (key === 'f' && !e.repeat) {
        state.inputs.f = true;
    }

    if (state.audioCtx && state.audioCtx.state === 'suspended') {
        state.audioCtx.resume();
    }
}

function onKeyUp(e: KeyboardEvent) {
    if (spaceActivatesButton(e)) return;
    const driveKey = driveKeyFor(e.key);
    if (driveKey) {
        inputManager.keyUp(driveKey);
        e.preventDefault();
    }
}

export function releaseKeyboardInputs() {
    inputManager.releaseKeys();
    state.inputs.e = false;
    state.inputs.f = false;
}
