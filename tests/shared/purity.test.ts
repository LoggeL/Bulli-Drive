import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// src/shared runs on both sides: in the browser bundle and in the Node
// server (and later in the headless simulation). It must not pull in three,
// the DOM or Node-only modules.

const SHARED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/shared');

function listSourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) return listSourceFiles(full);
        return /\.ts$/.test(entry) ? [full] : [];
    });
}

// Strips comments so documentation may still mention "three" or "window".
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function importSpecifiers(source: string): string[] {
    const specifiers: string[] = [];
    const patterns = [
        /\bimport\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g,
        /\bexport\s+(?:type\s+)?[^'"`;]*?\s+from\s+['"]([^'"]+)['"]/g,
        /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
        /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    ];
    for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
    }
    return specifiers;
}

// Bare packages src/shared may use. Everything else must be a relative import
// that stays inside src/shared.
const ALLOWED_PACKAGES = ['valibot'];

const DOM_GLOBALS = [
    'window', 'document', 'navigator', 'localStorage', 'sessionStorage',
    'HTMLElement', 'requestAnimationFrame', 'performance', 'WebSocket', 'process'
];

const files = listSourceFiles(SHARED_DIR);

describe('src/shared stays platform neutral', () => {
    it('finds the shared sources', () => {
        expect(files.length).toBeGreaterThan(0);
    });

    for (const file of files) {
        const relative = path.relative(SHARED_DIR, file);
        const source = stripComments(readFileSync(file, 'utf8'));

        it(`${relative} only imports allowed modules`, () => {
            for (const specifier of importSpecifiers(source)) {
                if (specifier.startsWith('.')) {
                    const target = path.resolve(path.dirname(file), specifier);
                    expect(target.startsWith(SHARED_DIR + path.sep), `${specifier} leaves src/shared`).toBe(true);
                } else {
                    expect(ALLOWED_PACKAGES, `${specifier} is not allowed in src/shared`).toContain(specifier);
                }
            }
        });

        it(`${relative} does not touch DOM or Node globals`, () => {
            for (const name of DOM_GLOBALS) {
                expect(new RegExp(`\\b${name}\\s*[.(\\[]`).test(source), `${name} used`).toBe(false);
            }
        });

        // World generation and the simulation must come out the same on
        // every machine and in every replay
        it(`${relative} uses no unseeded randomness or wall-clock time`, () => {
            expect(/\bMath\.random\b/.test(source), 'Math.random used').toBe(false);
            expect(/\bDate\.now\b|\bnew\s+Date\b/.test(source), 'wall-clock time used').toBe(false);
        });
    }
});
