// Layout of the v2 physics sandbox (?sandbox=1, docs/phase-1a-design.md,
// 12.7): a flat test pad with ramps, a jump with a landing hill, a long wall
// to slide along, a post row, a cone slalom, painted curves, a 90° city
// corner and dummy cars to bump into. The collision data lives here so the
// Node tests drive through the very same world the browser builds.

import type { TerrainConfig } from '../protocol.js';
import type { CarClassId } from '../sim/types.js';
import { createSimWorld, rampEdgeColliders, type BoxOrCircleInput as ColliderInput, type RampDef, type SimWorld } from './colliders.js';

// A ramp of the sandbox. hill marks the two halves of a hill, which get no
// wall along their high edge where they meet.
export type SandboxRamp = RampDef & { hill?: boolean };

const DEG = Math.PI / 180;

// Flat ground of the default world size: the border stays at ±498
export const SANDBOX_TERRAIN: TerrainConfig = {
    size: 1000,
    segments: 1,
    frequency1: 0,
    amplitude1: 0,
    frequency2: 0,
    amplitude2: 0,
    frequency3: 0,
    amplitude3: 0
};

// Asphalt pad around the origin (m); everything below stands on it
export const SANDBOX_PAD_SIZE = 400;

export type DummyBehaviour =
    | { kind: 'parked' }
    // Laps the circle (cx, cz, radius) counter-clockwise seen from above
    // (+x right, +z up) at about speed m/s
    | { kind: 'circle'; cx: number; cz: number; radius: number; speed: number };

export interface DummySpec {
    id: string;
    classId: CarClassId;
    x: number;
    z: number;
    yaw: number;
    behaviour: DummyBehaviour;
}

// Box colliders with the height they are drawn with (top may be Infinity)
export type SandboxBox = Extract<ColliderInput, { kind: 'box' }> & { height: number };

export interface SandboxLayout {
    spawn: { x: number; z: number; yaw: number };
    ramps: SandboxRamp[];
    walls: SandboxBox[];
    buildings: SandboxBox[];
    posts: Extract<ColliderInput, { kind: 'circle' }>[];
    // Visual only: cones tip over, the curves are paint
    cones: { x: number; z: number }[];
    curves: { x: number; z: number; radius: number }[];
    dummies: DummySpec[];
}

// A kicker of the given slope, 8 m wide, rising towards +z
function kicker(x: number, z: number, slopeDeg: number, length: number): RampDef {
    return { x, z, yaw: 0, width: 8, length, height: length * Math.tan(slopeDeg * DEG) };
}

function range(count: number, first: number, step: number): number[] {
    return Array.from({ length: count }, (_, index) => first + index * step);
}

const CURVE_CENTRE = { x: 110, z: 110 };

export const SANDBOX: SandboxLayout = {
    // Facing +z down the start straight
    spawn: { x: 0, z: -160, yaw: 0 },
    ramps: [
        // Three kickers side by side, 10°, 15° and 20°
        kicker(-25, -90, 10, 16),
        kicker(0, -90, 15, 14),
        kicker(25, -90, 20, 12),
        // Jump with a landing hill: kicker, 16 m gap, then a hill 3 m high
        // with a short steep face and a long landing slope behind its crest
        { x: 70, z: -120, yaw: 0, width: 8, length: 16, height: 3 },
        { x: 70, z: -93, yaw: 0, width: 10, length: 6, height: 3, hill: true },
        { x: 70, z: -78, yaw: Math.PI, width: 10, length: 24, height: 3, hill: true }
    ],
    walls: [
        // Long wall to slide along, 1 m thick, from z = -190 to 30
        { kind: 'box', x: -60, z: -80, hw: 0.5, hd: 110, top: Infinity, height: 2.5 }
    ],
    buildings: [
        // 90° city corner: a road 12 m wide comes up from the south at
        // x = -146 and turns east at z = 146 around the inner block
        { kind: 'box', x: -110, z: 110, hw: 30, hd: 30, top: Infinity, height: 16 },
        { kind: 'box', x: -164, z: 110, hw: 12, hd: 42, top: Infinity, height: 22 },
        { kind: 'box', x: -110, z: 164, hw: 54, hd: 12, top: Infinity, height: 12 }
    ],
    // Post row (r 0.35 like a sign post) across the way, 2.5 m apart: too
    // narrow for any car, the tunneling check of section 7.3
    posts: range(13, -45, 2.5).map(x => ({ kind: 'circle' as const, x, z: 0, r: 0.35, top: 3.3 })),
    cones: range(9, 20, 15).map(z => ({ x: 0, z })),
    curves: [
        { ...CURVE_CENTRE, radius: 40 },
        { ...CURVE_CENTRE, radius: 80 }
    ],
    dummies: [
        // Parked in a row east of the start, noses towards the start straight
        { id: 'dummy-pickup', classId: 'pickup', x: 40, z: -175, yaw: -Math.PI / 2, behaviour: { kind: 'parked' } },
        { id: 'dummy-beetle', classId: 'beetle', x: 40, z: -160, yaw: -Math.PI / 2, behaviour: { kind: 'parked' } },
        { id: 'dummy-jeep', classId: 'jeep', x: 40, z: -145, yaw: -Math.PI / 2, behaviour: { kind: 'parked' } },
        // Lapping the painted curves
        {
            id: 'dummy-sport', classId: 'sport', x: CURVE_CENTRE.x, z: CURVE_CENTRE.z - 40, yaw: Math.PI / 2,
            behaviour: { kind: 'circle', cx: CURVE_CENTRE.x, cz: CURVE_CENTRE.z, radius: 40, speed: 14 }
        },
        {
            id: 'dummy-bulli', classId: 'bulli', x: CURVE_CENTRE.x, z: CURVE_CENTRE.z + 80, yaw: -Math.PI / 2,
            behaviour: { kind: 'circle', cx: CURVE_CENTRE.x, cz: CURVE_CENTRE.z, radius: 80, speed: 20 }
        }
    ]
};

// Every static collider of the sandbox, in a fixed order
export function sandboxColliders(layout: SandboxLayout = SANDBOX): ColliderInput[] {
    const strip = ({ height: _height, ...collider }: SandboxBox): ColliderInput => collider;
    return [
        ...layout.walls.map(strip),
        ...layout.buildings.map(strip),
        ...layout.posts.map(post => ({ ...post })),
        ...layout.ramps.flatMap((ramp, index) => rampEdgeColliders(ramp, index, !ramp.hill))
    ];
}

// The sandbox's sim world. No road grid: a reset stays where it is.
export function createSandboxWorld(layout: SandboxLayout = SANDBOX): SimWorld {
    const ramps = layout.ramps.map(({ hill: _hill, ...ramp }): RampDef => ramp);
    return createSimWorld(SANDBOX_TERRAIN, sandboxColliders(layout), ramps);
}
