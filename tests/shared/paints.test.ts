import { describe, expect, it } from 'vitest';
import { isPaintId, paintByHex, paintById, PAINT_IDS, PAINTS, randomPaint } from '../../src/shared/paints.js';

// The car paints of the menu (docs/ui.md 5): the palette the server hands
// out and validates. Expected values are the table in docs/ui.md 5.

describe('the paint palette', () => {
    it('has the eight paints of docs/ui.md 5 in the menu order', () => {
        expect(PAINTS.map(paint => [paint.id, paint.name, paint.hex])).toEqual([
            ['sea', 'Sea Green', 0x5E8C7A],
            ['cream', 'Pearl White', 0xE6DFCC],
            ['red', 'Sealing Red', 0x8E2A28],
            ['blue', 'Dove Blue', 0x5C7C95],
            ['ochre', 'Ochre', 0xB8862F],
            ['orange', 'Signal Orange', 0xC8612A],
            ['silver', 'Silver', 0x9A9FA3],
            ['anthracite', 'Anthracite', 0x2A2C2E]
        ]);
        expect(PAINT_IDS).toEqual(PAINTS.map(paint => paint.id));
    });

    it('knows its ids and nothing else', () => {
        expect(isPaintId('ochre')).toBe(true);
        for (const value of ['Ochre', 'gold', '', undefined, null, 0x5E8C7A, ['sea']]) expect(isPaintId(value), String(value)).toBe(false);
    });

    it('finds a paint by id (Sea Green for an unknown one) and by exact colour code', () => {
        expect(paintById('blue').hex).toBe(0x5C7C95);
        expect(paintById('gold').id).toBe('sea');
        expect(paintByHex(0xC8612A)?.id).toBe('orange');
        // One step off is no palette paint (an old random colour)
        expect(paintByHex(0xC8612B)).toBeNull();
    });

    it('draws every paint over the random range, never past the last one', () => {
        // floor(r * 8): 0 -> first, 0.125 -> second, just below 1 -> last
        expect(randomPaint(() => 0).id).toBe('sea');
        expect(randomPaint(() => 0.125).id).toBe('cream');
        expect(randomPaint(() => 0.874).id).toBe('silver');
        expect(randomPaint(() => 0.999999).id).toBe('anthracite');
        // A source that returns 1 (outside [0, 1)) still gives a paint
        expect(randomPaint(() => 1).id).toBe('anthracite');
    });
});
