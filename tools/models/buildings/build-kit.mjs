// Builds the building kit: atlas -> Blender (one GLB per group) -> KTX2 atlas + meshopt GLBs in
// public/models/kit, checks budgets.json and writes public/models/kit/manifest.json.
//
//   node tools/models/buildings/build-kit.mjs                      # everything
//   node tools/models/buildings/build-kit.mjs --only=downtown,pier  # some groups (manifest keeps the rest)
//   node tools/models/buildings/build-kit.mjs --skip-blender        # re-pack tools/models/.out/kit
//   node tools/models/buildings/build-kit.mjs --skip-atlas          # keep the atlas PNGs / KTX2
//   node tools/models/buildings/build-kit.mjs --render=/path --tag=v3   # also Eevee review stills
//
// Needs: python3 with numpy + Pillow (make_atlas.py), Blender 5.2 ($BLENDER, see ../build-all.mjs),
// npm --prefix tools ci, the Poly Haven sources (npm --prefix tools run textures:fetch) and the
// G1 generated sources (node tools/textures/generated/sources.mjs unpack <archive>).
//
// The GLBs do not embed the atlas: their material "kit_atlas" references the KTX2 files next to
// them (glTF image uri + KHR_texture_basisu), so all groups share one download and one GPU copy.
// Atlas textures follow the glTF convention (no flipY), like the textures inside the car GLBs.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRTextureBasisu } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { encodeKTX2, inspectKTX2 } from '../../lib/ktx2.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODELS = path.dirname(HERE);
const TOOLS = path.dirname(MODELS);
const REPO = path.dirname(TOOLS);
const RAW = path.join(MODELS, '.out', 'kit');
const OUT = path.join(REPO, 'public', 'models', 'kit');
const GLTFPACK = path.join(TOOLS, 'node_modules', '.bin', 'gltfpack');
const KIT = JSON.parse(fs.readFileSync(path.join(HERE, 'kit.json'), 'utf8'));
const ATLAS = JSON.parse(fs.readFileSync(path.join(HERE, 'atlas.json'), 'utf8'));
const BUDGETS = JSON.parse(fs.readFileSync(path.join(HERE, 'budgets.json'), 'utf8'));

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value ?? true];
}));

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const sha = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 12);

function findBlender() {
    const candidates = [process.env.BLENDER, '/opt/homebrew/bin/blender',
        '/Applications/Blender.app/Contents/MacOS/Blender', '/usr/bin/blender', '/usr/local/bin/blender'];
    for (const candidate of candidates) if (candidate && fs.existsSync(candidate)) return candidate;
    return 'blender';
}

// Atlas maps: kind for the encoder, published size, glTF slot
const ATLAS_MAPS = {
    albedo: { kind: 'color', slot: 'baseColor' },
    normal: { kind: 'normal', slot: 'normal' },
    arm: { kind: 'data', slot: 'metallicRoughness+occlusion' },
    emissive: { kind: 'color', slot: 'emissive' }
};

const groups = args.only ? String(args.only).split(',') : Object.keys(KIT.groups);
for (const g of groups) if (!KIT.groups[g]) throw new Error(`Unknown kit group ${g}`);
fs.mkdirSync(OUT, { recursive: true });
const manifestPath = path.join(OUT, 'manifest.json');
const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : { version: 1, atlas: {}, groups: {} };

// 1. atlas PNGs (python3) and their KTX2 encodes
if (!args['skip-atlas']) {
    console.log('[kit] atlas: python3 make_atlas.py');
    execFileSync('python3', [path.join(HERE, 'make_atlas.py')], { stdio: 'inherit' });
    for (const [map, spec] of Object.entries(ATLAS_MAPS)) {
        const src = path.join(RAW, 'atlas', `kit_atlas_${map}.png`);
        const { ktx2, width, height, mode } = await encodeKTX2(fs.readFileSync(src),
            { kind: spec.kind, maxSize: ATLAS.ship[map], flipY: false, quality: 192 });
        const file = `kit_atlas_${map}.ktx2`;
        fs.writeFileSync(path.join(OUT, file), ktx2);
        manifest.atlas[map] = { file, kind: spec.kind, width, height, encoding: mode, bytes: ktx2.byteLength, hash: sha(ktx2) };
        console.log(`  ${file}: ${spec.kind} ${mode} ${width}x${height} ${(ktx2.byteLength / 1024).toFixed(0)} KB`);
    }
}
for (const [map, spec] of Object.entries(ATLAS_MAPS)) {
    const file = `kit_atlas_${map}.ktx2`;
    const target = path.join(OUT, file);
    if (!fs.existsSync(target)) throw new Error(`atlas ${map} missing - run without --skip-atlas`);
    if (!manifest.atlas[map]) {
        // --skip-atlas after a failed run: describe the KTX2 already on disk
        const bytes = fs.readFileSync(target);
        const info = inspectKTX2(bytes);
        manifest.atlas[map] = { file, kind: spec.kind, width: info.width, height: info.height,
            encoding: info.supercompression === 1 ? 'etc1s' : 'uastc', bytes: bytes.length, hash: sha(bytes) };
    }
}

// 2. Blender build per group
for (const g of groups) {
    if (args['skip-blender']) continue;
    const blender = findBlender();
    const blenderArgs = ['-b', '--factory-startup', '--python', path.join(HERE, 'kit.py'), '--', `--group=${g}`, `--out=${RAW}`];
    if (args.render) blenderArgs.push(`--render=${args.render}`, `--tag=${args.tag ?? 'v1'}`);
    const t0 = Date.now();
    const run = spawnSync(blender, blenderArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const log = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    fs.writeFileSync(path.join(RAW, `${g}.blender.log`), log);
    if (run.error) throw run.error;
    if (run.status !== 0 || /Traceback \(most recent call last\)/.test(log)) {
        throw new Error(`Blender build of ${g} failed, see ${path.join(RAW, `${g}.blender.log`)}\n${log.slice(-2000)}`);
    }
    console.log(`[kit] ${g}: blender ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

/** Attaches the external KTX2 atlas maps to the kit_atlas material of a document. */
function attachAtlas(doc) {
    const root = doc.getRoot();
    const textures = {};
    for (const [map, entry] of Object.entries(manifest.atlas)) {
        textures[map] = doc.createTexture(`kit_atlas_${map}`)
            .setImage(fs.readFileSync(path.join(OUT, entry.file)))
            .setMimeType('image/ktx2')
            .setURI(entry.file);
    }
    doc.createExtension(KHRTextureBasisu).setRequired(true);
    const materials = root.listMaterials();
    if (materials.length !== 1 || materials[0].getName() !== 'kit_atlas') {
        throw new Error(`expected the single material kit_atlas, got ${materials.map(m => m.getName()).join(', ')}`);
    }
    const m = materials[0];
    m.setBaseColorFactor([1, 1, 1, 1]).setBaseColorTexture(textures.albedo)
        .setMetallicFactor(1).setRoughnessFactor(1).setMetallicRoughnessTexture(textures.arm)
        .setOcclusionTexture(textures.arm)
        .setNormalTexture(textures.normal)
        .setEmissiveFactor([1, 1, 1]).setEmissiveTexture(textures.emissive)
        .setDoubleSided(false);
}

/** Facts about one packed group GLB, per piece and LOD (after meshopt decoding). */
async function summarize(file) {
    const doc = await io.read(file);
    const pieces = {};
    for (const node of doc.getRoot().listNodes()) {
        const extras = node.getExtras();
        if (!extras || typeof extras.kit_piece !== 'string') continue;
        const lods = [];
        for (const child of node.listChildren()) {
            const m = /_lod(\d)$/.exec(child.getName());
            if (!m) continue;
            let triangles = 0;
            let primitives = 0;
            child.traverse(n => {
                const mesh = n.getMesh();
                if (!mesh) return;
                for (const prim of mesh.listPrimitives()) {
                    primitives++;
                    const idx = prim.getIndices();
                    triangles += (idx ? idx.getCount() : prim.getAttribute('POSITION').getCount()) / 3;
                }
            });
            lods.push({ lod: Number(m[1]), triangles, primitives });
        }
        lods.sort((a, b) => a.lod - b.lod);
        pieces[extras.kit_piece] = { category: extras.category, footprint: extras.footprint, height: extras.height, lods };
    }
    return {
        bytes: fs.statSync(file).size,
        pieces,
        extensions: doc.getRoot().listExtensionsUsed().map(e => e.extensionName).sort()
    };
}

/** Budget violations of one group (empty = ok). */
function checkGroup(group, s) {
    const errors = [];
    if (s.bytes > BUDGETS.maxBytesPerGroup) errors.push(`${s.bytes} bytes > ${BUDGETS.maxBytesPerGroup}`);
    for (const e of BUDGETS.requiredExtensions) if (!s.extensions.includes(e)) errors.push(`missing extension ${e}`);
    for (const e of s.extensions) if (!BUDGETS.allowedExtensions.includes(e)) errors.push(`extension ${e} not allowed`);
    for (const [id, p] of Object.entries(s.pieces)) {
        const cat = BUDGETS.categories[p.category];
        if (!cat) { errors.push(`${id}: unknown category ${p.category}`); continue; }
        for (const l of p.lods) {
            const b = cat.lods[String(l.lod)];
            if (l.triangles > b.maxTriangles) errors.push(`${id} lod${l.lod}: ${l.triangles} triangles > ${b.maxTriangles}`);
            if (l.primitives > BUDGETS.maxPrimitivesPerLod) errors.push(`${id} lod${l.lod}: ${l.primitives} primitives`);
        }
        // the coarsest LOD at most a fraction of LOD0, unless LOD0 already fits the coarsest LOD's budget
        const first = p.lods[0], last = p.lods[p.lods.length - 1];
        if (first.triangles > cat.lods[String(last.lod)].maxTriangles && last.triangles > first.triangles * BUDGETS.lod2MaxFractionOfLod0) {
            errors.push(`${id} lod${last.lod}: ${last.triangles} triangles > ${BUDGETS.lod2MaxFractionOfLod0} x lod${first.lod}`);
        }
    }
    return errors;
}

// 3. pack every group: attach the atlas, gltfpack with meshopt, keep the texture references
for (const g of groups) {
    const src = path.join(RAW, `${g}.glb`);
    if (!fs.existsSync(src)) throw new Error(`${src} missing - run the Blender build first`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `bd-kit-${g}-`));
    try {
        const doc = await io.read(src);
        attachAtlas(doc);
        const mid = path.join(tmp, `${g}.gltf`);
        await io.write(mid, doc);
        const out = path.join(OUT, `kit_${g}.glb`);
        // -tr: keep the atlas as external references; -vtf: float UVs (the chunk builder merges pieces
        // without per-mesh texture transforms); -kn/-km/-ke: keep piece nodes, the material and extras
        execFileSync(GLTFPACK, ['-i', mid, '-o', out, '-cc', '-tr', '-vtf', '-kn', '-km', '-ke'], { stdio: 'pipe' });
        const s = await summarize(out);
        const errors = checkGroup(g, s);
        const listed = KIT.groups[g].pieces.map(p => p.id).sort();
        if (JSON.stringify(Object.keys(s.pieces).sort()) !== JSON.stringify(listed)) {
            errors.push(`pieces ${Object.keys(s.pieces).sort().join(',')} != kit.json ${listed.join(',')}`);
        }
        const bytes = fs.readFileSync(out);
        console.log(`[kit] ${g}: ${bytes.length} B, ${Object.keys(s.pieces).length} pieces` +
            Object.entries(s.pieces).map(([id, p]) => `\n    ${id}: ${p.lods.map(l => `lod${l.lod} ${l.triangles}`).join(' / ')}`).join(''));
        if (errors.length) throw new Error(`kit ${g} violates budgets.json:\n  ${errors.join('\n  ')}`);
        manifest.groups[g] = { file: `kit_${g}.glb`, bytes: bytes.length, hash: sha(bytes), pieces: s.pieces };
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

// 4. totals and the manifest
manifest.groups = Object.fromEntries(Object.entries(manifest.groups).sort(([a], [b]) => a.localeCompare(b)));
const glbBytes = Object.values(manifest.groups).reduce((sum, g) => sum + g.bytes, 0);
const atlasBytes = Object.values(manifest.atlas).reduce((sum, a) => sum + a.bytes, 0);
if (glbBytes > BUDGETS.maxBytesAllGroups) throw new Error(`kit GLBs ${glbBytes} B > ${BUDGETS.maxBytesAllGroups}`);
if (atlasBytes > BUDGETS.atlas.maxBytes) throw new Error(`kit atlas ${atlasBytes} B > ${BUDGETS.atlas.maxBytes}`);
manifest._doc = 'Written by tools/models/buildings/build-kit.mjs. One GLB per kit group; every piece is a node with extras ' +
    '(footprint in three.js axes, height, LOD distances, params) and one mesh child per LOD. The material kit_atlas ' +
    'references the KTX2 atlas files next to the GLBs (glTF convention, no flipY). Not loaded by the game yet (phase 3, M4).';
manifest.totals = { glbBytes, atlasBytes };
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + '\n');
console.log(`[kit] wrote ${path.relative(process.cwd(), manifestPath)}: GLBs ${(glbBytes / 1024).toFixed(0)} KB, atlas ${(atlasBytes / 1024).toFixed(0)} KB`);
