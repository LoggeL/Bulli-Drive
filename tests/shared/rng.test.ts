import { describe, expect, it } from 'vitest';
import { mulberry32, positionHash } from '../../src/shared/math/rng.js';
import { sha256OfFloats } from '../helpers.js';

// Golden values were recorded from the untouched implementations on main
// (1d39c07): createSeededRandom in src/server/world.ts and
// src/client/world/environment.ts, seededRandom in src/client/world/city.ts.

const WORLD_SEED = 0xB0111D;
const SCENERY_SEED = 0x42554c4c;

describe('mulberry32', () => {
    it('reproduces the world seed sequence', () => {
        const random = mulberry32(WORLD_SEED);
        expect(Array.from({ length: 8 }, () => random())).toEqual([
            0.21735702641308308,
            0.8369368209969252,
            0.04722317191772163,
            0.8002115359995514,
            0.43753488920629025,
            0.7611915387678891,
            0.5888137936126441,
            0.2566163132432848
        ]);
    });

    it('reproduces the client scenery sequence', () => {
        const random = mulberry32(SCENERY_SEED);
        expect(Array.from({ length: 8 }, () => random())).toEqual([
            0.38406452629715204,
            0.6520440154708922,
            0.4172500695567578,
            0.7337619757745415,
            0.4993297616019845,
            0.1354980869218707,
            0.4818167285993695,
            0.7744492334313691
        ]);
    });

    it('handles seed 0', () => {
        const random = mulberry32(0);
        expect(Array.from({ length: 4 }, () => random())).toEqual([
            0.26642920868471265,
            0.0003297457005828619,
            0.2232720274478197,
            0.1462021479383111
        ]);
    });

    it('matches the golden hash over 10k values', () => {
        const random = mulberry32(WORLD_SEED);
        const values = Array.from({ length: 10000 }, () => random());
        expect(sha256OfFloats(values)).toBe('8671677248110f9ca337d090078f27841e3f42c08cc98893861dd083a0deadb8');
        expect(values.every(v => v >= 0 && v < 1)).toBe(true);
    });

    it('restarts the sequence for a new generator with the same seed', () => {
        const a = mulberry32(1234);
        const b = mulberry32(1234);
        a();
        const c = mulberry32(1234);
        expect(b()).toBe(c());
    });
});

describe('positionHash', () => {
    it('reproduces the building detail hash', () => {
        expect([
            positionHash(0, 0, 0),
            positionHash(12.5, -7.25, 1),
            positionHash(-104, 55, 7),
            positionHash(300.1, 2.2, 43)
        ]).toEqual([0, 0.3831852141847776, 0.21899862099962775, 0.9636096651775006]);
    });
});
