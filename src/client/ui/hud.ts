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
            barFill.style.backgroundColor = '#' + getPowerupColor(type).toString(16);
            
            barBg.appendChild(barFill);
            el.appendChild(icon);
            el.appendChild(barBg);
            panel.appendChild(el);
        }
        
        // Update bar width/transform
        const fill = el.querySelector('.powerup-bar-fill') as HTMLElement;
        const maxTime = 5.0; // All powerups currently 5s
        const pct = Math.max(0, p.timer / maxTime);
        fill.style.transform = `scaleX(${pct})`;
    });
}

function getPowerupIcon(type: string) {
    switch(type) {
        case 'speed': return '⚡';
        case 'size': return '🍄';
        case 'jump': return '🦘';
        default: return '❓';
    }
}

function getPowerupColor(type: string) {
    switch(type) {
        case 'speed': return 0xFFD700;
        case 'size': return 0xFF1493;
        case 'jump': return 0x00FF7F;
        default: return 0xFFFFFF;
    }
}
