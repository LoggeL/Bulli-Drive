import { state } from '../state.js';
import { releaseKeyboardInputs } from '../controls/keyboard.js';
import { resetMobileControls } from '../controls/mobile.js';

/**
 * Initialize the splash screen: car selector, start button, and enter-key handler.
 * The onStart callback receives (name, carType) so main.ts can handle
 * audio, sounds, car rebuild, server notification, and hiding the splash.
 */
export function initSplashScreen(onStart: (name: string, carType: string) => Promise<void>): void {
    const splashInput = document.getElementById('splash-name-input') as HTMLInputElement;
    const startBtn = document.getElementById('start-btn');

    // Car selector logic
    const carCards = document.querySelectorAll('.car-card');
    let selectedCarType = localStorage.getItem('bulli-car-type') || 'bulli';

    // Restore saved selection
    carCards.forEach(card => {
        const el = card as HTMLElement;
        if (el.dataset.car === selectedCarType) {
            carCards.forEach(c => c.classList.remove('selected'));
            el.classList.add('selected');
        }
        el.addEventListener('click', () => {
            carCards.forEach(c => c.classList.remove('selected'));
            el.classList.add('selected');
            selectedCarType = el.dataset.car || 'bulli';
        });
    });

    if (startBtn && splashInput) {
        startBtn.addEventListener('click', async () => {
            const name = splashInput.value.trim() || "Player";
            // The hidden splash input/button must not retain focus after the
            // game starts, otherwise gameplay keys (especially Space) are
            // correctly treated as form/button input and never reach the car.
            splashInput.blur();
            startBtn.blur();
            await onStart(name, selectedCarType);
        });

        // Allow Enter key to start
        splashInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') startBtn.click();
        });
    }
}

/**
 * Initialize the about modal: link click opens modal, close button and backdrop dismiss it.
 */
export function initAboutModal(): void {
    const aboutLink = document.getElementById('about-link');
    const modalContainer = document.getElementById('modal-container');
    const modalClose = document.getElementById('modal-close');
    const modalBackdrop = modalContainer?.querySelector('.modal-backdrop');

    function showModal() {
        if (modalContainer) {
            modalContainer.inert = false;
            modalContainer.classList.remove('hidden');
            state.isModalOpen = true;
            // Drop any held keys so the car doesn't keep driving behind the modal
            // (and doesn't resume on close because a keyup was missed).
            releaseKeyboardInputs();
            resetMobileControls();
        }
    }

    function hideModal() {
        if (modalContainer) {
            const focused = document.activeElement;
            if (focused instanceof HTMLElement && modalContainer.contains(focused)) {
                focused.blur();
            }
            modalContainer.classList.add('hidden');
            modalContainer.inert = true;
            state.isModalOpen = false;
        }
    }

    if (modalContainer?.classList.contains('hidden')) {
        modalContainer.inert = true;
    }

    if (aboutLink) {
        aboutLink.addEventListener('click', (e) => {
            e.preventDefault();
            showModal();
        });
    }

    if (modalClose) {
        modalClose.addEventListener('click', hideModal);
    }

    if (modalBackdrop) {
        modalBackdrop.addEventListener('click', hideModal);
    }
}

/**
 * Initialize the rename UI: toggle button shows/hides the name form,
 * submit button sends a rename message to the server.
 */
export function initRenameUI(): void {
    const nameToggle = document.getElementById('name-toggle');
    const nameForm = document.getElementById('name-form');
    const nameSubmit = document.getElementById('name-submit');
    const nameInput = document.getElementById('name-input') as HTMLInputElement;

    if (nameToggle && nameForm) {
        nameToggle.addEventListener('click', () => {
            nameForm.classList.toggle('hidden');
            if (!nameForm.classList.contains('hidden') && nameInput) {
                nameInput.focus();
            }
        });
    }

    if (nameSubmit && nameInput) {
        const savedName = localStorage.getItem('bulli-player-name');
        if (savedName) {
            nameInput.placeholder = savedName;
        }

        nameSubmit.addEventListener('click', () => {
            const newName = nameInput.value.trim();
            if (newName) {
                localStorage.setItem('bulli-player-name', newName);
                if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                    state.ws.send(JSON.stringify({
                        type: 'rename',
                        name: newName
                    }));
                }
                nameInput.value = '';
                nameInput.placeholder = newName;
                state.myName = newName;

                // Update local nametag (only the name span, not the whole
                // element, so its child structure survives).
                if (state.bulli && state.bulli.nametag) {
                    const nameEl = state.bulli.nametag.querySelector('.nametag-name');
                    if (nameEl) nameEl.textContent = newName;
                }

                // Collapse the form after successful rename
                if (nameForm) {
                    nameForm.classList.add('hidden');
                }
            }
        });
        nameInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') nameSubmit.click();
        });
    }
}
