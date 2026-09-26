import { DEFAULT_ROOM_KIND, isRoomKind } from '../../../shared/protocol.js';
import { isPaintId, PAINT_IDS, type PaintId } from '../../../shared/paints.js';
import { MAX_NAME_LENGTH } from '../../../shared/constants.js';
import type { CarClassId } from '../../../shared/sim/types.js';

// The main menu's state (docs/ui.md 4): car, paint, mode and driver name,
// kept in the browser's storage for the next visit, and the navigation
// with keyboard and gamepad over the menu's rows. Pure: the storage is
// passed in (localStorage in the page, a map in the tests), nothing here
// touches the DOM (ui/menu/menu.ts does).

/** The cars in the order of the carousel (the ids stay the sim's). */
export const MENU_CARS: readonly CarClassId[] = ['bulli', 'beetle', 'pickup', 'sport', 'jeep'];

/** The mode cards; the time trial is reached from the race lobby and counts as Race here. */
export const MENU_MODES = ['party', 'freeroam', 'race'] as const;
export type MenuMode = typeof MENU_MODES[number];

/** The rows the keyboard's and the gamepad's up/down walk through. */
export const MENU_ROWS = ['name', 'car', 'paint', 'mode', 'drive'] as const;
export type MenuRow = typeof MENU_ROWS[number];

export interface MenuChoice {
    car: CarClassId;
    paint: PaintId;
    mode: MenuMode;
    name: string;
}

// The keys the game used before the menu (car, mode, name stay readable
// for players who come back)
export const STORAGE_KEYS = {
    car: 'bulli-car-type',
    paint: 'bulli-paint',
    mode: 'bulli-room-kind',
    name: 'bulli-player-name'
} as const;

/**
 * The paint of a first visit: Sea Green, the paint of the loading screen's
 * key art (tools/ui/keyart.ts). The hello asks the server for it too
 * (network/hello.ts), so the loader fades into the same car (docs/ui.md D28).
 */
export const FIRST_PAINT: PaintId = 'sea';

export type MenuStorage = Pick<Storage, 'getItem' | 'setItem'> | null;

function read(storage: MenuStorage, key: string): string | null {
    try {
        return storage?.getItem(key) ?? null;
    } catch {
        return null;
    }
}

function write(storage: MenuStorage, key: string, value: string): void {
    try {
        storage?.setItem(key, value);
    } catch { /* private mode: the choice lasts for this page */ }
}

/** A mode of the menu for a saved room kind (a time trial counts as Race). */
export function menuModeFor(kind: unknown): MenuMode {
    if (kind === 'timetrial') return 'race';
    return isRoomKind(kind) ? kind as MenuMode : DEFAULT_ROOM_KIND as MenuMode;
}

/** Cleans a typed name like the server does, before it is saved (the server cleans it again). */
export function cleanMenuName(name: string): string {
    return name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, MAX_NAME_LENGTH);
}

/** The paint saved by the menu, null without a valid one (a first visit: FIRST_PAINT). */
export function savedPaint(storage: MenuStorage): PaintId | null {
    const paint = read(storage, STORAGE_KEYS.paint);
    return isPaintId(paint) ? paint : null;
}

/** The choice of the last visit; anything missing or invalid falls back to the defaults. */
export function loadMenuChoice(storage: MenuStorage): MenuChoice {
    const car = read(storage, STORAGE_KEYS.car);
    return {
        car: MENU_CARS.includes(car as CarClassId) ? car as CarClassId : 'bulli',
        paint: savedPaint(storage) ?? FIRST_PAINT,
        mode: menuModeFor(read(storage, STORAGE_KEYS.mode)),
        name: cleanMenuName(read(storage, STORAGE_KEYS.name) ?? '')
    };
}

/**
 * Saves the choice for the next visit. The room kind is left alone when
 * the choice is Race and a time trial was played last: it counts as Race.
 * An empty name is not saved over a saved one.
 */
export function saveMenuChoice(storage: MenuStorage, choice: MenuChoice): void {
    write(storage, STORAGE_KEYS.car, choice.car);
    write(storage, STORAGE_KEYS.paint, choice.paint);
    if (!(choice.mode === 'race' && read(storage, STORAGE_KEYS.mode) === 'timetrial')) write(storage, STORAGE_KEYS.mode, choice.mode);
    const name = cleanMenuName(choice.name);
    if (name) write(storage, STORAGE_KEYS.name, name);
}

function step<T>(list: readonly T[], current: T, direction: number): T {
    const n = list.length;
    const index = Math.max(0, list.indexOf(current));
    return list[(((index + direction) % n) + n) % n];
}

/** The next car of the carousel in that direction (+1 right, -1 left), wrapping round. */
export function stepCar(car: CarClassId, direction: number): CarClassId {
    return step(MENU_CARS, car, direction);
}

export function stepPaint(paint: PaintId, direction: number): PaintId {
    return step(PAINT_IDS, paint, direction);
}

export function stepMode(mode: MenuMode, direction: number): MenuMode {
    return step(MENU_MODES, mode, direction);
}

/**
 * The row after `row` going down (+1) or up (-1), stopping at the ends.
 * skipName: the gamepad skips the name field (it cannot type).
 */
export function stepRow(row: MenuRow, direction: number, options: { skipName?: boolean } = {}): MenuRow {
    const rows: readonly MenuRow[] = options.skipName ? MENU_ROWS.filter(r => r !== 'name') : MENU_ROWS;
    // From a row the walk skips (the name for the pad, index -1): its first row
    const index = rows.indexOf(row);
    return rows[Math.min(rows.length - 1, Math.max(0, index + Math.sign(direction)))];
}

/** A navigation step of the keyboard or the gamepad in the menu. */
export type MenuAction = 'up' | 'down' | 'left' | 'right' | 'prevCar' | 'nextCar' | 'activate' | 'settings' | 'back';

export interface MenuFocus {
    choice: MenuChoice;
    row: MenuRow;
}

/**
 * What a navigation action does: up/down move between the rows, left/right
 * change the value of the row (car, paint or mode; nothing on the name and
 * DRIVE rows), LB/RB change the car from anywhere. activate, settings and
 * back leave the state as it is (the controller starts or opens dialogs).
 */
export function navigate(focus: MenuFocus, action: MenuAction, options: { skipName?: boolean } = {}): MenuFocus {
    const { choice, row } = focus;
    switch (action) {
        case 'up':
        case 'down':
            return { choice, row: stepRow(row, action === 'down' ? 1 : -1, options) };
        case 'prevCar':
        case 'nextCar':
            return { choice: { ...choice, car: stepCar(choice.car, action === 'nextCar' ? 1 : -1) }, row };
        case 'left':
        case 'right': {
            const direction = action === 'right' ? 1 : -1;
            if (row === 'car') return { choice: { ...choice, car: stepCar(choice.car, direction) }, row };
            if (row === 'paint') return { choice: { ...choice, paint: stepPaint(choice.paint, direction) }, row };
            if (row === 'mode') return { choice: { ...choice, mode: stepMode(choice.mode, direction) }, row };
            return focus;
        }
        default:
            return focus;
    }
}

/** The menu's view of a gamepad (standard mapping) in one poll. */
export interface PadMenuState {
    up: boolean;
    down: boolean;
    left: boolean;
    right: boolean;
    a: boolean;
    b: boolean;
    lb: boolean;
    rb: boolean;
    menu: boolean;
}

export const IDLE_PAD: PadMenuState = { up: false, down: false, left: false, right: false, a: false, b: false, lb: false, rb: false, menu: false };

// A stick past half way counts as a d-pad press
const STICK_PRESS = 0.5;

interface PadLikeForMenu {
    axes: readonly number[];
    buttons: ReadonlyArray<{ pressed: boolean }>;
}

/** Reads the d-pad (buttons 12-15), the left stick, A, B, LB, RB and Menu (9) of a standard pad. */
export function readPadMenu(pad: PadLikeForMenu | null): PadMenuState {
    if (!pad) return IDLE_PAD;
    const button = (index: number) => !!pad.buttons[index]?.pressed;
    const x = pad.axes[0] ?? 0, y = pad.axes[1] ?? 0;
    return {
        up: button(12) || y < -STICK_PRESS,
        down: button(13) || y > STICK_PRESS,
        left: button(14) || x < -STICK_PRESS,
        right: button(15) || x > STICK_PRESS,
        a: button(0),
        b: button(1),
        lb: button(4),
        rb: button(5),
        menu: button(9)
    };
}

const PAD_ACTIONS: ReadonlyArray<[keyof PadMenuState, MenuAction]> = [
    ['up', 'up'], ['down', 'down'], ['left', 'left'], ['right', 'right'],
    ['lb', 'prevCar'], ['rb', 'nextCar'], ['a', 'activate'], ['b', 'back'], ['menu', 'settings']
];

/** The actions of the buttons pressed since the last poll (a held button acts once). */
export function padMenuActions(previous: PadMenuState, current: PadMenuState): MenuAction[] {
    return PAD_ACTIONS.filter(([key]) => current[key] && !previous[key]).map(([, action]) => action);
}
