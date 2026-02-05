import { state } from '../state.js';

export function updateScoreUI() {
    const display = document.getElementById('score-display');
    if (display) display.innerText = state.score.toString();
}

export function showInteractionPrompt(text: string) {
    const prompt = document.getElementById('interaction-prompt');
    if (prompt) {
        prompt.innerText = text;
        prompt.classList.remove('hidden');
        setTimeout(() => prompt.classList.add('hidden'), 3000);
    }
}

export function updatePowerupsUI() {
    const panel = document.getElementById('powerup-panel');
    if (!panel || !state.bulli) return;

    // Iterate through supported powerup types
    const activeKeys = Object.keys(state.bulli.powerups).filter(k => state.bulli.powerups[k as keyof typeof state.bulli.powerups].active);

    // Remove indicators for inactive powerups
    const existing = Array.from(panel.children) as HTMLElement[];
    existing.forEach(el => {
        const type = el.dataset.type;
        if (type && !state.bulli.powerups[type as keyof typeof state.bulli.powerups].active) {
            el.remove();
        }
    });

    // Add or update active powerups
    activeKeys.forEach(type => {
        const key = type as keyof typeof state.bulli.powerups;
        const p = state.bulli.powerups[key];
        let el = panel.querySelector(`.powerup-indicator[data-type="${type}"]`) as HTMLElement;

        if (!el) {
            el = document.createElement('div');
            el.className = 'powerup-indicator';
            el.dataset.type = type;

            const icon = document.createElement('span');
            icon.className = 'powerup-icon';
            icon.innerText = getPowerupIcon(type);

            const barBg = document.createElement('div');
            barBg.className = 'powerup-bar-bg';

            const barFill = document.createElement('div');
            barFill.className = 'powerup-bar-fill';
            barFill.style.backgroundColor = '#' + getPowerupColor(type).toString(16).padStart(6, '0');

            barBg.appendChild(barFill);
            el.appendChild(icon);
            el.appendChild(barBg);
            panel.appendChild(el);
        }

        // Update bar width/transform
        const fill = el.querySelector('.powerup-bar-fill') as HTMLElement;
        const maxTime = type === 'shield' || type === 'ghost' ? 8.0 : 5.0;
        const pct = Math.max(0, p.timer / maxTime);
        fill.style.transform = `scaleX(${pct})`;
    });
}

// Speedometer
let speedoCanvas: HTMLCanvasElement | null = null;
let speedoCtx: CanvasRenderingContext2D | null = null;
let speedoValue: HTMLElement | null = null;
let speedoTurbo: HTMLElement | null = null;

function initSpeedoRefs() {
    speedoCanvas = document.getElementById('speedo-canvas') as HTMLCanvasElement;
    speedoCtx = speedoCanvas?.getContext('2d') || null;
    speedoValue = document.getElementById('speedo-value');
    speedoTurbo = document.getElementById('speedo-turbo');
}

export function updateSpeedometer() {
    if (!state.bulli) return;
    if (!speedoCanvas) initSpeedoRefs();
    if (!speedoCtx || !speedoCanvas || !speedoValue || !speedoTurbo) return;

    const rawSpeed = Math.abs(state.bulli.speed);
    const kmh = Math.round(rawSpeed * 120);
    const maxKmh = 180;
    const pct = Math.min(kmh / maxKmh, 1);
    const turboActive = state.bulli.powerups.speed.active;

    speedoValue.innerText = kmh.toString();

    if (turboActive) {
        speedoTurbo.classList.remove('hidden');
    } else {
        speedoTurbo.classList.add('hidden');
    }

    // Draw gauge arc
    const w = speedoCanvas.width;
    const h = speedoCanvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const r = w / 2 - 10;
    const startAngle = 0.75 * Math.PI;
    const endAngle = 2.25 * Math.PI;
    const sweepAngle = startAngle + pct * (endAngle - startAngle);

    speedoCtx.clearRect(0, 0, w, h);

    // Background arc
    speedoCtx.beginPath();
    speedoCtx.arc(cx, cy, r, startAngle, endAngle);
    speedoCtx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    speedoCtx.lineWidth = 6;
    speedoCtx.lineCap = 'round';
    speedoCtx.stroke();

    // Filled arc
    if (pct > 0.005) {
        speedoCtx.beginPath();
        speedoCtx.arc(cx, cy, r, startAngle, sweepAngle);
        if (turboActive) {
            const grad = speedoCtx.createLinearGradient(0, h, w, 0);
            grad.addColorStop(0, '#FFD54F');
            grad.addColorStop(1, '#E84545');
            speedoCtx.strokeStyle = grad;
        } else {
            const grad = speedoCtx.createLinearGradient(0, h, w, 0);
            grad.addColorStop(0, '#F5A623');
            grad.addColorStop(0.7, '#E84545');
            grad.addColorStop(1, '#D63031');
            speedoCtx.strokeStyle = grad;
        }
        speedoCtx.lineWidth = 6;
        speedoCtx.lineCap = 'round';
        speedoCtx.stroke();
    }

    // Tick marks
    const numTicks = 10;
    for (let i = 0; i <= numTicks; i++) {
        const tickAngle = startAngle + (i / numTicks) * (endAngle - startAngle);
        const innerR = r - 10;
        const outerR = r - 4;
        speedoCtx.beginPath();
        speedoCtx.moveTo(cx + Math.cos(tickAngle) * innerR, cy + Math.sin(tickAngle) * innerR);
        speedoCtx.lineTo(cx + Math.cos(tickAngle) * outerR, cy + Math.sin(tickAngle) * outerR);
        speedoCtx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        speedoCtx.lineWidth = 1.5;
        speedoCtx.stroke();
    }
}

function getPowerupIcon(type: string) {
    switch(type) {
        case 'speed': return '\u26A1';
        case 'size': return '\uD83C\uDF44';
        case 'jump': return '\uD83E\uDD98';
        case 'shield': return '\uD83D\uDEE1\uFE0F';
        case 'magnet': return '\uD83E\uDDF2';
        case 'ghost': return '\uD83D\uDC7B';
        default: return '\u2753';
    }
}

function getPowerupColor(type: string) {
    switch(type) {
        case 'speed': return 0xFFD700;
        case 'size': return 0xFF1493;
        case 'jump': return 0x00FF7F;
        case 'shield': return 0x00BFFF;
        case 'magnet': return 0xFF6600;
        case 'ghost': return 0x9966FF;
        default: return 0xFFFFFF;
    }
}

// Health bar
export function updateHealthBar() {
    const fill = document.getElementById('health-bar-fill');
    const text = document.getElementById('health-bar-text');
    if (!fill || !text) return;

    const hp = Math.max(0, Math.min(100, state.health));
    const pct = hp / 100;

    fill.style.width = (pct * 100) + '%';
    text.innerText = hp.toString();

    // Green to red gradient based on health
    if (pct > 0.5) {
        fill.style.background = `linear-gradient(90deg, #4CAF50, #8BC34A)`;
    } else if (pct > 0.25) {
        fill.style.background = `linear-gradient(90deg, #FF9800, #FFC107)`;
    } else {
        fill.style.background = `linear-gradient(90deg, #f44336, #E84545)`;
    }
}

// Minimap
let minimapCanvas: HTMLCanvasElement | null = null;
let minimapCtx: CanvasRenderingContext2D | null = null;

function initMinimapRefs() {
    minimapCanvas = document.getElementById('minimap-canvas') as HTMLCanvasElement;
    minimapCtx = minimapCanvas?.getContext('2d') || null;
}

// World range mapped to minimap
const MAP_RANGE = 350; // world units from center to edge shown

export function updateMinimap() {
    if (!state.bulli) return;
    if (!minimapCanvas) initMinimapRefs();
    if (!minimapCtx || !minimapCanvas) return;

    const w = minimapCanvas.width;
    const h = minimapCanvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const radius = w / 2;
    const scale = radius / MAP_RANGE;

    const playerX = state.bulli.group.position.x;
    const playerZ = state.bulli.group.position.z;
    const playerAngle = state.bulli.angle;

    minimapCtx.clearRect(0, 0, w, h);

    // Clip to circle
    minimapCtx.save();
    minimapCtx.beginPath();
    minimapCtx.arc(cx, cy, radius - 1, 0, Math.PI * 2);
    minimapCtx.clip();

    // Background - dark green terrain
    minimapCtx.fillStyle = 'rgba(34, 85, 34, 0.6)';
    minimapCtx.fillRect(0, 0, w, h);

    // Helper to convert world coords to minimap coords (centered on player)
    function worldToMinimap(wx: number, wz: number): [number, number] {
        const dx = wx - playerX;
        const dz = wz - playerZ;
        return [cx + dx * scale, cy + dz * scale];
    }

    // Draw city roads (gray lines)
    // City is a 4x4 grid of blocks, each blockSize=40 + roadWidth=12
    const blockSize = 40;
    const roadWidth = 12;
    const gridSize = 4;
    const totalBlockSize = blockSize + roadWidth;
    const halfCity = (gridSize * totalBlockSize) / 2;

    minimapCtx.strokeStyle = 'rgba(150, 150, 150, 0.5)';
    minimapCtx.lineWidth = Math.max(1, roadWidth * scale);

    for (let i = 0; i <= gridSize; i++) {
        // Horizontal roads
        const zPos = -halfCity + i * totalBlockSize + roadWidth / 2;
        const [x1, y1] = worldToMinimap(-halfCity, zPos);
        const [x2, y2] = worldToMinimap(halfCity, zPos);
        minimapCtx.beginPath();
        minimapCtx.moveTo(x1, y1);
        minimapCtx.lineTo(x2, y2);
        minimapCtx.stroke();

        // Vertical roads
        const xPos = -halfCity + i * totalBlockSize + roadWidth / 2;
        const [x3, y3] = worldToMinimap(xPos, -halfCity);
        const [x4, y4] = worldToMinimap(xPos, halfCity);
        minimapCtx.beginPath();
        minimapCtx.moveTo(x3, y3);
        minimapCtx.lineTo(x4, y4);
        minimapCtx.stroke();
    }

    // Draw coins (gold dots)
    state.coins.forEach((coin: any) => {
        const [mx, my] = worldToMinimap(coin.position.x, coin.position.z);
        // Only draw if within the minimap circle
        const distFromCenter = Math.sqrt((mx - cx) ** 2 + (my - cy) ** 2);
        if (distFromCenter < radius - 2) {
            minimapCtx!.fillStyle = '#FFD700';
            minimapCtx!.beginPath();
            minimapCtx!.arc(mx, my, 2, 0, Math.PI * 2);
            minimapCtx!.fill();
        }
    });

    // Draw powerups (colored dots)
    state.worldPowerups.forEach(p => {
        if (p.collected) return;
        const [mx, my] = worldToMinimap(p.x, p.z);
        const distFromCenter = Math.sqrt((mx - cx) ** 2 + (my - cy) ** 2);
        if (distFromCenter < radius - 2) {
            const color = '#' + p.color.toString(16).padStart(6, '0');
            minimapCtx!.fillStyle = color;
            minimapCtx!.beginPath();
            minimapCtx!.arc(mx, my, 3, 0, Math.PI * 2);
            minimapCtx!.fill();
        }
    });

    // Draw other players (colored dots)
    for (const id in state.remotePlayers) {
        const remote = state.remotePlayers[id];
        const [mx, my] = worldToMinimap(remote.group.position.x, remote.group.position.z);
        const distFromCenter = Math.sqrt((mx - cx) ** 2 + (my - cy) ** 2);
        if (distFromCenter < radius - 2) {
            const color = '#' + (remote.colorCode || 0x4488FF).toString(16).padStart(6, '0');
            minimapCtx!.fillStyle = color;
            minimapCtx!.beginPath();
            minimapCtx!.arc(mx, my, 3.5, 0, Math.PI * 2);
            minimapCtx!.fill();
        }
    }

    // Draw player (red arrow pointing in direction of travel)
    minimapCtx.save();
    minimapCtx.translate(cx, cy);
    minimapCtx.rotate(playerAngle);
    minimapCtx.fillStyle = '#E84545';
    minimapCtx.beginPath();
    minimapCtx.moveTo(0, -6);    // Tip (forward)
    minimapCtx.lineTo(-4, 4);
    minimapCtx.lineTo(4, 4);
    minimapCtx.closePath();
    minimapCtx.fill();

    // White outline for visibility
    minimapCtx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
    minimapCtx.lineWidth = 1;
    minimapCtx.stroke();
    minimapCtx.restore();

    // Restore clip
    minimapCtx.restore();

    // Draw circle border
    minimapCtx.beginPath();
    minimapCtx.arc(cx, cy, radius - 1, 0, Math.PI * 2);
    minimapCtx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    minimapCtx.lineWidth = 2;
    minimapCtx.stroke();
}
