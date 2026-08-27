import { state } from '../state.js';
import { CityData } from '../types.js';
import { CITY_LAYOUT } from '../../shared/constants.js';

const MAP_SIZE = 180;
const MAP_PADDING = 10;
const RADAR_CENTER = MAP_SIZE / 2;
const RADAR_ZOOM = 1.65;
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

function cityBounds() {
    const { blockSize, roadWidth, gridSize } = CITY_LAYOUT;
    const totalBlockSize = blockSize + roadWidth;
    const halfCity = (gridSize * totalBlockSize) / 2;
    return {
        minX: -halfCity - 7,
        maxX: halfCity + roadWidth + 7,
        minZ: -halfCity - 7,
        maxZ: halfCity + roadWidth + 7
    };
}

const bounds = cityBounds();
const worldWidth = bounds.maxX - bounds.minX;
const worldHeight = bounds.maxZ - bounds.minZ;
const scale = Math.min(
    (MAP_SIZE - MAP_PADDING * 2) / worldWidth,
    (MAP_SIZE - MAP_PADDING * 2) / worldHeight
);

function worldToMap(x: number, z: number): { x: number; y: number } {
    return {
        x: MAP_PADDING + (x - bounds.minX) * scale,
        y: MAP_SIZE - MAP_PADDING - (z - bounds.minZ) * scale
    };
}

interface MarkerPoint {
    x: number;
    y: number;
    offMap: boolean;
    direction: number;
}

function worldToRadarMarker(
    x: number,
    z: number,
    originX: number,
    originZ: number,
    heading: number
): MarkerPoint {
    const dx = (x - originX) * scale * RADAR_ZOOM;
    const dz = (z - originZ) * scale * RADAR_ZOOM;
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);
    // Vehicle-forward is always screen-up. Its right-hand world axis maps to
    // screen-right, so the map turns beneath the fixed player marker.
    const rotatedX = dx * cos - dz * sin;
    const rotatedY = -dx * sin - dz * cos;
    const distance = Math.hypot(rotatedX, rotatedY);
    const limit = RADAR_CENTER - RADAR_EDGE_INSET;
    const clamp = distance > limit ? limit / distance : 1;
    return {
        x: RADAR_CENTER + rotatedX * clamp,
        y: RADAR_CENTER + rotatedY * clamp,
        offMap: distance > limit,
        direction: Math.atan2(rotatedY, rotatedX)
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

function drawStaticMap(city: CityData) {
    staticLayer = document.createElement('canvas');
    staticLayer.width = Math.round(MAP_SIZE * pixelRatio);
    staticLayer.height = Math.round(MAP_SIZE * pixelRatio);
    const ctx = staticLayer.getContext('2d');
    if (!ctx) return;
    ctx.scale(pixelRatio, pixelRatio);

    // Roads are drawn from the exact authoritative geometry rather than a
    // hardcoded grid, so the radar cannot drift away from the 3D world.
    for (const road of city.roads) {
        const p = worldToMap(road.x, road.z);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(road.rotation);
        ctx.fillStyle = '#252a2b';
        ctx.fillRect(-road.width * scale / 2, -road.length * scale / 2, road.width * scale, road.length * scale);
        ctx.strokeStyle = 'rgba(246, 231, 186, 0.62)';
        ctx.lineWidth = 0.7;
        ctx.setLineDash([2.4, 2.8]);
        ctx.beginPath();
        ctx.moveTo(0, -road.length * scale / 2);
        ctx.lineTo(0, road.length * scale / 2);
        ctx.stroke();
        ctx.restore();
    }

    for (const building of city.buildings) {
        const p = worldToMap(building.x, building.z);
        const width = Math.max(2, building.width * scale);
        const depth = Math.max(2, building.depth * scale);
        ctx.fillStyle = '#d2b795';
        ctx.strokeStyle = 'rgba(76, 57, 47, 0.75)';
        ctx.lineWidth = 0.7;
        drawRoundedRect(ctx, p.x - width / 2, p.y - depth / 2, width, depth, 1.1);
        ctx.fill();
        ctx.stroke();
    }

    const { blockSize, roadWidth, gridSize } = CITY_LAYOUT;
    const totalBlockSize = blockSize + roadWidth;
    const halfCity = (gridSize * totalBlockSize) / 2;
    const blockPoint = (bx: number, bz: number) => worldToMap(
        -halfCity + roadWidth + bx * totalBlockSize + blockSize / 2,
        -halfCity + roadWidth + bz * totalBlockSize + blockSize / 2
    );
    const plazaIndex = Math.floor(gridSize / 2) - 1;
    const plaza = blockPoint(plazaIndex, plazaIndex);
    const park = blockPoint(gridSize - 1, gridSize - 1);

    ctx.fillStyle = '#cc7d5c';
    ctx.fillRect(
        plaza.x - blockSize * scale / 2,
        plaza.y - blockSize * scale / 2,
        blockSize * scale,
        blockSize * scale
    );
    ctx.fillStyle = '#61a55d';
    ctx.fillRect(
        park.x - blockSize * scale / 2,
        park.y - blockSize * scale / 2,
        blockSize * scale,
        blockSize * scale
    );

    ctx.fillStyle = '#f8f1db';
    ctx.font = '700 7px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('PLAZA', plaza.x, plaza.y + 2.5);
    ctx.fillText('PARK', park.x, park.y + 2.5);

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
    const origin = worldToMap(originX, originZ);

    ctx.save();
    ctx.beginPath();
    ctx.arc(RADAR_CENTER, RADAR_CENTER, RADAR_CENTER - 1.5, 0, Math.PI * 2);
    ctx.clip();

    if (backdropLayer) {
        ctx.drawImage(
            backdropLayer,
            0,
            0,
            backdropLayer.width,
            backdropLayer.height,
            0,
            0,
            MAP_SIZE,
            MAP_SIZE
        );
    }

    ctx.translate(RADAR_CENTER, RADAR_CENTER);
    ctx.rotate(-heading);
    ctx.scale(RADAR_ZOOM, RADAR_ZOOM);
    ctx.translate(-origin.x, -origin.y);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
        staticLayer,
        0,
        0,
        staticLayer.width,
        staticLayer.height,
        0,
        0,
        MAP_SIZE,
        MAP_SIZE
    );
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
    const northX = RADAR_CENTER - Math.sin(heading) * (RADAR_CENTER - 13);
    const northY = RADAR_CENTER - Math.cos(heading) * (RADAR_CENTER - 13);
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

export function initMinimap(city: CityData) {
    canvas = document.getElementById('minimap-canvas') as HTMLCanvasElement | null;
    if (!canvas) return;

    pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(MAP_SIZE * pixelRatio);
    canvas.height = Math.round(MAP_SIZE * pixelRatio);
    context = canvas.getContext('2d');
    buildRadarLayers();
    drawStaticMap(city);
    lastUpdate = -Infinity;
    updateMinimap(performance.now());
}

export function updateMinimap(now: number) {
    if (!canvas || !context || !staticLayer || now - lastUpdate < UPDATE_INTERVAL_MS) return;
    lastUpdate = now;

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
