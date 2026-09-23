# Plan: Bulli Drive als Open-World-Multiplayer-Rennspiel

**Stand:** 2026-09-23 · **Aktuelle Phase:** Phase 0 – in Arbeit (Branch `refactor/phase-0-foundation`, Basis `1d39c07`)

## 0. Entscheidungen (2026-09-23)

Diese Entscheidungen sind verbindlich und ersetzen die Empfehlungen des Entwurfs. Der restliche Plan ist darauf abgestimmt.

| # | Entscheidung | Folge für den Plan |
|---|---|---|
| 1 | **Kampf, Coins, Powerups, HP und Scoreboard bleiben als eigener „Party-Modus“.** | Eigener Room-Typ `PartyRoom` neben `FreeRoamRoom` und `RaceRoom`. Der bestehende Code wird dorthin **verschoben, nicht gelöscht**. Powerup-Effekte werden in Phase 1a zu Modifikatoren der neuen Sim, damit der Party-Modus auf der neuen Physik läuft. |
| 2 | **Rempeln (echter Auto-Auto-Kontakt) ist gewollt, auch im Rennen.** | Der Netcode wird von Anfang an **server-autoritativ mit Client-Prediction und Reconciliation** gebaut. Die frühere „Stufe B“ ist jetzt der Kern von Phase 1b, die „Stufe A“ (Client bestimmt die Bewegung) entfällt. Die Auto-Auto-Kollision gehört in die shared-Sim (Phase 1a). |
| 3 | **Kuratierte Map von 1,5–2 km mit handgebauten Straßen-Splines.** | Die frühere Phase 3b (prozedurales Streaming, 4×4 km) **entfällt komplett**. Die Map wird vollständig geladen, Chunks dienen nur dem Culling und dem Merging. |
| 4 | **Mobile ist eine gleichwertige Plattform.** | Touch-Steuerung, Mobile-HUD und das Performance-Budget (Tier low) sind Teil jedes Exit-Kriteriums, nicht erst der Politur. Der Playwright-Smoke läuft ab Phase 0 auch mit Touch-Emulation. |
| 5 | **Das echte VW-Logo bleibt** (privates Fun-Projekt). | Kein Branding-Umbau. Die Logo-Textur (`Bulli.ts:23-89`, `addVWLogo`) zählt zu den Teilen, die bleiben. |
| 6 | **Der Server läuft 24/7 in einem Docker-Container; SQLite auf einem persistenten Volume ist in Ordnung.** | Graceful Shutdown, `/healthz`, Restart-Policy, Speicherstabilität über Tage und ein Backup des Volumes gehören zum Plan. Kein externer Datenbankdienst. |

## 1. Kurzfazit

Ich empfehle, das Spiel **Gameplay-first als Vertical Slice nach dem Strangler-Prinzip** umzubauen, nicht neu zu schreiben. Zuerst kommen eine neue Fahrphysik mit Auto-Auto-Kontakt in `src/shared` und ein server-autoritativer Netz-Kern mit Prediction. Darauf folgt ein faires Rennen in der heutigen Stadt, bei dem der Server simuliert und misst. Erst wenn Playtests zeigen, dass das Spaß macht, wird die kuratierte Map von 1,5–2 km gebaut. Ein prozedurales Streaming gibt es nicht.

Das heutige Spiel mit Kampf, Coins und Powerups geht dabei nicht verloren. Es wird Schritt für Schritt zum Party-Modus auf derselben Room-Infrastruktur und profitiert vom server-autoritativen Netz (Rempeln, Treffer und Pickups werden vom Server entschieden).

Der Grund für den inkrementellen Weg ist das Tempo des Projekts. Es wird im Hobby-Tempo allein entwickelt (72 Commits, lange Pausen). Deshalb muss es nach jeder Phase ein fertiges Spiel geben. Der Neubau als Greenfield-Projekt würde 5–7 Monate lang nichts Spielbares liefern. Der Plan mit Infrastruktur zuerst würde die Physik und den Netcode je zweimal bauen.

## 2. Ist-Zustand (Stand `1d39c07`)

- **Bleibt:** Chase-Cam (`main.ts:165-237`), Touch-Joystick und Action-Buttons (`mobile.ts`), Pulse- und Blur-Handling (`keyboard.ts`), Partikel-Batch (`particles.ts`), Shader-Pattern (`worldShaders.ts`), Canvas-Tacho (`hud.ts`), Radar-Logik (`minimap.ts`), die 5 Karossen (`Bulli.ts:303-685`) samt VW-Logo-Textur (`Bulli.ts:23-89`), mulberry32, Gebäude-Kit (`city.ts:548-726`), Dispatch/safeSend/Heartbeat auf dem Server und der build-version-Mechanismus (`build-version.txt`, Reload bei neuer Version, Commit `00a3d4c`).
- **Wandert in den Party-Modus (nach Entscheidung 1):** Schießen (`handlers.ts:148-207`), HP, Kills und Respawn-Schild, Mega-Ram (`main.ts:281-300`), Coins und Powerups (Server `world.ts:4-8`, `handlers.ts:70-99`, `handlers.ts:249ff.`; Client `world/coins.ts`, `world/powerups.ts`, `world/projectiles.ts`), das Punkte-Scoreboard (`state.ts:209`, `ui/playerList.ts`) und der Salto als Sprung. Der Code wird verschoben und an die neue Sim und den Room-Tick angepasst, aber nicht entfernt.
- **Wird ersetzt: Physik.** Das heutige Heading-Modell hängt an der Framerate (`Bulli.ts:750`) und hat weder Quergeschwindigkeit noch Gravitation noch Auto-Auto-Kontakt. Es ist mit Three.js, DOM und Netz in einer Gott-Klasse von 1018 Zeilen verwoben.
- **Wird ersetzt: Netz.** Der Server übernimmt Positionen ungeprüft (`handlers.ts:59-63`) und broadcastet in O(n²) ohne Tick. Remote-Autos springen hart auf die neue Position (`websocket.ts:451`). Es gibt keine Rooms und keinen Reconnect. Der Mega-Ram ist ein clientseitiger Abstandstest, der ein `shoot` schickt.
- **Wird ersetzt: Welt.** Die Stadt misst 220 m, wird einmalig aufgebaut und besteht aus über 1500 Meshes. Sie reist komplett in der `init`-Nachricht mit. Die Kollision ist ein Seiteneffekt des Renderns (`state.obstacles`, linearer Scan).
- **Wird ersetzt: Build.** Three kommt per unpkg-Importmap, Versionierung läuft über ein `?v=`-Rewrite, es gibt keine Tests (nur `tsc --noEmit`) und keine CI.
- **Fliegt raus:** Der AFK-Hack (`main.ts:369-424`, ersetzt durch ein serverseitiges Idle-Flag in Phase 1b), die Protokoll-Kopie in `client/types.ts:114-130` und `scripts/*.mjs` (ersetzt durch Vite in Phase 0).
- **Unterschätzter Befund zum Maßstab:** Die Höchstgeschwindigkeit liegt heute bei ca. 60 u/s (216 km/h), der Tacho zeigt aber 120 km/h an (`hud.ts:254`). Die Kamera hängt auf 23 m Höhe. Außerhalb der Stadt gibt es kein Wasser, und die Sinus-Hügel sind zu flach, um abzuheben.

## 3. Ziel-Tech-Stack

| Bereich | Entscheidung | Begründung |
|---|---|---|
| Client-Build | Vite, `three` über npm (zuerst 0.160.0 gepinnt) | HMR für das Tuning, Content-Hashes statt `?v=`, Worker und Addons importierbar; `build-version.txt` wird vom Build erzeugt, damit der Stale-Client-Reload erhalten bleibt |
| Three-Upgrade | Eigener PR in Phase 3 mit Screenshot-Vergleich | Farbmanagement und Shader-Chunks brechen, daher nicht mit Gameplay mischen |
| Physik | Eigene Arcade-Sim in reinem TS (`src/shared/sim`), fester Takt von 60 Hz, **inklusive Auto-Auto-Kontakt** | Läuft in Browser und Node gleich, ermöglicht Prediction, Re-Simulation, Bots und Ghosts; kein Rapier-WASM auf Mobile |
| Server | Express 5 + ws 8, eigener Room-Tick (Sim 60 Hz, Snapshots 20–30 Hz), kein Colyseus | Dispatch, Backpressure und Heartbeat existieren schon; die State-Sync von Colyseus passt nicht zu Prediction und Reconciliation |
| Netcode | Server-autoritativ: Client schickt Inputs, Server simuliert, Client predicted und reconciled | Voraussetzung für faires Rempeln (Entscheidung 2); Cheating über Positionen ist damit per Konstruktion ausgeschlossen |
| Protokoll | JSON + valibot-Schemas, eine einzige Quelle, `PROTOCOL_VERSION` | Laufzeitvalidierung ohne Drift; Binärformat bzw. Quantisierung erst nach Messung |
| UI | Imperatives DOM + Screen-State-Machine + typisierter Event-Bus | Das hud.ts-Muster funktioniert; Preact erst, wenn die Menüs zu groß werden |
| Tests | Vitest (shared/Server), Bot-Integrationstest, Playwright-Smoke mit 2 Browsern **Desktop und Mobile (Touch-Emulation)** ab Phase 0 | Heute gibt es null Sicherheitsnetz; Mobile ist gleichwertig |
| Qualität | Lint-Regel `no-restricted-imports` (three/DOM in `src/shared` verboten), Draw-Call-Budget über `renderer.info` in der CI | Die Sim muss serverfähig bleiben; die Performance muss messbar sein |
| Persistenz | SQLite (better-sqlite3, WAL) auf einem persistenten Docker-Volume, ab Phase 4 | Reicht für einen Prozess; ein Repository-Interface hält Postgres offen |
| Deploy | Bestehendes Multi-Stage-Dockerfile, 24/7-Betrieb mit Restart-Policy, `/healthz`, Graceful Shutdown (SIGTERM), gehashte Assets mit `immutable` | Minimaler Umbau; Deploys und Neustarts dürfen Spieler nur kurz trennen, nicht verlieren |

## 4. Zielarchitektur

```
src/shared/              # kein three, kein DOM (per Lint erzwungen)
  protocol/messages.ts   # valibot-Schemas → Typen, PROTOCOL_VERSION
  math/rng.ts            # mulberry32 + hash2 (Integer)
  world/terrain.ts       # getTerrainHeight → Heightfield der Map (bilinear)
  world/cityGen.ts       # aus server/world.ts, Plaza/Park als Daten (heutige Stadt)
  world/colliders.ts     # SpatialGrid 16 m, Kreise/AABBs
  world/roads.ts         # Straßen-Splines laden, Korridore, Oberflächen (Phase 3)
  maps/*.json            # kuratierte Map: Splines, Plätze, Props, Spawns (Phase 3)
  sim/vehicle.ts         # stepVehicle(state,input,params,world), DT=1/60
  sim/vehicleClasses.ts  # Stats der 5 Karossen (Masse, Grip, Topspeed)
  sim/collision.ts       # Auto vs. Welt: 2 Kreise, swept
  sim/contact.ts         # Auto vs. Auto: Kreis-Paare, Impuls, deterministische Reihenfolge
  sim/world.ts           # stepWorld(cars[], inputs[]) – ein Tick für alle Autos
  sim/modifiers.ts       # Powerup-Effekte als Parameter-Modifikatoren (Party)
  race/track.ts, gates.ts, standings.ts, tracks/*.ts
  party/rules.ts         # Schaden, Pickups, Respawn, Scoreboard-Regeln
src/server/
  index.ts, net.ts, session.ts
  rooms/Room.ts          # Tick-Loop, Input-Puffer, Snapshots, Join/Leave
  rooms/FreeRoamRoom.ts, RaceRoom.ts, PartyRoom.ts, lobby.ts
  validation/inputs.ts   # Rate-Limit, Tick-Fenster, Wertebereiche der Inputs
  party/                 # verschobener Kampf-/Coin-/Powerup-Code aus handlers.ts/world.ts
  race/RaceTimer.ts, persistence/db.ts (Phase 4)
src/client/
  main.ts (Bootstrap), game/loop.ts (Accumulator + Render-Alpha)
  vehicle/ LocalVehicle, RemoteVehicle, CarModel, Nametag
  camera/ChaseCamera.ts (+ Renn-Kamera), input/InputManager.ts (Tastatur, Touch, Gamepad)
  net/ connection.ts, clock.ts, dispatch.ts, netsim.ts
  net/prediction.ts      # Input-Historie, Replay, Fehlerglättung
  race/ RaceClient.ts, GateView.ts
  party/ coins, powerups, projectiles, scoreboard (verschoben aus world/ und ui/)
  world/ city.ts → ChunkBuilder (Culling/Merging, kein Streaming)
  ui/ screens, hud, minimap, events.ts, mobile-Layouts
  effects/ particles, worldShaders, renderQuality → QualityTiers
tools/ bots/ (Pure-Pursuit), worldviewer/ + Spline-Editor (Phase 3)
tests/ shared/, server/, integration/botRace.test.ts, e2e/ (Desktop + Mobile)
```

## 5. Phasenplan

Die Dauer ist in Wochen fokussierter Arbeit angegeben, im Kalender wird es länger. Dazu gelten vier Regeln:

- Neue Subsysteme laufen hinter URL-Flags, höchstens zwei gleichzeitig.
- Das Löschen des Legacy-Pfads ist Teil des Exit-Kriteriums. Kampf, Coins und Powerups sind kein Legacy-Pfad, sondern wandern in den Party-Modus.
- Jedes Exit-Kriterium gilt für Desktop **und** Mobile.
- Nach Phase 2 und nach Phase 3 gibt es jeweils ein fertiges Spiel, an dem man aufhören könnte.

**Phase 0 – Fundament und Baseline (ca. 1 Woche) · Status: in Arbeit**
- **Ziel:** Sicher iterieren können, ohne dass sich für Spieler etwas ändert.
- **Deliverables:**
  - [x] Vite mit `three@0.160.0` über npm, Importmap und `scripts/*.mjs` gelöscht; `build-version.txt` und der Reload bei neuer Version funktionieren weiter
  - [ ] Vitest, CI (typecheck, test, build, docker), Playwright-Smoke mit 2 Tabs, einmal Desktop und einmal Mobile mit Touch-Emulation (Joystick, Action-Buttons)
  - [ ] Die eine Protokollquelle, `screens.ts:132` nutzt `sendToServer`
  - [ ] rng, terrain und cityGen nach shared, mit Golden-Test (Seed 0xB0111D ergibt 30 Gebäude und 120 Bäume)
  - [ ] `webglcontextlost`-Handler
  - [ ] Baseline-Messung (FPS, Draw Calls, Bandbreite) auf Desktop und einem Referenz-Handy
  - [ ] **Maßstab festlegen:** 1 u = 1 m, Ziel-Topspeed, Tacho korrigieren (die einzige gewollte sichtbare Änderung)
- Kampf, Coins, Powerups und Sprung bleiben in Phase 0 unverändert im Spiel.
- **Exit:** Das Spiel verhält sich auf Desktop und Mobile identisch zu `1d39c07` (bis auf den Tacho), der Stale-Client-Reload funktioniert, und die CI ist grün.

**Phase 1a – Fahrgefühl und Kontakt (3–4 Wochen, Flag `?physics=v2`)**
- **Deliverables:**
  - `stepVehicle` mit Längs- und Quergrip, Handbremse, Drift, die ein Boost-Meter füllt, und echter Gravitation
  - Klassen-Stats für die 5 Karossen, inklusive **Masse** für den Kontakt
  - Kollision mit der Welt als 2 Kreise gegen das SpatialGrid, swept bzw. mit Substeps (108 m/s bedeuten 1,8 m pro Tick), Gleiten an Wänden statt `speed×-0.5`
  - **Auto-Auto-Kontakt in `sim/contact.ts`:** Kreis-Paare pro Auto, Impuls mit Masse, geringer Restitution und Reibung, Drehmoment bei außermittigem Treffer, Impuls pro Kontakt begrenzt (kein Wegschleudern in die Luft). Die Paare werden in fester Reihenfolge (sortiert nach Spieler-ID) aufgelöst, damit Client und Server dasselbe rechnen. `stepWorld` simuliert alle Autos eines Ticks gemeinsam.
  - **Powerup-Effekte als Sim-Modifikatoren** (Turbo, Mega, Super-Jump, Ghost = kein Kontakt), damit der Party-Modus auf v2 läuft; Sprung/Salto als Impuls in der Sim
  - Fixed-Step-Loop
  - `Bulli.ts` zerlegt
  - InputManager mit Tastatur, Touch (bestehender Joystick und Buttons) und Gamepad; Option Auto-Gas für Touch
  - Sandbox-Strecke mit **Rampen**, Kurven, Wand und **Dummy-Autos zum Rempeln** sowie ein lil-gui-Tuning-Panel
  - Niedrigere Renn-Kamera
  - Reset statt der toten Recovery-Logik
- **Exit:** Mindestens 4 von 5 Testern ziehen das neue Fahren im Blindtest vor, auch auf dem Handy. Die Trajektorie ist bei 30, 60 und 144 FPS identisch. Der Tunneling-Test ist grün, auch für Auto gegen Auto bei Frontalzusammenstoß mit Topspeed. Ein Golden-Test für Kontaktszenarien (frontal, seitlich, Heck, drei Autos) läuft in Node und im Browser mit Toleranz gleich. Die Legacy-Physik ist gelöscht.

**Phase 1b – Server-autoritativer Netz-Kern (3–4 Wochen)**
- **Deliverables:**
  - Zuerst Rooms: Die Singletons in `state.ts:6` und `world.ts:4-9` werden zu Instanzfeldern. Das heutige Spiel läuft danach als **`PartyRoom`** (Kampf-, Coin- und Powerup-Code verschoben nach `server/party` und `client/party`), dazu kommt ein schlanker `FreeRoamRoom` ohne Kampf.
  - Room-Tick: Der Server simuliert mit 60 Hz über `stepWorld` und schickt mit 20 Hz (im Rennen 30 Hz) einen gebündelten Snapshot mit Zustand aller Autos und der letzten verarbeiteten Input-`seq` pro Spieler.
  - Uplink `input` mit `{seq, tick, buttons, steer, throttle}`, pro Paket redundant die letzten 3 Inputs; der Server puffert 1–3 Ticks gegen Jitter und begrenzt Inputs auf ein Tick-Fenster
  - Client-Prediction mit Input-Historie und Reconciliation (Replay ab dem bestätigten Tick), Fehlerglättung und Umgang mit Kontakt nach Abschnitt 6
  - Clock-Sync (Tick-Offset und RTT)
  - RemoteVehicle mit Hermite-Interpolation (100 ms Verzögerung) für entfernte Autos und extrapolierter Darstellung für Autos im Kontaktradius
  - Party-Regeln serverseitig: Pickups und Mega-Ram werden gegen den Server-Sim-Zustand entschieden; Mega-Ram wird echter Kontakt mit Schaden aus dem Impuls statt eines `shoot` aus dem Client
  - Session-Token mit 30 s Grace und Reconnect mit Backoff
  - `hello` mit Protokollversion; alte Clients werden **hart abgelehnt und zum Reload gezwungen**, kein v1/v2-Adapter (ergänzt den build-version-Mechanismus)
  - Dev-Netsim (Latenz, Jitter, Verlust)
  - Regel für `visibilitychange` und fehlende Inputs: Der Server wiederholt den letzten Input höchstens 250 ms lang, danach neutral mit Bremse; im Hintergrund wird das Auto zum Ghost (kein Kontakt). Das ersetzt den AFK-Hack durch ein serverseitiges Idle-Flag.
  - Graceful Shutdown: Bei SIGTERM werden Clients benachrichtigt und reconnecten nach dem Neustart
- **Exit:** Bei 150 ms RTT, 30 ms Jitter und 3 % Verlust fährt sich das eigene Auto ohne sichtbares Rubberbanding (Korrektur ohne Kontakt unter 10 cm im Mittel), Remote-Autos laufen flüssig, und Rempeln fühlt sich für beide Seiten nachvollziehbar an (Playtest Desktop gegen Handy). Ein Server-Tick mit 32 Autos bleibt unter 2 ms. Ein Reconnect innerhalb von 30 s behält den Spieler. Der Party-Modus ist spielbar wie vorher.

**Phase 2 – Vertical Slice Rennen (ca. 3 Wochen) → Release**
- **Deliverables:**
  - `shared/race` und die RaceRoom-State-Machine (lobby → countdown mit `startAt` und Freeze → racing → finished mit 30 s DNF → results/Rematch)
  - Gates und Zeitmessung laufen im Server-Sim-Tick mit Sub-Tick-Interpolation (`RaceTimer`, siehe Abschnitt 6)
  - 2 Strecken in der heutigen Stadt: „Downtown Loop“ (ggf. gridSize 4→6) und „Hill Sprint“ mit Rampen zu einem Aussichtspunkt
  - **Echter Kontakt im Rennen** mit Anti-Griefing: Ghost-Phase in den ersten Sekunden nach dem Start und nach jedem Reset, Ghost für Falschfahrer und für Spieler mit schlechter Verbindung
  - Launch-Boost und Windschatten
  - **Bots als Auffüller** (serverseitig, dieselbe Sim mit Bot-Input) und Solo-Zeitfahren mit eigenem Ghost aus Input-Streams
  - Race-HUD und Gate-Shader, Mobile-Layout für das Rennen (Gas/Bremse, Auto-Gas, Boost)
  - Modus-Auswahl im Menü: Free Roam, Rennen, Party
  - Sichtweite 120–600 m
- **Exit:** Bot-Rennen mit Kontakt in der CI grün. Manipulierte Clients (Input-Flut, Inputs aus der Zukunft, ungültige Werte) werden verworfen, ohne andere Spieler zu stören. Mindestens 70 % der Playtester wollen gleich noch ein Rennen fahren, auf Desktop und Handy.

**Phase 3 – Kuratierte Map (4–5 Wochen) → Release**
- **Deliverables:**
  - Eigener PR für das Three-Upgrade
  - Eine Map von 1,5–2 km mit **handgebauten Straßen-Splines als JSON**, prozedural geschmückt (Gebäude, Bäume, Props entlang der Korridore)
  - `tools/worldviewer` mit einfachem Spline-Editor (Punkte setzen, Breite, Oberfläche, Export als JSON)
  - Straßen als Ribbons mit Markierungs-Shader
  - Ein vorberechnetes Heightfield für die ganze Map mit Road-Corridor-Flatten, als Asset ausgeliefert; Mesh, Client und Server interpolieren identisch bilinear
  - Die ganze Map wird beim Start geladen; Gebäude gemergt pro Chunk und Material, Fenster im Shader, Props als InstancedMesh, Frustum- und Distanz-Culling pro Chunk
  - Offroad-Oberflächen, Leitplanken, Out-of-Track-Reset
  - Eine Party-Zone (Arena oder Stadtteil) für den Party-Modus
  - QualityTiers
  - `routeToTrack` für neue Strecken auf den Splines
- **Exit:** Unter 300 Draw Calls. 60 FPS auf dem Referenz-Desktop, mindestens 30 FPS auf dem Handy (Tier low) bei stabilem Speicher (iOS ohne Tab-Reload nach 20 Minuten). Die Strecken aus Phase 2 laufen unverändert oder sind auf die neue Map portiert.

**Phase 4 – Open-World-Multiplayer und Persistenz (3–4 Wochen)**
- **Deliverables:**
  - Event-Marker (Sprint, Circuit, Zeitfahren, Drift-Zone) mit Umkreis-Einladungen als Race-Overlay in der Free-Roam-Welt
  - Snapshot-Culling nach Distanz (bei 1,5–2 km und ca. 32 Spielern reicht das; ein Interest-Grid nur, wenn Messungen es verlangen)
  - SQLite-Bestenlisten pro `(trackId, mapVersion, Klasse)` auf dem persistenten Volume, mit Migrationen
  - Zeiten stammen aus dem Server-Sim und sind damit autoritativ; eingereichte Ghosts werden serverseitig aus Input-Streams nachsimuliert
  - Party-Scoreboard optional persistent (Tages-/Wochenwertung)
  - Ghost-Regeln als Feld im TrackDef
  - Backup des SQLite-Volumes (täglicher Snapshot via `VACUUM INTO` oder Online-Backup-API)
- **Exit:** 32 Spieler plus Bots pro Instanz bei unter 30 kB/s pro Client. Der Container läuft 7 Tage ohne Neustart mit stabilem Speicher. Ein Restore aus dem Backup ist getestet.

**Phase 5 – Politur (parallel ab Phase 2)**
- Spatial Audio, Tutorial, Einstellungen, Metriken, Nametag-Culling, Feinschliff der Touch-Steuerung (Haptik, Layout-Optionen), Party-Modus-Inhalte (neue Powerups, Arenen)

## 6. Netcode kompakt

**Modell: Der Server simuliert, der Client sagt voraus.** Es gibt nur noch dieses eine Modell für alle Room-Typen.

- **Uplink:** Der Client sendet pro Sim-Tick seinen Input mit `{seq, tick}`, gebündelt mit 30–60 Hz, pro Paket redundant die letzten 3 Inputs. Im Stand und ohne Eingabeänderung darf der Takt sinken.
- **Server-Tick:** 60 Hz. Pro Tick werden die gepufferten Inputs aller Spieler angewendet und `stepWorld` für alle Autos inklusive Kontakt ausgeführt. Fehlt ein Input, wird der letzte bis zu 250 ms wiederholt, danach gilt neutral mit Bremse. Inputs außerhalb des Tick-Fensters werden verworfen; Inputs werden auf gültige Wertebereiche geklemmt.
- **Downlink:** Pro Room und Tick-Intervall (20 Hz, im Rennen 30 Hz) geht ein gebündelter Snapshot raus: Position, Rotation, Geschwindigkeit, Winkelgeschwindigkeit und letzter Input jedes Autos sowie die letzte verarbeitete `seq` des Empfängers.
- **Prediction und Reconciliation (eigenes Auto):** Der Client simuliert sein Auto sofort mit dem eigenen Input und speichert Input und Zustand pro Tick. Trifft ein Snapshot ein, setzt er den Zustand auf den bestätigten Tick zurück und spielt alle unbestätigten Inputs erneut ab. Die Differenz zwischen alter und neuer Vorhersage wird nicht hart übernommen, sondern als Render-Offset über 100–200 ms abgebaut. Ab 4 m Abweichung wird hart gesnappt.
- **Remote-Autos, fern:** Hermite-Interpolation mit 100 ms Verzögerung, Yaw über den kürzesten Bogen, Extrapolation bis 250 ms bei Paketverlust.
- **Remote-Autos, im Kontaktradius (ca. 15–20 m):**
  - Im lokalen Predict werden sie **auf den vorhergesagten Tick extrapoliert**: ausgehend vom letzten Server-Zustand mit `stepVehicle` und ihrem zuletzt bekannten Input („Input-Repeat“). So liegen eigenes Auto und Gegner in derselben Zeitebene, und ein Stoß wirkt sofort und lokal.
  - Dargestellt werden sie in diesem Radius mit genau dieser extrapolierten Pose, damit sichtbarer und gespürter Kontakt übereinstimmen. Beim Übergang zwischen fern und nah wird zwischen interpolierter und extrapolierter Pose überblendet.
  - Die Extrapolation ist auf ca. 250 ms begrenzt. Bei höherer RTT wird der Kontakt lokal abgeschwächt (weicher Impuls), die endgültige Wirkung kommt dann vom Server.
- **Auflösung des Kontakts:** Maßgeblich ist immer der Server. Er rechnet den Kontakt mit den tatsächlich eingetroffenen Inputs beider Autos in fester Paar-Reihenfolge. Der nächste Snapshot korrigiert beide Clients; die Korrektur nach einem Kontakt wird weich geglättet (Render-Offset), bei großen Abweichungen über ein etwas längeres Fenster, aber nie länger als 300 ms.
- **Kosten begrenzen:** Beim Replay werden nur Autos im Kontaktradius mitsimuliert; alle anderen bleiben interpoliert. Bei 60 Hz und 150 ms RTT sind das ca. 9–12 Ticks Replay pro Snapshot für wenige Autos, was auch auf dem Handy reicht.
- **Anti-Griefing:** Ghost (kein Kontakt) nach Reset und Respawn, in der Startphase des Rennens, für Falschfahrer, für Tabs im Hintergrund und für Spieler mit sehr schlechter Verbindung. Der Impuls pro Kontakt ist begrenzt; schwere Klassen schieben mehr, aber nicht beliebig.
- **Gates und Zeitmessung:** Das Segment zwischen zwei Server-Ticks wird mit dem nächsten Gate geschnitten, der Kreuzungszeitpunkt sub-tick interpoliert. Es zählt immer nur das jeweils nächste Gate. Weil der Server die Bewegung selbst rechnet, entfallen Token-Bucket, Swept-Validierung von Client-Positionen und die Klemmung auf die Empfangszeit.
- **Countdown:** Der Server schickt `startAt` als Server-Tick; jeder Client rendert den Countdown lokal. Bis zum Start ignoriert der Server Gas-Inputs.
- **Party-Modus:** Treffer, Pickups und Mega-Ram werden gegen den Server-Zustand geprüft. Schüsse nutzen weiter das heutige Ziel-basierte Modell (`shoot` mit `targetId`, Reichweiten- und Cooldown-Prüfung), jetzt aber gegen Server-Positionen.
- **Determinismus:** Bitgleichheit zwischen Browser und Node ist nicht nötig, weil die Reconciliation Abweichungen korrigiert. Je näher die Sims beieinander liegen, desto seltener sind Korrekturen: kein `Math.random` in der Sim, feste Reihenfolge, Integer-Hash für Strukturdaten, vorberechnetes Heightfield.

## 7. Top-Risiken

| Risiko | Gegenmaßnahme |
|---|---|
| Kontakt fühlt sich unter Latenz unfair an (Gegner „teleportiert“, Stoß kommt verspätet oder doppelt) | Remote-Autos im Kontaktradius extrapoliert predicten und genau so darstellen, weiche Korrektur, begrenzter Impuls, Kontakt-Playtests mit Dev-Netsim ab Phase 1b |
| Rubberbanding des eigenen Autos durch Reconciliation | Gemeinsame shared-Sim, fester Takt, Render-Offset statt Snap, Messwert „Korrektur pro Snapshot“ im Debug-HUD |
| Spieler mit hoher RTT (Mobilfunk) zerstören das Erlebnis für andere | Ghost ab einer RTT-/Verlust-Schwelle, lokaler Kontakt abgeschwächt, Extrapolation begrenzt |
| Griefing durch Rempeln (Start, Respawn-Camping, Falschfahrer) | Ghost-Phasen, Impulsbegrenzung, Falschfahrer-Ghost, im Party-Modus Respawn-Schild |
| CPU-Last: Replay auf dem Handy, 60-Hz-Sim für viele Autos auf dem Server | Replay nur für Autos im Kontaktradius, SpatialGrid für Paar-Suche, Tick-Budget im Bot-Test messen |
| Das Tuning von Fahrgefühl und Kontakt ufert aus | Sandbox mit HMR, lil-gui und Dummy-Autos, harte Timebox, wöchentliche Playtests |
| Der Party-Modus bremst den Umbau (Legacy-Code muss auf neue Sim und Room-Tick) | Powerups als Sim-Modifikatoren schon in 1a, Party-Code gebündelt verschieben statt umschreiben, Party-Modus darf in 1b hinter einem Flag reifen |
| Die Stadt ist zu klein bzw. das Tempo passt nicht zum Maßstab | Maßstab in Phase 0 festlegen, gridSize 6, Hill Sprint, Renn-Kamera |
| Der Bau der kuratierten Map frisst die Zeit | Spline-Editor im worldviewer, prozedurales Schmücken entlang der Korridore, erst ein Stadtteil als spielbarer Ausschnitt |
| Leere Lobbys (realistisch 1–2 Spieler gleichzeitig) | Serverseitige Bots, Solo-Zeitfahren und asynchrone Ghosts schon in Phase 2, statt Sharding für 64 Spieler |
| Mobile: iOS-Speicher, Kontextverlust, Throttling, ungenaue Touch-Steuerung im Rennen | Tier low als Designgrenze, Handler für Kontextverlust, Auto-Gas, Mobile in jedem Exit-Kriterium, Soak-Tests auf echten Geräten |
| 24/7-Betrieb: Speicherlecks, Neustarts bei Deploys, Datenverlust auf dem Volume | Soak-Test über Tage, Graceful Shutdown mit Reconnect, `/healthz`, Restart-Policy, tägliches SQLite-Backup mit getestetem Restore |
| Math.sin weicht zwischen Browser-Engines und Node ab | Integer-Hash für Strukturdaten, vorberechnetes Heightfield, Vergleiche mit Toleranz; Reconciliation fängt Restabweichungen ab |
| Projektabbruch mitten im Umbau | Phase 2 und Phase 3 sind jeweils ein fertiges Spiel, der Party-Modus bleibt durchgehend spielbar |

## 8. Offene Entscheidungen (mit Empfehlung)

Entschieden am 2026-09-23 und daher nicht mehr offen: Kampf/Coins/Powerups (Party-Modus), Rempeln (ja, auch im Rennen), Welt (kuratiert, 1,5–2 km, kein Streaming), Mobile (gleichwertig), Branding (VW-Logo bleibt), Hosting (Docker 24/7, SQLite auf Volume). Siehe Abschnitt 0.

1. **Spielerzahlen:** Empfehlung: bis 8 pro Rennen, bis 16 pro Party-Room und ca. 32 pro Free-Roam-Instanz; Sharding erst, wenn es gemessen nötig ist.
2. **Topspeed und Maßstab:** Empfehlung: ca. 45–55 m/s Basis, mit Boost ca. 70 m/s, 1 u = 1 m. Wird in Phase 0 festgelegt.
3. **Kontaktstärke im Rennen:** Empfehlung: gleiche Physik wie im Free Roam, aber Impuls pro Kontakt begrenzt und Ghost in den ersten 3 s nach Start und Reset. Im Playtest von Phase 2 nachjustieren.
4. **Sprung außerhalb des Party-Modus:** Empfehlung: im Free Roam erlaubt, im Rennen aus (Rampen übernehmen die Rolle).
5. **Party-Modus in der neuen Map:** Empfehlung: eigene Zone bzw. Arena statt der ganzen Map, damit sich Free Roam und Party nicht stören.
6. **Standard-Steuerung auf Mobile:** Empfehlung: Auto-Gas an, Joystick nur zum Lenken, Bremse/Rückwärts als Button; umschaltbar in den Einstellungen.
7. **Accounts:** Empfehlung: anonymer Geräte-Token und Server-Bestenlisten, keine Logins in v1.
8. **Hoster-Details:** Welcher Host, welches Backup-Ziel? Empfehlung: eine Region, WebSocket-Idle-Timeouts und Verhalten bei Deploys vorab prüfen, Backups außerhalb des Hosts ablegen.
9. **Zeitbudget:** Wie viele Stunden pro Woche? Empfehlung: Phase 2 als festes erstes Release-Ziel setzen, alles danach nach Spielwert priorisieren.
