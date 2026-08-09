import * as THREE from 'three';
import { state } from '../state.js';

let scoreboardToggleInitialized = false;

function setScoreboardExpanded(expanded: boolean) {
    const toggle = document.getElementById('scoreboard-toggle');
    const panel = document.getElementById('scoreboard-panel');
    const rank = document.getElementById('player-rank')?.textContent || '#1';
    if (!toggle || !panel) return;

    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-label', `${expanded ? 'Close' : 'Open'} scoreboard. Current rank ${rank.replace('#', '')}`);
    panel.hidden = !expanded;
}

function initScoreboardToggle() {
    if (scoreboardToggleInitialized) return;
    const shell = document.getElementById('player-list');
    const toggle = document.getElementById('scoreboard-toggle');
    if (!shell || !toggle) return;

    scoreboardToggleInitialized = true;
    toggle.addEventListener('click', () => {
        setScoreboardExpanded(toggle.getAttribute('aria-expanded') !== 'true');
    });
    document.addEventListener('pointerdown', (event) => {
        if (toggle.getAttribute('aria-expanded') === 'true' && !shell.contains(event.target as Node)) {
            setScoreboardExpanded(false);
        }
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
            setScoreboardExpanded(false);
            toggle.focus();
        }
    });
}

export function updateScoreboardUI() {
    const list = document.getElementById('scoreboard-list');
    if (!list) return;
    initScoreboardToggle();
    list.innerHTML = '';

    // Use scoreboard from server, sorted by score desc
    const sortedEntries = [...state.scoreboard].sort((a, b) => b.score - a.score);
    const entries = sortedEntries.slice(0, 10);
    const localRankIndex = sortedEntries.findIndex(entry => entry.id === state.myId);
    const localRank = localRankIndex >= 0 ? localRankIndex + 1 : 1;
    const rankDisplay = document.getElementById('player-rank');
    const scoreboardToggle = document.getElementById('scoreboard-toggle');
    if (rankDisplay) rankDisplay.textContent = `#${localRank}`;
    if (scoreboardToggle) {
        const expanded = scoreboardToggle.getAttribute('aria-expanded') === 'true';
        scoreboardToggle.setAttribute('aria-label', `${expanded ? 'Close' : 'Open'} scoreboard. Current rank ${localRank}`);
    }
    
    entries.forEach((entry, index) => {
        const isMe = entry.id === state.myId;
        const row = document.createElement('li');
        row.className = 'scoreboard-row' + (isMe ? ' me' : '');
        
        // Rank
        const rank = document.createElement('span');
        rank.className = 'rank';
        rank.textContent = `${index + 1}`;
        row.appendChild(rank);
        
        // Color dot
        const dot = document.createElement('span');
        dot.className = 'player-dot';
        const playerColor = '#' + new THREE.Color(entry.color).getHexString();
        dot.style.backgroundColor = playerColor;
        dot.style.color = playerColor;
        row.appendChild(dot);
        
        // Name
        const name = document.createElement('span');
        name.className = 'player-name';
        name.textContent = entry.name + (isMe ? ' (You)' : '');
        row.appendChild(name);
        
        // Score
        const score = document.createElement('span');
        score.className = 'player-score';
        score.textContent = entry.score.toString();
        row.appendChild(score);
        
        list.appendChild(row);
    });
    
    // If no entries from server yet, show local player
    if (entries.length === 0 && state.bulli) {
        const row = document.createElement('li');
        row.className = 'scoreboard-row me';
        
        const rank = document.createElement('span');
        rank.className = 'rank';
        rank.textContent = '1';
        row.appendChild(rank);
        
        const dot = document.createElement('span');
        dot.className = 'player-dot';
        const playerColor = '#' + new THREE.Color(state.myColor!).getHexString();
        dot.style.backgroundColor = playerColor;
        dot.style.color = playerColor;
        row.appendChild(dot);
        
        const name = document.createElement('span');
        name.className = 'player-name';
        name.textContent = state.myName + ' (You)';
        row.appendChild(name);
        
        const score = document.createElement('span');
        score.className = 'player-score';
        score.textContent = state.score.toString();
        row.appendChild(score);
        
        list.appendChild(row);
    }
}
