import { state } from '../state.js';

export function setupMobileControls() {
    setupJoystick('joystick-move', (x, y) => {
        state.inputs.w = y < -0.3;
        state.inputs.s = y > 0.3;
        state.inputs.a = x < -0.3;
        state.inputs.d = x > 0.3;
    });

    setupJoystick('joystick-camera', (x, y) => {
        state.inputs.arrowleft = x < -0.3;
        state.inputs.arrowright = x > 0.3;
    });

    const honkBtn = document.getElementById('btn-honk');
    const flipBtn = document.getElementById('btn-flip');
    const shootBtn = document.getElementById('btn-shoot');

    if (honkBtn) {
        honkBtn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            state.inputs.f = true;
        });
        honkBtn.addEventListener('touchend', (e) => {
            e.preventDefault();
            state.inputs.f = false;
        });
    }

    if (flipBtn) {
        flipBtn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            state.inputs.space = true;
        });
        flipBtn.addEventListener('touchend', (e) => {
            e.preventDefault();
            state.inputs.space = false;
        });
    }

    if (shootBtn) {
        shootBtn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            state.inputs.e = true;
        });
        shootBtn.addEventListener('touchend', (e) => {
            e.preventDefault();
            state.inputs.e = false;
        });
    }
}

interface JoystickHandle {
    destroy(): void;
}

const activeJoysticks: JoystickHandle[] = [];

export function destroyMobileControls() {
    while (activeJoysticks.length) {
        activeJoysticks.pop()!.destroy();
    }
}

function setupJoystick(containerId: string, onMove: (x: number, y: number) => void): JoystickHandle | null {
    const container = document.getElementById(containerId);
    if (!container) return null;
    const stick = container.querySelector('.joystick-stick') as HTMLElement;
    if (!stick) return null;

    let activeTouchId: number | null = null;

    const handleTouch = (touch: Touch) => {
        const rect = container.getBoundingClientRect();
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;
        const maxRadius = rect.width / 2;

        const dx = touch.clientX - (rect.left + centerX);
        const dy = touch.clientY - (rect.top + centerY);
        const dist = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx);

        const moveRadius = Math.min(dist, maxRadius);
        const moveX = Math.cos(angle) * moveRadius;
        const moveY = Math.sin(angle) * moveRadius;

        stick.style.transform = `translate(${moveX}px, ${moveY}px)`;
        onMove(moveX / maxRadius, moveY / maxRadius);
    };

    const onStart = (e: TouchEvent) => {
        if (activeTouchId !== null) return;
        const touch = e.changedTouches[0];
        activeTouchId = touch.identifier;
        handleTouch(touch);
    };

    const onMoveTouch = (e: TouchEvent) => {
        for (let i = 0; i < e.changedTouches.length; i++) {
            if (e.changedTouches[i].identifier === activeTouchId) {
                handleTouch(e.changedTouches[i]);
            }
        }
    };

    const onEnd = (e: TouchEvent) => {
        for (let i = 0; i < e.changedTouches.length; i++) {
            if (e.changedTouches[i].identifier === activeTouchId) {
                activeTouchId = null;
                stick.style.transform = 'translate(0, 0)';
                onMove(0, 0);
            }
        }
    };

    container.addEventListener('touchstart', onStart, { passive: false });
    window.addEventListener('touchmove', onMoveTouch, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);

    const handle: JoystickHandle = {
        destroy() {
            container.removeEventListener('touchstart', onStart);
            window.removeEventListener('touchmove', onMoveTouch);
            window.removeEventListener('touchend', onEnd);
            window.removeEventListener('touchcancel', onEnd);
        }
    };
    activeJoysticks.push(handle);
    return handle;
}
