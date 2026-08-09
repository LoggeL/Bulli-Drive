import { state } from '../state.js';
import { setKeyboardDriveAxes } from './driveInput.js';

const heldDriveKeys = new Set<string>();

function syncDriveAxes() {
    const throttle = Number(heldDriveKeys.has('w')) - Number(heldDriveKeys.has('s'));
    const steer = Number(heldDriveKeys.has('a')) - Number(heldDriveKeys.has('d'));
    setKeyboardDriveAxes(throttle, steer);
}

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

function onKeyDown(e: KeyboardEvent) {
    if (document.activeElement?.tagName === 'INPUT') return;
    // Don't register new driving inputs while a modal/overlay is open.
    if (state.isModalOpen) return;
    // Let focused native/custom buttons handle Space themselves. Otherwise the
    // same press could both activate the button and queue vehicle recovery.
    if (spaceActivatesButton(e)) return;

    const key = e.key.toLowerCase();
    if (key === 'w' || key === 'a' || key === 's' || key === 'd') {
        heldDriveKeys.add(key);
        syncDriveAxes();
        e.preventDefault();
    } else if (key === ' ' && !e.repeat) {
        state.inputs.space = true;
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
    const key = e.key.toLowerCase();
    if (key === 'w' || key === 'a' || key === 's' || key === 'd') {
        heldDriveKeys.delete(key);
        syncDriveAxes();
        e.preventDefault();
    } else if (key === ' ') {
        // Actions are pulses consumed by Bulli.update. Clearing here can lose a
        // very quick key press between animation frames.
        e.preventDefault();
    }
}

export function releaseKeyboardInputs() {
    heldDriveKeys.clear();
    setKeyboardDriveAxes(0, 0);
    state.inputs.space = false;
    state.inputs.e = false;
    state.inputs.f = false;
}
