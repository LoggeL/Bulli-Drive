// Reload guards of the connection (websocket.ts): a newer protocol, a new
// deploy with the same protocol, or a world that differs from the server's
// reload the page, but only once per value, so a server or a cache that
// keeps serving the old page cannot cause a reload loop.

/** Reloads once per key value (sessionStorage guard); false when the guard holds. */
export function reloadOnce(key: string, value: string): boolean {
    try {
        if (sessionStorage.getItem(key) === value) return false;
        sessionStorage.setItem(key, value);
    } catch {
        return false;
    }
    window.location.reload();
    return true;
}
