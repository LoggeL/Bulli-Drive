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
