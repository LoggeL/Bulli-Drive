import { INPUT_FROZEN, INPUT_HIDDEN, type Snapshot } from '../../shared/net/codec.js';
import { NetClient } from '../../shared/net/client.js';
import { CONTACT_SMOOTH_MAX_MS, SMOOTH_TAU_MAX_MS, SMOOTH_TAU_MIN_MS } from '../../shared/net/constants.js';
import type { ReconcileResult } from '../../shared/net/prediction.js';
import { stopInput } from '../../shared/sim/inputs.js';
import { createVehicleInput, type SimCar, type VehicleInput } from '../../shared/sim/types.js';
import { createSimCar } from '../../shared/sim/vehicle.js';
import { isCarClassId } from '../../shared/sim/vehicleClasses.js';
import { inputManager } from '../input/InputManager.js';
import { sendBinary } from '../network/socket.js';
import { state } from '../state.js';
import { isWebGLContextLost } from '../ui/contextLoss.js';
import type { LocalVehicle } from '../vehicle/LocalVehicle.js';

// The local car on the server-authoritative netcode in the browser
// (docs/phase-1b-design.md, 8): the shared NetClient (clock, lead,
// prediction, input packets) plus what the page adds: the inputs from
// keyboard, touch and gamepad (stop inputs while frozen), the LocalVehicle
// it predicts, and the render offset that fades a correction out.

const TWO_PI = Math.PI * 2;
const OFFSET_EPSILON = 1e-3;

function wrapAngle(angle: number): number {
    return angle - TWO_PI * Math.floor((angle + Math.PI) / TWO_PI);
}

export class NetDriver extends NetClient {
    // Render offset of the own car (m, rad) and when a contact correction began
    readonly offset = { x: 0, y: 0, z: 0, yaw: 0 };
    private contactOffsetSince = -1;
    private readonly input: VehicleInput = createVehicleInput();
    // Set on every hard correction so the camera jumps too
    cameraSnap = false;

    constructor() {
        super(bytes => sendBinary(bytes));
    }

    bindCar(car: SimCar): void {
        this.prediction?.setCar(car);
    }

    /**
     * One fixed tick of the local car: sample (or stop, while frozen), store,
     * predict. Returns whether the car was simulated.
     */
    tickLocal(vehicle: LocalVehicle, _now: number): boolean {
        const p = this.prediction;
        if (!p || p.tick < 0) return false;
        if (p.car !== vehicle.car) p.setCar(vehicle.car);
        const frozen = state.isModalOpen || isWebGLContextLost();
        const flags = (frozen ? INPUT_FROZEN : 0) | (typeof document !== 'undefined' && document.hidden ? INPUT_HIDDEN : 0);
        if (frozen) stopInput(p.car.state, this.input);
        else inputManager.sampleTick(this.input);
        return this.tickWith(this.input, flags);
    }

    /**
     * A snapshot for the own car: lead control, the reconciliation, and the
     * difference to what was on screen as a fading render offset.
     */
    onSnapshot(snap: Snapshot, vehicle: LocalVehicle | null, now: number): ReconcileResult | null {
        // The rendered pose before the correction
        const before = vehicle ? vehicle.renderPose() : null;
        const result = this.reconcileSnapshot(snap, now);
        if (!result || result.matched || !vehicle || !this.prediction) return result;
        vehicle.syncPrevFrom(this.prediction.prev);
        if (result.snapped) {
            this.clearOffset();
            this.cameraSnap = true;
        } else if (before) {
            // Shown before (with the old offset) minus the new sim pose
            const after = vehicle.renderPose(false);
            this.offset.x = before.x - after.x;
            this.offset.y = before.y - after.y;
            this.offset.z = before.z - after.z;
            this.offset.yaw = wrapAngle(before.yaw - after.yaw);
            if (result.contact && this.contactOffsetSince < 0) this.contactOffsetSince = now;
        }
        return result;
    }

    clearOffset(): void {
        this.offset.x = this.offset.y = this.offset.z = this.offset.yaw = 0;
        this.contactOffsetSince = -1;
    }

    /** Fades the render offset out over 100-200 ms (at most 300 ms after a contact). */
    decayOffset(dtMs: number, now: number): void {
        const o = this.offset;
        const size = Math.hypot(o.x, o.y, o.z);
        if (size < OFFSET_EPSILON && Math.abs(o.yaw) < OFFSET_EPSILON) {
            this.clearOffset();
            return;
        }
        if (this.contactOffsetSince >= 0 && now - this.contactOffsetSince >= CONTACT_SMOOTH_MAX_MS) {
            this.clearOffset();
            return;
        }
        const tau = SMOOTH_TAU_MIN_MS + (SMOOTH_TAU_MAX_MS - SMOOTH_TAU_MIN_MS) * Math.min(1, size / 2);
        const k = Math.exp(-Math.max(0, dtMs) / tau);
        o.x *= k; o.y *= k; o.z *= k; o.yaw *= k;
    }

    spawnOwn(tick: number, x: number, z: number, yaw: number): void {
        super.spawnOwn(tick, x, z, yaw);
        this.clearOffset();
        this.cameraSnap = true;
    }

    despawnOwn(): void {
        super.despawnOwn();
        this.clearOffset();
    }
}

export const netDriver = new NetDriver();

// A throwaway car for the prediction until the local car exists
export function placeholderCar(id: string, carType: string): SimCar {
    return createSimCar(id, isCarClassId(carType) ? carType : 'bulli');
}
