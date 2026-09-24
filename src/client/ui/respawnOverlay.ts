// The "ELIMINATED" overlay with its respawn countdown: shown when the own
// car dies in the Party, hidden when it comes back (network/websocket.ts).

let respawnInterval: number = 0;

export function showRespawnOverlay() {
    let overlay = document.getElementById('respawn-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'respawn-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;flex-direction:column;justify-content:center;align-items:center;z-index:300;pointer-events:none;';

        const title = document.createElement('div');
        title.style.cssText = 'font-family:Righteous,cursive;font-size:2.5rem;color:#E84545;text-shadow:0 0 20px rgba(232,69,69,0.5);';
        title.textContent = 'ELIMINATED';

        const timer = document.createElement('div');
        timer.id = 'respawn-timer';
        timer.style.cssText = 'font-family:Quicksand,sans-serif;font-size:1.2rem;color:rgba(255,255,255,0.7);margin-top:0.5rem;';
        timer.textContent = 'Respawning in 3...';

        overlay.appendChild(title);
        overlay.appendChild(timer);
        document.body.appendChild(overlay);
    }
    overlay.style.display = 'flex';

    // Countdown - clear any prior interval to avoid stacking on rapid re-deaths
    if (respawnInterval) {
        clearInterval(respawnInterval);
        respawnInterval = 0;
    }
    let count = 3;
    const timerEl = document.getElementById('respawn-timer');
    if (timerEl) timerEl.textContent = 'Respawning in 3...';
    respawnInterval = window.setInterval(() => {
        count--;
        if (count <= 0) {
            clearInterval(respawnInterval);
            respawnInterval = 0;
            if (timerEl) timerEl.textContent = 'Respawning...';
        } else if (timerEl) {
            timerEl.textContent = `Respawning in ${count}...`;
        }
    }, 1000);
}

export function hideRespawnOverlay() {
    if (respawnInterval) {
        clearInterval(respawnInterval);
        respawnInterval = 0;
    }
    const overlay = document.getElementById('respawn-overlay');
    if (overlay) overlay.style.display = 'none';
}
