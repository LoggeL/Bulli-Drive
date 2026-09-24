// Minimal PNG writer (8-bit RGB, no filter) for the bake preview. Node only.

import { crc32, deflateSync } from 'node:zlib';

function chunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}

export function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
    if (rgb.length !== width * height * 3) throw new Error('rgb has the wrong size');
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    header[8] = 8;  // bit depth
    header[9] = 2;  // colour type RGB
    const raw = new Uint8Array(height * (width * 3 + 1));
    for (let y = 0; y < height; y++) {
        raw[y * (width * 3 + 1)] = 0;
        raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
    }
    const parts = [
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', new Uint8Array(0))
    ];
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
}
