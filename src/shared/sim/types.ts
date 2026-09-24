// Data shapes of the v2 driving simulation (docs/phase-1a-design.md,
// section 5). State and params are plain objects; the sim mutates them in
// place and never allocates per tick.

export type CarClassId = 'bulli' | 'pickup' | 'sport' | 'beetle' | 'jeep';
export type DriveLayout = 'rear' | 'all';
export type AssistProfile = 'standard' | 'touch';

// Quantised already in 1a, so client and server compute identical values in 1b
export interface VehicleInput {
    steer: number;      // int -127..127, + = left
    throttle: number;   // int 0..255
    brake: number;      // int 0..255; brakes, reverses after REVERSE_HOLD_TICKS at a standstill
    buttons: number;    // BTN_* bit mask (held state)
}

export interface VehicleState {
    // Pose (m, rad)
    x: number; y: number; z: number;   // y = underside of the car
    yaw: number;
    // Velocity (world, m/s) and yaw rate (rad/s, + = left)
    vx: number; vy: number; vz: number;
    yawRate: number;
    // Filter states - part of the 1b snapshot, or the replay diverges
    steerAngle: number;    // road wheel angle δ (rad), rate limited
    loadX: number;         // low-pass filtered longitudinal acceleration (m/s²)
    rearGrip: number;      // 0..1, handbrake blend
    betaPrev: number;      // slip angle of the previous tick
    // Ground
    grounded: boolean;
    airTicks: number;      // ticks since leaving the ground (coyote, air fill)
    // Gameplay
    boostMeter: number;    // 0..1
    boosting: boolean;
    driftTicks: number;    // > 0 while drifting (hysteresis), gameplay only
    driftLowTicks: number; // ticks below the exit threshold
    wallTicks: number;     // ticks since the last wall contact (saturates at 255)
    flipAngle: number;     // flip (rad), 0 = no flip
    flipRate: number;      // rad/s, fixed at take-off
    jumpCooldown: number;  // ticks
    resetHold: number;     // ticks reset has been held
    reverseHold: number;   // ticks of brake at a standstill
    ghostTicks: number;    // contact ghost after reset/respawn (no car contact only)
    ghostExit: number;     // ticks world collision stays off after a Party ghost ended in a collider
    wasGhost: boolean;     // Party ghost in the previous tick
    scale: number;         // 1..MEGA_SCALE, eases
    prevButtons: number;   // edge detection
    draft: number;         // 0..1 slipstream strength, rate limited (race world only)
}

export interface VehicleParams {
    mass: number;           // kg
    wheelbase: number;      // L (m)
    cgFront: number;        // a/L
    cgHeight: number;       // m
    yawRadius: number;      // rg (m), Iz = m·rg²
    drive: DriveLayout;
    topSpeed: number;       // vtop (m/s), exact at full throttle
    accel: number;          // A (m/s²) from a standstill
    brakeDecel: number;     // m/s²
    gripFront: number; gripRear: number;          // μ (g)
    aeroGrip: number;       // grip bonus at vtop (0.25 = +25 %)
    slipPeakFront: number; slipPeakRear: number;  // rad
    slideFront: number; slideRear: number;        // remaining grip beyond 2·α_peak
    handbrakeGrip: number;  // rear grip factor with the handbrake pulled
    steerLock: number;      // δ0 (rad)
    steerFalloff: number;   // vS (m/s)
    driftFill: number;      // class factor of the boost fill
    offroadGrip: number; offroadDrag: number;     // take effect in phase 3
    colliderRadius: number; // r of the two circles
    colliderOffset: number; // c: circle centres at ±c along the heading
    jumpSpeed: number;      // m/s
    counterSteer: number;   // K_CS (assist profile)
    spinGuardAngle: number; // β0 (rad) (assist profile)
    contactMass: number;    // effective contact mass: mass × Mega/Shield, set by applyModifiers
    massRatioCap: number;   // R (1.8; Mega 3.5)
    restitutionWall: number;
}

export interface VehicleModifiers {
    turbo: boolean;
    mega: boolean;
    superJump: boolean;
    ghost: boolean;   // Party ghost: no car contact AND no world colliders (world border still applies)
    shield: boolean;  // shield powerup or respawn shield
    launch: boolean;  // perfect race start: more acceleration (race rule)
    bogged: boolean;  // early race start: less acceleration (race rule)
}

// Reset every tick and written in place (no allocation)
export interface StepEvents {
    wallImpact: number;     // max normal speed into a wall (m/s)
    wallX: number; wallZ: number;  // contact point of the strongest wall hit
    carImpact: number;      // max |Δv| from car contact (m/s)
    carImpactId: string;    // opponent of the strongest contact ('' = none)
    landedImpact: number;   // vertical impact speed
    jumped: boolean;
    boostStarted: boolean;
    drifting: boolean;
    reset: boolean;
}

export interface SimCar {
    id: string;
    state: VehicleState;
    input: VehicleInput;
    base: VehicleParams;         // class + assist profile
    params: VehicleParams;       // effective (applyModifiers writes into it)
    mods: VehicleModifiers;
    kinematic: boolean;          // 1a: remote proxy; pose/velocity set from outside
    contactScale: number;        // 1 for real cars; 1a proxies: impulse only on the partner
    events: StepEvents;
    // Per-tick accumulators for the contact caps (Σ|Δv|, Σ|Δω|), reset by stepWorld
    contactDv: number;
    contactDw: number;
}

export function createVehicleState(): VehicleState {
    return {
        x: 0, y: 0, z: 0,
        yaw: 0,
        vx: 0, vy: 0, vz: 0,
        yawRate: 0,
        steerAngle: 0,
        loadX: 0,
        rearGrip: 1,
        betaPrev: 0,
        grounded: true,
        airTicks: 0,
        boostMeter: 0,
        boosting: false,
        driftTicks: 0,
        driftLowTicks: 0,
        wallTicks: 255,
        flipAngle: 0,
        flipRate: 0,
        jumpCooldown: 0,
        resetHold: 0,
        reverseHold: 0,
        ghostTicks: 0,
        ghostExit: 0,
        wasGhost: false,
        scale: 1,
        prevButtons: 0,
        draft: 0
    };
}

// Copies every field, e.g. into the prediction history or the render
// interpolation's prev/curr pair. No allocation.
export function copyVehicleState(dst: VehicleState, src: VehicleState): VehicleState {
    dst.x = src.x; dst.y = src.y; dst.z = src.z;
    dst.yaw = src.yaw;
    dst.vx = src.vx; dst.vy = src.vy; dst.vz = src.vz;
    dst.yawRate = src.yawRate;
    dst.steerAngle = src.steerAngle;
    dst.loadX = src.loadX;
    dst.rearGrip = src.rearGrip;
    dst.betaPrev = src.betaPrev;
    dst.grounded = src.grounded;
    dst.airTicks = src.airTicks;
    dst.boostMeter = src.boostMeter;
    dst.boosting = src.boosting;
    dst.driftTicks = src.driftTicks;
    dst.driftLowTicks = src.driftLowTicks;
    dst.wallTicks = src.wallTicks;
    dst.flipAngle = src.flipAngle;
    dst.flipRate = src.flipRate;
    dst.jumpCooldown = src.jumpCooldown;
    dst.resetHold = src.resetHold;
    dst.reverseHold = src.reverseHold;
    dst.ghostTicks = src.ghostTicks;
    dst.ghostExit = src.ghostExit;
    dst.wasGhost = src.wasGhost;
    dst.scale = src.scale;
    dst.prevButtons = src.prevButtons;
    dst.draft = src.draft;
    return dst;
}

export function createVehicleInput(): VehicleInput {
    return { steer: 0, throttle: 0, brake: 0, buttons: 0 };
}

export function createVehicleModifiers(): VehicleModifiers {
    return { turbo: false, mega: false, superJump: false, ghost: false, shield: false, launch: false, bogged: false };
}

export function createStepEvents(): StepEvents {
    const events = {} as StepEvents;
    resetStepEvents(events);
    return events;
}

export function resetStepEvents(ev: StepEvents): void {
    ev.wallImpact = 0;
    ev.wallX = 0;
    ev.wallZ = 0;
    ev.carImpact = 0;
    ev.carImpactId = '';
    ev.landedImpact = 0;
    ev.jumped = false;
    ev.boostStarted = false;
    ev.drifting = false;
    ev.reset = false;
}
