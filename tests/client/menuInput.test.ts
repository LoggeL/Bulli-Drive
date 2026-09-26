// @vitest-environment happy-dom
import * as THREE from 'three';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../../src/client/state.js';

// The game's own actions (horn, shot) stay quiet while the main menu is
// open (docs/ui.md 4.4): its gamepad walks the menu with the same buttons
// (LB/RB change the car), and the car on the pier is not in the game yet.
// The keyboard's guard is in controls/keyboard.ts; these are the gamepad's
// path (vehicle/v2Driver.ts) and the car's own (entities/Bulli.ts).

const sent: string[] = [];
vi.mock('../../src/client/network/socket.js', async importOriginal => ({
    ...await importOriginal<typeof import('../../src/client/network/socket.js')>(),
    sendToServer: (message: { type: string }) => { sent.push(message.type); return true; }
}));
// Nothing here loads a model or a texture
vi.mock('../../src/client/assets/gltfLoader.js', () => ({
    createGltfModelLoader: () => Promise.reject(new Error('no models in this test')),
    getKTX2Loader: () => null
}));
const noopContext = new Proxy({}, { get: () => () => undefined });

let inputManager: typeof import('../../src/client/input/InputManager.js').inputManager;
let Bulli: typeof import('../../src/client/entities/Bulli.js').Bulli;

beforeAll(async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => noopContext as never);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    state.scene = new THREE.Scene();
    ({ inputManager } = await import('../../src/client/input/InputManager.js'));
    // Wires the pad's actions (import side effect)
    await import('../../src/client/vehicle/v2Driver.js');
    ({ Bulli } = await import('../../src/client/entities/Bulli.js'));
});

afterAll(() => {
    state.inMenu = false;
    vi.restoreAllMocks();
});

beforeEach(() => {
    sent.length = 0;
    state.inputs.e = state.inputs.f = false;
    state.dead = false;
    state.isModalOpen = false;
});

describe('the game\'s actions in the menu', () => {
    it('ignores the pad\'s horn (LB) and shot (X) while the menu is open', () => {
        state.inMenu = true;
        inputManager.onAction!('honk');
        inputManager.onAction!('shoot');
        expect(state.inputs.f).toBe(false);
        expect(state.inputs.e).toBe(false);
        // In the game they act
        state.inMenu = false;
        inputManager.onAction!('honk');
        inputManager.onAction!('shoot');
        expect(state.inputs.f).toBe(true);
        expect(state.inputs.e).toBe(true);
    });

    it('lets the car on the pier neither honk nor shoot, and drops what was asked', () => {
        const car = new Bulli(0x5E8C7A, true, 'bulli');
        state.inMenu = true;
        state.inputs.f = true;
        car.handleActions();
        expect(sent).toEqual([]);
        expect(state.inputs.f).toBe(false);
        state.inMenu = false;
        state.inputs.f = true;
        car.handleActions();
        expect(sent).toEqual(['honk']);
        car.dispose();
    });
});
