import { describe, expect, it } from 'vitest';
import {
    BULLI_BAY_GRID, decodeHeightfield, encodeHeightfield, heightAt, HeightfieldFormatError, meshDeviation,
    predictDecode, predictEncode, quantizeHeight, surfaceAt, unzigzag16, waterDepth, zigzag16,
    zoneAt, zoneCols, zoneRows, type GridSpec, type Heightfield
} from '../../../src/shared/map/heightfield.js';

// The baked heightfield (docs/phase-3-design.md, section 6). All expected
// values are worked out by hand on tiny grids; offset 0 and scale 1 make
// the stored integers the heights in metres.

const UNIT: GridSpec = {
    cols: 2, rows: 2, cellSize: 2, originX: 0, originZ: 0,
    heightOffset: 0, heightScale: 1, waterLevel: 0, zoneCell: 2
};

function field(spec: GridSpec, q: number[], surface?: number[], zones?: number[]): Heightfield {
    return {
        spec,
        q: Uint16Array.from(q),
        surface: Uint8Array.from(surface ?? q.map(() => 0)),
        zones: Uint8Array.from(zones ?? new Array(zoneCols(spec) * zoneRows(spec)).fill(0)),
        mapVersion: 7,
        sourceHash: Uint8Array.from({ length: 16 }, (_, i) => i * 17)
    };
}

describe('heightAt (bilinear, 6.3)', () => {
    // q row by row, z outer: (x=0,z=0)=0, (x=2,z=0)=3, (x=0,z=2)=7, (x=2,z=2)=11
    const hf = field(UNIT, [0, 3, 7, 11]);

    it('returns the stored heights exactly at the corners', () => {
        expect(heightAt(hf, 0, 0)).toBe(0);
        expect(heightAt(hf, 2, 0)).toBe(3);
        expect(heightAt(hf, 0, 2)).toBe(7);
        expect(heightAt(hf, 2, 2)).toBe(11);
    });

    it('returns the mean of the four corners in the middle of a cell', () => {
        expect(heightAt(hf, 1, 1)).toBe((0 + 3 + 7 + 11) / 4);
    });

    it('interpolates linearly along the cell edges', () => {
        expect(heightAt(hf, 1, 0)).toBe(1.5);   // between 0 and 3
        expect(heightAt(hf, 0, 1)).toBe(3.5);   // between 0 and 7
        expect(heightAt(hf, 2, 1)).toBe(7);     // between 3 and 11
        expect(heightAt(hf, 1, 2)).toBe(9);     // between 7 and 11
    });

    it('keeps x and z apart (fx along x, fz along z)', () => {
        // gx = 0.25, gz = 0.75: top = 0 + 3·0.25 = 0.75, bottom = 7 + 4·0.25 = 8,
        // h = 0.75 + (8 - 0.75)·0.75 = 6.1875 (exact in binary)
        expect(heightAt(hf, 0.5, 1.5)).toBe(6.1875);
        // Swapped: gx = 0.75, gz = 0.25: top = 2.25, bottom = 10, h = 4.1875
        expect(heightAt(hf, 1.5, 0.5)).toBe(4.1875);
    });

    it('clamps positions outside the grid to the border', () => {
        expect(heightAt(hf, -5, -5)).toBe(0);
        expect(heightAt(hf, 50, -1)).toBe(3);
        expect(heightAt(hf, -1, 50)).toBe(7);
        expect(heightAt(hf, 1, -100)).toBe(1.5);
        expect(heightAt(hf, 100, 100)).toBe(11);
    });

    it('clamps a position less than one cell beyond the last row or column', () => {
        // gx = 1.5 would extrapolate the last cell to 0 + 3·1.5 = 4.5
        expect(heightAt(hf, 3, 0)).toBe(3);
        expect(heightAt(hf, 0, 3.5)).toBe(7);
        expect(heightAt(hf, 3, 3)).toBe(11);
    });

    it('returns NaN for NaN and the border value for infinities', () => {
        expect(heightAt(hf, NaN, 1)).toBeNaN();
        expect(heightAt(hf, Infinity, Infinity)).toBe(11);
        expect(heightAt(hf, -Infinity, 0)).toBe(0);
    });

    it('uses the last cell for the last row and column of a larger grid', () => {
        const spec: GridSpec = { ...UNIT, cols: 3, rows: 3 };
        // Heights 10·row + col
        const big = field(spec, [0, 1, 2, 10, 11, 12, 20, 21, 22]);
        expect(heightAt(big, 4, 4)).toBe(22);
        expect(heightAt(big, 4, 3)).toBe(17);   // between 12 and 22
        expect(heightAt(big, 3, 4)).toBe(21.5); // between 21 and 22
        expect(heightAt(big, 2, 2)).toBe(11);
    });

    it('applies offset and scale of the Bulli Bay grid (1 cm steps from -20 m)', () => {
        const spec: GridSpec = { ...BULLI_BAY_GRID, cols: 2, rows: 2 };
        // q = 2000 → -20 + 2000·0.01 = 0; q = 2150 → 1.5 m
        const hf2 = field(spec, [2000, 2150, 2000, 2150]);
        expect(heightAt(hf2, -1000, -1000)).toBeCloseTo(0, 12);
        expect(heightAt(hf2, -998, -1000)).toBeCloseTo(1.5, 12);
        expect(heightAt(hf2, -999, -999)).toBeCloseTo(0.75, 12);
    });
});

describe('meshDeviation (terrain mesh against the bilinear ground)', () => {
    // Corners 0, 3, 7, 11: d = h00 + h11 - h10 - h01 = 0 + 11 - 3 - 7 = 1.
    // Two triangles through the corners give the centre either (0 + 11) / 2
    // = 5.5 or (3 + 7) / 2 = 5; the bilinear centre is 21 / 4 = 5.25, both
    // miss it by 0.25 = |d| / 4.
    const hf = field(UNIT, [0, 3, 7, 11]);

    it('is a quarter of the twist of the cell, the miss of either diagonal at the centre', () => {
        expect(meshDeviation(hf, 0, 0)).toBe(0.25);
        expect(Math.abs(heightAt(hf, 1, 1) - (0 + 11) / 2)).toBe(0.25);
        expect(Math.abs(heightAt(hf, 1, 1) - (3 + 7) / 2)).toBe(0.25);
    });

    it('shrinks with the square of the subdivision', () => {
        // Half-size quads: each has a quarter of the twist, missing by 1/16
        expect(meshDeviation(hf, 0, 0, 2)).toBe(1 / 16);
        expect(meshDeviation(hf, 0, 0, 4)).toBe(1 / 64);
    });

    it('is 0 for a plane and outside the grid, and scales to metres', () => {
        expect(meshDeviation(field(UNIT, [1, 3, 5, 7]), 0, 0)).toBe(0);
        expect(meshDeviation(hf, 1, 0)).toBe(0);
        expect(meshDeviation(hf, -1, 0)).toBe(0);
        // 1 cm steps: a twist of 100 steps is 1 m, a quarter of it 0.25 m
        const cm = field({ ...UNIT, heightScale: 0.01 }, [0, 0, 0, 100]);
        expect(meshDeviation(cm, 0, 0)).toBe(0.25);
    });
});

describe('surfaceAt, zoneAt, waterDepth', () => {
    const spec: GridSpec = { ...UNIT, cols: 3, rows: 3, zoneCell: 2 };
    const hf = field(spec, [0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 1, 2, 3, 4, 5, 6, 7, 8], [10, 11, 12, 13]);

    it('takes the surface of the nearest grid point, halfway rounding up', () => {
        expect(surfaceAt(hf, 0, 0)).toBe(0);
        expect(surfaceAt(hf, 0.9, 0)).toBe(0);
        expect(surfaceAt(hf, 1, 0)).toBe(1);      // exactly halfway: next point
        expect(surfaceAt(hf, 3.2, 2.9)).toBe(5);  // (i 2, j 1)
        expect(surfaceAt(hf, -7, 99)).toBe(6);    // clamped to (0, 2)
        // Less than a cell beyond the last column or row, and above the first row
        expect(surfaceAt(hf, 5.5, -3)).toBe(2);   // (3, -1) clamped to (2, 0)
        expect(surfaceAt(hf, 0, 5.5)).toBe(6);    // (0, 3) clamped to (0, 2)
    });

    it('takes the zone of the zone cell containing the position', () => {
        expect(zoneAt(hf, 0.5, 0.5)).toBe(10);
        expect(zoneAt(hf, 2.5, 0.5)).toBe(11);
        expect(zoneAt(hf, 0.5, 3.9)).toBe(12);
        expect(zoneAt(hf, 99, 99)).toBe(13);
        expect(zoneAt(hf, -5, -5)).toBe(10);
        // The 2 × 2 zone cells end at 4 m: the grid's last row and column of
        // points belong to the last zone cell
        expect(zoneAt(hf, 4.5, 0.5)).toBe(11);
        expect(zoneAt(hf, 0.5, 5)).toBe(12);
    });

    it('measures water depth from the water level', () => {
        const wet = field({ ...UNIT, waterLevel: 1 }, [0, 4, 0, 4]);
        expect(waterDepth(wet, 0, 0)).toBe(1);
        expect(waterDepth(wet, 2, 0)).toBe(-3);
        expect(waterDepth(wet, 1, 1)).toBe(-1);
    });
});

describe('quantizeHeight', () => {
    const spec = BULLI_BAY_GRID;
    it('maps metres to 1 cm steps from -20 m, clamped to 16 bit', () => {
        expect(quantizeHeight(spec, -20)).toBe(0);
        expect(quantizeHeight(spec, 0)).toBe(2000);
        expect(quantizeHeight(spec, 1.234)).toBe(2123);
        expect(quantizeHeight(spec, 1.236)).toBe(2124);
        expect(quantizeHeight(spec, -25)).toBe(0);
        expect(quantizeHeight(spec, 635.35)).toBe(65535);
        expect(quantizeHeight(spec, 700)).toBe(65535);
    });
});

describe('row predictor (6.2)', () => {
    it('zigzags small signed residuals to small unsigned ones', () => {
        expect(zigzag16(0)).toBe(0);
        expect(zigzag16(-1)).toBe(1);
        expect(zigzag16(1)).toBe(2);
        expect(zigzag16(-2)).toBe(3);
        expect(zigzag16(32767)).toBe(65534);
        expect(zigzag16(-32767)).toBe(65533);
        expect(zigzag16(-32768)).toBe(65535);
        // Modulo 2^16: 65535 is -1
        expect(zigzag16(65535)).toBe(1);
        for (const z of [0, 1, 2, 3, 65533, 65534, 65535]) expect(zigzag16(unzigzag16(z))).toBe(z);
        expect(unzigzag16(1)).toBe(65535);
        expect(unzigzag16(4)).toBe(2);
    });

    it('encodes a hand-worked 3 × 3 grid', () => {
        const q = Uint16Array.from([10, 12, 15, 11, 14, 18, 13, 17, 22]);
        // Residuals: first point raw, first row left only, first column up
        // only, else q - left - up + upleft
        //   10  2  3
        //    1  1  1
        //    2  1  1
        // zigzagged ×2
        expect(Array.from(predictEncode(q, 3, 3))).toEqual([20, 4, 6, 2, 2, 2, 4, 2, 2]);
    });

    it('decodes what it encodes, also across the 16-bit wrap-around', () => {
        const q = Uint16Array.from([0, 65535, 0, 65535, 0, 65535, 12345, 0, 40000, 1, 2, 3]);
        expect(Array.from(predictDecode(predictEncode(q, 4, 3), 4, 3))).toEqual(Array.from(q));
    });
});

describe('terrain.bhf file format (6.1)', () => {
    const spec: GridSpec = { ...BULLI_BAY_GRID, cols: 5, rows: 5, zoneCell: 4 };
    const n = 25;
    const hf = field(spec,
        Array.from({ length: n }, (_, k) => 2000 + 37 * k - (k % 3) * 11),
        Array.from({ length: n }, (_, k) => k % 10),
        [1, 2, 3, 4]);

    it('writes the header fields at their offsets', () => {
        const bytes = encodeHeightfield(hf);
        const view = new DataView(bytes.buffer);
        expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('BDHF');
        expect(view.getUint16(4, true)).toBe(1);
        expect(view.getUint16(6, true)).toBe(1);
        expect(view.getUint16(8, true)).toBe(5);
        expect(view.getUint16(10, true)).toBe(5);
        expect(view.getFloat32(12, true)).toBe(2);
        expect(view.getFloat32(16, true)).toBe(-1000);
        expect(view.getFloat32(24, true)).toBe(-20);
        expect(view.getUint16(38, true)).toBe(4);
        expect(view.getUint32(40, true)).toBe(7);
        expect(Array.from(bytes.subarray(44, 60))).toEqual(Array.from(hf.sourceHash));
        // 64 header + 2·25 heights + 25 surface + 2·2 zones
        expect(bytes.length).toBe(64 + 50 + 25 + 4);
        // First height is stored raw (zigzag of 2000)
        expect(view.getUint16(64, true)).toBe(4000);
    });

    it('reads back what it writes', () => {
        const back = decodeHeightfield(encodeHeightfield(hf), spec);
        expect(Array.from(back.q)).toEqual(Array.from(hf.q));
        expect(Array.from(back.surface)).toEqual(Array.from(hf.surface));
        expect(Array.from(back.zones)).toEqual([1, 2, 3, 4]);
        expect(back.mapVersion).toBe(7);
        expect(Array.from(back.sourceHash)).toEqual(Array.from(hf.sourceHash));
        expect(back.spec).toBe(spec);
    });

    it('stores the water level little-endian like every other field', () => {
        const wet: GridSpec = { ...spec, waterLevel: 0.5 };
        const bytes = encodeHeightfield({ ...hf, spec: wet });
        expect(new DataView(bytes.buffer).getFloat32(32, true)).toBe(0.5);
        expect(decodeHeightfield(bytes, wet).spec.waterLevel).toBe(0.5);
    });

    it('reads a file that sits at an odd offset in a larger buffer', () => {
        const bytes = encodeHeightfield(hf);
        const padded = new Uint8Array(bytes.length + 3);
        padded.set(bytes, 1);
        const back = decodeHeightfield(padded.subarray(1, 1 + bytes.length), spec);
        expect(Array.from(back.q)).toEqual(Array.from(hf.q));
    });

    it('rejects a wrong magic, version, grid, header value or length', () => {
        const good = encodeHeightfield(hf);
        const broken = (edit: (bytes: Uint8Array, view: DataView) => void) => {
            const bytes = good.slice();
            edit(bytes, new DataView(bytes.buffer));
            return () => decodeHeightfield(bytes, spec);
        };
        expect(broken(b => { b[0] = 0x58; })).toThrow(/magic/);
        expect(broken((_, v) => v.setUint16(4, 2, true))).toThrow(/version 2/);
        expect(broken((_, v) => v.setUint16(8, 6, true))).toThrow(/grid is 6 × 5/);
        expect(broken((_, v) => v.setFloat32(16, -999, true))).toThrow(/originX/);
        expect(broken((_, v) => v.setFloat32(28, 0.02, true))).toThrow(/heightScale/);
        expect(broken((_, v) => v.setUint16(38, 8, true))).toThrow(/zone cell/);
        expect(broken((_, v) => v.setUint16(36, 4, true))).toThrow(/surface or zone cell/);
        expect(() => decodeHeightfield(good.subarray(0, good.length - 1), spec)).toThrow(/bytes/);
        expect(() => decodeHeightfield(good.subarray(0, 10), spec)).toThrow(HeightfieldFormatError);
        expect(() => decodeHeightfield(good, { ...spec, cols: 4 })).toThrow(/grid is 5 × 5, the map expects 4 × 5/);
    });

    it('refuses to write layers that do not fit the grid', () => {
        expect(() => encodeHeightfield({ ...hf, surface: new Uint8Array(3) })).toThrow(HeightfieldFormatError);
        expect(() => encodeHeightfield({ ...hf, q: new Uint16Array(24) })).toThrow(/layer sizes/);
        expect(() => encodeHeightfield({ ...hf, zones: new Uint8Array(5) })).toThrow(/layer sizes/);
        expect(() => encodeHeightfield({ ...hf, sourceHash: new Uint8Array(8) })).toThrow(/16 bytes/);
    });
});
