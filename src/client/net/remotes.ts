import * as THREE from 'three';
import {
    CAR_GHOST, CAR_GROUNDED, CAR_IDLE, CAR_MEGA, CAR_RACE_GHOST, CAR_RESPAWN_SHIELD, CAR_SHIELD, CAR_TURBO, type Snapshot
} from '../../shared/net/codec.js';
import { AdaptiveDelay, createRemotePose, RemoteTrack, type RemotePose } from '../../shared/net/interpolation.js';
import type { PredictedRemote } from '../../shared/net/prediction.js';
import type { Bulli } from '../entities/Bulli.js';
import { state } from '../state.js';
import { BodyMotion, type BodyMotionInput } from '../vehicle/bodyMotion.js';
import { groundHeight } from '../world/ground.js';
import { netDriver } from './netDriver.js';

// Remote cars on screen (docs/phase-1b-design.md, 8.6): far ones follow
// their snapshots 100 ms in the past (Hermite, a short extrapolation), the
// ones in the contact set show their predicted pose, so a bump looks the
// way it feels. Entering and leaving the contact set blends over 300 ms.
// Corrections of either fade out as render offsets (shared/net).
// Idle cars turn grey with "ZZZ" (the flag replaces the old AFK guess).

const BLEND_MS = 300;
const TWO_PI = Math.PI * 2;
// A car missing from the snapshots this long is hidden (dead, gone)
const MISSING_HIDE_TICKS = 30;

interface RemoteView {
    track: RemoteTrack;
    // 0 = interpolated, 1 = predicted (contact set)
    blend: number;
    flags: number;
    idleShown: boolean;
    dead: boolean;
    lastSeenTick: number;
    // Forward speed of the last frame (m/s), for the brake lights
    lastSpeed: number;
    // Body height, pitch, roll and wheels on screen
    body: BodyMotion;
}

// Slowing down faster than this (m/s²) going forwards lights the brake lights
const BRAKE_LIGHT_DECEL = 6;

const views = new Map<string, RemoteView>();
const pose: RemotePose = createRemotePose();
const bodyInput: BodyMotionInput = {
    x: 0, z: 0, yaw: 0, airHeight: 0, grounded: true, susp: 0, vy: 0, speed: 0, horizontalSpeed: 0, loadX: 0, yawRate: 0
};
const delay = new AdaptiveDelay();

function wrapAngle(angle: number): number {
    return angle - TWO_PI * Math.floor((angle + Math.PI) / TWO_PI);
}

function viewOf(id: string): RemoteView {
    let view = views.get(id);
    if (!view) {
        view = {
            track: new RemoteTrack(), blend: 0, flags: 0, idleShown: false, dead: false, lastSeenTick: -1, lastSpeed: 0,
            body: new BodyMotion()
        };
        views.set(id, view);
    }
    return view;
}

export function forgetRemote(id: string): void {
    views.delete(id);
}

export function clearRemoteViews(): void {
    views.clear();
}

/** The car is dead (hidden) or back (a respawn: no blending from the old spot). */
export function setRemoteDead(id: string, dead: boolean): void {
    const view = viewOf(id);
    view.dead = dead;
    if (!dead) {
        view.track.clear();
        view.body.reset();
    }
    const remote = state.remotePlayers[id] as unknown as Bulli | undefined;
    if (remote) remote.bodyGroup.visible = !dead;
}

/** Every car of a snapshot into its sample buffer. */
export function noteSnapshotCars(snap: Snapshot): void {
    for (const car of snap.cars) {
        const id = netDriver.idForSlot(car.slot);
        if (!id || id === state.myId) continue;
        const view = viewOf(id);
        view.track.push(snap.serverTick, car);
        view.flags = car.flags;
        view.lastSeenTick = snap.serverTick;
    }
}

function predictedById(id: string): PredictedRemote | null {
    const prediction = netDriver.prediction;
    if (!prediction) return null;
    for (const remote of prediction.remotes.values()) if (remote.id === id) return remote;
    return null;
}

function setIdleLook(remote: Bulli, idle: boolean): void {
    // Grey car: the model's own material copies, never shared ones
    remote.setAfkVisual(idle);
    const tag = remote.nametag;
    if (!tag) return;
    tag.style.opacity = idle ? '0.4' : '';
    const badge = tag.querySelector('.afk-badge');
    if (idle && !badge) {
        const nameEl = tag.querySelector('.nametag-name');
        const span = document.createElement('span');
        span.className = 'afk-badge';
        span.textContent = ' ZZZ';
        nameEl?.appendChild(span);
    } else if (!idle && badge) {
        badge.remove();
    }
}

/**
 * Poses every remote car for this frame. alpha: how far the local car's
 * next tick has come (the predicted remotes are interpolated with it).
 */
export function updateRemoteCars(dt: number, now: number, alpha: number): void {
    const renderTick = netDriver.clock.ready ? netDriver.clock.serverTickAt(now) - delay.delay : -1;
    let anyExtrapolated = false;
    const step = Math.max(0, dt) * 1000 / BLEND_MS;
    for (const id in state.remotePlayers) {
        const remote = state.remotePlayers[id] as unknown as Bulli;
        const view = viewOf(id);
        if (view.dead) {
            remote.bodyGroup.visible = false;
            continue;
        }
        if (!view.track.newest || renderTick < 0) continue;
        const newestTick = view.track.newest.tick;
        const missing = netDriver.prediction ? netDriver.prediction.lastSnapshotTick - newestTick : 0;
        remote.bodyGroup.visible = missing < MISSING_HIDE_TICKS;
        view.track.decay(dt * 1000);
        if (!view.track.sample(renderTick, pose)) continue;
        if (pose.extrapolated) anyExtrapolated = true;

        const predicted = predictedById(id);
        view.blend = predicted ? Math.min(1, view.blend + step) : Math.max(0, view.blend - step);
        if (view.track.teleported) {
            view.track.teleported = false;
            view.blend = predicted ? 1 : 0;
            view.body.reset();
        }
        let x = pose.x, y = pose.y, z = pose.z, yaw = pose.yaw;
        let steer = pose.car?.steerAngle ?? 0;
        let scale = pose.car?.scale ?? 1;
        let speed = pose.speed;
        let susp = pose.susp, vy = pose.vy;
        let grounded = ((pose.car?.flags ?? CAR_GROUNDED) & CAR_GROUNDED) !== 0;
        let vx = pose.car?.vx ?? 0, vz = pose.car?.vz ?? 0;
        if (predicted && view.blend > 0) {
            // The predicted pose plus its own offset from the snapshots
            const a = predicted.prev, b = predicted.car.state, w = view.blend, o = predicted.offset;
            const px = a.x + (b.x - a.x) * alpha + o.x;
            const py = a.y + (b.y - a.y) * alpha + o.y;
            const pz = a.z + (b.z - a.z) * alpha + o.z;
            const pyaw = a.yaw + wrapAngle(b.yaw - a.yaw) * alpha + o.yaw;
            x += (px - x) * w;
            y += (py - y) * w;
            z += (pz - z) * w;
            yaw = yaw + wrapAngle(pyaw - yaw) * w;
            steer = b.steerAngle;
            scale = b.scale;
            speed = b.vx * Math.sin(b.yaw) + b.vz * Math.cos(b.yaw);
            const ps = a.susp + (b.susp - a.susp) * alpha, pvy = a.vy + (b.vy - a.vy) * alpha;
            susp += (ps - susp) * w;
            vy += (pvy - vy) * w;
            if (w >= 0.5) {
                grounded = b.grounded;
                vx = b.vx;
                vz = b.vz;
            }
        }
        const ground = groundHeight(x, z);
        const shownScale = Number.isFinite(scale) ? Math.max(0.5, Math.min(4, scale)) : 1;
        remote.group.position.set(x, ground, z);
        remote.group.rotation.order = 'YXZ';
        remote.group.rotation.y = yaw;
        remote.group.scale.setScalar(shownScale);
        // Ground tilt, body on its springs and in the air (vehicle/bodyMotion.ts)
        bodyInput.x = x;
        bodyInput.z = z;
        bodyInput.yaw = yaw;
        bodyInput.airHeight = y - ground;
        bodyInput.grounded = grounded;
        bodyInput.susp = susp;
        bodyInput.vy = vy;
        bodyInput.speed = speed;
        bodyInput.horizontalSpeed = Math.hypot(vx, vz);
        view.body.update(dt, bodyInput, groundHeight);
        remote.setBodyPose(view.body, shownScale);
        remote.angle = yaw;
        remote.speed = speed / 60;
        // Wheels and brake lights (CarModel rolls them each frame): the
        // brake lights come on while the car slows down hard going forwards
        const slowing = dt > 0 ? (view.lastSpeed - speed) / dt : 0;
        view.lastSpeed = speed;
        remote.setDriveState(speed, steer, speed > 0.5 && slowing > BRAKE_LIGHT_DECEL);

        // Powerup looks and the idle grey from the flags
        const flags = view.flags;
        // A race ghost (wrong way, finished, DNF) looks like the Ghost powerup
        remote.powerups.ghost.active = (flags & (CAR_GHOST | CAR_RACE_GHOST)) !== 0;
        remote.powerups.shield.active = (flags & (CAR_SHIELD | CAR_RESPAWN_SHIELD)) !== 0;
        remote.powerups.size.active = (flags & CAR_MEGA) !== 0;
        remote.powerups.speed.active = (flags & CAR_TURBO) !== 0;
        const idle = (flags & CAR_IDLE) !== 0;
        if (idle !== view.idleShown) {
            view.idleShown = idle;
            setIdleLook(remote, idle);
        }
    }
    delay.frame(dt * 1000, anyExtrapolated);
}

/** The car flags of a remote car from its latest snapshot (0 before one). */
export function remoteFlags(id: string): number {
    return views.get(id)?.flags ?? 0;
}
