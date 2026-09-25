import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The map data that reaches the sim or a hash both sides compare
// (heightfield, road samples, rail colliders, track definitions) and the
// bake, which the worldviewer repeats in the browser, must come out
// bit-identical in every JavaScript engine (docs/phase-3-design.md, E4 and
// 5.3). ECMAScript rounds +, -, ×, ÷ and Math.sqrt exactly; Math.hypot, the
// trigonometric, exponential and logarithmic functions and ** are only
// "implementation-approximated" and differ between V8, JavaScriptCore and
// SpiderMonkey in the last bit. A line that uses one on purpose (a rounded
// result, a report text) says so with "determinism:" in a comment.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const FILES = [
    'src/shared/map/corridor.ts',
    'src/shared/map/geometry.ts',
    'src/shared/map/heightfield.ts',
    'src/shared/map/rails.ts',
    'src/shared/map/roadNetwork.ts',
    'src/shared/map/roadSchema.ts',
    'src/shared/map/spline.ts',
    'src/shared/map/trackRoute.ts',
    'tools/map/bakeSources.ts',
    'tools/map/bakeTerrain.ts',
    'tools/map/baseTerrain.ts'
];

const APPROXIMATED = /Math\.(hypot|atan2|atan|asin|acos|sin|cos|tan|sinh|cosh|tanh|asinh|acosh|atanh|exp|expm1|log|log1p|log2|log10|pow|cbrt)\b|\*\*/;

// Code of a line without its comment (a "//" inside a string does not occur
// in these files)
function code(line: string): string {
    const at = line.indexOf('//');
    return at >= 0 ? line.slice(0, at) : line;
}

// Block comments blanked out, line breaks kept (so line numbers still fit)
function withoutBlockComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '));
}

describe('map modules use only exactly rounded arithmetic', () => {
    for (const file of FILES) {
        it(file, () => {
            const lines = withoutBlockComments(readFileSync(path.join(ROOT, file), 'utf8')).split('\n');
            const offending = lines
                .map((line, i) => ({ line, n: i + 1 }))
                .filter(({ line }) => APPROXIMATED.test(code(line)) && !line.includes('determinism:'))
                .map(({ line, n }) => `${n}: ${line.trim()}`);
            expect(offending).toEqual([]);
        });
    }

    it('catches Math.hypot, Math.atan2 and ** in code but not in comments or marked lines', () => {
        const flagged = (line: string) => APPROXIMATED.test(code(line)) && !line.includes('determinism:');
        expect(flagged('const d = Math.hypot(dx, dz);')).toBe(true);
        expect(flagged('const yaw = Math.atan2(tx, tz);')).toBe(true);
        expect(flagged('const a = x ** 2;')).toBe(true);
        expect(flagged('const d = Math.sqrt(dx * dx + dz * dz); // not Math.hypot')).toBe(false);
        expect(flagged('const y = Math.round(Math.atan2(a, b) * 1e6) / 1e6; // determinism: rounded')).toBe(false);
        expect(withoutBlockComments('/**\n * Math.hypot\n */\nx').split('\n').some(flagged)).toBe(false);
    });
});
