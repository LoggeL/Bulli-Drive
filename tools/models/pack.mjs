// Packs the raw Blender GLBs of one car (tools/models/.out/<id>/<id>_lod<n>.glb) for the game:
//   1. fixes what the Blender exporter loses (clearcoat roughness of the paints)
//   2. encodes every texture to KTX2 (KHR_texture_basisu) with tools/lib/ktx2.mjs
//      (base colour/emissive -> ETC1S sRGB, normal -> UASTC, packed maps -> ETC1S linear,
//      small palette textures -> UASTC)
//   3. gltfpack -cc -kn -km -ke: meshopt compression + quantisation while keeping named
//      nodes (wheel pivots, sockets), materials and extras. The default
//      `gltf-transform optimize` is NOT used: it merges/drops the wheel nodes.
//   4. checks the result against budgets.json and returns a manifest entry.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRTextureBasisu } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { encodeKTX2 } from '../lib/ktx2.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = path.dirname(HERE);
export const REPO = path.dirname(TOOLS);
export const RAW_DIR = path.join(HERE, '.out');
export const PUBLIC_DIR = path.join(REPO, 'public', 'models');
export const BUDGETS = JSON.parse(fs.readFileSync(path.join(HERE, 'budgets.json'), 'utf8'));
const GLTFPACK = path.join(TOOLS, 'node_modules', '.bin', 'gltfpack');

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

/** Which kind of KTX2 encoding a texture needs, from the material slots that use it. */
function textureKind(doc, texture) {
    const slots = new Set(doc.getGraph().listParentEdges(texture).map(edge => edge.getName()));
    if (slots.has('normalTexture')) return 'normal';
    if (slots.has('baseColorTexture') || slots.has('emissiveTexture')) return 'color';
    return 'data';
}

/** Facts about a packed GLB (after meshopt decoding). */
export async function summarize(file) {
    const doc = await io.read(file);
    const root = doc.getRoot();
    let triangles = 0;
    let primitives = 0;
    for (const node of root.listNodes()) {
        const mesh = node.getMesh();
        if (!mesh) continue;
        for (const prim of mesh.listPrimitives()) {
            primitives++;
            const indices = prim.getIndices();
            triangles += (indices ? indices.getCount() : prim.getAttribute('POSITION').getCount()) / 3;
        }
    }
    const nodes = Object.fromEntries(root.listNodes().map(n => [n.getName(), n]));
    const wheel = nodes.wheel_fl?.getExtras() ?? {};
    return {
        bytes: fs.statSync(file).size,
        triangles,
        primitives,
        nodes: Object.keys(nodes).sort(),
        materials: root.listMaterials().map(m => m.getName()),
        extensions: root.listExtensionsUsed().map(e => e.extensionName).sort(),
        textures: root.listTextures().map(t => ({ name: t.getName(), mimeType: t.getMimeType(), bytes: t.getImage()?.byteLength ?? 0 })),
        wheelRadius: typeof wheel.radius === 'number' ? wheel.radius : null,
        accessory: nodes.accessory_surfboard?.getExtras() ?? null,
        carExtras: root.listNodes().find(n => n.getName().startsWith('car_'))?.getExtras() ?? {}
    };
}

/** Budget violations of one packed LOD (empty = ok). */
export function checkBudget(lod, s, id) {
    const b = BUDGETS.lods[String(lod)];
    const errors = [];
    const maxTriangles = Math.min(b.maxTriangles, BUDGETS.modelTriangles?.[id]?.[String(lod)] ?? Infinity);
    if (s.triangles > maxTriangles) errors.push(`${s.triangles} triangles > ${maxTriangles}`);
    if (s.primitives > b.maxPrimitives) errors.push(`${s.primitives} primitives > ${b.maxPrimitives}`);
    if (s.bytes > b.maxBytes) errors.push(`${s.bytes} bytes > ${b.maxBytes}`);
    for (const n of BUDGETS.requiredNodes) if (!s.nodes.includes(n)) errors.push(`missing node ${n}`);
    for (const m of BUDGETS.requiredMaterials) if (!s.materials.includes(m)) errors.push(`missing material ${m}`);
    for (const e of BUDGETS.requiredExtensions) if (!s.extensions.includes(e)) errors.push(`missing extension ${e}`);
    for (const e of s.extensions) if (!BUDGETS.allowedExtensions.includes(e)) errors.push(`extension ${e} not allowed`);
    for (const t of s.textures) if (t.mimeType !== 'image/ktx2') errors.push(`texture ${t.name} is ${t.mimeType}, not KTX2`);
    if (!s.wheelRadius) errors.push('wheel_fl has no radius extra');
    if (!s.accessory || s.accessory.default_visible !== false) errors.push('accessory_surfboard must default to hidden');
    return errors;
}

/**
 * Packs all LODs of one model into public/models and returns its manifest entry.
 * @param {string} id model id (car type)
 * @param {{ name: string, lods: number[] }} spec entry of models.json
 */
export async function packModel(id, spec) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `bd-pack-${id}-`));
    fs.mkdirSync(PUBLIC_DIR, { recursive: true });
    const lods = [];
    try {
        for (const lod of spec.lods) {
            const src = path.join(RAW_DIR, id, `${id}_lod${lod}.glb`);
            if (!fs.existsSync(src)) throw new Error(`${src} missing - run the Blender build first (tools/models/build-all.mjs)`);
            const doc = await io.read(src);
            const root = doc.getRoot();
            // Blender 5.2 drops "Coat Roughness" on export -> restore it on the paints
            for (const m of root.listMaterials()) {
                const cc = m.getExtension('KHR_materials_clearcoat');
                if (cc && /^paint_/.test(m.getName())) cc.setClearcoatRoughnessFactor(0.03);
            }
            const textures = [];
            for (const texture of root.listTextures()) {
                const mime = texture.getMimeType();
                if (mime === 'image/ktx2') continue;
                const kind = textureKind(doc, texture);
                const before = texture.getImage().byteLength;
                const { ktx2, width, height, mode } = await encodeKTX2(texture.getImage(), { kind, quality: 255 });
                texture.setImage(ktx2).setMimeType('image/ktx2');
                if (texture.getURI()) texture.setURI(texture.getURI().replace(/\.(png|jpe?g|webp)$/i, '.ktx2'));
                textures.push({ name: texture.getName(), kind, mode, size: `${width}x${height}`, before, after: ktx2.byteLength });
            }
            if (textures.length) doc.createExtension(KHRTextureBasisu).setRequired(true);
            const mid = path.join(tmp, `${id}_lod${lod}.ktx2.glb`);
            await io.write(mid, doc);
            const out = path.join(PUBLIC_DIR, `${id}_lod${lod}.glb`);
            execFileSync(GLTFPACK, ['-i', mid, '-o', out, '-cc', '-kn', '-km', '-ke'], { stdio: 'pipe' });
            const s = await summarize(out);
            const errors = checkBudget(lod, s, id);
            const hash = createHash('sha256').update(fs.readFileSync(out)).digest('hex').slice(0, 12);
            console.log(`  ${id} lod${lod}: ${s.bytes} B (raw ${fs.statSync(src).size} B), ${s.triangles} tris, ` +
                `${s.primitives} primitives, ${textures.length} KTX2 textures` +
                (errors.length ? `\n    BUDGET: ${errors.join('; ')}` : ''));
            for (const t of textures) {
                console.log(`    ${t.name}: ${t.kind} ${t.mode} ${t.size} ${t.before} -> ${t.after} B`);
            }
            if (errors.length) throw new Error(`${id} lod${lod} violates budgets.json: ${errors.join('; ')}`);
            lods.push({
                lod,
                file: `${id}_lod${lod}.glb`,
                hash,
                bytes: s.bytes,
                triangles: s.triangles,
                primitives: s.primitives
            });
        }
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    const total = lods.reduce((sum, l) => sum + l.bytes, 0);
    if (total > BUDGETS.maxBytesPerModel) {
        throw new Error(`${id}: ${total} bytes for all LODs > ${BUDGETS.maxBytesPerModel}`);
    }
    const lod0 = await summarize(path.join(PUBLIC_DIR, lods[0].file));
    const x = lod0.carExtras;
    return {
        name: spec.name,
        wheelRadius: lod0.wheelRadius,
        // Real dimensions in metres (Blender build, tools/models/ref/dimensions.json)
        dimensions: {
            length: x.length_m ?? null,
            width: x.width_m ?? null,
            height: x.height_m ?? null,
            wheelbase: x.wheelbase_m ?? null
        },
        lods
    };
}
