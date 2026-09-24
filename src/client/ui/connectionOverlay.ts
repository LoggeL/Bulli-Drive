import { OVERLAY_AFTER_MS, RELOAD_OFFER_MS } from '../../shared/net/reconnect.js';

// The connection banner (docs/phase-1b-design.md, 11.1): "Reconnecting…"
// once the connection has been gone for a second, with a reload button
// after 30 s; a message with one button when only the player can go on
// (kicked, taken over by another tab, server rejected the page). It sits
// in the upper middle of the screen, clear of the touch controls at the
// bottom and of the HUD chips along the top edge.

let root: HTMLElement | null = null;
let label: HTMLElement | null = null;
let button: HTMLButtonElement | null = null;
let showTimer = 0;
let reloadTimer = 0;
let buttonAction: (() => void) | null = null;

function ensure(): HTMLElement {
    if (root) return root;
    root = document.createElement('div');
    root.id = 'net-notice';
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');
    root.hidden = true;
    const spinner = document.createElement('span');
    spinner.className = 'net-notice-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    label = document.createElement('span');
    label.className = 'net-notice-text';
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'net-notice-reload';
    button.addEventListener('click', () => buttonAction?.());
    root.append(spinner, label, button);
    document.body.appendChild(root);
    return root;
}

function clearTimers(): void {
    window.clearTimeout(showTimer);
    window.clearTimeout(reloadTimer);
    showTimer = 0;
    reloadTimer = 0;
}

function setButton(text: string | null, action: (() => void) | null): void {
    ensure();
    buttonAction = action;
    button!.hidden = text === null;
    button!.textContent = text ?? '';
}

function show(text: string, busy: boolean): void {
    const el = ensure();
    label!.textContent = text;
    el.classList.toggle('busy', busy);
    el.hidden = false;
}

/**
 * The connection is gone since sinceMs (performance.now) and the client is
 * trying again: the banner shows OVERLAY_AFTER_MS after that, and offers a
 * reload RELOAD_OFFER_MS after it.
 */
export function showReconnecting(sinceMs: number, text = 'Reconnecting…'): void {
    ensure();
    clearTimers();
    const now = performance.now();
    const update = () => {
        const reload = performance.now() - sinceMs >= RELOAD_OFFER_MS;
        setButton(reload ? 'Reload' : null, reload ? () => window.location.reload() : null);
        show(text, true);
    };
    const showIn = Math.max(0, sinceMs + OVERLAY_AFTER_MS - now);
    if (showIn === 0) update();
    else showTimer = window.setTimeout(update, showIn);
    reloadTimer = window.setTimeout(update, Math.max(0, sinceMs + RELOAD_OFFER_MS - now));
}

/** A message that stays, with one button (reload by default). */
export function showConnectionNotice(text: string, buttonText = 'Reload', action: () => void = () => window.location.reload()): void {
    clearTimers();
    setButton(buttonText, action);
    show(text, false);
}

export function hideConnectionOverlay(): void {
    clearTimers();
    if (root) root.hidden = true;
}

/** Whether the banner is on screen (e2e hook). */
export function connectionOverlayText(): string | null {
    return root && !root.hidden ? label?.textContent ?? '' : null;
}
