// three.js preview of the packed building kit (public/models/kit), the way the game will load it:
// GLTFLoader + KTX2Loader (the atlas referenced by the GLBs) + meshopt, MeshStandardMaterial with
// COLOR_0, RoomEnvironment reflections and a sun with shadows. Review aid only, not in the game.
//
//   node tools/models/buildings/preview.mjs [--out=/tmp/kit-preview] [--port=8870]
//
// Serves the repository on localhost (three from node_modules, the kit from public/models/kit),
// renders a few fixed views in headless Chromium and writes <out>/three_<view>.png.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value ?? true];
}));
const OUT = path.resolve(String(args.out ?? '/tmp/kit-preview'));
const PORT = Number(args.port ?? 8870);
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary',
    '.ktx2': 'image/ktx2', '.json': 'application/json', '.html': 'text/html' };

const PAGE = `<!doctype html><html><head><style>html,body{margin:0;background:#9fb6c8}canvas{display:block}</style>
<script type="importmap">{"imports":{"three":"/node_modules/three/build/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>
</head><body><script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(1600, 900);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fb6c8);
scene.fog = new THREE.Fog(0x9fb6c8, 150, 600);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x6b5f50, 0.6));
const sun = new THREE.DirectionalLight(0xfff0dc, 2.6);
sun.position.set(-60, 80, 70);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -140, right: 140, top: 140, bottom: -140, near: 1, far: 400 });
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200), new THREE.MeshStandardMaterial({ color: 0x6f6a62, roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const ktx2 = new KTX2Loader().setTranscoderPath('/node_modules/three/examples/jsm/libs/basis/').detectSupport(renderer);
const loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
const load = url => new Promise((res, rej) => loader.load(url, res, undefined, rej));
const groups = ${JSON.stringify(Object.keys(JSON.parse(fs.readFileSync(path.join(REPO, 'public/models/kit/manifest.json'), 'utf8')).groups))};
const pieces = {};
let calls = 0;
for (const g of groups) {
    const gltf = await load('/public/models/kit/kit_' + g + '.glb');
    gltf.scene.traverse(o => { if (o.userData && o.userData.kit_piece) pieces[o.userData.kit_piece] = o; });
}
function place(id, lod, x, z, rotY = 0) {
    const src = pieces[id];
    const lodNode = src.children.find(c => c.name.endsWith('_lod' + lod));
    const copy = lodNode.clone(true);
    copy.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    copy.position.set(x, 0, z);
    copy.rotation.y = rotY;
    scene.add(copy);
    return copy;
}
const w = id => { const f = pieces[id].userData.footprint; return f.maxX - f.minX; };
// Main street: downtown row facing +z along z = 0, a second row across the street facing -z
let x = -60;
for (const id of Object.keys(pieces).filter(p => p.startsWith('downtown'))) { place(id, 0, x + w(id) / 2, 0); x += w(id); }
x = -50;
for (const id of Object.keys(pieces).filter(p => p.startsWith('downtown')).reverse()) { place(id, 0, x + w(id) / 2, 22, Math.PI); x += w(id); }
// Seaview Heights and the beach front behind
x = -70;
for (const id of Object.keys(pieces).filter(p => p.startsWith('spanish'))) { place(id, 0, x + w(id) / 2, -45); x += w(id) + 6; }
x = -40;
for (const id of Object.keys(pieces).filter(p => p.startsWith('beach_'))) { place(id, 0, x + w(id) / 2, 70, Math.PI); x += w(id) + 4; }
// harbour, pier, props
x = 40;
for (const id of Object.keys(pieces).filter(p => p.startsWith('industrial'))) { place(id, 0, x + w(id) / 2, -40); x += w(id) + 12; }
for (let i = 0; i < 5; i++) place(i === 4 ? 'pier_end' : (i % 2 ? 'pier_segment_lamp' : 'pier_segment'), 0, 60 + i * 10, 60).position.y = 5;
place('lifeguard_tower', 0, 20, 70); place('surfboard_rack', 0, 12, 66);
for (let i = 0; i < 6; i++) place('arena_jersey', 0, 70 + i * 3.83, 20);
place('arena_container_20', 0, 100, 16, 0.3); place('arena_container_40', 0, 110, 4, -0.2); place('arena_floodlight', 0, 96, 30, Math.PI);
place('arena_grandstand', 0, 70, 30);
for (let i = 0; i < 6; i++) place('guardrail_segment', 0, -70 + i * 3.81, 34);
place('rock_boulder_l', 0, 30, 40); place('rock_boulder_m', 0, 36, 44); place('cliff_block', 0, 20, 95);
// LOD strip: the corner building at LOD0/1/2 side by side (far right)
['0', '1', '2'].forEach((l, i) => place('downtown_b6_f3_corner', Number(l), 190 + i * 30, 0));
const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.3, 2000);
window.shot = (px, py, pz, tx, ty, tz, fov) => {
    camera.fov = fov; camera.updateProjectionMatrix();
    camera.position.set(px, py, pz); camera.lookAt(tx, ty, tz);
    renderer.render(scene, camera);
    return renderer.info.render.calls;
};
window.ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/' || url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(PAGE);
        return;
    }
    const file = path.join(REPO, url);
    if (!file.startsWith(REPO) || !fs.existsSync(file)) {
        res.writeHead(404);
        res.end();
        return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve));
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForFunction(() => window.ready === true, null, { timeout: 120000 });
    fs.mkdirSync(OUT, { recursive: true });
    const views = {
        mainstreet: [-66, 1.7, 11, -20, 5, 2, 50],
        overview: [-40, 90, -150, 20, 0, 20, 40],
        harbour: [118, 5, -12, 80, 5, -45, 50],
        pier: [40, 8, 40, 75, 5, 60, 50],
        lods: [220, 14, 45, 220, 6, 0, 45],
        ...(args.debug ? { roof: [-40, 22, -8, -38, 9, 8, 50] } : {})
    };
    for (const [name, v] of Object.entries(views)) {
        const calls = await page.evaluate(v => window.shot(...v), v);
        const file = path.join(OUT, `three_${name}.png`);
        await page.screenshot({ path: file });
        console.log(`[preview] ${file} (${calls} draw calls)`);
    }
    if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
} finally {
    await browser.close();
    server.close();
}
