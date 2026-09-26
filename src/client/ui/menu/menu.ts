import { PAINTS, paintById, type PaintId } from '../../../shared/paints.js';
import type { CarClassId } from '../../../shared/sim/types.js';
import { carAnnouncement, carStats, CAR_NAMES } from './carStats.js';
import {
    IDLE_PAD, loadMenuChoice, MENU_CARS, navigate, padMenuActions, readPadMenu, saveMenuChoice, stepCar,
    type MenuAction, type MenuChoice, type MenuMode, type MenuRow, type MenuStorage, type PadMenuState
} from './menuState.js';
import { listenOwnPaint } from './paintSync.js';
import { closeOpenDialog, dialogOpen, initDialogs, moveDialogFocus, openAbout, openSettings, syncSoundControls } from './settingsDialog.js';
import { gameAssetsPercent, gameAssetsReady } from '../assetGate.js';
import { setSoundEnabled, soundEnabled } from '../../effects/sounds.js';

// The main menu (docs/ui.md 4): driver name, car carousel with its numbers,
// paint chips, mode cards, DRIVE with the loading progress, settings,
// sound and About; keyboard, touch and gamepad. The choice lives in
// menuState.ts (pure); this wires it to index.html's #splash-screen, keeps
// the showroom told (car, paint, where the car sits in the frame) and runs
// the start. The ids and classes the join flow and the tests use stay:
// #splash-screen (class hidden after the start), #splash-name-input,
// .mode-option[data-room], #start-btn.

export interface MenuHooks {
    /** Another car in the carousel (the showroom swaps the car, the server hears of it) */
    onCar(car: CarClassId): void;
    /** Another paint */
    onPaint(paint: PaintId): void;
    /** DRIVE: joins the game with the choice; the menu closes once it resolves */
    onStart(choice: MenuChoice): Promise<void>;
}

export interface MenuOptions {
    storage?: MenuStorage;
    /** Polls of the start button's progress and the gamepad (ms); tests pass their fake timers */
    pollMs?: number;
}

type InputKind = 'keyboard' | 'touch' | 'gamepad';

const PAD_POLL_MS = 50;
const SWIPE_MIN_PX = 40;
// The loader fades out over the menu this long (ui/loadingScreen.ts): DRIVE
// shows no loading progress under it (it would flash 'LOADING 99 %' while
// the last car model comes in)
const SHOW_SETTLE_MS = 500;

let root: HTMLElement | null = null;
let hooks: MenuHooks | null = null;
let storage: MenuStorage = null;
let choice: MenuChoice = { car: 'bulli', paint: 'sea', mode: 'party', name: '' };
let row: MenuRow = 'name';
let open = false;
let starting = false;
let settling = false;
let pollTimer = 0;
let padTimer = 0;
let padState: PadMenuState = IDLE_PAD;
let layoutChanged: (() => void) | null = null;

const $ = <T extends Element = HTMLElement>(selector: string): T | null => root?.querySelector<T>(selector) ?? null;
const $$ = <T extends Element = HTMLElement>(selector: string): T[] => (root ? [...root.querySelectorAll<T>(selector)] : []);

function browserStorage(): MenuStorage {
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}

/** The menu's current choice (the name as typed). */
export function menuChoice(): MenuChoice {
    return { ...choice, name: nameInput()?.value ?? choice.name };
}

/** Whether the menu is up (loaded, not started). */
export function menuOpen(): boolean {
    return open;
}

/** The layout moved (resize, sheet height): the showroom frames the car again. */
export function onMenuLayout(fn: () => void): void {
    layoutChanged = fn;
}

function nameInput(): HTMLInputElement | null {
    return $<HTMLInputElement>('#splash-name-input');
}

/** Where the car stands in the frame: the centre and size of the free box (fractions of the frame). */
export interface MenuCarFrame {
    center: [number, number];
    box: [number, number];
}

/**
 * The free box for the car: the stage beside the panel (desktop, phones
 * held sideways) or above the sheet (upright phones), without the carousel
 * and numbers at its foot and the wordmark at its top; null while the
 * menu is not laid out.
 */
export function menuCarFrame(): MenuCarFrame | null {
    const stage = $('.menu-stage')?.getBoundingClientRect();
    const width = window.innerWidth, height = window.innerHeight;
    if (!stage || stage.width < 1 || !width || !height) return null;
    let top = stage.top;
    let bottom = stage.bottom;
    const showcase = $('.menu-showcase')?.getBoundingClientRect();
    if (showcase && showcase.height > 0 && showcase.top > top + 80) bottom = Math.min(bottom, showcase.top);
    const tools = $('.menu-tools')?.getBoundingClientRect();
    const brand = $('.menu-brand .wordmark')?.getBoundingClientRect();
    for (const box of [tools, brand]) {
        // Only what sits over the stage's top (upright and sideways phones)
        if (box && box.height > 0 && box.bottom < bottom - 120 && box.left < stage.right && box.right > stage.left) top = Math.max(top, box.bottom);
    }
    return {
        center: [(stage.left + stage.right) / 2 / width, (top + bottom) / 2 / height],
        box: [stage.width / width, (bottom - top) / height]
    };
}

// ---- Rendering the choice ----

function renderCar(): void {
    const stats = carStats(choice.car);
    for (const card of $$('.car-card')) {
        const current = card.dataset.car === choice.car;
        card.setAttribute('aria-current', String(current));
        card.tabIndex = current ? 0 : -1;
    }
    $$('.car-dots i').forEach((dot, index) => dot.classList.toggle('on', MENU_CARS[index] === choice.car));
    const title = $('.car-title-name');
    if (title) title.textContent = stats.name;
    const speed = $('[data-stat="speed"]');
    if (speed) speed.textContent = String(stats.topSpeedKmh);
    const mass = $('[data-stat="mass"]');
    if (mass) mass.textContent = String(stats.mass);
    $('[data-bar="speed"]')?.style.setProperty('--value', stats.topSpeedBar.toFixed(3));
    $('[data-bar="accel"]')?.style.setProperty('--value', stats.accelBar.toFixed(3));
    const character = $('.car-character');
    if (character) character.textContent = stats.character;
}

function renderPaint(): void {
    for (const chip of $$('.paint-chip')) {
        const checked = chip.dataset.paint === choice.paint;
        chip.setAttribute('aria-checked', String(checked));
        chip.tabIndex = checked ? 0 : -1;
    }
    const name = $('.paint-name');
    if (name) name.textContent = paintById(choice.paint).name;
}

function renderMode(): void {
    root?.setAttribute('data-mode', choice.mode);
    for (const option of $$('.mode-option')) {
        const checked = option.dataset.room === choice.mode;
        option.setAttribute('aria-checked', String(checked));
        option.tabIndex = checked ? 0 : -1;
    }
}

function announce(text: string): void {
    const live = $('#menu-live');
    if (live) live.textContent = text;
}

// ---- Changing it ----

// From DRIVE on the pick is taken: nothing changes it any more
function setCar(car: CarClassId, options: { announce?: boolean } = {}): void {
    if (car === choice.car || starting) return;
    choice = { ...choice, car };
    renderCar();
    saveMenuChoice(storage, menuChoice());
    hooks?.onCar(car);
    if (options.announce !== false) announce(carAnnouncement(car));
}

function setPaint(paint: PaintId, options: { fromServer?: boolean } = {}): void {
    if (paint === choice.paint || (starting && !options.fromServer)) return;
    choice = { ...choice, paint };
    renderPaint();
    // The server's paint (one it kept for a resumed session) is not a pick: it is not saved
    if (options.fromServer) return;
    saveMenuChoice(storage, menuChoice());
    hooks?.onPaint(paint);
    announce(paintById(paint).name);
}

function setMode(mode: MenuMode): void {
    if (mode === choice.mode || starting) return;
    choice = { ...choice, mode };
    renderMode();
    saveMenuChoice(storage, menuChoice());
}

// ---- Building the parts that come from data ----

function buildCars(): void {
    const strip = $('.car-strip');
    const dots = $('.car-dots');
    if (!strip || !dots) return;
    strip.replaceChildren(...MENU_CARS.map(car => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'car-card';
        card.dataset.car = car;
        const stats = carStats(car);
        card.setAttribute('aria-label', `${CAR_NAMES[car]}, ${stats.topSpeedKmh} km/h, ${stats.mass} kg`);
        const img = document.createElement('img');
        // The render loads once the menu shows (onShow), not alongside the loader's assets
        img.dataset.src = `/icons/car-${car}-menu.webp`;
        img.alt = '';
        img.width = 320;
        img.height = 180;
        img.decoding = 'async';
        img.draggable = false;
        const name = document.createElement('span');
        name.className = 'car-name';
        name.textContent = CAR_NAMES[car];
        card.append(img, name);
        card.addEventListener('click', () => setCar(car));
        return card;
    }));
    dots.replaceChildren(...MENU_CARS.map(() => document.createElement('i')));
}

function buildPaints(): void {
    const chips = $('.paint-chips');
    if (!chips) return;
    chips.replaceChildren(...PAINTS.map(paint => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'paint-chip';
        chip.setAttribute('role', 'radio');
        chip.dataset.paint = paint.id;
        chip.setAttribute('aria-label', paint.name);
        chip.title = paint.name;
        chip.style.setProperty('--paint', `#${paint.hex.toString(16).padStart(6, '0')}`);
        chip.addEventListener('click', () => setPaint(paint.id));
        return chip;
    }));
}

// ---- Keyboard ----

function arrowStep(event: KeyboardEvent, vertical: boolean): number {
    if (event.key === 'ArrowRight' || (vertical && event.key === 'ArrowDown')) return 1;
    if (event.key === 'ArrowLeft' || (vertical && event.key === 'ArrowUp')) return -1;
    return 0;
}

// Radio groups (paint, mode): the arrows move the choice and the focus
function radioKeys(selector: string, pick: (element: HTMLElement) => void): void {
    root?.querySelector(selector)?.addEventListener('keydown', event => {
        const keyEvent = event as KeyboardEvent;
        const step = arrowStep(keyEvent, true);
        if (!step) return;
        const items = $$(`${selector} [role="radio"]`);
        const index = items.findIndex(item => item.getAttribute('aria-checked') === 'true');
        const next = items[(index + step + items.length) % items.length];
        keyEvent.preventDefault();
        pick(next);
        next.focus();
    });
}

function focusRow(target: MenuRow): void {
    row = target;
    const element = rowElement(target);
    element?.focus({ preventScroll: false });
    element?.scrollIntoView?.({ block: 'nearest' });
}

function rowElement(target: MenuRow): HTMLElement | null {
    switch (target) {
        case 'name': return nameInput();
        case 'car': {
            const card = $(`.car-card[aria-current="true"]`);
            return card && card.offsetParent !== null ? card : $('.car-next');
        }
        case 'paint': return $('.paint-chip[aria-checked="true"]');
        case 'mode': return $('.mode-option[aria-checked="true"]');
        case 'drive': return $('#start-btn');
    }
}

function rowOf(element: Element | null): MenuRow | null {
    if (!element) return null;
    if (element.id === 'splash-name-input') return 'name';
    if (element.closest('.car-carousel')) return 'car';
    if (element.closest('.paint-chips')) return 'paint';
    if (element.closest('.mode-selector-row')) return 'mode';
    if (element.id === 'start-btn') return 'drive';
    return null;
}

// ---- Gamepad ----

function pollPad(): void {
    const pads = typeof navigator.getGamepads === 'function' ? [...navigator.getGamepads()] : [];
    const pad = pads.find(p => p?.connected && p.mapping === 'standard') ?? pads.find(p => p?.connected) ?? null;
    const next = readPadMenu(pad);
    const actions = padMenuActions(padState, next);
    padState = next;
    if (!pad) return;
    if (actions.length) setInput('gamepad');
    for (const action of actions) padAction(action);
}

function padAction(action: MenuAction): void {
    if (dialogOpen()) {
        if (action === 'back' || action === 'settings') closeOpenDialog();
        else if (action === 'activate') (document.activeElement as HTMLElement | null)?.click();
        else if (action === 'up' || action === 'left') moveDialogFocus(-1);
        else if (action === 'down' || action === 'right') moveDialogFocus(1);
        return;
    }
    if (action === 'settings') {
        openSettings('gamepad');
        return;
    }
    if (action === 'activate') {
        if (row === 'drive') void start();
        else focusRow(row);
        return;
    }
    const current = rowOf(document.activeElement) ?? row;
    const next = navigate({ choice: menuChoice(), row: current }, action, { skipName: true });
    if (next.choice.car !== choice.car) setCar(next.choice.car);
    if (next.choice.paint !== choice.paint) setPaint(next.choice.paint);
    if (next.choice.mode !== choice.mode) setMode(next.choice.mode);
    focusRow(next.row);
}

// ---- Input kind (which controls hint shows) ----

function setInput(kind: InputKind): void {
    if (root?.dataset.input !== kind) root?.setAttribute('data-input', kind);
}

function detectInput(): void {
    const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    setInput(coarse ? 'touch' : 'keyboard');
    window.addEventListener('keydown', () => { if (open) setInput('keyboard'); }, true);
    window.addEventListener('pointerdown', event => {
        if (open) setInput(event.pointerType === 'touch' ? 'touch' : 'keyboard');
    }, true);
    window.addEventListener('gamepadconnected', () => { if (open) setInput('gamepad'); });
}

// ---- Swipe on the showroom ----

function swipe(area: Element | null): void {
    let startX = 0, startY = 0, id = -1;
    area?.addEventListener('pointerdown', event => {
        const e = event as PointerEvent;
        if ((e.target as Element).closest('button, input')) return;
        id = e.pointerId;
        startX = e.clientX;
        startY = e.clientY;
    });
    area?.addEventListener('pointerup', event => {
        const e = event as PointerEvent;
        if (e.pointerId !== id) return;
        id = -1;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        if (Math.abs(dx) >= SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy) * 1.5) setCar(stepCar(choice.car, dx < 0 ? 1 : -1));
    });
    area?.addEventListener('pointercancel', () => { id = -1; });
}

// ---- DRIVE ----

function renderDrive(): void {
    const button = $('#start-btn');
    const label = $('#start-btn .btn-label');
    if (!button || !label) return;
    // Under the loader's fade DRIVE is just DRIVE (a click still waits for the assets)
    const ready = gameAssetsReady() || settling;
    const percent = gameAssetsPercent();
    button.classList.toggle('loading', !ready);
    button.style.setProperty('--progress', ready ? '1' : (percent / 100).toFixed(3));
    if (ready) button.removeAttribute('aria-busy');
    else button.setAttribute('aria-busy', 'true');
    label.textContent = starting ? 'STARTING…' : ready ? 'DRIVE' : `LOADING ${percent} %`;
}

async function start(): Promise<void> {
    // One start; a second click changes nothing
    if (starting || !hooks) return;
    starting = true;
    const picked = menuChoice();
    saveMenuChoice(storage, picked);
    lockPanel(true);
    renderDrive();
    // The hidden menu must not keep the focus: Space drives, Enter would press DRIVE again
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && root?.contains(focused)) focused.blur();
    try {
        await hooks.onStart({ ...picked, name: picked.name.trim() || 'Player' });
    } catch (error) {
        console.error('Start failed', error);
        starting = false;
        lockPanel(false);
        renderDrive();
    }
}

// The panel while the start waits for its assets: shown, but not to be changed
function lockPanel(locked: boolean): void {
    const panel = $('.menu-panel');
    if (panel) panel.inert = locked;
    root?.classList.toggle('starting', locked);
}

/** Closes the menu for good (the start went through). */
export function closeMenu(): void {
    open = false;
    window.clearInterval(pollTimer);
    window.clearInterval(padTimer);
    pollTimer = padTimer = 0;
    listenOwnPaint(null);
    if (!root) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && root.contains(focused)) focused.blur();
    root.classList.add('hidden');
    root.inert = true;
}

// The loader is gone: the menu is up
function onShow(pollMs: number): void {
    if (open || starting) return;
    open = true;
    for (const img of $$<HTMLImageElement>('.car-card img[data-src]')) {
        // Fades in once it is there (ui/menu.css)
        img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
        img.src = img.dataset.src!;
        img.removeAttribute('data-src');
    }
    settling = true;
    window.setTimeout(() => {
        settling = false;
        renderDrive();
    }, SHOW_SETTLE_MS);
    renderDrive();
    pollTimer = window.setInterval(renderDrive, pollMs);
    padTimer = window.setInterval(pollPad, Math.min(pollMs, PAD_POLL_MS));
    layoutChanged?.();
    // A keyboard gets the name field; a phone nothing (no keyboard popping up)
    const fine = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches;
    if (fine) nameInput()?.focus({ preventScroll: true });
}

/** Sets the menu up on index.html's markup (hidden until the loader is gone). */
export function initMenu(menuHooks: MenuHooks, options: MenuOptions = {}): MenuChoice {
    root = document.getElementById('splash-screen');
    hooks = menuHooks;
    storage = options.storage ?? browserStorage();
    choice = loadMenuChoice(storage);
    open = false;
    starting = false;
    settling = false;
    padState = IDLE_PAD;
    const pollMs = options.pollMs ?? 200;
    if (!root) return choice;

    // The wordmark from the loader (tools/ui/wordmark.mjs writes it once, there)
    const wordmark = document.querySelector('#loading-screen svg.wordmark');
    const brand = $('.menu-brand');
    if (wordmark && brand && !brand.querySelector('.wordmark')) {
        const copy = wordmark.cloneNode(true) as SVGElement;
        copy.setAttribute('aria-hidden', 'true');
        copy.removeAttribute('role');
        brand.prepend(copy);
    }

    buildCars();
    buildPaints();
    const input = nameInput();
    if (input) {
        input.value = choice.name;
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                void start();
            }
        });
        input.addEventListener('change', () => saveMenuChoice(storage, menuChoice()));
    }
    for (const option of $$('.mode-option')) {
        option.addEventListener('click', () => setMode(option.dataset.room as MenuMode));
    }
    radioKeys('.paint-chips', chip => setPaint(chip.dataset.paint as PaintId));
    radioKeys('.mode-selector-row', option => setMode(option.dataset.room as MenuMode));
    // The carousel: arrows, cards, the arrow keys, swipes on the showroom
    $('.car-prev')?.addEventListener('click', () => setCar(stepCar(choice.car, -1)));
    $('.car-next')?.addEventListener('click', () => setCar(stepCar(choice.car, 1)));
    $('.car-carousel')?.addEventListener('keydown', event => {
        const step = arrowStep(event as KeyboardEvent, false);
        if (!step) return;
        event.preventDefault();
        setCar(stepCar(choice.car, step));
        const card = $('.car-card[aria-current="true"]');
        if (card?.offsetParent !== null && (document.activeElement as HTMLElement | null)?.classList.contains('car-card')) card?.focus();
    });
    swipe($('.menu-stage'));
    swipe($('.menu-showcase'));
    $('#start-btn')?.addEventListener('click', () => void start());
    // Tools
    $('#menu-settings')?.addEventListener('click', () => openSettings(root?.dataset.input as InputKind | undefined));
    $('#about-link')?.addEventListener('click', () => openAbout());
    $('#menu-sound')?.addEventListener('click', () => {
        setSoundEnabled(!soundEnabled());
        syncSoundControls();
    });
    initDialogs();
    syncSoundControls();
    // Remember where focus is for the gamepad
    root.addEventListener('focusin', event => { row = rowOf(event.target as Element) ?? row; });
    root.addEventListener('menushow', () => onShow(pollMs));
    detectInput();

    // The sheet's height (upright phones) places the car above it
    const panel = $('.menu-panel');
    const measure = () => {
        const height = panel?.getBoundingClientRect().height ?? 0;
        root?.style.setProperty('--menu-sheet-height', `${Math.round(height)}px`);
        layoutChanged?.();
    };
    if (typeof ResizeObserver === 'function' && panel) new ResizeObserver(measure).observe(panel);
    window.addEventListener('resize', measure);
    measure();

    // The server's paint on a first visit (a random palette paint)
    listenOwnPaint(paint => setPaint(paint, { fromServer: true }));

    renderCar();
    renderPaint();
    renderMode();
    return choice;
}
