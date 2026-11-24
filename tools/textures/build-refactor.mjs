#!/usr/bin/env node
// Encodes prepared refactor PBR biomes, lore billboards/decals, and map preview UI cards
// into public/textures/biomes/, public/textures/billboards/, and public/ui/.
//
// Orientation: every standalone KTX2 here is encoded with flipY: true (matching
// public/textures/manifest.json and THREE.TextureLoader UV conventions).
//
// Usage:
//   node tools/textures/build-refactor.mjs
//   node tools/textures/build-refactor.mjs --force
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { encodeKTX2 } from '../lib/ktx2.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(path.dirname(HERE));
const PREP = path.join(HERE, '.cache', 'refactor-prep');
const CATALOG = JSON.parse(fs.readFileSync(path.join(HERE, 'refactor-prompts.json'), 'utf8'));

const BIOMES_OUT = path.join(REPO, 'public', 'textures', 'biomes');
const BILLBOARDS_OUT = path.join(REPO, 'public', 'textures', 'billboards');
const UI_OUT = path.join(REPO, 'public', 'ui');

const force = process.argv.includes('--force');
const sha = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

async function encodeOneKtx2(sourcePath, outPath, { kind, maxSize, quality }) {
    const srcBuf = fs.readFileSync(sourcePath);
    const { ktx2, width, height, mode } = await encodeKTX2(srcBuf, {
        kind,
        maxSize,
        flipY: true,
        quality
    });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, ktx2);
    return {
        file: path.basename(outPath),
        kind,
        width,
        height,
        encoding: mode,
        bytes: ktx2.byteLength,
        hash: sha(ktx2),
        sourceHash: sha(srcBuf)
    };
}

// 1. Biome PBR sets -> public/textures/biomes/
fs.mkdirSync(BIOMES_OUT, { recursive: true });
const prevBiomesPath = path.join(BIOMES_OUT, 'manifest.json');
const prevBiomes = !force && fs.existsSync(prevBiomesPath)
    ? JSON.parse(fs.readFileSync(prevBiomesPath, 'utf8')).textures ?? {}
    : {};
const biomeManifest = {
    version: 1,
    _doc: 'Written by tools/textures/build-refactor.mjs. Standalone biome PBR KTX2 sets encoded with flipY: true. kind: color = sRGB ETC1S, data = linear ARM ETC1S, normal = OpenGL +Y UASTC+Zstd.',
    flipY: true,
    textures: {},
    materials: {}
};

const biomeJobs = [];
for (const b of CATALOG.biomes) {
    const matEntry = {
        tileMeters: b.tileMeters,
        source: 'codex-imagegen:gpt-image-2',
        license: 'Project-Owned-AI',
        albedo: `${b.id}_albedo`,
        normal: `${b.id}_normal`,
        arm: `${b.id}_arm`
    };
    biomeManifest.materials[b.id] = matEntry;
    for (const [map, kind, maxSize, quality] of [
        ['albedo', 'color', b.albedoSize, 192],
        ['normal', 'normal', b.mapSize, 192],
        ['arm', 'data', b.mapSize, 192]
    ]) {
        const key = `${b.id}_${map}`;
        const src = path.join(PREP, 'biomes', `${key}.png`);
        const dst = path.join(BIOMES_OUT, `${key}.ktx2`);
        biomeJobs.push(async () => {
            const srcHash = sha(fs.readFileSync(src));
            const old = prevBiomes[key];
            if (old && old.sourceHash === srcHash && fs.existsSync(dst) && fs.statSync(dst).size === old.bytes) {
                biomeManifest.textures[key] = old;
                console.log(`[biome]     ${key.padEnd(24)} ${kind.padEnd(6)} ${old.encoding.padEnd(5)} ${old.width}x${old.height} ${(old.bytes / 1024).toFixed(1)} KB (cached)`);
                return;
            }
            const entry = await encodeOneKtx2(src, dst, { kind, maxSize, quality });
            biomeManifest.textures[key] = entry;
            console.log(`[biome]     ${key.padEnd(24)} ${kind.padEnd(6)} ${entry.encoding.padEnd(5)} ${entry.width}x${entry.height} ${(entry.bytes / 1024).toFixed(1)} KB`);
        });
    }
}

// 2. Lore Billboards & Decals -> public/textures/billboards/
fs.mkdirSync(BILLBOARDS_OUT, { recursive: true });
const prevBillboardsPath = path.join(BILLBOARDS_OUT, 'manifest.json');
const prevBillboards = !force && fs.existsSync(prevBillboardsPath)
    ? JSON.parse(fs.readFileSync(prevBillboardsPath, 'utf8')).textures ?? {}
    : {};
const billboardManifest = {
    version: 1,
    _doc: 'Written by tools/textures/build-refactor.mjs. Lore billboards (1024x512) and ground decals (512x512) encoded to KTX2 ETC1S sRGB with flipY: true.',
    flipY: true,
    textures: {}
};

const billboardJobs = [];
const BILLBOARD_TARGET_BYTES = 59 * 1024;
for (const bb of CATALOG.billboards) {
    const src = path.join(PREP, 'billboards', `${bb.id}.png`);
    const dst = path.join(BILLBOARDS_OUT, `${bb.id}.ktx2`);
    billboardJobs.push(async () => {
        const srcHash = sha(fs.readFileSync(src));
        const old = prevBillboards[bb.id];
        if (old && old.sourceHash === srcHash && old.bytes <= BILLBOARD_TARGET_BYTES && fs.existsSync(dst) && fs.statSync(dst).size === old.bytes) {
            billboardManifest.textures[bb.id] = old;
            console.log(`[billboard] ${bb.id.padEnd(24)} ${bb.kind.padEnd(6)} ${old.encoding.padEnd(5)} ${old.width}x${old.height} ${(old.bytes / 1024).toFixed(1)} KB (cached)`);
            return;
        }
        // Try full target size at high ETC1S quality first; if dense poster artwork exceeds
        // the 60 KB cap even at q=72, fall back cleanly to 512x256 at crisp q=220 (exact 2:1 POT,
        // avoiding crushed q=16 macroblocks while staying well under budget).
        const maxSize = Math.max(bb.outWidth, bb.outHeight);
        let quality = 160;
        let entry = await encodeOneKtx2(src, dst, { kind: 'color', maxSize, quality });
        if (entry.bytes > BILLBOARD_TARGET_BYTES) {
            quality = 72;
            entry = await encodeOneKtx2(src, dst, { kind: 'color', maxSize, quality });
        }
        if (entry.bytes > BILLBOARD_TARGET_BYTES && maxSize > 512) {
            quality = 220;
            entry = await encodeOneKtx2(src, dst, { kind: 'color', maxSize: 512, quality });
        }
        billboardManifest.textures[bb.id] = {
            ...entry,
            category: bb.kind,
            source: 'codex-imagegen:gpt-image-2',
            license: 'Project-Owned-AI'
        };
        console.log(`[billboard] ${bb.id.padEnd(24)} ${bb.kind.padEnd(6)} ${entry.encoding.padEnd(5)} ${entry.width}x${entry.height} q=${quality} ${(entry.bytes / 1024).toFixed(1)} KB`);
    });
}

// Run KTX2 encodes with 4 concurrent workers
const allKtx2Jobs = [...biomeJobs, ...billboardJobs];
let nextJob = 0;
async function worker() {
    while (nextJob < allKtx2Jobs.length) await allKtx2Jobs[nextJob++]();
}
await Promise.all([worker(), worker(), worker(), worker()]);

// Stable key ordering
biomeManifest.textures = Object.fromEntries(Object.entries(biomeManifest.textures).sort(([a], [b]) => a.localeCompare(b)));
biomeManifest.materials = Object.fromEntries(Object.entries(biomeManifest.materials).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(path.join(BIOMES_OUT, 'manifest.json'), JSON.stringify(biomeManifest, null, 1) + '\n');

billboardManifest.textures = Object.fromEntries(Object.entries(billboardManifest.textures).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(path.join(BILLBOARDS_OUT, 'manifest.json'), JSON.stringify(billboardManifest, null, 1) + '\n');

// 3. Map Picker Preview Cards -> public/ui/map-<id>.webp (800x450, <= 60 KB each)
fs.mkdirSync(UI_OUT, { recursive: true });
let uiBytes = 0;
const UI_TARGET_BYTES = 59 * 1024;
for (const u of CATALOG.ui) {
    const src = path.join(PREP, 'ui', `${u.id}.png`);
    const dst = path.join(UI_OUT, `${u.id}.webp`);
    let q = 84;
    let buf = await sharp(src).resize(u.outWidth, u.outHeight, { fit: 'cover' })
        .webp({ quality: q, preset: 'photo', smartSubsample: true, effort: 6 }).toBuffer();
    while (buf.byteLength > UI_TARGET_BYTES && q > 32) {
        q -= 4;
        buf = await sharp(src).resize(u.outWidth, u.outHeight, { fit: 'cover' })
            .webp({ quality: q, preset: 'photo', smartSubsample: true, effort: 6 }).toBuffer();
    }
    fs.writeFileSync(dst, buf);
    uiBytes += buf.byteLength;
    console.log(`[ui]        ${(u.id + '.webp').padEnd(24)} ${u.outWidth}x${u.outHeight} q=${q} ${(buf.byteLength / 1024).toFixed(1)} KB`);
}

const biomeBytes = Object.values(biomeManifest.textures).reduce((s, e) => s + e.bytes, 0);
const billboardBytes = Object.values(billboardManifest.textures).reduce((s, e) => s + e.bytes, 0);
console.log(
    `\n[build-refactor] summary: biomes=${(biomeBytes / 1024 / 1024).toFixed(2)} MB (${biomeJobs.length} files), ` +
    `billboards=${(billboardBytes / 1024 / 1024).toFixed(2)} MB (${billboardJobs.length} files), ` +
    `ui=${(uiBytes / 1024).toFixed(1)} KB (${CATALOG.ui.length} files), ` +
    `total_new=${((biomeBytes + billboardBytes + uiBytes) / 1024 / 1024).toFixed(2)} MB`
);
if (force) console.log('[build-refactor] --force completed');
