import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Size budgets of the loading screen's and the menu's assets (docs/ui.md
// 9): the key art (tools/ui/keyart.ts), the menu's car renders
// (tools/ui/menu-renders.mjs) and the self-hosted fonts, measured on disk.
// A heavier render or another font cut shows up here, not only on a slow
// phone.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const kb = (file: string) => statSync(path.join(ROOT, file)).size / 1024;

// WebP: "RIFF" <size> "WEBP"; the VP8/VP8L/VP8X chunk holds the canvas size
function webpSize(file: string): [number, number] {
    const bytes = readFileSync(path.join(ROOT, file));
    expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
    expect(bytes.toString('ascii', 8, 12)).toBe('WEBP');
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8 ') return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
    if (chunk === 'VP8X') return [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3)];
    const bits = bytes.readUInt32LE(21);
    return [1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)];
}

describe('the loading screen assets', () => {
    it('keeps the key art of each layout, and its lite render, within its budgets and sizes', () => {
        for (const lite of ['', 'lite-']) {
            expect(kb(`public/ui/keyart-${lite}1920.webp`), lite).toBeLessThanOrEqual(250);
            expect(webpSize(`public/ui/keyart-${lite}1920.webp`), lite).toEqual([1920, 1080]);
            // Phones upright (390 x 750 at 2x) and sideways (844 x 390 at 2x)
            expect(kb(`public/ui/keyart-${lite}portrait.webp`), lite).toBeLessThanOrEqual(120);
            expect(webpSize(`public/ui/keyart-${lite}portrait.webp`), lite).toEqual([780, 1500]);
            expect(kb(`public/ui/keyart-${lite}phone-landscape.webp`), lite).toBeLessThanOrEqual(120);
            expect(webpSize(`public/ui/keyart-${lite}phone-landscape.webp`), lite).toEqual([1688, 780]);
        }
    });

    it('keeps the inline placeholder within 1.5 KB', () => {
        const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
        const placeholder = /keyart-blur \*\/url\((data:[^)]*)\)/.exec(html)![1];
        expect(placeholder.length).toBeLessThanOrEqual(1.5 * 1024);
    });

    it('keeps the two Barlow cuts within 60 KB, with their licence', () => {
        expect(kb('public/fonts/barlow-500.woff2') + kb('public/fonts/barlow-semi-condensed-600.woff2')).toBeLessThanOrEqual(60);
        const licences = readFileSync(path.join(ROOT, 'public/fonts/LICENSES.md'), 'utf8');
        // Righteous and Quicksand are the HUD's until it moves to Barlow (docs/ui.md 13)
        for (const file of ['barlow-500', 'barlow-semi-condensed-600', 'righteous-400', 'quicksand-variable']) {
            expect(licences).toContain(`${file}.woff2`);
            expect(readFileSync(path.join(ROOT, `public/fonts/${file}.woff2`)).toString('ascii', 0, 4)).toBe('wOF2');
        }
    });
});

describe('the menu assets', () => {
    it('renders each car for its card at 640 x 360 within 20 KB', () => {
        for (const car of ['bulli', 'beetle', 'pickup', 'sport', 'jeep']) {
            const file = `public/icons/car-${car}-menu.webp`;
            expect(kb(file), car).toBeLessThanOrEqual(20);
            expect(webpSize(file), car).toEqual([640, 360]);
        }
    });

    it('serves no font the menu and the HUD do not use', () => {
        const licences = readFileSync(path.join(ROOT, 'public/fonts/LICENSES.md'), 'utf8');
        expect(licences).not.toMatch(/Permanent Marker/);
    });
});
