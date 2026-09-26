// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Sound on or off (src/client/effects/sounds.ts, docs/ui.md 4.3): every
// sound runs through one master gain, which starts at the setting kept from
// the last visit and follows the switch. The audio graph is a stand-in that
// records the nodes; nothing plays.

interface FakeGain {
    gain: { value: number; setTargetAtTime(value: number): void; setValueAtTime(): void; exponentialRampToValueAtTime(): void; linearRampToValueAtTime(): void };
    connect(target: unknown): void;
    target: unknown;
    context: unknown;
}

function fakeContext() {
    const gains: FakeGain[] = [];
    const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {} });
    const context = {
        state: 'running',
        currentTime: 0,
        destination: { name: 'speakers' },
        createGain() {
            const node: FakeGain = {
                gain: { ...param(), value: 1, setTargetAtTime(value: number) { node.gain.value = value; } },
                target: null,
                context,
                connect(target) { node.target = target; }
            };
            gains.push(node);
            return node;
        },
        createOscillator: () => ({ type: '', frequency: param(), connect() {}, start() {}, stop() {} })
    };
    // The master is the gain wired to the speakers
    const masters = () => gains.filter(node => node.target === context.destination);
    return { context, master: () => masters()[0], masters };
}

let sounds: typeof import('../../src/client/effects/sounds.js');
let state: typeof import('../../src/client/state.js').state;

// A fresh page: the setting is read when the module loads
async function load(): Promise<void> {
    sounds = await import('../../src/client/effects/sounds.js');
    ({ state } = await import('../../src/client/state.js'));
}

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
});

afterEach(() => {
    localStorage.clear();
});

describe('the sound setting', () => {
    it('starts muted when it was switched off on the last visit', async () => {
        localStorage.setItem('bulli-sound', 'off');
        await load();
        const { context, master } = fakeContext();
        state.audioCtx = context as never;
        sounds.playHitSound();
        expect(sounds.soundEnabled()).toBe(false);
        expect(master()!.gain.value).toBe(0);
        // Switched on: the master follows, and the next visit keeps it
        sounds.setSoundEnabled(true);
        expect(master()!.gain.value).toBe(1);
        expect(localStorage.getItem('bulli-sound')).toBe('on');
    });

    it('starts at full volume by default, and mutes every sound with the switch', async () => {
        await load();
        const { context, master, masters } = fakeContext();
        state.audioCtx = context as never;
        sounds.playHitSound();
        expect(master()!.gain.value).toBe(1);
        sounds.setSoundEnabled(false);
        expect(master()!.gain.value).toBe(0);
        // One master for the page: the next sound goes through the same, muted one
        sounds.playHitSound();
        expect(masters()).toHaveLength(1);
        expect(master()!.gain.value).toBe(0);
    });
});
