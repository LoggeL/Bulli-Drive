// Binary frames of protocol v2 (docs/phase-1b-design.md, 3.3 and 3.4):
// the input uplink and the snapshot downlink. Everything else is JSON.
// DataView, little endian. The first byte is the frame kind.

import { SIM_TUNING } from '../sim/constants.js';
import { createVehicleState, type VehicleInput, type VehicleModifiers, type VehicleState } from '../sim/types.js';
import { INPUT_MAX_PER_PACKET } from './constants.js';
import {
    HEIGHT_STEP, LOAD_STEP, POS_STEP, SPEED_STEP, STEER_STEP, YAW_RATE_STEP,
    quantByte, quantFlip, quantHeight, quantLoad, quantPos, quantScale, quantSpeed, quantSteer,
    quantUnit, quantYaw, quantYawRate, unquantFlip, unquantYaw
} from './quant.js';

export const FRAME_INPUT = 0x01;
export const FRAME_SNAPSHOT = 0x02;

// ---------- Input (client -> server) ----------

// clientFlags of an input packet
export const INPUT_FROZEN = 1;   // modal open or GL context lost: the client sends stop inputs
export const INPUT_HIDDEN = 2;   // tab in the background

export const INPUT_HEADER_BYTES = 11;
export const INPUT_BYTES = 4;

export interface InputPacket {
    flags: number;
    // seq and tick of the newest input; input k has seq - k and tick - k
    seq: number;
    tick: number;
    // Newest first
    inputs: VehicleInput[];
}

export function inputPacketSize(count: number): number {
    return INPUT_HEADER_BYTES + count * INPUT_BYTES;
}

export function encodeInputPacket(packet: InputPacket, out?: Uint8Array): Uint8Array {
    const count = packet.inputs.length;
    if (count < 1 || count > INPUT_MAX_PER_PACKET) throw new Error(`input packet with ${count} inputs`);
    const bytes = out ?? new Uint8Array(inputPacketSize(count));
    const view = new DataView(bytes.buffer, bytes.byteOffset, inputPacketSize(count));
    view.setUint8(0, FRAME_INPUT);
    view.setUint8(1, count);
    view.setUint8(2, packet.flags & 0xff);
    view.setUint32(3, packet.seq >>> 0, true);
    view.setUint32(7, packet.tick >>> 0, true);
    for (let k = 0; k < count; k++) {
        const input = packet.inputs[k];
        const at = INPUT_HEADER_BYTES + k * INPUT_BYTES;
        view.setInt8(at, input.steer);
        view.setUint8(at + 1, input.throttle);
        view.setUint8(at + 2, input.brake);
        view.setUint8(at + 3, input.buttons);
    }
    return bytes;
}

/** The packet, or null when the frame is not a well-formed input packet. */
export function decodeInputPacket(bytes: Uint8Array): InputPacket | null {
    if (bytes.byteLength < INPUT_HEADER_BYTES + INPUT_BYTES) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint8(0) !== FRAME_INPUT) return null;
    const count = view.getUint8(1);
    if (count < 1 || count > INPUT_MAX_PER_PACKET || bytes.byteLength !== inputPacketSize(count)) return null;
    const packet: InputPacket = {
        flags: view.getUint8(2),
        seq: view.getUint32(3, true),
        tick: view.getUint32(7, true),
        inputs: []
    };
    for (let k = 0; k < count; k++) {
        const at = INPUT_HEADER_BYTES + k * INPUT_BYTES;
        packet.inputs.push({
            steer: view.getInt8(at),
            throttle: view.getUint8(at + 1),
            brake: view.getUint8(at + 2),
            buttons: view.getUint8(at + 3)
        });
    }
    return packet;
}

// ---------- Snapshot (server -> client) ----------

export const SNAPSHOT_HEADER_BYTES = 16;
export const SNAPSHOT_HAS_SELF = 1;
export const NO_SEQ = 0xffffffff;
export const NO_SLACK = -128;

// Car flags (compact records and the self block)
export const CAR_GROUNDED = 1 << 0;
export const CAR_BOOSTING = 1 << 1;
export const CAR_DRIFTING = 1 << 2;
export const CAR_TURBO = 1 << 3;
export const CAR_MEGA = 1 << 4;
export const CAR_SUPER_JUMP = 1 << 5;
export const CAR_GHOST = 1 << 6;
export const CAR_SHIELD = 1 << 7;           // shield powerup
export const CAR_RESPAWN_SHIELD = 1 << 8;
export const CAR_IDLE = 1 << 9;
export const CAR_LAGGY = 1 << 10;
export const CAR_FLIPPING = 1 << 11;
export const CAR_WAS_GHOST = 1 << 12;
export const CAR_GHOST_EXIT = 1 << 13;

// VehicleModifiers as bits (self block)
export const MOD_TURBO = 1;
export const MOD_MEGA = 2;
export const MOD_SUPER_JUMP = 4;
export const MOD_GHOST = 8;
export const MOD_SHIELD = 16;

export function modsToBits(mods: VehicleModifiers): number {
    return (mods.turbo ? MOD_TURBO : 0) | (mods.mega ? MOD_MEGA : 0) | (mods.superJump ? MOD_SUPER_JUMP : 0)
        | (mods.ghost ? MOD_GHOST : 0) | (mods.shield ? MOD_SHIELD : 0);
}

export function bitsToMods(bits: number, out: VehicleModifiers): VehicleModifiers {
    out.turbo = (bits & MOD_TURBO) !== 0;
    out.mega = (bits & MOD_MEGA) !== 0;
    out.superJump = (bits & MOD_SUPER_JUMP) !== 0;
    out.ghost = (bits & MOD_GHOST) !== 0;
    out.shield = (bits & MOD_SHIELD) !== 0;
    return out;
}

// The sim modifiers a car with these flags drives with
export function flagsToMods(flags: number, out: VehicleModifiers): VehicleModifiers {
    out.turbo = (flags & CAR_TURBO) !== 0;
    out.mega = (flags & CAR_MEGA) !== 0;
    out.superJump = (flags & CAR_SUPER_JUMP) !== 0;
    out.ghost = (flags & CAR_GHOST) !== 0;
    out.shield = (flags & (CAR_SHIELD | CAR_RESPAWN_SHIELD)) !== 0;
    return out;
}

// The flags that follow from the car state itself (the room adds the rest)
export function stateFlags(s: VehicleState): number {
    return (s.grounded ? CAR_GROUNDED : 0) | (s.boosting ? CAR_BOOSTING : 0) | (s.driftTicks > 0 ? CAR_DRIFTING : 0)
        | (s.flipAngle > 0 ? CAR_FLIPPING : 0) | (s.wasGhost ? CAR_WAS_GHOST : 0) | (s.ghostExit > 0 ? CAR_GHOST_EXIT : 0);
}

export interface SnapshotHeader {
    serverTick: number;
    // Newest input seq the server has applied for this client, -1 = none yet
    lastProcessedSeq: number;
    // Smallest lead (ticks) of this client's inputs since the last snapshot,
    // null = none arrived
    inputSlack: number | null;
    bufferTarget: number;
    carCount: number;
    // Ticks since the last snapshot the server had to repeat or stop
    missedInputs: number;
}

// ---- Self block: the recipient's own car in full precision ----

const SELF_F64 = [
    'x', 'y', 'z', 'yaw', 'vx', 'vy', 'vz', 'yawRate', 'steerAngle', 'loadX', 'rearGrip', 'betaPrev',
    'boostMeter', 'flipAngle', 'flipRate', 'scale'
] as const satisfies readonly (keyof VehicleState)[];
const SELF_U8 = ['airTicks', 'driftLowTicks', 'wallTicks', 'jumpCooldown', 'resetHold', 'reverseHold', 'ghostExit', 'prevButtons'] as const satisfies readonly (keyof VehicleState)[];
const SELF_U16 = ['driftTicks', 'ghostTicks'] as const satisfies readonly (keyof VehicleState)[];
const SELF_BOOL = ['grounded', 'boosting', 'wasGhost'] as const satisfies readonly (keyof VehicleState)[];

// Every VehicleState key is in exactly one list (checked by the codec test)
export const SELF_BLOCK_KEYS: readonly (keyof VehicleState)[] = [...SELF_F64, ...SELF_U8, ...SELF_U16, ...SELF_BOOL];

// slot, f64s, u8 and u16 counters, bools, flags u16, mods u8, input
export const SELF_BLOCK_BYTES = 1 + SELF_F64.length * 8 + SELF_U8.length + SELF_U16.length * 2 + 1 + 2 + 1 + 4;

export interface SelfBlock {
    slot: number;
    state: VehicleState;
    flags: number;
    mods: number;
    // The input the server applied in serverTick
    input: VehicleInput;
}

export function writeSelfBlock(view: DataView, at: number, slot: number, s: VehicleState, flags: number, mods: number, input: VehicleInput): number {
    view.setUint8(at++, slot);
    for (const key of SELF_F64) { view.setFloat64(at, s[key], true); at += 8; }
    for (const key of SELF_U8) view.setUint8(at++, quantByte(s[key]));
    for (const key of SELF_U16) { view.setUint16(at, Math.max(0, Math.min(65535, s[key] | 0)), true); at += 2; }
    let bits = 0;
    SELF_BOOL.forEach((key, i) => { if (s[key]) bits |= 1 << i; });
    view.setUint8(at++, bits);
    view.setUint16(at, flags & 0xffff, true); at += 2;
    view.setUint8(at++, mods & 0xff);
    return writeInput(view, at, input);
}

function readSelfBlock(view: DataView, at: number): SelfBlock | null {
    const state = createVehicleState();
    const slot = view.getUint8(at++);
    for (const key of SELF_F64) {
        const value = view.getFloat64(at, true);
        if (!Number.isFinite(value)) return null;
        state[key] = value;
        at += 8;
    }
    for (const key of SELF_U8) state[key] = view.getUint8(at++);
    for (const key of SELF_U16) { state[key] = view.getUint16(at, true); at += 2; }
    const bits = view.getUint8(at++);
    SELF_BOOL.forEach((key, i) => { state[key] = (bits & (1 << i)) !== 0; });
    const flags = view.getUint16(at, true); at += 2;
    const mods = view.getUint8(at++);
    const input = readInput(view, at);
    return { slot, state, flags, mods, input };
}

function writeInput(view: DataView, at: number, input: VehicleInput): number {
    view.setInt8(at, Math.max(-127, Math.min(127, input.steer | 0)));
    view.setUint8(at + 1, quantByte(input.throttle));
    view.setUint8(at + 2, quantByte(input.brake));
    view.setUint8(at + 3, quantByte(input.buttons));
    return at + 4;
}

function readInput(view: DataView, at: number): VehicleInput {
    return {
        steer: view.getInt8(at),
        throttle: view.getUint8(at + 1),
        brake: view.getUint8(at + 2),
        buttons: view.getUint8(at + 3)
    };
}

// ---- Compact record: every other car, 32 bytes ----

export const COMPACT_BYTES = 32;

export interface CompactCar {
    slot: number;
    flags: number;
    x: number; y: number; z: number;
    yaw: number;
    vx: number; vy: number; vz: number;
    yawRate: number;
    steerAngle: number;
    input: VehicleInput;
    scale: number;
    flipAngle: number;
    boostMeter: number;
    rearGrip: number;
    loadX: number;
    ghostTicks: number;
}

function setInt24(view: DataView, at: number, value: number): void {
    view.setUint16(at, value & 0xffff, true);
    view.setInt8(at + 2, value >> 16);
}

function getInt24(view: DataView, at: number): number {
    return view.getUint16(at, true) | (view.getInt8(at + 2) << 16);
}

export function writeCompactCar(view: DataView, at: number, slot: number, flags: number, s: VehicleState, input: VehicleInput): number {
    view.setUint8(at, slot);
    view.setUint16(at + 1, flags & 0xffff, true);
    setInt24(view, at + 3, quantPos(s.x));
    setInt24(view, at + 6, quantPos(s.z));
    view.setInt16(at + 9, quantHeight(s.y), true);
    view.setUint16(at + 11, quantYaw(s.yaw), true);
    view.setInt16(at + 13, quantSpeed(s.vx), true);
    view.setInt16(at + 15, quantSpeed(s.vy), true);
    view.setInt16(at + 17, quantSpeed(s.vz), true);
    view.setInt16(at + 19, quantYawRate(s.yawRate), true);
    view.setInt8(at + 21, quantSteer(s.steerAngle));
    writeInput(view, at + 22, input);
    view.setUint8(at + 26, quantScale(s.scale));
    view.setUint8(at + 27, quantFlip(s.flipAngle));
    view.setUint8(at + 28, quantUnit(s.boostMeter));
    view.setUint8(at + 29, quantUnit(s.rearGrip));
    view.setInt8(at + 30, quantLoad(s.loadX));
    view.setUint8(at + 31, quantByte(s.ghostTicks));
    return at + COMPACT_BYTES;
}

function readCompactCar(view: DataView, at: number): CompactCar {
    return {
        slot: view.getUint8(at),
        flags: view.getUint16(at + 1, true),
        x: getInt24(view, at + 3) * POS_STEP,
        z: getInt24(view, at + 6) * POS_STEP,
        y: view.getInt16(at + 9, true) * HEIGHT_STEP,
        yaw: unquantYaw(view.getUint16(at + 11, true)),
        vx: view.getInt16(at + 13, true) * SPEED_STEP,
        vy: view.getInt16(at + 15, true) * SPEED_STEP,
        vz: view.getInt16(at + 17, true) * SPEED_STEP,
        yawRate: view.getInt16(at + 19, true) * YAW_RATE_STEP,
        steerAngle: view.getInt8(at + 21) * STEER_STEP,
        input: readInput(view, at + 22),
        scale: 1 + view.getUint8(at + 26) / 100,
        flipAngle: unquantFlip(view.getUint8(at + 27)),
        boostMeter: view.getUint8(at + 28) / 255,
        rearGrip: view.getUint8(at + 29) / 255,
        loadX: view.getInt8(at + 30) * LOAD_STEP,
        ghostTicks: view.getUint8(at + 31)
    };
}

// ---- Whole snapshot ----

export function writeSnapshotHeader(view: DataView, header: SnapshotHeader, hasSelf: boolean): number {
    view.setUint8(0, FRAME_SNAPSHOT);
    view.setUint8(1, hasSelf ? SNAPSHOT_HAS_SELF : 0);
    view.setUint32(2, header.serverTick >>> 0, true);
    view.setUint32(6, header.lastProcessedSeq < 0 ? NO_SEQ : header.lastProcessedSeq >>> 0, true);
    view.setInt8(10, header.inputSlack === null ? NO_SLACK : Math.max(-127, Math.min(127, Math.round(header.inputSlack))));
    view.setUint8(11, quantByte(header.bufferTarget));
    view.setUint8(12, quantByte(header.carCount));
    view.setUint8(13, quantByte(header.missedInputs));
    view.setUint16(14, 0, true);
    return SNAPSHOT_HEADER_BYTES;
}

export interface Snapshot extends SnapshotHeader {
    self: SelfBlock | null;
    cars: CompactCar[];
}

export function snapshotSize(hasSelf: boolean, carCount: number): number {
    return SNAPSHOT_HEADER_BYTES + (hasSelf ? SELF_BLOCK_BYTES : 0) + carCount * COMPACT_BYTES;
}

/**
 * Builds a whole snapshot, e.g. for tests and bots; the server writes the
 * header and self block in front of a compact part it encodes once per room.
 */
export function encodeSnapshot(snapshot: Snapshot): Uint8Array {
    const bytes = new Uint8Array(snapshotSize(!!snapshot.self, snapshot.cars.length));
    const view = new DataView(bytes.buffer);
    let at = writeSnapshotHeader(view, { ...snapshot, carCount: snapshot.cars.length }, !!snapshot.self);
    if (snapshot.self) {
        const self = snapshot.self;
        at = writeSelfBlock(view, at, self.slot, self.state, self.flags, self.mods, self.input);
    }
    for (const car of snapshot.cars) {
        const s = createVehicleState();
        Object.assign(s, {
            x: car.x, y: car.y, z: car.z, yaw: car.yaw, vx: car.vx, vy: car.vy, vz: car.vz,
            yawRate: car.yawRate, steerAngle: car.steerAngle, scale: car.scale, flipAngle: car.flipAngle,
            boostMeter: car.boostMeter, rearGrip: car.rearGrip, loadX: car.loadX, ghostTicks: car.ghostTicks
        });
        at = writeCompactCar(view, at, car.slot, car.flags, s, car.input);
    }
    return bytes;
}

/**
 * The snapshot, or null when the frame is malformed (wrong kind or length)
 * or carries non-finite numbers in the self block (3.1).
 */
export function decodeSnapshot(bytes: Uint8Array): Snapshot | null {
    if (bytes.byteLength < SNAPSHOT_HEADER_BYTES) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint8(0) !== FRAME_SNAPSHOT) return null;
    const hasSelf = (view.getUint8(1) & SNAPSHOT_HAS_SELF) !== 0;
    const carCount = view.getUint8(12);
    if (bytes.byteLength !== snapshotSize(hasSelf, carCount)) return null;
    const seq = view.getUint32(6, true);
    const slack = view.getInt8(10);
    const snapshot: Snapshot = {
        serverTick: view.getUint32(2, true),
        lastProcessedSeq: seq === NO_SEQ ? -1 : seq,
        inputSlack: slack === NO_SLACK ? null : slack,
        bufferTarget: view.getUint8(11),
        carCount,
        missedInputs: view.getUint8(13),
        self: null,
        cars: []
    };
    let at = SNAPSHOT_HEADER_BYTES;
    if (hasSelf) {
        snapshot.self = readSelfBlock(view, at);
        if (!snapshot.self) return null;
        at += SELF_BLOCK_BYTES;
    }
    for (let i = 0; i < carCount; i++) {
        snapshot.cars.push(readCompactCar(view, at));
        at += COMPACT_BYTES;
    }
    return snapshot;
}

// Nominal flip rate of a remote car (one turn in 1.1 s, the standard jump)
const NOMINAL_FLIP_RATE = Math.PI * 2 / 1.1;

/**
 * A complete VehicleState from a compact record, for extrapolating a remote
 * car in the local prediction (3.4). What the record does not carry is
 * derived or set so the car neither jumps again nor starts a drift boost.
 */
export function decodeRemoteState(car: CompactCar, out: VehicleState): VehicleState {
    out.x = car.x; out.y = car.y; out.z = car.z;
    out.yaw = car.yaw;
    out.vx = car.vx; out.vy = car.vy; out.vz = car.vz;
    out.yawRate = car.yawRate;
    out.steerAngle = car.steerAngle;
    out.loadX = car.loadX;
    out.rearGrip = car.rearGrip;
    const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
    const u = car.vx * fx + car.vz * fz;
    const w = car.vx * fz - car.vz * fx;
    out.betaPrev = u > 1 ? Math.atan2(w, u) : 0;
    out.grounded = (car.flags & CAR_GROUNDED) !== 0;
    out.airTicks = out.grounded ? 0 : SIM_TUNING.COYOTE_TICKS + 1;
    out.boostMeter = car.boostMeter;
    out.boosting = (car.flags & CAR_BOOSTING) !== 0;
    out.driftTicks = (car.flags & CAR_DRIFTING) !== 0 ? 1 : 0;
    out.driftLowTicks = 0;
    out.wallTicks = 255;
    out.flipAngle = car.flipAngle;
    out.flipRate = (car.flags & CAR_FLIPPING) !== 0 ? NOMINAL_FLIP_RATE : 0;
    out.jumpCooldown = 0;
    out.resetHold = 0;
    out.reverseHold = 0;
    out.ghostTicks = car.ghostTicks;
    out.ghostExit = (car.flags & CAR_GHOST_EXIT) !== 0 ? 1 : 0;
    out.wasGhost = (car.flags & CAR_WAS_GHOST) !== 0;
    out.scale = car.scale;
    out.prevButtons = car.input.buttons;
    return out;
}
