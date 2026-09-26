// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { destroyMobileControls, resetMobileControls, setupMobileControls } from '../../src/client/controls/mobile.js';
import { inputManager } from '../../src/client/input/InputManager.js';
import { state } from '../../src/client/state.js';
import { createVehicleInput } from '../../src/shared/sim/types.js';

// The touch HUD's DOM layer (src/client/controls/mobile.ts,
// docs/phase-1a-design.md 11.2) on the real markup of index.html: pointer
// events on the stick and the buttons end up as the input of the next sim
// tick. The rules behind it (brake threshold, auto-gas, the flip button's
// hold time) are tested on InputManager in input.test.ts; this checks the
// wiring - which button sets which bit, which way the stick's axes point.
// Bits as the protocol defines them (docs/phase-1a-design.md, 11.1):
// handbrake 1, boost 2, reset 8 (4 was the jump, section 26).
const HANDBRAKE = 1;
const BOOST = 2;
const RESET = 8;

const INDEX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../index.html');
const BODY = /<body>([\s\S]*)<\/body>/.exec(readFileSync(INDEX, 'utf8'))![1]
    .replace(/<script[\s\S]*?<\/script>/g, '');

// The stick's base: 120 px wide at (100, 400), so its centre is (160, 460)
// and the rim 60 px out (happy-dom has no layout)
const BASE = { left: 100, top: 400, width: 120, height: 120 };
const CENTER = { x: BASE.left + BASE.width / 2, y: BASE.top + BASE.height / 2 };
const RADIUS = BASE.width / 2;

// requestAnimationFrame by hand: the stick filters its position per frame
let frameQueue: FrameRequestCallback[] = [];
let frameTime = 1000;
function frames(count: number): void {
    for (let i = 0; i < count; i++) {
        frameTime += 1000 / 60;
        const queue = frameQueue;
        frameQueue = [];
        for (const callback of queue) callback(frameTime);
    }
}

const out = createVehicleInput();
const tick = () => ({ ...inputManager.sampleTick(out) });

function pointer(type: string, target: Element, id: number, x = 0, y = 0): void {
    target.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true, cancelable: true }));
}

const byId = (id: string) => document.getElementById(id)!;

beforeAll(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frameQueue.push(callback));
    vi.stubGlobal('cancelAnimationFrame', () => { frameQueue = []; });
});

afterAll(() => {
    vi.unstubAllGlobals();
});

beforeEach(() => {
    document.body.innerHTML = BODY;
    const base = document.querySelector('#joystick-move .joystick-base')!;
    vi.spyOn(base, 'getBoundingClientRect').mockReturnValue(
        { ...BASE, x: BASE.left, y: BASE.top, right: BASE.left + BASE.width, bottom: BASE.top + BASE.height, toJSON: () => ({}) } as DOMRect
    );
    try { localStorage.clear(); } catch { /* no storage */ }
    state.isModalOpen = false;
    inputManager.touchUi = true;
    setupMobileControls();
    frameQueue = [];
});

afterEach(() => {
    destroyMobileControls();
    inputManager.releaseAll();
    inputManager.touchUi = false;
    vi.restoreAllMocks();
});

describe('touch buttons', () => {
    it('DRIFT holds the handbrake, BOOST the boost, each for as long as its finger stays', () => {
        pointer('pointerdown', byId('btn-drift'), 2);
        expect(tick().buttons).toBe(HANDBRAKE);
        expect(tick().buttons).toBe(HANDBRAKE);
        pointer('pointerdown', byId('btn-boost'), 3);
        expect(tick().buttons).toBe(HANDBRAKE | BOOST);
        pointer('pointerup', byId('btn-drift'), 2);
        expect(tick().buttons).toBe(BOOST);
        pointer('pointerup', byId('btn-boost'), 3);
        expect(tick().buttons).toBe(0);
    });

    it('a second finger on DRIFT while the first one steers', () => {
        const stick = byId('joystick-move');
        pointer('pointerdown', stick, 1, CENTER.x - RADIUS, CENTER.y);
        frames(30);
        pointer('pointerdown', byId('btn-drift'), 2);
        const input = tick();
        expect(input.buttons).toBe(HANDBRAKE);
        expect(input.steer).toBe(127);
        // The finger on the stick lifting does not release DRIFT
        pointer('pointerup', stick, 1);
        expect(tick().buttons).toBe(HANDBRAKE);
    });

    it('lets go of every held button on blur (app switch, notification)', () => {
        pointer('pointerdown', byId('btn-drift'), 2);
        pointer('pointerdown', byId('btn-boost'), 3);
        window.dispatchEvent(new Event('blur'));
        expect(tick().buttons).toBe(0);
    });

    it('ignores the buttons while a dialog is open', () => {
        state.isModalOpen = true;
        pointer('pointerdown', byId('btn-drift'), 2);
        expect(tick().buttons).toBe(0);
    });

    it('the flip button holds reset while pressed; a tap sends nothing else (no jump)', () => {
        const flip = byId('btn-flip');
        pointer('pointerdown', flip, 4);
        expect(tick().buttons).toBe(RESET);
        pointer('pointerup', flip, 4);
        expect(tick().buttons).toBe(0);

        // Held for half a second (30 ticks, RESET_HOLD_TICKS): reset all
        // along, and nothing when the finger lifts
        pointer('pointerdown', flip, 4);
        for (let i = 0; i < 30; i++) expect(tick().buttons).toBe(RESET);
        pointer('pointerup', flip, 4);
        expect(tick().buttons).toBe(0);
    });
});

describe('the race layout (docs/phase-2-design.md, 17.5)', () => {
    it('BRAKE brakes while held; the stick pulled back only steers', () => {
        inputManager.setRaceTouch(true);
        try {
            const stick = byId('joystick-move');
            // Pulled back and to the left: no brake, just steering
            pointer('pointerdown', stick, 1, CENTER.x - RADIUS, CENTER.y + RADIUS);
            frames(30);
            let input = tick();
            expect(input.brake).toBe(0);
            expect(input.steer).toBe(127);
            pointer('pointerup', stick, 1);
            pointer('pointerdown', byId('btn-brake'), 5);
            input = tick();
            expect(input.brake).toBe(255);
            expect(input.throttle).toBe(0);
            pointer('pointerup', byId('btn-brake'), 5);
            expect(tick().brake).toBe(0);
        } finally {
            inputManager.setRaceTouch(false);
        }
    });
});

describe('the stick', () => {
    it('pulled down brakes, pushed up gives gas without auto-gas, to the left steers left', () => {
        // Auto-gas off (the AUTO button), so the stick alone decides
        byId('btn-autogas').click();
        expect(byId('btn-autogas').getAttribute('aria-pressed')).toBe('false');
        const stick = byId('joystick-move');

        pointer('pointerdown', stick, 1, CENTER.x, CENTER.y + RADIUS);
        frames(30);
        expect(tick()).toMatchObject({ brake: 255, throttle: 0, steer: 0 });

        pointer('pointermove', stick, 1, CENTER.x, CENTER.y - RADIUS);
        frames(30);
        expect(tick()).toMatchObject({ brake: 0, throttle: 255, steer: 0 });

        // A finger past the rim counts as the rim
        pointer('pointermove', stick, 1, CENTER.x - 3 * RADIUS, CENTER.y);
        frames(30);
        expect(tick()).toMatchObject({ steer: 127, brake: 0 });

        // Released: back to rest at once
        pointer('pointerup', stick, 1);
        expect(tick()).toMatchObject({ steer: 0, throttle: 0, brake: 0 });
    });

    it('stays at rest inside the deadzone and eases in towards a new position', () => {
        byId('btn-autogas').click();
        const stick = byId('joystick-move');
        // 4 px of 60 is inside the deadzone (12 %)
        pointer('pointerdown', stick, 1, CENTER.x, CENTER.y - 4);
        frames(30);
        expect(tick()).toMatchObject({ steer: 0, throttle: 0, brake: 0 });

        // Straight to the rim: the first frame goes 1 - e^(-30/60) = 39 % of
        // the way (filter rate 30/s, one 60 Hz frame), 100 of 255
        pointer('pointermove', stick, 1, CENTER.x, CENTER.y - RADIUS);
        frames(1);
        expect(tick().throttle).toBe(100);
        frames(30);
        expect(tick().throttle).toBe(255);
    });

    it('with auto-gas, the first touch starts driving and the car keeps going after release', () => {
        expect(tick().throttle).toBe(0);
        const stick = byId('joystick-move');
        pointer('pointerdown', stick, 1, CENTER.x, CENTER.y - 4);
        frames(1);
        pointer('pointerup', stick, 1);
        expect(tick()).toMatchObject({ throttle: 255, brake: 0 });
        // resetMobileControls (death, respawn) stops it until the next touch
        resetMobileControls();
        expect(tick().throttle).toBe(0);
    });
});
