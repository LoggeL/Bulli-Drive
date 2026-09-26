// The menu's showroom (docs/ui.md 4.1): the chosen car parked at the head of
// the pier of Bulli Bay in the evening sun, the camera three-quarter from
// the front with the sea and the pier restaurant behind. The loading screen's
// key art is rendered from exactly this start pose (tools/ui/keyart.ts), so
// that the menu's first live frame (U4) only fades in over it.

export interface ShowroomFraming {
    /** Camera distance from the car (m) and height above the deck (m) */
    distance: number;
    height: number;
    /** Vertical field of view (degrees) */
    fov: number;
    /** Height of the looked-at point above the deck (m) */
    lookHeight: number;
    /** Where the car lands in the frame (fractions from the top left): a shifted projection, the UI keeps its side */
    center: [number, number];
    /** The car fills this much of the free box's height (fitDistance), and at most maxWidth of its width */
    fill: number;
    maxWidth: number;
}

/** Where the car stands: on the pier deck (5 m above the sea), heading east-northeast back to the town. */
export const SHOWROOM_SPOT = { x: -745, z: -18, yaw: 1.75 } as const;

/**
 * The camera's direction from the car, added to the car's heading (radians,
 * same sense as yaw): three-quarter from the front, with the sea behind the
 * car; the middle of the showroom camera's swing.
 */
export const SHOWROOM_HERO_ANGLE = 0.45;

export const SHOWROOM_FRAMING: Readonly<Record<'landscape' | 'portrait', ShowroomFraming>> = {
    // Desktop and phones held sideways: the car in the right part of the
    // frame, the menu panel on the left over sea and deck
    landscape: { distance: 10, height: 1.4, fov: 35, lookHeight: 0.8, center: [0.64, 0.38], fill: 0.7, maxWidth: 0.72 },
    // Phones held upright: the car in the upper part, the sheet below it;
    // the free box is short there, the car takes more of it
    portrait: { distance: 13, height: 1.6, fov: 55, lookHeight: 0.8, center: [0.5, 0.25], fill: 0.92, maxWidth: 0.62 }
};

export interface ShowroomPose {
    position: [number, number, number];
    lookAt: [number, number, number];
    fov: number;
    center: [number, number];
}

// The pier deck reaches this far from the car's line towards the sea side
// rail, less 1.2 m (the deck is z -25..-15, the car at z -18)
const RAIL_CLEARANCE = 5.8;

/**
 * The hero angle for a camera this far out: SHOWROOM_HERO_ANGLE, or less
 * when the camera would otherwise stand over the sea side rail (a wider
 * shot comes round more from the front, along the pier).
 */
export function heroAngleFor(distance: number): number {
    const limit = Math.acos(Math.max(-1, -RAIL_CLEARANCE / distance)) - SHOWROOM_SPOT.yaw;
    return Math.min(SHOWROOM_HERO_ANGLE, limit);
}

/** The Bulli's height as a share of the frame at 8 m with a 35° FOV (measured on the key art). */
export const CAR_FRAME_AT_8M = 0.54;
/** The car's width over its height in the three-quarter view, with the near front larger in perspective */
export const CAR_ASPECT = 1.5;
export const SHOWROOM_DISTANCE = { min: 7, max: 15 } as const;

/**
 * How far the camera stands for the car to fill the free box (its width and
 * height as shares of the frame; aspect = frame width / height): the car's
 * size falls with the distance and with tan(fov / 2).
 */
export function fitDistance(framing: ShowroomFraming, box: [number, number], aspect: number): number {
    const lens = Math.tan(35 / 2 * DEG) / Math.tan(framing.fov / 2 * DEG);
    const atUnit = 8 * CAR_FRAME_AT_8M * lens;
    const byHeight = atUnit / (framing.fill * box[1]);
    const byWidth = atUnit * CAR_ASPECT / aspect / (framing.maxWidth * box[0]);
    return Math.min(SHOWROOM_DISTANCE.max, Math.max(SHOWROOM_DISTANCE.min, byHeight, byWidth));
}

/** The camera's start pose for a framing, with the deck at deckY. */
export function showroomStartPose(framing: ShowroomFraming, deckY: number): ShowroomPose {
    const { x, z, yaw } = SHOWROOM_SPOT;
    // Heading yaw points along (sin yaw, cos yaw); the camera sits in the
    // direction yaw + hero angle from the car
    const direction = yaw + heroAngleFor(framing.distance);
    return {
        position: [x + Math.sin(direction) * framing.distance, deckY + framing.height, z + Math.cos(direction) * framing.distance],
        lookAt: [x, deckY + framing.lookHeight, z],
        fov: framing.fov,
        center: [framing.center[0], framing.center[1]]
    };
}

const DEG = Math.PI / 180;

/**
 * The showroom camera's slow swing (docs/ui.md 4.1): from the hero angle
 * (the key art's pose) towards the car's nose and back, SHOWROOM_SWING at
 * most, once per SHOWROOM_PERIOD_S. Only to that side: on the other the
 * camera would leave the 10 m wide pier deck over its rail (D13, D18).
 */
export const SHOWROOM_SWING = 30 * DEG;
export const SHOWROOM_PERIOD_S = 40;

/** The swing at time t (s) as an angle added to the hero angle: 0 at t = 0, -SHOWROOM_SWING half a period later. */
export function showroomSwing(t: number, reducedMotion = false): number {
    if (reducedMotion) return 0;
    return -SHOWROOM_SWING * (1 - Math.cos(2 * Math.PI * t / SHOWROOM_PERIOD_S)) / 2;
}

/**
 * The showroom camera at time t (s) since the menu opened: the start pose
 * (t = 0, the key art) swung by showroomSwing. center: where the car lands
 * in the frame, the framing's own by default (the menu passes the middle of
 * the free stage beside its panels); distance: the camera's, the framing's
 * own by default (the menu fits it to the free stage, fitDistance).
 */
export function showroomPose(t: number, framing: ShowroomFraming, deckY: number,
    options: { reducedMotion?: boolean; center?: [number, number]; distance?: number } = {}): ShowroomPose {
    const { x, z, yaw } = SHOWROOM_SPOT;
    const distance = options.distance ?? framing.distance;
    const direction = yaw + heroAngleFor(distance) + showroomSwing(t, options.reducedMotion);
    return {
        position: [x + Math.sin(direction) * distance, deckY + framing.height, z + Math.cos(direction) * distance],
        lookAt: [x, deckY + framing.lookHeight, z],
        fov: framing.fov,
        center: options.center ? [options.center[0], options.center[1]] : [framing.center[0], framing.center[1]]
    };
}

// ---- Menu -> game (docs/ui.md 6) ----

/**
 * A camera as position and view direction: yaw as the car's heading
 * (direction sin yaw, cos yaw on the ground), pitch up from the horizon,
 * vertical FOV (degrees) and the frame centre of the projection.
 */
export interface CameraState {
    position: [number, number, number];
    yaw: number;
    pitch: number;
    fov: number;
    center: [number, number];
}

export function cameraStateOf(pose: ShowroomPose): CameraState {
    const [px, py, pz] = pose.position;
    const dx = pose.lookAt[0] - px, dy = pose.lookAt[1] - py, dz = pose.lookAt[2] - pz;
    return {
        position: [px, py, pz],
        yaw: Math.atan2(dx, dz),
        pitch: Math.atan2(dy, Math.hypot(dx, dz)),
        fov: pose.fov,
        center: [pose.center[0], pose.center[1]]
    };
}

export const TRANSITION = {
    /** The crane up into the sky (s) */
    rise: 0.7,
    /** The flight down to the chase camera after the cut (s) */
    descend: 1.1,
    /** How far the crane lifts the camera (m) */
    height: 45,
    /** The frame's lower edge this far above the horizon at the cut: only sky in view */
    skyMargin: 10 * DEG,
    /** A spawn closer than this to the showroom (m) gets a direct flight instead of the cut */
    nearDistance: 150,
    /** The direct flight (s) */
    direct: 1.2,
    /** Waiting in the sky for the spawn at most this long (s); then down to wherever the car is */
    maxHold: 2,
    /** The cross-fade with reduced motion and lite graphics (s) */
    fade: 0.3
} as const;

/** The pitch at the cut: the lower edge of a frame with this vertical FOV lies skyMargin above the horizon. */
export function cutPitch(fov: number): number {
    return fov / 2 * DEG + TRANSITION.skyMargin;
}

export type TransitionKind = 'crane' | 'direct' | 'fade';

/** How the menu goes into the game: a fade without motion (reduced motion, lite), a direct flight to a near spawn, else the crane. */
export function transitionKind(options: { reducedMotion: boolean; lite: boolean; spawnDistance: number | null }): TransitionKind {
    if (options.reducedMotion || options.lite) return 'fade';
    if (options.spawnDistance !== null && options.spawnDistance < TRANSITION.nearDistance) return 'direct';
    return 'crane';
}

function smooth(u: number): number {
    const x = Math.min(1, Math.max(0, u));
    return x * x * (3 - 2 * x);
}

function lerp(a: number, b: number, u: number): number {
    return a + (b - a) * u;
}

function lerpAngle(a: number, b: number, u: number): number {
    const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
    return a + d * u;
}

function blend(a: CameraState, b: CameraState, u: number): CameraState {
    return {
        position: [lerp(a.position[0], b.position[0], u), lerp(a.position[1], b.position[1], u), lerp(a.position[2], b.position[2], u)],
        yaw: lerpAngle(a.yaw, b.yaw, u),
        pitch: lerp(a.pitch, b.pitch, u),
        fov: lerp(a.fov, b.fov, u),
        center: [lerp(a.center[0], b.center[0], u), lerp(a.center[1], b.center[1], u)]
    };
}

/**
 * The camera t seconds into the crane: up from the showroom (from) into
 * the sky for TRANSITION.rise, waiting there until the cut at cutAt
 * (Infinity while the spawn is not there), then, over the spawn and still
 * looking into the same sky, down to the chase camera (to) for
 * TRANSITION.descend. The sky depends on the view direction only, so the
 * cut does not show. `to` is the chase camera of this frame (it follows
 * the car).
 */
export function transitionPose(t: number, from: CameraState, to: CameraState, cutAt: number): CameraState {
    const up = cutPitch(from.fov);
    const sky = (base: [number, number, number]): CameraState => ({
        position: [base[0], base[1] + TRANSITION.height, base[2]],
        yaw: from.yaw,
        pitch: up,
        fov: from.fov,
        center: [0.5, 0.5]
    });
    // Never before the camera is up
    const cut = Math.max(cutAt, TRANSITION.rise);
    if (t < TRANSITION.rise) return blend(from, sky(from.position), smooth(t / TRANSITION.rise));
    if (t < cut) return sky(from.position);
    return blend(sky(to.position), to, smooth((t - cut) / TRANSITION.descend));
}

/** A direct flight to a near spawn: from the showroom to the chase camera in TRANSITION.direct. */
export function directPose(t: number, from: CameraState, to: CameraState): CameraState {
    return blend(from, to, smooth(t / TRANSITION.direct));
}

/**
 * Where the car will spawn, as far as the way into the game may rely on it:
 * the room's preview spot in a Party or Free Roam room the menu goes on
 * with. Not in a race room: its preview is a free-roam spot, the grid is
 * elsewhere, and a late joiner watches instead of spawning (the crane then
 * waits in the sky, D3). Not when the menu switches to another room.
 */
export function spawnHintFor(roomKind: string | null | undefined, menuMode: string,
    preview: { x: number; z: number } | null): { x: number; z: number } | null {
    if (!preview || (roomKind !== 'party' && roomKind !== 'freeroam') || roomKind !== menuMode) return null;
    return { x: preview.x, z: preview.z };
}
