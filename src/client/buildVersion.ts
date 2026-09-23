// Stale-client guard. index.html and build-version.txt are served no-store,
// the hashed JS/CSS in /assets are immutable. The build stamps its version
// into index.html (<meta name="bulli-build-version">, see vite.config.ts); if
// a page from an older deploy is still running (cached HTML, restored tab),
// that stamp differs from the server's build-version.txt and we reload once.

const RELOAD_MARKER_KEY = 'bulli-build-version-reload';

function readPageBuildVersion(): string | null {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="bulli-build-version"]');
    return meta?.content || null;
}

async function fetchServerBuildVersion(): Promise<string> {
    const response = await fetch('/build-version.txt', { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`Unable to load client build version (${response.status})`);
    }
    const version = (await response.text()).trim();
    if (!/^[a-f0-9]{16}$/.test(version)) {
        throw new Error('Invalid client build version');
    }
    return version;
}

/**
 * Resolves once this page is the current build. On a mismatch it triggers a
 * reload and never resolves, so the stale game code does not start.
 */
export async function ensureCurrentBuild(): Promise<void> {
    const pageVersion = readPageBuildVersion();
    // Dev server (Vite) pages carry no stamp; HMR keeps them current.
    if (!pageVersion) return;

    let serverVersion: string;
    try {
        serverVersion = await fetchServerBuildVersion();
    } catch (err) {
        // The bundle is self-consistent (content-hashed), so a missing version
        // file must not keep the game from starting.
        console.warn('Skipping client build version check', err);
        return;
    }
    if (serverVersion === pageVersion) return;

    // Reload at most once per server version to avoid loops behind a cache
    // that keeps serving the old page. Without sessionStorage there is no such
    // guard, so we keep running the (self-consistent) old build instead.
    try {
        if (sessionStorage.getItem(RELOAD_MARKER_KEY) === serverVersion) {
            console.warn(`Running stale client build ${pageVersion}, server has ${serverVersion}`);
            return;
        }
        sessionStorage.setItem(RELOAD_MARKER_KEY, serverVersion);
    } catch (err) {
        console.warn('Cannot guard stale-client reload, keeping current build', err);
        return;
    }

    window.location.reload();
    await new Promise<never>(() => { /* page is reloading */ });
}
