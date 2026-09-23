import type { SimCar } from '../../shared/sim/types.js';
import type { SimWorld } from '../../shared/world/colliders.js';
import type { ChaseCamera } from '../camera/ChaseCamera.js';
import type { LocalVehicle } from '../vehicle/LocalVehicle.js';

// Extension points for the v2 sandbox (?sandbox=1) and the tuning panel
// (?tune=1), both loaded on demand. Module level, because the local car's
// LocalVehicle is only created with its first frame and rebuilt whenever
// the car is. Without those flags everything here stays empty.
export const gameHooks = {
    // Replaces the sim world built from the city obstacles
    world: null as SimWorld | null,
    // More dynamic cars stepped in the same stepWorld as the local car
    extraCars: [] as SimCar[],
    // Once per sim tick, right before and after stepWorld
    beforeTick: [] as Array<(vehicle: LocalVehicle) => void>,
    afterTick: [] as Array<(vehicle: LocalVehicle) => void>,
    // Once per frame after the local car moved, with the frame's dt (s)
    frame: [] as Array<(dt: number) => void>,
    // After the tuning panel changed class or profile values, so cars that
    // already exist pick them up (tuning.ts refreshCarParams)
    tuningChanged: [] as Array<() => void>,
    // The chase camera main.ts drives (profile switch in the panel)
    camera: null as ChaseCamera | null
};
