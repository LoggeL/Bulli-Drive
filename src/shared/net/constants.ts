// Netcode constants (docs/phase-1b-design.md, section 4). Tick counts are
// sim ticks of 1/60 s; values marked as start values in the design are
// tuned with the netsim and the bots.

import { SIM_HZ } from '../sim/constants.js';

export const TICK_RATE = SIM_HZ;
export const TICK_MS = 1000 / TICK_RATE;

// Party and Free Roam: a snapshot every 3 ticks (20 Hz)
export const SNAPSHOT_EVERY = 3;
export const SNAPSHOT_RATE = TICK_RATE / SNAPSHOT_EVERY;

// Older inputs sent again in every packet, and the most per packet
export const INPUT_REDUNDANCY = 2;
export const INPUT_MAX_PER_PACKET = 8;
// Inputs further ahead of the server tick are dropped (broken clock or
// tampering). Above the earliest a client's inputs arrive before its lead
// control takes that for a clock jump (buffer + EARLY_JUMP_TICKS +
// MAX_LATE_MARGIN_TICKS in leadControl.ts); below the 64 slots of the
// server's input ring (20.5)
export const INPUT_MAX_AHEAD = 60;
// Without new input the server repeats the last one this long (250 ms),
// then stops the car
export const INPUT_REPEAT_TICKS = 15;
// Lead of the inputs at the server the client aims for
export const BUFFER_TARGET_MIN = 1;
export const BUFFER_TARGET_MAX = 3;

// Input and state history of the client (2.1 s), a power of two
export const HISTORY_TICKS = 128;
// Remote cars are shown this far in the past (100 ms), up to the maximum
export const INTERP_DELAY_TICKS = 6;
export const INTERP_DELAY_MAX_TICKS = 9;
// Remote cars are extrapolated at most this far (250 ms)
export const EXTRAPOLATE_MAX_TICKS = 15;

// Contact set (8.5): remote cars closer than CONTACT_RADIUS_BASE +
// |v_rel| · lead (at most CONTACT_RADIUS_MAX) are predicted along with the
// own car; they leave it CONTACT_RADIUS_HYSTERESIS further out
export const CONTACT_RADIUS_BASE = 15;
export const CONTACT_RADIUS_MAX = 45;
export const CONTACT_RADIUS_HYSTERESIS = 5;
export const CONTACT_SET_MAX = 6;
// Soft contact against remote cars predicted far ahead: full strength up to
// SOFT_CONTACT_FROM ticks of lead, SOFT_CONTACT_SCALE from SOFT_CONTACT_TO on
export const SOFT_CONTACT_FROM = 9;
export const SOFT_CONTACT_TO = 15;
export const SOFT_CONTACT_SCALE = 0.5;

// Render offset of a correction (8.4)
export const SMOOTH_TAU_MIN_MS = 100;
export const SMOOTH_TAU_MAX_MS = 200;
// After a correction with car contact the offset is gone after this long
export const CONTACT_SMOOTH_MAX_MS = 300;
export const SNAP_DISTANCE = 4;
export const SNAP_YAW = Math.PI / 4;
// A correction smaller than this counts as none (8.4, step 2)
export const MATCH_POSITION = 1e-3;
export const MATCH_VELOCITY = 1e-3;
export const MATCH_YAW = 1e-4;

// Contact events for effects: from this Δv, per pair at most every few ticks
export const CONTACT_EVENT_MIN_DV = 3;
export const CONTACT_EVENT_PAIR_TICKS = 6;
export const CONTACT_EVENT_RANGE = 150;

// Idle (5.4): no input for this long, and the idle kick
export const IDLE_AFTER_TICKS = 60;
export const IDLE_EXIT_GHOST_TICKS = 60;
export const IDLE_KICK_MS = 10 * 60_000;
// Lag ghost: RTT above LAGGY_RTT_MS or more than LAGGY_MISS_RATE repeated
// inputs over LAGGY_WINDOW_TICKS; ends after LAGGY_RECOVER_TICKS below both.
// The window is 5 s instead of the 2 s of the design (20.2): a single hitch
// of the page (a shader compiled on first use, a GC pause) of 400 ms must
// not make a player a ghost; lasting loss does
export const LAGGY_RTT_MS = 300;
export const LAGGY_MISS_RATE = 0.2;
export const LAGGY_WINDOW_TICKS = 300;
export const LAGGY_RECOVER_TICKS = 300;

// Session grace after a lost connection (11.1): the car waits as an idle
// ghost this long for the player to come back with the session token
export const GRACE_MS = 30_000;
// A resume ticket from 'shutdown' is good this long (11.3)
export const RESUME_TICKET_MS = 120_000;
// Graceful shutdown (11.2): clients reconnect after this, the server closes
// the sockets this long after the 'shutdown' message and exits at the latest
// after SHUTDOWN_MAX_MS
export const SHUTDOWN_RECONNECT_MS = 1500;
export const SHUTDOWN_CLOSE_DELAY_MS = 300;
export const SHUTDOWN_MAX_MS = 5000;

// Clock sync (3.7): pings right after joining, then once a second
export const CLOCK_BURST_PINGS = 5;
export const CLOCK_BURST_INTERVAL_MS = 100;
export const CLOCK_INTERVAL_MS = 1000;
export const CLOCK_SAMPLES = 8;

// Close codes (11.1)
export const CLOSE_VERSION = 4000;
export const CLOSE_HELLO = 4001;
export const CLOSE_FULL = 4002;
export const CLOSE_POLICY = 4003;
export const CLOSE_IDLE = 4004;
export const CLOSE_TAKEN_OVER = 4005;
// Standard codes: the server restarts (graceful shutdown) or goes away
export const CLOSE_RESTART = 1012;
export const CLOSE_GOING_AWAY = 1001;
