import * as THREE from 'three';
import { state } from '../state.js';

export function updatePlayerListUI() {
    const list = document.getElementById('players-ul');
    if (!list) return;
    list.innerHTML = '';

    // Add me
    if (state.bulli) {
        addPlayerToList(list, state.myName, state.myColor!, true);
    }

    // Add others
    for (const id in state.remotePlayers) {
        const p = state.remotePlayers[id];
        addPlayerToList(list, p.name, p.colorCode, false);
    }
}

function addPlayerToList(list: HTMLElement, name: string, color: number, isMe: boolean) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'player-dot';
    dot.style.backgroundColor = '#' + new THREE.Color(color).getHexString();

    li.appendChild(dot);
    li.appendChild(document.createTextNode(name + (isMe ? ' (You)' : '')));
    list.appendChild(li);
}
