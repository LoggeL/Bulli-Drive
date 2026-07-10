import { state } from '../state.js';
import { CityData } from '../types.js';
import { CITY_LAYOUT } from '../../shared/constants.js';

const MAP_SIZE = 180;
const MAP_PADDING = 10;
const UPDATE_INTERVAL_MS = 100;

let canvas: HTMLCanvasElement | null = null;
let context: CanvasRenderingContext2D | null = null;
let staticLayer: HTMLCanvasElement | null = null;
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

function worldToMarker(x: number, z: number): MarkerPoint {
    const raw = worldToMap(x, z);
    const edgeInset = 4;
    const min = edgeInset;
    const max = MAP_SIZE - edgeInset;
    return {
        x: Math.max(min, Math.min(max, raw.x)),
        y: Math.max(min, Math.min(max, raw.y)),
        offMap: raw.x < min || raw.x > max || raw.y < min || raw.y > max,
        direction: Math.atan2(raw.y - MAP_SIZE / 2, raw.x - MAP_SIZE / 2)
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

    const gradient = ctx.createLinearGradient(0, 0, 0, MAP_SIZE);
    gradient.addColorStop(0, '#315c4b');
    gradient.addColorStop(1, '#1e3e36');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, MAP_SIZE, MAP_SIZE);

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

    ctx.strokeStyle = 'rgba(255, 248, 231, 0.26)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, MAP_SIZE - 1, MAP_SIZE - 1);
}

function colorToCss(color: number): string {
    return `#${Math.max(0, Math.min(0xffffff, color)).toString(16).padStart(6, '0')}`;
}

export function initMinimap(city: CityData) {
    canvas = document.getElementById('minimap-canvas') as HTMLCanvasElement | null;
    if (!canvas) return;

    pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(MAP_SIZE * pixelRatio);
    canvas.height = Math.round(MAP_SIZE * pixelRatio);
    context = canvas.getContext('2d');
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
    ctx.drawImage(staticLayer, 0, 0);
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    for (const coin of state.serverCoins ?? []) {
        if (coin.collected) continue;
        drawMarker(ctx, worldToMarker(coin.x, coin.z), 1.15, '#f5c842');
    }

    for (const powerup of state.worldPowerups) {
        if (powerup.collected) continue;
        drawMarker(
            ctx,
            worldToMarker(powerup.x, powerup.z),
            1.7,
            colorToCss(powerup.color),
            'rgba(255,255,255,0.72)'
        );
    }

    for (const id in state.remotePlayers) {
        const remote = state.remotePlayers[id];
        drawMarker(
            ctx,
            worldToMarker(remote.group.position.x, remote.group.position.z),
            2.4,
            colorToCss(remote.colorCode),
            '#fff8e7'
        );
    }

    if (state.bulli) {
        const p = worldToMarker(state.bulli.group.position.x, state.bulli.group.position.z);
        if (p.offMap) {
            drawMarker(ctx, p, 3.4, '#ffffff', '#e84545');
        } else {
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(state.bulli.angle || 0);
            ctx.fillStyle = '#ffffff';
            ctx.strokeStyle = '#e84545';
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.moveTo(0, -5.2);
            ctx.lineTo(3.8, 4.1);
            ctx.lineTo(0, 2.5);
            ctx.lineTo(-3.8, 4.1);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.restore();
        }
    }

    ctx.globalAlpha = 1;
}
