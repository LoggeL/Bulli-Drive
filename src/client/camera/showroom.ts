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
    landscape: { distance: 8, height: 1.4, fov: 35, lookHeight: 0.8, center: [0.68, 0.56] },
    // Phones held upright: the car in the upper part, the sheet below it
    portrait: { distance: 10, height: 1.6, fov: 55, lookHeight: 0.8, center: [0.5, 0.36] }
};

export interface ShowroomPose {
    position: [number, number, number];
    lookAt: [number, number, number];
    fov: number;
    center: [number, number];
}

/** The camera's start pose for a framing, with the deck at deckY. */
export function showroomStartPose(framing: ShowroomFraming, deckY: number): ShowroomPose {
    const { x, z, yaw } = SHOWROOM_SPOT;
    // Heading yaw points along (sin yaw, cos yaw); the camera sits in the
    // direction yaw + hero angle from the car
    const direction = yaw + SHOWROOM_HERO_ANGLE;
    return {
        position: [x + Math.sin(direction) * framing.distance, deckY + framing.height, z + Math.cos(direction) * framing.distance],
        lookAt: [x, deckY + framing.lookHeight, z],
        fov: framing.fov,
        center: [framing.center[0], framing.center[1]]
    };
}
