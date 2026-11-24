#!/usr/bin/env node
// Build & pack all 24 Hero Monuments & Easter-Egg Props -> public/models/props/*.glb + manifest.json
//
// Usage:
//   node tools/models/props/build-props.mjs [--only=id1,id2] [--preview=/tmp/bulli-props-preview] [--no-ao]
//
// Zero Draco: compresses every GLB with meshoptimizer (gltfpack -cc -kn -km -ke) preserving named
// nodes (animNodes, billboard_face), materials, and extras, matching src/client/assets/gltfLoader.ts.
import { spawnSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MeshoptDecoder } from '../../node_modules/meshoptimizer/meshopt_decoder.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const TOOLS_DIR = path.join(ROOT, 'tools');
const RAW_DIR = path.join(ROOT, 'tools/models/.out/props');
const OUT_DIR = path.join(ROOT, 'public/models/props');
const GLTFPACK = path.join(TOOLS_DIR, 'node_modules/.bin/gltfpack');
const BLENDER = process.env.BLENDER || '/opt/homebrew/bin/blender';

const BUDGETS = {
  monument: { maxTris: 8000, maxBytes: 180 * 1024 },
  prop:     { maxTris: 2500, maxBytes: 80 * 1024 },
  totalMaxBytes: 2.5 * 1024 * 1024,
};

const args = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.slice(2).split('=');
    return [k, v ?? 'true'];
  })
);

function runBlenderAsync(script, extraArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(BLENDER, ['-b', '--factory-startup', '--python-exit-code', '1', '--python', script, '--', ...extraArgs], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', d => {
      const s = d.toString();
      out += s;
      for (const line of s.split('\n')) {
        if (line.startsWith('[prop]') || line.startsWith('ERROR')) process.stdout.write(line + '\n');
      }
    });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`Blender ${path.basename(script)} failed (${code}):\n${err.slice(-2000)}\n${out.slice(-2000)}`));
      } else {
        resolve(out);
      }
    });
  });
}

function readGlb(file) {
  const data = fs.readFileSync(file);
  if (data.readUInt32LE(0) !== 0x46546c67 || data.readUInt32LE(4) !== 2) {
    throw new Error(`Not a valid GLB 2.0: ${file}`);
  }
  const jsonLen = data.readUInt32LE(12);
  const gltf = JSON.parse(data.subarray(20, 20 + jsonLen).toString('utf8'));
  const binChunkOffset = 20 + jsonLen;
  const binLen = data.readUInt32LE(binChunkOffset);
  const bin = data.subarray(binChunkOffset + 8, binChunkOffset + 8 + binLen);
  return { gltf, bin };
}

function decodeAccessorVec2Float(gltf, bin, accIdx) {
  const acc = gltf.accessors[accIdx];
  if (!acc || acc.type !== 'VEC2' || acc.componentType !== 5126) {
    throw new Error(`TEXCOORD_0 accessor ${accIdx} must be FLOAT VEC2 (got ${acc?.componentType} ${acc?.type})`);
  }
  const bv = gltf.bufferViews[acc.bufferView];
  const ext = bv.extensions?.EXT_meshopt_compression;
  let bytes;
  if (ext) {
    const src = bin.subarray(ext.byteOffset ?? 0, (ext.byteOffset ?? 0) + ext.byteLength);
    bytes = new Uint8Array(ext.count * ext.byteStride);
    MeshoptDecoder.decodeGltfBuffer(bytes, ext.count, ext.byteStride, src, ext.mode, ext.filter ?? 'NONE');
  } else {
    const off = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    bytes = bin.subarray(off, off + acc.count * 8);
  }
  const stride = ext?.byteStride ?? bv.byteStride ?? 8;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  for (let i = 0; i < acc.count; i++) {
    out.push([dv.getFloat32(i * stride, true), dv.getFloat32(i * stride + 4, true)]);
  }
  return out;
}

function verifyBillboardFaceUvs(gltf, bin, id) {
  const nodes = gltf.nodes ?? [];
  const rootIdx = nodes.findIndex(n => n.name === 'billboard_face');
  if (rootIdx < 0) return `${id}: missing "billboard_face" node after gltfpack`;

  const prims = [];
  const stack = [rootIdx];
  while (stack.length) {
    const n = nodes[stack.pop()];
    if (n.mesh !== undefined) prims.push(...gltf.meshes[n.mesh].primitives);
    for (const c of n.children ?? []) stack.push(c);
  }
  if (prims.length === 0) return `${id}: "billboard_face" node has no mesh primitives`;

  for (const prim of prims) {
    const tcIdx = prim.attributes?.TEXCOORD_0;
    if (tcIdx === undefined) return `${id}: "billboard_face" primitive is missing TEXCOORD_0`;
    const uvs = decodeAccessorVec2Float(gltf, bin, tcIdx);
    if (uvs.length < 4) return `${id}: "billboard_face" TEXCOORD_0 has only ${uvs.length} verts`;
    const us = uvs.map(p => p[0]);
    const vs = uvs.map(p => p[1]);
    const uMin = Math.min(...us), uMax = Math.max(...us);
    const vMin = Math.min(...vs), vMax = Math.max(...vs);
    if (Math.abs(uMin) > 1e-4 || Math.abs(uMax - 1) > 1e-4 || Math.abs(vMin) > 1e-4 || Math.abs(vMax - 1) > 1e-4) {
      return `${id}: "billboard_face" TEXCOORD_0 range [${uMin},${vMin}]..[${uMax},${vMax}] != [0,0]..[1,1]`;
    }
  }
  return null;
}

function countGlbTris(gltf) {
  let tris = 0;
  for (const node of gltf.nodes ?? []) {
    if (node.mesh === undefined) continue;
    for (const prim of gltf.meshes[node.mesh].primitives) {
      const acc = prim.indices !== undefined ? gltf.accessors[prim.indices] : gltf.accessors[prim.attributes.POSITION];
      tris += Math.round(acc.count / 3);
    }
  }
  return tris;
}

async function main() {
  await MeshoptDecoder.ready;
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const commonArgs = [`--out=${RAW_DIR}`];
  if (args.only) commonArgs.push(`--only=${args.only}`);
  if (args.preview) commonArgs.push(`--preview=${args.preview}`);
  if (args['no-ao']) commonArgs.push('--no-ao');

  const metaMon = path.join(RAW_DIR, 'monuments_meta.json');
  const metaEgg = path.join(RAW_DIR, 'easter_eggs_meta.json');

  console.log('[props] Building monuments & easter-egg props in parallel via Blender 5.2...');
  await Promise.all([
    runBlenderAsync(path.join(HERE, 'monuments.py'), [...commonArgs, `--meta=${metaMon}`]),
    runBlenderAsync(path.join(HERE, 'easter_eggs.py'), [...commonArgs, `--meta=${metaEgg}`]),
  ]);

  const rawMeta = [
    ...(fs.existsSync(metaMon) ? JSON.parse(fs.readFileSync(metaMon, 'utf8')) : []),
    ...(fs.existsSync(metaEgg) ? JSON.parse(fs.readFileSync(metaEgg, 'utf8')) : []),
  ];

  // Load existing manifest when using --only so partial rebuilds keep other entries
  const manifestPath = path.join(OUT_DIR, 'manifest.json');
  const propsMap = (args.only && fs.existsSync(manifestPath))
    ? (JSON.parse(fs.readFileSync(manifestPath, 'utf8')).props ?? {})
    : {};

  let failures = [];
  for (const item of rawMeta) {
    const outGlb = path.join(OUT_DIR, `${item.id}.glb`);
    const packArgs = ['-i', item.raw, '-o', outGlb, '-cc', '-kn', '-km', '-ke'];
    if (item.hasBillboard) {
      // Keep unused TEXCOORD_0 on billboard_face (texture is bound dynamically at runtime)
      // as unquantized FLOAT [0..1] so no KHR_texture_transform compensation is required.
      packArgs.push('-kv', '-vtf');
    }
    const pack = spawnSync(GLTFPACK, packArgs, { cwd: ROOT, encoding: 'utf8' });

    if (pack.status !== 0) {
      throw new Error(`gltfpack failed on ${item.id}: ${pack.stderr || pack.stdout}`);
    }

    const buf = fs.readFileSync(outGlb);
    const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
    const { gltf, bin } = readGlb(outGlb);
    const tris = countGlbTris(gltf);
    const nodeNames = new Set((gltf.nodes ?? []).map(n => n.name).filter(Boolean));
    const exts = gltf.extensionsUsed ?? [];

    const b = BUDGETS[item.kind];
    if (tris > b.maxTris) failures.push(`${item.id}: ${tris} tris > ${b.maxTris}`);
    if (buf.length > b.maxBytes) failures.push(`${item.id}: ${buf.length} B > ${b.maxBytes} B`);
    if (exts.includes('KHR_draco_mesh_compression')) failures.push(`${item.id}: uses Draco!`);
    for (const an of item.animNodes ?? []) {
      if (!nodeNames.has(an)) failures.push(`${item.id}: missing animNode "${an}" after gltfpack`);
    }
    if (item.hasBillboard) {
      const uvErr = verifyBillboardFaceUvs(gltf, bin, item.id);
      if (uvErr) failures.push(uvErr);
    }

    const foundation = Number(Math.max(0, -(item.bounds?.min?.[1] ?? 0)).toFixed(3));
    const entry = {
      file: `${item.id}.glb`,
      kind: item.kind,
      hash,
      bytes: buf.length,
      triangles: tris,
      foundation,
      bounds: item.bounds,
    };
    if (item.animNodes && item.animNodes.length > 0) entry.animNodes = item.animNodes;
    if (item.hasBillboard) entry.billboardNode = 'billboard_face';
    propsMap[item.id] = entry;

    console.log(
      `  [pack] ${item.id.padEnd(26)} ${String(tris).padStart(5)} tris  ${(buf.length / 1024).toFixed(1).padStart(6)} KB` +
      `  found=${foundation.toFixed(1)}m` +
      (item.animNodes?.length ? `  anim=[${item.animNodes.join(',')}]` : '') +
      (item.hasBillboard ? '  [billboard_face]' : '')
    );
  }

  // Sort keys cleanly in manifest
  const sortedProps = Object.fromEntries(Object.keys(propsMap).sort().map(k => [k, propsMap[k]]));
  const totalBytes = Object.values(sortedProps).reduce((s, e) => s + e.bytes, 0);
  if (totalBytes > BUDGETS.totalMaxBytes) {
    failures.push(`Total props bytes ${totalBytes} > ${BUDGETS.totalMaxBytes}`);
  }

  const manifest = {
    version: 1,
    billboardUvConvention: 'three-plane-flipY-true',
    props: sortedProps,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  console.log(`\n[props] Wrote public/models/props/manifest.json (${Object.keys(sortedProps).length} props, ${(totalBytes / 1024).toFixed(1)} KB total)`);
  if (failures.length > 0) {
    console.error('[props] BUDGET / CONTRACT FAILURES:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
