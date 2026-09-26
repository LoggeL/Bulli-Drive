// Vertical dynamics measurement (docs/phase-1a-design.md, 26): how far a
// car leaves the ground over crests and bumps at speed. A measurement, not
// a gate; it prints a table (and with --series the height over the ground
// and vy over time) so the vertical model can be compared before and after
// a change.
//
//   npx tsx scripts/sim-airtime.ts            # table
//   npx tsx scripts/sim-airtime.ts --series   # plus time series every 3 ticks
//
// Scenarios, each at 25, 40 and 55 m/s held constant (the horizontal speed
// is set before every tick, yaw fixed, so only the vertical motion is
// measured):
// - bump: a synthetic cosine bump 1.5 m high and 12 m long on flat ground
// - crest R150: a parabolic crest of radius 150 m between grades of ±10 %
//   (the smallest vertical radius the map's road profiles are rounded to)
// - map crests: the three most convex crests on the race tracks of Bulli
//   Bay where the road runs straight for ±40 m, driven along the track's
//   tangent there, and the sharpest grade kink of all tracks (25 m either
//   side)
// Besides, one medium bot per track and class (driveTrack) counts the
// flights (>= 3 ticks in the air) off ramps and off the terrain.

import { loadMap } from '../src/server/maps.js';
import { heightAt } from '../src/shared/map/heightfield.js';
import { createMapData } from '../src/shared/map/mapData.js';
import { routeToTrack } from '../src/shared/map/routeToTrack.js';
import { spawnCar } from '../src/shared/sim/scenarios.js';
import type { SimCar } from '../src/shared/sim/types.js';
import { stepVehicle } from '../src/shared/sim/world.js';
import { CAR_CLASS_IDS } from '../src/shared/sim/vehicleClasses.js';
import { createSimWorld, type GroundModel, type SimWorld } from '../src/shared/world/colliders.js';
import { driveTrack } from '../tools/map/driveTrack.js';
import { loadMapBundle } from '../tools/map/mapBundle.js';
import { validateMap } from '../tools/map/validateMap.js';

const SPEEDS = [25, 40, 55];
const series = process.argv.includes('--series');

function groundWorld(height: (x: number, z: number) => number): SimWorld {
    const model: GroundModel = {
        height, surface: () => 0, waterLevel: -Infinity, fallLimit: -Infinity, bound: 4000,
        grid: { origin: -4000, cellSize: 64, cells: 125 }
    };
    return createSimWorld(model, [], []);
}

// Cosine bump 1.5 m high, 12 m long, from z = 0 to z = 12
const BUMP_H = 1.5, BUMP_L = 12;
const bump = groundWorld((_x, z) => z > 0 && z < BUMP_L ? BUMP_H / 2 * (1 - Math.cos(2 * Math.PI * z / BUMP_L)) : 0);

// Crest of radius R between grades of ±G: y = -z²/(2R) for |z| < R·G, the
// straight grades beyond, top at z = 0
const R = 150, G = 0.1;
const crest = groundWorld((_x, z) => Math.abs(z) < R * G ? -z * z / (2 * R) : -(Math.abs(z) - R * G / 2) * G);

interface Run { label: string; speed: number; air: number; maxGap: number; maxVy: number; impact: number; takeoffZ: number | null }

// Drives a car along (dx, dz) from (x0, z0) through `length` m at a fixed
// horizontal speed
function run(label: string, world: SimWorld, x0: number, z0: number, dx: number, dz: number, speed: number, length: number): Run {
    const yaw = Math.atan2(dx, dz);
    const car: SimCar = spawnCar(world, 'a', 'bulli', x0, z0, yaw, speed);
    const ticks = Math.ceil(length / speed * 60);
    let air = 0, maxGap = 0, maxVy = 0, impact = 0, takeoffZ: number | null = null;
    const rows: string[] = [];
    for (let t = 0; t < ticks; t++) {
        const s = car.state;
        s.vx = dx * speed;
        s.vz = dz * speed;
        s.yaw = yaw;
        s.yawRate = 0;
        car.input.throttle = 0;
        stepVehicle(car, world);
        const gap = s.y - world.groundHeight(s.x, s.z);
        if (!s.grounded) {
            air++;
            if (takeoffZ === null) takeoffZ = (s.x - x0) * dx + (s.z - z0) * dz;
        }
        maxGap = Math.max(maxGap, gap);
        maxVy = Math.max(maxVy, s.vy);
        impact = Math.max(impact, car.events.landedImpact);
        if (series && t % 3 === 0) rows.push(`${(t / 60).toFixed(2)}s ${gap.toFixed(2)}m ${s.vy.toFixed(1)}`);
    }
    if (series) console.log(`  ${label} ${speed} m/s: ${rows.join(' | ')}`);
    return { label, speed, air: air / 60, maxGap, maxVy, impact, takeoffZ };
}

const results: Run[] = [];
for (const v of SPEEDS) results.push(run('bump 1.5 m / 12 m', bump, 0, -60, 0, 1, v, 60 + BUMP_L + Math.max(80, v * 3)));
for (const v of SPEEDS) results.push(run('crest R 150 m', crest, 0, -60, 0, 1, v, 60 + Math.max(120, v * 3)));

// ---- The most convex crests of the race tracks ----

const bundle = loadMapBundle('bulli-bay');
const map = createMapData(bundle, bundle.hf);
const validation = validateMap(bundle);
const WINDOW = 10;
const crests: { track: string; x: number; z: number; tx: number; tz: number; kappa: number }[] = [];
for (const route of validation.routes) {
    const pts = route.points;
    const h = pts.map(p => heightAt(bundle.hf, p.x, p.z));
    const k = WINDOW / 2; // points are 2 m apart
    for (let i = 20; i < pts.length - 20; i++) {
        // Only where the road runs straight for ±40 m, so the straight run
        // through the crest stays on it
        let bend = 0;
        for (let j = i - 20; j <= i + 20; j++) bend = Math.max(bend, Math.abs(pts[j].curvature));
        if (bend > 0.004) continue;
        // Vertical curvature from the second difference over ±10 m (convex > 0)
        const kappa = -(h[i + k] - 2 * h[i] + h[i - k]) / (WINDOW * WINDOW);
        crests.push({ track: route.track.id, x: pts[i].x, z: pts[i].z, tx: pts[i].tx, tz: pts[i].tz, kappa });
    }
}
crests.sort((a, b) => b.kappa - a.kappa);
const picked: typeof crests = [];
for (const c of crests) {
    if (picked.length === 3) break;
    if (picked.every(p => Math.hypot(p.x - c.x, p.z - c.z) > 100)) picked.push(c);
}
// And the sharpest grade kink of all tracks (second difference over ±2 m),
// driven 25 m either side of it along the track's tangent
let kink = { track: '', x: 0, z: 0, tx: 0, tz: 0, kappa: -Infinity };
for (const route of validation.routes) {
    const pts = route.points;
    for (let i = 13; i < pts.length - 13; i++) {
        const h = (j: number) => heightAt(bundle.hf, pts[j].x, pts[j].z);
        const kappa = -(h(i + 1) - 2 * h(i) + h(i - 1)) / 4;
        if (kappa > kink.kappa) kink = { track: route.track.id, x: pts[i].x, z: pts[i].z, tx: pts[i].tx, tz: pts[i].tz, kappa };
    }
}
const mapWorld = loadMap().simWorld;
for (const c of picked) {
    const label = `${c.track} (${c.x.toFixed(0)}, ${c.z.toFixed(0)}) κ ${c.kappa.toFixed(4)}/m`;
    for (const v of SPEEDS) results.push(run(label, mapWorld, c.x - c.tx * 40, c.z - c.tz * 40, c.tx, c.tz, v, 40 + Math.max(60, v * 2)));
}
for (const v of SPEEDS) {
    const label = `kink ${kink.track} (${kink.x.toFixed(0)}, ${kink.z.toFixed(0)}) κ ${kink.kappa.toFixed(3)}/m over 4 m`;
    results.push(run(label, mapWorld, kink.x - kink.tx * 25, kink.z - kink.tz * 25, kink.tx, kink.tz, v, 50));
}

console.log('\n| Scenario | v (m/s) | air (s) | max height over ground (m) | max vy (m/s) | landing impact (m/s) |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: |');
for (const r of results) {
    console.log(`| ${r.label} | ${r.speed} | ${r.air.toFixed(2)} | ${r.maxGap.toFixed(2)} | ${r.maxVy.toFixed(1)} | ${r.impact.toFixed(1)} |`);
}

// ---- Bots on every track: flights off ramps and off the terrain ----

console.log('\n| Track | class | time (s) | resets | ramp flights | terrain flights | longest terrain flight (s) |');
console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: |');
for (const route of validation.routes) {
    const track = routeToTrack(bundle.net, route, bundle.map.mapVersion);
    for (const classId of CAR_CLASS_IDS) {
        const result = driveTrack(map, track, classId, 'medium', 1);
        const ramp = result.flights.filter(f => f.ramp >= 0).length;
        const terrain = result.flights.filter(f => f.ramp < 0);
        const longest = terrain.reduce((m, f) => Math.max(m, f.ticks), 0) / 60;
        console.log(`| ${route.track.id} | ${classId} | ${result.time?.toFixed(1) ?? 'DNF'} | ${result.resets} | ${ramp} | ${terrain.length} | ${longest.toFixed(2)} |`);
    }
}
