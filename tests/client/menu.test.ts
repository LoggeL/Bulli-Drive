// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuChoice } from '../../src/client/ui/menu/menuState.js';

// The main menu on index.html's own markup (src/client/ui/menu/menu.ts,
// docs/ui.md 4): picking car, paint and mode, what it keeps in the storage,
// the keys, DRIVE with the loading progress and a single start, the
// settings dialog. The pure state and navigation: menuState.test.ts.

const assets = { ready: false, percent: 64 };
vi.mock('../../src/client/ui/assetGate.js', () => ({
    gameAssetsReady: () => assets.ready,
    gameAssetsPercent: () => assets.percent
}));

type Menu = typeof import('../../src/client/ui/menu/menu.js');

const INDEX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../index.html');
const BODY = /<body>([\s\S]*)<\/body>/.exec(readFileSync(INDEX, 'utf8'))![1].replace(/<script[\s\S]*?<\/script>/g, '');

let menu: Menu;
let store: Map<string, string>;
const cars: string[] = [];
const paints: string[] = [];
const starts: MenuChoice[] = [];
let startGate: Promise<void> = Promise.resolve();

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
const storage = () => ({ getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } });

async function openMenu(saved: Record<string, string> = {}): Promise<void> {
    store = new Map(Object.entries(saved));
    menu.initMenu({
        onCar: car => { cars.push(car); },
        onPaint: paint => { paints.push(paint); },
        onStart: async choice => { starts.push(choice); await startGate; }
    }, { storage: storage(), pollMs: 100 });
    // The loader is gone (ui/loadingScreen.ts removeLoader)
    $('#splash-screen').classList.remove('hidden');
    $('#splash-screen').dispatchEvent(new Event('menushow'));
}

function key(target: Element, name: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
}

beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    document.body.innerHTML = BODY;
    cars.length = paints.length = starts.length = 0;
    assets.ready = false;
    assets.percent = 64;
    startGate = Promise.resolve();
    localStorage.clear();
    menu = await import('../../src/client/ui/menu/menu.js');
});

afterEach(() => {
    vi.useRealTimers();
});

describe('the main menu', () => {
    it('shows the choice of the last visit', async () => {
        await openMenu({ 'bulli-car-type': 'sport', 'bulli-paint': 'ochre', 'bulli-room-kind': 'freeroam', 'bulli-player-name': 'Ada' });
        expect($<HTMLInputElement>('#splash-name-input').value).toBe('Ada');
        expect($('.car-card[aria-current="true"]').dataset.car).toBe('sport');
        expect($('.car-title-name').textContent).toBe('356');
        // 55 m/s: 198 km/h, 1200 kg (shared/sim/vehicleClasses.ts)
        expect($('[data-stat="speed"]').textContent).toBe('198');
        expect($('[data-stat="mass"]').textContent).toBe('1200');
        expect($('.paint-chip[aria-checked="true"]').dataset.paint).toBe('ochre');
        expect($('.paint-name').textContent).toBe('Ochre');
        expect($('.mode-option[aria-checked="true"]').dataset.room).toBe('freeroam');
        expect($('#splash-screen').dataset.mode).toBe('freeroam');
        // Eight chips named for screen readers, one card per car
        expect($$('.paint-chip').map(chip => chip.getAttribute('aria-label'))).toEqual([
            'Sea Green', 'Pearl White', 'Sealing Red', 'Dove Blue', 'Ochre', 'Signal Orange', 'Silver', 'Anthracite'
        ]);
        expect($$('.car-card').map(card => card.dataset.car)).toEqual(['bulli', 'beetle', 'pickup', 'sport', 'jeep']);
    });

    it('changes car, paint and mode, tells the game and keeps them for the next visit', async () => {
        await openMenu();
        $('.car-next').click();
        expect(cars).toEqual(['beetle']);
        expect($('.car-card[aria-current="true"]').dataset.car).toBe('beetle');
        expect($('#menu-live').textContent).toBe('Beetle – 173 km/h, 900 kg');
        $('.car-prev').click();
        $('.car-prev').click();
        expect(cars).toEqual(['beetle', 'bulli', 'jeep']);
        $('.paint-chip[data-paint="red"]').click();
        expect(paints).toEqual(['red']);
        expect($('.paint-chip[data-paint="red"]').getAttribute('aria-checked')).toBe('true');
        $('.mode-option[data-room="race"]').click();
        expect($('#splash-screen').dataset.mode).toBe('race');
        expect(Object.fromEntries(store)).toMatchObject({ 'bulli-car-type': 'jeep', 'bulli-paint': 'red', 'bulli-room-kind': 'race' });
        // The same pick again tells nobody
        $('.paint-chip[data-paint="red"]').click();
        expect(paints).toEqual(['red']);
    });

    it('walks the paint and the modes with the arrow keys, the carousel with left and right', async () => {
        await openMenu();
        const chip = $('.paint-chip[aria-checked="true"]');
        expect(chip.tabIndex).toBe(0);
        const event = key(chip, 'ArrowLeft');
        expect(event.defaultPrevented).toBe(true);
        // Sea Green is first: left wraps to Anthracite, which takes the focus
        expect($('.paint-chip[aria-checked="true"]').dataset.paint).toBe('anthracite');
        expect(document.activeElement).toBe($('.paint-chip[data-paint="anthracite"]'));
        key($('.mode-option[aria-checked="true"]'), 'ArrowDown');
        expect($('.mode-option[aria-checked="true"]').dataset.room).toBe('freeroam');
        key($('.car-card[aria-current="true"]'), 'ArrowRight');
        expect(cars).toEqual(['beetle']);
        // Up and down do not turn the carousel
        key($('.car-card[aria-current="true"]'), 'ArrowDown');
        expect(cars).toEqual(['beetle']);
    });

    it('fills DRIVE while the start\'s assets load, and starts once however often it is pressed', async () => {
        let release!: () => void;
        startGate = new Promise(resolve => { release = resolve; });
        await openMenu();
        const button = $('#start-btn');
        // Under the loader's fade DRIVE is plain (no flash of a last percent)
        expect($('#start-btn .btn-label').textContent).toBe('DRIVE');
        vi.advanceTimersByTime(500);
        expect(button.classList.contains('loading')).toBe(true);
        expect($('#start-btn .btn-label').textContent).toBe('LOADING 64 %');
        expect(button.style.getPropertyValue('--progress')).toBe('0.640');
        $<HTMLInputElement>('#splash-name-input').value = '  Kalle ';
        button.click();
        button.click();
        key($('#splash-name-input'), 'Enter');
        expect(starts).toEqual([{ car: 'bulli', paint: 'sea', mode: 'party', name: 'Kalle' }]);
        expect($('#start-btn .btn-label').textContent).toBe('STARTING…');
        // The assets are in: the label says so, the start goes on
        assets.ready = true;
        vi.advanceTimersByTime(100);
        expect(button.classList.contains('loading')).toBe(false);
        expect(store.get('bulli-player-name')).toBe('Kalle');
        release();
    });

    it('takes the pick at DRIVE: car, paint, mode and name stay while the start waits for its assets', async () => {
        startGate = new Promise(() => undefined);
        await openMenu();
        $('#start-btn').click();
        expect($('#splash-screen').classList.contains('starting')).toBe(true);
        expect($('.menu-panel').inert).toBe(true);
        // Nothing reaches the game or the storage any more, whichever way it comes
        $('.car-next').click();
        $('.paint-chip[data-paint="red"]').click();
        $('.mode-option[data-room="race"]').click();
        key($('.paint-chip[aria-checked="true"]'), 'ArrowRight');
        expect(cars).toEqual([]);
        expect(paints).toEqual([]);
        expect($('.car-card[aria-current="true"]').dataset.car).toBe('bulli');
        expect($('#splash-screen').dataset.mode).toBe('party');
        expect(store.get('bulli-car-type')).toBe('bulli');
        expect(starts).toEqual([{ car: 'bulli', paint: 'sea', mode: 'party', name: 'Player' }]);
    });

    it('loads the car renders once the menu shows, not alongside the loader', async () => {
        store = new Map();
        menu.initMenu({ onCar: () => undefined, onPaint: () => undefined, onStart: async () => undefined }, { storage: storage(), pollMs: 100 });
        const images = () => $$('.car-card img') as HTMLImageElement[];
        expect(images()).toHaveLength(5);
        expect(images().every(img => !img.getAttribute('src'))).toBe(true);
        $('#splash-screen').dispatchEvent(new Event('menushow'));
        expect(images().map(img => img.getAttribute('src'))).toEqual(['bulli', 'beetle', 'pickup', 'sport', 'jeep'].map(car => `/icons/car-${car}-menu.webp`));
    });

    it('starts on Enter in the name field, as "Player" without a name, and closes for good', async () => {
        assets.ready = true;
        await openMenu();
        vi.advanceTimersByTime(100);
        expect($('#start-btn .btn-label').textContent).toBe('DRIVE');
        key($('#splash-name-input'), 'Enter');
        expect(starts.map(start => start.name)).toEqual(['Player']);
        menu.closeMenu();
        expect($('#splash-screen').classList.contains('hidden')).toBe(true);
        expect($('#splash-screen').inert).toBe(true);
        expect(menu.menuOpen()).toBe(false);
    });

    it('shows the paint the server kept (a resumed session) without saving it as a pick', async () => {
        await openMenu();
        const sync = await import('../../src/client/ui/menu/paintSync.js');
        // Dove Blue from the server
        sync.onOwnPaint(0x5C7C95);
        expect($('.paint-chip[aria-checked="true"]').dataset.paint).toBe('blue');
        expect(paints).toEqual([]);
        expect(store.has('bulli-paint')).toBe(false);
        // Any other colour (an old resume ticket) leaves the chips alone
        sync.onOwnPaint(0x123456);
        expect($('.paint-chip[aria-checked="true"]').dataset.paint).toBe('blue');
    });
});

describe('the gamepad in the menu', () => {
    // A standard pad whose pressed buttons the test sets between polls
    const pressed = new Set<number>();
    const pad = { connected: true, mapping: 'standard', axes: [0, 0, 0, 0], get buttons() {
        return Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.has(i), value: pressed.has(i) ? 1 : 0 }));
    } };
    function press(button: number): void {
        pressed.add(button);
        vi.advanceTimersByTime(50);
        pressed.delete(button);
        vi.advanceTimersByTime(50);
    }

    beforeEach(() => {
        pressed.clear();
        Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [pad] });
    });

    it('walks the rows with the d-pad, changes the values with left/right and LB/RB, starts with A on DRIVE', async () => {
        assets.ready = true;
        await openMenu();
        // RB: the next car from anywhere; the hint shows the pad's buttons
        press(5);
        expect(cars).toEqual(['beetle']);
        expect($('#splash-screen').dataset.input).toBe('gamepad');
        // Down from the name (skipped by the pad) to the car row, then the paint row
        $<HTMLInputElement>('#splash-name-input').focus();
        press(13);
        // The chosen card, or the arrow where the cards are not shown (phones; happy-dom lays nothing out)
        expect(document.activeElement?.closest('.car-carousel')).not.toBeNull();
        press(13);
        expect(document.activeElement).toBe($('.paint-chip[aria-checked="true"]'));
        // Right on the paint row: Sea Green -> Pearl White
        press(15);
        expect(paints).toEqual(['cream']);
        press(13);
        press(13);
        expect(document.activeElement).toBe($('#start-btn'));
        press(0);
        expect(starts).toHaveLength(1);
        expect(starts[0]).toMatchObject({ car: 'beetle', paint: 'cream' });
    });

    it('opens the settings with Menu and closes them with B', async () => {
        await openMenu();
        press(9);
        expect(($('#settings-dialog') as HTMLDialogElement).open).toBe(true);
        expect($('#controls-gamepad').hidden).toBe(false);
        press(1);
        expect(($('#settings-dialog') as HTMLDialogElement).open).toBe(false);
    });
});

describe('the settings dialog', () => {
    it('keeps the graphics setting for the next load and offers the reload', async () => {
        await openMenu();
        $('#menu-settings').click();
        expect(($('#settings-dialog') as HTMLDialogElement).open).toBe(true);
        expect($('[data-graphics="auto"]').getAttribute('aria-checked')).toBe('true');
        expect($('#graphics-apply').hidden).toBe(true);
        $('[data-graphics="lite"]').click();
        expect(localStorage.getItem('bulli-graphics')).toBe('lite');
        expect($('#graphics-note').textContent).toBe('Applies after a reload.');
        expect($('#graphics-apply').hidden).toBe(false);
        // Back to the loaded one: nothing to apply; Auto is no stored value
        $('[data-graphics="auto"]').click();
        expect(localStorage.getItem('bulli-graphics')).toBeNull();
        expect($('#graphics-apply').hidden).toBe(true);
    });

    it('switches the sound with the dialog\'s switch and the menu\'s button alike', async () => {
        await openMenu();
        expect($('#menu-sound').getAttribute('aria-pressed')).toBe('true');
        $('#menu-sound').click();
        expect(localStorage.getItem('bulli-sound')).toBe('off');
        $('#menu-settings').click();
        expect($('#sound-switch').getAttribute('aria-checked')).toBe('false');
        $('#sound-switch').click();
        expect(localStorage.getItem('bulli-sound')).toBe('on');
        expect($('#menu-sound').getAttribute('aria-pressed')).toBe('true');
    });

    it('opens on the controls of the input in use, and the tabs follow the arrow keys', async () => {
        await openMenu();
        $('#splash-screen').dataset.input = 'gamepad';
        $('#menu-settings').click();
        expect($('#controls-gamepad').hidden).toBe(false);
        expect($('#controls-keyboard').hidden).toBe(true);
        key($('#tab-gamepad'), 'ArrowRight');
        expect($('#tab-keyboard').getAttribute('aria-selected')).toBe('true');
        expect($('#controls-keyboard').hidden).toBe(false);
    });
});
