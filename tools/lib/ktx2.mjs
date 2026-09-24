// KTX2 (Basis Universal) encoding shared by the model packer and the texture build.
//
// Uses ktx2-encoder (MIT, the official basis_universal encoder compiled to WASM), so no
// native toktx/basisu binary is needed on any platform. Images are decoded and resized
// with sharp.
//
// Texture kinds:
//   color  - sRGB albedo/emissive/decals: ETC1S (BasisLZ), transcodes to ETC2/BC1/BC7/ASTC
//   data   - linear packed maps (ARM, metal/rough): ETC1S without the perceptual metric
//   normal - tangent-space normals: UASTC + RDO + Zstandard (ETC1S blocks show in lighting)
// Small textures (<= 128 px) always use UASTC: they cost a few KB and keep palette cells exact.
import sharp from 'sharp';
import { encodeToKTX2 } from 'ktx2-encoder';
import { read as readKTX2 } from 'ktx-parse';

// The Basis WASM module prints per-slice progress through console.log (bound when the
// module is first created). Drop those lines so build logs stay readable.
const BASIS_NOISE = /^(Total slices|Slice: |Mode: |basis_compressor|Encoding slice|Using |Basis Universal|Processing|Wrote output|Compression succeeded|Total (basis|encoding))/;
const consoleLog = console.log.bind(console);
console.log = (...args) => {
    if (args.length === 1 && typeof args[0] === 'string' && BASIS_NOISE.test(args[0])) return;
    consoleLog(...args);
};

export const SMALL_UASTC_PX = 128;

/** Decodes any sharp-readable image (JPG/PNG/WebP/raw) into RGBA8 for the encoder. */
export async function decodeRGBA(buffer) {
    const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
}

/**
 * Encodes one image to KTX2 with mipmaps.
 * @param {Uint8Array} source encoded image (JPG/PNG/WebP)
 * @param {object} o
 * @param {'color'|'data'|'normal'} o.kind
 * @param {number} [o.maxSize] longest side limit (downscaled with lanczos3, aspect kept)
 * @param {boolean} [o.flipY] flip rows while encoding; use it for textures that three.js
 *   would otherwise upload with flipY=true (plain TextureLoader convention). glTF textures
 *   must NOT be flipped.
 * @param {number} [o.quality] ETC1S quality level 1..255
 * @param {boolean} [o.forceUASTC]
 * @returns {Promise<{ ktx2: Uint8Array, width: number, height: number, mode: string }>}
 */
export async function encodeKTX2(source, { kind, maxSize = 0, flipY = false, quality = 192, forceUASTC = false }) {
    let img = sharp(source);
    const meta = await img.metadata();
    let width = meta.width;
    let height = meta.height;
    if (maxSize && Math.max(width, height) > maxSize) {
        const k = maxSize / Math.max(width, height);
        width = Math.max(4, Math.round(width * k));
        height = Math.max(4, Math.round(height * k));
        img = img.resize(width, height, { kernel: 'lanczos3', fit: 'fill' });
    }
    const png = await img.png().toBuffer();
    const uastc = forceUASTC || kind === 'normal' || Math.max(width, height) <= SMALL_UASTC_PX;
    const srgb = kind === 'color';
    const options = {
        isUASTC: uastc,
        isKTX2File: true,
        generateMipmap: true,
        isYFlip: flipY,
        isPerceptual: srgb,
        isSetKTX2SRGBTransferFunc: srgb,
        isNormalMap: kind === 'normal',
        imageDecoder: decodeRGBA,
        enableDebug: false
    };
    if (uastc) {
        Object.assign(options, {
            needSupercompression: true,
            uastcLDRQualityLevel: 2,
            // Rate-distortion optimisation only where the texture is big enough to matter
            enableRDO: Math.max(width, height) > SMALL_UASTC_PX,
            rdoQualityLevel: kind === 'normal' ? 0.75 : 1.0
        });
    } else {
        Object.assign(options, { qualityLevel: quality, compressionLevel: 4 });
    }
    const ktx2 = await encodeToKTX2(new Uint8Array(png), options);
    const info = inspectKTX2(ktx2);
    if (info.width !== width || info.height !== height) {
        throw new Error(`KTX2 size ${info.width}x${info.height} != ${width}x${height}`);
    }
    return { ktx2, width, height, mode: uastc ? 'uastc' : 'etc1s' };
}

/** Header facts of a KTX2 file (for reports and tests). */
export function inspectKTX2(bytes) {
    const c = readKTX2(bytes);
    const dfd = c.dataFormatDescriptor[0];
    return {
        width: c.pixelWidth,
        height: c.pixelHeight,
        levels: c.levels.length,
        // 1 = BasisLZ (ETC1S), 2 = Zstandard (UASTC here), 0 = none
        supercompression: c.supercompressionScheme,
        // KHR_DF_TRANSFER_SRGB = 2, LINEAR = 1
        srgb: dfd.transferFunction === 2
    };
}
