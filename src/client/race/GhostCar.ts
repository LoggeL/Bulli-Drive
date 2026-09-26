import { createGhostPose } from '../../shared/race/ghostTrack.js';
import { formatRaceTime } from '../../shared/race/timing.js';
import { isCarClassId } from '../../shared/sim/vehicleClasses.js';
import { state } from '../state.js';
import { CarModel, type CarType } from '../vehicle/CarModel.js';
import { Nametag } from '../vehicle/Nametag.js';
import { groundHeight } from '../world/ground.js';
import type { GhostPlayback } from './ghostPlayback.js';

// The time trial ghost on screen (docs/phase-2-design.md, 15.4): a
// half-transparent car of its class along the pose track from the server,
// with the tag "GHOST 1:21.345". It takes no part in the sim.

const GHOST_COLOR = 0xbfe3ff;

export class GhostCar {
    readonly model: CarModel;
    private readonly tag: Nametag;
    private readonly pose = createGhostPose();
    private lastX = 0;
    private lastZ = 0;
    private placed = false;
    // Where it is (minimap)
    x = 0;
    z = 0;

    constructor(carType: string, finishTicks: number, private readonly playback: GhostPlayback) {
        const type = (isCarClassId(carType) ? carType : 'bulli') as CarType;
        this.model = new CarModel(GHOST_COLOR, type);
        this.model.ghostOpacity = { scale: 0.5, max: 0.5 };
        this.model.setGhostVisual(true);
        this.model.group.name = 'race-ghost';
        state.scene?.add(this.model.group);
        this.tag = new Nametag(`GHOST ${formatRaceTime(finishTicks)}`);
        this.tag.element.classList.add('nametag-ghost');
    }

    /** Poses the ghost for render tick t (float) after a frame of dt seconds. */
    update(t: number, dt: number): void {
        const pose = this.playback.sample(t, this.pose);
        const group = this.model.group;
        const ground = groundHeight(pose.x, pose.z);
        group.position.set(pose.x, ground, pose.z);
        group.rotation.y = pose.yaw;
        this.model.bodyGroup.position.y = Math.max(0, pose.y - ground);
        const speed = this.placed && dt > 0 ? Math.hypot(pose.x - this.lastX, pose.z - this.lastZ) / dt : 0;
        this.model.setDriveState(Math.min(speed, 80), 0, false);
        this.placed = true;
        this.lastX = this.x = pose.x;
        this.lastZ = this.z = pose.z;
        // The tag goes once the run is over (the ghost waits at the finish)
        if (this.playback.finished(t)) this.tag.hide();
        else if (state.camera) this.tag.update(group.position, state.camera, this.model.nametagHeight);
    }

    dispose(): void {
        this.model.group.removeFromParent();
        this.model.dispose();
        this.tag.remove();
    }
}

