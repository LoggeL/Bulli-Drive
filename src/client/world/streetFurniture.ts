import * as THREE from 'three';
import type { FurnitureKind } from '../../shared/map/furniture.js';
import { tube } from './batch.js';
import { FINISH, PropBatch } from './furniture.js';

// The street furniture's models (graphics G1; placed by
// shared/map/furniture.ts, drawn instanced by world/mapWorld.ts): swan neck
// street lights, traffic signal mast arms with a street light on top, fire
// hydrants, trash cans and park benches, as the old city had them.
// Finishes come from the `surface` attribute of the furniture material
// (materials.ts); the signal lenses cycle in its shader.
//
// Object space: foot at the origin, y up. Light and signal arms reach along
// +x, signal heads face -z (towards the traffic they control), a bench
// faces +z.

/** The geometry plus a copy facing the other way (thin open shells). */
function twoSided(g: THREE.BufferGeometry): THREE.BufferGeometry {
    const flat = g.index ? g.toNonIndexed() : g;
    const back = flat.clone();
    const P = back.attributes.position, N = back.attributes.normal;
    for (let i = 0; i < P.count; i += 3) {
        for (const A of [P, N]) {
            const x = A.getX(i + 1), y = A.getY(i + 1), z = A.getZ(i + 1);
            A.setXYZ(i + 1, A.getX(i + 2), A.getY(i + 2), A.getZ(i + 2));
            A.setXYZ(i + 2, x, y, z);
        }
    }
    for (let i = 0; i < N.count; i++) N.setXYZ(i, -N.getX(i), -N.getY(i), -N.getZ(i));
    const merged = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'uv'] as const) {
        const a = flat.getAttribute(name), b = back.getAttribute(name);
        const data = new Float32Array(a.count * a.itemSize * 2);
        data.set(a.array as Float32Array);
        data.set(b.array as Float32Array, a.count * a.itemSize);
        merged.setAttribute(name, new THREE.BufferAttribute(data, a.itemSize));
    }
    return merged;
}

/**
 * Surface of revolution from (radius, height) pairs. Trace the profile with
 * the solid on the left (bottom outwards, up the outside, top inwards): the
 * front faces then face out of the solid.
 */
function lathe(profile: readonly (readonly [number, number])[], segments: number): THREE.BufferGeometry {
    return new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), segments);
}

// Swan neck street light of the probe, with a cast base, collar rings and a
// lantern head; the arm reaches along +x
function lampGeometry(P: PropBatch, low: boolean): void {
    const r = low ? 8 : 12;
    const iron = FINISH.castIron;
    P.add(lathe([[0.2, 0], [0.2, 0.05], [0.17, 0.09], [0.15, 0.2], [0.125, 0.55], [0.155, 0.6], [0.155, 0.66], [0.1, 0.72], [0.085, 0.76]], r), iron);
    P.add(new THREE.CylinderGeometry(0.062, 0.084, 4.45, r, 1, true).translate(0, 0.76 + 2.225, 0), iron);
    for (const y of [1.6, 3.6]) P.add(new THREE.TorusGeometry(0.08, 0.018, 5, r).rotateX(Math.PI / 2).translate(0, y, 0), iron);
    P.add(lathe([[0.062, 5.18], [0.09, 5.22], [0.09, 5.3], [0.05, 5.36], [0.03, 5.48], [0, 5.5]], r), iron);
    const points: THREE.Vector3[] = [];
    const steps = low ? 7 : 11;
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        points.push(new THREE.Vector3(Math.sin(t * Math.PI * 0.9) * 0.55 + t * 0.5, 5.2 + Math.sin(t * Math.PI) * 0.45 - t * 0.1, 0));
    }
    P.add(tube(points, points.map((_, i) => 0.04 - i * 0.0012), low ? 5 : 7), iron);
    const hx = points[steps].x;
    // Lantern: hood, cap, frosted globe with a warm core
    P.add(lathe([[0.1, 4.99], [0.28, 4.98], [0.27, 5.02], [0.07, 5.17], [0.05, 5.22], [0.02, 5.26]], r).translate(hx, 0, 0), iron);
    P.add(new THREE.SphereGeometry(0.175, r, low ? 6 : 8).scale(1, 1.2, 1).translate(hx, 4.78, 0), FINISH.globe);
    P.add(new THREE.SphereGeometry(0.08, 6, 4).translate(hx, 4.72, 0), FINISH.lampCore);
}

// One three-aspect signal head facing -z, centered at (x, y, z)
function signalHead(P: PropBatch, x: number, y: number, z: number, low: boolean, backplate: boolean): void {
    P.box(0.34, 0.98, 0.26, x, y, z, FINISH.signalBody);
    if (backplate) P.box(0.62, 1.2, 0.025, x, y, z + 0.14, FINISH.blackPlastic);
    const lenses = [FINISH.lensRed, FINISH.lensYellow, FINISH.lensGreen];
    for (let i = 0; i < 3; i++) {
        const ly = y + 0.31 - i * 0.31;
        P.add(new THREE.CircleGeometry(0.105, low ? 10 : 14).rotateY(Math.PI).translate(x, ly, z - 0.132), lenses[i]);
        // Visor: open half cylinder over the lens
        P.add(twoSided(new THREE.CylinderGeometry(0.125, 0.125, 0.2, low ? 6 : 9, 1, true, -Math.PI / 2, Math.PI)
            .rotateX(-Math.PI / 2).translate(x, ly, z - 0.232)), FINISH.signalBody);
    }
}

// Galvanized mast arm pole: the arm reaches 7 m along +x over the lanes with
// two heads, a third head sits on the pole; a davit arm on top carries a
// cobra head street light
function signalGeometry(P: PropBatch, low: boolean): void {
    const r = low ? 8 : 12;
    const steel = FINISH.galvanized;
    P.box(0.44, 0.05, 0.44, 0, 0.025, 0, FINISH.concrete);
    P.add(lathe([[0.22, 0.05], [0.22, 0.09], [0.17, 0.12], [0.17, 0.28], [0.155, 0.32]], r), steel);
    P.add(new THREE.CylinderGeometry(0.115, 0.155, 7.1, r, 1, true).translate(0, 0.32 + 3.55, 0), steel);
    P.add(new THREE.SphereGeometry(0.12, r, 4, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 7.42, 0), steel);
    // Mast arm, rising slightly, with its clamp and a brace
    const arm: THREE.Vector3[] = [];
    for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        arm.push(new THREE.Vector3(0.1 + t * 7.0, 6.05 + t * 0.35 - t * t * 0.1, 0));
    }
    P.add(tube(arm, arm.map((_, i) => 0.12 - i * 0.009), low ? 6 : 8), steel);
    P.add(new THREE.CylinderGeometry(0.19, 0.19, 0.4, r).translate(0, 6.05, 0), steel);
    P.add(tube([new THREE.Vector3(0.1, 5.35, 0), new THREE.Vector3(0.9, 5.8, 0), new THREE.Vector3(1.7, 6.14, 0)], [0.04, 0.035, 0.03], 5), steel);
    // Heads over the two lanes, hanging from brackets
    for (const hx of [3.6, 6.4]) {
        const top = 6.05 + (hx / 7) * 0.35 - (hx / 7) ** 2 * 0.1;
        P.box(0.05, top - 6.03, 0.05, hx, (top + 6.03) / 2, 0, steel);
        signalHead(P, hx, 5.55, 0, low, true);
    }
    // Pole mounted head at eye level, facing the same traffic
    P.box(0.08, 0.08, 0.2, 0, 3.4, -0.18, steel);
    signalHead(P, 0, 3.4, -0.42, low, false);
    // Davit arm and cobra head luminaire
    const davit: THREE.Vector3[] = [];
    for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        davit.push(new THREE.Vector3(Math.sin(t * Math.PI / 2) * 2.3, 7.35 + Math.sin(t * Math.PI * 0.8) * 0.5 - t * 0.05, 0));
    }
    P.add(tube(davit, davit.map(() => 0.05), low ? 5 : 7), steel);
    const hx = davit[6].x + 0.35;
    const hy = davit[6].y;
    P.add(new THREE.SphereGeometry(0.5, r, low ? 5 : 7, 0, Math.PI * 2, 0, Math.PI / 2).scale(1.0, 0.36, 0.52).translate(hx, hy - 0.02, 0), FINISH.luminaire);
    P.add(new THREE.SphereGeometry(0.44, r, 4, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2).scale(0.95, 0.18, 0.46).translate(hx + 0.03, hy - 0.02, 0), FINISH.globe);
}

// California wet barrel hydrant: flanged barrel, dome bonnet with operating
// nut, two hose outlets and a pumper outlet with caps
function hydrantGeometry(P: PropBatch, low: boolean): void {
    const r = low ? 8 : 14;
    const body = FINISH.hydrant, cap = FINISH.hydrantCap;
    P.add(lathe([[0.19, 0], [0.19, 0.035], [0.15, 0.05], [0.13, 0.07], [0.125, 0.5], [0.155, 0.52], [0.155, 0.56], [0.13, 0.57]], r), body);
    P.add(new THREE.SphereGeometry(0.13, r, low ? 4 : 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.85, 1).translate(0, 0.57, 0), body);
    P.add(new THREE.CylinderGeometry(0.035, 0.045, 0.08, 5).translate(0, 0.72, 0), cap);
    // Bolts of the flanges
    for (let i = 0; i < (low ? 4 : 8); i++) {
        const a = (i / (low ? 4 : 8)) * Math.PI * 2;
        P.add(new THREE.CylinderGeometry(0.012, 0.012, 0.03, 4).translate(Math.cos(a) * 0.17, 0.045, Math.sin(a) * 0.17), cap);
        P.add(new THREE.CylinderGeometry(0.01, 0.01, 0.05, 4).translate(Math.cos(a) * 0.145, 0.575, Math.sin(a) * 0.145), cap);
    }
    const outlet = (angle: number, radius: number, y: number) => {
        const m = new THREE.Matrix4().makeRotationY(angle);
        P.add(new THREE.CylinderGeometry(radius, radius, 0.1, r).rotateZ(Math.PI / 2).translate(0.15, y, 0).applyMatrix4(m), body);
        P.add(new THREE.CylinderGeometry(radius * 1.12, radius * 1.12, 0.05, r).rotateZ(Math.PI / 2).translate(0.215, y, 0).applyMatrix4(m), cap);
        P.add(new THREE.CylinderGeometry(0.022, 0.026, 0.035, 5).rotateZ(Math.PI / 2).translate(0.255, y, 0).applyMatrix4(m), cap);
    };
    outlet(0, 0.045, 0.4);
    outlet(Math.PI, 0.045, 0.4);
    outlet(Math.PI / 2, 0.07, 0.36);
}

// Slatted steel trash receptacle with liner and a dome lid, 50 cm across
// (built 62 cm wide, scaled down in furnitureGeometry)
function trashCanGeometry(P: PropBatch, low: boolean): void {
    const r = low ? 10 : 16;
    const can = FINISH.can;
    P.add(new THREE.CylinderGeometry(0.3, 0.31, 0.07, r).translate(0, 0.035, 0), can);
    P.add(new THREE.CylinderGeometry(0.25, 0.25, 0.8, r).translate(0, 0.47, 0), FINISH.canLiner);
    const slats = low ? 12 : 18;
    for (let i = 0; i < slats; i++) {
        const a = (i / slats) * Math.PI * 2;
        const m = new THREE.Matrix4().makeRotationY(-a).setPosition(Math.cos(a) * 0.28, 0.47, Math.sin(a) * 0.28);
        P.add(new THREE.BoxGeometry(0.022, 0.8, 0.075).applyMatrix4(m), can);
    }
    for (const y of [0.12, 0.5, 0.86]) P.add(new THREE.CylinderGeometry(0.297, 0.297, 0.05, r, 1, true).translate(0, y, 0), can);
    P.add(lathe([[0.3, 0.88], [0.31, 0.9], [0.3, 0.93], [0.24, 0.98], [0.15, 1.0], [0.15, 1.02], [0, 1.03]], r), can);
}

// Park bench, 2 m: cast iron ends with armrests, wooden seat and back slats;
// the back is at -z, the bench faces +z
function benchGeometry(P: PropBatch): void {
    const iron = FINISH.castIron, wood = FINISH.wood;
    for (const x of [-0.86, 0.86]) {
        const at = (g: THREE.BufferGeometry) => g.translate(x, 0, 0);
        P.add(at(new THREE.BoxGeometry(0.05, 0.43, 0.05).translate(0, 0.215, 0.2)), iron);
        P.add(at(new THREE.BoxGeometry(0.05, 0.9, 0.05).rotateX(-0.18).translate(0, 0.45, -0.24)), iron);
        P.add(at(new THREE.BoxGeometry(0.05, 0.035, 0.5).translate(0, 0.41, -0.02)), iron);
        P.add(at(new THREE.BoxGeometry(0.055, 0.04, 0.52).translate(0, 0.64, 0.0)), iron);
        P.add(at(new THREE.BoxGeometry(0.04, 0.23, 0.04).translate(0, 0.525, 0.22)), iron);
        P.add(at(new THREE.BoxGeometry(0.06, 0.03, 0.12).translate(0, 0.015, 0.2)), iron);
        P.add(at(new THREE.BoxGeometry(0.06, 0.03, 0.12).translate(0, 0.015, -0.3)), iron);
    }
    for (let i = 0; i < 5; i++) P.add(new THREE.BoxGeometry(2.0, 0.035, 0.075).translate(0, 0.445, -0.2 + i * 0.095), wood);
    for (let i = 0; i < 3; i++) P.add(new THREE.BoxGeometry(2.0, 0.08, 0.025).rotateX(-0.18).translate(0, 0.58 + i * 0.12, -0.3 - i * 0.022), wood);
}

// Far away (and on software WebGL) a few boxes: the post, the arm, the
// lantern or the signal heads, the barrel, the bench's seat and back
function farGeometry(P: PropBatch, kind: FurnitureKind): void {
    if (kind === 'lamp') {
        P.box(0.16, 5.2, 0.16, 0, 2.6, 0, FINISH.castIron);
        P.box(1.0, 0.08, 0.08, 0.5, 5.4, 0, FINISH.castIron);
        P.box(0.36, 0.42, 0.36, 1.0, 4.9, 0, FINISH.globe);
    } else if (kind === 'signal') {
        P.box(0.26, 7.4, 0.26, 0, 3.7, 0, FINISH.galvanized);
        P.box(7.0, 0.2, 0.2, 3.6, 6.2, 0, FINISH.galvanized);
        for (const x of [3.6, 6.4]) P.box(0.34, 0.98, 0.26, x, 5.55, 0, FINISH.signalBody);
    } else if (kind === 'hydrant') {
        P.box(0.26, 0.7, 0.26, 0, 0.35, 0, FINISH.hydrant);
    } else if (kind === 'trashCan') {
        P.box(0.46, 1.0, 0.46, 0, 0.5, 0, FINISH.can);
    } else {
        P.box(2.0, 0.08, 0.45, 0, 0.44, 0, FINISH.wood);
        P.box(2.0, 0.36, 0.06, 0, 0.7, -0.26, FINISH.wood);
    }
}

/**
 * One kind's model: 'high' on desktops, 'low' (fewer segments) on phones,
 * 'far' a few boxes for the distance and for software WebGL.
 */
export function furnitureGeometry(kind: FurnitureKind, detail: 'high' | 'low' | 'far'): THREE.BufferGeometry {
    const low = detail !== 'high';
    const P = new PropBatch(`furniture-${kind}`);
    if (detail === 'far') farGeometry(P, kind);
    else if (kind === 'lamp') lampGeometry(P, low);
    else if (kind === 'signal') signalGeometry(P, low);
    else if (kind === 'hydrant') hydrantGeometry(P, low);
    else if (kind === 'trashCan') trashCanGeometry(P, low);
    else benchGeometry(P);
    const geometry = P.build()!;
    if (kind === 'trashCan' && detail !== 'far') geometry.scale(0.8, 1, 0.8);
    return geometry;
}
