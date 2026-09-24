import * as THREE from 'three';

// Wire DTOs and message types live in src/shared/protocol.ts; this file only
// holds client-side types.

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
}
