#!/usr/bin/env node
// Verifies all new refactor PBR biome textures, lore billboards/decals, and UI map preview
// cards against contract #18 and the hard size/format/POT/KTX2 guardrails of #17/#20.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(path.dirname(HERE));
const BIOMES_DIR = path.join(REPO, 'public', 'textures', 'biomes');
const BILLBOARDS_DIR = path.join(REPO, 'public', 'textures', 'billboards');
const UI_DIR = path.join(REPO, 'public', 'ui');

const EXPECTED_BIOMES = [
    'alpine_snow', 'alpine_ice', 'alpine_rock',
    'quarry_gravel', 'quarry_red_rock', 'concrete_bowl',
    'forge_cobble', 'tulip_meadow'
];
const EXPECTED_SIGNS = [
    'sign_lmf_welcome', 'sign_ppk_bulli', 'sign_ppk_trio', 'sign_kolpingtheater',
    'sign_oilbert_ad', 'sign_win98_desktop', 'sign_codex_widget', 'sign_bands_marquee',
    'sign_reactor_safety', 'sign_arcanum_note', 'sign_voll_o_meter', 'sign_selantis_poster',
    'sign_jp_poolparty', 'sign_abseits_contact', 'sign_werkzeugwand'
];
const EXPECTED_DECALS = [
    'decal_saalplan_ag', 'decal_bomberman_grid', 'decal_sudoku_grid',
    'decal_geogames_map', 'decal_kniffel_pips'
];
const EXPECTED_UI = [
    'map-bulli-bay.webp', 'map-alpen-pass.webp', 'map-stunt-forge.webp', 'map-logge-forge.webp'
];

const KTX2_MAGIC = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPot = n => n > 0 && (n & (n - 1)) === 0;
const sha16 = buf => createHash('sha256').update(buf).digest('hex').slice(0, 16);

const errors = [];
const assert = (cond, msg) => { if (!cond) errors.push(msg); };

function checkKtx2(filePath, entry, label) {
    if (!fs.existsSync(filePath)) {
        errors.push(`missing file: ${label} (${filePath})`);
        return 0;
    }
    const data = fs.readFileSync(filePath);
    assert(data.subarray(0, 12).equals(KTX2_MAGIC), `${label}: invalid KTX2 magic`);
    const vkFormat = data.readUInt32LE(12);
    const width = data.readUInt32LE(20);
    const height = data.readUInt32LE(24);
    const levels = data.readUInt32LE(40);
    const supercomp = data.readUInt32LE(44);
    const expectedLevels = Math.floor(Math.log2(Math.max(width, height))) + 1;
    assert(vkFormat === 0, `${label}: vkFormat ${vkFormat} != 0 (Basis Universal)`);
    assert(isPot(width) && isPot(height), `${label}: non-POT ${width}x${height}`);
    assert(Math.max(width, height) <= 1024, `${label}: dimension ${width}x${height} > 1024`);
    assert(width === entry.width && height === entry.height, `${label}: header ${width}x${height} != manifest ${entry.width}x${entry.height}`);
    assert(levels === expectedLevels, `${label}: mip levels ${levels} != ${expectedLevels}`);
    assert(supercomp === (entry.encoding === 'etc1s' ? 1 : 2), `${label}: supercompression ${supercomp} mismatch (${entry.encoding})`);
    if (entry.kind === 'normal') assert(entry.encoding === 'uastc', `${label}: normal map must be uastc`);
    assert(data.length === entry.bytes, `${label}: bytes ${data.length} != manifest ${entry.bytes}`);
    assert(sha16(data) === entry.hash, `${label}: hash mismatch`);
    return data.length;
}

// 1. Verify biomes
const biomeManifest = JSON.parse(fs.readFileSync(path.join(BIOMES_DIR, 'manifest.json'), 'utf8'));
assert(biomeManifest.flipY === true, 'biomes/manifest.json must declare flipY: true');
assert(
    JSON.stringify(Object.keys(biomeManifest.materials).sort()) === JSON.stringify([...EXPECTED_BIOMES].sort()),
    'biomes/manifest.json material keys mismatch contract #18'
);
let biomeBytes = 0;
const expectedBiomeFiles = ['manifest.json'];
for (const id of EXPECTED_BIOMES) {
    const mat = biomeManifest.materials[id];
    assert(mat.tileMeters > 0, `biome ${id}: invalid tileMeters`);
    for (const map of ['albedo', 'normal', 'arm']) {
        const key = `${id}_${map}`;
        const entry = biomeManifest.textures[key];
        assert(Boolean(entry), `biome ${key}: missing manifest entry`);
        if (entry) {
            expectedBiomeFiles.push(entry.file);
            biomeBytes += checkKtx2(path.join(BIOMES_DIR, entry.file), entry, `biomes/${key}`);
        }
    }
}
const actualBiomeFiles = fs.readdirSync(BIOMES_DIR).sort();
assert(JSON.stringify(actualBiomeFiles) === JSON.stringify(expectedBiomeFiles.sort()), 'biomes/ has stray or missing files');

// 2. Verify billboards & decals
const billboardManifest = JSON.parse(fs.readFileSync(path.join(BILLBOARDS_DIR, 'manifest.json'), 'utf8'));
assert(billboardManifest.flipY === true, 'billboards/manifest.json must declare flipY: true');
const allExpectedBillboards = [...EXPECTED_SIGNS, ...EXPECTED_DECALS].sort();
assert(
    JSON.stringify(Object.keys(billboardManifest.textures).sort()) === JSON.stringify(allExpectedBillboards),
    'billboards/manifest.json keys mismatch contract #18'
);
let billboardBytes = 0;
const expectedBillboardFiles = ['manifest.json'];
for (const id of allExpectedBillboards) {
    const entry = billboardManifest.textures[id];
    if (!entry) continue;
    expectedBillboardFiles.push(entry.file);
    const bytes = checkKtx2(path.join(BILLBOARDS_DIR, entry.file), entry, `billboards/${id}`);
    billboardBytes += bytes;
    const isSign = id.startsWith('sign_');
    const validDims = isSign
        ? ((entry.width === 1024 && entry.height === 512) || (entry.width === 512 && entry.height === 256))
        : (entry.width === 512 && entry.height === 512);
    assert(
        validDims,
        `billboards/${id}: expected ${isSign ? '1024x512 or 512x256' : '512x512'}, got ${entry.width}x${entry.height}`
    );
    assert(bytes <= 60 * 1024, `billboards/${id}: ${bytes} bytes > 60 KB cap`);
}
const actualBillboardFiles = fs.readdirSync(BILLBOARDS_DIR).sort();
assert(JSON.stringify(actualBillboardFiles) === JSON.stringify(expectedBillboardFiles.sort()), 'billboards/ has stray or missing files');
assert(billboardBytes <= 1.3 * 1024 * 1024, `billboards total ${(billboardBytes / 1024 / 1024).toFixed(2)} MB > 1.3 MB cap`);

// 3. Verify UI map preview cards
let uiBytes = 0;
for (const file of EXPECTED_UI) {
    const p = path.join(UI_DIR, file);
    if (!fs.existsSync(p)) {
        errors.push(`missing UI card: ${file}`);
        continue;
    }
    const stat = fs.statSync(p);
    const meta = await sharp(p).metadata();
    assert(meta.format === 'webp', `ui/${file}: expected webp, got ${meta.format}`);
    assert(meta.width === 800 && meta.height === 450, `ui/${file}: expected 800x450, got ${meta.width}x${meta.height}`);
    assert(stat.size <= 60 * 1024, `ui/${file}: ${stat.size} bytes > 60 KB cap`);
    uiBytes += stat.size;
}

// 4. Verify total budgets
const newTotal = biomeBytes + billboardBytes + uiBytes;
assert(newTotal <= 8.5 * 1024 * 1024, `new assets total ${(newTotal / 1024 / 1024).toFixed(2)} MB > 8.5 MB cap`);

const walkSize = dir => {
    let sum = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        sum += e.isDirectory() ? walkSize(p) : fs.statSync(p).size;
    }
    return sum;
};
const modelsPlusTextures = walkSize(path.join(REPO, 'public', 'models')) + walkSize(path.join(REPO, 'public', 'textures'));
assert(modelsPlusTextures <= 30 * 1024 * 1024, `public/models + public/textures ${(modelsPlusTextures / 1024 / 1024).toFixed(2)} MB > 30 MB cap`);

console.log(JSON.stringify({
    ok: errors.length === 0,
    biomes: { sets: EXPECTED_BIOMES.length, files: EXPECTED_BIOMES.length * 3, mb: +(biomeBytes / 1024 / 1024).toFixed(2) },
    billboards: { count: allExpectedBillboards.length, kb: +(billboardBytes / 1024).toFixed(1), mb: +(billboardBytes / 1024 / 1024).toFixed(2) },
    uiCards: { count: EXPECTED_UI.length, kb: +(uiBytes / 1024).toFixed(1) },
    newTotalMb: +(newTotal / 1024 / 1024).toFixed(2),
    modelsPlusTexturesMb: +(modelsPlusTextures / 1024 / 1024).toFixed(2),
    errors
}, null, 2));

if (errors.length) process.exit(1);
