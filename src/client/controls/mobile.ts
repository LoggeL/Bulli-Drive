import { state } from '../state.js';
import { releaseTouchDriveAxes, setTouchDriveAxes } from './driveInput.js';

const JOYSTICK_DEADZONE = 0.12;
const JOYSTICK_RESPONSE_CURVE = 1.15;
const JOYSTICK_FILTER_RATE = 18;

interface ControlHandle {
    reset(): void;
    destroy(): void;
}

type ActionKey = 'e' | 'f' | 'space';

const activeControls: ControlHandle[] = [];
let removeLifecycleListeners: (() => void) | null = null;

export function setupMobileControls() {
    // Make setup idempotent for hot reloads/reinitialisation.
    destroyMobileControls();

    setupJoystick('joystick-move', (x, y, active) => {
        // DOM Y grows downwards, while positive throttle means forward. The
        // steering sign preserves the established A/left and D/right behavior.
        setTouchDriveAxes(-y, -x, active);
    });

    setupActionButton('btn-honk', 'f');
    setupActionButton('btn-flip', 'space');
    setupActionButton('btn-shoot', 'e');

    const resetForLifecycle = () => resetMobileControls();
    const resetWhenHidden = () => {
        if (document.hidden) resetMobileControls();
    };
    window.addEventListener('blur', resetForLifecycle);
    window.addEventListener('pagehide', resetForLifecycle);
    window.addEventListener('orientationchange', resetForLifecycle);
    document.addEventListener('visibilitychange', resetWhenHidden);
    removeLifecycleListeners = () => {
        window.removeEventListener('blur', resetForLifecycle);
        window.removeEventListener('pagehide', resetForLifecycle);
        window.removeEventListener('orientationchange', resetForLifecycle);
        document.removeEventListener('visibilitychange', resetWhenHidden);
    };
}

export function resetMobileControls() {
    activeControls.forEach(control => control.reset());
    releaseTouchDriveAxes();
    state.inputs.e = false;
    state.inputs.f = false;
    state.inputs.space = false;
}

export function destroyMobileControls() {
    resetMobileControls();
    while (activeControls.length) activeControls.pop()!.destroy();
    removeLifecycleListeners?.();
    removeLifecycleListeners = null;
}

function setupActionButton(elementId: string, key: ActionKey): ControlHandle | null {
    const button = document.getElementById(elementId);
    if (!button) return null;

    let activePointerId: number | null = null;

    const queueAction = () => {
        if (state.isModalOpen) return;
        // Keep the pulse set until Bulli.update consumes it. Clearing it on a
        // fast pointerup can otherwise drop taps that happen between frames.
        state.inputs[key] = true;

        if (state.audioCtx?.state === 'suspended') {
            void state.audioCtx.resume();
        }
    };

    const release = (pointerId?: number) => {
        if (activePointerId === null) return;
        if (pointerId !== undefined && pointerId !== activePointerId) return;

        const capturedPointer = activePointerId;
        activePointerId = null;
        if (button.hasPointerCapture(capturedPointer)) {
            button.releasePointerCapture(capturedPointer);
        }
        button.classList.remove('active');
    };

    const reset = () => {
        release();
        state.inputs[key] = false;
    };

    const onPointerDown = (event: PointerEvent) => {
        if (activePointerId !== null || state.isModalOpen) return;
        event.preventDefault();
        activePointerId = event.pointerId;
        button.setPointerCapture(event.pointerId);
        button.classList.add('active');
        queueAction();
    };

    const onPointerUp = (event: PointerEvent) => release(event.pointerId);
    const onLostCapture = (event: PointerEvent) => release(event.pointerId);
    const onClick = (event: MouseEvent) => {
        // Native pointer clicks have already queued the action on pointerdown.
        // detail=0 covers keyboard, VoiceOver and switch-control activation.
        if (event.detail === 0) queueAction();
    };

    button.addEventListener('pointerdown', onPointerDown);
    button.addEventListener('pointerup', onPointerUp);
    button.addEventListener('pointercancel', onPointerUp);
    button.addEventListener('lostpointercapture', onLostCapture);
    button.addEventListener('click', onClick);

    const handle: ControlHandle = {
        reset,
        destroy() {
            reset();
            button.removeEventListener('pointerdown', onPointerDown);
            button.removeEventListener('pointerup', onPointerUp);
            button.removeEventListener('pointercancel', onPointerUp);
            button.removeEventListener('lostpointercapture', onLostCapture);
            button.removeEventListener('click', onClick);
        }
    };
    activeControls.push(handle);
    return handle;
}

function setupJoystick(
    containerId: string,
    onMove: (x: number, y: number, active: boolean) => void
): ControlHandle | null {
    const container = document.getElementById(containerId);
    if (!container) return null;
    const base = container.querySelector('.joystick-base') as HTMLElement | null;
    const stick = container.querySelector('.joystick-stick') as HTMLElement | null;
    if (!base || !stick) return null;

    let activePointerId: number | null = null;
    let targetX = 0;
    let targetY = 0;
    let filteredX = 0;
    let filteredY = 0;
    let lastFrameTime = 0;
    let animationFrame = 0;

    const stopFilterLoop = () => {
        if (animationFrame) cancelAnimationFrame(animationFrame);
        animationFrame = 0;
        lastFrameTime = 0;
    };

    const filterFrame = (now: number) => {
        if (activePointerId === null) {
            stopFilterLoop();
            return;
        }

        const dt = lastFrameTime ? Math.min((now - lastFrameTime) / 1000, 1 / 15) : 1 / 60;
        lastFrameTime = now;
        const blend = 1 - Math.exp(-JOYSTICK_FILTER_RATE * dt);
        filteredX += (targetX - filteredX) * blend;
        filteredY += (targetY - filteredY) * blend;
        onMove(filteredX, filteredY, true);
        animationFrame = requestAnimationFrame(filterFrame);
    };

    const updatePointer = (event: PointerEvent) => {
        const baseRect = base.getBoundingClientRect();
        const stickRect = stick.getBoundingClientRect();
        const centerX = baseRect.left + baseRect.width / 2;
        const centerY = baseRect.top + baseRect.height / 2;
        const radius = Math.max(1, Math.min(baseRect.width, baseRect.height) / 2);
        const dx = event.clientX - centerX;
        const dy = event.clientY - centerY;
        const distance = Math.hypot(dx, dy);
        const rawMagnitude = Math.min(1, distance / radius);
        const unitX = distance > 0 ? dx / distance : 0;
        const unitY = distance > 0 ? dy / distance : 0;

        let outputMagnitude = 0;
        if (rawMagnitude > JOYSTICK_DEADZONE) {
            const remapped = (rawMagnitude - JOYSTICK_DEADZONE) / (1 - JOYSTICK_DEADZONE);
            outputMagnitude = Math.pow(remapped, JOYSTICK_RESPONSE_CURVE);
        }
        // Convert the circular gesture into independent drive axes. At the
        // outer diagonal both axes can still reach 1, matching keyboard W+A
        // instead of unintentionally cutting throttle to roughly 70%.
        const dominantDirection = Math.max(Math.abs(unitX), Math.abs(unitY), 0.0001);
        const axisScale = outputMagnitude / dominantDirection;
        targetX = Math.max(-1, Math.min(1, unitX * axisScale));
        targetY = Math.max(-1, Math.min(1, unitY * axisScale));

        // Keep the visual knob inside the base even when the pointer travels
        // beyond it; the logical axes remain clamped independently above.
        const stickRadius = Math.max(stickRect.width, stickRect.height) / 2;
        const visualRadius = Math.max(1, radius - stickRadius - 2);
        const visualDistance = rawMagnitude * visualRadius;
        stick.style.transform = `translate(${unitX * visualDistance}px, ${unitY * visualDistance}px)`;
    };

    const release = (pointerId?: number) => {
        if (activePointerId === null) return;
        if (pointerId !== undefined && pointerId !== activePointerId) return;

        const capturedPointer = activePointerId;
        activePointerId = null;
        if (container.hasPointerCapture(capturedPointer)) {
            container.releasePointerCapture(capturedPointer);
        }
        stopFilterLoop();
        targetX = 0;
        targetY = 0;
        filteredX = 0;
        filteredY = 0;
        stick.style.transform = 'translate(0, 0)';
        container.classList.remove('active');
        onMove(0, 0, false);
    };

    const onPointerDown = (event: PointerEvent) => {
        if (activePointerId !== null || state.isModalOpen) return;
        event.preventDefault();
        activePointerId = event.pointerId;
        container.setPointerCapture(event.pointerId);
        container.classList.add('active');
        updatePointer(event);
        animationFrame = requestAnimationFrame(filterFrame);

        if (state.audioCtx?.state === 'suspended') {
            void state.audioCtx.resume();
        }
    };

    const onPointerMove = (event: PointerEvent) => {
        if (event.pointerId !== activePointerId) return;
        event.preventDefault();
        updatePointer(event);
    };
    const onPointerUp = (event: PointerEvent) => release(event.pointerId);
    const onLostCapture = (event: PointerEvent) => release(event.pointerId);

    container.style.touchAction = 'none';
    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerup', onPointerUp);
    container.addEventListener('pointercancel', onPointerUp);
    container.addEventListener('lostpointercapture', onLostCapture);

    const handle: ControlHandle = {
        reset: release,
        destroy() {
            release();
            container.removeEventListener('pointerdown', onPointerDown);
            container.removeEventListener('pointermove', onPointerMove);
            container.removeEventListener('pointerup', onPointerUp);
            container.removeEventListener('pointercancel', onPointerUp);
            container.removeEventListener('lostpointercapture', onLostCapture);
        }
    };
    activeControls.push(handle);
    return handle;
}
