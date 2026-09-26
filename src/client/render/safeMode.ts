// Lite graphics after trouble (a lost WebGL context, a refused one): phones
// that ran out of GPU memory tend to lose the context again on the next
// load, and some browsers then refuse WebGL for the site altogether. After
// such trouble the next loads use the cheapest look (the 'software' tier:
// no environment map, simple shadows, lower car LODs), one device pixel per
// CSS pixel and no MSAA, for SAFE_MODE_DAYS. ?lite=1 forces it, ?lite=0
// clears it.

export const SAFE_MODE_KEY = 'bulli-safe-mode-until';
export const SAFE_MODE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SafeModeEnv {
    search: string;
    storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
    now: number;
}

function browserEnv(): SafeModeEnv {
    let storage: SafeModeEnv['storage'] = null;
    try {
        storage = window.localStorage;
    } catch { /* private mode or blocked storage */ }
    return { search: window.location?.search ?? '', storage, now: Date.now() };
}

/** Whether this load uses lite graphics. */
export function isSafeMode(env: SafeModeEnv = browserEnv()): boolean {
    return safeModeReason(env) !== null;
}

/**
 * Why this load uses lite graphics: the link says so (?lite=1), or the
 * graphics had trouble on this device within SAFE_MODE_DAYS; null when it
 * does not (the loading screen names the reason).
 */
export function safeModeReason(env: SafeModeEnv = browserEnv()): 'link' | 'trouble' | null {
    const forced = new URLSearchParams(env.search).get('lite');
    if (forced === '1') return 'link';
    if (forced === '0') {
        clearSafeMode(env);
        return null;
    }
    let until = NaN;
    try {
        until = Number(env.storage?.getItem(SAFE_MODE_KEY));
    } catch { /* ignore */ }
    return Number.isFinite(until) && until > env.now ? 'trouble' : null;
}

/** Remembers graphics trouble, so the next loads start in lite graphics. */
export function markGraphicsTrouble(env: SafeModeEnv = browserEnv()): void {
    try {
        env.storage?.setItem(SAFE_MODE_KEY, String(env.now + SAFE_MODE_DAYS * DAY_MS));
    } catch { /* ignore */ }
}

export function clearSafeMode(env: SafeModeEnv = browserEnv()): void {
    try {
        env.storage?.removeItem(SAFE_MODE_KEY);
    } catch { /* ignore */ }
}
