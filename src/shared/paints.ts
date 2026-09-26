import type { RandomSource } from './math/rng.js';

// The car paints a player can pick in the menu (docs/ui.md 5): a curated
// palette of calm period colours instead of a free colour picker, so every
// car fits the natural look of Bulli Bay (docs/world-look.md). The server
// hands out one of them (the player's wish from 'hello' or 'setPaint', a
// random one otherwise), and the client paints these values as they are
// (assets/carMaterials.ts); other colours (older resume tickets) are mapped
// into the paint range there.

// A paint taken out of or renamed in the palette: 'hello' tolerates an id
// it does not know (a random paint instead), 'setPaint' drops it; a page
// of an older build reloads on the build check anyway, so no protocol bump.
export const PAINT_IDS = ['sea', 'cream', 'red', 'blue', 'ochre', 'orange', 'silver', 'anthracite'] as const;
export type PaintId = typeof PAINT_IDS[number];

export interface Paint {
    id: PaintId;
    /** Shown in the menu and read out by screen readers */
    name: string;
    /** sRGB colour code */
    hex: number;
}

export const PAINTS: readonly Paint[] = [
    { id: 'sea', name: 'Sea Green', hex: 0x5E8C7A },
    { id: 'cream', name: 'Pearl White', hex: 0xE6DFCC },
    { id: 'red', name: 'Sealing Red', hex: 0x8E2A28 },
    { id: 'blue', name: 'Dove Blue', hex: 0x5C7C95 },
    { id: 'ochre', name: 'Ochre', hex: 0xB8862F },
    { id: 'orange', name: 'Signal Orange', hex: 0xC8612A },
    { id: 'silver', name: 'Silver', hex: 0x9A9FA3 },
    { id: 'anthracite', name: 'Anthracite', hex: 0x2A2C2E }
];

export function isPaintId(value: unknown): value is PaintId {
    return typeof value === 'string' && (PAINT_IDS as readonly string[]).includes(value);
}

/** The paint of that id (Sea Green for anything else). */
export function paintById(id: unknown): Paint {
    return PAINTS.find(paint => paint.id === id) ?? PAINTS[0];
}

/** The palette paint with exactly this colour code, or null. */
export function paintByHex(hex: number): Paint | null {
    return PAINTS.find(paint => paint.hex === hex) ?? null;
}

/** A paint drawn from the palette (a new player without a wish, race bots). */
export function randomPaint(random: RandomSource): Paint {
    return PAINTS[Math.min(PAINTS.length - 1, Math.floor(random() * PAINTS.length))];
}
