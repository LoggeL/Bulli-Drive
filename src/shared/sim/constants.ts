// Fixed-step constants and tuning values of the v2 driving simulation
// (docs/phase-1a-design.md, sections 5 and 6.1). Units are SI throughout:
// metres, seconds, kilograms, radians; speeds in m/s.

export const SIM_HZ = 60;
export const DT = 1 / SIM_HZ;
// Movement is split into this many substeps per tick, independent of speed
// and of the number of cars, so client replay and server take the same path.
export const SUBSTEPS = 3;
export const V_ABS = 85;    // m/s, top speed cap incl. Turbo + Boost (306 km/h)
export const V_SAFE = 90;   // m/s, safety clamp on |v|

export const DEG = Math.PI / 180;

// VehicleInput.buttons bits (held state). Bit 4 was the jump (removed,
// docs/phase-1a-design.md 26); the sim ignores it and clampInput drops it.
export const BTN_HANDBRAKE = 1;
export const BTN_BOOST = 2;
export const BTN_RESET = 8;   // must be held for RESET_HOLD_TICKS
export const BTN_MASK = BTN_HANDBRAKE | BTN_BOOST | BTN_RESET;

// Ticks the world collision stays off after a Party ghost ended inside a
// building, at most (section 7.3, step 5)
export const GHOST_EXIT_TICKS = 180;

// Global tuning values. One mutable object so the lil-gui panel can write
// into it; the server always runs with these defaults.
export const SIM_TUNING = {
    // Gravity: on the body (vertical motion, on the ground and in the
    // air), downhill pull, tyre load
    GRAVITY: 20,
    G_SLOPE: 9.81,
    G_TIRE: 9.81,
    // Suspension (docs/phase-1a-design.md, 26): natural frequency (Hz) and
    // damping ratio of the body on its springs, travel from the rest
    // position down to the bump stop (m)
    SUSP_FREQ: 2,
    SUSP_DAMPING: 0.8,
    SUSP_TRAVEL: 0.25,
    // Below this speed the tyre model blends into kinematic steering
    V_LOW: 5,
    // Resistances
    ROLL: 0.4,              // m/s²
    C_AIR: 0.0006,          // 1/m, aerodynamic drag = C_AIR·u²
    ENGINE_BRAKE: 1.5,      // m/s² without throttle and brake
    OVERSPEED: 0.5,         // 1/s, pulls speeds above the reference back
    // Drive
    DRIVE_EXP: 2.5,
    GRIP_CIRCLE: 0.6,
    // Reverse
    REV_TOP: 15,
    REV_ACCEL: 6,
    REVERSE_HOLD_TICKS: 8,
    // Handbrake: extra braking without throttle, rear grip drop/recovery time
    HB_DECEL: 5,
    HB_DROP_TIME: 0.08,
    HB_RECOVER_TIME: 0.35,
    // Longitudinal load transfer
    LOAD_GAIN: 0.5,
    LOAD_TAU: 0.08,
    LOAD_MAX_REAR: 0.2,     // share of Fz moved to the rear under throttle
    LOAD_MAX_FRONT: 0.1,    // share of Fz moved to the front under braking
    // Steering rate of the road wheels (rad/s)
    STEER_RATE_IN: 3.5,
    STEER_RATE_OUT: 5,
    // Assists: spin guard stiffness and slip-angle damping
    K_SPIN: 15,
    K_BD: 6,
    BETA_DAMP_FROM: 15 * DEG,
    // Limits
    R_MAX: 6,               // rad/s
    // Boost
    BOOST_ACCEL: 10,
    BOOST_ADD: 20,          // boost target above the class top speed
    BOOST_DRAIN: 0.45,      // meter per second
    BOOST_MIN: 0.15,        // meter needed to start a boost
    DRIFT_FILL: 0.35,
    AIR_FILL: 0.10,
    // Yaw in the air (section 26): no steering; the yaw rate eases at
    // AIR_YAW_RESPONSE (1/s) towards AIR_ALIGN (1/s) times the slip angle,
    // which turns the nose into the flight direction for a straight landing
    AIR_YAW_RESPONSE: 3,
    AIR_ALIGN: 2,
    RESET_HOLD_TICKS: 30,
    RESET_GHOST_TICKS: 120,
    // Global knobs
    gripScale: 1.0,
    yawDampHigh: 0,
    driftReleaseKick: 0,    // m/s once when a drift of >= 72 ticks ends ("mini turbo")
    // Wall contact
    WALL_FRICTION: 0.15,
    WALL_BOUNCE_MAX: 3,
    WALL_DOMEGA_MAX: 2.5,
    // Car-car contact
    CAR_RESTITUTION: 0.25,
    CAR_BOUNCE_MAX: 4,
    CAR_FRICTION: 0.3,
    CONTACT_DOMEGA_CAP: 2.5,    // Σ|Δω| per car and tick
    CONTACT_DV_CAP: 30,         // Σ|Δv| per car and tick
    CONTACT_SLOP: 0.01,
    CONTACT_CORRECTION: 0.8,
    CONTACT_MAX_CORRECTION: 0.5
};

export type SimTuning = typeof SIM_TUNING;

// Fresh copy of the shipped defaults, e.g. to undo panel changes in tests
export const SIM_TUNING_DEFAULTS: Readonly<SimTuning> = Object.freeze({ ...SIM_TUNING });
