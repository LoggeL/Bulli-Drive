// The pose track of a time trial ghost (docs/phase-2-design.md, 15.2 and
// 15.4): one sample every GHOST_POSE_EVERY ticks (20 Hz) from startTick on,
// 13 bytes each: x and z as i24 in 1/4096 m, y as i16 in cm, yaw as u16
// (a full turn in 65536 steps), the flip angle as u8 (a full turn in 256
// steps). About 23 kB for 90 s; the JSON message carries it as Base64.

export const GHOST_SAMPLE_BYTES = 13;
const XZ_SCALE = 4096;
const Y_SCALE = 100;
const TWO_PI = Math.PI * 2;

export interface GhostPose {
    x: number;
    y: number;
    z: number;
    yaw: number;
    flipAngle: number;
}

export function createGhostPose(): GhostPose {
    return { x: 0, y: 0, z: 0, yaw: 0, flipAngle: 0 };
}

function clamp(value: number, min: number, max: number): number {
    return value < min ? min : value > max ? max : value;
}

// A full turn in steps parts, wrapped into [0, steps)
function turnSteps(angle: number, steps: number): number {
    const turns = angle / TWO_PI;
    const wrapped = turns - Math.floor(turns);
    return Math.round(wrapped * steps) % steps;
}

function writeI24(bytes: Uint8Array, at: number, value: number): void {
    const v = clamp(Math.round(value), -0x800000, 0x7fffff) & 0xffffff;
    bytes[at] = v & 0xff;
    bytes[at + 1] = (v >> 8) & 0xff;
    bytes[at + 2] = (v >> 16) & 0xff;
}

function readI24(bytes: Uint8Array, at: number): number {
    const v = bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
    return v & 0x800000 ? v - 0x1000000 : v;
}

/** Writes one sample at byte offset at. */
export function writeGhostPose(bytes: Uint8Array, at: number, pose: GhostPose): void {
    writeI24(bytes, at, pose.x * XZ_SCALE);
    writeI24(bytes, at + 3, pose.z * XZ_SCALE);
    const y = clamp(Math.round(pose.y * Y_SCALE), -0x8000, 0x7fff) & 0xffff;
    bytes[at + 6] = y & 0xff;
    bytes[at + 7] = y >> 8;
    const yaw = turnSteps(pose.yaw, 65536);
    bytes[at + 8] = yaw & 0xff;
    bytes[at + 9] = yaw >> 8;
    bytes[at + 10] = turnSteps(pose.flipAngle, 256);
    // Two spare bytes (always 0): room for a flag set without a new format
    bytes[at + 11] = 0;
    bytes[at + 12] = 0;
}

/** Reads sample i of a track into out. */
export function readGhostPose(bytes: Uint8Array, i: number, out: GhostPose): GhostPose {
    const at = i * GHOST_SAMPLE_BYTES;
    out.x = readI24(bytes, at) / XZ_SCALE;
    out.z = readI24(bytes, at + 3) / XZ_SCALE;
    const y = bytes[at + 6] | (bytes[at + 7] << 8);
    out.y = (y & 0x8000 ? y - 0x10000 : y) / Y_SCALE;
    const yaw = (bytes[at + 8] | (bytes[at + 9] << 8)) / 65536 * TWO_PI;
    out.yaw = yaw > Math.PI ? yaw - TWO_PI : yaw;
    out.flipAngle = bytes[at + 10] / 256 * TWO_PI;
    return out;
}

export function ghostSampleCount(bytes: Uint8Array): number {
    return Math.floor(bytes.byteLength / GHOST_SAMPLE_BYTES);
}

/** Collects the samples of a run; grows as needed. */
export class GhostTrackWriter {
    private bytes = new Uint8Array(GHOST_SAMPLE_BYTES * 256);
    private count = 0;

    push(pose: GhostPose): void {
        if ((this.count + 1) * GHOST_SAMPLE_BYTES > this.bytes.byteLength) {
            const grown = new Uint8Array(this.bytes.byteLength * 2);
            grown.set(this.bytes);
            this.bytes = grown;
        }
        writeGhostPose(this.bytes, this.count * GHOST_SAMPLE_BYTES, pose);
        this.count++;
    }

    get samples(): number {
        return this.count;
    }

    /** The track so far (a copy of exactly the written bytes). */
    finish(): Uint8Array {
        return this.bytes.slice(0, this.count * GHOST_SAMPLE_BYTES);
    }
}

// ---- Base64 (both sides, without btoa or Buffer) ----

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;

export function toBase64(bytes: Uint8Array): string {
    let out = '';
    let i = 0;
    for (; i + 2 < bytes.length; i += 3) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
    }
    const rest = bytes.length - i;
    if (rest === 1) {
        const n = bytes[i] << 16;
        out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + '==';
    } else if (rest === 2) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
        out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + '=';
    }
    return out;
}

/** The bytes of a Base64 string, or null if it is not valid Base64. */
export function fromBase64(text: string): Uint8Array | null {
    if (text.length % 4 !== 0) return null;
    const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
    const out = new Uint8Array(text.length / 4 * 3 - pad);
    let o = 0;
    for (let i = 0; i < text.length; i += 4) {
        let n = 0;
        for (let k = 0; k < 4; k++) {
            const c = text.charCodeAt(i + k);
            const last = i + 4 === text.length;
            if (last && c === 61 && k >= 4 - pad) {
                n <<= 6;
                continue;
            }
            const v = c < 128 ? LOOKUP[c] : -1;
            if (v < 0) return null;
            n = (n << 6) | v;
        }
        if (o < out.length) out[o++] = (n >> 16) & 0xff;
        if (o < out.length) out[o++] = (n >> 8) & 0xff;
        if (o < out.length) out[o++] = n & 0xff;
    }
    return out;
}
