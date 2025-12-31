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

    if (honkBtn) {
        honkBtn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            state.inputs.f = true;
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
}

function setupJoystick(containerId: string, onMove: (x: number, y: number) => void) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const stick = container.querySelector('.joystick-stick') as HTMLElement;
    if (!stick) return;

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

    container.addEventListener('touchstart', (e) => {
        if (activeTouchId !== null) return;
        const touch = e.changedTouches[0];
        activeTouchId = touch.identifier;
        handleTouch(touch);
    }, { passive: false });

    window.addEventListener('touchmove', (e) => {
        for (let i = 0; i < e.changedTouches.length; i++) {
            if (e.changedTouches[i].identifier === activeTouchId) {
                handleTouch(e.changedTouches[i]);
            }
        }
    }, { passive: false });

    const endTouch = (e: TouchEvent) => {
        for (let i = 0; i < e.changedTouches.length; i++) {
            if (e.changedTouches[i].identifier === activeTouchId) {
                activeTouchId = null;
                stick.style.transform = 'translate(0, 0)';
                onMove(0, 0);
            }
        }
    };

    window.addEventListener('touchend', endTouch);
    window.addEventListener('touchcancel', endTouch);
}
