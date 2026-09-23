# Performance-Baseline (Phase 0)

**Stand:** 2026-09-23 · **Commit:** `20d7581` (Spielverhalten wie `1d39c07`, nur mit korrigiertem Tacho) · Rohdaten: [`docs/baseline/`](baseline/)

Diese Zahlen sind der Vergleichspunkt für alle späteren Phasen. Wer etwas am Rendering, an der Welt oder am Netzcode ändert, misst mit denselben Befehlen neu und vergleicht.

> **Wichtig:** Headless-Chromium rendert standardmäßig mit **SwiftShader auf der CPU**. FPS und Frame-Times aus diesen Läufen sind **nicht repräsentativ** für echte Geräte. **Draw Calls, Dreiecke, Speicherzähler und die Bandbreite pro Update sind es** – sie hängen nicht von der GPU ab. Einschränkung: Der Client schickt höchstens ein Positions-Update pro Frame. Die **Upload-Rate** stimmt deshalb nur, wenn die Clients mindestens 20 FPS schaffen; im SwiftShader-Lauf ist sie zu niedrig. Für realistische Raten gibt es `--gl=gpu`.

## Wie gemessen wird

```bash
npm run perf:baseline                                   # Build, 2 Clients, SwiftShader, 5 s Warm-up + 20 s Messung
npm run perf:baseline -- --gl=gpu                       # lokale GPU statt SwiftShader
npm run perf:baseline -- --gl=gpu --device=mobile       # iPhone-13-Viewport (390×844, DPR 3)
npm run perf:baseline -- --clients=4 --duration=60 --out=perf.json
```

Das Skript (`scripts/perf-baseline.ts`) startet den Produktions-Server, lässt die Clients über den echten Beitritt (`/?e2e=1&debug=perf`) ins Spiel gehen und fährt dann mit allen gleichzeitig: W gehalten, abwechselnd kurz links und rechts lenken. Bleibt ein Auto an einer Wand hängen, setzt es mit Lenkeinschlag zurück. Aufgezeichnet wird über `window.__bulliPerf`, die Ausgabe ist JSON auf stdout.

Auf echten Geräten (Referenz-Handy, Desktop mit GPU) zeigt `?debug=perf` dieselben Werte live als Overlay: FPS, Frame-Time, CPU-Zeit der Game-Loop, Draw Calls, Dreiecke, Geometrien, Texturen, Shader-Programme, Pixel-Ratio und die WebSocket-Bandbreite in beide Richtungen. Ohne das Flag gibt es weder Overlay noch Hook.

Was die Werte bedeuten:

- **Frame-Time:** Abstand zwischen zwei `requestAnimationFrame`-Aufrufen, also was der Spieler sieht.
- **CPU Game-Loop:** Zeit in `animate()` einschließlich des `render()`-Aufrufs auf der CPU; die GPU-Zeit ist nicht enthalten.
- **Draw Calls / Dreiecke:** `renderer.info.render` des letzten Frames, einschließlich Shadow-Pass.
- **Bandbreite:** Nutzdaten (JSON-Text) ohne WebSocket-Framing und TCP-Overhead.

**Setup:** Mac mit Apple M5 Pro, Chromium 153 (Playwright 1.63), Node 24.18, Server lokal. Beide Clients laufen im selben Browser-Prozess und teilen sich die Maschine. Der Spawn-Punkt ist zufällig und die Route nicht festgelegt – die Draw Calls schwanken deshalb von Lauf zu Lauf stark (siehe unten).

## Ergebnisse

### Lauf A – SwiftShader, Desktop 1280×800 (Standard von `npm run perf:baseline`)

Die adaptive Auflösung senkt die Pixel-Ratio bei so niedrigen FPS auf 0,75.

| | Client 1 | Client 2 |
|---|---|---|
| FPS | 13,5 | 12,6 |
| Frame-Time p50 / p95 | 50 / 167 ms | 83 / 150 ms |
| CPU Game-Loop p50 / p95 | 0,8 / 1,1 ms | 1,0 / 1,5 ms |
| Draw Calls Ø / p95 / max | 67 / 201 / 269 | 230 / 428 / 490 |
| Dreiecke Ø / max | 41 k / 57 k | 58 k / 73 k |
| Geometrien / Texturen / Programme | 171 / 3 / 11 | 187 / 2 / 10 |
| WS raus | 1,47 kB/s · 6,8 msg/s | 1,77 kB/s · 8,2 msg/s |
| WS rein | 1,98 kB/s · 8,3 msg/s | 1,67 kB/s · 6,9 msg/s |
| gefahrene Strecke | 445 m | 224 m |

### Lauf B – lokale GPU (Metal), Desktop 1280×800, DPR 1

| | Client 1 | Client 2 |
|---|---|---|
| FPS | 59,7 | 59,6 |
| Frame-Time p50 / p95 / max | 16,7 / 16,7 / 133 ms | 16,7 / 16,7 / 150 ms |
| CPU Game-Loop p50 / p95 | 1,4 / 2,1 ms | 1,0 / 1,8 ms |
| Draw Calls Ø / p95 / max | 51 / 116 / 120 | 40 / 52 / 52 |
| Dreiecke Ø / max | 43 k / 46 k | 41 k / 44 k |
| Geometrien / Texturen / Programme | 269 / 4 / 12 | 205 / 2 / 9 |
| WS raus | 3,46 kB/s · 16,9 msg/s | 3,49 kB/s · 17,2 msg/s |
| WS rein | 3,92 kB/s · 17,4 msg/s | 3,90 kB/s · 17,2 msg/s |
| gefahrene Strecke | 548 m | 554 m |

In diesem Lauf sind beide Autos früh aus der Stadt gefahren, deshalb die niedrigen Draw Calls.

### Lauf C – lokale GPU (Metal), iPhone 13 (390×844, DPR 3 → auf 2 begrenzt)

| | Client 1 | Client 2 |
|---|---|---|
| FPS | 60,0 | 60,0 |
| Frame-Time p50 / p95 | 16,7 / 16,8 ms | 16,7 / 16,8 ms |
| CPU Game-Loop p50 / p95 | 1,6 / 2,0 ms | 1,3 / 2,0 ms |
| Draw Calls Ø / p95 / max | 344 / 549 / 583 | 266 / 597 / 775 |
| Dreiecke Ø / max | 64 k / 78 k | 60 k / 94 k |
| Geometrien / Texturen / Programme | 366 / 5 / 12 | 366 / 5 / 12 |
| WS raus | 3,47 kB/s · 16,8 msg/s | 3,65 kB/s · 17,1 msg/s |
| WS rein | 4,06 kB/s · 17,2 msg/s | 3,92 kB/s · 17,0 msg/s |
| gefahrene Strecke | 217 m | 364 m |

### Gemeinsam für alle Läufe

- **Beitritt:** Bis zum Losfahren empfängt jeder Client ca. **20,5 kB** – fast alles davon ist die `init`-Nachricht mit der ganzen Welt (Stadt, Bäume, Coins, Powerups, Terrain).
- **Server-Speicher (RSS):** 74 MB nach dem Start, 78–79 MB nach ca. 25 s mit 2 Clients. Das ist kein Soak-Test.
- **Explorative Vorläufe** mit demselben Rendering-Code (nicht in `docs/baseline/`): Mitten in der Stadt wurden bis zu **845 Draw Calls** und **97 k Dreiecke** pro Frame gemessen.

## Einordnung

- **Draw Calls sind der Engpass, nicht die Dreiecke.** Je nach Blickrichtung sind es 30–120 am Stadtrand und 500–850 mitten in der Stadt. Fenster und Straßenmarkierungen sind schon instanziert (pro Gebäude bzw. pro Straßennetz), aber Gebäudedetails (Türen, Markisen, Klimageräte, Balkone, Schilder), Palmen, Laternen, Bänke sowie Bäume, Felsen und Büsche der Umgebung sind einzelne Meshes, und der Shadow-Pass zeichnet die schattenwerfenden davon ein zweites Mal. Auf Mobile-GPUs sind mehrere hundert Draw Calls pro Frame das Erste, was knapp wird. Instancing bzw. Merging der statischen Welt gehört deshalb in Phase 3 (kuratierte Map), dort mit Budget für Tier low.
- **Dreiecke** (40–97 k) und **Speicher** (bis 370 Geometrien, 2–5 Texturen, 9–12 Shader-Programme) sind unkritisch. Die Zähler wachsen, sobald neue Teile der Welt zum ersten Mal gezeichnet werden.
- **CPU der Game-Loop** liegt auf dem M5 Pro bei 1–2 ms pro Frame. Für das Handy sagt das wenig aus, dafür braucht es die Messung auf dem Referenz-Handy.
- **Bandbreite wächst quadratisch mit der Spielerzahl.** Pro Client gehen bei 60 FPS ca. 17 Updates/s mit je ca. 205 B hinaus (≈ 3,5 kB/s). Pro fremdem Spieler kommen ca. 17 Updates/s mit je ca. 225 B herein (≈ 4 kB/s). Hochgerechnet bei n Spielern: pro Client ≈ (n−1) · 4 kB/s herein, am Server ≈ n · (n−1) · 4 kB/s hinaus. Bei 8 Spielern sind das ≈ 28 kB/s pro Client und ≈ 225 kB/s am Server, bei 16 Spielern ≈ 60 kB/s bzw. ≈ 960 kB/s (ohne Framing-Overhead). Das ist die Messlatte für die Snapshots in Phase 1b (Binärformat, Deltas, Interest Management).
- **Die Upload-Rate hängt an der Framerate.** Der Client schickt nur innerhalb von `update()`, also höchstens einmal pro Frame. Bei 7–13 FPS (SwiftShader) sind es nur 7–8 Updates/s statt ca. 17. Auf schwachen Handys ist das genauso. Der feste Netz-Tick aus Phase 1b macht das unabhängig von der Framerate.
- **Headless mit GPU** ist näher an einem echten Desktop, hat aber keinen Compositor und kein echtes VSync. `requestAnimationFrame` ist auf 60 Hz begrenzt, deshalb liegt die Frame-Time p50 fest bei 16,7 ms.

## Offen

- **Referenz-Handy:** noch nicht festgelegt (siehe Plan, Phase 0). Messung dort: Spiel mit `?debug=perf` öffnen, eine Minute durch die Stadt fahren, die Overlay-Werte (FPS, Frame-Time, CPU, Draw Calls, Pixel-Ratio) hier ergänzen.
- **Desktop mit echter GPU im normalen Browserfenster**, ebenfalls über das Overlay.
- **Reproduzierbarer Blickpunkt:** Wegen des zufälligen Spawns streuen die Draw Calls stark. Für genaue Vorher/Nachher-Vergleiche beim Rendering braucht es eine feste Kamerafahrt, z. B. in der Sandbox aus Phase 1a.
