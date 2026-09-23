// Car against the static world (docs/phase-1a-design.md, section 7.3): the
// car is two circles at ±c along its heading, colliders are circles and
// axis-aligned boxes, the world border is four planes. Contacts are pushed
// out and answered with an impulse against an infinitely heavy wall, so a
// grazing hit slides along instead of bouncing back.

import type { Collider, SimWorld } from '../world/colliders.js';
import { SIM_TUNING as T } from './constants.js';
import type { SimCar, VehicleParams, VehicleState } from './types.js';

const WORLD_ITERATIONS = 2;
const PUSH_EPSILON = 0.001;
const QUERY_MARGIN = 0.5;

// Result of the last narrow-phase test (module scratch, no allocation)
let hitPen = 0;
let hitNx = 0;
let hitNz = 0;

function circleVsCollider(px: number, pz: number, r: number, collider: Collider): boolean {
    if (collider.kind === 'circle') {
        const dx = px - collider.x, dz = pz - collider.z;
        const reach = r + collider.r;
        const d2 = dx * dx + dz * dz;
        if (d2 >= reach * reach) return false;
        const d = Math.sqrt(d2);
        if (d > 1e-9) {
            hitNx = dx / d;
            hitNz = dz / d;
        } else {
            hitNx = 1;
            hitNz = 0;
        }
        hitPen = reach - d;
        return true;
    }
    const minX = collider.x - collider.hw, maxX = collider.x + collider.hw;
    const minZ = collider.z - collider.hd, maxZ = collider.z + collider.hd;
    const qx = px < minX ? minX : px > maxX ? maxX : px;
    const qz = pz < minZ ? minZ : pz > maxZ ? maxZ : pz;
    const dx = px - qx, dz = pz - qz;
    const d2 = dx * dx + dz * dz;
    if (d2 > 0) {
        if (d2 >= r * r) return false;
        const d = Math.sqrt(d2);
        hitNx = dx / d;
        hitNz = dz / d;
        hitPen = r - d;
        return true;
    }
    // Centre inside the box (spawn, growing Mega): leave along the axis of
    // least penetration, x before z on a tie
    let best = px - minX;
    hitNx = -1; hitNz = 0;
    if (maxX - px < best) { best = maxX - px; hitNx = 1; hitNz = 0; }
    if (pz - minZ < best) { best = pz - minZ; hitNx = 0; hitNz = -1; }
    if (maxZ - pz < best) { best = maxZ - pz; hitNx = 0; hitNz = 1; }
    hitPen = r + best;
    return true;
}

// Deeper of the car's two circles against one collider. Returns the
// penetration (<= 0: no contact); the normal lands in hitNx/hitNz and the
// circle's side (+1 front, -1 rear) in hitSide.
let hitSide = 0;
function carVsCollider(s: VehicleState, p: VehicleParams, fx: number, fz: number, collider: Collider): number {
    const c = p.colliderOffset, r = p.colliderRadius;
    let pen = 0, nx = 0, nz = 0, side = 0;
    if (circleVsCollider(s.x + c * fx, s.z + c * fz, r, collider)) {
        pen = hitPen; nx = hitNx; nz = hitNz; side = 1;
    }
    if (circleVsCollider(s.x - c * fx, s.z - c * fz, r, collider) && hitPen > pen) {
        pen = hitPen; nx = hitNx; nz = hitNz; side = -1;
    }
    hitNx = nx; hitNz = nz; hitSide = side;
    return pen;
}

function queryCar(s: VehicleState, p: VehicleParams, world: SimWorld): number {
    const extent = p.colliderOffset + p.colliderRadius + QUERY_MARGIN;
    return world.grid.query(s.x - extent, s.z - extent, s.x + extent, s.z + extent, world.queryBuffer);
}

// Impulse of a wall contact at lever (rcx, rcz) from the centre of mass
// with normal n pointing out of the wall
function applyWallImpulse(car: SimCar, rcx: number, rcz: number, nx: number, nz: number): void {
    const s = car.state, p = car.params;
    const m = p.mass;
    const I = m * p.yawRadius * p.yawRadius;
    // v_p = v + ω × r_c with ω × r = (ω·r_z, -ω·r_x)
    const vpx = s.vx + s.yawRate * rcz;
    const vpz = s.vz - s.yawRate * rcx;
    const vn = vpx * nx + vpz * nz;
    if (vn >= 0) return;
    const rn = rcz * nx - rcx * nz;
    const K = 1 / m + rn * rn / I;
    const bounce = Math.min(p.restitutionWall * -vn, T.WALL_BOUNCE_MAX);
    const jn = (-vn + bounce) / K;
    let jx = jn * nx, jz = jn * nz;
    let tx = vpx - vn * nx, tz = vpz - vn * nz;
    const vt = Math.sqrt(tx * tx + tz * tz);
    if (vt > 1e-9) {
        tx /= vt; tz /= vt;
        const rt = rcz * tx - rcx * tz;
        const Kt = 1 / m + rt * rt / I;
        const jt = -Math.min(vt / Kt, T.WALL_FRICTION * jn);
        jx += jt * tx; jz += jt * tz;
    }
    s.vx += jx / m;
    s.vz += jz / m;
    let dw = (rcz * jx - rcx * jz) / I;
    if (dw > T.WALL_DOMEGA_MAX) dw = T.WALL_DOMEGA_MAX;
    else if (dw < -T.WALL_DOMEGA_MAX) dw = -T.WALL_DOMEGA_MAX;
    const yawRate = s.yawRate + dw;
    s.yawRate = yawRate > T.R_MAX ? T.R_MAX : yawRate < -T.R_MAX ? -T.R_MAX : yawRate;
    if (-vn > car.events.wallImpact) {
        car.events.wallImpact = -vn;
        car.events.wallX = s.x + rcx;
        car.events.wallZ = s.z + rcz;
    }
}

// Pushes the car out of every overlapped static collider it cannot pass
// over, in index order. With a car, contacts also get the impulse answer;
// without one (reset), only the position is corrected.
function resolveColliders(s: VehicleState, p: VehicleParams, world: SimWorld, car: SimCar | null): void {
    const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
    const count = queryCar(s, p, world);
    for (let k = 0; k < count; k++) {
        const collider = world.colliders[world.queryBuffer[k]];
        if (s.y >= collider.base + collider.top) continue;
        const pen = carVsCollider(s, p, fx, fz, collider);
        if (pen <= 0) continue;
        const nx = hitNx, nz = hitNz;
        s.x += nx * (pen + PUSH_EPSILON);
        s.z += nz * (pen + PUSH_EPSILON);
        if (car) {
            car.state.wallTicks = 0;
            const lever = hitSide * p.colliderOffset;
            applyWallImpulse(car, lever * fx - nx * p.colliderRadius, lever * fz - nz * p.colliderRadius, nx, nz);
        }
    }
}

// The world border: four planes at ±bound the circles stay inside of
function resolveBorder(car: SimCar, world: SimWorld): void {
    const s = car.state, p = car.params;
    const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
    const r = p.colliderRadius, bound = world.bound;
    for (let side = 1; side >= -1; side -= 2) {
        for (let plane = 0; plane < 4; plane++) {
            const lever = side * p.colliderOffset;
            const cx = s.x + lever * fx, cz = s.z + lever * fz;
            let pen = 0, nx = 0, nz = 0;
            if (plane === 0) { pen = cx + r - bound; nx = -1; }
            else if (plane === 1) { pen = -bound - (cx - r); nx = 1; }
            else if (plane === 2) { pen = cz + r - bound; nz = -1; }
            else { pen = -bound - (cz - r); nz = 1; }
            if (pen <= 0) continue;
            s.x += nx * pen;
            s.z += nz * pen;
            s.wallTicks = 0;
            applyWallImpulse(car, lever * fx - nx * r, lever * fz - nz * r, nx, nz);
        }
    }
}

// True when the car overlaps a static collider it cannot pass over
export function overlapsColliders(s: VehicleState, p: VehicleParams, world: SimWorld): boolean {
    const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
    const count = queryCar(s, p, world);
    for (let k = 0; k < count; k++) {
        const collider = world.colliders[world.queryBuffer[k]];
        if (s.y >= collider.base + collider.top) continue;
        if (carVsCollider(s, p, fx, fz, collider) > 0) return true;
    }
    return false;
}

// Position-only push-out, e.g. after a reset (no impulse, no events)
export function pushOutOfColliders(s: VehicleState, p: VehicleParams, world: SimWorld, iterations: number): void {
    for (let i = 0; i < iterations; i++) {
        if (!overlapsColliders(s, p, world)) return;
        resolveColliders(s, p, world, null);
    }
}

// One substep of world collision for a dynamic car, two iterations. A
// Party ghost only keeps the world border; so does a car whose ghost ended
// inside a collider until it is free again (ghostExit).
export function resolveWorld(car: SimCar, world: SimWorld): void {
    const s = car.state, p = car.params;
    let useColliders = !car.mods.ghost;
    if (useColliders && s.ghostExit > 0) {
        if (overlapsColliders(s, p, world)) useColliders = false;
        else s.ghostExit = 0;
    }
    for (let i = 0; i < WORLD_ITERATIONS; i++) {
        if (useColliders) resolveColliders(s, p, world, car);
        resolveBorder(car, world);
    }
}
