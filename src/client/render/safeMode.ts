// Lite graphics after trouble (a lost WebGL context, a refused one): phones
// that ran out of GPU memory tend to lose the context again on the next
// load, and some browsers then refuse WebGL for the site altogether. After
// such trouble the next loads use the cheapest look (the 'software' tier:
// no environment map, simple shadows, lower car LODs), one device pixel per
// CSS pixel and no MSAA, for SAFE_MODE_DAYS. ?lite=1 forces it, ?lite=0
// clears it.
//
// The menu's graphics setting (docs/ui.md 7) comes in between: Auto, Lite
// or High, kept under GRAPHICS_KEY. The order is: the link (?lite=) over
// the setting over the trouble timer over the automatic tier. High forces
// the desktop tier (HDRI, MSAA) on phones too; graphics trouble puts a
// High setting back to Auto, so the device falls back to lite graphics.

export const SAFE_MODE_KEY = 'bulli-safe-mode-until';
export const GRAPHICS_KEY = 'bulli-graphics';
export const GRAPHICS_SETTINGS = ['auto', 'lite', 'high'] as const;
export type GraphicsSetting = typeof GRAPHICS_SETTINGS[number];
export const SAFE_MODE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SafeModeEnv {
    search: string;
    storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
    now: number;
}

function browserEnv(): SafeModeEnv {
    if (typeof window === 'undefined') return { search: '', storage: null, now: Date.now() };
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

/** The graphics setting of the menu (Auto without a valid one). */
export function graphicsSetting(env: SafeModeEnv = browserEnv()): GraphicsSetting {
    let value: string | null = null;
    try {
        value = env.storage?.getItem(GRAPHICS_KEY) ?? null;
    } catch { /* ignore */ }
    return (GRAPHICS_SETTINGS as readonly string[]).includes(value ?? '') ? value as GraphicsSetting : 'auto';
}

/** Saves the graphics setting; it applies from the next load (renderer, tier). */
export function setGraphicsSetting(setting: GraphicsSetting, env: SafeModeEnv = browserEnv()): void {
    try {
        if (setting === 'auto') env.storage?.removeItem(GRAPHICS_KEY);
        else env.storage?.setItem(GRAPHICS_KEY, setting);
    } catch { /* ignore */ }
}

/**
 * Why this load uses lite graphics: the link says so (?lite=1), the menu's
 * graphics setting, or the graphics had trouble on this device within
 * SAFE_MODE_DAYS; null when it does not (the loading screen names the
 * reason).
 */
export function safeModeReason(env: SafeModeEnv = browserEnv()): 'link' | 'setting' | 'trouble' | null {
    const forced = new URLSearchParams(env.search).get('lite');
    if (forced === '1') return 'link';
    if (forced === '0') {
        clearSafeMode(env);
        return null;
    }
    const setting = graphicsSetting(env);
    if (setting === 'lite') return 'setting';
    if (setting === 'high') return null;
    let until = NaN;
    try {
        until = Number(env.storage?.getItem(SAFE_MODE_KEY));
    } catch { /* ignore */ }
    return Number.isFinite(until) && until > env.now ? 'trouble' : null;
}

/** Whether this load forces the high (desktop) tier: the menu says High and the link does not say lite. */
export function highGraphics(env: SafeModeEnv = browserEnv()): boolean {
    return new URLSearchParams(env.search).get('lite') === null && graphicsSetting(env) === 'high';
}

/**
 * Remembers graphics trouble, so the next loads start in lite graphics; a
 * High setting goes back to Auto (it would keep the device out of lite).
 */
export function markGraphicsTrouble(env: SafeModeEnv = browserEnv()): void {
    try {
        env.storage?.setItem(SAFE_MODE_KEY, String(env.now + SAFE_MODE_DAYS * DAY_MS));
    } catch { /* ignore */ }
    if (graphicsSetting(env) === 'high') setGraphicsSetting('auto', env);
}

export function clearSafeMode(env: SafeModeEnv = browserEnv()): void {
    try {
        env.storage?.removeItem(SAFE_MODE_KEY);
    } catch { /* ignore */ }
}
