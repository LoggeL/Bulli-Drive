import { INPUT_FROZEN, INPUT_HIDDEN, type Snapshot } from '../../shared/net/codec.js';
import { NetClient } from '../../shared/net/client.js';
import type { ReconcileResult } from '../../shared/net/prediction.js';
import type { Pose } from '../../shared/net/renderOffset.js';
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
// keyboard, touch and gamepad (stop inputs while frozen) and the
// LocalVehicle it predicts, whose render pair the offsets are measured on.

export class NetDriver extends NetClient {
    private readonly input: VehicleInput = createVehicleInput();
    // The local car during a snapshot: its render pair is what is on screen
    private vehicle: LocalVehicle | null = null;

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
        const hidden = typeof document !== 'undefined' && document.hidden;
        const flags = (frozen ? INPUT_FROZEN : 0) | (hidden ? INPUT_HIDDEN : 0);
        // The server stops a frozen or hidden car too (Room.takeInput)
        if (frozen || hidden) stopInput(p.car.state, this.input);
        else inputManager.sampleTick(this.input);
        return this.tickWith(this.input, flags);
    }

    /**
     * A snapshot for the own car: lead control, the reconciliation, and the
     * difference to what was on screen as a fading render offset (the
     * shared NetClient does it against the LocalVehicle's render pair).
     */
    onSnapshot(snap: Snapshot, vehicle: LocalVehicle | null, now: number): ReconcileResult | null {
        this.vehicle = vehicle;
        try {
            return this.reconcileSnapshot(snap, now, vehicle ? vehicle.alpha : this.renderAlpha(now));
        } finally {
            this.vehicle = null;
        }
    }

    protected ownPose(alpha: number, withOffset: boolean, out: Pose): Pose {
        const vehicle = this.vehicle;
        if (!vehicle) return super.ownPose(alpha, withOffset, out);
        const pose = vehicle.renderPose(withOffset);
        out.x = pose.x; out.y = pose.y; out.z = pose.z; out.yaw = pose.yaw;
        return out;
    }

    protected afterReplay(): void {
        if (this.vehicle && this.prediction) this.vehicle.syncPrevFrom(this.prediction.prev);
    }
}

export const netDriver = new NetDriver();

// A throwaway car for the prediction until the local car exists
export function placeholderCar(id: string, carType: string): SimCar {
    return createSimCar(id, isCarClassId(carType) ? carType : 'bulli');
}
