import { createHash } from 'node:crypto';

// Key-order independent JSON, so golden hashes only change when values change.
export function stableStringify(value: unknown): string {
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return '{' + Object.keys(record).sort()
            .map(key => JSON.stringify(key) + ':' + stableStringify(record[key]))
            .join(',') + '}';
    }
    return JSON.stringify(value);
}

export function sha256(data: string | Uint8Array): string {
    return createHash('sha256').update(data).digest('hex');
}

// Hashes the exact IEEE-754 bits, so even a last-digit drift is caught.
export function sha256OfFloats(values: ArrayLike<number>): string {
    return sha256(new Uint8Array(Float64Array.from(values).buffer));
}
