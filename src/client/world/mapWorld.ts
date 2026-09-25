import * as THREE from 'three';
import type { Vec2 } from '../../shared/map/geometry.js';
import { heightAt } from '../../shared/map/heightfield.js';
import type { MapData } from '../../shared/map/mapData.js';
import { PLANT_COLLIDERS } from '../../shared/map/plants.js';
import type { FurnitureKind } from '../../shared/map/furniture.js';
import { areaRailLine, railLine } from '../../shared/map/rails.js';
import type { RailKind } from '../../shared/map/roadSchema.js';
import { leftNormal, pointAt } from '../../shared/map/spline.js';
import type { RoomKind } from '../../shared/protocol.js';
import type { RenderTier } from '../effects/renderQuality.js';
import { Batch, rgb } from './batch.js';
import { ChunkedInstances, ChunkView, type InstanceSpec } from './chunkedInstances.js';
import { markColliderAt } from './colliderTags.js';
import { buildFountain } from './fountain.js';
import { furnitureGeometry } from './streetFurniture.js';
import { FINISH, PropBatch, type Finish } from './furniture.js';
import { mergeKit, pieceGeometry, type KitCatalog, type KitInstance } from './kit.js';
import { cellDistance, cellKey, cellLod, CELL_SIZES, occupiedCells, selectCells, type CellLevel, type CellRef } from './kitCells.js';
import type { WorldMaterials } from './materials.js';
import { createPalms, type PalmSpot } from './palms.js';
import { alongPolyline, polylineLength, postsAlong, railPieces } from './railings.js';
import { crestSpots } from './viewpoint.js';
import { createRoads } from './roads.js';
import { scatterDecor, type DecorSpot } from './scatter.js';
import { createSea } from './sea.js';
import { createTerrainMaterial, createTerrainTextures, TerrainField } from './terrain.js';
import { shrubGeometry, treeCardGeometry, treeCardInstances, type TreeSpot } from './vegetation.js';
import { WORLD_QUALITY, type WorldQuality } from './worldQuality.js';

// The world of a curated map as the client draws it (docs/phase-3-design.md
// 9, 10, 11; M4): the terrain rings, the sea, the roads, the kit's
// buildings, landmarks, containers and pier merged per cell and LOD, the
// plants with colliders where the sim has them, the client's own scatter,
// guard rails, barriers, fences and railings, the plaza's fountain. Built
// once per page; update() runs every frame before rendering.
//
// Look and collision agree: every prop that stands on a collider is drawn
// at that collider's position (colliderTags.ts, tests/client/mapScene.test.ts).

const GUARDRAIL = { piece: 'guardrail_segment', length: 3.81 };
const JERSEY = { piece: 'arena_jersey', length: 3.81 };
const PIER_SEGMENT = 10;
// Rock pieces of the plants with a rock collider
const ROCK_PIECES = { boulder: 'rock_boulder_l', rock: 'rock_boulder_m' } as const;
// Fences: posts every 3 m, 2.4 m high chain-link panels
const FENCE_POST_SPACING = 3;
const FENCE_HEIGHT = 2.4;
// Wooden railings: posts every 2 m, 1.05 m
const RAIL_POST_SPACING = 2;
const RAIL_HEIGHT = 1.05;
// The lookout's coin telescopes: painted steel, dark lenses
const TELESCOPE: Finish = { color: rgb(0x2f5d45), rough: 0.42, metal: 0.25 };
const LENS: Finish = { color: rgb(0x141617), rough: 0.2 };

interface CellMesh {
    ref: CellRef;
    mesh: THREE.Mesh | null;
    lastUsed: number;
}

// The chain-link panels: a diamond mesh of wire cut out in the shader
function fenceMaterial(tier: RenderTier): THREE.Material {
    const material = tier === 'software'
        ? new THREE.MeshLambertMaterial({ color: 0x9a9e9b, side: THREE.DoubleSide, transparent: true, opacity: 0.35, depthWrite: false })
        : new THREE.MeshStandardMaterial({ color: 0x9a9e9b, roughness: 0.45, metalness: 0.8, side: THREE.DoubleSide, alphaTest: 0.5 });
    if (tier === 'software') return material;
    material.onBeforeCompile = shader => {
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec2 vFence;')
            .replace('#include <uv_vertex>', '#include <uv_vertex>\nvFence = uv;');
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nvarying vec2 vFence;')
            .replace('#include <alphatest_fragment>', /* glsl */`
	{
		// 5 cm diamonds of 3 mm wire; far away the wire blends into a veil
		vec2 q = vec2( vFence.x + vFence.y, vFence.x - vFence.y ) / 0.07;
		vec2 fw = fwidth( q );
		vec2 d = abs( fract( q ) - 0.5 );
		float wire = max( 1.0 - smoothstep( 0.04, 0.04 + fw.x, 0.5 - d.x ), 1.0 - smoothstep( 0.04, 0.04 + fw.y, 0.5 - d.y ) );
		float far = smoothstep( 0.3, 0.8, max( fw.x, fw.y ) );
		float alpha = mix( wire, 0.22, far );
		if ( alpha < 0.5 && ( far < 0.5 || fract( dot( gl_FragCoord.xy, vec2( 0.5, 0.25 ) ) ) > alpha ) ) discard;
	}`);
    };
    material.customProgramCacheKey = () => 'bulli-fence';
    return material;
}

// A sunshade: pole and a canopy of eight panels in two colours
function sunshadeGeometry(canopy: number, stripe: number): THREE.BufferGeometry {
    const batch = new PropBatch('sunshade');
    batch.add(new THREE.CylinderGeometry(0.025, 0.025, 2.3, 6).translate(0, 1.15, 0), FINISH.canvasPole);
    const cloth = new THREE.ConeGeometry(1.2, 0.45, 8, 1, true).translate(0, 2.2, 0);
    const colors = new Float32Array(cloth.attributes.position.count * 3);
    const a = new THREE.Color(canopy), b = new THREE.Color(stripe);
    for (let i = 0; i < cloth.attributes.position.count; i++) {
        const angle = Math.atan2(cloth.attributes.position.getZ(i), cloth.attributes.position.getX(i));
        const c = Math.floor(((angle / (Math.PI * 2)) + 1) * 8 + 0.5) % 2 ? a : b;
        c.toArray(colors, i * 3);
    }
    cloth.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    batch.add(cloth, { color: [1, 1, 1], rough: 0.85 });
    return batch.build()!;
}

export class MapWorld {
    readonly group = new THREE.Group();
    readonly terrain: TerrainField;
    private readonly view = new ChunkView(-25, 220);
    private readonly instanced: ChunkedInstances[] = [];
    private readonly partyOnly: THREE.Object3D[] = [];
    private kit: KitCatalog | null = null;
    private readonly kitGroup = new THREE.Group();
    private readonly kitInstances: KitInstance[];
    private readonly cells = new Map<string, CellMesh>();
    private readonly occupied: Set<string>;
    private previousCells = new Set<string>();
    private frame = 0;
    quality: WorldQuality;
    // Scatter spots (e2e hook, tests)
    readonly decor: DecorSpot[];

    constructor(readonly map: MapData, readonly tier: RenderTier, readonly M: WorldMaterials, quality: WorldQuality, renderer: THREE.WebGLRenderer | null) {
        this.quality = quality;
        this.group.name = 'map';
        const hf = map.hf;
        const ground = (x: number, z: number) => heightAt(hf, x, z);

        this.terrain = new TerrainField(hf, quality.terrain, createTerrainMaterial(tier, hf, createTerrainTextures(hf, tier)));
        this.group.add(this.terrain.group);
        this.group.add(createSea(hf, tier));
        this.group.add(createRoads(map.net, ground, tier));

        this.kitGroup.name = 'kit';
        this.group.add(this.kitGroup);
        this.kitInstances = this.buildKitInstances();
        this.occupied = occupiedCells(this.kitInstances);
        for (const lot of map.buildings) markColliderAt('building', lot.x, lot.z);
        for (const structure of map.structures) markColliderAt(structure.kind === 'container' ? 'container' : 'landmark', structure.x, structure.z);

        const plants = new THREE.Group();
        plants.name = 'plants';
        this.group.add(plants);
        this.addTrees(plants);
        plants.add(createPalms(M, this.palmSpots(), tier, renderer));
        this.decor = scatterDecor(map, quality.scatter);
        this.addScatter(plants);

        const props = new THREE.Group();
        props.name = 'props';
        this.group.add(props);
        this.addFences(props);
        this.addRailings(props);
        this.addFountain(props);
        this.addFurniture(props);
    }

    // ---- The kit ----

    // Buildings, landmarks, containers and the pier: pieces merged per cell
    private buildKitInstances(): KitInstance[] {
        const hf = this.map.hf;
        const at = (piece: string, x: number, z: number, ux: number, uz: number, y = heightAt(hf, x, z)): KitInstance => ({ piece, x, y, z, ux, uz });
        const out: KitInstance[] = [];
        for (const lot of this.map.buildings) out.push(at(lot.piece, lot.x, lot.z, lot.ux, lot.uz));
        for (const s of this.map.structures) out.push(at(s.piece, s.x, s.z, s.ux, s.uz));
        out.push(...this.pierInstances());
        return out;
    }

    // The pier's deck: kit segments from the land end out to the sea, a
    // lamp segment every third, the end piece last
    private pierInstances(): KitInstance[] {
        const out: KitInstance[] = [];
        for (const area of this.map.net.areas) {
            if (area.surface !== 'wood' || area.y === undefined) continue;
            const p = area.polygon;
            // Longest side gives the direction; the short sides' midpoints the ends
            let best = 0, bestLength = 0;
            for (let i = 0; i < p.length; i++) {
                const q = p[(i + 1) % p.length];
                const l = Math.hypot(q[0] - p[i][0], q[1] - p[i][1]);
                if (l > bestLength) { bestLength = l; best = i; }
            }
            if (p.length !== 4) continue;
            const a = p[best], b = p[(best + 1) % 4], c = p[(best + 2) % 4], d = p[(best + 3) % 4];
            let start: Vec2 = [(d[0] + a[0]) / 2, (d[1] + a[1]) / 2], end: Vec2 = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2];
            const connect = this.map.net.nodeById.get(area.connects[0] ?? '');
            if (connect && Math.hypot(end[0] - connect.x, end[1] - connect.z) < Math.hypot(start[0] - connect.x, start[1] - connect.z)) [start, end] = [end, start];
            const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
            const dx = (end[0] - start[0]) / length, dz = (end[1] - start[1]) / length;
            // Whole segments over the deck's length (the last may reach a metre past it)
            const count = Math.round(length / PIER_SEGMENT);
            for (let k = 0; k < count; k++) {
                const piece = k === count - 1 ? 'pier_end' : k % 3 === 1 ? 'pier_segment_lamp' : 'pier_segment';
                // Local +x along the pier: the local z axis is (-dz, dx)
                out.push({ piece, x: start[0] + dx * PIER_SEGMENT * k, y: area.y, z: start[1] + dz * PIER_SEGMENT * k, ux: -dz, uz: dx });
            }
        }
        return out;
    }

    hasKit(): boolean {
        return this.kit !== null;
    }

    /** The kit has loaded: merge its cells and add the instanced kit props. */
    attachKit(kit: KitCatalog): void {
        if (this.kit) return;
        this.kit = kit;
        // The far LOD of every chunk right away; nearer cells when needed
        for (const key of this.occupied) {
            if (!key.startsWith('0:')) continue;
            const [, i, j] = key.split(':').map(Number);
            this.ensureCell({ level: 0, i, j });
        }
        this.addKitProps();
    }

    private cellMembers(ref: CellRef): KitInstance[] {
        const size = CELL_SIZES[ref.level];
        const minX = -1000 + ref.i * size, minZ = -1000 + ref.j * size;
        return this.kitInstances.filter(instance => instance.x >= minX && instance.x < minX + size && instance.z >= minZ && instance.z < minZ + size);
    }

    private ensureCell(ref: CellRef): CellMesh {
        const key = cellKey(ref.level, ref.i, ref.j);
        let cell = this.cells.get(key);
        if (cell) return cell;
        const geometry = this.kit ? mergeKit(this.kit, this.cellMembers(ref), cellLod(ref.level, this.quality.kit.nearLod)) : null;
        let mesh: THREE.Mesh | null = null;
        if (geometry && this.kit) {
            mesh = new THREE.Mesh(geometry, this.kit.material);
            mesh.name = `kit-${key}`;
            mesh.castShadow = false;
            mesh.receiveShadow = true;
            mesh.matrixAutoUpdate = false;
            mesh.visible = false;
            this.kitGroup.add(mesh);
        }
        cell = { ref, mesh, lastUsed: this.frame };
        this.cells.set(key, cell);
        return cell;
    }

    private updateKit(x: number, z: number): void {
        if (!this.kit) return;
        const selected = selectCells(this.occupied, x, z, this.quality.kit, this.previousCells);
        const keys = new Set(selected.map(ref => cellKey(ref.level, ref.i, ref.j)));
        // Build at most a few missing cells per frame; a chunk with a cell
        // that is not built yet draws its far LOD meanwhile
        let budget = 3;
        const byChunk = new Map<string, CellRef[]>();
        for (const ref of selected) {
            const shift = ref.level;
            const chunk = cellKey(0, ref.i >> shift, ref.j >> shift);
            const list = byChunk.get(chunk);
            if (list) list.push(ref);
            else byChunk.set(chunk, [ref]);
        }
        const draw = new Set<CellMesh>();
        for (const [chunkKey, refs] of byChunk) {
            let ready = true;
            for (const ref of refs) {
                const key = cellKey(ref.level, ref.i, ref.j);
                if (!this.cells.has(key)) {
                    if (budget > 0) { budget--; this.ensureCell(ref); } else ready = false;
                }
            }
            if (ready) {
                for (const ref of refs) draw.add(this.cells.get(cellKey(ref.level, ref.i, ref.j))!);
            } else {
                draw.add(this.cells.get(chunkKey)!);
            }
        }
        // Cells cast shadows only near the camera: the shadow map covers
        // 45 to 60 m round the car, and a 15 m building's shadow at the 17°
        // sun is 50 m long (the far LOD2 chunks never do)
        const reach = this.quality.kit.shadowReach;
        for (const cell of this.cells.values()) {
            const on = draw.has(cell);
            if (cell.mesh) {
                cell.mesh.visible = on;
                cell.mesh.castShadow = on && cell.ref.level > 0 && cellDistance(x, z, cell.ref.level, cell.ref.i, cell.ref.j) < reach;
            }
            if (on) cell.lastUsed = this.frame;
        }
        // Forget near cells that have been far for a while (memory on phones)
        if (this.frame % 60 === 0) {
            for (const [key, cell] of this.cells) {
                if (cell.ref.level === 0 || this.frame - cell.lastUsed < 600) continue;
                const reach = cell.ref.level === 2 ? this.quality.kit.lod0 : this.quality.kit.lod1;
                if (cellDistance(x, z, cell.ref.level, cell.ref.i, cell.ref.j) < 2 * reach + 60) continue;
                if (cell.mesh) {
                    cell.mesh.geometry.dispose();
                    this.kitGroup.remove(cell.mesh);
                }
                this.cells.delete(key);
            }
        }
        this.previousCells = keys;
    }

    // Guard rails and barriers along the rail lines, and the rocks with a
    // collider, instanced from the kit
    private addKitProps(): void {
        const kit = this.kit!;
        const { net, hf } = this.map;
        const specs: Record<'wbeam' | 'concrete', InstanceSpec[]> = { wbeam: [], concrete: [] };
        const terminals: KitInstance[] = [];
        const x = new THREE.Vector3(), y = new THREE.Vector3(), zAxis = new THREE.Vector3();
        const place = (kind: 'wbeam' | 'concrete', line: Vec2[], toRoad: (x: number, z: number) => Vec2) => {
            const spec = kind === 'wbeam' ? GUARDRAIL : JERSEY;
            const pieces = railPieces(line, spec.length, toRoad);
            for (const piece of pieces) {
                const ay = heightAt(hf, piece.ax, piece.az), by = heightAt(hf, piece.bx, piece.bz);
                x.set(piece.bx - piece.ax, by - ay, piece.bz - piece.az).normalize();
                zAxis.set(-x.z, 0, x.x).normalize();
                y.crossVectors(zAxis, x);
                const matrix = new THREE.Matrix4().makeBasis(x.clone().multiplyScalar(piece.scale), y, zAxis).setPosition(piece.ax, ay, piece.az);
                specs[kind].push({ matrix });
            }
            if (kind === 'wbeam' && pieces.length) {
                const first = pieces[0], last = pieces[pieces.length - 1];
                const axis = (p: typeof first) => {
                    const l = Math.hypot(p.bx - p.ax, p.bz - p.az);
                    return { ux: -(p.bz - p.az) / l, uz: (p.bx - p.ax) / l };
                };
                // Terminals at the line's two ends, flared away from the road
                const start = axis(first), end = axis(last);
                terminals.push({ piece: 'guardrail_end_start', x: first.ax, y: heightAt(hf, first.ax, first.az), z: first.az, ...start });
                terminals.push({ piece: 'guardrail_end_finish', x: last.bx, y: heightAt(hf, last.bx, last.bz), z: last.bz, ...end });
            }
        };
        for (const edge of net.edges) {
            for (const rail of edge.def.rails ?? []) {
                if (rail.kind !== 'wbeam' && rail.kind !== 'concrete') continue;
                const line = railLine(edge, rail, net) as Vec2[];
                const side = rail.side === 'left' ? 1 : -1;
                place(rail.kind, line, (px, pz) => {
                    // Towards the road: against the rail's side of the edge
                    const s = nearestStation(edge.samples, px, pz);
                    const p = pointAt(edge.samples, s);
                    const [nx, nz] = leftNormal(p.tx, p.tz);
                    return [-nx * side, -nz * side];
                });
            }
        }
        for (const area of net.areas) {
            for (const rail of area.rails ?? []) {
                if (rail.kind !== 'wbeam' && rail.kind !== 'concrete') continue;
                let cx = 0, cz = 0;
                for (const [px, pz] of area.polygon) { cx += px; cz += pz; }
                cx /= area.polygon.length; cz /= area.polygon.length;
                place(rail.kind, areaRailLine(area, rail) as Vec2[], (px, pz) => [cx - px, cz - pz]);
            }
        }
        const lod = this.tier === 'desktop' ? 0 : 1;
        for (const kind of ['wbeam', 'concrete'] as const) {
            const geometry = pieceGeometry(kit, kind === 'wbeam' ? GUARDRAIL.piece : JERSEY.piece, lod);
            if (!geometry || !specs[kind].length) continue;
            const instances = new ChunkedInstances(geometry, kit.material, specs[kind], this.quality.sight.rails, `rails-${kind}`);
            instances.mesh.castShadow = true;
            instances.mesh.receiveShadow = true;
            this.instanced.push(instances);
            this.kitGroup.add(instances.mesh);
        }
        const ends = mergeKit(kit, terminals, lod);
        if (ends) {
            const mesh = new THREE.Mesh(ends, kit.material);
            mesh.name = 'rail-terminals';
            mesh.castShadow = mesh.receiveShadow = true;
            mesh.matrixAutoUpdate = false;
            this.kitGroup.add(mesh);
        }
        // Rocks: the kit's boulders, turned and sized per plant
        for (const [kind, piece] of Object.entries(ROCK_PIECES) as [keyof typeof ROCK_PIECES, string][]) {
            const rocks = this.map.plants.filter(plant => plant.kind === kind);
            const geometry = pieceGeometry(kit, piece, 1);
            if (!geometry || !rocks.length) continue;
            const q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
            const rockSpecs = rocks.map(rock => {
                q.setFromAxisAngle(up, (rock.seed % 360) * Math.PI / 180);
                s.setScalar(rock.size);
                // Sunk a little into the slope
                return { matrix: new THREE.Matrix4().compose(p.set(rock.x, heightAt(hf, rock.x, rock.z) - 0.25 * rock.size, rock.z), q, s) };
            });
            const instances = new ChunkedInstances(geometry, kit.material, rockSpecs, this.quality.sight.rocks, `rocks-${kind}`);
            instances.mesh.castShadow = true;
            instances.mesh.receiveShadow = true;
            this.instanced.push(instances);
            this.kitGroup.add(instances.mesh);
        }
    }

    // ---- Plants ----

    private palmSpots(): PalmSpot[] {
        const hf = this.map.hf;
        return this.map.plants.filter(plant => plant.kind === 'palm').map(plant => {
            markColliderAt('palm', plant.x, plant.z);
            return {
                // Fan palms along the streets and the beach, some date palms in the park and gardens
                kind: plant.seed % 4 === 0 ? 'date' : 'fan',
                x: plant.x, y: heightAt(hf, plant.x, plant.z), z: plant.z,
                scale: plant.size * (plant.seed % 4 === 0 ? 1.1 : 1),
                yaw: (plant.seed % 628) / 100
            } as PalmSpot;
        });
    }

    private addTrees(group: THREE.Group): void {
        const hf = this.map.hf;
        for (const [kind, seed] of [['oak', 11], ['cypress', 12]] as const) {
            const spots: TreeSpot[] = [];
            for (const plant of this.map.plants) {
                if (plant.kind !== kind) continue;
                markColliderAt('tree', plant.x, plant.z);
                spots.push({ x: plant.x, y: heightAt(hf, plant.x, plant.z), z: plant.z, scale: plant.size * (kind === 'oak' ? 1 : 0.95) });
            }
            if (!spots.length) continue;
            const instances = new ChunkedInstances(treeCardGeometry(kind), this.M.tree, treeCardInstances(kind, spots, seed), this.quality.sight.trees, `trees-${kind}`);
            instances.mesh.castShadow = true;
            // Crossed cards would shadow each other in hard halves (vegetation.ts)
            instances.mesh.receiveShadow = false;
            this.instanced.push(instances);
            group.add(instances.mesh);
        }
        for (const rock of this.map.plants) {
            if (rock.kind === 'boulder' || rock.kind === 'rock') markColliderAt('rock', rock.x, rock.z);
        }
    }

    private addScatter(group: THREE.Group): void {
        const sight = this.quality.sight.scatter;
        const byKind = (kind: DecorSpot['kind']) => this.decor.filter(spot => spot.kind === kind);
        // Chaparral: the bush cards of the tree atlas, low and wide
        const chaparral = byKind('chaparral').map(spot => ({ x: spot.x, y: spot.y + 0.3, z: spot.z, scale: spot.size }));
        if (chaparral.length) {
            const instances = new ChunkedInstances(treeCardGeometry('bush'), this.M.tree, treeCardInstances('bush', chaparral, 13), sight, 'scatter-chaparral');
            instances.mesh.receiveShadow = true;
            this.instanced.push(instances);
            group.add(instances.mesh);
        }
        const shrub = (kind: DecorSpot['kind'], card: 0 | 1, tint: (seed: number) => THREE.Color, heightScale = 0.9) => {
            const spots = byKind(kind);
            if (!spots.length) return;
            const q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
            const specs = spots.map(spot => {
                q.setFromAxisAngle(up, spot.seed * Math.PI * 2);
                s.set(spot.size, spot.size * heightScale, spot.size);
                return { matrix: new THREE.Matrix4().compose(p.set(spot.x, spot.y - 0.08, spot.z), q, s), color: tint(spot.seed) };
            });
            const instances = new ChunkedInstances(shrubGeometry(card), this.M.shrub, specs, sight, `scatter-${kind}`);
            instances.mesh.receiveShadow = true;
            this.instanced.push(instances);
            group.add(instances.mesh);
        };
        shrub('shrub', 1, seed => new THREE.Color().setRGB(0.8 + seed * 0.2, 0.85 + seed * 0.15, 0.75));
        shrub('flowers', 0, seed => new THREE.Color().setRGB(0.85 + seed * 0.15, 0.85 + seed * 0.1, 0.85));
        // Dune grass: the green card, low, bleached
        shrub('duneGrass', 1, seed => new THREE.Color().setRGB(1.05 + seed * 0.2, 1.0 + seed * 0.15, 0.62), 0.55);
        // Sunshades on the beach, merged (a few dozen)
        const shades = byKind('sunshade');
        if (shades.length) {
            const palette = [[0xd9483b, 0xf1e8d6], [0x2f6fa5, 0xf1e8d6], [0xe0b02f, 0xd9483b], [0x3d8c7a, 0xf1e8d6]];
            const batch = new Batch('sunshades');
            const variants = palette.map(([a, b]) => sunshadeGeometry(a, b));
            for (const spot of shades) {
                const matrix = new THREE.Matrix4().makeRotationY(spot.seed * 6.28)
                    .multiply(new THREE.Matrix4().makeRotationZ((spot.seed - 0.5) * 0.25))
                    .setPosition(spot.x, spot.y - 0.2, spot.z);
                batch.add(variants[Math.floor(spot.seed * palette.length) % palette.length], matrix);
            }
            const mesh = batch.mesh(this.M.furniture, { cast: true, receive: true });
            if (mesh) group.add(mesh);
        }
    }

    // ---- Fences, railings, the fountain ----

    private addFences(group: THREE.Group): void {
        const hf = this.map.hf;
        const build = (lines: readonly (readonly Vec2[])[], name: string) => {
            const frame = new PropBatch(`${name}-frame`);
            const panels = new Batch(`${name}-panels`);
            for (const line of lines) {
                // Posts and the top rail are 7 and 5 cm thin: four sides, no
                // caps (1.6 km of fence round the arena and the Party zone:
                // 555 posts, 822 rail pieces)
                for (const [px, pz] of postsAlong(line, FENCE_POST_SPACING)) {
                    const y = heightAt(hf, px, pz);
                    frame.add(new THREE.CylinderGeometry(0.035, 0.035, FENCE_HEIGHT + 0.1, 4, 1, true).translate(px, y + (FENCE_HEIGHT + 0.1) / 2, pz), FINISH.galvanized);
                }
                const total = polylineLength(line);
                const steps = Math.max(1, Math.ceil(total / 2));
                const positions: number[] = [], uvs: number[] = [], index: number[] = [];
                for (let k = 0; k <= steps; k++) {
                    const [px, pz] = alongPolyline(line, total * k / steps);
                    const y = heightAt(hf, px, pz);
                    positions.push(px, y + 0.03, pz, px, y + FENCE_HEIGHT, pz);
                    uvs.push(total * k / steps, 0, total * k / steps, FENCE_HEIGHT);
                    if (k > 0) {
                        const a = 2 * (k - 1);
                        index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
                    }
                    // Top rail
                    if (k > 0) {
                        const [qx, qz] = alongPolyline(line, total * (k - 1) / steps);
                        const qy = heightAt(hf, qx, qz);
                        const a = new THREE.Vector3(qx, qy + FENCE_HEIGHT, qz), b = new THREE.Vector3(px, y + FENCE_HEIGHT, pz);
                        const bar = barBetween(a, b, 0.025);
                        frame.add(bar, FINISH.galvanized);
                    }
                }
                const panel = new THREE.BufferGeometry();
                panel.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
                panel.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
                panel.setIndex(index);
                panel.computeVertexNormals();
                panels.add(panel);
            }
            const out = new THREE.Group();
            out.name = name;
            const frameMesh = frame.mesh(this.M.furniture, { cast: true, receive: true });
            const panelMesh = panels.mesh(fenceMaterial(this.tier), { cast: false, receive: true });
            if (frameMesh) out.add(frameMesh);
            if (panelMesh) out.add(panelMesh);
            return out;
        };
        const arena = this.map.fences.filter(fence => !fence.party).map(fence => fence.line);
        const party = this.map.fences.filter(fence => fence.party).map(fence => fence.line);
        if (arena.length) group.add(build(arena, 'fence-arena'));
        if (party.length) {
            const partyFence = build(party, 'fence-party');
            partyFence.visible = false;
            this.partyOnly.push(partyFence);
            group.add(partyFence);
        }
    }

    // Wooden railings (lookouts, beach lot, pier foot) and chain-link rails
    private addRailings(group: THREE.Group): void {
        const hf = this.map.hf;
        const { net } = this.map;
        const batch = new PropBatch('railings');
        const lines: { kind: RailKind; line: Vec2[] }[] = [];
        for (const edge of net.edges) {
            for (const rail of edge.def.rails ?? []) {
                if (rail.kind === 'wood' || rail.kind === 'fence') lines.push({ kind: rail.kind, line: railLine(edge, rail, net) as Vec2[] });
            }
        }
        for (const area of net.areas) {
            // The pier's deck brings its own railing
            if (area.surface === 'wood') continue;
            for (const rail of area.rails ?? []) {
                if (rail.kind === 'wood' || rail.kind === 'fence') lines.push({ kind: rail.kind, line: areaRailLine(area, rail) as Vec2[] });
            }
        }
        const up = new THREE.Vector3(0, 1, 0);
        for (const { line } of lines) {
            const posts = postsAlong(line, RAIL_POST_SPACING);
            posts.forEach(([px, pz], k) => {
                const y = heightAt(hf, px, pz);
                batch.box(0.12, RAIL_HEIGHT + 0.1, 0.12, px, y + (RAIL_HEIGHT + 0.1) / 2 - 0.1, pz, FINISH.wood);
                if (k === 0) return;
                const [qx, qz] = posts[k - 1];
                const qy = heightAt(hf, qx, qz);
                for (const h of [RAIL_HEIGHT - 0.06, RAIL_HEIGHT * 0.5]) {
                    const a = new THREE.Vector3(qx, qy + h, qz), b = new THREE.Vector3(px, y + h, pz);
                    const length = a.distanceTo(b);
                    const g = new THREE.BoxGeometry(length, 0.12, 0.07);
                    const matrix = new THREE.Matrix4().makeBasis(
                        b.clone().sub(a).normalize(), up, new THREE.Vector3().crossVectors(b.clone().sub(a).normalize(), up).normalize()
                    ).setPosition((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
                    g.applyMatrix4(matrix);
                    batch.add(g, FINISH.wood);
                }
            });
        }
        this.addTelescopes(batch);
        const mesh = batch.mesh(this.M.furniture, { cast: true, receive: true });
        if (mesh) group.add(mesh);
    }

    // The lookout's coin telescopes (design 3.3): two on the knoll between
    // its lot and the bay (the pier), where the view opens (viewpoint.ts,
    // A66); small props like the sunshades, without a collider
    private addTelescopes(batch: PropBatch): void {
        const { landmarks } = this.map.sources.pois;
        const pier = landmarks.find(landmark => landmark.kind === 'pier');
        const ground = (x: number, z: number) => heightAt(this.map.hf, x, z);
        for (const lookout of landmarks) {
            const area = lookout.kind === 'lookout' && lookout.area ? this.map.net.areas.find(a => a.id === lookout.area) : undefined;
            if (!area || !pier) continue;
            let cx = 0, cz = 0;
            for (const [px, pz] of area.polygon) { cx += px; cz += pz; }
            const from: Vec2 = [cx / area.polygon.length, cz / area.polygon.length];
            for (const spot of crestSpots(ground, from, [pier.x, pier.z], 20, 90, 2, 1.8)) {
                const matrix = new THREE.Matrix4().makeRotationY(spot.yaw).setPosition(spot.x, ground(spot.x, spot.z), spot.z);
                addTelescope(batch, matrix);
            }
        }
    }

    private addFountain(group: THREE.Group): void {
        const fountain = this.map.sources.pois.landmarks.find(landmark => landmark.kind === 'fountain');
        if (!fountain) return;
        const y = heightAt(this.map.hf, fountain.x, fountain.z);
        const stone = new Batch('fountain-stone');
        const water = buildFountain(stone, this.M, fountain.x, y, fountain.z, this.tier);
        const stoneMesh = stone.mesh(this.M.stucco, { cast: true, receive: true });
        if (stoneMesh) group.add(stoneMesh);
        for (const mesh of water) group.add(mesh);
        markColliderAt('fountain', fountain.x, fountain.z);
    }

    // Street lights, signals, hydrants, trash cans and benches at their
    // colliders (shared/map/furniture.ts): per kind the full model up close
    // (fewer segments on phones) and a few boxes beyond, each instanced;
    // only the poles cast shadows, up close (software WebGL: boxes only,
    // no shadows)
    private addFurniture(group: THREE.Group): void {
        const specs = new Map<FurnitureKind, InstanceSpec[]>();
        for (const piece of this.map.furniture) {
            markColliderAt('furniture', piece.x, piece.z);
            const matrix = new THREE.Matrix4().makeRotationY(Math.atan2(piece.ux, piece.uz))
                .setPosition(piece.x, heightAt(this.map.hf, piece.x, piece.z), piece.z);
            const list = specs.get(piece.kind);
            if (list) list.push({ matrix });
            else specs.set(piece.kind, [{ matrix }]);
        }
        const { furniture, furnitureNear } = this.quality.sight;
        for (const [kind, list] of specs) {
            const near = new ChunkedInstances(furnitureGeometry(kind, this.tier === 'desktop' ? 'high' : 'low'), this.M.furniture, list, furnitureNear, `furniture-${kind}`);
            near.mesh.castShadow = this.tier !== 'software' && (kind === 'lamp' || kind === 'signal');
            const far = new ChunkedInstances(furnitureGeometry(kind, 'far'), this.M.furniture, list, furniture, `furniture-${kind}-far`, furnitureNear);
            for (const instances of [near, far]) {
                instances.mesh.receiveShadow = true;
                this.instanced.push(instances);
                group.add(instances.mesh);
            }
        }
    }

    // ---- Per frame ----

    /** Re-centres the terrain, picks the kit cells and packs the instances for this camera. */
    update(camera: THREE.Camera): void {
        this.frame++;
        const { x, z } = camera.position;
        this.terrain.update(x, z);
        const key = this.view.update(camera);
        for (const instances of this.instanced) instances.update(this.view, key, x, z);
        this.updateKit(x, z);
    }

    /** The Party draws the fence round its zone. */
    setRoom(kind: RoomKind | null): void {
        for (const object of this.partyOnly) object.visible = kind === 'party';
    }

    /** Changes the detail level (distances and sights; the terrain keeps its rings). */
    setQuality(quality: WorldQuality): void {
        this.quality = quality;
        this.instanced.forEach(instances => {
            const name = instances.mesh.name;
            if (name.startsWith('furniture')) {
                const far = name.endsWith('-far');
                instances.sight = far ? quality.sight.furniture : quality.sight.furnitureNear;
                instances.from = far ? quality.sight.furnitureNear : 0;
                return;
            }
            instances.sight = name.startsWith('trees') ? quality.sight.trees : name.startsWith('scatter') ? quality.sight.scatter
                : name.startsWith('rocks') ? quality.sight.rocks : quality.sight.rails;
        });
    }

    stats(): { kitCells: number; kitBuilt: number; instances: Record<string, number>; terrainTriangles: number } {
        let visible = 0;
        for (const cell of this.cells.values()) if (cell.mesh?.visible) visible++;
        return {
            kitCells: visible,
            kitBuilt: this.cells.size,
            instances: Object.fromEntries(this.instanced.map(i => [i.mesh.name, i.mesh.count])),
            terrainTriangles: this.terrain.triangles()
        };
    }
}

// A coin telescope on its post, looking along +z (painted green, the
// lenses dark, the eyepieces at the back)
function addTelescope(batch: PropBatch, matrix: THREE.Matrix4): void {
    const part = (geometry: THREE.BufferGeometry, finish: Finish) => batch.add(geometry.applyMatrix4(matrix), finish);
    part(new THREE.CylinderGeometry(0.2, 0.24, 0.08, 10).translate(0, 0.04, 0), FINISH.concrete);
    part(new THREE.CylinderGeometry(0.055, 0.07, 1.05, 8).translate(0, 0.6, 0), TELESCOPE);
    part(new THREE.BoxGeometry(0.34, 0.12, 0.14).translate(0, 1.15, 0), TELESCOPE);
    // The housing, tilted a little down towards the view
    const housing = new THREE.Matrix4().makeRotationX(0.08).setPosition(0, 1.33, 0);
    part(new THREE.CylinderGeometry(0.15, 0.17, 0.46, 12).rotateX(Math.PI / 2).applyMatrix4(housing), TELESCOPE);
    part(new THREE.BoxGeometry(0.1, 0.1, 0.12).translate(0, 0.17, -0.05).applyMatrix4(housing), TELESCOPE);
    for (const x of [-0.07, 0.07]) {
        part(new THREE.CylinderGeometry(0.06, 0.06, 0.06, 10).rotateX(Math.PI / 2).translate(x, 0, 0.25).applyMatrix4(housing), LENS);
        part(new THREE.CylinderGeometry(0.035, 0.035, 0.08, 8).rotateX(Math.PI / 2).translate(x, 0.02, -0.27).applyMatrix4(housing), LENS);
    }
}

// A thin bar from a to b (four sides, open ends)
function barBetween(a: THREE.Vector3, b: THREE.Vector3, radius: number): THREE.BufferGeometry {
    const direction = b.clone().sub(a);
    const length = direction.length();
    const bar = new THREE.CylinderGeometry(radius, radius, length, 4, 1, true);
    bar.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()));
    return bar.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
}

// Station on the edge nearest to (x, z) (the samples are 1 m apart)
function nearestStation(samples: readonly { x: number; z: number; s: number }[], x: number, z: number): number {
    let best = 0, bestDistance = Infinity;
    for (const sample of samples) {
        const d = (sample.x - x) ** 2 + (sample.z - z) ** 2;
        if (d < bestDistance) { bestDistance = d; best = sample.s; }
    }
    return best;
}

export { WORLD_QUALITY };
