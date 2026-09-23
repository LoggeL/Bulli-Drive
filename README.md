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

### Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Game server with `tsx watch` plus the Vite dev server (HMR) on port 5173 |
| `npm run build` | Client with Vite to `dist/client` (hashed assets, `build-version.txt`), server with `tsc` to `dist/server` and `dist/shared` |
| `npm start` | Runs the production build on port 8000 (`PORT` to override) |
| `npm run typecheck` | Type-checks client, server, tests, scripts and build config |
| `npm test` | Vitest unit tests in `tests/` (golden tests for world generation, terrain and RNG, protocol validation, server handlers, speedometer scale) |
| `npm run test:e2e` | Builds, then runs the Playwright smoke tests in `tests/e2e` against the production server (port 8799, `E2E_PORT` to override) |
| `npm run perf:baseline` | Builds, then drives two headless Chromium clients for 20 s and prints FPS, draw calls and WebSocket bandwidth as JSON (see [docs/baseline.md](docs/baseline.md)) |
| `npm run ci` | typecheck, unit tests and build in one go |

The Playwright tests cover desktop join and drive, two players seeing each other
move, the touch controls on an emulated iPhone 13, the stale-client reload, a
lost WebGL context and the perf overlay. They need Chromium once:
`npx playwright install chromium`.

GitHub Actions (`.github/workflows/ci.yml`) runs typecheck and unit tests, the
build, the Playwright tests and a Docker build with a container smoke test on
every pull request and push to `main`.

### URL flags
- `?debug=perf` shows a performance overlay (FPS, frame time, draw calls,
  triangles, geometries, textures, WebSocket bytes per second). Use it to
  measure on real devices.
- `?e2e=1` installs a read-only state hook for the Playwright tests.

Without these flags the game behaves exactly the same.

## Architecture

```
index.html            Vite entry (HUD markup, loading and splash screens)
src/client/           Browser game (three.js)
  main.ts             Bootstrap, render loop, chase camera
  entities/Bulli.ts   Cars: models, local driving physics, nametags
  world/              City, terrain, coins, powerups, projectiles
  network/            WebSocket client and message dispatch
  controls/           Keyboard and touch (joystick, action buttons)
  ui/                 HUD, speedometer, minimap, screens, WebGL context-loss notice
  effects/            Particles, sounds, adaptive render quality
  debug/              Perf overlay (?debug=perf)
src/server/           Express + ws game server: world state, message handlers, broadcasting
src/shared/           Code for both sides: protocol schemas (valibot), constants,
                      seeded RNG, city/world generation, terrain height
tests/                Vitest (shared/, server/, client/) and Playwright (e2e/)
scripts/              perf-baseline.ts
docs/                 Refactor plan, performance baseline
```

The server generates the world from a fixed seed and sends it to every client
on join; clients drive locally and send position updates at up to 20 Hz, which
the server validates and broadcasts. One world unit is one metre.

Code in `src/shared` runs in the browser and on the server, so it must not
import three, the DOM or Node modules (a test enforces this).

### Roadmap
Bulli Drive is being rebuilt into an open-world multiplayer racing game
(party mode with the current combat, car contact, a curated map, full mobile
support, 24/7 hosting). The plan, decisions and phases are in
[docs/refactor-plan.md](docs/refactor-plan.md); the performance baseline the
rebuild is measured against is in [docs/baseline.md](docs/baseline.md).

## Controls
- **WASD:** Drive and steer
- **SPACE:** Jump / flip; recover when stuck
- **E:** Shoot projectile
- **F:** Honk

The camera automatically swings into a chase view behind the car.
