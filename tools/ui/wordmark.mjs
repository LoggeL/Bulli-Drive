// The "BULLI DRIVE" wordmark of the loading screen and the menu (docs/ui.md 2):
// the letters of Barlow Semi Condensed SemiBold as SVG paths, so the
// wordmark stands on the first paint without waiting for a font. Writes the
// <svg> into index.html between every pair of
//   <!-- wordmark -->  ...  <!-- /wordmark -->
// markers (run again after a change of text, font or tracking):
//
//   node tools/ui/wordmark.mjs
//
// The font comes from @fontsource/barlow-semi-condensed (SIL OFL 1.1) in
// tools/node_modules: WOFF 1, which opentype.js reads (it has no WOFF2).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const opentype = require('opentype.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INDEX = path.join(ROOT, 'index.html');
const FONT = path.join(path.dirname(require.resolve('@fontsource/barlow-semi-condensed/package.json')),
    'files/barlow-semi-condensed-latin-600-normal.woff');

const TEXT = 'BULLI DRIVE';
const SIZE = 100;          // font units per em mapped to 100 SVG units
const TRACKING = 0.16;     // letter spacing in em (wide, like the mockups)
const WORD_GAP = 0.12;     // extra space between the two words in em

const bytes = fs.readFileSync(FONT);
const font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const scale = SIZE / font.unitsPerEm;
const ascender = font.tables.os2.sCapHeight * scale;

// Path data with one decimal (opentype.js 2.0's own toPathData(1) turns
// some values, e.g. 224.00000000000003, into NaN)
const num = value => String(Math.round(value * 10) / 10);
function pathData(path) {
    return path.commands.map(c => {
        switch (c.type) {
            case 'M': case 'L': return `${c.type}${num(c.x)} ${num(c.y)}`;
            case 'Q': return `Q${num(c.x1)} ${num(c.y1)} ${num(c.x)} ${num(c.y)}`;
            case 'C': return `C${num(c.x1)} ${num(c.y1)} ${num(c.x2)} ${num(c.y2)} ${num(c.x)} ${num(c.y)}`;
            case 'Z': return 'Z';
            default: throw new Error(`path command ${c.type}`);
        }
    }).join('');
}

let x = 0;
const parts = [];
const glyphs = font.stringToGlyphs(TEXT);
glyphs.forEach((glyph, i) => {
    if (TEXT[i] === ' ') {
        x += glyph.advanceWidth * scale + WORD_GAP * SIZE;
        return;
    }
    // Baseline at the cap height, so the box starts at the top of the capitals
    parts.push(pathData(glyph.getPath(x, ascender, SIZE)));
    x += glyph.advanceWidth * scale;
    if (i < glyphs.length - 1) {
        x += font.getKerningValue(glyph, glyphs[i + 1]) * scale + TRACKING * SIZE;
    }
});

const width = Math.ceil(x);
const height = Math.ceil(ascender);
if (parts.some(part => part.includes('NaN'))) throw new Error('wordmark path with NaN');
const svg = `<svg class="wordmark" viewBox="0 0 ${width} ${height}" role="img" aria-label="Bulli Drive"><path fill="currentColor" d="${parts.join('')}"/></svg>`;

const html = fs.readFileSync(INDEX, 'utf8');
const marker = /(<!-- wordmark -->)[\s\S]*?(<!-- \/wordmark -->)/g;
const count = (html.match(marker) ?? []).length;
if (!count) throw new Error('index.html has no <!-- wordmark --> ... <!-- /wordmark --> markers');
fs.writeFileSync(INDEX, html.replace(marker, `$1${svg}$2`));
console.log(`wordmark ${width} x ${height}, ${svg.length} bytes, written ${count}x into index.html`);
