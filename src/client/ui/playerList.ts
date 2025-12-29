import * as THREE from 'three';
import { state } from '../state.js';

export function updateScoreboardUI() {
    const list = document.getElementById('scoreboard-list');
    if (!list) return;
    list.innerHTML = '';

    // Use scoreboard from server, sorted by score desc
    const entries = [...state.scoreboard].sort((a, b) => b.score - a.score).slice(0, 10);
    
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
        dot.style.backgroundColor = '#' + new THREE.Color(entry.color).getHexString();
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
        dot.style.backgroundColor = '#' + new THREE.Color(state.myColor!).getHexString();
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
