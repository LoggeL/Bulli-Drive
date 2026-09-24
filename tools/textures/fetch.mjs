// Downloads the CC0 source textures and HDRIs listed in textures.json from Poly Haven
// (https://polyhaven.com, CC0 1.0) into tools/textures/.cache (git-ignored). Every file is
// checked against the md5 the Poly Haven API publishes; files already in the cache with the
// right md5 are skipped, so the script is cheap to re-run.
//
//   npm --prefix tools run textures:fetch
//
// Output: .cache/polyhaven/<role>/<role>_<map>_1k.jpg, .cache/hdri/<id>_<res>.hdr and
// .cache/sources.json (authors, real tile size, URLs; build.mjs copies it into the manifest).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, '.cache');
const SPEC = JSON.parse(fs.readFileSync(path.join(HERE, 'textures.json'), 'utf8'));
const API = 'https://api.polyhaven.com';
const HEADERS = { 'User-Agent': 'bulli-drive-asset-fetch/1.0 (+https://bulli.logge.top)' };
// Poly Haven map keys -> our map names. All sources are the 1k JPGs; the game uses <= 1024 px.
const MAP_KEYS = { albedo: 'Diffuse', normal: 'nor_gl', arm: 'arm', roughness: 'Rough', ao: 'AO' };
const SOURCE_RES = '1k';

async function get(url, as = 'json') {
    for (let attempt = 1; ; attempt++) {
        try {
            const response = await fetch(url, { headers: HEADERS });
            if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
            return as === 'json' ? await response.json() : new Uint8Array(await response.arrayBuffer());
        } catch (error) {
            if (attempt >= 3) throw new Error(`GET ${url} failed: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
    }
}

const md5 = bytes => createHash('md5').update(bytes).digest('hex');

async function download(file, target) {
    if (fs.existsSync(target) && md5(fs.readFileSync(target)) === file.md5) return 'cached';
    const bytes = await get(file.url, 'bytes');
    if (md5(bytes) !== file.md5) throw new Error(`md5 mismatch for ${file.url}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    return 'downloaded';
}

const sources = { polyhaven: {}, hdri: {} };
let downloaded = 0;
let cached = 0;
const count = result => (result === 'downloaded' ? downloaded++ : cached++);

for (const entry of SPEC.polyhaven) {
    const [info, files] = await Promise.all([get(`${API}/info/${entry.id}`), get(`${API}/files/${entry.id}`)]);
    const record = {
        id: entry.id,
        name: info.name,
        authors: Object.keys(info.authors ?? {}),
        tileMeters: Array.isArray(info.dimensions) ? +(info.dimensions[0] / 1000).toFixed(2) : null,
        source: `https://polyhaven.com/a/${entry.id}`,
        license: 'CC0-1.0',
        files: {}
    };
    for (const map of Object.keys(entry.maps)) {
        const key = MAP_KEYS[map];
        const file = files[key]?.[SOURCE_RES]?.jpg;
        if (!file) throw new Error(`${entry.id}: no ${key} ${SOURCE_RES} jpg on Poly Haven`);
        const target = path.join(CACHE, 'polyhaven', entry.role, `${entry.role}_${map}_${SOURCE_RES}.jpg`);
        count(await download(file, target));
        record.files[map] = { file: path.relative(CACHE, target), url: file.url, md5: file.md5 };
    }
    sources.polyhaven[entry.role] = record;
    console.log(`[fetch] ${entry.role.padEnd(14)} ${entry.id} (${record.authors.join(', ')}, ${record.tileMeters} m)`);
}

for (const entry of SPEC.hdri) {
    const [info, files] = await Promise.all([get(`${API}/info/${entry.id}`), get(`${API}/files/${entry.id}`)]);
    const record = {
        id: entry.id,
        name: info.name,
        authors: Object.keys(info.authors ?? {}),
        source: `https://polyhaven.com/a/${entry.id}`,
        license: 'CC0-1.0',
        files: {}
    };
    for (const res of entry.resolutions) {
        const file = files.hdri?.[res]?.hdr;
        if (!file) throw new Error(`${entry.id}: no ${res} .hdr on Poly Haven`);
        const target = path.join(CACHE, 'hdri', `${entry.id}_${res}.hdr`);
        count(await download(file, target));
        record.files[res] = { file: path.relative(CACHE, target), url: file.url, md5: file.md5 };
    }
    sources.hdri[entry.id] = record;
    console.log(`[fetch] hdri ${entry.id} ${entry.resolutions.join(', ')} (${record.authors.join(', ')})`);
}

fs.mkdirSync(CACHE, { recursive: true });
fs.writeFileSync(path.join(CACHE, 'sources.json'), JSON.stringify(sources, null, 1) + '\n');
console.log(`[fetch] ${downloaded} downloaded, ${cached} already cached -> ${path.relative(process.cwd(), CACHE)}`);
