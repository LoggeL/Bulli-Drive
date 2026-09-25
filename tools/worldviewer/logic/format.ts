// The text layout of the hand-edited map sources (src/shared/maps/*/*.json):
// the top-level object one key per line, an array or record below it one
// entry per line in compact JSON, a trailing newline. Exporting an unchanged
// roads.json therefore gives the committed file byte for byte, and an edit
// changes only the lines of the objects it touched (small git diffs).

function compact(value: unknown): string {
    return JSON.stringify(value);
}

function block(value: unknown): string {
    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        return `[\n${value.map(item => `    ${compact(item)}`).join(',\n')}\n  ]`;
    }
    if (value !== null && typeof value === 'object') {
        const entries = Object.entries(value);
        if (entries.length === 0) return '{}';
        return `{\n${entries.map(([key, item]) => `    ${JSON.stringify(key)}: ${compact(item)}`).join(',\n')}\n  }`;
    }
    return compact(value);
}

// Formats a map source file. Keys keep their order (the editor inserts new
// keys where the schema has them, see editOps.ts).
export function formatMapJson(file: object): string {
    const lines = Object.entries(file).map(([key, value]) => `  ${JSON.stringify(key)}: ${block(value)}`);
    return `{\n${lines.join(',\n')}\n}\n`;
}
