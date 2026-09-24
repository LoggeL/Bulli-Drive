import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// The inline stale-asset guard at the top of index.html: an index.html from
// an older deploy points at hashed /assets files the server no longer has,
// so the bundle (and its own version check) never runs. The guard reloads
// once per page build and then gives up, so a broken deploy cannot loop.
// The script is taken from index.html as it ships and run against a fake
// window, the way the browser runs it before any other script.

const INDEX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../index.html');
const ORIGIN = 'https://bulli.example';
const BUILD = '0123456789abcdef';
const MARKER = 'bulli-asset-reload';

function guardScript(): string {
    const html = readFileSync(INDEX, 'utf8');
    const match = /<script>([\s\S]*?)<\/script>/.exec(html);
    expect(match, 'the inline guard in index.html').not.toBeNull();
    // It has to come before Vite's asset tags, which go to the end of <head>
    expect(match!.index).toBeLessThan(html.indexOf('<link rel="stylesheet"'));
    return match![1];
}

class FakeScript { constructor(readonly src: string) {} }
class FakeLink { constructor(readonly href: string) {} }
class FakeImage { constructor(readonly src: string) {} }

interface Page {
    // A resource failed to load: the 'error' event as it reaches window in
    // the capture phase
    fail(target: object): void;
    reloads: number;
    warnings: string[];
    storage: Map<string, string>;
}

function openPage(options: { build?: string | null; storage?: Map<string, string>; storageThrows?: boolean } = {}): Page {
    const build = options.build === undefined ? BUILD : options.build;
    const listeners: Array<{ type: string; listener: (event: { target: object }) => void; capture: boolean }> = [];
    const page: Page = {
        fail(target) {
            for (const entry of listeners) if (entry.type === 'error' && entry.capture) entry.listener({ target });
        },
        reloads: 0,
        warnings: [],
        storage: options.storage ?? new Map()
    };
    const storage = {
        getItem(key: string) {
            if (options.storageThrows) throw new Error('SecurityError');
            return page.storage.get(key) ?? null;
        },
        setItem(key: string, value: string) {
            if (options.storageThrows) throw new Error('SecurityError');
            page.storage.set(key, value);
        }
    };
    const window = {
        addEventListener(type: string, listener: (event: { target: object }) => void, capture?: boolean) {
            listeners.push({ type, listener, capture: capture === true });
        },
        location: { href: `${ORIGIN}/`, origin: ORIGIN, reload() { page.reloads++; } }
    };
    const context = vm.createContext({
        window,
        document: {
            querySelector: (selector: string) =>
                selector === 'meta[name="bulli-build-version"]' && build ? { content: build } : null
        },
        sessionStorage: storage,
        console: { warn: (...args: unknown[]) => page.warnings.push(args.map(String).join(' ')) },
        URL,
        HTMLScriptElement: FakeScript,
        HTMLLinkElement: FakeLink
    });
    vm.runInContext(guardScript(), context);
    return page;
}

describe('the stale-asset guard in index.html', () => {
    it('reloads once when a hashed script or stylesheet of the page is gone', () => {
        const page = openPage();
        page.fail(new FakeScript(`${ORIGIN}/assets/index-0ldBu1ld.js`));
        expect(page.reloads).toBe(1);
        expect(page.storage.get(MARKER)).toBe(BUILD);
        // Further failures of the same page load do nothing more (and do
        // not claim the reload failed)
        page.fail(new FakeLink(`${ORIGIN}/assets/index-0ldBu1ld.css`));
        expect(page.reloads).toBe(1);
        expect(page.warnings.filter(line => line.includes('failed to load again'))).toEqual([]);

        const css = openPage();
        css.fail(new FakeLink('/assets/index-0ldBu1ld.css'));
        expect(css.reloads).toBe(1);
    });

    it('gives up after one reload for the same build, so a broken deploy cannot loop', () => {
        const storage = new Map<string, string>();
        openPage({ storage }).fail(new FakeScript(`${ORIGIN}/assets/index-0ldBu1ld.js`));
        // The reloaded page is the same broken build
        const again = openPage({ storage });
        again.fail(new FakeScript(`${ORIGIN}/assets/index-0ldBu1ld.js`));
        expect(again.reloads).toBe(0);
        expect(again.warnings.join('\n')).toContain(`Client assets of build ${BUILD} failed to load again`);

        // A newer build that breaks the same way gets its own one reload
        const newer = openPage({ storage, build: 'fedcba9876543210' });
        newer.fail(new FakeScript(`${ORIGIN}/assets/index-n3wBu1ld.js`));
        expect(newer.reloads).toBe(1);
    });

    it('ignores what is not a hashed asset of this origin', () => {
        const page = openPage();
        page.fail(new FakeScript('https://cdn.example/assets/index-abc.js'));
        page.fail(new FakeLink('https://fonts.googleapis.com/css2?family=Righteous'));
        page.fail(new FakeScript(`${ORIGIN}/models/manifest.js`));
        page.fail(new FakeImage(`${ORIGIN}/assets/logo.png`));
        page.fail(new FakeScript(''));
        expect(page.reloads).toBe(0);
        expect(page.storage.size).toBe(0);
    });

    it('does nothing on a dev server page without a build stamp, or without sessionStorage', () => {
        const dev = openPage({ build: null });
        dev.fail(new FakeScript(`${ORIGIN}/assets/index-abc.js`));
        expect(dev.reloads).toBe(0);
        expect(dev.warnings).toEqual([]);
        expect(dev.storage.size).toBe(0);

        const locked = openPage({ storageThrows: true });
        locked.fail(new FakeScript(`${ORIGIN}/assets/index-abc.js`));
        expect(locked.reloads).toBe(0);
        expect(locked.warnings.join('\n')).toContain('Cannot guard the asset reload');
    });
});
