import { describe, expect, it } from 'vitest';
import { inputKindFor, LOADER_TIPS, tipFor } from '../../src/client/ui/loaderTips.js';

// The loading screen's tips (docs/ui.md 3.1) follow the input the player
// drives with, and none of them names the jump (removed on the branch
// sim/airborne-no-jump) or its Q key.

describe('the loading screen tips', () => {
    it('picks the gamepad once one is connected, else touch on a coarse pointer, else keys', () => {
        expect(inputKindFor({ coarsePointer: false, gamepad: false })).toBe('keyboard');
        expect(inputKindFor({ coarsePointer: true, gamepad: false })).toBe('touch');
        expect(inputKindFor({ coarsePointer: true, gamepad: true })).toBe('gamepad');
        expect(inputKindFor({ coarsePointer: false, gamepad: true })).toBe('gamepad');
    });

    it('cycles through the tips of one input', () => {
        const n = LOADER_TIPS.touch.length;
        expect(tipFor('touch', 0)).toBe(LOADER_TIPS.touch[0]);
        expect(tipFor('touch', n)).toBe(LOADER_TIPS.touch[0]);
        expect(tipFor('touch', n + 1)).toBe(LOADER_TIPS.touch[1]);
        expect(tipFor('touch', -1)).toBe(LOADER_TIPS.touch[n - 1]);
    });

    it('names the keys of each input and never the jump', () => {
        const all = Object.values(LOADER_TIPS).flat();
        for (const tip of all) {
            expect(tip).not.toMatch(/jump|flip/i);
            expect(tip).not.toMatch(/\bQ\b/);
        }
        expect(LOADER_TIPS.keyboard.join(' ')).toMatch(/SPACE.*drift/);
        expect(LOADER_TIPS.touch.join(' ')).not.toMatch(/SPACE|SHIFT|\bR\b/);
        expect(LOADER_TIPS.gamepad.join(' ')).not.toMatch(/SPACE|SHIFT|WASD/);
    });
});
