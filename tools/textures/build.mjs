// Encodes the textures of textures.json into KTX2 (Basis Universal) under public/textures and
// writes public/textures/manifest.json. Sources:
//   - Poly Haven PBR sets and HDRIs: tools/textures/.cache (run fetch.mjs first)
//   - generated (AI) textures: tools/textures/.cache/generated/<source>. These have no public
//     download; their KTX2 files in public/textures/generated are the canonical copies. The
//     build keeps an existing KTX2 when its source is not in the cache. To re-encode, put the
//     prepared sources there, e.g. from the prototype:
//       node tools/textures/build.mjs --import-generated=/path/to/world/tex
//
//   npm --prefix tools run textures           # fetch + build
//   node tools/textures/build.mjs --force     # re-encode even if source and settings are unchanged
//
// Orientation: every standalone KTX2 here is encoded with flipY, so it samples exactly like the
// same JPG/PNG loaded by THREE.TextureLoader (flipY = true). Compressed textures cannot be
// flipped on upload, so this keeps UVs and tangent frames identical between both paths.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeKTX2 } from '../lib/ktx2.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(path.dirname(HERE));
const CACHE = path.join(HERE, '.cache');
const OUT = path.join(REPO, 'public', 'textures');
const SPEC = JSON.parse(fs.readFileSync(path.join(HERE, 'textures.json'), 'utf8'));
const ENCODER_VERSION = 1;      // bump when encodeKTX2 settings change -> everything re-encodes

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value ?? true];
}));

const manifestPath = path.join(OUT, 'manifest.json');
const previous = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { textures: {} };
const sourcesPath = path.join(CACHE, 'sources.json');
const sources = fs.existsSync(sourcesPath) ? JSON.parse(fs.readFileSync(sourcesPath, 'utf8')) : null;
if (!sources && SPEC.polyhaven.length) console.warn('[textures] no .cache/sources.json - run fetch.mjs first; keeping existing Poly Haven textures');

if (args['import-generated']) {
    const from = String(args['import-generated']);
    fs.mkdirSync(path.join(CACHE, 'generated'), { recursive: true });
    for (const g of SPEC.generated) {
        for (const file of [g.source, g.sidecar].filter(Boolean)) {
            const candidates = [path.join(from, file), path.join(from, '..', '..', 'assets', 'decals', file)];
            const found = candidates.find(c => fs.existsSync(c));
            if (!found) throw new Error(`--import-generated: ${file} not found in ${from}`);
            fs.copyFileSync(found, path.join(CACHE, 'generated', file));
        }
    }
    console.log(`[textures] imported ${SPEC.generated.length} generated sources from ${from}`);
}

const manifest = {
    version: 1,
    _doc: 'Written by tools/textures/build.mjs. KTX2 files are encoded with flipY (sample like TextureLoader JPG/PNG). kind: color = sRGB, data/normal = linear.',
    flipY: true,
    textures: {},
    materials: {},
    hdri: {},
    generated: {}
};
const stats = { encoded: 0, unchanged: 0, kept: 0, bytes: 0 };
const sha = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

/** Encodes one source into public/textures/<key>.ktx2 unless it is up to date. */
async function texture(key, sourceFile, kind, maxSize) {
    const file = `${key}.ktx2`;
    const target = path.join(OUT, file);
    const old = previous.textures?.[key];
    if (!sourceFile || !fs.existsSync(sourceFile)) {
        if (old && fs.existsSync(target)) {
            manifest.textures[key] = old;
            stats.kept++;
            stats.bytes += old.bytes;
            return old;
        }
        throw new Error(`${key}: source ${sourceFile ?? '(none)'} missing and no existing ${file}`);
    }
    const source = fs.readFileSync(sourceFile);
    const settings = `${ENCODER_VERSION}:${kind}:${maxSize}`;
    const sourceHash = sha(source);
    if (!args.force && old && old.sourceHash === sourceHash && old.settings === settings && fs.existsSync(target)) {
        manifest.textures[key] = old;
        stats.unchanged++;
        stats.bytes += old.bytes;
        return old;
    }
    const { ktx2, width, height, mode } = await encodeKTX2(source, { kind, maxSize, flipY: true, quality: 192 });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, ktx2);
    const entry = { file, kind, width, height, encoding: mode, bytes: ktx2.byteLength, hash: sha(ktx2), sourceHash, settings };
    manifest.textures[key] = entry;
    stats.encoded++;
    stats.bytes += entry.bytes;
    console.log(`[textures] ${key.padEnd(30)} ${kind.padEnd(6)} ${mode.padEnd(5)} ${width}x${height} ` +
        `${(source.length / 1024).toFixed(0)} KB -> ${(ktx2.byteLength / 1024).toFixed(0)} KB`);
    return entry;
}

// Poly Haven PBR sets
const jobs = [];
for (const entry of SPEC.polyhaven) {
    const publish = entry.publish ?? Object.keys(entry.maps);
    const src = sources?.polyhaven?.[entry.role] ?? previous.materials?.[entry.role];
    const material = {
        tileMeters: src?.tileMeters ?? null,
        source: src?.source ?? `https://polyhaven.com/a/${entry.id}`,
        authors: src?.authors ?? [],
        license: 'CC0-1.0'
    };
    // publish: [] = fetched for the offline tools only (Blender look-dev)
    if (!publish.length) continue;
    for (const map of publish) {
        const kind = map === 'albedo' ? 'color' : map === 'normal' ? 'normal' : 'data';
        const key = `pbr/${entry.role}_${map}`;
        const sourceFile = path.join(CACHE, 'polyhaven', entry.role, `${entry.role}_${map}_1k.jpg`);
        material[map] = key;
        jobs.push(() => texture(key, sourceFile, kind, entry.maps[map]));
    }
    manifest.materials[entry.role] = material;
}
// Generated (AI) textures
for (const g of SPEC.generated) {
    const key = `generated/${g.name}`;
    manifest.generated[g.name] = { texture: key, note: g.note ?? null };
    jobs.push(async () => {
        await texture(key, path.join(CACHE, 'generated', g.source), g.kind, g.maxSize);
        if (g.sidecar) {
            const from = path.join(CACHE, 'generated', g.sidecar);
            const to = path.join(OUT, 'generated', g.sidecar);
            if (fs.existsSync(from)) fs.copyFileSync(from, to);
            if (!fs.existsSync(to)) throw new Error(`${g.sidecar} missing`);
            manifest.generated[g.name].sidecar = `generated/${g.sidecar}`;
        }
    });
}

// A few encodes in parallel (the WASM encoder is single threaded)
let next = 0;
async function worker() {
    while (next < jobs.length) await jobs[next++]();
}
await Promise.all([worker(), worker(), worker(), worker()]);

// HDRIs are shipped as Radiance .hdr (three.js RGBELoader); r160's KTX2Loader has no UASTC HDR
for (const entry of SPEC.hdri) {
    const file = `hdri/${entry.id}_${entry.publish}.hdr`;
    const from = path.join(CACHE, 'hdri', `${entry.id}_${entry.publish}.hdr`);
    const to = path.join(OUT, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (fs.existsSync(from)) fs.copyFileSync(from, to);
    if (!fs.existsSync(to)) throw new Error(`${file} missing - run fetch.mjs`);
    const src = sources?.hdri?.[entry.id] ?? previous.hdri?.[entry.id];
    const bytes = fs.statSync(to).size;
    manifest.hdri[entry.id] = {
        file, bytes, hash: sha(fs.readFileSync(to)),
        source: src?.source ?? `https://polyhaven.com/a/${entry.id}`,
        authors: src?.authors ?? [],
        license: 'CC0-1.0'
    };
    stats.bytes += bytes;
}

// Stable order for small diffs
manifest.textures = Object.fromEntries(Object.entries(manifest.textures).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + '\n');
console.log(`[textures] ${stats.encoded} encoded, ${stats.unchanged} unchanged, ${stats.kept} kept without source; ` +
    `public/textures ${(stats.bytes / 1024 / 1024).toFixed(2)} MB`);
