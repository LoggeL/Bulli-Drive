// The loading screen (index.html #loading-screen) is opaque and covers the
// whole page until the first room has built the world (websocket.ts,
// removeLoader: it fades out, then goes). While it covers the page, a drawn
// frame is thrown away, so the render loop skips drawing (main.ts): on a
// phone that is battery, on a CPU rasterizer most of the page's first
// seconds.

/** Whether the loading screen still covers the page (not fading out, not gone). */
export function loadingScreenCovers(doc: Document = document): boolean {
    const loader = doc.getElementById('loading-screen');
    return !!loader && loader.style.opacity !== '0';
}
