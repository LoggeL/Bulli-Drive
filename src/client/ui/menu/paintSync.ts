import { paintByHex, type PaintId } from '../../../shared/paints.js';

// Between the connection and the menu's paint chips (docs/ui.md 5): the
// hello carries the menu's paint (network/hello.ts), and the paint the
// server confirms in 'welcome' is shown on the chips (the same one, or on
// a resumed session the paint it kept). Its own module, so
// network/websocket.ts does not load the menu.

let listener: ((paint: PaintId) => void) | null = null;

/** The server's paint for this player ('welcome'). */
export function onOwnPaint(color: number): void {
    const paint = paintByHex(color);
    if (paint) listener?.(paint.id);
}

/** The menu listens for the server's paint. */
export function listenOwnPaint(fn: ((paint: PaintId) => void) | null): void {
    listener = fn;
}
