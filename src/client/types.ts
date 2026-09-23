import * as THREE from 'three';

// Wire DTOs and message types live in src/shared/protocol.ts; this file only
// holds client-side types.

// Collision obstacles in the XZ plane. Buildings are axis-aligned boxes
// (rect, AABB collision); trees / rocks / round props are circles. top is
// the height of the upper edge above the ground (COLLIDER_TOPS in
// shared/world/colliders.ts); only the v2 physics uses it, a car flying
// higher passes over. Missing means it cannot be jumped over.
export type Obstacle =
    | { type?: 'circle'; x: number; z: number; radius: number; top?: number }
    | { type: 'rect'; x: number; z: number; halfWidth: number; halfDepth: number; top?: number };

export interface RemotePlayer {
    id: string;
    group: THREE.Group;
    flipGroup: THREE.Group;
    name: string;
    colorCode: number;
    health: number;
    nametag?: HTMLElement;
    healthBarFill?: HTMLElement;
    shieldMesh?: THREE.Mesh;
    powerups: { ghost: { active: boolean; timer: number }; shield: { active: boolean; timer: number } };
    updateNametag(): void;
    honk(): void;
    dispose(): void;
}

export interface Inputs {
    /** Forward/reverse request in the normalized range [-1, 1]. */
    throttle: number;
    /** Left/right steering request in the normalized range [-1, 1]. */
    steer: number;
    e: boolean;
    f: boolean;
    space: boolean;
}
