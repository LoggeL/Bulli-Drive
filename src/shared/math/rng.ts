// Deterministic random helpers shared by client and server. Everything that
// has to come out identical on every machine (world layout, scenery, building
// details) draws from here instead of Math.random().

export type RandomSource = () => number;

// mulberry32: small, fast 32-bit PRNG returning floats in [0, 1). The same
// seed always yields the same sequence, so re-creating a generator from a
// fixed seed reproduces a world exactly.
export function mulberry32(seed: number): RandomSource {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
    };
}

// Stateless pseudo-random value in [0, 1) for a world position and a salt.
// Used where a detail must depend only on "where" (e.g. which windows of a
// building are lit), not on the order in which things are generated.
export function positionHash(x: number, z: number, salt: number): number {
    const n = Math.sin(x * 12.9898 + z * 78.233 + salt * 43.1234) * 43758.5453;
    return n - Math.floor(n);
}
