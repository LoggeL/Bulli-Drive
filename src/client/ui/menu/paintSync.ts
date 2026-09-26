import { paintByHex, type PaintId } from '../../../shared/paints.js';
import { savedPaint } from './menuState.js';

// Between the connection and the menu's paint chips (docs/ui.md 5): the
// hello carries the paint saved by the menu, and the paint the server
// gives in 'welcome' (the saved one, or a random palette paint on a first
// visit) is shown on the chips. Its own module, so network/websocket.ts
// does not load the menu.

let listener: ((paint: PaintId) => void) | null = null;

function storage(): Storage | null {
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}

/** The paint this browser picked in the menu, null before the first pick. */
export function preferredPaint(): PaintId | null {
    return savedPaint(storage());
}

/** The server's paint for this player ('welcome'). */
export function onOwnPaint(color: number): void {
    const paint = paintByHex(color);
    if (paint) listener?.(paint.id);
}

/** The menu listens for the server's paint. */
export function listenOwnPaint(fn: ((paint: PaintId) => void) | null): void {
    listener = fn;
}
