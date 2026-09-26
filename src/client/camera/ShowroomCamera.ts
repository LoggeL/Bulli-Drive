import * as THREE from 'three';
import {
    cameraStateOf, directPose, fitDistance, SHOWROOM_FRAMING, SHOWROOM_SPOT, showroomPose, TRANSITION, transitionKind, transitionPose,
    type CameraState, type ShowroomFraming, type TransitionKind
} from './showroom.js';

// The menu's showroom (docs/ui.md 4.1) and the way from it into the game
// (6), on the game's own camera and renderer. While the menu is open the
// own car stands at the head of the pier (it is not in the sim before the
// spawn) and the camera swings slowly round it; the frame is shifted so
// the car sits in the free stage beside the menu's panels. DRIVE starts
// the crane: up into the sky, the cut to the spawn, down into the chase
// camera. The pure poses are in camera/showroom.ts; main.ts runs this once
// per frame after the chase camera, which meanwhile follows the car on a
// camera of its own (its damping starts from where it left the camera) and
// hands over at the end.

/** The own car as far as the showroom needs it (entities/Bulli.ts). */
export interface ShowroomCar {
    group: THREE.Group;
    bodyGroup: THREE.Group;
    angle: number;
    vehicle?: { place(x: number, z: number, yaw: number): void };
}

export interface ShowroomEnv {
    /** Ground height of the map (the pier deck at the spot); null before the map */
    groundHeight: ((x: number, z: number) => number) | null;
    /** The car stands where the menu puts it: not in the sim yet */
    carFree: () => boolean;
    /** The server spawned the own car (offline: always) */
    spawned: () => boolean;
    /** The free box the car stands in (the menu's stage), null for the framing's own */
    frame: () => { center: [number, number]; box: [number, number] } | null;
    /** Where the server will spawn the car, when known (the room's preview) */
    spawnHint: () => { x: number; z: number } | null;
    reducedMotion: () => boolean;
    lite: boolean;
    /** Phones draw the showroom at most this often (fps); 0 = every frame */
    maxFps: number;
    now?: () => number;
}

// A car swap in the showroom: down 0.3 m and gone, the new one comes up
const SWAP_S = 0.25;
const SWAP_DIP = 0.3;
// Lite graphics draw the showroom only this long after a change, then the frame stands
const LITE_SETTLE_MS = 700;
const DECK_FALLBACK = 5;

const _dir = new THREE.Vector3();
const _look = new THREE.Vector3();
const _size = new THREE.Vector2();

export class ShowroomCamera {
    /** Menu open: the showroom owns the camera and the car's place */
    active = true;
    private startedAt: number;
    private swapAt = -Infinity;
    private liteUntil = 0;
    private lastDrawAt = -Infinity;
    // The way into the game
    private transitionKind: TransitionKind | null = null;
    private transitionAt = 0;
    private from: CameraState | null = null;
    private cutAt = Infinity;
    private fade: HTMLCanvasElement | null = null;
    private fadeAt = Infinity;
    private captureStill = false;
    private stillTaken = false;
    private finished: (() => void) | null = null;
    private readonly now: () => number;

    constructor(private readonly env: ShowroomEnv) {
        this.now = env.now ?? (() => performance.now());
        this.startedAt = this.now();
        this.invalidate();
    }

    /** Whether the menu or the way into the game still owns the camera. */
    get busy(): boolean {
        return this.active || this.transitionKind !== null;
    }

    private framing(camera: THREE.PerspectiveCamera): ShowroomFraming {
        return camera.aspect < 1 ? SHOWROOM_FRAMING.portrait : SHOWROOM_FRAMING.landscape;
    }

    // The pose options for the menu's layout: centre and fitted distance
    private layout(camera: THREE.PerspectiveCamera): { center?: [number, number]; distance?: number } {
        const frame = this.env.frame();
        if (!frame) return {};
        return { center: frame.center, distance: fitDistance(this.framing(camera), frame.box, camera.aspect) };
    }

    private deckY(): number {
        return this.env.groundHeight?.(SHOWROOM_SPOT.x, SHOWROOM_SPOT.z) ?? DECK_FALLBACK;
    }

    /** Something in the frame changed (car, paint, layout): lite graphics draw again for a moment. */
    invalidate(): void {
        this.liteUntil = this.now() + LITE_SETTLE_MS;
    }

    /** The car changes: it dips and comes back (the new body swaps in at the bottom). */
    swapCar(): void {
        this.swapAt = this.now();
        this.invalidate();
    }

    /** How far the car is down in its swap right now (m). */
    private dip(now: number): number {
        const u = (now - this.swapAt) / 1000 / SWAP_S;
        if (u < 0 || u >= 1) return 0;
        // Down in the first half, up in the second
        return SWAP_DIP * Math.sin(Math.PI * u);
    }

    /**
     * Whether this frame is drawn: lite graphics only just after a change,
     * phones at most maxFps, else every frame. The game itself always draws.
     */
    shouldDraw(frameTime: number): boolean {
        if (!this.busy) return true;
        if (this.transitionKind) return true;
        if (this.env.lite && this.now() > this.liteUntil) return false;
        if (this.env.maxFps > 0 && frameTime - this.lastDrawAt < 1000 / this.env.maxFps - 2) return false;
        this.lastDrawAt = frameTime;
        return true;
    }

    /** Once per frame, after the car and the chase camera (on `chase`) moved. */
    update(camera: THREE.PerspectiveCamera, car: ShowroomCar | null, chase: THREE.PerspectiveCamera): void {
        const now = this.now();
        if (this.active) {
            if (car && this.env.carFree()) this.placeCar(car, now);
            const t = (now - this.startedAt) / 1000;
            const lite = this.env.lite;
            const pose = showroomPose(t, this.framing(camera), this.deckY(), {
                reducedMotion: lite || this.env.reducedMotion(),
                ...this.layout(camera)
            });
            this.apply(camera, cameraStateOf(pose));
            return;
        }
        if (this.transitionKind) this.transitionFrame(camera, chase, now);
        // The still of the cross-fade shows the car where it stood, even if
        // the spawn came in before that frame was drawn
        if (this.captureStill && car) this.showAtSpot(car);
    }

    private showAtSpot(car: ShowroomCar): void {
        car.group.position.set(SHOWROOM_SPOT.x, this.deckY(), SHOWROOM_SPOT.z);
        car.group.rotation.y = SHOWROOM_SPOT.yaw;
        car.bodyGroup.visible = true;
    }

    private placeCar(car: ShowroomCar, now: number): void {
        const { x, z, yaw } = SHOWROOM_SPOT;
        const y = this.deckY();
        if (Math.abs(car.group.position.x - x) > 1e-3 || Math.abs(car.group.position.z - z) > 1e-3 || car.angle !== yaw) {
            car.vehicle?.place(x, z, yaw);
            car.group.position.set(x, y, z);
            car.angle = yaw;
            car.group.rotation.y = yaw;
        }
        car.bodyGroup.visible = true;
        car.group.position.y = y - this.dip(now);
    }

    /** Writes a camera state onto the camera, the frame shifted to its centre. */
    private apply(camera: THREE.PerspectiveCamera, pose: CameraState): void {
        camera.position.set(...pose.position);
        const cos = Math.cos(pose.pitch);
        _look.set(pose.position[0] + Math.sin(pose.yaw) * cos, pose.position[1] + Math.sin(pose.pitch), pose.position[2] + Math.cos(pose.yaw) * cos);
        camera.lookAt(_look);
        camera.fov = pose.fov;
        const [cx, cy] = pose.center;
        if (Math.abs(cx - 0.5) > 1e-4 || Math.abs(cy - 0.5) > 1e-4) {
            _size.set(window.innerWidth, window.innerHeight);
            camera.setViewOffset(_size.x, _size.y, (0.5 - cx) * _size.x, (0.5 - cy) * _size.y, _size.x, _size.y);
        } else {
            camera.clearViewOffset();
        }
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld();
    }

    /** The camera as a state (the chase camera's pose of this frame). */
    private read(camera: THREE.PerspectiveCamera): CameraState {
        camera.getWorldDirection(_dir);
        return {
            position: [camera.position.x, camera.position.y, camera.position.z],
            yaw: Math.atan2(_dir.x, _dir.z),
            pitch: Math.asin(Math.max(-1, Math.min(1, _dir.y))),
            fov: camera.fov,
            center: [0.5, 0.5]
        };
    }

    /**
     * DRIVE: the showroom lets go of the car, the camera goes into the
     * game. Resolves when the chase camera has it.
     */
    startTransition(camera: THREE.PerspectiveCamera): Promise<void> {
        if (!this.active) return Promise.resolve();
        this.active = false;
        const t = (this.now() - this.startedAt) / 1000;
        const hint = this.env.spawnHint();
        const spawnDistance = hint ? Math.hypot(hint.x - SHOWROOM_SPOT.x, hint.z - SHOWROOM_SPOT.z) : null;
        const kind = transitionKind({ reducedMotion: this.env.reducedMotion(), lite: this.env.lite, spawnDistance });
        this.from = cameraStateOf(showroomPose(t, this.framing(camera), this.deckY(), {
            reducedMotion: this.env.lite || this.env.reducedMotion(),
            ...this.layout(camera)
        }));
        this.transitionKind = kind;
        this.transitionAt = this.now();
        this.cutAt = Infinity;
        this.fadeAt = Infinity;
        this.stillTaken = false;
        // The cross-fade holds the next showroom frame (afterRender)
        this.captureStill = kind === 'fade';
        return new Promise(resolve => { this.finished = resolve; });
    }

    /**
     * Right after a frame was drawn (the drawing buffer still holds it):
     * the cross-fade takes the last showroom frame as its still.
     */
    afterRender(canvas: HTMLCanvasElement): void {
        if (!this.captureStill) return;
        this.captureStill = false;
        this.fade = this.still(canvas);
        this.stillTaken = true;
    }

    // The last showroom frame, held over the canvas for the cross-fade
    private still(source: HTMLCanvasElement): HTMLCanvasElement | null {
        try {
            const still = document.createElement('canvas');
            still.width = source.width;
            still.height = source.height;
            still.getContext('2d')?.drawImage(source, 0, 0);
            still.className = 'showroom-still';
            still.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:8000;pointer-events:none;'
                + `transition:opacity ${TRANSITION.fade}s ease`;
            document.body.appendChild(still);
            return still;
        } catch {
            return null;
        }
    }

    private transitionFrame(camera: THREE.PerspectiveCamera, chase: THREE.PerspectiveCamera, now: number): void {
        const t = (now - this.transitionAt) / 1000;
        const from = this.from!;
        const spawned = this.env.spawned() || t >= TRANSITION.rise + TRANSITION.maxHold;
        switch (this.transitionKind) {
            case 'fade':
                // The showroom frame is held as a still (afterRender); once
                // the car is spawned the chase camera takes over under it
                // and the still fades
                if (!this.stillTaken || !spawned) {
                    this.apply(camera, from);
                    return;
                }
                if (this.fadeAt === Infinity) {
                    this.fadeAt = now;
                    // A frame of the game under the still, then it fades
                    window.setTimeout(() => { if (this.fade) this.fade.style.opacity = '0'; }, 30);
                }
                this.apply(camera, this.read(chase));
                if (now - this.fadeAt >= TRANSITION.fade * 1000 + 30) this.finish(camera, chase);
                return;
            case 'direct':
                if (!spawned) {
                    this.transitionAt = now;
                    this.apply(camera, from);
                    return;
                }
                this.apply(camera, directPose(t, from, this.read(chase)));
                if (t >= TRANSITION.direct) this.finish(camera, chase);
                return;
            default: {
                if (this.cutAt === Infinity && t >= TRANSITION.rise && spawned) this.cutAt = t;
                this.apply(camera, transitionPose(t, from, this.read(chase), this.cutAt));
                if (t >= this.cutAt + TRANSITION.descend) this.finish(camera, chase);
            }
        }
    }

    /** Seconds left of the way into the game (the HUD fades in over the last 0.3 s); Infinity while waiting. */
    remaining(): number {
        if (!this.transitionKind) return 0;
        const t = (this.now() - this.transitionAt) / 1000;
        if (this.transitionKind === 'fade') return this.fadeAt === Infinity ? Infinity : TRANSITION.fade - (this.now() - this.fadeAt) / 1000;
        if (this.transitionKind === 'direct') return TRANSITION.direct - t;
        return this.cutAt === Infinity ? Infinity : this.cutAt + TRANSITION.descend - t;
    }

    // The game camera takes over where the chase camera is
    private finish(camera: THREE.PerspectiveCamera, chase: THREE.PerspectiveCamera): void {
        camera.position.copy(chase.position);
        camera.quaternion.copy(chase.quaternion);
        camera.fov = chase.fov;
        camera.clearViewOffset();
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld();
        this.transitionKind = null;
        this.fade?.remove();
        this.fade = null;
        this.finished?.();
        this.finished = null;
    }
}
