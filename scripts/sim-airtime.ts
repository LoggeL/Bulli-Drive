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
//
// Roads (docs/phase-1a-design.md, 27): every road of the map (chains of
// edges through joints), both directions, at 60, 100, 130, 160 and 200 km/h
// held constant along the centre line (the car is put back onto the line
// and turned along it before every tick): every take-off of at least
// 3 ticks with its place, air time and height, and a summary per speed.
// Ramps: every jump ramp of the map (free roam) and of the tracks (race
// world), driven straight at 60, 90 and 130 km/h (the speed is held until
// the lip): air time, distance from the front edge to the touch-down,
// height, landing impact, and the validator's estimate beside it.
//
// Sweep (opt-in, about a minute): every track, class and bot level with
// seeds 1-4 (360 races): DNF, resets, missed gates, total time, flights off
// the terrain and how far the bots got off the racing line.
//
//   npx tsx scripts/sim-airtime.ts --only roads,ramps   # sections: synthetic, crests, roads, ramps, bots, sweep
//   npx tsx scripts/sim-airtime.ts --tune GRAVITY=16    # other tuning values for the sim
//   npx tsx scripts/sim-airtime.ts --terrain old.bhf    # another bake of the same roads

import { heightAt } from '../src/shared/map/heightfield.js';
import { createMapData } from '../src/shared/map/mapData.js';
import { roadChains, type RoadChain, type RoadNetwork } from '../src/shared/map/roadNetwork.js';
import { routeToTrack } from '../src/shared/map/routeToTrack.js';
import { pointAt } from '../src/shared/map/spline.js';
import { createRaceWorld } from '../src/shared/race/raceWorld.js';
import type { TrackDef } from '../src/shared/race/types.js';
import { SIM_TUNING } from '../src/shared/sim/constants.js';
import { spawnCar } from '../src/shared/sim/scenarios.js';
import type { SimCar } from '../src/shared/sim/types.js';
import { stepVehicle } from '../src/shared/sim/world.js';
import { CAR_CLASS_IDS } from '../src/shared/sim/vehicleClasses.js';
import { createSimWorld, type GroundModel, type RampDef, type SimWorld } from '../src/shared/world/colliders.js';
import { driveTrack } from '../tools/map/driveTrack.js';
import { loadMapBundle } from '../tools/map/mapBundle.js';
import { rampFlight, rampLip, validateMap } from '../tools/map/validateMap.js';

const SPEEDS = [25, 40, 55];
const series = process.argv.includes('--series');
const onlyArg = process.argv.indexOf('--only');
const sections = new Set(onlyArg >= 0 ? process.argv[onlyArg + 1].split(',') : ['synthetic', 'crests', 'roads', 'ramps', 'bots']);
const KMH = 3.6;
// --tune GRAVITY=16,SUSP_FREQ=1.8: try other tuning values (the sim's
// only; the validator's estimate keeps the shipped defaults)
const tuneArg = process.argv.indexOf('--tune');
if (tuneArg >= 0) {
    for (const pair of process.argv[tuneArg + 1].split(',')) {
        const [key, value] = pair.split('=');
        if (!(key in SIM_TUNING)) throw new Error(`unknown tuning value ${key}`);
        (SIM_TUNING as Record<string, number>)[key] = Number(value);
    }
}

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
    // Moving with the ground from the start: on a grade a body spawned with
    // vy = 0 would hop once while its suspension catches up
    car.state.vy = (world.groundHeight(x0 + dx, z0 + dz) - world.groundHeight(x0 - dx, z0 - dz)) / 2 * speed;
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
if (sections.has('synthetic')) {
    for (const v of SPEEDS) results.push(run('bump 1.5 m / 12 m', bump, 0, -60, 0, 1, v, 60 + BUMP_L + Math.max(80, v * 3)));
    for (const v of SPEEDS) results.push(run('crest R 150 m', crest, 0, -60, 0, 1, v, 60 + Math.max(120, v * 3)));
}

// --terrain <file.bhf>: another bake of the same road network (e.g. the
// previous one) instead of public/maps/bulli-bay/terrain.bhf
const terrainArg = process.argv.indexOf('--terrain');
const bundle = loadMapBundle('bulli-bay', terrainArg >= 0 ? process.argv[terrainArg + 1] : undefined);
const map = createMapData(bundle, bundle.hf);
const validation = validateMap(bundle);
const mapWorld = map.simWorld;

// ---- The most convex crests of the race tracks ----

if (sections.has('crests')) {
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
    for (const c of picked) {
        const label = `${c.track} (${c.x.toFixed(0)}, ${c.z.toFixed(0)}) κ ${c.kappa.toFixed(4)}/m`;
        for (const v of SPEEDS) results.push(run(label, mapWorld, c.x - c.tx * 40, c.z - c.tz * 40, c.tx, c.tz, v, 40 + Math.max(60, v * 2)));
    }
    for (const v of SPEEDS) {
        const label = `kink ${kink.track} (${kink.x.toFixed(0)}, ${kink.z.toFixed(0)}) κ ${kink.kappa.toFixed(3)}/m over 4 m`;
        results.push(run(label, mapWorld, kink.x - kink.tx * 25, kink.z - kink.tz * 25, kink.tx, kink.tz, v, 50));
    }
}

if (results.length) {
    console.log('\n| Scenario | v (m/s) | air (s) | max height over ground (m) | max vy (m/s) | landing impact (m/s) |');
    console.log('| --- | ---: | ---: | ---: | ---: | ---: |');
    for (const r of results) {
        console.log(`| ${r.label} | ${r.speed} | ${r.air.toFixed(2)} | ${r.maxGap.toFixed(2)} | ${r.maxVy.toFixed(1)} | ${r.impact.toFixed(1)} |`);
    }
}

// ---- Every road at 60-200 km/h along its centre line ----

// A road (chain of edges through joints) as a path: position, tangent and
// edge at chain station S, walked forwards or backwards
interface RoadPath { length: number; at(S: number): { x: number; z: number; tx: number; tz: number; edge: string; s: number } }
function roadPath(net: RoadNetwork, chain: RoadChain, backwards: boolean): RoadPath {
    const parts = chain.parts.map(p => ({ edge: net.edges[p.edge], reversed: p.reversed }));
    const starts: number[] = [];
    let sum = 0;
    for (const p of parts) { starts.push(sum); sum += p.edge.length; }
    const length = sum;
    return {
        length,
        at(S: number) {
            const along = backwards ? length - S : S;
            let i = parts.length - 1;
            while (i > 0 && starts[i] > along) i--;
            const { edge, reversed } = parts[i];
            const local = Math.max(0, Math.min(edge.length, along - starts[i]));
            const s = reversed ? edge.length - local : local;
            const p = pointAt(edge.samples, s);
            const dir = (reversed ? -1 : 1) * (backwards ? -1 : 1);
            return { x: p.x, z: p.z, tx: p.tx * dir, tz: p.tz * dir, edge: edge.id, s };
        }
    };
}

interface RoadFlight { road: string; edge: string; s: number; x: number; z: number; kmh: number; air: number; height: number; impact: number }

// Drives the path at a constant speed, following the centre line; after
// the path's end a flight in progress goes on straight
function driveRoad(world: SimWorld, path: RoadPath, road: string, kmh: number): RoadFlight[] {
    const v = kmh / KMH;
    const start = path.at(0);
    const car = spawnCar(world, 'a', 'bulli', start.x, start.z, Math.atan2(start.tx, start.tz), v);
    const s = car.state;
    s.vy = (world.groundHeight(start.x + start.tx, start.z + start.tz) - world.groundHeight(start.x - start.tx, start.z - start.tz)) / 2 * v;
    const flights: RoadFlight[] = [];
    let S = 0, air = 0, height = 0, takeoff: RoadFlight | null = null;
    const ticks = Math.ceil(path.length / v * 60);
    for (let t = 0; t < ticks + 180; t++) {
        if (t >= ticks && air === 0) break;
        if (s.grounded || t < ticks) {
            const p = path.at(S);
            s.x = p.x;
            s.z = p.z;
            s.vx = p.tx * v;
            s.vz = p.tz * v;
            s.yaw = Math.atan2(p.tx, p.tz);
            s.yawRate = 0;
        }
        car.input.throttle = 0;
        const before = path.at(S);
        stepVehicle(car, world);
        S += v / 60;
        if (!s.grounded) {
            if (air === 0) takeoff = { road, edge: before.edge, s: before.s, x: before.x, z: before.z, kmh, air: 0, height: 0, impact: 0 };
            air++;
            height = Math.max(height, s.y - world.groundHeight(s.x, s.z));
        } else if (air > 0) {
            if (air >= 3 && takeoff) flights.push({ ...takeoff, air: air / 60, height, impact: car.events.landedImpact });
            air = 0;
            height = 0;
        }
    }
    return flights;
}

const ROAD_SPEEDS = [60, 100, 130, 160, 200];
if (sections.has('roads')) {
    const chains = roadChains(bundle.net);
    const all: RoadFlight[] = [];
    for (const chain of chains) {
        const first = bundle.net.edges[chain.parts[0].edge].id, last = bundle.net.edges[chain.parts[chain.parts.length - 1].edge].id;
        const name = chain.parts.length > 1 ? `${first}…${last}` : first;
        for (const backwards of [false, true]) {
            const path = roadPath(bundle.net, chain, backwards);
            for (const kmh of ROAD_SPEEDS) all.push(...driveRoad(mapWorld, path, `${name}${backwards ? ' ←' : ''}`, kmh));
        }
    }
    const length = chains.reduce((sum, c) => sum + c.length, 0);
    console.log(`\nRoads: ${chains.length} roads, ${(length / 1000).toFixed(2)} km, both directions, Bulli, speed held on the centre line; flights of >= 3 ticks`);
    console.log('\n| km/h | take-offs | >= 0.1 s | >= 0.3 s | longest (s) | highest (m) | total air (s) |');
    console.log('| ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const kmh of ROAD_SPEEDS) {
        const f = all.filter(r => r.kmh === kmh);
        const longest = f.reduce((m, r) => Math.max(m, r.air), 0), highest = f.reduce((m, r) => Math.max(m, r.height), 0);
        console.log(`| ${kmh} | ${f.length} | ${f.filter(r => r.air >= 0.1).length} | ${f.filter(r => r.air >= 0.3).length} | ${longest.toFixed(2)} | ${highest.toFixed(2)} | ${f.reduce((m, r) => m + r.air, 0).toFixed(1)} |`);
    }
    // Take-off spots: flights within 12 m of each other on the same road
    // and direction are one spot; air time and height per speed
    interface Spot { road: string; edge: string; s: number; x: number; z: number; by: Map<number, RoadFlight> }
    const spots: Spot[] = [];
    for (const f of all) {
        let spot = spots.find(p => p.road === f.road && Math.hypot(p.x - f.x, p.z - f.z) < 12);
        if (!spot) { spot = { road: f.road, edge: f.edge, s: f.s, x: f.x, z: f.z, by: new Map() }; spots.push(spot); }
        const prev = spot.by.get(f.kmh);
        if (!prev || prev.air < f.air) spot.by.set(f.kmh, f);
    }
    spots.sort((a, b) => a.x - b.x || a.z - b.z);
    console.log('\n| Road (← backwards) | edge, s | x, z | ' + ROAD_SPEEDS.map(k => `${k} km/h air s / m`).join(' | ') + ' |');
    console.log('| --- | --- | --- | ' + ROAD_SPEEDS.map(() => '---:').join(' | ') + ' |');
    for (const spot of spots) {
        if ([...spot.by.values()].every(f => f.air < 0.1)) continue;
        const cells = ROAD_SPEEDS.map(k => { const f = spot.by.get(k); return f ? `${f.air.toFixed(2)} / ${f.height.toFixed(2)}` : '–'; });
        console.log(`| ${spot.road} | ${spot.edge} ${spot.s.toFixed(0)} | ${spot.x.toFixed(0)}, ${spot.z.toFixed(0)} | ${cells.join(' | ')} |`);
    }
    console.log(`(${spots.filter(p => [...p.by.values()].every(f => f.air < 0.1)).length} more spots with hops under 0.1 s only)`);
}

// ---- Every ramp of the map and of the tracks ----

// Straight at the ramp from 40 m behind its centre; the speed is held while
// on the ground before the lip, then the car flies on its own
function driveRamp(world: SimWorld, ramp: RampDef, kmh: number): { air: number; distance: number; height: number; impact: number } {
    const v = kmh / KMH;
    const fx = Math.sin(ramp.yaw), fz = Math.cos(ramp.yaw);
    const car = spawnCar(world, 'a', 'bulli', ramp.x - fx * 40, ramp.z - fz * 40, ramp.yaw, v);
    const s = car.state;
    const front = ramp.length / 2;
    let air = 0, height = 0, impact = 0, distance = 0, flown = false;
    for (let t = 0; t < 600; t++) {
        const along = (s.x - ramp.x) * fx + (s.z - ramp.z) * fz;
        if (!flown && s.grounded && along < front) {
            s.vx = fx * v;
            s.vz = fz * v;
            s.yaw = ramp.yaw;
            s.yawRate = 0;
        }
        car.input.throttle = 0;
        stepVehicle(car, world);
        // Only a flight off the ramp counts (hops on the run-up do not)
        if (!s.grounded && (air > 0 || along >= -front)) {
            air++;
            height = Math.max(height, s.y - world.groundHeight(s.x, s.z));
        } else if (air > 0) {
            // The flight over the lip: it lands beyond the front edge (a hop
            // onto the ramp itself does not count)
            distance = (s.x - ramp.x) * fx + (s.z - ramp.z) * fz - front;
            if (air >= 3 && distance > 0) {
                flown = true;
                impact = car.events.landedImpact;
                break;
            }
            air = 0;
            height = 0;
        }
    }
    return { air: air / 60, distance, height, impact };
}

const RAMP_SPEEDS = [60, 90, 130];
if (sections.has('ramps')) {
    const rows: { label: string; world: SimWorld; ramp: RampDef }[] = [];
    map.ramps.forEach((ramp, i) => rows.push({ label: `map ${ramp.id}`, world: mapWorld, ramp: map.simWorld.ramps[i] }));
    for (const route of validation.routes) {
        const track = routeToTrack(bundle.net, route, bundle.map.mapVersion) as unknown as TrackDef;
        const world = createRaceWorld(map, track);
        track.ramps.forEach((ramp, i) => rows.push({ label: `${route.track.id} ramp ${i + 1}`, world, ramp }));
    }
    console.log('\nRamps: straight at each ramp, Bulli, speed held to the lip. Sim: air s / distance from the front edge to touch-down m / height m / impact m/s; estimate: rampFlight (validator) over level ground');
    console.log('\n| Ramp | length × height, lip | ' + RAMP_SPEEDS.map(k => `${k} km/h sim`).join(' | ') + ' | ' + RAMP_SPEEDS.map(k => `${k} km/h estimate`).join(' | ') + ' |');
    console.log('| --- | --- | ' + RAMP_SPEEDS.map(() => '---:').join(' | ') + ' | ' + RAMP_SPEEDS.map(() => '---:').join(' | ') + ' |');
    for (const { label, world, ramp } of rows) {
        const lip = rampLip(bundle.hf, ramp);
        const sim = RAMP_SPEEDS.map(k => { const r = driveRamp(world, ramp, k); return `${r.air.toFixed(2)} / ${r.distance.toFixed(1)} / ${r.height.toFixed(2)} / ${r.impact.toFixed(1)}`; });
        const est = RAMP_SPEEDS.map(k => { const f = rampFlight(ramp, lip, k / KMH); return `${f.time.toFixed(2)} / ${f.distance.toFixed(1)}`; });
        console.log(`| ${label} | ${ramp.length} × ${ramp.height}, ${lip.toFixed(2)} | ${sim.join(' | ')} | ${est.join(' | ')} |`);
    }
}

// ---- Bots on every track: flights off ramps and off the terrain ----

if (sections.has('bots')) {
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
}

// ---- All bots: 6 tracks × 5 classes × 3 levels × 4 seeds ----

if (sections.has('sweep')) {
    let races = 0, dnf = 0, resets = 0, missed = 0, total = 0, flights = 0, longest = 0, wide = 0;
    const notes: string[] = [];
    for (const route of validation.routes) {
        const track = routeToTrack(bundle.net, route, bundle.map.mapVersion);
        for (const classId of CAR_CLASS_IDS) {
            for (const level of ['easy', 'medium', 'hard'] as const) {
                for (let seed = 1; seed <= 4; seed++) {
                    const r = driveTrack(map, track, classId, level, seed);
                    races++;
                    if (r.time === null) dnf++; else total += r.time;
                    resets += r.resets;
                    missed += r.missedGates;
                    const terrain = r.flights.filter(f => f.ramp < 0);
                    flights += terrain.length;
                    for (const f of terrain) longest = Math.max(longest, f.ticks / 60);
                    if (r.maxLineDistance >= 8) wide++;
                    if (r.time === null || r.resets || r.missedGates) notes.push(`${route.track.id} ${classId} ${level} ${seed}: ${r.time?.toFixed(1) ?? 'DNF'} s, ${r.resets} resets, ${r.missedGates} missed, ${r.maxLineDistance.toFixed(1)} m off`);
                }
            }
        }
    }
    console.log(`\nSweep: ${races} races, ${dnf} DNF, ${resets} resets, ${missed} missed gates, total ${total.toFixed(0)} s, ${flights} terrain flights (longest ${longest.toFixed(2)} s), ${wide} races >= 8 m off the line`);
    for (const note of notes) console.log(`  ${note}`);
}
