import { graphicsSetting, safeModeReason, setGraphicsSetting, type GraphicsSetting } from '../../render/safeMode.js';
import { setSoundEnabled, soundEnabled } from '../../effects/sounds.js';
import { releaseKeyboardInputs } from '../../controls/keyboard.js';
import { resetMobileControls } from '../../controls/mobile.js';
import { state } from '../../state.js';

// The settings and About dialogs of the menu (docs/ui.md 4.3), also opened
// from the room menu in the game: graphics Auto / Lite / High (from the
// next load, render/safeMode.ts), sound on / off (effects/sounds.ts) and
// the controls per input. Native <dialog>: focus trap and Esc come with
// it. While one is open the car does not take input (state.isModalOpen).

type ControlsTab = 'keyboard' | 'touch' | 'gamepad';

let initialized = false;
// The graphics setting of this load; another one needs a reload
let loadedGraphics: GraphicsSetting = 'auto';

function dialog(id: string): HTMLDialogElement | null {
    return document.getElementById(id) as HTMLDialogElement | null;
}

const DIALOG_IDS = ['settings-dialog', 'about-dialog'];

/** Whether a menu dialog is open. */
export function dialogOpen(): boolean {
    return DIALOG_IDS.some(id => dialog(id)?.open);
}

export function closeOpenDialog(): void {
    for (const id of DIALOG_IDS) if (dialog(id)?.open) dialog(id)!.close();
}

/** The gamepad walks through the open dialog's controls. */
export function moveDialogFocus(step: number): void {
    const open = DIALOG_IDS.map(dialog).find(d => d?.open);
    if (!open) return;
    const items = [...open.querySelectorAll<HTMLElement>('button:not([hidden]):not([disabled]), [tabindex="0"]')]
        .filter(item => item.offsetParent !== null || item === document.activeElement);
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    items[(index + step + items.length) % items.length].focus();
}

/** The menu's ♪ button and the dialog's switch show the same state. */
export function syncSoundControls(): void {
    const on = soundEnabled();
    document.getElementById('menu-sound')?.setAttribute('aria-pressed', String(on));
    document.getElementById('menu-sound')?.setAttribute('aria-label', on ? 'Sound on' : 'Sound off');
    document.getElementById('sound-switch')?.setAttribute('aria-checked', String(on));
}

/** What the graphics line says under the choice. */
export function graphicsNote(chosen: GraphicsSetting, loaded: GraphicsSetting, reason: ReturnType<typeof safeModeReason>): string {
    if (chosen !== loaded) return 'Applies after a reload.';
    if (reason === 'link') return 'Lite graphics from the link (?lite=1).';
    if (chosen === 'auto') return reason === 'trouble' ? 'Auto (Lite after graphics trouble on this device).' : 'Auto picks the look for this device.';
    if (chosen === 'lite') return 'The lightest look: for older phones and long battery life.';
    return 'The full look with sky light and smoothing, also on phones.';
}

function renderGraphics(chosen: GraphicsSetting): void {
    for (const button of document.querySelectorAll<HTMLElement>('[data-graphics]')) {
        const checked = button.dataset.graphics === chosen;
        button.setAttribute('aria-checked', String(checked));
        button.tabIndex = checked ? 0 : -1;
    }
    const note = document.getElementById('graphics-note');
    if (note) note.textContent = graphicsNote(chosen, loadedGraphics, safeModeReason());
    const apply = document.getElementById('graphics-apply');
    if (apply) apply.hidden = chosen === loadedGraphics;
}

function selectTab(tab: ControlsTab): void {
    for (const button of document.querySelectorAll<HTMLElement>('.tabs [role="tab"]')) {
        const selected = button.id === `tab-${tab}`;
        button.setAttribute('aria-selected', String(selected));
        button.tabIndex = selected ? 0 : -1;
    }
    for (const panel of document.querySelectorAll<HTMLElement>('.controls-table')) {
        panel.hidden = panel.id !== `controls-${tab}`;
    }
}

function showDialog(target: HTMLDialogElement | null): void {
    if (!target || target.open) return;
    closeOpenDialog();
    target.showModal();
    state.isModalOpen = true;
    // Drop held keys, so the car does not keep driving behind the dialog
    releaseKeyboardInputs();
    resetMobileControls();
}

/** Opens the settings; the controls tab of the input in use. */
export function openSettings(input: ControlsTab = 'keyboard'): void {
    const target = dialog('settings-dialog');
    renderGraphics(graphicsSetting());
    syncSoundControls();
    selectTab(input);
    showDialog(target);
}

export function openAbout(): void {
    const build = document.querySelector<HTMLMetaElement>('meta[name="bulli-build-version"]')?.content;
    const version = document.getElementById('about-build');
    if (version) version.textContent = build || 'dev';
    showDialog(dialog('about-dialog'));
}

/** Wires both dialogs (once). */
export function initDialogs(): void {
    if (initialized) return;
    initialized = true;
    loadedGraphics = graphicsSetting();
    for (const id of DIALOG_IDS) {
        const target = dialog(id);
        if (!target) continue;
        target.querySelector('.dialog-close')?.addEventListener('click', () => target.close());
        target.addEventListener('close', () => {
            if (!dialogOpen()) state.isModalOpen = false;
        });
        // A click on the backdrop (the dialog element itself, outside its box) closes it
        target.addEventListener('click', event => {
            if (event.target !== target) return;
            const box = target.getBoundingClientRect();
            const e = event as MouseEvent;
            if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) target.close();
        });
    }
    const buttons = [...document.querySelectorAll<HTMLElement>('[data-graphics]')];
    for (const button of buttons) {
        button.addEventListener('click', () => {
            const chosen = button.dataset.graphics as GraphicsSetting;
            setGraphicsSetting(chosen);
            renderGraphics(chosen);
        });
        button.addEventListener('keydown', event => {
            const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
            if (!step) return;
            event.preventDefault();
            const next = buttons[(buttons.indexOf(button) + step + buttons.length) % buttons.length];
            next.click();
            next.focus();
        });
    }
    document.getElementById('graphics-apply')?.addEventListener('click', () => window.location.reload());
    document.getElementById('sound-switch')?.addEventListener('click', () => {
        setSoundEnabled(!soundEnabled());
        syncSoundControls();
    });
    const tabs = [...document.querySelectorAll<HTMLElement>('.tabs [role="tab"]')];
    for (const tab of tabs) {
        tab.addEventListener('click', () => selectTab(tab.id.replace('tab-', '') as ControlsTab));
        tab.addEventListener('keydown', event => {
            const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
            if (!step) return;
            event.preventDefault();
            const next = tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length];
            next.click();
            next.focus();
        });
    }
}
