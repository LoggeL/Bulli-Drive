import { state } from '../state.js';
import type { MapData } from '../../shared/map/mapData.js';
import { SURFACE, ZONE } from '../../shared/map/types.js';
import { boxCorners, placementBox } from '../../shared/map/structures.js';
import type { RoadSurfaceName } from '../../shared/map/roadSchema.js';
import type { TrackDef } from '../../shared/race/types.js';
import { drawTrack, fitFrame, mapHeading, toMap, type MapFrame } from '../race/trackMap.js';
import { radarNorth, radarOffset, radarRotation } from './radar.js';

// The driving radar (docs/phase-3-design.md E2, M5): heading up, the map of
// the whole curated map turning beneath the car. The map is drawn once into
// a layer of one pixel per heightfield grid point (2 m): the ground from
// the baked surfaces with hill shading, the sea by its depth, the lots, the
// roads by surface and the buildings' footprints. In a race it shows the
// whole track instead, north up (below).

const MAP_SIZE = 180;
const RADAR_CENTER = MAP_SIZE / 2;
// Metres from the car to the rim of the radar
const RADAR_RANGE = 230;
const RADAR_EDGE_INSET = 10;
const UPDATE_INTERVAL_MS = 50;

let canvas: HTMLCanvasElement | null = null;
let context: CanvasRenderingContext2D | null = null;
let staticLayer: HTMLCanvasElement | null = null;
let backdropLayer: HTMLCanvasElement | null = null;
let overlayLayer: HTMLCanvasElement | null = null;
let overlayForegroundLayer: HTMLCanvasElement | null = null;
const colorCssCache = new Map<number, string>();

let pixelRatio = 1;
let lastUpdate = -Infinity;

// The map layer: its origin in the world and metres per layer pixel
const layerFrame = { originX: -1000, originZ: -1000, metresPerPixel: 2 };
const radarPixelsPerMetre = (RADAR_CENTER - RADAR_EDGE_INSET) / RADAR_RANGE;

interface MarkerPoint {
    x: number;
    y: number;
    offMap: boolean;
    direction: number;
}

function worldToRadarMarker(x: number, z: number, originX: number, originZ: number, heading: number): MarkerPoint {
    const offset = radarOffset((x - originX) * radarPixelsPerMetre, (z - originZ) * radarPixelsPerMetre, heading);
    const distance = Math.hypot(offset.x, offset.y);
    const limit = RADAR_CENTER - RADAR_EDGE_INSET;
    const clamp = distance > limit ? limit / distance : 1;
    return {
        x: RADAR_CENTER + offset.x * clamp,
        y: RADAR_CENTER + offset.y * clamp,
        offMap: distance > limit,
        direction: Math.atan2(offset.y, offset.x)
    };
}

function drawMarker(
    ctx: CanvasRenderingContext2D,
    point: MarkerPoint,
    radius: number,
    fill: string,
    stroke?: string
) {
    ctx.save();
    ctx.translate(point.x, point.y);
    ctx.globalAlpha = point.offMap ? 0.68 : 0.88;
    ctx.fillStyle = fill;
    ctx.beginPath();
    if (point.offMap) {
        ctx.rotate(point.direction);
        ctx.moveTo(radius + 2, 0);
        ctx.lineTo(-radius, -radius);
        ctx.lineTo(-radius, radius);
        ctx.closePath();
    } else {
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
    }
    ctx.fill();
    if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 0.7;
        ctx.stroke();
    }
    ctx.restore();
}

function drawRoundedRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number
) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
}

// ---- The map layer ----

type RGB = [number, number, number];
const GROUND: Record<number, RGB> = {
    [SURFACE.sand]: [217, 200, 158],
    [SURFACE.wetSand]: [189, 169, 131],
    [SURFACE.rock]: [154, 145, 134],
    [SURFACE.dirt]: [150, 128, 96],
    [SURFACE.gravel]: [160, 152, 138]
};
const DRY_GRASS: RGB = [150, 142, 94];
const LAWN: RGB = [122, 146, 88];
const ROAD_COLOR: Record<RoadSurfaceName, string> = {
    asphalt: '#3a3d3e', concrete: '#8f8d86', dirt: '#8a6c4b', gravel: '#9d9585', sand: '#d8c290', wood: '#8a6a48'
};

/** Draws the map into a layer canvas of one pixel per grid point. */
function drawMapLayer(map: MapData): HTMLCanvasElement | null {
    const hf = map.hf;
    const { cols, rows, cellSize, originX, originZ, heightOffset, heightScale, zoneCell } = hf.spec;
    layerFrame.originX = originX;
    layerFrame.originZ = originZ;
    layerFrame.metresPerPixel = cellSize;
    const layer = document.createElement('canvas');
    layer.width = cols;
    layer.height = rows;
    const ctx = layer.getContext('2d');
    if (!ctx) return null;
    const image = ctx.createImageData(cols, rows);
    const data = image.data;
    const zoneCols = Math.floor((cols - 1) * cellSize / zoneCell);
    const perZone = zoneCell / cellSize;
    const h = (i: number, j: number) => heightOffset + hf.q[Math.min(rows - 1, Math.max(0, j)) * cols + Math.min(cols - 1, Math.max(0, i))] * heightScale;
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
            const k = j * cols + i;
            const y = h(i, j);
            let c: RGB;
            if (y < hf.spec.waterLevel - 0.3) {
                const t = Math.min(1, -y / 10);
                c = [61 - 33 * t, 134 - 60 * t, 163 - 57 * t];
            } else {
                const surface = hf.surface[k];
                const zone = hf.zones[Math.min(zoneCols - 1, Math.floor(j / perZone)) * zoneCols + Math.min(zoneCols - 1, Math.floor(i / perZone))];
                c = GROUND[surface] ?? (zone === ZONE.residential || zone === ZONE.park ? LAWN : DRY_GRASS);
                // Hill shading, light from the north west
                const gx = (h(i + 1, j) - h(i - 1, j)) / (2 * cellSize), gz = (h(i, j + 1) - h(i, j - 1)) / (2 * cellSize);
                const shade = Math.max(0.55, Math.min(1.25, 0.95 + (gx + gz) * 0.9));
                c = [c[0] * shade, c[1] * shade, c[2] * shade];
            }
            data[k * 4] = c[0];
            data[k * 4 + 1] = c[1];
            data[k * 4 + 2] = c[2];
            data[k * 4 + 3] = 255;
        }
    }
    ctx.putImageData(image, 0, 0);
    const toLayer = (x: number, z: number): [number, number] => [(x - originX) / cellSize + 0.5, (z - originZ) / cellSize + 0.5];
    // Lots
    for (const area of map.net.areas) {
        ctx.fillStyle = area.markings === 'plazaPavers' ? '#b98263' : ROAD_COLOR[area.surface];
        ctx.beginPath();
        area.polygon.forEach(([x, z], n) => {
            const [px, py] = toLayer(x, z);
            if (n === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        });
        ctx.closePath();
        ctx.fill();
    }
    // Roads: a dark casing, then the surface
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const pass of [0, 1]) {
        for (const edge of map.net.edges) {
            const width = edge.profile.width / cellSize;
            ctx.strokeStyle = pass === 0 ? 'rgba(20, 22, 20, 0.45)' : ROAD_COLOR[edge.profile.surface];
            ctx.lineWidth = pass === 0 ? width + 1.4 : width;
            ctx.beginPath();
            edge.samples.forEach((sample, n) => {
                if (n % 3 !== 0 && n !== edge.samples.length - 1) return;
                const [px, py] = toLayer(sample.x, sample.z);
                if (n === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            });
            ctx.stroke();
        }
    }
    // Buildings and landmarks
    ctx.fillStyle = '#dcc7a6';
    ctx.strokeStyle = 'rgba(70, 52, 40, 0.85)';
    ctx.lineWidth = 0.6;
    for (const placed of [...map.buildings, ...map.structures]) {
        ctx.beginPath();
        boxCorners(placementBox(placed)).forEach(([x, z], n) => {
            const [px, py] = toLayer(x, z);
            if (n === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        });
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
    }
    return layer;
}

function colorToCss(color: number): string {
    const normalized = Math.max(0, Math.min(0xffffff, color));
    let css = colorCssCache.get(normalized);
    if (!css) {
        css = `#${normalized.toString(16).padStart(6, '0')}`;
        colorCssCache.set(normalized, css);
    }
    return css;
}

function drawRotatingMap(
    ctx: CanvasRenderingContext2D,
    originX: number,
    originZ: number,
    heading: number
) {
    if (!staticLayer) return;
    ctx.save();
    ctx.beginPath();
    ctx.arc(RADAR_CENTER, RADAR_CENTER, RADAR_CENTER - 1.5, 0, Math.PI * 2);
    ctx.clip();
    if (backdropLayer) {
        ctx.drawImage(backdropLayer, 0, 0, backdropLayer.width, backdropLayer.height, 0, 0, MAP_SIZE, MAP_SIZE);
    }
    const { originX: lx0, originZ: lz0, metresPerPixel } = layerFrame;
    ctx.translate(RADAR_CENTER, RADAR_CENTER);
    ctx.rotate(radarRotation(heading));
    ctx.scale(radarPixelsPerMetre * metresPerPixel, radarPixelsPerMetre * metresPerPixel);
    ctx.translate(-((originX - lx0) / metresPerPixel + 0.5), -((originZ - lz0) / metresPerPixel + 0.5));
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(staticLayer, 0, 0);
    ctx.restore();
}

function drawLocalBus(ctx: CanvasRenderingContext2D, color: number) {
    ctx.save();
    ctx.translate(RADAR_CENTER, RADAR_CENTER);

    ctx.fillStyle = 'rgba(232, 69, 69, 0.2)';
    ctx.beginPath();
    ctx.arc(0, 0, 11, 0, Math.PI * 2);
    ctx.fill();

    drawRoundedRect(ctx, -4.8, -7.6, 9.6, 15.2, 2.4);
    ctx.fillStyle = colorToCss(color);
    ctx.fill();
    ctx.strokeStyle = '#fff8e7';
    ctx.lineWidth = 1.25;
    ctx.stroke();

    ctx.fillStyle = '#9ac7d4';
    drawRoundedRect(ctx, -3.2, -4.9, 6.4, 4.2, 1);
    ctx.fill();

    ctx.fillStyle = '#fff8e7';
    ctx.beginPath();
    ctx.moveTo(0, -10.5);
    ctx.lineTo(3.2, -7.2);
    ctx.lineTo(-3.2, -7.2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

function drawRadarOverlay(ctx: CanvasRenderingContext2D, heading: number) {
    ctx.save();
    if (overlayLayer) {
        ctx.drawImage(
            overlayLayer,
            0,
            0,
            overlayLayer.width,
            overlayLayer.height,
            0,
            0,
            MAP_SIZE,
            MAP_SIZE
        );
    }

    // North moves around the rim while the map remains vehicle-heading-up.
    const north = radarNorth(heading);
    const northX = RADAR_CENTER + north.x * (RADAR_CENTER - 13);
    const northY = RADAR_CENTER + north.y * (RADAR_CENTER - 13);
    ctx.fillStyle = '#e84545';
    ctx.beginPath();
    ctx.arc(northX, northY, 7.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 248, 231, 0.76)';
    ctx.lineWidth = 0.9;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 7px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', northX, northY + 0.4);
    if (overlayForegroundLayer) {
        ctx.drawImage(
            overlayForegroundLayer,
            0,
            0,
            overlayForegroundLayer.width,
            overlayForegroundLayer.height,
            0,
            0,
            MAP_SIZE,
            MAP_SIZE
        );
    }
    ctx.restore();
}

function buildRadarLayers() {
    backdropLayer = document.createElement('canvas');
    backdropLayer.width = Math.round(MAP_SIZE * pixelRatio);
    backdropLayer.height = Math.round(MAP_SIZE * pixelRatio);
    const backdropCtx = backdropLayer.getContext('2d');
    if (backdropCtx) {
        backdropCtx.scale(pixelRatio, pixelRatio);
        const backdrop = backdropCtx.createRadialGradient(
            RADAR_CENTER,
            RADAR_CENTER,
            8,
            RADAR_CENTER,
            RADAR_CENTER,
            RADAR_CENTER
        );
        backdrop.addColorStop(0, '#315c4b');
        backdrop.addColorStop(1, '#17342f');
        backdropCtx.fillStyle = backdrop;
        backdropCtx.fillRect(0, 0, MAP_SIZE, MAP_SIZE);
    }

    overlayLayer = document.createElement('canvas');
    overlayLayer.width = Math.round(MAP_SIZE * pixelRatio);
    overlayLayer.height = Math.round(MAP_SIZE * pixelRatio);
    const overlayCtx = overlayLayer.getContext('2d');
    if (!overlayCtx) return;
    overlayCtx.scale(pixelRatio, pixelRatio);

    overlayCtx.strokeStyle = 'rgba(255, 248, 231, 0.14)';
    overlayCtx.lineWidth = 0.8;
    for (const radius of [RADAR_CENTER * 0.34, RADAR_CENTER * 0.67]) {
        overlayCtx.beginPath();
        overlayCtx.arc(RADAR_CENTER, RADAR_CENTER, radius, 0, Math.PI * 2);
        overlayCtx.stroke();
    }

    const vignette = overlayCtx.createRadialGradient(
        RADAR_CENTER,
        RADAR_CENTER,
        RADAR_CENTER * 0.45,
        RADAR_CENTER,
        RADAR_CENTER,
        RADAR_CENTER
    );
    vignette.addColorStop(0, 'rgba(4, 15, 16, 0)');
    vignette.addColorStop(1, 'rgba(4, 15, 16, 0.38)');
    overlayCtx.fillStyle = vignette;
    overlayCtx.beginPath();
    overlayCtx.arc(RADAR_CENTER, RADAR_CENTER, RADAR_CENTER - 1.5, 0, Math.PI * 2);
    overlayCtx.fill();

    overlayForegroundLayer = document.createElement('canvas');
    overlayForegroundLayer.width = Math.round(MAP_SIZE * pixelRatio);
    overlayForegroundLayer.height = Math.round(MAP_SIZE * pixelRatio);
    const foregroundCtx = overlayForegroundLayer.getContext('2d');
    if (!foregroundCtx) return;
    foregroundCtx.scale(pixelRatio, pixelRatio);
    foregroundCtx.strokeStyle = 'rgba(255, 248, 231, 0.38)';
    foregroundCtx.lineWidth = 1.2;
    foregroundCtx.beginPath();
    foregroundCtx.arc(RADAR_CENTER, RADAR_CENTER, RADAR_CENTER - 2, 0, Math.PI * 2);
    foregroundCtx.stroke();

    foregroundCtx.fillStyle = '#f3d28e';
    foregroundCtx.beginPath();
    foregroundCtx.moveTo(RADAR_CENTER, 2.5);
    foregroundCtx.lineTo(RADAR_CENTER - 4, 8.5);
    foregroundCtx.lineTo(RADAR_CENTER + 4, 8.5);
    foregroundCtx.closePath();
    foregroundCtx.fill();
}

export function initMinimap(map: MapData) {
    canvas = document.getElementById('minimap-canvas') as HTMLCanvasElement | null;
    if (!canvas) return;

    pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(MAP_SIZE * pixelRatio);
    canvas.height = Math.round(MAP_SIZE * pixelRatio);
    context = canvas.getContext('2d');
    buildRadarLayers();
    staticLayer = drawMapLayer(map);
    lastUpdate = -Infinity;
    updateMinimap(performance.now());
}

// ---- Track mode (docs/phase-2-design.md, 17.3) ----
// In a race the map shows the whole track, north up: the racing line as a
// band, the gates as bars (the next one bright), start and finish
// chequered, every racer as a dot in their colour, the own car as an
// arrow and the time trial ghost as a hollow circle.

// The track fits into the square inside the round panel
const TRACK_PADDING = 30;

interface TrackMode {
    track: TrackDef;
    frame: MapFrame;
    layer: HTMLCanvasElement | null;
    layerGate: number;
}

let trackMode: TrackMode | null = null;
// Set by the race client every frame
export const minimapRace = { nextGate: -1, ghost: null as { x: number; z: number } | null };

/** Track mode on (a race room) or off (null). */
export function setMinimapTrack(track: TrackDef | null): void {
    if (!track) {
        trackMode = null;
        lastUpdate = -Infinity;
        return;
    }
    if (trackMode?.track.id === track.id) return;
    trackMode = { track, frame: fitFrame(track.minimap, MAP_SIZE, MAP_SIZE, TRACK_PADDING), layer: null, layerGate: -2 };
    lastUpdate = -Infinity;
}

// The static part (line and gates) is drawn once per track and next gate
function trackLayer(mode: TrackMode): HTMLCanvasElement | null {
    if (mode.layer && mode.layerGate === minimapRace.nextGate) return mode.layer;
    const layer = mode.layer ?? document.createElement('canvas');
    layer.width = Math.round(MAP_SIZE * pixelRatio);
    layer.height = Math.round(MAP_SIZE * pixelRatio);
    const ctx = layer.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.clearRect(0, 0, MAP_SIZE, MAP_SIZE);
    drawTrack(ctx, mode.frame, mode.track, {
        band: 3, lineColor: 'rgba(245, 166, 35, 0.95)', gateColor: 'rgba(255, 248, 231, 0.55)', nextGate: minimapRace.nextGate
    });
    mode.layer = layer;
    mode.layerGate = minimapRace.nextGate;
    return layer;
}

function drawTrackMinimap(ctx: CanvasRenderingContext2D, mode: TrackMode): void {
    ctx.save();
    ctx.beginPath();
    ctx.arc(RADAR_CENTER, RADAR_CENTER, RADAR_CENTER - 1.5, 0, Math.PI * 2);
    ctx.clip();
    if (backdropLayer) ctx.drawImage(backdropLayer, 0, 0, backdropLayer.width, backdropLayer.height, 0, 0, MAP_SIZE, MAP_SIZE);
    const layer = trackLayer(mode);
    if (layer) ctx.drawImage(layer, 0, 0, layer.width, layer.height, 0, 0, MAP_SIZE, MAP_SIZE);
    const ghost = minimapRace.ghost;
    if (ghost) {
        const g = toMap(mode.frame, ghost.x, ghost.z);
        ctx.strokeStyle = '#bfe3ff';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(g.px, g.py, 4, 0, Math.PI * 2);
        ctx.stroke();
    }
    for (const id in state.remotePlayers) {
        const remote = state.remotePlayers[id];
        if (!remote.bodyGroup.visible) continue;
        const m = toMap(mode.frame, remote.group.position.x, remote.group.position.z);
        ctx.fillStyle = colorToCss(remote.colorCode);
        ctx.strokeStyle = '#fff8e7';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.arc(m.px, m.py, 3.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    }
    const own = state.bulli;
    if (own && own.bodyGroup.visible) {
        const m = toMap(mode.frame, own.group.position.x, own.group.position.z);
        ctx.translate(m.px, m.py);
        ctx.rotate(mapHeading(own.angle ?? 0));
        ctx.fillStyle = colorToCss(own.colorCode);
        ctx.strokeStyle = '#fff8e7';
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(0, -7);
        ctx.lineTo(5, 5);
        ctx.lineTo(0, 2.5);
        ctx.lineTo(-5, 5);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
    }
    ctx.restore();
    // The rim and the north marker at the top (north is always up here)
    drawRadarOverlay(ctx, 0);
}

export function updateMinimap(now: number) {
    if (!canvas || !context || !staticLayer || now - lastUpdate < UPDATE_INTERVAL_MS) return;
    lastUpdate = now;
    if (trackMode) {
        const ctx = context;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        drawTrackMinimap(ctx, trackMode);
        ctx.globalAlpha = 1;
        return;
    }

    const ctx = context;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    const originX = state.bulli?.group.position.x ?? 0;
    const originZ = state.bulli?.group.position.z ?? 0;
    const heading = state.bulli?.angle ?? 0;
    drawRotatingMap(ctx, originX, originZ, heading);

    for (const coin of state.serverCoins ?? []) {
        if (coin.collected) continue;
        const point = worldToRadarMarker(coin.x, coin.z, originX, originZ, heading);
        if (!point.offMap) drawMarker(ctx, point, 1.45, '#f5c842');
    }

    for (const powerup of state.worldPowerups) {
        if (powerup.collected) continue;
        const point = worldToRadarMarker(powerup.x, powerup.z, originX, originZ, heading);
        if (!point.offMap) {
            drawMarker(ctx, point, 2.2, colorToCss(powerup.color), 'rgba(255,255,255,0.72)');
        }
    }

    for (const id in state.remotePlayers) {
        const remote = state.remotePlayers[id];
        drawMarker(
            ctx,
            worldToRadarMarker(
                remote.group.position.x,
                remote.group.position.z,
                originX,
                originZ,
                heading
            ),
            2.8,
            colorToCss(remote.colorCode),
            '#fff8e7'
        );
    }

    if (state.bulli) {
        drawLocalBus(ctx, state.bulli.colorCode);
    }

    drawRadarOverlay(ctx, heading);
    ctx.globalAlpha = 1;
}
