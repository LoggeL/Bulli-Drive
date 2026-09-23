// Car against car (docs/phase-1a-design.md, section 8): the deepest of the
// four circle pairs gets an impulse with restitution and friction plus a
// soft position correction. Impulses are purely horizontal, so a bump never
// throws a car into the air, and per-tick caps keep chains of contacts from
// exploding.

import { SIM_TUNING as T } from './constants.js';
import type { SimCar } from './types.js';

const HEIGHT_WINDOW = 1.4;

function applyContactDelta(car: SimCar, dvx: number, dvz: number, dw: number): void {
    const s = car.state;
    // Σ|Δv| cap: scale the change down to what is left of this tick's budget
    const dv = Math.sqrt(dvx * dvx + dvz * dvz);
    const dvBudget = T.CONTACT_DV_CAP - car.contactDv;
    if (dv > dvBudget) {
        const k = dvBudget > 0 ? dvBudget / dv : 0;
        dvx *= k; dvz *= k;
        car.contactDv = T.CONTACT_DV_CAP;
    } else {
        car.contactDv += dv;
    }
    s.vx += dvx;
    s.vz += dvz;
    // Σ|Δω| cap, then |ω| <= R_MAX
    const dwBudget = Math.max(0, T.CONTACT_DOMEGA_CAP - car.contactDw);
    if (dw > dwBudget) dw = dwBudget;
    else if (dw < -dwBudget) dw = -dwBudget;
    car.contactDw += Math.abs(dw);
    const yawRate = s.yawRate + dw;
    s.yawRate = yawRate > T.R_MAX ? T.R_MAX : yawRate < -T.R_MAX ? -T.R_MAX : yawRate;
}

function noteImpact(car: SimCar, other: SimCar, impact: number): void {
    if (impact > car.events.carImpact) {
        car.events.carImpact = impact;
        car.events.carImpactId = other.id;
    }
}

// Resolves one pair. a comes before b in the id-sorted car list; the
// contact normal points from b to a. A kinematic car (1a remote proxy)
// takes neither impulse nor correction: its partner gets the full-strength
// impulse scaled by the proxy's contactScale, without restitution.
export function resolveContact(a: SimCar, b: SimCar): void {
    if (a.kinematic && b.kinematic) return;
    if (a.mods.ghost || b.mods.ghost) return;
    const sa = a.state, sb = b.state;
    if (sa.ghostTicks > 0 || sb.ghostTicks > 0) return;
    // Every test below is written so that NaN fails it: a car with a broken
    // state must not hand NaN impulses to the others
    if (!(Math.abs(sa.y - sb.y) <= HEIGHT_WINDOW * Math.max(sa.scale, sb.scale))) return;

    const pa = a.params, pb = b.params;
    const ca = pa.colliderOffset, ra = pa.colliderRadius;
    const cb = pb.colliderOffset, rb = pb.colliderRadius;
    // Broad phase on the enclosing circles
    const hull = ca + ra + cb + rb;
    const hx = sa.x - sb.x, hz = sa.z - sb.z;
    if (!(hx * hx + hz * hz < hull * hull)) return;

    // Narrow phase: the four circle pairs in fixed order, deepest wins
    const fax = Math.sin(sa.yaw), faz = Math.cos(sa.yaw);
    const fbx = Math.sin(sb.yaw), fbz = Math.cos(sb.yaw);
    const reach = ra + rb;
    let pen = 0, nx = 0, nz = 0, cjx = 0, cjz = 0;
    for (let pair = 0; pair < 4; pair++) {
        const sideA = pair < 2 ? 1 : -1;
        const sideB = pair % 2 === 0 ? 1 : -1;
        const aX = sa.x + sideA * ca * fax, aZ = sa.z + sideA * ca * faz;
        const bX = sb.x + sideB * cb * fbx, bZ = sb.z + sideB * cb * fbz;
        const dx = aX - bX, dz = aZ - bZ;
        const d2 = dx * dx + dz * dz;
        if (!(d2 < reach * reach)) continue;
        const d = Math.sqrt(d2);
        if (reach - d <= pen) continue;
        pen = reach - d;
        if (d > 1e-9) {
            nx = dx / d; nz = dz / d;
        } else {
            // Coincident circles: separate along the line between the cars
            const hd = Math.sqrt(hx * hx + hz * hz);
            nx = hd > 1e-9 ? hx / hd : 1;
            nz = hd > 1e-9 ? hz / hd : 0;
        }
        cjx = bX; cjz = bZ;
    }
    if (!(pen > 0)) return;

    const dynA = !a.kinematic, dynB = !b.kinematic;
    // Contact point: middle of the overlap on the line between the circles
    const pcx = cjx + nx * (rb - pen / 2);
    const pcz = cjz + nz * (rb - pen / 2);
    const rAx = pcx - sa.x, rAz = pcz - sa.z;
    const rBx = pcx - sb.x, rBz = pcz - sb.z;

    // Contact masses, ratio capped so heavy classes push more but not endlessly
    let ma = pa.contactMass, mb = pb.contactMass;
    const ratioCap = Math.max(pa.massRatioCap, pb.massRatioCap);
    if (ma > ratioCap * mb) ma = ratioCap * mb;
    else if (mb > ratioCap * ma) mb = ratioCap * ma;
    const Ia = ma * pa.yawRadius * pa.yawRadius;
    const Ib = mb * pb.yawRadius * pb.yawRadius;

    // Relative velocity at the contact point, ω × r = (ω·r_z, -ω·r_x)
    const vax = sa.vx + sa.yawRate * rAz, vaz = sa.vz - sa.yawRate * rAx;
    const vbx = sb.vx + sb.yawRate * rBz, vbz = sb.vz - sb.yawRate * rBx;
    const vrx = vax - vbx, vrz = vaz - vbz;
    const vn = vrx * nx + vrz * nz;
    if (vn < 0) {
        const rAn = rAz * nx - rAx * nz;
        const rBn = rBz * nx - rBx * nz;
        const K = 1 / ma + 1 / mb + rAn * rAn / Ia + rBn * rBn / Ib;
        const restitution = dynA && dynB ? T.CAR_RESTITUTION : 0;
        const bounce = Math.min(restitution * -vn, T.CAR_BOUNCE_MAX);
        // Stopping is never capped, only the rebound
        const jn = (-vn + bounce) / K;
        let jx = jn * nx, jz = jn * nz;
        let tx = vrx - vn * nx, tz = vrz - vn * nz;
        const vt = Math.sqrt(tx * tx + tz * tz);
        if (vt > 1e-9) {
            tx /= vt; tz /= vt;
            const rAt = rAz * tx - rAx * tz;
            const rBt = rBz * tx - rBx * tz;
            const Kt = 1 / ma + 1 / mb + rAt * rAt / Ia + rBt * rBt / Ib;
            const jt = -Math.min(vt / Kt, T.CAR_FRICTION * jn);
            jx += jt * tx; jz += jt * tz;
        }
        const strength = a.contactScale * b.contactScale;
        jx *= strength; jz *= strength;
        const j = Math.sqrt(jx * jx + jz * jz);
        if (dynA) {
            applyContactDelta(a, jx / ma, jz / ma, (rAz * jx - rAx * jz) / Ia);
            noteImpact(a, b, j / ma);
        }
        if (dynB) {
            applyContactDelta(b, -jx / mb, -jz / mb, -(rBz * jx - rBx * jz) / Ib);
            noteImpact(b, a, j / mb);
        }
    }

    // Soft position correction, split by inverse mass (all of it on the
    // dynamic car against a proxy), at most 0.5 m per car and substep
    const corr = Math.max(0, pen - T.CONTACT_SLOP) * T.CONTACT_CORRECTION;
    if (corr <= 0) return;
    const shareA = dynA ? (dynB ? (1 / ma) / (1 / ma + 1 / mb) : 1) : 0;
    const corrA = Math.min(corr * shareA, T.CONTACT_MAX_CORRECTION);
    const corrB = Math.min(corr * (1 - shareA), T.CONTACT_MAX_CORRECTION);
    if (dynA) { sa.x += nx * corrA; sa.z += nz * corrA; }
    if (dynB) { sb.x -= nx * corrB; sb.z -= nz * corrB; }
}
