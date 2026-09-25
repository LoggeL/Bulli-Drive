// The baked heightfield (docs/phase-3-design.md, section 6): the file format
// terrain.bhf, its row predictor and the queries heightAt, surfaceAt,
// zoneAt and waterDepth.
//
// Client and server read the same bytes and call the same heightAt, which
// uses only +, -, ×, ÷ and Math.floor on doubles. IEEE-754 rounds each of
// these exactly and JavaScript never contracts them into an FMA, so the
// height is bit-identical in every engine (design E4). The order of the
// operations in heightAt is part of that contract: changing it changes the
// sim (golden runs, mapVersion).

// Grid of a map. The numbers are JS doubles from the code; the header's
// f32 copies are only checked against them (0.01 has no exact f32).
export interface GridSpec {
    cols: number;
    rows: number;
    cellSize: number;
    originX: number;
    originZ: number;
    heightOffset: number;
    heightScale: number;
    waterLevel: number;
    // Edge length of a zone cell (multiple of cellSize)
    zoneCell: number;
}

// Bulli Bay: 2 × 2 km, 2 m grid, 1 cm height steps from -20 m (design E3)
export const BULLI_BAY_GRID: GridSpec = {
    cols: 1001,
    rows: 1001,
    cellSize: 2,
    originX: -1000,
    originZ: -1000,
    heightOffset: -20,
    heightScale: 0.01,
    waterLevel: 0,
    zoneCell: 8
};

export function zoneCols(spec: GridSpec): number {
    return Math.floor((spec.cols - 1) * spec.cellSize / spec.zoneCell);
}

export function zoneRows(spec: GridSpec): number {
    return Math.floor((spec.rows - 1) * spec.cellSize / spec.zoneCell);
}

export interface Heightfield {
    spec: GridSpec;
    // Quantised heights, row by row (z outer, x inner): h = offset + q·scale
    q: Uint16Array;
    // Surface ID per grid point (SURFACE in types.ts)
    surface: Uint8Array;
    // Zone ID per zone cell (ZONE in types.ts)
    zones: Uint8Array;
    mapVersion: number;
    // FNV-1a-128 over the sources and the bake version (16 bytes)
    sourceHash: Uint8Array;
}

// ---- Queries ----

// Bilinear height at (x, z). Outside the grid the border value.
export function heightAt(hf: Heightfield, x: number, z: number): number {
    const spec = hf.spec;
    const cols = spec.cols, rows = spec.rows;
    let gx = (x - spec.originX) / spec.cellSize;
    let gz = (z - spec.originZ) / spec.cellSize;
    if (gx < 0) gx = 0; else if (gx > cols - 1) gx = cols - 1;
    if (gz < 0) gz = 0; else if (gz > rows - 1) gz = rows - 1;
    let i = Math.floor(gx); if (i > cols - 2) i = cols - 2;
    let j = Math.floor(gz); if (j > rows - 2) j = rows - 2;
    const fx = gx - i, fz = gz - j;
    const k = j * cols + i;
    const q = hf.q;
    const h00 = q[k], h10 = q[k + 1], h01 = q[k + cols], h11 = q[k + cols + 1];
    const top = h00 + (h10 - h00) * fx;
    const bottom = h01 + (h11 - h01) * fx;
    return spec.heightOffset + (top + (bottom - top) * fz) * spec.heightScale;
}

// Index of the grid point nearest to (x, z), clamped into the grid
function nearestPoint(spec: GridSpec, x: number, z: number): number {
    let i = Math.floor((x - spec.originX) / spec.cellSize + 0.5);
    let j = Math.floor((z - spec.originZ) / spec.cellSize + 0.5);
    if (i < 0) i = 0; else if (i > spec.cols - 1) i = spec.cols - 1;
    if (j < 0) j = 0; else if (j > spec.rows - 1) j = spec.rows - 1;
    return j * spec.cols + i;
}

// Surface ID of the nearest grid point (design E6: no blending, O(1))
export function surfaceAt(hf: Heightfield, x: number, z: number): number {
    return hf.surface[nearestPoint(hf.spec, x, z)];
}

// Zone ID of the zone cell containing (x, z)
export function zoneAt(hf: Heightfield, x: number, z: number): number {
    const spec = hf.spec;
    const cols = zoneCols(spec), rows = zoneRows(spec);
    let i = Math.floor((x - spec.originX) / spec.zoneCell);
    let j = Math.floor((z - spec.originZ) / spec.zoneCell);
    if (i < 0) i = 0; else if (i > cols - 1) i = cols - 1;
    if (j < 0) j = 0; else if (j > rows - 1) j = rows - 1;
    return hf.zones[j * cols + i];
}

// How far the terrain mesh can stray from the sim's ground in cell (i, j)
// (m): the bilinear surface of a cell is h00 + (h10-h00)·fx + (h01-h00)·fz
// + d·fx·fz with d = h00 + h11 - h10 - h01. Two triangles through the four
// corners miss it by up to |d| / 4 (at the cell's centre, either diagonal);
// a mesh with a vertex every cellSize / k on the bilinear surface misses it
// by |d| / (4 k²). Cells outside the grid count as 0.
export function meshDeviation(hf: Heightfield, i: number, j: number, subdivision = 1): number {
    const { cols, rows, heightScale } = hf.spec;
    if (i < 0 || j < 0 || i >= cols - 1 || j >= rows - 1) return 0;
    const k = j * cols + i;
    const q = hf.q;
    const d = q[k] + q[k + cols + 1] - q[k + 1] - q[k + cols];
    return Math.abs(d) * heightScale / (4 * subdivision * subdivision);
}

// Water depth above the ground (negative on land), section 7
export function waterDepth(hf: Heightfield, x: number, z: number): number {
    return hf.spec.waterLevel - heightAt(hf, x, z);
}

// Quantises a height in metres (round half up, clamped to 0..65535)
export function quantizeHeight(spec: GridSpec, h: number): number {
    const q = Math.floor((h - spec.heightOffset) / spec.heightScale + 0.5);
    return q < 0 ? 0 : q > 65535 ? 65535 : q;
}

// ---- Row predictor (6.2) ----

// Zigzag of a 16-bit two's complement value: 0, -1, 1, -2, ... → 0, 1, 2, 3, ...
export function zigzag16(r: number): number {
    const s = (r << 16) >> 16;
    return ((s << 1) ^ (s >> 15)) & 0xffff;
}

export function unzigzag16(z: number): number {
    return ((z >>> 1) ^ -(z & 1)) & 0xffff;
}

// r = q[i,j] - q[i-1,j] - q[i,j-1] + q[i-1,j-1] (first row: left only,
// first column: up only), modulo 2^16 and zigzagged. Smooth terrain gives
// small residuals that compress well.
export function predictEncode(q: Uint16Array, cols: number, rows: number): Uint16Array {
    const out = new Uint16Array(cols * rows);
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
            const k = j * cols + i;
            let p = 0;
            if (i > 0 && j > 0) p = q[k - 1] + q[k - cols] - q[k - cols - 1];
            else if (i > 0) p = q[k - 1];
            else if (j > 0) p = q[k - cols];
            out[k] = zigzag16(q[k] - p);
        }
    }
    return out;
}

export function predictDecode(residuals: Uint16Array, cols: number, rows: number): Uint16Array {
    const q = new Uint16Array(cols * rows);
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
            const k = j * cols + i;
            let p = 0;
            if (i > 0 && j > 0) p = q[k - 1] + q[k - cols] - q[k - cols - 1];
            else if (i > 0) p = q[k - 1];
            else if (j > 0) p = q[k - cols];
            q[k] = (p + unzigzag16(residuals[k])) & 0xffff;
        }
    }
    return q;
}

// ---- File format terrain.bhf (6.1) ----

export const BHF_MAGIC = 'BDHF';
export const BHF_VERSION = 1;
export const BHF_HEADER_BYTES = 64;
const FLAG_PREDICTOR = 1;

export class HeightfieldFormatError extends Error {}

export function heightfieldByteLength(spec: GridSpec): number {
    const n = spec.cols * spec.rows;
    return BHF_HEADER_BYTES + 2 * n + n + zoneCols(spec) * zoneRows(spec);
}

export function encodeHeightfield(hf: Heightfield): Uint8Array {
    const spec = hf.spec;
    const n = spec.cols * spec.rows;
    if (hf.q.length !== n || hf.surface.length !== n || hf.zones.length !== zoneCols(spec) * zoneRows(spec)) {
        throw new HeightfieldFormatError('layer sizes do not match the grid');
    }
    if (hf.sourceHash.length !== 16) throw new HeightfieldFormatError('sourceHash must be 16 bytes');
    const bytes = new Uint8Array(heightfieldByteLength(spec));
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < 4; i++) bytes[i] = BHF_MAGIC.charCodeAt(i);
    view.setUint16(4, BHF_VERSION, true);
    view.setUint16(6, FLAG_PREDICTOR, true);
    view.setUint16(8, spec.cols, true);
    view.setUint16(10, spec.rows, true);
    view.setFloat32(12, spec.cellSize, true);
    view.setFloat32(16, spec.originX, true);
    view.setFloat32(20, spec.originZ, true);
    view.setFloat32(24, spec.heightOffset, true);
    view.setFloat32(28, spec.heightScale, true);
    view.setFloat32(32, spec.waterLevel, true);
    view.setUint16(36, spec.cellSize, true);
    view.setUint16(38, spec.zoneCell, true);
    view.setUint32(40, hf.mapVersion, true);
    bytes.set(hf.sourceHash, 44);
    view.setUint32(60, 0, true);
    const residuals = predictEncode(hf.q, spec.cols, spec.rows);
    let offset = BHF_HEADER_BYTES;
    for (let k = 0; k < n; k++, offset += 2) view.setUint16(offset, residuals[k], true);
    bytes.set(hf.surface, offset);
    offset += n;
    bytes.set(hf.zones, offset);
    return bytes;
}

function checkF32(view: DataView, offset: number, expected: number, name: string): void {
    const value = view.getFloat32(offset, true);
    if (!(Math.abs(value - expected) <= 1e-6 * Math.max(1, Math.abs(expected)))) {
        throw new HeightfieldFormatError(`${name} is ${value}, the map expects ${expected}`);
    }
}

// Reads a terrain.bhf and checks it against the grid the code expects.
// Throws HeightfieldFormatError on any mismatch. After the check only the
// spec's doubles are used, never the header's f32 values.
export function decodeHeightfield(bytes: Uint8Array, spec: GridSpec): Heightfield {
    if (bytes.length < BHF_HEADER_BYTES) throw new HeightfieldFormatError(`file too short (${bytes.length} bytes)`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let magic = '';
    for (let i = 0; i < 4; i++) magic += String.fromCharCode(bytes[i]);
    if (magic !== BHF_MAGIC) throw new HeightfieldFormatError(`not a heightfield (magic "${magic}")`);
    const version = view.getUint16(4, true);
    if (version !== BHF_VERSION) throw new HeightfieldFormatError(`unsupported version ${version}`);
    const flags = view.getUint16(6, true);
    const cols = view.getUint16(8, true), rows = view.getUint16(10, true);
    if (cols !== spec.cols || rows !== spec.rows) {
        throw new HeightfieldFormatError(`grid is ${cols} × ${rows}, the map expects ${spec.cols} × ${spec.rows}`);
    }
    checkF32(view, 12, spec.cellSize, 'cellSize');
    checkF32(view, 16, spec.originX, 'originX');
    checkF32(view, 20, spec.originZ, 'originZ');
    checkF32(view, 24, spec.heightOffset, 'heightOffset');
    checkF32(view, 28, spec.heightScale, 'heightScale');
    checkF32(view, 32, spec.waterLevel, 'waterLevel');
    if (view.getUint16(36, true) !== spec.cellSize || view.getUint16(38, true) !== spec.zoneCell) {
        throw new HeightfieldFormatError('surface or zone cell size does not match the map');
    }
    const expected = heightfieldByteLength(spec);
    if (bytes.length !== expected) {
        throw new HeightfieldFormatError(`file has ${bytes.length} bytes, the grid needs ${expected}`);
    }
    const n = cols * rows;
    const raw = new Uint16Array(n);
    let offset = BHF_HEADER_BYTES;
    for (let k = 0; k < n; k++, offset += 2) raw[k] = view.getUint16(offset, true);
    const q = flags & FLAG_PREDICTOR ? predictDecode(raw, cols, rows) : raw;
    const surface = bytes.slice(offset, offset + n);
    offset += n;
    const zones = bytes.slice(offset, offset + zoneCols(spec) * zoneRows(spec));
    return {
        spec, q, surface, zones,
        mapVersion: view.getUint32(40, true),
        sourceHash: bytes.slice(44, 60)
    };
}
