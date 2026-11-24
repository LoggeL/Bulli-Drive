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

function readGlbJson(file) {
  const data = fs.readFileSync(file);
  if (data.readUInt32LE(0) !== 0x46546c67 || data.readUInt32LE(4) !== 2) {
    throw new Error(`Not a valid GLB 2.0: ${file}`);
  }
  const jsonLen = data.readUInt32LE(12);
  return JSON.parse(data.subarray(20, 20 + jsonLen).toString('utf8'));
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
    const pack = spawnSync(GLTFPACK, [
      '-i', item.raw,
      '-o', outGlb,
      '-cc', '-kn', '-km', '-ke',
    ], { cwd: ROOT, encoding: 'utf8' });

    if (pack.status !== 0) {
      throw new Error(`gltfpack failed on ${item.id}: ${pack.stderr || pack.stdout}`);
    }

    const buf = fs.readFileSync(outGlb);
    const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
    const gltf = readGlbJson(outGlb);
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
    if (item.hasBillboard && !nodeNames.has('billboard_face')) {
      failures.push(`${item.id}: missing "billboard_face" node after gltfpack`);
    }

    const entry = {
      file: `${item.id}.glb`,
      kind: item.kind,
      hash,
      bytes: buf.length,
      triangles: tris,
      bounds: item.bounds,
    };
    if (item.animNodes && item.animNodes.length > 0) entry.animNodes = item.animNodes;
    if (item.hasBillboard) entry.billboardNode = 'billboard_face';
    propsMap[item.id] = entry;

    console.log(
      `  [pack] ${item.id.padEnd(26)} ${String(tris).padStart(5)} tris  ${(buf.length / 1024).toFixed(1).padStart(6)} KB` +
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
