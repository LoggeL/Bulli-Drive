import { SIM_TUNING, V_SAFE } from '../../shared/sim/constants.js';
import type { SimCar } from '../../shared/sim/types.js';
import { createSimCar } from '../../shared/sim/vehicle.js';
import { isCarClassId } from '../../shared/sim/vehicleClasses.js';
import type { SimWorld } from '../../shared/world/colliders.js';
import { state } from '../state.js';

// Remote players as kinematic contact partners of the local v2 car
// (docs/phase-1a-design.md, 8.5). The protocol is unchanged in 1a, so each
// proxy follows the 20 Hz position updates; only the local car is pushed.
// Real two-sided contact comes with the server sim in 1b.

// Updates that come faster than this still count as this far apart
const MIN_UPDATE_GAP = 0.03;
// The pose is extrapolated along the estimated velocity at most this long
const MAX_EXTRAPOLATION = 0.1;
// Older samples no longer count as moving (stationary cars send once a second)
const STALE_AFTER = 0.25;
// A jump farther than this between two updates is a respawn/teleport
const TELEPORT_DISTANCE = 20;
const VELOCITY_BLEND = 0.5;
const MEGA_FROM_SCALE = 1.5;

interface ProxyTrack {
    car: SimCar;
    x: number;
    z: number;
    // Height above the ground as reported (jump height)
    lift: number;
    yaw: number;
    vx: number;
    vz: number;
    yawRate: number;
    // performance.now() of the last update, -1 before the first
    receivedAt: number;
}

const tracks = new Map<string, ProxyTrack>();

interface RemoteCarLike {
    carType?: string;
    group: { position: { x: number; z: number }; rotation: { y: number }; scale: { x: number } };
    flipGroup: { visible: boolean; position: { y: number } };
    powerups?: { ghost?: { active: boolean }; shield?: { active: boolean } };
}

function wrapAngle(angle: number): number {
    return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function createTrack(id: string, remote: RemoteCarLike): ProxyTrack {
    const car = createSimCar(id, isCarClassId(remote.carType) ? remote.carType : 'bulli');
    car.kinematic = true;
    car.contactScale = SIM_TUNING.PROXY_CONTACT_SCALE;
    return {
        car,
        x: remote.group.position.x,
        z: remote.group.position.z,
        lift: remote.flipGroup.position.y,
        yaw: remote.group.rotation.y,
        vx: 0,
        vz: 0,
        yawRate: 0,
        receivedAt: -1
    };
}

/** Called for every 'update' of a remote player, after its model moved. */
export function noteRemoteUpdate(id: string, remote: RemoteCarLike, now: number): void {
    let track = tracks.get(id);
    if (!track) {
        track = createTrack(id, remote);
        tracks.set(id, track);
    }
    const x = remote.group.position.x;
    const z = remote.group.position.z;
    const yaw = remote.group.rotation.y;
    if (track.receivedAt >= 0) {
        const gap = Math.max(MIN_UPDATE_GAP, (now - track.receivedAt) / 1000);
        const dx = x - track.x, dz = z - track.z;
        if (Math.hypot(dx, dz) > TELEPORT_DISTANCE) {
            track.vx = track.vz = track.yawRate = 0;
        } else {
            track.vx += (dx / gap - track.vx) * VELOCITY_BLEND;
            track.vz += (dz / gap - track.vz) * VELOCITY_BLEND;
            track.yawRate += (wrapAngle(yaw - track.yaw) / gap - track.yawRate) * VELOCITY_BLEND;
            const speed = Math.hypot(track.vx, track.vz);
            if (speed > V_SAFE) {
                track.vx *= V_SAFE / speed;
                track.vz *= V_SAFE / speed;
            }
            const maxRate = SIM_TUNING.R_MAX;
            track.yawRate = Math.max(-maxRate, Math.min(maxRate, track.yawRate));
        }
    }
    track.x = x;
    track.z = z;
    track.yaw = yaw;
    track.lift = remote.flipGroup.position.y;
    track.receivedAt = now;
}

export function removeRemoteProxy(id: string): void {
    tracks.delete(id);
}

/**
 * Puts every visible remote player into out as a kinematic sim car, posed
 * at its last update plus a short extrapolation. out keeps its other
 * entries (the local car). Tracks of players that left are dropped.
 */
export function collectRemoteProxies(now: number, world: SimWorld, out: SimCar[]): void {
    for (const id of tracks.keys()) {
        if (!state.remotePlayers[id]) tracks.delete(id);
    }
    for (const id in state.remotePlayers) {
        const remote = state.remotePlayers[id] as unknown as RemoteCarLike;
        // Dead players are hidden until they respawn
        if (!remote.flipGroup.visible) continue;
        let track = tracks.get(id);
        if (!track) {
            track = createTrack(id, remote);
            tracks.set(id, track);
        }
        const age = track.receivedAt < 0 ? Infinity : (now - track.receivedAt) / 1000;
        const moving = age <= STALE_AFTER;
        const ahead = moving ? Math.min(age, MAX_EXTRAPOLATION) : 0;
        const car = track.car;
        const s = car.state;
        s.x = track.x + (moving ? track.vx : 0) * ahead;
        s.z = track.z + (moving ? track.vz : 0) * ahead;
        s.yaw = track.yaw + (moving ? track.yawRate : 0) * ahead;
        s.y = world.groundHeight(s.x, s.z) + Math.max(0, track.lift);
        s.vx = moving ? track.vx : 0;
        s.vz = moving ? track.vz : 0;
        s.vy = 0;
        s.yawRate = moving ? track.yawRate : 0;
        const scale = remote.group.scale.x;
        s.scale = Number.isFinite(scale) && scale > 0 ? scale : 1;
        car.mods.mega = s.scale > MEGA_FROM_SCALE;
        car.mods.shield = remote.powerups?.shield?.active ?? false;
        car.mods.ghost = remote.powerups?.ghost?.active ?? false;
        out.push(car);
    }
}

// Test/debug view of the proxies
export function remoteProxyCount(): number {
    return tracks.size;
}
