export const CONFIG = {
    // The chase camera jumps instead of flying after a teleport this far
    cameraTeleportDistance: 20,
    shadowMapSize: 1024,
    // Dynamic WS URL: Use current hostname/port. The server accepts any path;
    // /ws lets the Vite dev server proxy it without clashing with its HMR socket.
    serverUrl: `${window.location.origin.replace(/^http/, 'ws')}/ws`
};
