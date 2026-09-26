// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// What index.html tells the player about the drive controls of the v2
// physics (phase 1a): the splash screen's key row, its touch row for phones
// (style.css shows one of the two, see the e2e desktop and mobile specs)
// and the About dialog. SPACE used to jump and is the handbrake now; the
// jump is gone altogether (docs/phase-1a-design.md, 26), so the menu and
// the help name neither it nor its Q key (docs/ui.md D11). And the loading
// screen (docs/ui.md 3): it paints from the page alone.

const INDEX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../index.html');
const html = readFileSync(INDEX, 'utf8');
const head = /<head>([\s\S]*)<\/head>/.exec(html)![1];
// Parsed inert (a template loads no stylesheets, fonts or scripts)
const template = document.createElement('template');
template.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1];
const page = template.content;

// Text as the player reads it: whitespace collapsed
const text = (selector: string) => (page.querySelector(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim();

// "KEY action" pairs of a preview row
function previewPairs(selector: string): string[] {
    const row = page.querySelector(selector);
    expect(row, selector).not.toBeNull();
    return [...row!.querySelectorAll('.preview-keys')].map(key => {
        const next = key.nextElementSibling;
        const desc = next?.classList.contains('preview-desc') ? ` ${next.textContent}` : '';
        return `${key.textContent}${desc}`;
    });
}

// "KEY: action" rows of the About dialog under a section title
function aboutRows(section: string): string[] {
    const title = [...page.querySelectorAll('#modal-body .modal-section-title')].find(h => h.textContent === section);
    expect(title, section).toBeDefined();
    const grid = title!.nextElementSibling!;
    return [...grid.querySelectorAll('.modal-control-row')].map(row => {
        const [key, action] = row.querySelectorAll('span');
        return `${key.textContent}: ${action.textContent}`;
    });
}

describe('the drive controls in index.html', () => {
    it('shows the drive keys on the splash screen', () => {
        expect(previewPairs('.splash-controls-preview .preview-keyboard')).toEqual([
            'WASD drive', 'SPACE drift', 'SHIFT boost', 'R reset', 'E shoot'
        ]);
        expect(text('.preview-keyboard')).not.toMatch(/SPACE jump/);
    });

    it('shows the touch controls instead for phones', () => {
        expect(previewPairs('.splash-controls-preview .preview-touch')).toEqual(['STICK steer', 'AUTO gas', 'DRIFT', 'BOOST']);
    });

    it('lists keys and touch controls in the About dialog', () => {
        expect(aboutRows('Controls')).toEqual([
            'W A S D: Drive & steer',
            'SPACE: Handbrake / drift',
            'SHIFT: Boost (fills while drifting)',
            'R: Hold to reset onto the road',
            'E: Shoot projectile',
            'F: Honk horn'
        ]);
        expect(aboutRows('Touch')).toEqual([
            'STICK: Steer; pull back to brake and reverse',
            'AUTO: Auto-gas on / off',
            'DRIFT: Handbrake / drift (hold)',
            'BOOST: Boost (hold)',
            'RESET: Hold to reset onto the road'
        ]);
        // The old v1 text (jump to recover) is gone
        expect(text('#modal-body')).not.toContain('recover when stuck');
    });

    it('has no jump left: no text, key hint, icon or powerup of it', () => {
        const markup = template.innerHTML;
        expect(markup).not.toMatch(/jump|flip/i);
        const powerups = [...page.querySelectorAll('.modal-powerup-item strong')].map(item => item.textContent);
        expect(powerups).toEqual(['Speed Boost', 'Grow', 'Shield', 'Magnet', 'Ghost']);
        // The touch button that jumped on a tap only resets now
        const reset = page.querySelector('#btn-reset')!;
        expect(reset.getAttribute('aria-label')).toBe('Hold to reset onto the road');
        expect(reset.querySelector('use')?.getAttribute('href')).toBe('#icon-recover');
    });
});

describe('the menu and help texts', () => {
    it('name neither the jump nor the Q key', () => {
        for (const selector of ['#loading-screen', '#splash-screen', '#modal-container']) {
            const text = page.querySelector(selector)!.textContent!.replace(/\s+/g, ' ');
            expect(text, selector).not.toMatch(/jump|flip/i);
            expect(text, selector).not.toMatch(/\bQ\b/);
        }
    });
});

describe('the loading screen', () => {
    const loader = page.querySelector('#loading-screen')!;

    it('has a real progress bar, a status line and a tip per input', () => {
        const bar = loader.querySelector('[role="progressbar"]')!;
        expect(bar.getAttribute('aria-valuemin')).toBe('0');
        expect(bar.getAttribute('aria-valuemax')).toBe('100');
        expect(bar.getAttribute('aria-valuenow')).toBe('0');
        expect(bar.querySelector('.loader-fill')).not.toBeNull();
        expect(loader.querySelector('.loader-status')?.textContent).toBeTruthy();
        expect(loader.querySelector('#loader-live')?.getAttribute('aria-live')).toBe('polite');
        expect(loader.querySelector('.loader-tip .tip-keyboard')?.textContent).toMatch(/SPACE/);
        expect(loader.querySelector('.loader-tip .tip-touch')?.textContent).toMatch(/AUTO/);
        // No cartoon bus and no joke lines any more
        expect(loader.querySelector('.bulli-svg')).toBeNull();
        expect(html).not.toMatch(/Polishing headlights|blinker fluid/);
    });

    it('shows the key art and the wordmark before any game code', () => {
        const img = loader.querySelector<HTMLImageElement>('.keyart img')!;
        expect(img.getAttribute('src')).toBe('/ui/keyart-1920.webp');
        expect(loader.querySelector('.keyart source[media="(orientation: portrait)"]')?.getAttribute('srcset')).toBe('/ui/keyart-portrait-900.webp');
        expect(head).toMatch(/<link rel="preload" as="image" href="\/ui\/keyart-1920\.webp"[^>]*fetchpriority="high"/);
        // The wordmark is paths, no font to wait for (tools/ui/wordmark.mjs)
        const wordmark = loader.querySelector('svg.wordmark');
        expect(wordmark?.getAttribute('aria-label')).toBe('Bulli Drive');
        const d = wordmark?.querySelector('path')?.getAttribute('d') ?? '';
        expect(d.length).toBeGreaterThan(500);
        // Only commands and numbers (a NaN is a console error in the browser)
        expect(d).toMatch(/^M[MLQCZ0-9 .-]+$/);
        // The critical CSS is inline, with the blurred key art as placeholder
        expect(head).toMatch(/<style>[\s\S]*#loading-screen[\s\S]*<\/style>/);
        expect(head).toMatch(/keyart-blur \*\/url\(data:image\/webp;base64,[A-Za-z0-9+/=]+\)\/\* \/keyart-blur/);
    });

    it('keeps the inline CSS and script of the head within 6 KB (docs/ui.md 9)', () => {
        const blocks = [...head.matchAll(/<(style|script)>([\s\S]*?)<\/\1>/g)].map(match => match[2]);
        // The first script is the stale-client guard, which is not the loader's
        const [, ...loader] = blocks;
        const bytes = loader.join('').replace(/url\(data:[^)]*\)/, '').length;
        expect(bytes).toBeLessThanOrEqual(6 * 1024);
    });

    it('loads no fonts from Google, only its own', () => {
        expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
        expect(head).toMatch(/<link rel="preload" as="font" href="\/fonts\/barlow-500\.woff2" type="font\/woff2" crossorigin>/);
    });

    it('keeps the ids the join flow and the tests use', () => {
        for (const selector of ['#splash-screen', '#splash-name-input', '#start-btn', '.mode-option[data-room="party"]']) {
            expect(page.querySelector(selector), selector).not.toBeNull();
        }
    });
});
