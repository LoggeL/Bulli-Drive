import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

// The shipped KTX2 world textures (public/textures, written by
// tools/textures/build.mjs) read byte by byte: three.js' KTX2Loader takes a
// texture's colour space from the transfer function in its Data Format
// Descriptor, so an albedo stored as linear or a normal / ARM map stored as
// sRGB shades the world wrong without any error. Also: size and a full mip
// chain as the manifest says, and the Basis codec the manifest names.
//
// Header layout and constants from the KTX 2.0 specification (Khronos):
// identifier (12 bytes), then nine uint32 from vkFormat to
// supercompressionScheme, the index at byte 48 (dfdByteOffset,
// dfdByteLength). The DFD starts with dfdTotalSize (uint32), then the basic
// descriptor block: two header words, then colorModel, colorPrimaries,
// transferFunction and flags as single bytes.
// KHR_DF_TRANSFER_LINEAR = 1, KHR_DF_TRANSFER_SRGB = 2;
// KHR_DF_MODEL_ETC1S = 163, KHR_DF_MODEL_UASTC = 166.

const ROOT = path.resolve(__dirname, '../..');
const TEXTURES = path.join(ROOT, 'public/textures');
const KTX2_IDENTIFIER = [0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A];
const TRANSFER_LINEAR = 1;
const TRANSFER_SRGB = 2;
const MODEL_ETC1S = 163;
const MODEL_UASTC = 166;

interface ManifestEntry {
    file: string;
    kind: 'color' | 'data' | 'normal';
    width: number;
    height: number;
    encoding: 'etc1s' | 'uastc';
}

const manifest = JSON.parse(fs.readFileSync(path.join(TEXTURES, 'manifest.json'), 'utf8')) as {
    textures: Record<string, ManifestEntry>;
};

interface Ktx2Info {
    width: number;
    height: number;
    levels: number;
    colorModel: number;
    transfer: number;
}

function readKtx2(bytes: Uint8Array): Ktx2Info {
    expect([...bytes.subarray(0, 12)]).toEqual(KTX2_IDENTIFIER);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const dfd = view.getUint32(48, true);
    return {
        width: view.getUint32(20, true),
        height: view.getUint32(24, true),
        levels: view.getUint32(40, true),
        colorModel: view.getUint8(dfd + 12),
        transfer: view.getUint8(dfd + 14)
    };
}

function ktx2Files(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) return ktx2Files(file);
        return entry.name.endsWith('.ktx2') ? [path.relative(TEXTURES, file).split(path.sep).join('/')] : [];
    });
}

// What a texture's name promises, independent of the manifest: PBR albedos
// are colour, normal and ARM (occlusion, roughness, metalness) maps are data
function transferByName(file: string): number | null {
    if (/_normal\.ktx2$|_arm\.ktx2$/.test(file)) return TRANSFER_LINEAR;
    if (/_albedo(_\w+)?\.ktx2$/.test(file)) return TRANSFER_SRGB;
    return null;
}

describe('the shipped KTX2 textures', () => {
    const files = ktx2Files(TEXTURES).sort();
    const entries = Object.values(manifest.textures);

    it('are exactly the ones in the manifest', () => {
        expect(files.length).toBeGreaterThan(0);
        expect(entries.map(entry => entry.file).sort()).toEqual(files);
    });

    it('store albedos as sRGB and normal and ARM maps as linear', () => {
        const wrong: string[] = [];
        let named = 0;
        for (const file of files) {
            const expected = transferByName(file);
            if (expected === null) continue;
            named++;
            const { transfer } = readKtx2(fs.readFileSync(path.join(TEXTURES, file)));
            if (transfer !== expected) wrong.push(`${file}: transfer ${transfer}, expected ${expected}`);
        }
        expect(wrong).toEqual([]);
        // At least the map's six full PBR sets (asphalt, dry grass, gravel,
        // sand, sidewalk, stucco; three maps each) and the lawns' albedo
        expect(named).toBeGreaterThanOrEqual(19);
    });

    it('match the manifest: colour space by kind, size, a full mip chain and the codec', () => {
        const wrong: string[] = [];
        for (const entry of entries) {
            const info = readKtx2(fs.readFileSync(path.join(TEXTURES, entry.file)));
            const transfer = entry.kind === 'color' ? TRANSFER_SRGB : TRANSFER_LINEAR;
            // 512 x 512 has 10 levels (512, 256, ..., 1); 1024 x 512 has 11
            const levels = Math.floor(Math.log2(Math.max(entry.width, entry.height))) + 1;
            const model = entry.encoding === 'uastc' ? MODEL_UASTC : MODEL_ETC1S;
            if (info.transfer !== transfer) wrong.push(`${entry.file}: transfer ${info.transfer} for kind ${entry.kind}`);
            if (info.width !== entry.width || info.height !== entry.height) wrong.push(`${entry.file}: ${info.width}x${info.height}`);
            if (info.levels !== levels) wrong.push(`${entry.file}: ${info.levels} mip levels, expected ${levels}`);
            if (info.colorModel !== model) wrong.push(`${entry.file}: colour model ${info.colorModel} for ${entry.encoding}`);
        }
        expect(wrong).toEqual([]);
    });

    it('reads the asphalt normal map the old browser check loaded: 512 x 512, 10 levels, linear', () => {
        expect(readKtx2(fs.readFileSync(path.join(TEXTURES, 'pbr/asphalt_normal.ktx2')))).toEqual({
            width: 512, height: 512, levels: 10, colorModel: MODEL_UASTC, transfer: TRANSFER_LINEAR
        });
    });
});
