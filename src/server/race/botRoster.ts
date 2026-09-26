import type { RandomSource } from '../../shared/math/rng.js';
import type { CarClassId } from '../../shared/sim/types.js';
import { CAR_CLASS_IDS } from '../../shared/sim/vehicleClasses.js';
import { Session, type Transport } from '../session.js';
import { randomPaint } from '../../shared/paints.js';

// The race bots as room members (docs/phase-2-design.md, 6.3): a real
// Session on a null transport (open, sends nothing, no round trip), so slot
// allocation, snapshots, member info, stepWorld and events need no special
// paths. Names, classes and paints come from a seed per room and race.

export const BOT_NAMES: readonly string[] = ['Kalle', 'Uschi', 'Hotte', 'Gabi', 'Manni', 'Heike', 'Jupp'];


class NullTransport implements Transport {
    readonly readyState = 1;
    readonly bufferedAmount = 0;
    send(): void { /* a bot reads nothing */ }
    close(): void { /* nothing to close */ }
}

export class BotSession extends Session {
    constructor(id: string, name: string, color: number, carType: CarClassId) {
        super(id, new NullTransport(), name, color);
        this.carType = carType;
        this.profile = 'standard';
        this.rttMs = 0;
    }
}

export interface BotIdentity {
    name: string;
    color: number;
    carType: CarClassId;
}

/**
 * count bot identities for one race: distinct names (while there are
 * enough), in a shuffled order, each with a class and a colour.
 */
export function drawBots(count: number, random: RandomSource): BotIdentity[] {
    const names = [...BOT_NAMES];
    // Fisher-Yates with the seeded source
    for (let i = names.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [names[i], names[j]] = [names[j], names[i]];
    }
    const out: BotIdentity[] = [];
    for (let i = 0; i < count; i++) {
        out.push({
            name: names[i % names.length],
            // The players' palette (docs/ui.md 5)
            color: randomPaint(random).hex,
            carType: CAR_CLASS_IDS[Math.floor(random() * CAR_CLASS_IDS.length)]
        });
    }
    return out;
}
