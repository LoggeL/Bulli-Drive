import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureCurrentBuild } from '../../src/client/buildVersion.js';

// The stale-client guard in the bundle (src/client/buildVersion.ts): a page
// whose build stamp differs from the server's build-version.txt reloads, at
// most once per server version, and never keeps the game from starting
// when the version file is missing or broken.

const PAGE = 'aaaaaaaaaaaaaaaa';
const NEWER = 'ffffffffffffffff';
const MARKER = 'bulli-build-version-reload';

interface Page {
    reloads: number;
    fetched: string[];
    storage: Map<string, string>;
    warnings: string[];
    // Resolves with the first location.reload()
    reloaded: Promise<'reload'>;
}

function openPage(stamp: string | null, serve: () => Promise<Response>, storageThrows = false): Page {
    let onReload = () => {};
    const reloaded = new Promise<'reload'>(resolve => { onReload = () => resolve('reload'); });
    const page: Page = { reloads: 0, fetched: [], storage: new Map(), warnings: [], reloaded };
    vi.stubGlobal('document', {
        querySelector: (selector: string) =>
            selector === 'meta[name="bulli-build-version"]' && stamp !== null ? { content: stamp } : null
    });
    vi.stubGlobal('fetch', (url: string) => {
        page.fetched.push(url);
        return serve();
    });
    vi.stubGlobal('sessionStorage', {
        getItem: (key: string) => {
            if (storageThrows) throw new Error('SecurityError');
            return page.storage.get(key) ?? null;
        },
        setItem: (key: string, value: string) => {
            if (storageThrows) throw new Error('SecurityError');
            page.storage.set(key, value);
        }
    });
    vi.stubGlobal('window', { location: { reload: () => { page.reloads++; onReload(); } } });
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { page.warnings.push(args.map(String).join(' ')); });
    return page;
}

const text = (body: string, status = 200) => () => Promise.resolve(new Response(body, { status }));

// Whether the check let the game start or reloaded the page instead
// (then it never resolves)
function outcome(page: Page): Promise<'start' | 'reload'> {
    return Promise.race([ensureCurrentBuild().then(() => 'start' as const), page.reloaded]);
}

describe('the build version check', () => {
    beforeEach(() => vi.restoreAllMocks());
    afterEach(() => vi.unstubAllGlobals());

    it('starts the current build without a reload', async () => {
        const page = openPage(PAGE, text(`${PAGE}\n`));
        expect(await outcome(page)).toBe('start');
        expect(page.reloads).toBe(0);
        expect(page.fetched).toEqual(['/build-version.txt']);
    });

    it('reloads a stale page once and holds its game code back', async () => {
        const page = openPage(PAGE, text(`${NEWER}\n`));
        expect(await outcome(page)).toBe('reload');
        expect(page.reloads).toBe(1);
        expect(page.storage.get(MARKER)).toBe(NEWER);
    });

    it('runs the stale build after the reload for the same server version, with a warning', async () => {
        const page = openPage(PAGE, text(NEWER));
        page.storage.set(MARKER, NEWER);
        expect(await outcome(page)).toBe('start');
        expect(page.reloads).toBe(0);
        expect(page.warnings.some(line => line.includes(`Running stale client build ${PAGE}, server has ${NEWER}`))).toBe(true);
    });

    it('reloads again for a yet newer deploy', async () => {
        const page = openPage(PAGE, text(NEWER));
        page.storage.set(MARKER, 'bbbbbbbbbbbbbbbb');
        expect(await outcome(page)).toBe('reload');
        expect(page.reloads).toBe(1);
        expect(page.storage.get(MARKER)).toBe(NEWER);
    });

    it('starts without a check when the version file is missing or broken, or the storage is locked', async () => {
        // (an error status counts even when its body looks like a version)
        for (const serve of [text('gone', 404), text(NEWER, 503), text('<html>not a version</html>'), text('FFFFFFFFFFFFFFFF'), () => Promise.reject(new Error('offline'))]) {
            const page = openPage(PAGE, serve);
            expect(await outcome(page)).toBe('start');
            expect(page.reloads).toBe(0);
            vi.unstubAllGlobals();
            vi.restoreAllMocks();
        }
        // Without sessionStorage there is no loop guard: keep the old build
        const locked = openPage(PAGE, text(NEWER), true);
        expect(await outcome(locked)).toBe('start');
        expect(locked.reloads).toBe(0);
    });

    it('does not check a dev server page without a stamp', async () => {
        const page = openPage(null, text(NEWER));
        expect(await outcome(page)).toBe('start');
        expect(page.fetched).toEqual([]);
        expect(page.reloads).toBe(0);
    });
});
