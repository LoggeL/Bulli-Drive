// Undo history of the editor: immutable states (editOps.ts shares the
// untouched objects between states, so a step costs little memory). A drag
// is one step: the editor pushes when the drag ends, not on every move.

export interface History<T> {
    past: readonly T[];
    present: T;
    future: readonly T[];
    limit: number;
}

export function createHistory<T>(present: T, limit = 200): History<T> {
    return { past: [], present, future: [], limit };
}

// A new state after an edit: redo is gone, the oldest step drops out
// beyond the limit. Pushing the present state again changes nothing.
export function pushHistory<T>(history: History<T>, next: T): History<T> {
    if (next === history.present) return history;
    const past = [...history.past, history.present];
    return { ...history, past: past.slice(Math.max(0, past.length - history.limit)), present: next, future: [] };
}

export function undo<T>(history: History<T>): History<T> {
    if (history.past.length === 0) return history;
    return {
        ...history,
        past: history.past.slice(0, -1),
        present: history.past[history.past.length - 1],
        future: [history.present, ...history.future]
    };
}

export function redo<T>(history: History<T>): History<T> {
    if (history.future.length === 0) return history;
    return {
        ...history,
        past: [...history.past, history.present],
        present: history.future[0],
        future: history.future.slice(1)
    };
}
