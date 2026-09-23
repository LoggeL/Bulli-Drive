# Bulli Drive

A multiplayer 3D driving game featuring a chibi-style VW Bulli. Cruise a sun-soaked
city, collect coins and powerups, and shoot it out with other drivers.

![Screenshot](docs/screenshot.png)

## Features
- **Multiplayer:** Real-time sync of position, rotation, flipping, honks and shots.
- **Combat:** Shoot projectiles at other players, score kills, climb the scoreboard.
- **Powerups & coins:** Turbo, Mega, Super Jump, Shield, Magnet and Ghost powerups plus collectible coins, shared across all players.
- **3D Graphics:** Built with Three.js.
- **Sunset city:** A deterministic, connected road grid with marked crossings, palm-lined streets, a tiled fountain plaza, landscaped park, and a heading-up radar that keeps your Bulli centered.

## Getting Started

### Prerequisites
- Node.js 20.19+ or 22.12+ (required by Vite)

### Install, build and run
```bash
npm install
npm run build
npm start
```
The game is then available at `http://localhost:8000`.

### Development
```bash
npm run dev
```
Starts the game server (`tsx watch`, port 8000) and the Vite dev server with HMR
at `http://localhost:5173`, which proxies the game WebSocket (`/ws`) to the game server.

`npm run typecheck` checks client, server, tests and build config.
`npm test` runs the Vitest unit tests in `tests/` (golden tests for the shared
world generation, terrain and RNG, protocol validation, server handlers);
`npm run ci` chains typecheck, tests and build.

Code in `src/shared` runs in the browser and on the server, so it must not
import three, the DOM or Node modules (a test enforces this).

## Controls
- **WASD:** Drive and steer
- **SPACE:** Jump / flip; recover when stuck
- **E:** Shoot projectile
- **F:** Honk

The camera automatically swings into a chase view behind the car.
