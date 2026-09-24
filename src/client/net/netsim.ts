import { mulberry32 } from '../../shared/math/rng.js';
import { NetsimConnection, parseNetsimFlag, type NetsimOptions } from '../../shared/net/netsim.js';

// The client side of the dev netsim (docs/phase-1b-design.md, 11.5):
// ?netsim=RTT,JITTER,LOSS[,MODE], e.g. ?netsim=150,30,3. It only touches
// this tab's own socket, so it works in every build, live included. Each
// socket gets its own pair of links, so nothing of an old connection
// arrives on a new one.

export const NETSIM: NetsimOptions | null = (() => {
    try {
        const flag = new URLSearchParams(window.location.search).get('netsim');
        const options = parseNetsimFlag(flag);
        if (flag && !options) console.warn(`?netsim=${flag} is not valid (expected RTT,JITTER,LOSS[,tcp|drop])`);
        return options;
    } catch {
        return null;
    }
})();

let seed = 1;

const clock = {
    now: () => performance.now(),
    setTimeout: (fn: () => void, ms: number) => window.setTimeout(fn, ms)
};

/** A netsim for a new socket, or null without ?netsim. */
export function createSocketNetsim(): NetsimConnection | null {
    if (!NETSIM) return null;
    return new NetsimConnection(NETSIM, mulberry32(0xb011 + seed++ * 7919), clock);
}
