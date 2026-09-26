// FNV-1a with 128 bits (docs/phase-3-design.md, 6.1: sourceHash). Not a
// cryptographic hash; it only tells whether terrain.bhf was baked from the
// current sources.

const OFFSET_BASIS = 0x6c62272e07bb014262b821756295c58dn;
const PRIME = 0x0000000001000000000000000000013bn;
const MASK = (1n << 128n) - 1n;

export function fnv1a128(...parts: Uint8Array[]): Uint8Array {
    let hash = OFFSET_BASIS;
    for (const part of parts) {
        for (let i = 0; i < part.length; i++) {
            hash ^= BigInt(part[i]);
            hash = (hash * PRIME) & MASK;
        }
    }
    // Big-endian bytes, so the hex string reads like the number
    const out = new Uint8Array(16);
    for (let i = 15; i >= 0; i--) {
        out[i] = Number(hash & 0xffn);
        hash >>= 8n;
    }
    return out;
}

export function toHex(bytes: Uint8Array): string {
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
