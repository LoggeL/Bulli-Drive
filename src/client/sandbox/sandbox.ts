import * as THREE from 'three';
import { BUILDING_COLORS } from '../../shared/world/cityGen.js';
import type { RampDef, SimWorld } from '../../shared/world/colliders.js';
import { createSandboxWorld, SANDBOX, SANDBOX_PAD_SIZE, SANDBOX_TERRAIN, type DummySpec, type SandboxBox } from '../../shared/world/sandbox.js';
import { createDummy, driveDummy, resetDummy } from '../../shared/sim/dummies.js';
import { findScenario, recordScenario, SIM_SCENARIOS, tuningIsDefault, type ScenarioFrame } from '../../shared/sim/scenarios.js';
import { copyVehicleState, createVehicleState, type SimCar, type VehicleState } from '../../shared/sim/types.js';
import { refreshCarParams } from '../../shared/sim/tuning.js';
import { CAR_CLASS_IDS } from '../../shared/sim/vehicleClasses.js';
import { Bulli, type CarType } from '../entities/Bulli.js';
import { gameHooks } from '../game/hooks.js';
import { createLocalPlayer, removeLoader } from '../network/websocket.js';
import { state } from '../state.js';
import { CarModel } from '../vehicle/CarModel.js';
import type { LocalVehicle } from '../vehicle/LocalVehicle.js';
import { Nametag } from '../vehicle/Nametag.js';

// The offline test pad of the v2 physics (?sandbox=1, docs/phase-1a-design.md,
// 12.7). Loaded on demand instead of the server connection: it draws the
// layout from shared/world/sandbox.ts, hands its sim world to the local car
// (game/hooks.ts) and steps five dummy cars in the same stepWorld, parked
// or lapping the painted curves. N resets the dummies and cones, C switches
// the car body.

const DUMMY_COLORS = [0x1E88E5, 0x43A047, 0xFDD835, 0x8E24AA, 0xFB8C00];
const PLAYER_COLOR = 0xD32F2F;
// Cones fall over when a car's centre comes this close (m)
const CONE_HIT_RADIUS = 1.9;
const CONE_FALL_RATE = 8;
const TWO_PI = Math.PI * 2;

interface Dummy {
    spec: DummySpec;
    car: SimCar;
    // State before the last tick, for the render interpolation
    prev: VehicleState;
    model: CarModel;
    tag: Nametag;
}

interface Cone {
    mesh: THREE.Group;
    x: number;
    z: number;
    // Direction it falls towards; 0/0 while standing
    fallX: number;
    fallZ: number;
    fall: number;
}

let world: SimWorld;
const dummies: Dummy[] = [];
const cones: Cone[] = [];

function damp(rate: number, dt: number): number {
    return 1 - Math.exp(-rate * Math.min(dt, 0.1));
}

function mesh(geometry: THREE.BufferGeometry, color: number, shadows = true): THREE.Mesh {
    const result = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 0.85 }));
    result.castShadow = shadows;
    result.receiveShadow = true;
    return result;
}

// Wedge rising along local +z from 0 at the rear to height at the front,
// turned by the ramp's yaw like the sim's ramp surface
function rampMesh(ramp: RampDef): THREE.Mesh {
    const w = ramp.width / 2, l = ramp.length / 2, h = ramp.height;
    const a = [-w, 0, -l], b = [w, 0, -l];
    const c = [-w, h, l], d = [w, h, l];
    const e = [-w, 0, l], f = [w, 0, l];
    const triangles = [
        a, d, b, a, c, d,       // slope
        e, f, d, e, d, c,       // front face
        a, e, c,                // left side
        b, d, f                 // right side
    ];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(triangles.flat(), 3));
    geometry.computeVertexNormals();
    const result = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
        color: 0xE0A040, roughness: 0.8, side: THREE.DoubleSide
    }));
    result.castShadow = true;
    result.receiveShadow = true;
    result.position.set(ramp.x, 0, ramp.z);
    result.rotation.y = ramp.yaw;
    return result;
}

function boxMesh(box: SandboxBox, color: number): THREE.Mesh {
    const result = mesh(new THREE.BoxGeometry(box.hw * 2, box.height, box.hd * 2), color);
    result.position.set(box.x, box.height / 2, box.z);
    return result;
}

function coneMesh(): THREE.Group {
    const group = new THREE.Group();
    const body = mesh(new THREE.ConeGeometry(0.35, 0.8, 14), 0xFF6F00);
    body.position.y = 0.4;
    const band = mesh(new THREE.CylinderGeometry(0.2, 0.25, 0.14, 14), 0xFFFFFF, false);
    band.position.y = 0.45;
    const base = mesh(new THREE.BoxGeometry(0.7, 0.05, 0.7), 0xFF6F00);
    base.position.y = 0.025;
    group.add(body, band, base);
    return group;
}

function buildScene(): void {
    const scene = state.scene;
    // Grass to the world border a little below the pad, asphalt pad on top.
    // The polygon offsets keep pad and paint in front even with a coarse
    // depth buffer (software WebGL, some phones).
    const grass = new THREE.Mesh(
        new THREE.PlaneGeometry(SANDBOX_TERRAIN.size, SANDBOX_TERRAIN.size).rotateX(-Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: 0x5A9C4F, roughness: 0.95 })
    );
    grass.position.y = -0.1;
    grass.receiveShadow = true;
    scene.add(grass);
    const pad = new THREE.Mesh(
        new THREE.PlaneGeometry(SANDBOX_PAD_SIZE, SANDBOX_PAD_SIZE).rotateX(-Math.PI / 2),
        new THREE.MeshStandardMaterial({
            color: 0x4A4F55, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1
        })
    );
    pad.receiveShadow = true;
    scene.add(pad);

    // Paint: start line and the curves
    const paint = new THREE.MeshBasicMaterial({
        color: 0xF2F2F2, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4
    });
    const start = new THREE.Mesh(new THREE.PlaneGeometry(12, 0.6).rotateX(-Math.PI / 2), paint);
    start.position.set(SANDBOX.spawn.x, 0.02, SANDBOX.spawn.z + 4);
    scene.add(start);
    for (const curve of SANDBOX.curves) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(curve.radius - 0.2, curve.radius + 0.2, 128).rotateX(-Math.PI / 2), paint);
        ring.position.set(curve.x, 0.02, curve.z);
        scene.add(ring);
    }

    for (const ramp of SANDBOX.ramps) scene.add(rampMesh(ramp));
    for (const wall of SANDBOX.walls) scene.add(boxMesh(wall, 0xB8BEC6));
    SANDBOX.buildings.forEach((building, index) => scene.add(boxMesh(building, BUILDING_COLORS[index % BUILDING_COLORS.length])));
    for (const post of SANDBOX.posts) {
        const pole = mesh(new THREE.CylinderGeometry(post.r, post.r, post.top, 10), 0xE53935);
        pole.position.set(post.x, post.top / 2, post.z);
        scene.add(pole);
    }
    for (const spot of SANDBOX.cones) {
        const cone: Cone = { mesh: coneMesh(), x: spot.x, z: spot.z, fallX: 0, fallZ: 0, fall: 0 };
        cone.mesh.position.set(spot.x, 0.02, spot.z);
        cones.push(cone);
        scene.add(cone.mesh);
    }
}

function createDummies(): void {
    SANDBOX.dummies.forEach((spec, index) => {
        const car = createDummy(spec, world);
        const model = new CarModel(DUMMY_COLORS[index % DUMMY_COLORS.length], spec.classId);
        if (model.shieldMesh) model.shieldMesh.visible = false;
        state.scene.add(model.group);
        const dummy: Dummy = {
            spec, car, model,
            prev: copyVehicleState(createVehicleState(), car.state),
            tag: new Nametag(`DUMMY ${spec.classId.toUpperCase()}`)
        };
        dummies.push(dummy);
    });
    gameHooks.extraCars.push(...dummies.map(dummy => dummy.car));
    gameHooks.extraModels.push(...dummies.map(dummy => dummy.model));
}

// Dummies and cones back to their spots
export function resetSandbox(): void {
    for (const dummy of dummies) {
        resetDummy(dummy.car, dummy.spec, world);
        copyVehicleState(dummy.prev, dummy.car.state);
    }
    for (const cone of cones) {
        cone.fall = cone.fallX = cone.fallZ = 0;
        cone.mesh.position.set(cone.x, 0.02, cone.z);
        cone.mesh.rotation.set(0, 0, 0);
    }
}

function beforeTick(): void {
    for (const dummy of dummies) {
        copyVehicleState(dummy.prev, dummy.car.state);
        driveDummy(dummy.car, dummy.spec);
    }
}

function knockCones(x: number, z: number, vx: number, vz: number): void {
    for (const cone of cones) {
        if (cone.fall > 0 || Math.hypot(cone.x - x, cone.z - z) > CONE_HIT_RADIUS) continue;
        const speed = Math.hypot(vx, vz);
        // Falls along the car's travel direction, away from its centre when slow
        const dx = speed > 1 ? vx / speed : cone.x - x;
        const dz = speed > 1 ? vz / speed : cone.z - z;
        const length = Math.hypot(dx, dz) || 1;
        cone.fallX = dx / length;
        cone.fallZ = dz / length;
        cone.fall = 0.001;
    }
}

function renderDummies(dt: number, alpha: number): void {
    for (const dummy of dummies) {
        const s = dummy.car.state, p = dummy.prev;
        const x = p.x + (s.x - p.x) * alpha;
        const z = p.z + (s.z - p.z) * alpha;
        const ground = world.groundHeight(x, z);
        const group = dummy.model.group;
        group.position.set(x, ground, z);
        group.rotation.y = p.yaw + (s.yaw - p.yaw) * alpha;
        group.scale.setScalar(p.scale + (s.scale - p.scale) * alpha);
        dummy.model.flipGroup.position.y = Math.max(0, p.y + (s.y - p.y) * alpha - ground);
        const flip = s.flipAngle > 0 && p.flipAngle <= s.flipAngle ? p.flipAngle + (s.flipAngle - p.flipAngle) * alpha : 0;
        dummy.model.flipGroup.rotation.x = flip % TWO_PI;
        const u = s.vx * Math.sin(s.yaw) + s.vz * Math.cos(s.yaw);
        dummy.model.setDriveState(u, s.steerAngle, dummy.car.input.brake > 20 && u > 0.5);
        if (state.camera) dummy.tag.update(group.position, state.camera, dummy.model.nametagHeight * group.scale.y);
        knockCones(x, z, s.vx, s.vz);
    }
}

function renderCones(dt: number): void {
    for (const cone of cones) {
        if (cone.fall <= 0 || cone.fall >= 1) continue;
        cone.fall = Math.min(1, cone.fall + (1 - cone.fall) * damp(CONE_FALL_RATE, dt) + 0.01);
        // Tip about the horizontal axis across the fall direction
        const angle = cone.fall * Math.PI / 2;
        cone.mesh.rotation.set(cone.fallZ * angle, 0, -cone.fallX * angle);
        cone.mesh.position.set(cone.x + cone.fallX * cone.fall * 0.8, 0.02, cone.z + cone.fallZ * cone.fall * 0.8);
    }
}

function frame(dt: number): void {
    const vehicle: LocalVehicle | undefined = state.bulli?.vehicle;
    renderDummies(dt, vehicle?.alpha ?? 1);
    if (vehicle) {
        const s = vehicle.car.state;
        knockCones(vehicle.pose.x, vehicle.pose.z, s.vx, s.vz);
    }
    renderCones(dt);
}

// Rebuilds the local car with another body where it stands
export function switchCar(carType: CarType): void {
    const old: Bulli | null = state.bulli;
    if (!old || old.carType === carType) return;
    const position = old.group.position.clone();
    const angle = old.angle;
    state.scene.remove(old.group);
    old.dispose();
    const car = new Bulli(state.myColor ?? PLAYER_COLOR, true, carType);
    car.group.position.copy(position);
    car.angle = angle;
    car.group.rotation.y = angle;
    car.createNametag(state.myName, true);
    state.scene.add(car.group);
    state.bulli = car;
    state.myCarType = carType;
    try {
        localStorage.setItem('bulli-car-type', carType);
    } catch { /* storage blocked */ }
}

function nextCar(): void {
    const current = CAR_CLASS_IDS.indexOf(state.bulli?.carType);
    switchCar(CAR_CLASS_IDS[(current + 1) % CAR_CLASS_IDS.length]);
}

function onKeyDown(event: KeyboardEvent): void {
    if (event.repeat || state.isModalOpen) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('input, textarea, select, .lil-gui')) return;
    const key = event.key.toLowerCase();
    if (key === 'n') resetSandbox();
    else if (key === 'c') nextCar();
}

function banner(): void {
    const element = document.createElement('div');
    element.id = 'sandbox-banner';
    const title = document.createElement('span');
    title.className = 'sandbox-title';
    title.textContent = 'SANDBOX';
    element.appendChild(title);
    const button = (label: string, key: string, action: () => void) => {
        const control = document.createElement('button');
        control.type = 'button';
        control.innerHTML = `<span class="key">${key}</span> ${label}`;
        control.addEventListener('click', () => {
            action();
            // Space must reach the car, not re-press this button
            control.blur();
        });
        element.appendChild(control);
    };
    button('Reset dummies', 'N', resetSandbox);
    button('Switch car', 'C', nextCar);
    document.getElementById('ui-overlay')?.appendChild(element);
}

// Test hook (?e2e=1): dummies and the golden scenarios in the browser (14.4)
export interface SandboxDummySnapshot {
    id: string;
    classId: string;
    x: number;
    z: number;
    yaw: number;
    speed: number;
}

function installE2EHook(): void {
    if (new URLSearchParams(window.location.search).get('e2e') !== '1') return;
    (window as unknown as { __bulliSim: unknown }).__bulliSim = {
        dummies(): SandboxDummySnapshot[] {
            return dummies.map(({ car, spec }) => ({
                id: car.id,
                classId: spec.classId,
                x: car.state.x,
                z: car.state.z,
                yaw: car.state.yaw,
                speed: Math.hypot(car.state.vx, car.state.vz)
            }));
        },
        resetDummies: resetSandbox,
        scenarios(): string[] {
            return SIM_SCENARIOS.map(scenario => scenario.name);
        },
        runGolden(name: string): ScenarioFrame[] {
            if (!tuningIsDefault()) throw new Error('goldens need the default tuning');
            return recordScenario(findScenario(name));
        }
    };
}

export function startSandbox(): void {
    document.body.classList.add('sandbox');
    state.terrainConfig = { ...SANDBOX_TERRAIN };
    world = createSandboxWorld();
    gameHooks.world = world;
    buildScene();
    createDummies();
    gameHooks.beforeTick.push(beforeTick);
    gameHooks.frame.push(frame);
    gameHooks.tuningChanged.push(() => {
        for (const dummy of dummies) refreshCarParams(dummy.car, dummy.spec.classId, 'standard');
    });

    let name = 'Sandbox';
    try {
        name = localStorage.getItem('bulli-player-name') || name;
    } catch { /* storage blocked */ }
    createLocalPlayer(PLAYER_COLOR, name, SANDBOX.spawn);
    removeLoader();

    window.addEventListener('keydown', onKeyDown);
    banner();
    installE2EHook();
}
