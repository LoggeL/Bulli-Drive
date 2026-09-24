// Every race constant of phase 2 (docs/phase-2-design.md, section 4). Plain
// numbers only: the sim imports the modifier values from here, so this file
// must not import anything itself. Values marked *start value* in the spec
// are tuned in the playtest and with bots.

// ---- Room ----

// Snapshots at 30 Hz in races and time trials (every 2nd tick)
export const RACE_SNAPSHOT_EVERY = 2;
// Cars in one race (humans + bots)
export const MAX_RACERS = 8;
// Humans per race room (drivers + spectators)
export const RACE_ROOM_MAX_MEMBERS = 16;
// Bots fill the field up to this many cars
export const RACE_FIELD_TARGET = 6;
// Every human ready: the countdown starts after 1 s
export const LOBBY_ALL_READY_TICKS = 60;
// At least one human ready: the countdown starts after 15 s at the latest
export const LOBBY_AUTOSTART_TICKS = 900;
// The grid is visible this long before the lights start
export const COUNTDOWN_PREP_TICKS = 60;
// The same in a time trial (quick restart)
export const TIMETRIAL_PREP_TICKS = 30;
// Three lights at S - 180, S - 120, S - 60, green at S = startTick
export const COUNTDOWN_TICKS = 180;
// Contact ghost for every racer from S to S + 179
export const START_GHOST_TICKS = 180;
// DNF 30 s after the first finisher
export const DNF_AFTER_FIRST_TICKS = 1800;
// Results and vote, 15 s
export const RESULTS_TICKS = 900;
// raceStatus at 5 Hz
export const RACE_STATUS_EVERY = 12;

// ---- Gates, progress, wrong way ----

// The crossing point may lie this far (m) beyond a gate's ends
export const GATE_TOLERANCE = 1.0;
// Velocity against the racing line's tangent (about 120°)
export const WRONG_WAY_DOT = -0.5;
// Driving the right way again ends a wrong-way state
export const WRONG_WAY_EXIT_DOT = 0.3;
// Below this speed (m/s) the heading test does not count
export const WRONG_WAY_MIN_SPEED = 4;
// Hysteresis: ticks a condition must hold to enter and to leave
export const WRONG_WAY_ENTER_TICKS = 60;
export const WRONG_WAY_EXIT_TICKS = 30;
// Falling back this far (m) along the line since the last gate counts too
export const WRONG_WAY_BACKTRACK = 25;
// This far (m) along the line past the next gate without crossing it: missed
export const MISSED_GATE_DISTANCE = 30;
// Farther (m) from the line, the remaining distance is the straight line to the gate
export const OFF_LINE_DISTANCE = 25;
// A reset that lands past the next gate goes back this far (m) before it (10.3)
export const RESET_BEFORE_GATE = 5;

// ---- Racing line ----

// Resampling step of the racing line (m)
export const LINE_STEP = 2;
// Windowed projection searches this many segments either side of the hint
export const LINE_WINDOW = 40;
// Safety margin on the front grip for the speed profile, and on the brakes
export const LINE_GRIP_MARGIN = 0.85;
export const LINE_BRAKE_MARGIN = 0.8;

// ---- Launch ----

// A throttle edge in [S - 20, S] is a perfect start
export const LAUNCH_WINDOW_TICKS = 20;
// Raw throttle from which the pedal counts as pressed
export const LAUNCH_THROTTLE = 128;
// Raw countdown throttle kept per racer (ring buffer)
export const LAUNCH_HISTORY_TICKS = 64;
// Perfect start: acceleration × 1.6 for 60 ticks (*start value*)
export const LAUNCH_TICKS = 60;
export const LAUNCH_ACCEL = 1.6;
// Early start: acceleration × 0.5 for 30 ticks (*start value*)
export const BOGGED_TICKS = 30;
export const BOGGED_ACCEL = 0.5;

// ---- Slipstream (*start values*) ----

// Cone behind the car ahead: along its heading from DRAFT_MIN to DRAFT_RANGE (m)
export const DRAFT_RANGE = 30;
export const DRAFT_MIN = 3;
// Half width of the cone: DRAFT_HALF_WIDTH + DRAFT_HALF_WIDTH_GROWTH · along
export const DRAFT_HALF_WIDTH = 1.2;
export const DRAFT_HALF_WIDTH_GROWTH = 0.05;
// Heading difference of the car ahead, at most (rad, 20°)
export const DRAFT_HEADING = 20 * Math.PI / 180;
// Both cars at least this fast (m/s)
export const DRAFT_MIN_SPEED = 15;
// Rate limits of VehicleState.draft (per second)
export const DRAFT_RISE = 1.0;
export const DRAFT_FALL = 2.0;
// Effect at draft = 1: top speed + 4 m/s, acceleration + 15 %, boost fill 0.08/s
export const DRAFT_TOP_ADD = 4;
export const DRAFT_ACCEL = 0.15;
export const DRAFT_FILL = 0.08;

// ---- Time trial ----

// Pose track of a ghost: one sample every GHOST_POSE_EVERY ticks (20 Hz)
export const GHOST_POSE_HZ = 20;
export const GHOST_POSE_EVERY = 3;
// Personal bests per ghost key kept in memory (LRU)
export const GHOST_PERSONAL_MAX = 64;
