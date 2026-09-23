// Quantisation of the compact car records (docs/phase-1b-design.md, 3.4).
// Every value is rounded to the nearest step and saturates at its range.

const TWO_PI = Math.PI * 2;

function clampInt(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return 0;
    const rounded = Math.round(value);
    return rounded < min ? min : rounded > max ? max : rounded;
}

export const POS_STEP = 1 / 4096;       // x, z: i24
export const HEIGHT_STEP = 0.01;        // y: i16
export const SPEED_STEP = 0.01;         // vx, vy, vz: i16
export const YAW_RATE_STEP = 0.001;     // i16
export const STEER_STEP = 1 / 200;      // i8
export const LOAD_STEP = 0.25;          // i8
export const YAW_STEPS = 65536;         // u16 over a full turn
export const FLIP_STEPS = 256;          // u8 over a full turn

export const I24_MIN = -(1 << 23);
export const I24_MAX = (1 << 23) - 1;

export const quantPos = (v: number) => clampInt(v / POS_STEP, I24_MIN, I24_MAX);
export const quantHeight = (v: number) => clampInt(v / HEIGHT_STEP, -32768, 32767);
export const quantSpeed = (v: number) => clampInt(v / SPEED_STEP, -32768, 32767);
export const quantYawRate = (v: number) => clampInt(v / YAW_RATE_STEP, -32768, 32767);
export const quantSteer = (v: number) => clampInt(v / STEER_STEP, -127, 127);
export const quantLoad = (v: number) => clampInt(v / LOAD_STEP, -127, 127);
export const quantUnit = (v: number) => clampInt(v * 255, 0, 255);
export const quantScale = (v: number) => clampInt((v - 1) * 100, 0, 255);
export const quantByte = (v: number) => clampInt(v, 0, 255);

// Angles wrap: any yaw maps onto 0..65535 (and back to -π..π)
export function quantYaw(yaw: number): number {
    if (!Number.isFinite(yaw)) return 0;
    const turns = yaw / TWO_PI;
    const steps = Math.round((turns - Math.floor(turns)) * YAW_STEPS);
    return steps === YAW_STEPS ? 0 : steps;
}

export function unquantYaw(steps: number): number {
    const yaw = (steps / YAW_STEPS) * TWO_PI;
    return yaw > Math.PI ? yaw - TWO_PI : yaw;
}

export function quantFlip(angle: number): number {
    if (!Number.isFinite(angle) || angle <= 0) return 0;
    const steps = Math.round((angle % TWO_PI) / TWO_PI * FLIP_STEPS);
    // A running flip never quantises to 0 (0 means "no flip")
    return steps >= FLIP_STEPS ? FLIP_STEPS - 1 : Math.max(1, steps);
}

export function unquantFlip(steps: number): number {
    return steps / FLIP_STEPS * TWO_PI;
}
