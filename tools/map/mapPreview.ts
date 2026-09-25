// Top-down preview of a curated map for reviews and the design document
// (docs/phase-3-design.md, 3 and 6.4, deviation A15):
//
//   npx tsx tools/map/mapPreview.ts [--map bulli-bay] [--size 1400] [--out docs/img/phase-3-map-preview.png]
//
// The committed terrain.bhf as shaded relief with its surfaces (preview.ts),
// then drawn over it in a headless Chromium canvas: roads by surface,
// areas, rails, zone outlines and names, the tracks with gates and grid,
// landmarks, spawns and the party arena's contents. North is up.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { areaRailLine, railLine } from '../../src/shared/map/rails.js';
import { routeToTrack } from '../../src/shared/map/routeToTrack.js';
import { loadMapBundle, ROOT } from './mapBundle.js';
import { encodePng } from './png.js';
import { heightsOf, shadedRgb } from './preview.js';
import { validateMap } from './validateMap.js';

type P = [number, number];

// Colours of the tracks in the order of tracks.json
const TRACK_COLORS = ['#e8413c', '#1f8fff', '#ff9f1a', '#b04cff', '#16b88a', '#ff4fa3', '#6c7a89'];

function round(p: readonly [number, number]): P {
    return [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10];
}

export function previewData(mapId: string) {
    const bundle = loadMapBundle(mapId);
    const { net, hf, pois, zones, tracks } = bundle;
    const validation = validateMap(bundle);
    const { cols, rows } = hf.spec;
    const base = encodePng(cols, rows, shadedRgb(hf, heightsOf(hf)));
    const every = <T>(list: readonly T[], n: number) => list.filter((_, i) => i % n === 0 || i === list.length - 1);
    // Road names: once per name, at the middle of its longest edge
    const longest = new Map<string, typeof net.edges[number]>();
    for (const edge of net.edges) {
        const name = edge.def.name;
        if (!name) continue;
        const best = longest.get(name);
        if (!best || edge.length > best.length) longest.set(name, edge);
    }
    return {
        mapId,
        name: bundle.map.name,
        spec: { originX: hf.spec.originX, originZ: hf.spec.originZ, size: (cols - 1) * hf.spec.cellSize },
        base: `data:image/png;base64,${Buffer.from(base).toString('base64')}`,
        boundary: bundle.map.boundary.map(round),
        // Zone names, unless a landmark of the same name labels the place
        zones: zones.zones.map(z => ({
            zone: z.zone,
            name: z.name && !pois.landmarks.some(l => l.name === z.name) ? z.name : '',
            label: z.label ?? null,
            polygon: z.polygon.map(round)
        })),
        areas: net.areas.map(a => ({ id: a.id, surface: a.surface, polygon: a.polygon.map(round) })),
        roads: net.edges.map(e => ({
            id: e.id, surface: e.profile.surface, width: e.profile.width,
            sidewalk: e.profile.sidewalk.left + e.profile.sidewalk.right > 0,
            points: every(e.samples, 3).map(p => round([p.x, p.z]))
        })),
        labels: [...longest.entries()].map(([name, e]) => {
            const p = e.samples[Math.floor(e.samples.length / 2)];
            return { name, x: p.x, z: p.z, angle: Math.atan2(p.tz, p.tx) };
        }),
        rails: [
            ...net.edges.flatMap(e => (e.def.rails ?? []).map(r => ({ kind: r.kind, points: every(railLine(e, r), 2).map(round) }))),
            ...net.areas.flatMap(a => (a.rails ?? []).map(r => ({ kind: r.kind, points: areaRailLine(a, r).map(round) })))
        ],
        // Jump ramps: the map's (free roam, party) and every track's
        jumps: [
            ...(pois.jumps ?? []),
            ...validation.routes.flatMap(route => routeToTrack(net, route, bundle.map.mapVersion).ramps)
        ].map(j => ({ x: j.x, z: j.z, yaw: j.yaw, length: j.length, width: j.width })),
        tracks: validation.routes.map((route, i) => ({
            id: route.track.id, name: route.track.name, kind: route.track.kind, laps: route.track.laps,
            bonus: route.track.bonus ?? false,
            color: TRACK_COLORS[i % TRACK_COLORS.length],
            closed: route.closed,
            points: route.points.filter(p => route.closed || (p.s >= route.startS - 40 && p.s <= route.finishS)).map(p => round([p.x, p.z])),
            gates: route.gates.map(g => ({ x: g.x, z: g.z, yaw: g.yaw, width: g.width, visual: g.visual })),
            grid: route.grid.map(g => round([g.x, g.z])),
            stats: validation.tracks.find(t => t.id === route.track.id)
        })),
        landmarks: pois.landmarks.map(l => ({ kind: l.kind, name: l.name, x: l.x, z: l.z })),
        spawns: pois.spawns.freeRoam.map(s => ({ x: s.x, z: s.z, yaw: s.yaw })),
        party: pois.spawns.party.map(s => ({ x: s.x, z: s.z, yaw: s.yaw })),
        arena: pois.arena,
        findings: validation.findings.filter(f => f.severity === 'error').length,
        km: validation.roads.km,
        tracksCount: tracks.tracks.length
    };
}

export type PreviewData = ReturnType<typeof previewData>;

// Runs in the page: draws everything onto a canvas and returns a PNG data URL
function draw(data: PreviewData, size: number): Promise<string> {
    const SURFACE_COLORS: Record<string, string> = {
        asphalt: '#3c3d42', concrete: '#a19d93', wood: '#8b5a2b', gravel: '#b3a283', dirt: '#8f6a43', sand: '#dcc58c'
    };
    const ZONE_COLORS: Record<string, string> = {
        downtown: '#c0504d', residential: '#d98c3a', industrial: '#6b6f78', beach: '#caa64c', dunes: '#b89a52',
        hills: '#6f7f3a', cliffs: '#7d6b5a', arena: '#b03aa8', park: '#3e8f3e', ranch: '#9a7a2e', wild: '#555'
    };
    const LANDMARK_GLYPH: Record<string, string> = {
        plaza: 'P', fountain: 'F', pier: 'Pi', restaurant: 'R', lookout: 'L', diner: 'D', gasStation: 'G',
        partyArena: 'A', cannery: 'C', lighthouse: 'Lh', waterTower: 'W', lifeguardTower: 'T', barn: 'B',
        harbor: 'H', crane: 'K', lightMast: 'M', beach: 'S', surfShop: 'Su', park: 'Pk'
    };
    return new Promise(resolve => {
        const canvas = document.createElement('canvas');
        const legendWidth = Math.round(size * 0.3);
        canvas.width = size + legendWidth;
        canvas.height = size;
        document.body.appendChild(canvas);
        const ctx = canvas.getContext('2d')!;
        const scale = size / data.spec.size;
        const X = (x: number) => (x - data.spec.originX) * scale;
        const Z = (z: number) => (z - data.spec.originZ) * scale;
        const path = (points: readonly (readonly [number, number])[], close = false) => {
            ctx.beginPath();
            points.forEach(([x, z], i) => i ? ctx.lineTo(X(x), Z(z)) : ctx.moveTo(X(x), Z(z)));
            if (close) ctx.closePath();
        };
        const label = (text: string, x: number, y: number, font: string, color = '#fff', halo = 'rgba(0,0,0,0.75)', align: CanvasTextAlign = 'center') => {
            ctx.font = font;
            ctx.textAlign = align;
            ctx.textBaseline = 'middle';
            ctx.lineWidth = 3;
            ctx.strokeStyle = halo;
            ctx.lineJoin = 'round';
            ctx.strokeText(text, x, y);
            ctx.fillStyle = color;
            ctx.fillText(text, x, y);
        };
        const img = new Image();
        img.onload = () => {
            ctx.fillStyle = '#f4f1ea';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(img, 0, 0, size, size);

            // Chunk grid (250 m, section 9)
            ctx.strokeStyle = 'rgba(255,255,255,0.18)';
            ctx.lineWidth = 1;
            for (let c = 1; c < 8; c++) {
                const p = c * size / 8;
                ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
            }
            // Zones
            ctx.setLineDash([6, 4]);
            for (const zone of data.zones) {
                ctx.strokeStyle = ZONE_COLORS[zone.zone] ?? '#555';
                ctx.lineWidth = 1.5;
                path(zone.polygon, true);
                ctx.stroke();
            }
            ctx.setLineDash([]);
            // Boundary
            ctx.strokeStyle = 'rgba(200,30,30,0.8)';
            ctx.lineWidth = 2;
            ctx.setLineDash([12, 6]);
            path(data.boundary, true);
            ctx.stroke();
            ctx.setLineDash([]);
            // Areas
            for (const area of data.areas) {
                ctx.fillStyle = SURFACE_COLORS[area.surface] ?? '#888';
                path(area.polygon, true);
                ctx.fill();
                ctx.strokeStyle = 'rgba(0,0,0,0.5)';
                ctx.lineWidth = 1;
                ctx.stroke();
            }
            // Roads: a dark casing, then the surface
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            for (const road of data.roads) {
                ctx.strokeStyle = road.sidewalk ? 'rgba(215,210,200,0.95)' : 'rgba(0,0,0,0.35)';
                ctx.lineWidth = Math.max(2.5, (road.width + (road.sidewalk ? 6 : 2)) * scale);
                path(road.points);
                ctx.stroke();
            }
            for (const road of data.roads) {
                ctx.strokeStyle = SURFACE_COLORS[road.surface] ?? '#888';
                ctx.lineWidth = Math.max(1.5, road.width * scale);
                path(road.points);
                ctx.stroke();
            }
            // Rails
            for (const rail of data.rails) {
                ctx.strokeStyle = rail.kind === 'fence' ? '#e0e0e0' : rail.kind === 'wood' ? '#c89a5a' : '#f2f2f2';
                ctx.lineWidth = 1.2;
                ctx.setLineDash(rail.kind === 'fence' ? [2, 2] : []);
                path(rail.points);
                ctx.stroke();
            }
            ctx.setLineDash([]);
            // Party arena contents
            const box = (x: number, z: number, yaw: number, l: number, w: number) => {
                const fx = Math.sin(yaw), fz = Math.cos(yaw), lx = fz, lz = -fx;
                const corners: [number, number][] = [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([a, b]) =>
                    [x + fx * a * l / 2 + lx * b * w / 2, z + fz * a * l / 2 + lz * b * w / 2]);
                path(corners, true);
            };
            for (const c of data.arena.containers) {
                box(c.x, c.z, c.yaw, 12.2, 2.44);
                ctx.fillStyle = '#c0392b'; ctx.fill();
            }
            for (const r of data.arena.ramps) {
                box(r.x, r.z, r.yaw, r.length, r.width);
                ctx.fillStyle = '#f1c40f'; ctx.fill();
            }
            // Jump ramps, outlined so they show up outside the arena too
            for (const j of data.jumps) {
                box(j.x, j.z, j.yaw, j.length, j.width);
                ctx.fillStyle = '#f1c40f'; ctx.fill();
                ctx.strokeStyle = '#111'; ctx.lineWidth = 1.2; ctx.stroke();
            }
            for (const [x, z] of data.arena.coins) { ctx.fillStyle = '#ffd700'; ctx.beginPath(); ctx.arc(X(x), Z(z), 1.8, 0, 7); ctx.fill(); }
            for (const [x, z] of data.arena.powerups) { ctx.fillStyle = '#3fa9ff'; ctx.beginPath(); ctx.arc(X(x), Z(z), 1.8, 0, 7); ctx.fill(); }
            // Tracks
            for (const track of data.tracks) {
                ctx.strokeStyle = track.color;
                ctx.globalAlpha = track.bonus ? 0.7 : 0.95;
                ctx.lineWidth = 3;
                ctx.setLineDash(track.bonus ? [7, 4] : []);
                path(track.points, track.closed);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.globalAlpha = 1;
                // Direction arrows every ~120 m
                const pts = track.points;
                for (let i = 20; i + 1 < pts.length; i += 60) {
                    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
                    const ang = Math.atan2(Z(bz) - Z(az), X(bx) - X(ax));
                    ctx.save();
                    ctx.translate(X(ax), Z(az));
                    ctx.rotate(ang);
                    ctx.fillStyle = track.color;
                    ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-4, -4.5); ctx.lineTo(-4, 4.5); ctx.closePath(); ctx.fill();
                    ctx.restore();
                }
                // Gates across the driving direction
                for (const g of track.gates) {
                    const lx = Math.cos(g.yaw), lz = -Math.sin(g.yaw);
                    ctx.strokeStyle = g.visual === 'arch' ? track.color : '#ffffff';
                    ctx.lineWidth = g.visual === 'arch' ? 2 : 3.5;
                    ctx.beginPath();
                    ctx.moveTo(X(g.x + lx * g.width / 2), Z(g.z + lz * g.width / 2));
                    ctx.lineTo(X(g.x - lx * g.width / 2), Z(g.z - lz * g.width / 2));
                    ctx.stroke();
                }
                for (const [x, z] of track.grid) {
                    ctx.fillStyle = '#fff';
                    ctx.fillRect(X(x) - 1.2, Z(z) - 1.2, 2.4, 2.4);
                }
                const start = track.gates[0];
                label(track.kind === 'circuit' ? 'S/F' : 'S', X(start.x), Z(start.z) - 11, 'bold 11px sans-serif', '#fff', track.color);
                if (track.kind === 'sprint') {
                    const fin = track.gates[track.gates.length - 1];
                    label('Z', X(fin.x), Z(fin.z) - 11, 'bold 11px sans-serif', '#fff', track.color);
                }
            }
            // Spawns
            const tri = (x: number, z: number, yaw: number, color: string) => {
                ctx.save();
                ctx.translate(X(x), Z(z));
                ctx.rotate(Math.atan2(Math.cos(yaw), Math.sin(yaw)));
                ctx.fillStyle = color;
                ctx.strokeStyle = '#000';
                ctx.lineWidth = 0.8;
                ctx.beginPath(); ctx.moveTo(4.5, 0); ctx.lineTo(-3, -3); ctx.lineTo(-3, 3); ctx.closePath();
                ctx.fill(); ctx.stroke();
                ctx.restore();
            };
            for (const s of data.spawns) tri(s.x, s.z, s.yaw, '#39ff6a');
            for (const s of data.party) tri(s.x, s.z, s.yaw, '#ff5ce1');
            // Road names
            for (const l of data.labels) {
                ctx.save();
                ctx.translate(X(l.x), Z(l.z));
                let a = l.angle;
                if (a > Math.PI / 2) a -= Math.PI; else if (a < -Math.PI / 2) a += Math.PI;
                ctx.rotate(a);
                label(l.name, 0, -9, 'italic 10px sans-serif', '#fdfdfd', 'rgba(0,0,0,0.7)');
                ctx.restore();
            }
            // Zone names at the centre of their polygon
            for (const zone of data.zones) {
                if (!zone.name) continue;
                let cx = 0, cz = 0;
                for (const [x, z] of zone.polygon) { cx += x; cz += z; }
                cx /= zone.polygon.length; cz /= zone.polygon.length;
                if (zone.label) [cx, cz] = zone.label;
                label(zone.name.toUpperCase(), X(cx), Z(cz), 'bold 13px sans-serif', '#fff8e0', 'rgba(60,40,20,0.8)');
            }
            // Landmarks
            for (const l of data.landmarks) {
                ctx.fillStyle = '#fff';
                ctx.strokeStyle = '#222';
                ctx.lineWidth = 1.5;
                ctx.beginPath(); ctx.arc(X(l.x), Z(l.z), 7, 0, 7); ctx.fill(); ctx.stroke();
                label(LANDMARK_GLYPH[l.kind] ?? '?', X(l.x), Z(l.z), 'bold 8px sans-serif', '#222', '#fff');
                label(l.name, X(l.x) + 10, Z(l.z), '10px sans-serif', '#fff', 'rgba(0,0,0,0.75)', 'left');
            }
            // Scale bar and north arrow
            const bar = 500 * scale;
            ctx.fillStyle = 'rgba(255,255,255,0.9)';
            ctx.fillRect(size - bar - 30, size - 40, bar + 20, 28);
            ctx.fillStyle = '#222';
            ctx.fillRect(size - bar - 20, size - 22, bar, 5);
            label('500 m', size - 20 - bar / 2, size - 32, 'bold 11px sans-serif', '#222', '#fff');
            ctx.fillStyle = '#222';
            ctx.beginPath(); ctx.moveTo(size - 30, 20); ctx.lineTo(size - 38, 42); ctx.lineTo(size - 22, 42); ctx.closePath(); ctx.fill();
            label('N', size - 30, 52, 'bold 13px sans-serif', '#222', '#fff');

            // Legend
            const lx = size + 20;
            let ly = 34;
            ctx.fillStyle = '#f4f1ea';
            ctx.fillRect(size, 0, legendWidth, size);
            label(data.name, lx, ly, 'bold 26px serif', '#1d2b3a', '#f4f1ea', 'left');
            ly += 26;
            label(`Vorschau aus terrain.bhf und den Quellen (${data.mapId})`, lx, ly, '12px sans-serif', '#444', '#f4f1ea', 'left');
            ly += 18;
            label(`${data.km.toFixed(1)} km Straßen · 2 × 2 km · ${data.findings} Fehler der Validierung`, lx, ly, '12px sans-serif', '#444', '#f4f1ea', 'left');
            ly += 34;
            label('Strecken', lx, ly, 'bold 15px sans-serif', '#1d2b3a', '#f4f1ea', 'left');
            ly += 22;
            const time = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
            for (const track of data.tracks) {
                ctx.strokeStyle = track.color;
                ctx.lineWidth = 4;
                ctx.setLineDash(track.bonus ? [7, 4] : []);
                ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + 26, ly); ctx.stroke();
                ctx.setLineDash([]);
                label(`${track.name}${track.bonus ? ' (Bonus)' : ''}`, lx + 34, ly, 'bold 12px sans-serif', '#1d2b3a', '#f4f1ea', 'left');
                ly += 16;
                const st = track.stats;
                if (st) {
                    const laps = track.kind === 'circuit' ? ` × ${track.laps} Runden` : ' Sprint';
                    label(`${(st.length / 1000).toFixed(2)} km${laps}, ${st.gates} Gates, +${Math.round(st.climb)} m`, lx + 34, ly, '11px sans-serif', '#333', '#f4f1ea', 'left');
                    ly += 15;
                    label(`Schätzung ${time(st.fastest.time)} (${st.fastest.car}) – ${time(st.slowest.time)} (${st.slowest.car})`, lx + 34, ly, '11px sans-serif', '#333', '#f4f1ea', 'left');
                    ly += 15;
                }
                ly += 8;
            }
            ly += 14;
            label('Beläge', lx, ly, 'bold 15px sans-serif', '#1d2b3a', '#f4f1ea', 'left');
            ly += 22;
            for (const [name, color] of Object.entries(SURFACE_COLORS)) {
                ctx.fillStyle = color;
                ctx.fillRect(lx, ly - 6, 26, 12);
                label(name, lx + 34, ly, '12px sans-serif', '#333', '#f4f1ea', 'left');
                ly += 18;
            }
            ly += 14;
            label('Zeichen', lx, ly, 'bold 15px sans-serif', '#1d2b3a', '#f4f1ea', 'left');
            ly += 22;
            const legendTri = (color: string, text: string) => {
                ctx.save(); ctx.translate(lx + 13, ly); ctx.fillStyle = color; ctx.strokeStyle = '#000';
                ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-4, -4); ctx.lineTo(-4, 4); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
                label(text, lx + 34, ly, '12px sans-serif', '#333', '#f4f1ea', 'left');
                ly += 18;
            };
            legendTri('#39ff6a', 'Free-Roam-Spawn');
            legendTri('#ff5ce1', 'Party-Spawn');
            const legendLine = (color: string, dash: number[], text: string, width = 2) => {
                ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash);
                ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + 26, ly); ctx.stroke(); ctx.setLineDash([]);
                label(text, lx + 34, ly, '12px sans-serif', '#333', '#f4f1ea', 'left');
                ly += 18;
            };
            legendLine('#555', [], 'Leitplanke / Geländer', 1.5);
            legendLine('rgba(200,30,30,0.8)', [12, 6], 'Kartengrenze');
            legendLine('#888', [6, 4], 'Zonen');
            legendLine('#fff', [], 'Start / Ziel (weiß), Gates (Farbe)', 3);
            ctx.fillStyle = '#c0392b'; ctx.fillRect(lx, ly - 4, 26, 8);
            label('Container, Rampen/Sprünge (gelb), Coins, Power-ups', lx + 34, ly, '12px sans-serif', '#333', '#f4f1ea', 'left');
            ly += 26;
            label('Landmarken', lx, ly, 'bold 15px sans-serif', '#1d2b3a', '#f4f1ea', 'left');
            ly += 20;
            const seen = new Set<string>();
            for (const l of data.landmarks) {
                if (seen.has(l.kind)) continue;
                seen.add(l.kind);
                ctx.fillStyle = '#fff'; ctx.strokeStyle = '#222'; ctx.lineWidth = 1.5;
                ctx.beginPath(); ctx.arc(lx + 13, ly, 7, 0, 7); ctx.fill(); ctx.stroke();
                label(LANDMARK_GLYPH[l.kind] ?? '?', lx + 13, ly, 'bold 8px sans-serif', '#222', '#fff');
                label(l.kind, lx + 34, ly, '11px sans-serif', '#333', '#f4f1ea', 'left');
                ly += 16;
            }
            resolve(canvas.toDataURL('image/png'));
        };
        img.src = data.base;
    });
}

export async function renderMapPreview(mapId: string, size: number): Promise<Buffer> {
    const data = previewData(mapId);
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.setContent('<!doctype html><html><body style="margin:0"></body></html>');
        // tsx compiles with keepNames, so functions sent as source text call
        // its __name helper
        await page.evaluate('globalThis.__name = (fn) => fn');
        const url = await page.evaluate(({ data, size, source }) => {
            // The draw function travels as source text
            const fn = new Function(`return (${source})`)() as (d: typeof data, s: number) => Promise<string>;
            return fn(data, size);
        }, { data, size, source: draw.toString() });
        return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
    } finally {
        await browser.close();
    }
}

async function main(argv: string[]): Promise<number> {
    const arg = (name: string) => {
        const i = argv.indexOf(name);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const mapId = arg('--map') ?? 'bulli-bay';
    const size = Number(arg('--size') ?? 1400);
    const out = path.resolve(ROOT, arg('--out') ?? 'docs/img/phase-3-map-preview.png');
    const png = await renderMapPreview(mapId, size);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, png);
    console.log(`wrote ${path.relative(ROOT, out)} (${Math.round(png.length / 1024)} KB)`);
    return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
