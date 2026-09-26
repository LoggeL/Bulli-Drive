import * as THREE from 'three';
import { createCourse } from '../../shared/race/progress.js';
import { CHEVRON_POST_TOP } from '../../shared/race/raceWorld.js';
import type { GateDef, TrackDef, TrackRamp } from '../../shared/race/types.js';
import { rampRearBase, type RampDef } from '../../shared/world/colliders.js';
import type { MapData } from '../../shared/map/mapData.js';
import { lightingTier } from '../render/lighting.js';
import { Batch, rgb } from '../world/batch.js';
import { groundHeight } from '../world/ground.js';
import { FINISH, PropBatch, type Finish } from '../world/furniture.js';
import { worldMaterials } from '../world/worldMaterials.js';
import type { GateLook } from './raceModel.js';
import { barrierPieces, chevronPosts, delineatorPosts, gateEnds, ribbonEdges } from './trackLayout.js';

// The look of a race track (docs/phase-2-design.md, 17.4, world-look.md):
// an aluminium truss portal over start and finish with a chequered banner
// and a start light of five lamps mirroring the countdown; checkpoints as
// two slim masts with a fabric banner ("CP 3") and an LED strip below it
// (the next gate glows warm white and pulses, gates passed are dim);
// red-white water barriers across the side streets, chevron boards on two
// posts, delineator posts, arrows and grid boxes on the road, and the
// track's ramps. The map's jump ramps are drawn once for every room
// (mapFeaturesGroup).
//
// Draw calls: every static piece of one material in one merged mesh
// (props through the street furniture material, the banners, boards and
// road paint through one atlas), the LED strips and the lamps as one
// InstancedMesh each; about 8 in all, plus the shadow pass for the props
// (budget +20).

const ATLAS_COLUMNS = 2;
const ATLAS_ROWS = 8;
const CELL_W = 512;
const CELL_H = 128;

// Atlas cells
const CELL_TITLE = 0;
const CELL_START = 1;
const CELL_FINISH = 2;
const CELL_CP = 3;              // CP 1 .. CP 8 in cells 3 .. 10
const CELL_CHECKER = 11;
const CELL_CHEVRON_LEFT = 12;
const CELL_CHEVRON_RIGHT = 13;
const CELL_ARROW = 14;
const CELL_WHITE = 15;

// Finishes of the props (the `surface` attribute of the furniture material)
const ALUMINIUM: Finish = { color: rgb(0xc4c8ca), rough: 0.32, metal: 0.9 };
const BARRIER_RED: Finish = { color: rgb(0xc3261d), rough: 0.5 };
const BARRIER_WHITE: Finish = { color: rgb(0xe6e2da), rough: 0.5 };
const BOARD_BACK: Finish = { color: rgb(0x2b2f31), rough: 0.6, metal: 0.3 };
const DELINEATOR: Finish = { color: rgb(0xf0eee8), rough: 0.5 };
const DELINEATOR_BAND: Finish = { color: rgb(0x121212), rough: 0.6 };
const REFLECTOR: Finish = { color: [1, 0.5, 0.08], rough: 0.2, emit: 1.6 };
const HOUSING: Finish = { color: rgb(0x1b1d1e), rough: 0.5, metal: 0.3 };
const STEEL_DECK: Finish = { color: rgb(0x8f9497), rough: 0.42, metal: 0.8 };
const HAZARD_YELLOW: Finish = { color: rgb(0xe0a526), rough: 0.5 };
const EARTH: Finish = { color: rgb(0x6d5236), rough: 0.97 };

const CHECKPOINT_TOP = 5.9;
const CHECKPOINT_BANNER = 1.0;
const PORTAL_HEIGHT = 7.2;
const TRUSS = 0.5;

// ---- Atlas ----

let atlasTexture: THREE.CanvasTexture | null = null;

function cellUv(cell: number): { u0: number; v0: number; u1: number; v1: number } {
    const col = cell % ATLAS_COLUMNS, row = Math.floor(cell / ATLAS_COLUMNS);
    return { u0: col / ATLAS_COLUMNS, u1: (col + 1) / ATLAS_COLUMNS, v1: 1 - row / ATLAS_ROWS, v0: 1 - (row + 1) / ATLAS_ROWS };
}

function drawBanner(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, chequered: boolean): void {
    const grad = ctx.createLinearGradient(0, y, 0, y + CELL_H);
    grad.addColorStop(0, '#1f3a4d');
    grad.addColorStop(1, '#16293a');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, CELL_W, CELL_H);
    if (chequered) {
        const s = 16;
        for (let row = 0; row < 2; row++) {
            for (let k = 0; k < CELL_W / s; k++) {
                ctx.fillStyle = (k + row) % 2 === 0 ? '#f4f1ea' : '#111111';
                ctx.fillRect(x + k * s, y + row * s, s, s);
                ctx.fillRect(x + k * s, y + CELL_H - (row + 1) * s, s, s);
            }
        }
    } else {
        ctx.fillStyle = '#f5a623';
        ctx.fillRect(x, y, CELL_W, 10);
        ctx.fillRect(x, y + CELL_H - 10, CELL_W, 10);
    }
    ctx.fillStyle = '#fff8e7';
    ctx.font = `900 ${chequered ? 52 : 64}px "Arial Black", "Helvetica Neue", Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + CELL_W / 2, y + CELL_H / 2 + 3, CELL_W - 40);
}

function drawChevron(ctx: CanvasRenderingContext2D, x: number, y: number, left: boolean): void {
    ctx.fillStyle = '#c3261d';
    ctx.fillRect(x, y, CELL_W, CELL_H);
    ctx.fillStyle = '#f7f4ee';
    for (let k = 0; k < 4; k++) {
        const cx = x + 90 + k * 110;
        const dir = left ? -1 : 1;
        ctx.beginPath();
        ctx.moveTo(cx - dir * 30, y + 14);
        ctx.lineTo(cx + dir * 20, y + CELL_H / 2);
        ctx.lineTo(cx - dir * 30, y + CELL_H - 14);
        ctx.lineTo(cx - dir * 5, y + CELL_H - 14);
        ctx.lineTo(cx + dir * 45, y + CELL_H / 2);
        ctx.lineTo(cx - dir * 5, y + 14);
        ctx.closePath();
        ctx.fill();
    }
}

function atlas(): THREE.Texture {
    if (atlasTexture) return atlasTexture;
    const canvas = document.createElement('canvas');
    canvas.width = CELL_W * ATLAS_COLUMNS;
    canvas.height = CELL_H * ATLAS_ROWS;
    const ctx = canvas.getContext('2d');
    if (ctx) {
        const at = (cell: number) => ({ x: (cell % ATLAS_COLUMNS) * CELL_W, y: Math.floor(cell / ATLAS_COLUMNS) * CELL_H });
        let p = at(CELL_TITLE);
        drawBanner(ctx, p.x, p.y, 'BULLI DRIVE', true);
        p = at(CELL_START);
        drawBanner(ctx, p.x, p.y, 'START', true);
        p = at(CELL_FINISH);
        drawBanner(ctx, p.x, p.y, 'FINISH', true);
        for (let k = 1; k <= 8; k++) {
            p = at(CELL_CP + k - 1);
            drawBanner(ctx, p.x, p.y, `CP ${k}`, false);
        }
        p = at(CELL_CHECKER);
        const s = CELL_H / 4;
        for (let row = 0; row < 4; row++) {
            for (let k = 0; k < CELL_W / s; k++) {
                ctx.fillStyle = (k + row) % 2 === 0 ? '#f2efe8' : '#161616';
                ctx.fillRect(p.x + k * s, p.y + row * s, s, s);
            }
        }
        p = at(CELL_CHEVRON_LEFT);
        drawChevron(ctx, p.x, p.y, true);
        p = at(CELL_CHEVRON_RIGHT);
        drawChevron(ctx, p.x, p.y, false);
        // Road arrow pointing up (+v): transparent around it
        p = at(CELL_ARROW);
        ctx.clearRect(p.x, p.y, CELL_W, CELL_H);
        ctx.fillStyle = '#f2efe8';
        ctx.beginPath();
        ctx.moveTo(p.x + CELL_W / 2, p.y + 6);
        ctx.lineTo(p.x + CELL_W / 2 + 60, p.y + 52);
        ctx.lineTo(p.x + CELL_W / 2 + 20, p.y + 52);
        ctx.lineTo(p.x + CELL_W / 2 + 20, p.y + CELL_H - 6);
        ctx.lineTo(p.x + CELL_W / 2 - 20, p.y + CELL_H - 6);
        ctx.lineTo(p.x + CELL_W / 2 - 20, p.y + 52);
        ctx.lineTo(p.x + CELL_W / 2 - 60, p.y + 52);
        ctx.closePath();
        ctx.fill();
        p = at(CELL_WHITE);
        ctx.fillStyle = '#f2efe8';
        ctx.fillRect(p.x, p.y, CELL_W, CELL_H);
    }
    atlasTexture = new THREE.CanvasTexture(canvas);
    atlasTexture.colorSpace = THREE.SRGBColorSpace;
    atlasTexture.anisotropy = 4;
    return atlasTexture;
}

// ---- Geometry helpers ----

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();

/** A round bar from a to b. */
function bar(batch: PropBatch, a: THREE.Vector3, b: THREE.Vector3, radius: number, finish: Finish, radial = 6): void {
    const length = a.distanceTo(b);
    if (length < 1e-4) return;
    const g = new THREE.CylinderGeometry(radius, radius, length, radial, 1, true);
    _q.setFromUnitVectors(_up, _b.subVectors(b, a).normalize());
    _m.compose(_a.addVectors(a, b).multiplyScalar(0.5), _q, _s.set(1, 1, 1));
    batch.add(g, finish, _m);
}

/** A box of w (along the left axis) x h x d (along yaw), its foot at (x, y, z). */
function boxAt(batch: PropBatch, w: number, h: number, d: number, x: number, y: number, z: number, yaw: number, finish: Finish): void {
    // Box x is the left axis for a yaw rotation (cos yaw, 0, -sin yaw)
    batch.add(new THREE.BoxGeometry(w, h, d), finish, new THREE.Matrix4().makeRotationY(yaw).setPosition(x, y + h / 2, z));
}

/** A quad facing `normal`, from its centre, the right-pointing axis (u) and up axis (v), mapped to an atlas cell. */
function atlasQuad(batch: Batch, center: THREE.Vector3, uAxis: THREE.Vector3, vAxis: THREE.Vector3, halfU: number, halfV: number, cell: number, flipU = false): void {
    const { u0, u1, v0, v1 } = cellUv(cell);
    const ua = flipU ? u1 : u0, ub = flipU ? u0 : u1;
    const corner = (su: number, sv: number) => center.clone().addScaledVector(uAxis, su * halfU).addScaledVector(vAxis, sv * halfV);
    const p = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p.flatMap(v => [v.x, v.y, v.z]), 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([ua, v0, ub, v0, ub, v1, ua, v1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.computeVertexNormals();
    batch.add(g);
}

/** A flat mark on the ground (road paint) along yaw, length along the heading. */
function groundMark(batch: Batch, x: number, z: number, yaw: number, width: number, length: number, cell: number, lift = 0.075): void {
    const y = groundHeight(x, z) + lift;
    // u runs to the right of the heading (-left), v along the heading
    const right = new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw));
    const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    atlasQuad(batch, new THREE.Vector3(x, y, z), right, forward, width / 2, length / 2, cell);
}

function groundAt(x: number, z: number): number {
    return groundHeight(x, z);
}

// ---- Gates ----

interface GateBuild {
    props: PropBatch;
    atlas: Batch;
    leds: { matrix: THREE.Matrix4; gate: number }[];
    lamps: THREE.Matrix4[];
}

function bannerCell(gate: GateDef, index: number): number {
    switch (gate.visual) {
        case 'startFinish': return CELL_TITLE;
        case 'start': return CELL_START;
        case 'finish': return CELL_FINISH;
        default: return CELL_CP + Math.min(7, Math.max(0, index - 1));
    }
}

/** A double-sided banner between two points, from yBottom to yTop, readable from both sides. */
function banner(build: GateBuild, left: THREE.Vector3, right: THREE.Vector3, yBottom: number, yTop: number, cell: number, forward: THREE.Vector3): void {
    const center = new THREE.Vector3((left.x + right.x) / 2, (yBottom + yTop) / 2, (left.z + right.z) / 2);
    const across = new THREE.Vector3(right.x - left.x, 0, right.z - left.z);
    const halfU = across.length() / 2;
    across.normalize();
    const up = new THREE.Vector3(0, 1, 0);
    // Front: seen by the approaching car (looking along forward), u to its right
    const front = center.clone().addScaledVector(forward, -0.02);
    const back = center.clone().addScaledVector(forward, 0.02);
    atlasQuad(build.atlas, front, across, up, halfU, (yTop - yBottom) / 2, cell);
    atlasQuad(build.atlas, back, across.clone().negate(), up, halfU, (yTop - yBottom) / 2, cell);
}

function led(build: GateBuild, gate: number, left: THREE.Vector3, right: THREE.Vector3, y: number, yaw: number): void {
    const width = Math.hypot(right.x - left.x, right.z - left.z);
    const matrix = new THREE.Matrix4().compose(
        new THREE.Vector3((left.x + right.x) / 2, y, (left.z + right.z) / 2),
        new THREE.Quaternion().setFromAxisAngle(_up, yaw),
        new THREE.Vector3(width, 0.1, 0.08)
    );
    build.leds.push({ matrix, gate });
}

function checkpoint(build: GateBuild, gate: GateDef, index: number): void {
    const { left, right } = gateEnds(gate, 0.4);
    const forward = new THREE.Vector3(Math.sin(gate.yaw), 0, Math.cos(gate.yaw));
    const yl = groundAt(left.x, left.z), yr = groundAt(right.x, right.z);
    const base = (yl + yr) / 2;
    for (const [p, y] of [[left, yl], [right, yr]] as const) {
        bar(build.props, new THREE.Vector3(p.x, y - 0.3, p.z), new THREE.Vector3(p.x, base + CHECKPOINT_TOP + 0.25, p.z), 0.085, FINISH.galvanized, 8);
        boxAt(build.props, 0.36, 0.14, 0.36, p.x, y - 0.04, p.z, gate.yaw, FINISH.concrete);
    }
    // The fabric hangs between two tensioning bars, inset from the masts
    const inset = (t: number) => new THREE.Vector3(left.x + (right.x - left.x) * t, 0, left.z + (right.z - left.z) * t);
    const width = Math.hypot(right.x - left.x, right.z - left.z);
    const k = 0.18 / width;
    const a = inset(k), b = inset(1 - k);
    const top = base + CHECKPOINT_TOP, bottom = top - CHECKPOINT_BANNER;
    bar(build.props, new THREE.Vector3(a.x, top + 0.04, a.z), new THREE.Vector3(b.x, top + 0.04, b.z), 0.035, FINISH.galvanized);
    bar(build.props, new THREE.Vector3(a.x, bottom - 0.02, a.z), new THREE.Vector3(b.x, bottom - 0.02, b.z), 0.035, FINISH.galvanized);
    banner(build, a, b, bottom, top, bannerCell(gate, index), forward);
    led(build, index, a, b, bottom - 0.12, gate.yaw);
}

/** A square truss member of 4 chords with zigzag lacing, from a to b. */
function truss(props: PropBatch, a: THREE.Vector3, b: THREE.Vector3, side: THREE.Vector3, size: number): void {
    const dir = new THREE.Vector3().subVectors(b, a);
    const length = dir.length();
    dir.normalize();
    const n1 = side.clone().normalize().multiplyScalar(size / 2);
    const n2 = new THREE.Vector3().crossVectors(dir, n1).normalize().multiplyScalar(size / 2);
    const corners = [n1.clone().add(n2), n1.clone().sub(n2), n1.clone().negate().sub(n2), n1.clone().negate().add(n2)];
    for (const c of corners) bar(props, a.clone().add(c), b.clone().add(c), 0.045, ALUMINIUM);
    const steps = Math.max(1, Math.round(length / size));
    for (let face = 0; face < 4; face++) {
        const c0 = corners[face], c1 = corners[(face + 1) % 4];
        for (let i = 0; i < steps; i++) {
            const p0 = a.clone().addScaledVector(dir, length * i / steps).add(i % 2 === 0 ? c0 : c1);
            const p1 = a.clone().addScaledVector(dir, length * (i + 1) / steps).add(i % 2 === 0 ? c1 : c0);
            bar(props, p0, p1, 0.022, ALUMINIUM, 4);
        }
    }
}

function portal(build: GateBuild, gate: GateDef, index: number, withLights: boolean): void {
    const { left, right } = gateEnds(gate, 0.9);
    const forward = new THREE.Vector3(Math.sin(gate.yaw), 0, Math.cos(gate.yaw));
    const across = new THREE.Vector3(right.x - left.x, 0, right.z - left.z).normalize();
    const yl = groundAt(left.x, left.z), yr = groundAt(right.x, right.z);
    const base = Math.max(yl, yr);
    const top = base + PORTAL_HEIGHT;
    // Two towers and the beam across their tops
    for (const [p, y] of [[left, yl], [right, yr]] as const) {
        truss(build.props, new THREE.Vector3(p.x, y - 0.2, p.z), new THREE.Vector3(p.x, top, p.z), forward, TRUSS);
        boxAt(build.props, 1.1, 0.2, 1.1, p.x, y - 0.1, p.z, gate.yaw, FINISH.concrete);
    }
    const beamY = top - TRUSS / 2;
    truss(build.props, new THREE.Vector3(left.x, beamY, left.z), new THREE.Vector3(right.x, beamY, right.z), forward, TRUSS);
    // Banner under the beam
    const inset = TRUSS / 2 + 0.25;
    const a = new THREE.Vector3(left.x, 0, left.z).addScaledVector(across, inset);
    const b = new THREE.Vector3(right.x, 0, right.z).addScaledVector(across, -inset);
    const bannerTop = top - TRUSS - 0.1, bannerBottom = bannerTop - 1.3;
    banner(build, a, b, bannerBottom, bannerTop, bannerCell(gate, index), forward);
    led(build, index, a, b, bannerBottom - 0.12, gate.yaw);
    // Chequered line on the road
    groundMark(build.atlas, gate.x, gate.z, gate.yaw, gate.width, 1.4, CELL_CHECKER);
    if (!withLights) return;
    // Start light: a housing under the banner with five lamps facing the grid
    const cy = bannerBottom - 0.75;
    const centerX = gate.x, centerZ = gate.z;
    boxAt(build.props, 2.7, 0.62, 0.34, centerX, cy - 0.31, centerZ, gate.yaw, HOUSING);
    bar(build.props, new THREE.Vector3(centerX, cy + 0.3, centerZ), new THREE.Vector3(centerX, bannerBottom, centerZ), 0.04, FINISH.galvanized);
    const facing = new THREE.Quaternion().setFromUnitVectors(_up, forward.clone().negate());
    for (let k = 0; k < 5; k++) {
        const offset = (k - 2) * 0.5;
        const position = new THREE.Vector3(centerX, cy, centerZ).addScaledVector(across, offset).addScaledVector(forward, -0.18);
        build.lamps.push(new THREE.Matrix4().compose(position, facing, new THREE.Vector3(1, 1, 1)));
    }
}

// ---- Track hints ----

function hints(build: GateBuild, track: TrackDef): void {
    for (const hint of track.hints) {
        switch (hint.kind) {
            case 'barrier':
                for (const piece of barrierPieces(hint)) {
                    // One 1.9 m water barrier: a wide foot and a narrower body
                    const y = groundAt(piece.x, piece.z);
                    const finish = piece.red ? BARRIER_RED : BARRIER_WHITE;
                    boxAt(build.props, 1.9, 0.3, 0.6, piece.x, y, piece.z, piece.yaw, finish);
                    boxAt(build.props, 1.9, 0.7, 0.36, piece.x, y + 0.3, piece.z, piece.yaw, finish);
                }
                break;
            case 'chevron': {
                const posts = chevronPosts(hint);
                const ground = Math.max(...posts.map(p => groundAt(p.x, p.z)));
                for (const p of posts) {
                    const y = groundAt(p.x, p.z);
                    // The concrete foot is the collider's size
                    bar(build.props, new THREE.Vector3(p.x, y - 0.2, p.z), new THREE.Vector3(p.x, y + 0.45, p.z), 0.35, FINISH.concrete, 10);
                    bar(build.props, new THREE.Vector3(p.x, y, p.z), new THREE.Vector3(p.x, ground + CHEVRON_POST_TOP - 0.4, p.z), 0.07, FINISH.galvanized, 8);
                }
                const facing = new THREE.Vector3(Math.sin(hint.yaw), 0, Math.cos(hint.yaw));
                const right = new THREE.Vector3(-Math.cos(hint.yaw), 0, Math.sin(hint.yaw));
                const center = new THREE.Vector3(hint.x, ground + 2.2, hint.z);
                boxAt(build.props, 3.0, 0.8, 0.06, hint.x, ground + 1.8, hint.z, hint.yaw, BOARD_BACK);
                // The face towards the approaching car, readable from there
                // (its right is the board's -left axis)
                atlasQuad(build.atlas, center.clone().addScaledVector(facing, 0.035), right.clone().negate(), new THREE.Vector3(0, 1, 0),
                    1.45, 0.38, hint.dir === 'left' ? CELL_CHEVRON_LEFT : CELL_CHEVRON_RIGHT);
                break;
            }
            case 'delineators':
                for (const post of delineatorPosts(hint.line, hint.offset, hint.spacing)) {
                    const y = groundAt(post.x, post.z);
                    boxAt(build.props, 0.12, 1.0, 0.12, post.x, y - 0.1, post.z, post.yaw, DELINEATOR);
                    boxAt(build.props, 0.13, 0.18, 0.13, post.x, y + 0.62, post.z, post.yaw, DELINEATOR_BAND);
                    boxAt(build.props, 0.07, 0.09, 0.135, post.x, y + 0.8, post.z, post.yaw, REFLECTOR);
                }
                break;
            case 'arrow':
                groundMark(build.atlas, hint.x, hint.z, hint.yaw, 6.8, 5, CELL_ARROW);
                break;
        }
    }
    // A painted box in front of each grid slot
    for (const slot of track.grid) {
        const fx = Math.sin(slot.yaw), fz = Math.cos(slot.yaw);
        groundMark(build.atlas, slot.x + fx * 2.6, slot.z + fz * 2.6, slot.yaw, 2.6, 0.22, CELL_WHITE);
    }
}

// ---- Ramps ----

type LookedRamp = RampDef & { look?: TrackRamp['look'] };

function rampMesh(props: PropBatch, ramp: LookedRamp): void {
    const base = rampRearBase(ramp, (x, z) => groundHeight(x, z));
    const sin = Math.sin(ramp.yaw), cos = Math.cos(ramp.yaw);
    // Local (across, along) to world; across along the left axis
    const world = (across: number, along: number) => ({ x: ramp.x + cos * across + sin * along, z: ramp.z - sin * across + cos * along });
    const surface = (along: number) => base + ramp.height * (along / ramp.length + 0.5);
    const half = ramp.width / 2, halfL = ramp.length / 2;
    const steel = ramp.look === undefined || ramp.look === 'steel';
    const deck = steel ? STEEL_DECK : EARTH;
    const steps = 8;
    const positions: number[] = [];
    const quadAt = (p: THREE.Vector3[]) => {
        positions.push(p[0].x, p[0].y, p[0].z, p[1].x, p[1].y, p[1].z, p[2].x, p[2].y, p[2].z);
        positions.push(p[0].x, p[0].y, p[0].z, p[2].x, p[2].y, p[2].z, p[3].x, p[3].y, p[3].z);
    };
    const point = (across: number, along: number, y: number) => {
        const w = world(across, along);
        return new THREE.Vector3(w.x, y, w.z);
    };
    const foot = (across: number, along: number) => {
        const w = world(across, along);
        return groundAt(w.x, w.z) - 0.4;
    };
    for (let i = 0; i < steps; i++) {
        const a0 = -halfL + ramp.length * i / steps, a1 = -halfL + ramp.length * (i + 1) / steps;
        // Deck (up), both sides (outwards)
        quadAt([point(-half, a0, surface(a0)), point(-half, a1, surface(a1)), point(half, a1, surface(a1)), point(half, a0, surface(a0))]);
        quadAt([point(half, a0, foot(half, a0)), point(half, a0, surface(a0)), point(half, a1, surface(a1)), point(half, a1, foot(half, a1))]);
        quadAt([point(-half, a1, foot(-half, a1)), point(-half, a1, surface(a1)), point(-half, a0, surface(a0)), point(-half, a0, foot(-half, a0))]);
    }
    // Front face at the high end
    quadAt([point(-half, halfL, foot(-half, halfL)), point(-half, halfL, surface(halfL)), point(half, halfL, surface(halfL)), point(half, halfL, foot(half, halfL))]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.computeVertexNormals();
    props.add(g, deck);
    // The lip: a hazard bar on the steel ramp, a timber edge on the earth ones
    const lip = world(0, halfL - 0.15);
    boxAt(props, ramp.width, 0.14, 0.32, lip.x, surface(halfL) - 0.1, lip.z, ramp.yaw, steel ? HAZARD_YELLOW : FINISH.wood);
    if (steel) {
        // Anti-slip ribs across the steel deck
        for (let k = 1; k <= 7; k++) {
            const along = -halfL + k * ramp.length / 8;
            const at = world(0, along);
            boxAt(props, ramp.width - 0.3, 0.05, 0.08, at.x, surface(along) - 0.01, at.z, ramp.yaw, FINISH.galvanized);
        }
    }
    if (!steel) {
        // Planks across the upper half of the deck
        for (let k = 1; k <= 4; k++) {
            const along = halfL - 0.5 - k * 0.9;
            const at = world(0, along);
            boxAt(props, ramp.width - 0.2, 0.06, 0.34, at.x, surface(along) - 0.02, at.z, ramp.yaw, FINISH.wood);
        }
    }
}

let mapFeatures: THREE.Group | null = null;

/**
 * The map's jump ramps (built once per page; every room's world has them):
 * null until a map is given.
 */
export function mapFeaturesGroup(map: MapData | null): THREE.Group | null {
    if (mapFeatures || !map) return mapFeatures;
    const M = worldMaterials();
    const group = new THREE.Group();
    group.name = 'map-ramps';
    const props = new PropBatch('map-ramps');
    for (const ramp of map.ramps) rampMesh(props, ramp);
    const rampMeshObject = props.mesh(M.furniture, { cast: lightingTier() !== 'software' });
    if (rampMeshObject) group.add(rampMeshObject);
    mapFeatures = group;
    return group;
}

// ---- The dressing of one track ----

const LED_DIM = new THREE.Color(0.06, 0.05, 0.04);
const LED_AHEAD = new THREE.Color(0.35, 0.3, 0.24);
const LED_NEXT = new THREE.Color(1.0, 0.82, 0.55);
const LAMP_OFF = new THREE.Color(0.05, 0.02, 0.02);
const LAMP_RED = new THREE.Color(2.2, 0.06, 0.02);
const LAMP_GREEN = new THREE.Color(0.08, 1.9, 0.3);
const _color = new THREE.Color();

export class TrackDressing {
    readonly group = new THREE.Group();
    private readonly leds: THREE.InstancedMesh | null;
    private readonly ledGates: number[];
    private readonly lamps: THREE.InstancedMesh | null;
    private readonly materials: THREE.Material[] = [];
    private lastLights = '';

    constructor(readonly track: TrackDef) {
        this.group.name = 'race-track';
        const M = worldMaterials();
        const build: GateBuild = { props: new PropBatch('race-props'), atlas: new Batch('race-atlas'), leds: [], lamps: [] };
        track.gates.forEach((gate, i) => {
            if (gate.visual === 'arch') checkpoint(build, gate, i);
            else portal(build, gate, i, gate.visual !== 'finish');
        });
        hints(build, track);
        // The track's own ramps (the map's are in mapFeaturesGroup)
        for (const ramp of track.ramps) rampMesh(build.props, ramp);
        const cast = lightingTier() !== 'software';
        const props = build.props.mesh(M.furniture, { cast });
        if (props) this.group.add(props);
        const atlasMaterial = new THREE.MeshStandardMaterial({
            map: atlas(), roughness: 0.78, metalness: 0, alphaTest: 0.5, vertexColors: true,
            polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
        });
        this.materials.push(atlasMaterial);
        const paint = build.atlas.mesh(atlasMaterial, { cast: false });
        if (paint) this.group.add(paint);

        this.ledGates = build.leds.map(l => l.gate);
        if (build.leds.length) {
            const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
            this.materials.push(material);
            const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, build.leds.length);
            build.leds.forEach((l, i) => {
                mesh.setMatrixAt(i, l.matrix);
                mesh.setColorAt(i, LED_AHEAD);
            });
            mesh.name = 'race-leds';
            mesh.computeBoundingSphere();
            this.group.add(mesh);
            this.leds = mesh;
        } else {
            this.leds = null;
        }
        if (build.lamps.length) {
            const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
            this.materials.push(material);
            const mesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.19, 0.19, 0.08, 16), material, build.lamps.length);
            build.lamps.forEach((matrix, i) => {
                mesh.setMatrixAt(i, matrix);
                mesh.setColorAt(i, LAMP_OFF);
            });
            mesh.name = 'race-start-lights';
            mesh.computeBoundingSphere();
            this.group.add(mesh);
            this.lamps = mesh;
        } else {
            this.lamps = null;
        }
    }

    /**
     * Per frame: the LED strips by the look of their gate (the next one
     * pulses slowly), the start lights by the countdown (lit red lamps of
     * five, or all green; null: off).
     */
    update(timeSec: number, look: (gate: number) => GateLook, lights: { red: number; green: boolean } | null): void {
        const leds = this.leds;
        if (leds) {
            const pulse = 1.4 + 0.8 * Math.sin(timeSec * 2.4);
            this.ledGates.forEach((gate, i) => {
                const kind = look(gate);
                if (kind === 'next') _color.copy(LED_NEXT).multiplyScalar(pulse);
                else _color.copy(kind === 'passed' ? LED_DIM : LED_AHEAD);
                leds.setColorAt(i, _color);
            });
            if (leds.instanceColor) leds.instanceColor.needsUpdate = true;
        }
        const lamps = this.lamps;
        if (!lamps) return;
        const key = lights ? `${lights.red}:${lights.green}` : 'off';
        if (key === this.lastLights) return;
        this.lastLights = key;
        for (let i = 0; i < lamps.count; i++) {
            const k = i % 5;
            lamps.setColorAt(i, !lights ? LAMP_OFF : lights.green ? LAMP_GREEN : k < lights.red ? LAMP_RED : LAMP_OFF);
        }
        if (lamps.instanceColor) lamps.instanceColor.needsUpdate = true;
    }

    dispose(): void {
        this.group.removeFromParent();
        this.group.traverse(object => {
            const mesh = object as THREE.Mesh;
            if (mesh.isMesh) mesh.geometry.dispose();
        });
        for (const material of this.materials) material.dispose();
    }
}

/** Lamps of five lit for the countdown's red lights (1..3 of 3 → 1, 3, 5 of 5). */
export function lampsFor(lights: number): number {
    return Math.min(5, Math.floor(lights * 5 / 3));
}
