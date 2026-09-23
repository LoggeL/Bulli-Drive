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
- Node.js 22.12+ (required by Vite, Vitest and concurrently)

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

To try the touch controls on a real phone in the same network, run
`npm run dev:lan` instead: Vite then also listens on the LAN and prints the
`Network:` URL to open on the phone. (`npm run dev -- --host` does not work,
the flag ends up at `concurrently`, not at Vite.) The production build is
reachable from the LAN as well: `npm run build && npm start`, then
`http://<LAN-IP>:8000`.

### Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Game server with `tsx watch` plus the Vite dev server (HMR) on port 5173 |
| `npm run dev:lan` | Same as `dev`, but Vite also listens on the LAN, for testing on real phones |
| `npm run build` | Client with Vite to `dist/client` (hashed assets, `build-version.txt`), server with `tsc` to `dist/server` and `dist/shared` |
| `npm start` | Runs the production build on port 8000 (`PORT` to override) |
| `npm run typecheck` | Type-checks client, server, tests, scripts and build config |
| `npm test` | Vitest unit tests in `tests/` (golden tests for world generation, terrain, RNG and the v2 sim scenarios, protocol validation, server handlers, speedometer scale, model cache, budgets of the packed models and textures) |
| `npm run test:e2e` | Builds, then runs the Playwright smoke tests in `tests/e2e` against the production server (port 8799, `E2E_PORT` to override) |
| `npm run perf:baseline` | Builds, then drives two headless Chromium clients for 20 s and prints FPS, draw calls and WebSocket bandwidth as JSON (see [docs/baseline.md](docs/baseline.md)); with the v2 physics it also reports the sim time per frame; `-- --physics=legacy` measures the old physics, `-- --sandbox` the offline sandbox |
| `npm run screenshots` | Builds, then captures a fixed set of views with headless Chromium for visual before/after comparisons (`-- --out=<dir>`, `--gl=swiftshader`, `--physics=legacy`, `--compare=<a>,<b>`; `stats.json` records how much of the frame the car takes; see `scripts/screenshots.ts`) |
| `npx tsx scripts/sim-golden-drift.ts` | Shows how far the v2 golden scenarios drift when `Math.sin` & co. round differently in the last bit, and that the golden tolerance still catches tiny tuning changes |
| `npm run ci` | typecheck, unit tests and build in one go |
| `npm run assets:models` | Builds the car models in Blender and packs them (meshopt + KTX2) into `public/models` (needs Blender 5.2 and `npm --prefix tools ci` once; see [tools/models/README.md](tools/models/README.md)) |
| `npm run assets:textures` | Downloads the CC0 textures and HDRIs (Poly Haven) and encodes them to KTX2 in `public/textures` ([tools/textures/README.md](tools/textures/README.md)) |

The Playwright tests cover the v2 physics as the default (driving on desktop
and phone, two players bumping into each other, the sandbox with its dummy
cars, the tuning panel and the golden sim scenarios in the browser), the old
physics behind `?physics=legacy` (desktop join and drive, two players seeing
each other move, the touch controls on an emulated iPhone 13), which physics
each URL starts, the stale-client reload, a lost WebGL context, the perf
overlay and the car model loading (GLB + KTX2) with its procedural fallback.
They need Chromium once:
`npx playwright install chromium`.

GitHub Actions (`.github/workflows/ci.yml`) runs typecheck and unit tests, the
build, the Playwright tests and a Docker build with a container smoke test on
every pull request and push to `main`.

### URL flags
The game drives with the fixed-step v2 physics (single-track model with
drift, boost and car contact, see
[docs/phase-1a-design.md](docs/phase-1a-design.md)) without any flag.

- `?physics=legacy` switches back to the old driving physics, camera, HUD
  and controls. It is a temporary escape hatch and goes away once v2 has run
  for a few days without problems. Multiplayer works with both, also mixed.
  (`?physics=v2` is still accepted and changes nothing.)
- `?sandbox=1` opens the offline test pad of the v2 physics instead of the
  city (always v2, no server connection needed). See below.
- `?tune=1` adds the live tuning panel with telemetry to the v2 physics
  (not with `?physics=legacy`). It is loaded on demand.
- `?debug=perf` shows a performance overlay (FPS, frame time, draw calls,
  triangles, geometries, textures, WebSocket bytes per second, and with the
  v2 physics the sim time per frame). Use it to measure on real devices.
- `?e2e=1` installs a state hook for the Playwright tests (read-only, apart
  from placing the car on a free stretch of road).

Apart from these, the flags change nothing about the game.

### Sandbox and tuning (v2 physics)
Open `http://localhost:5173/?sandbox=1&tune=1` with `npm run dev` (or
`http://localhost:8000/?sandbox=1&tune=1` after `npm run build && npm start`;
`npx vite` alone is enough, the sandbox never connects to the server). The
pad is 400 × 400 m and has three kickers (10°, 15°, 20°), a jump with a
landing hill, a long wall to slide along, a post row, a cone slalom, two
painted curves (R 40 and R 80 m), a 90° city corner with 12 m roads and five
dummy cars, one of each body: three parked next to the start, two lapping
the curves. They are full sim cars, so ramming them pushes them away.

| Key | Sandbox |
|---|---|
| W/S, A/D (or arrows) | Throttle, brake/reverse, steer |
| Space / Shift / Q | Handbrake (drift) / boost / jump |
| R (hold) | Reset the car where it is |
| N | Put the dummies and cones back |
| C | Switch the car body |

The same buttons are in the SANDBOX box at the top left (for touch). With
`?tune=1` the panel on the right shows speed, slip (drift) angle, yaw rate,
wheel angle, boost and ground contact, plots speed and drift angle of the
last 5 s and has every tuning value of the spec: global values, the values
of one car class (`·K`, pick the class in "Werte der Klasse") and of the
assist profile (`·P`). "Export → Zwischenablage" copies the changed values
as JSON, "Import ← Zwischenablage" loads such a JSON back and "Reset auf
Defaults" undoes everything. In the sandbox the panel also toggles the
powerup effects (Turbo, Mega, Super-Jump, Ghost, Shield) and switches the
body. Changes live in the page only; to keep them, paste the exported JSON
into the defaults (`SIM_TUNING` in `src/shared/sim/constants.ts`, the classes
in `src/shared/sim/vehicleClasses.ts`).

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
  debug/              Perf overlay (?debug=perf), v2 tuning panel (?tune=1)
  vehicle/, input/,   v2 physics on the client: car model, local sim car,
  camera/, game/      input manager, chase camera, fixed-step loop, hooks
  sandbox/            Offline test pad of the v2 physics (?sandbox=1)
  assets/             Model cache: GLB (meshopt) + KTX2 loading, preload and
                      shader warmup during the splash screen, procedural fallback
src/server/           Express + ws game server: world state, message handlers, broadcasting
src/shared/           Code for both sides: protocol schemas (valibot), constants,
                      seeded RNG, city/world generation, terrain height, the v2
                      driving sim (sim/) and its collision world and sandbox
                      layout (world/)
tests/                Vitest (shared/, server/, client/) and Playwright (e2e/)
scripts/              perf-baseline.ts, screenshots.ts
public/models/        Packed car GLBs (3 LODs each) + manifest.json
public/textures/      KTX2 world textures, HDRIs + manifest.json
tools/                Offline asset pipeline (own package.json): Blender car builds,
                      gltfpack/KTX2 packing, texture download and encoding
docs/                 Refactor plan, performance baseline, phase 1a spec, blind test
                      guide, asset provenance and licences (assets.md)
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
- **WASD or arrows:** Drive, brake/reverse and steer
- **SPACE:** Handbrake / drift (drifting fills the boost meter)
- **SHIFT:** Boost
- **Q:** Jump / flip
- **R (hold):** Reset the car onto the nearest road
- **E:** Shoot projectile
- **F:** Honk

On touch screens auto-gas drives once you touch the stick, which steers and
brakes when pulled back; hold **DRIFT** for the handbrake and **BOOST** to
boost, **AUTO** switches auto-gas on and off, and the jump button jumps on a
tap and resets when held. Gamepads (standard mapping) work too: RT/LT gas and
brake, A drift, B boost, Y jump, Back reset, X shoot, LB honk.

With `?physics=legacy`: WASD drive, **SPACE** jumps / flips and recovers
when stuck, E shoots, F honks.

The camera automatically swings into a chase view behind the car.
