// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// What index.html tells the player about the drive controls of the v2
// physics (phase 1a): the splash screen's key row, its touch row for phones
// (style.css shows one of the two, see the e2e desktop and mobile specs)
// and the About dialog. SPACE used to jump and is the handbrake now; the
// jump is gone altogether (docs/phase-1a-design.md, 26).

const INDEX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../index.html');
// Parsed inert (a template loads no stylesheets, fonts or scripts)
const template = document.createElement('template');
template.innerHTML = /<body>([\s\S]*)<\/body>/.exec(readFileSync(INDEX, 'utf8'))![1];
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
            'WASD drive', 'SPACE drift', 'SHIFT boost', 'E shoot'
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
