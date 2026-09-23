import type { InputPacket } from '../../shared/net/codec.js';
import { BUFFER_TARGET_MAX, BUFFER_TARGET_MIN, INPUT_MAX_AHEAD } from '../../shared/net/constants.js';
import { clampInput, copyInput } from '../../shared/sim/inputs.js';
import { createVehicleInput, type VehicleInput } from '../../shared/sim/types.js';

// The inputs of one room member, by the server tick they are meant for
// (docs/phase-1b-design.md, 5.2). A ring of 64 entries; late, far-future
// and duplicate inputs are dropped. It also measures how early the inputs
// arrive (inputSlack) and how regularly (bufferTarget), which the client
// uses to set its lead.

const SIZE = 64;
const MASK = SIZE - 1;
// Packet arrival gaps kept for the jitter estimate (2 s at 60 packets/s)
const GAPS = 120;

export interface BufferedInput {
    tick: number;     // -1 = empty
    seq: number;
    flags: number;
    input: VehicleInput;
}

export class InputBuffer {
    private readonly ring: BufferedInput[] = [];
    // Highest tick already simulated for this member
    lastStepped = -1;
    // Highest input tick received so far: inputs above it are new, the rest
    // are the redundant copies of earlier packets
    private highestSeen = -1;
    // Since the last snapshot
    minSlack: number | null = null;
    missed = 0;
    // Totals, for metrics and tests
    late = 0;
    early = 0;
    duplicates = 0;
    accepted = 0;
    // Flags of the newest packet
    lastFlags = 0;
    bufferTarget = BUFFER_TARGET_MIN;
    private readonly gaps = new Float64Array(GAPS);
    private gapCount = 0;
    private lastArrival = -1;
    private readonly scratch = createVehicleInput();

    constructor() {
        for (let i = 0; i < SIZE; i++) this.ring.push({ tick: -1, seq: 0, flags: 0, input: createVehicleInput() });
    }

    /**
     * Stores the packet's inputs (newest first: input k is for tick - k).
     * roomTick is the last tick the room simulated; nowMs the arrival time.
     */
    accept(packet: InputPacket, roomTick: number, nowMs: number): void {
        this.lastFlags = packet.flags;
        for (let k = 0; k < packet.inputs.length; k++) {
            const tick = packet.tick - k;
            // How early each new input arrived, late ones included (<= 0):
            // the client's lead has to cover its slowest input, not the newest
            if (tick > this.highestSeen) {
                const slack = tick - roomTick;
                if (this.minSlack === null || slack < this.minSlack) this.minSlack = slack;
            }
            if (tick <= this.lastStepped || tick <= roomTick) {
                this.late++;
                continue;
            }
            if (tick > roomTick + INPUT_MAX_AHEAD) {
                this.early++;
                continue;
            }
            const slot = this.ring[tick & MASK];
            if (slot.tick === tick) {
                this.duplicates++;
                continue;
            }
            slot.tick = tick;
            slot.seq = (packet.seq - k) >>> 0;
            slot.flags = packet.flags;
            copyInput(slot.input, clampInput(copyInput(this.scratch, packet.inputs[k])));
            this.accepted++;
        }
        if (packet.tick > this.highestSeen) this.highestSeen = packet.tick;
        if (this.lastArrival >= 0) {
            this.gaps[this.gapCount % GAPS] = nowMs - this.lastArrival;
            this.gapCount++;
        }
        this.lastArrival = nowMs;
    }

    /** The input for tick, or null (the room repeats or stops). Marks the tick as simulated. */
    take(tick: number): BufferedInput | null {
        this.lastStepped = tick;
        const slot = this.ring[tick & MASK];
        if (slot.tick !== tick) return null;
        slot.tick = -1;
        return slot;
    }

    /** Jitter of the arrivals (p90 - p10 of the gaps, ms) and the lead target from it. */
    updateBufferTarget(): number {
        const n = Math.min(this.gapCount, GAPS);
        if (n < 10) return this.bufferTarget;
        const sorted = Array.from(this.gaps.subarray(0, n)).sort((a, b) => a - b);
        const jitter = sorted[Math.floor(0.9 * (n - 1))] - sorted[Math.floor(0.1 * (n - 1))];
        const target = jitter < 8 ? 1 : jitter < 25 ? 2 : 3;
        this.bufferTarget = Math.max(BUFFER_TARGET_MIN, Math.min(BUFFER_TARGET_MAX, target));
        return this.bufferTarget;
    }

    /** Slack and missed ticks since the last snapshot; starts the next window. */
    takeWindow(): { slack: number | null; missed: number } {
        const window = { slack: this.minSlack, missed: this.missed };
        this.minSlack = null;
        this.missed = 0;
        return window;
    }

    clear(): void {
        for (const slot of this.ring) slot.tick = -1;
    }
}
