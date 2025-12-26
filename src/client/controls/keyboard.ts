import { state } from '../state.js';

export function initKeyboard() {
    window.addEventListener('keydown', onKeyDown, false);
    window.addEventListener('keyup', onKeyUp, false);
}

function onKeyDown(e: KeyboardEvent) {
    if (document.activeElement?.tagName === 'INPUT') return;

    const key = e.key.toLowerCase();
    if (key === ' ') state.inputs.space = true;
    if (key === 'arrowleft') state.inputs.arrowleft = true;
    if (key === 'arrowright') state.inputs.arrowright = true;
    
    if (key in state.inputs) {
        (state.inputs as any)[key] = true;
    }
    
    if (state.audioCtx && state.audioCtx.state === 'suspended') {
        state.audioCtx.resume();
    }
}

function onKeyUp(e: KeyboardEvent) {
    const key = e.key.toLowerCase();
    if (key === ' ') state.inputs.space = false;
    if (key === 'arrowleft') state.inputs.arrowleft = false;
    if (key === 'arrowright') state.inputs.arrowright = false;
    
    // Don't reset 'f' on keyup, let Bulli.update consume it
    if (key in state.inputs && key !== 'f') {
        (state.inputs as any)[key] = false;
    }
}
