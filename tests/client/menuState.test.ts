import { describe, expect, it } from 'vitest';
import {
    IDLE_PAD, loadMenuChoice, menuModeFor, navigate, padMenuActions, readPadMenu, saveMenuChoice, stepCar, stepMode, stepPaint, stepRow,
    type MenuChoice, type MenuStorage, type PadMenuState
} from '../../src/client/ui/menu/menuState.js';

// The main menu's state (src/client/ui/menu/menuState.ts, docs/ui.md 4):
// the choice from the last visit, saving it, and the keyboard's and the
// gamepad's steps through the rows and values. The DOM wiring is in
// tests/client/menu.test.ts.

function memory(entries: Record<string, string> = {}): MenuStorage & { store: Map<string, string> } {
    const store = new Map(Object.entries(entries));
    return { store, getItem: key => store.get(key) ?? null, setItem: (key, value) => { store.set(key, value); } };
}

const throwing: MenuStorage = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('QuotaExceededError'); }
};

const base: MenuChoice = { car: 'bulli', paint: 'sea', mode: 'party', name: 'Ada' };

describe('the choice of the last visit', () => {
    it('is the Bulli in Sea Green in the Party without a name on a first visit', () => {
        expect(loadMenuChoice(memory())).toEqual({ car: 'bulli', paint: 'sea', mode: 'party', name: '' });
        expect(loadMenuChoice(null)).toEqual({ car: 'bulli', paint: 'sea', mode: 'party', name: '' });
    });

    it('comes back from the keys the game used before the menu, plus the paint', () => {
        const storage = memory({
            'bulli-car-type': 'jeep', 'bulli-paint': 'ochre', 'bulli-room-kind': 'freeroam', 'bulli-player-name': 'SurfKing42'
        });
        expect(loadMenuChoice(storage)).toEqual({ car: 'jeep', paint: 'ochre', mode: 'freeroam', name: 'SurfKing42' });
    });

    it('falls back value by value when something is invalid, and when the storage throws', () => {
        const storage = memory({ 'bulli-car-type': 'tank', 'bulli-paint': 'neon', 'bulli-room-kind': 'deathmatch', 'bulli-player-name': 'Kalle' });
        expect(loadMenuChoice(storage)).toEqual({ car: 'bulli', paint: 'sea', mode: 'party', name: 'Kalle' });
        expect(loadMenuChoice(throwing)).toEqual({ car: 'bulli', paint: 'sea', mode: 'party', name: '' });
    });

    it('shows a time trial played last as Race', () => {
        expect(menuModeFor('timetrial')).toBe('race');
        expect(loadMenuChoice(memory({ 'bulli-room-kind': 'timetrial' })).mode).toBe('race');
    });

    it('cleans a saved name like the server: control characters out, trimmed, 20 characters at most', () => {
        expect(loadMenuChoice(memory({ 'bulli-player-name': '  Surf\u0007King  ' })).name).toBe('SurfKing');
        expect(loadMenuChoice(memory({ 'bulli-player-name': 'x'.repeat(30) })).name).toHaveLength(20);
    });
});

describe('saving the choice', () => {
    it('writes car, paint, mode and name for the next visit', () => {
        const storage = memory();
        saveMenuChoice(storage, { car: 'sport', paint: 'red', mode: 'race', name: ' Ada ' });
        expect(Object.fromEntries(storage.store)).toEqual({
            'bulli-car-type': 'sport', 'bulli-paint': 'red', 'bulli-room-kind': 'race', 'bulli-player-name': 'Ada'
        });
        expect(loadMenuChoice(storage)).toEqual({ car: 'sport', paint: 'red', mode: 'race', name: 'Ada' });
    });

    it('keeps a time trial when Race stays picked, and a saved name when the field is empty', () => {
        const storage = memory({ 'bulli-room-kind': 'timetrial', 'bulli-player-name': 'Ada' });
        saveMenuChoice(storage, { ...base, mode: 'race', name: '   ' });
        expect(storage.store.get('bulli-room-kind')).toBe('timetrial');
        expect(storage.store.get('bulli-player-name')).toBe('Ada');
        saveMenuChoice(storage, { ...base, mode: 'freeroam' });
        expect(storage.store.get('bulli-room-kind')).toBe('freeroam');
    });

    it('never throws on a storage that refuses', () => {
        expect(() => saveMenuChoice(throwing, base)).not.toThrow();
    });
});

describe('stepping through the values', () => {
    it('runs the carousel round in both directions', () => {
        // Bulli, Beetle, Pickup, 356, Type 181
        expect(stepCar('bulli', 1)).toBe('beetle');
        expect(stepCar('jeep', 1)).toBe('bulli');
        expect(stepCar('bulli', -1)).toBe('jeep');
        expect(stepCar('sport', -1)).toBe('pickup');
    });

    it('runs the paints and the modes round too', () => {
        expect(stepPaint('anthracite', 1)).toBe('sea');
        expect(stepPaint('sea', -1)).toBe('anthracite');
        expect(stepPaint('cream', 1)).toBe('red');
        expect(stepMode('race', 1)).toBe('party');
        expect(stepMode('party', -1)).toBe('race');
    });

    it('stops at the first and the last row, and skips the name for the gamepad', () => {
        expect(stepRow('name', -1)).toBe('name');
        expect(stepRow('name', 1)).toBe('car');
        expect(stepRow('mode', 1)).toBe('drive');
        expect(stepRow('drive', 1)).toBe('drive');
        expect(stepRow('car', -1, { skipName: true })).toBe('car');
        expect(stepRow('car', -1)).toBe('name');
        // The pad in the name field (focused by the page): down goes to the car row
        expect(stepRow('name', 1, { skipName: true })).toBe('car');
        expect(stepRow('name', -1, { skipName: true })).toBe('car');
    });
});

describe('navigation', () => {
    it('moves between the rows and changes the value of the row it is on', () => {
        let focus = navigate({ choice: base, row: 'name' }, 'down');
        expect(focus.row).toBe('car');
        focus = navigate(focus, 'right');
        expect(focus.choice.car).toBe('beetle');
        focus = navigate(navigate(focus, 'down'), 'left');
        expect([focus.row, focus.choice.paint]).toEqual(['paint', 'anthracite']);
        focus = navigate(navigate(focus, 'down'), 'right');
        expect([focus.row, focus.choice.mode]).toEqual(['mode', 'freeroam']);
        // The other values stay
        expect(focus.choice).toEqual({ car: 'beetle', paint: 'anthracite', mode: 'freeroam', name: 'Ada' });
    });

    it('changes nothing with left/right on the name and DRIVE rows', () => {
        for (const row of ['name', 'drive'] as const) {
            expect(navigate({ choice: base, row }, 'left')).toEqual({ choice: base, row });
            expect(navigate({ choice: base, row }, 'right')).toEqual({ choice: base, row });
        }
    });

    it('changes the car with LB/RB from any row, and leaves activate, settings and back to the controller', () => {
        expect(navigate({ choice: base, row: 'mode' }, 'nextCar')).toEqual({ choice: { ...base, car: 'beetle' }, row: 'mode' });
        expect(navigate({ choice: base, row: 'drive' }, 'prevCar').choice.car).toBe('jeep');
        for (const action of ['activate', 'settings', 'back'] as const) {
            expect(navigate({ choice: base, row: 'paint' }, action)).toEqual({ choice: base, row: 'paint' });
        }
    });
});

describe('the gamepad in the menu', () => {
    const pad = (pressed: number[], axes: number[] = [0, 0, 0, 0]) => ({
        axes, buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) }))
    });

    it('reads the d-pad, the left stick past half way and the face buttons of the standard mapping', () => {
        expect(readPadMenu(null)).toEqual(IDLE_PAD);
        expect(readPadMenu(pad([12, 0, 5]))).toEqual({ ...IDLE_PAD, up: true, a: true, rb: true });
        expect(readPadMenu(pad([], [0.6, -0.2]))).toEqual({ ...IDLE_PAD, right: true });
        expect(readPadMenu(pad([], [-0.4, 0.7]))).toEqual({ ...IDLE_PAD, down: true });
        expect(readPadMenu(pad([1, 4, 9, 14]))).toEqual({ ...IDLE_PAD, b: true, lb: true, menu: true, left: true });
    });

    it('acts once per press, not while a button is held', () => {
        const down: PadMenuState = { ...IDLE_PAD, down: true };
        expect(padMenuActions(IDLE_PAD, down)).toEqual(['down']);
        expect(padMenuActions(down, down)).toEqual([]);
        expect(padMenuActions(down, { ...down, a: true, rb: true })).toEqual(['nextCar', 'activate']);
        expect(padMenuActions(IDLE_PAD, { ...IDLE_PAD, menu: true, b: true, lb: true })).toEqual(['prevCar', 'back', 'settings']);
    });
});
