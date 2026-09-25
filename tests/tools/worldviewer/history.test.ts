import { describe, expect, it } from 'vitest';
import { createHistory, pushHistory, redo, undo } from '../../../tools/worldviewer/logic/history.js';

describe('editor history', () => {
    it('undoes and redoes in order', () => {
        let h = createHistory('a');
        h = pushHistory(h, 'b');
        h = pushHistory(h, 'c');
        h = undo(h);
        expect(h.present).toBe('b');
        h = undo(h);
        expect(h.present).toBe('a');
        // Nothing left to undo: unchanged
        expect(undo(h)).toBe(h);
        h = redo(h);
        expect(h.present).toBe('b');
        h = redo(h);
        expect(h.present).toBe('c');
        expect(redo(h)).toBe(h);
    });

    it('starts empty and redoes back onto the undo stack', () => {
        expect(createHistory('a', 5)).toEqual({ past: [], present: 'a', future: [], limit: 5 });
        const h = redo(undo(pushHistory(createHistory('a'), 'b')));
        expect(h.past).toEqual(['a']);
        expect(undo(h).present).toBe('a');
    });

    it('drops the redo steps on a new edit', () => {
        let h = pushHistory(pushHistory(createHistory('a'), 'b'), 'c');
        h = pushHistory(undo(h), 'd');
        expect(h.future).toEqual([]);
        expect(h.past).toEqual(['a', 'b']);
        expect(h.present).toBe('d');
    });

    it('ignores pushing the present state', () => {
        const h = pushHistory(createHistory('a'), 'b');
        expect(pushHistory(h, 'b')).toBe(h);
    });

    it('keeps at most limit undo steps', () => {
        let h = createHistory(0, 3);
        for (let i = 1; i <= 5; i++) h = pushHistory(h, i);
        expect(h.past).toEqual([2, 3, 4]);
        expect(h.present).toBe(5);
    });
});
