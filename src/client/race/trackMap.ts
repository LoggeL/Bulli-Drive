import { createCourse } from '../../shared/race/progress.js';
import type { TrackDef } from '../../shared/race/types.js';
import { gateEnds } from './trackLayout.js';

// A track seen from above, north up (docs/phase-2-design.md, 17.3, with
// the compass of the curated map, docs/phase-3-design.md E2: north = -z up,
// east = +x to the right): the frame that fits the track's minimap bounds
// into a canvas, and the drawing of the racing line with its gates, used by
// the minimap in track mode and the preview in the lobby.

export interface MapFrame {
    scale: number;       // px per m
    cx: number; cz: number;
    width: number; height: number;
}

/** Fits the bounds into width x height px with `padding` px on every side, centred. */
export function fitFrame(bounds: TrackDef['minimap'], width: number, height: number, padding: number): MapFrame {
    const w = bounds.maxX - bounds.minX, h = bounds.maxZ - bounds.minZ;
    const scale = Math.min((width - 2 * padding) / w, (height - 2 * padding) / h);
    return { scale, cx: (bounds.minX + bounds.maxX) / 2, cz: (bounds.minZ + bounds.maxZ) / 2, width, height };
}

/** Canvas position of the world point (x, z). */
export function toMap(frame: MapFrame, x: number, z: number): { px: number; py: number } {
    return { px: frame.width / 2 + (x - frame.cx) * frame.scale, py: frame.height / 2 + (z - frame.cz) * frame.scale };
}

/** Canvas angle (for ctx.rotate, 0 = pointing up) of a heading yaw. */
export function mapHeading(yaw: number): number {
    // Forward (sin yaw, cos yaw) is (sin yaw, cos yaw) on the canvas (px
    // grows with +x, py with +z); up (0, -1) turned clockwise by π - yaw
    return Math.PI - yaw;
}

const lines = new Map<TrackDef['id'], { x: number; z: number }[]>();

function linePoints(track: TrackDef): { x: number; z: number }[] {
    let points = lines.get(track.id);
    if (!points) {
        points = createCourse(track).line.points.map(p => ({ x: p.x, z: p.z }));
        lines.set(track.id, points);
    }
    return points;
}

export interface TrackDrawStyle {
    band: number;          // line width of the racing line (px)
    lineColor: string;
    gateColor: string;
    nextGate?: number;     // highlighted gate
}

/** Draws the racing line, the gates as cross bars and a chequered start/finish into ctx. */
export function drawTrack(ctx: CanvasRenderingContext2D, frame: MapFrame, track: TrackDef, style: TrackDrawStyle): void {
    const points = linePoints(track);
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(10, 16, 16, 0.55)';
    ctx.lineWidth = style.band + 2;
    const path = () => {
        ctx.beginPath();
        points.forEach((p, i) => {
            const m = toMap(frame, p.x, p.z);
            if (i === 0) ctx.moveTo(m.px, m.py);
            else ctx.lineTo(m.px, m.py);
        });
        if (track.kind === 'circuit') ctx.closePath();
    };
    path();
    ctx.stroke();
    ctx.strokeStyle = style.lineColor;
    ctx.lineWidth = style.band;
    path();
    ctx.stroke();
    track.gates.forEach((gate, i) => {
        const { left, right } = gateEnds(gate);
        const a = toMap(frame, left.x, left.z), b = toMap(frame, right.x, right.z);
        const finish = gate.visual !== 'arch';
        if (finish) {
            // Chequered: alternating squares along the bar
            const n = 6;
            for (let k = 0; k < n; k++) {
                ctx.strokeStyle = k % 2 === 0 ? '#ffffff' : '#111111';
                ctx.lineWidth = style.band + 2;
                ctx.lineCap = 'butt';
                ctx.beginPath();
                ctx.moveTo(a.px + (b.px - a.px) * k / n, a.py + (b.py - a.py) * k / n);
                ctx.lineTo(a.px + (b.px - a.px) * (k + 1) / n, a.py + (b.py - a.py) * (k + 1) / n);
                ctx.stroke();
            }
            ctx.lineCap = 'round';
            return;
        }
        ctx.strokeStyle = i === style.nextGate ? '#fff3c4' : style.gateColor;
        ctx.lineWidth = i === style.nextGate ? 3 : 1.6;
        ctx.beginPath();
        ctx.moveTo(a.px, a.py);
        ctx.lineTo(b.px, b.py);
        ctx.stroke();
    });
    ctx.restore();
}

/** The lobby's track preview on a canvas (nothing without a 2D context). */
export function drawTrackPreview(canvas: HTMLCanvasElement, track: TrackDef): void {
    const ctx = canvas.getContext?.('2d');
    if (!ctx) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const width = canvas.clientWidth || canvas.width, height = canvas.clientHeight || canvas.height;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const frame = fitFrame(track.minimap, width, height, 10);
    drawTrack(ctx, frame, track, { band: 3, lineColor: '#f5a623', gateColor: 'rgba(255, 248, 231, 0.8)' });
}
