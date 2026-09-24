# Phase 2: Vertical Slice Rennen – verbindliche Spezifikation

**Stand:** 2026-09-24 · **Branch:** `game/phase-2-racing` (auf `main` e1fccbd) · Bezug: [`refactor-plan.md`](refactor-plan.md) Abschnitt 0 (Entscheidungen), 5 (Phase 2), 6 (Netcode kompakt) · Grundlagen: [`phase-1a-design.md`](phase-1a-design.md) (Sim, Abschnitte 5–10), [`phase-1b-design.md`](phase-1b-design.md) (Rooms, Protokoll, Tick, Prediction, Abschnitte 2–8)

Dieses Dokument ist die verbindliche Grundlage für Phase 2. Verbindlich sind Struktur, Datenformate, Nachrichten, die Reihenfolge im Tick, die Regeln und die Umsetzungsreihenfolge. Zahlen mit dem Vermerk *Startwert* werden im Playtest und mit Bots nachjustiert. Abweichungen kommen wie in 1a und 1b in einen eigenen Abschnitt am Ende (Abschnitt 25) und werden nicht still umgesetzt.

**Rahmen (aus den Nutzerentscheidungen, nicht verhandelbar):**

- **Echtes Rempeln auch im Rennen.** Der Kontakt aus `stepWorld` bleibt an. Nur die Anti-Griefing-Regeln aus Abschnitt 11 schalten ihn gezielt ab.
- **Server-autoritativ:** Der Server misst Zeiten, Gates und Positionen im eigenen Sim-Tick. Der Client sagt nur voraus und zeigt an.
- **Mobile ist gleichwertig:** Race-HUD, Lobby, Countdown, Ergebnisse und das Zeitfahren funktionieren mit Touch im Hoch- und im Querformat.
- **Neue Features gehen direkt live**, ohne Feature-Flag, nach grüner CI per Squash-Merge. Jeder Commit auf dem Branch lässt das Spiel spielbar.
- **Keine Rückfragen:** Offene Punkte entscheide ich selbst und halte sie in Abschnitt 2 fest.
- Die Testpyramide aus `CLAUDE.md` gilt. Höchstens **ein** neuer E2E-Test (der Renn-Nutzerweg), alles andere als Unit- oder Bot-Integrationstest. Jeder neue Test bekommt eine Mutationsprobe.
- `src/shared` bleibt frei von three, DOM und Node-Globals (`tests/shared/purity.test.ts`). Neu dazu kommt `src/shared/race`.

---

## 1. Überblick

```
                         RaceRoom (60 Hz, Snapshots 30 Hz)
┌──────────────────────────────────────────────────────────────────────────────────┐
│ lobby ─► countdown ─► racing ─► finished ─► results ─┐                           │
│   ▲       (startTick,   (Gates,   (30 s DNF   (Rematch/  │                           │
│   │        Freeze,       Runden,   nach dem    Next-     │                           │
│   │        Bots rein)    Zeiten)   Ersten)     Track)    │                           │
│   └────────────────────────────────────────────────────┘                           │
│                                                                                    │
│ Room.step(T):                                                                      │
│   Inputs (Menschen: InputBuffer · Bots: LineDriver) ─► raceInputFilter (Freeze)    │
│   ─► beforeStep: Ghost-Böden, Launch-Mods ─► stepWorld(raceWorld: Karte + Strecke, │
│      Windschatten an) ─► afterStep: Gates (Sub-Tick), Fortschritt, Falschfahrer,   │
│      Ziel, Phasenwechsel ─► Events, raceStatus (5 Hz), Snapshot (30 Hz)            │
└──────────────────────────────────────────────────────────────────────────────────┘
         ▲ input (binär, wie 1b)              │ raceState · raceStatus · events · snapshot
         │                                    ▼
Client: Prediction mit denselben Regeln (Freeze, Ghost-Böden, Launch, Windschatten,
        Reset-Pose) · Race-HUD · Minimap · Gate-Visuals · Ghost-Wiedergabe (Zeitfahren)
```

Phase 2 baut **keine neue Physik**. Sie ergänzt die Sim um drei klar abgegrenzte Dinge: den Windschatten-Modifikator, den Launch-Modifikator und eine Reset-Pose pro Welt. Dazu kommt das Rennen als eigener Room-Typ auf der Room-Basis aus 1b.

---

## 2. Entscheidungen dieser Phase (selbst getroffen)

| # | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | `gridSize` 4 → 6 für den Downtown Loop (Plan: „ggf.“)? | **Bleibt 4.** | Eine größere Stadt ändert Weltgenerierung, Goldens, Spawns, Props und die Grafik-Messungen. Die Map wird in Phase 3 ohnehin ersetzt. Die Runde mit 750 m reicht für 3 Runden in rund 90 s. |
| E2 | Wo liegen die Rampen des Hill Sprint? | **In der Karte** (`MapData`, alle Modi), `MAP_VERSION` 2 → 3 | Free-Roam- und Party-Spieler sollen die Sprünge auch nutzen. Rampen liegen außerhalb der Stadt, Spawns treffen sie nie. |
| E3 | Streckenbegrenzungen (Absperrungen, Pfeiltafeln) | **Collider nur in der Renn-Welt** (`raceWorld` = Karte + Strecke) | Sperrt Seitenstraßen im Rennen, ohne Free Roam und Party zu verbauen. Client und Server bauen dieselbe Renn-Welt aus shared-Daten. |
| E4 | Sprung im Rennen | **Aus** (`BTN_JUMP` wird gefiltert, Button ausgeblendet) | Empfehlung aus Plan 8.4. Die Rampen übernehmen die Rolle. |
| E5 | Feldgröße und Bots | Rennen **bis 8 Autos**, Bots füllen auf **6** auf, ab 6 Menschen ohne Bots | Plan 8.1 (bis 8 pro Rennen). Ein Feld von 6 fühlt sich voll an und bleibt auf dem Handy flüssig. |
| E6 | Zeitfahren | **Eigener Room-Typ `timetrial`**, eine private Instanz pro Spieler, ganzer Lauf (Sprint oder 3 Runden) | Keine Wechselwirkung mit anderen Autos. Nur dann ist der Lauf aus den Inputs allein nachsimulierbar (Ghost). |
| E7 | Wie spielt der Client den Ghost ab? | **Pose-Spur vom Server** (20 Hz, quantisiert), die der Server aus dem Input-Stream **nachsimuliert** | Browser und Node rechnen nicht bitgleich (1b, Plan 6). Über 90 s würde ein im Browser simulierter Ghost auseinanderlaufen. Der Server simuliert deterministisch und liefert die Spur. |
| E8 | Ghost-Speicher | **`GhostStore`-Interface, synchron**; Phase 2 `MemoryGhostStore`, Phase 4 `SqliteGhostStore` | better-sqlite3 ist synchron. Ein synchrones Interface spart Promise-Ketten im Tick. Nach einem Neustart sind die Ghosts weg, das ist in Phase 2 in Ordnung. |
| E9 | DNF-Regel | 30 s nach dem **ersten Zieleinlauf, auch wenn es ein Bot ist** | Das ist die übliche Rennregel. Bei „leicht“ kommen Menschen ohnehin vor den Bots ins Ziel. |
| E10 | Nach den Ergebnissen | Abstimmung **Rematch / Nächste Strecke**, Mehrheit der Menschen. Bei Gleichstand oder ohne Stimmen gilt **Nächste Strecke**. | Abwechslung. Wer abstimmt, gilt in der nächsten Lobby als bereit. |
| E11 | Sprache der UI | **Englisch** wie die bestehende UI („LAP 2/3“, „WRONG WAY“, „GO!“) | Einheitlich mit Splash, Room-Chip und HUD. Doku und Commits bleiben wie bisher. |
| E12 | Ghost nach Reset | **Bestehende Sim-Regel** (`RESET_GHOST_TICKS` = 120, 2 s) plus Overlap-Hold aus 1b | Das Team hat die Mechanik bereits (5.4 in 1b). Die 3 s gelten für den Start. |
| E13 | Positionsdistanz | **Restweg entlang der Ideallinie** bis zum nächsten Gate. Liegt das Auto mehr als 25 m daneben, gilt die Luftlinie. | Die Luftlinie ordnet Autos um Kurven falsch. Der Restweg ist die „Distanz zum nächsten Gate“, gemessen wie gefahren. |
| E14 | Protokoll | **`PROTOCOL_VERSION` 2 → 3** | Der Self-Block bekommt `draft`, die Mod-Bits `launch` und `bogged`, und die Kompakt-Flags zwei Bits. JSON-Nachrichten kommen nur additiv dazu. |
| E15 | Startaufstellung | Rennen 1 nach Beitrittsreihenfolge, danach nach dem Ergebnis des vorigen Rennens (Sieger auf der Pole). Neue Spieler und Bots stehen dahinter, Bots in geseedeter Zufallsreihenfolge. | Einfach und nachvollziehbar. |

---

## 3. Module und Dateien

```
src/shared/race/                 # neu, rein (kein three, kein DOM), Stryker-Gruppe 'race'
  types.ts          # TrackDef, GateDef, GridSlot, TrackHint, RacePhase, RacerStatus
  rules.ts          # alle Renn-Konstanten (Abschnitt 4)
  geometry.ts       # Polylinien: Verrundung, Resampling, Projektion mit Fenster, Bogenlänge
  racingLine.ts     # Ideallinie + Geschwindigkeitsprofil aus der Krümmung
  gates.ts          # Gate-Segment, Kreuzung mit Sub-Tick-Anteil, Richtungstest
  progress.ts       # RaceProgress je Auto: passed, lap, Restweg, Falschfahrer, verpasstes Gate
  standings.ts      # Positionsberechnung (Sortierschlüssel, Abschnitt 9)
  launch.ts         # Launch-Ergebnis aus den Roh-Inputs des Countdowns
  inputFilter.ts    # raceInputFilter (Freeze, Sprung aus) und raceGhostFloor (Start-Ghost)
  raceWorld.ts      # createRaceWorld(map, track): Karte + Strecken-Collider + resetPose + slipstream
  lineDriver.ts     # Bot-Fahrer: Pure Pursuit entlang der Ideallinie, Schwierigkeitsstufen
  pursuit.ts        # aus tools/bots/driver.ts herausgelöst: steerForAngle, wrapAngle, forwardSpeed, Stuck-Logik
  ghostTrack.ts     # Pose-Spur kodieren/dekodieren (20 Hz, quantisiert)
  replay.ts         # replayRun(track, car, inputs): deterministische Nachsimulation
  tracks/downtownLoop.ts, tracks/hillSprint.ts, tracks/index.ts (TRACKS, TRACK_ROTATION)
src/shared/sim/
  slipstream.ts     # neu: Windschatten-Ziel je Auto (Abschnitt 13)
  modifiers.ts      # + launch, bogged, draft
  types.ts          # VehicleState + draft; VehicleModifiers + launch, bogged; SimWorld-Felder s. u.
  world.ts          # stepWorld: Windschatten-Schritt, wenn world.slipstream
  vehicle.ts        # Reset: world.resetPose vor world.roads
src/shared/world/
  mapFeatures.ts    # neu: MAP_RAMPS, HILL_ROAD (Polylinie für die Optik)
  mapData.ts        # Rampen + Rampenkanten in die Karte, MAP_VERSION = 3
  colliders.ts      # Rampenbasis = Gelände an der Hinterkante; SimWorld.resetPose?, SimWorld.slipstream
src/server/rooms/
  Room.ts           # Bot-Mitglieder, humanCount, world-Getter, forceGhost-Hook (Abschnitt 7)
  RaceRoom.ts       # Phasen, Rennregeln im Tick, Bots, Abstimmung
  TimeTrialRoom.ts  # extends RaceRoom: solo, Ghost-Aufzeichnung und -Auslieferung
  lobby.ts          # Instanzwahl für race/timetrial (Abschnitt 6.5)
  spawn.ts          # Fix der Fallback-Kandidaten (Abschnitt 18)
src/server/race/
  ghostStore.ts     # GhostStore-Interface, MemoryGhostStore, GhostKey, simHash
  botRoster.ts      # Bot-Namen, Klassen, Seeds, BotSession (Session ohne Socket)
src/client/race/
  RaceClient.ts     # raceState/raceStatus/Events → Zustand, Prediction-Hooks
  raceHud.ts        # Position, Runde, Zeit, Split, Pfeil, Countdown, Banner
  lobbyOverlay.ts, resultsOverlay.ts
  GateView.ts       # Gate-Bögen, Start-/Ziel-Portal, Startampel
  TrackDressing.ts  # Absperrungen, Pfeiltafeln, Leitpfosten (instanziert)
  GhostCar.ts       # halbtransparentes Auto entlang der Pose-Spur
src/client/world/
  ramps.ts, hillRoad.ts   # Rampen- und Hügelstraßen-Optik (alle Modi)
tools/bots/
  driver.ts         # nutzt src/shared/race/pursuit.ts, Verhalten unverändert
  bot.ts            # + Modus 'race' und 'timetrial' (LineDriver auf der eigenen Prediction)
```

`tools/` darf aus `src/` importieren, aber nicht umgekehrt. Deshalb wandert der gemeinsame Kern des Bot-Fahrens (Pure Pursuit, Lenkwinkel, Stuck-Erkennung) nach `src/shared/race/pursuit.ts`. `RoadDriver` in `tools/bots/driver.ts` importiert ihn von dort. `tests/tools/driver.test.ts` bleibt unverändert grün und dient als Regressions-Lock für das Verhalten.

---

## 4. Konstanten (`src/shared/race/rules.ts`)

| Konstante | Wert | Bedeutung |
|---|---|---|
| `RACE_SNAPSHOT_EVERY` | 2 | 30 Hz im Rennen und im Zeitfahren (1b 2.2) |
| `MAX_RACERS` | 8 | Autos im Rennen (Menschen + Bots) |
| `RACE_ROOM_MAX_MEMBERS` | 16 | Menschen pro Race-Room (Fahrer + Zuschauer) |
| `RACE_FIELD_TARGET` | 6 | Bots füllen bis hierhin auf |
| `LOBBY_ALL_READY_TICKS` | 60 | Alle Menschen bereit → Countdown nach 1 s |
| `LOBBY_AUTOSTART_TICKS` | 900 | Mindestens einer bereit → Countdown spätestens nach 15 s |
| `COUNTDOWN_PREP_TICKS` | 60 | Aufstellung sichtbar, bevor die Ampel beginnt |
| `TIMETRIAL_PREP_TICKS` | 30 | dasselbe im Zeitfahren (schneller Neustart) |
| `COUNTDOWN_TICKS` | 180 | Drei Lichter bei S − 180, S − 120, S − 60, Grün bei S = `startTick` |
| `START_GHOST_TICKS` | 180 | Kontakt-Ghost für alle von S bis S + 179 |
| `DNF_AFTER_FIRST_TICKS` | 1800 | 30 s nach dem ersten Zieleinlauf |
| `RESULTS_TICKS` | 900 | 15 s Ergebnisse und Abstimmung |
| `GATE_TOLERANCE` | 1,0 m | Kreuzungspunkt darf so weit über die Gate-Enden hinaus liegen |
| `WRONG_WAY_DOT` | −0,5 | Geschwindigkeit gegen die Tangente der Ideallinie (≈ 120°) |
| `WRONG_WAY_MIN_SPEED` | 4 m/s | darunter keine Falschfahrer-Erkennung |
| `WRONG_WAY_ENTER_TICKS` / `EXIT_TICKS` | 60 / 30 | Hysterese |
| `WRONG_WAY_BACKTRACK` | 25 m | Rückschritt auf der Ideallinie seit dem letzten Gate, der ebenfalls zählt |
| `MISSED_GATE_DISTANCE` | 30 m | Auf der Linie so weit hinter dem nächsten Gate → „verpasst“ |
| `OFF_LINE_DISTANCE` | 25 m | Weiter weg gilt für den Restweg die Luftlinie |
| `LAUNCH_WINDOW_TICKS` | 20 | Gas-Flanke in [S − 20, S] = perfekter Start |
| `LAUNCH_THROTTLE` | 128 | Schwelle für „Gas gedrückt“ |
| `LAUNCH_TICKS` / `LAUNCH_ACCEL` | 60 / × 1,6 | Launch-Boost *(Startwert)* |
| `BOGGED_TICKS` / `BOGGED_ACCEL` | 30 / × 0,5 | Frühstart *(Startwert)* |
| `DRAFT_RANGE` / `DRAFT_MIN` | 30 m / 3 m | Windschatten-Kegel *(Startwert)* |
| `DRAFT_HALF_WIDTH` | 1,2 m + 0,05 · Abstand | |
| `DRAFT_HEADING` | 20° | Kurs des Vordermanns höchstens so weit abweichend |
| `DRAFT_MIN_SPEED` | 15 m/s | beide Autos |
| `DRAFT_RISE` / `DRAFT_FALL` | 1,0 / 2,0 pro s | Ratenbegrenzung von `state.draft` |
| `DRAFT_TOP_ADD` / `DRAFT_ACCEL` / `DRAFT_FILL` | 4 m/s / + 15 % / 0,08 pro s | Wirkung bei `draft` = 1 *(Startwert)* |
| `RACE_STATUS_EVERY` | 12 | `raceStatus` mit 5 Hz |
| `GHOST_POSE_HZ` | 20 | Pose-Spur des Ghosts |
| `GHOST_PERSONAL_MAX` | 64 | persönliche Bestzeiten pro Ghost-Key im Speicher (LRU) |

---

## 5. Streckendaten und Strecken

### 5.1 Datenformat (`src/shared/race/types.ts`)

Konventionen wie in der Sim: 1 u = 1 m, Vorwärts ist `(sin yaw, cos yaw)`, links ist `(cos yaw, −sin yaw)`. `yaw = 0` zeigt nach +z (auf der Minimap oben), `π/2` nach +x.

```ts
export type TrackId = 'downtown-loop' | 'hill-sprint';

export interface Vec2 { x: number; z: number }

// Ein Gate ist ein Liniensegment der Breite width durch (x, z), quer zur
// Fahrtrichtung yaw. Gezählt wird nur eine Kreuzung in Fahrtrichtung.
export interface GateDef {
    x: number; z: number;
    yaw: number;                 // Fahrtrichtung beim Durchfahren
    width: number;               // m, Segment von links (+w/2) nach rechts (−w/2)
    visual: 'startFinish' | 'start' | 'finish' | 'arch';
}

// Startplatz k: Position und Blickrichtung, k = 0 ist die Pole
export interface GridSlot { x: number; z: number; yaw: number }

// Streckenbegrenzung und Hinweise. collider = Teil der Renn-Welt (E3)
export type TrackHint =
    | { kind: 'barrier'; x: number; z: number; yaw: number; length: number }      // Wasserbarrieren-Reihe, Collider: Box, top 1,0
    | { kind: 'chevron'; x: number; z: number; yaw: number; dir: 'left' | 'right' } // Pfeiltafel auf 2 Pfosten, Collider: 2 Kreise r 0,35
    | { kind: 'delineators'; line: Vec2[]; offset: number; spacing: number }       // Leitpfosten links und rechts, nur Optik
    | { kind: 'arrow'; x: number; z: number; yaw: number };                        // Pfeil auf der Fahrbahn, nur Optik

export interface TrackDef {
    id: TrackId;
    name: string;                // 'Downtown Loop'
    kind: 'circuit' | 'sprint';
    laps: number;                // circuit 3, sprint 1
    mapVersion: number;          // Karte, für die die Strecke gebaut ist (3)
    trackVersion: number;        // +1 bei jeder Änderung an Gates, Grid, Linie oder Hints (Ghost-Key)
    centerline: Vec2[];          // Fahrweg (circuit: geschlossen, letzter Punkt ≠ erster)
    lineOptions: { radius: number; apexShift: number };  // Verrundung der Ideallinie (5.4)
    gates: GateDef[];            // in Reihenfolge; circuit: gates[0] ist Start/Ziel
    grid: GridSlot[];            // mindestens MAX_RACERS Plätze hinter gates[0]
    hints: TrackHint[];
    minimap: { minX: number; maxX: number; minZ: number; maxZ: number };
}
```

**Checkpoint-Reihenfolge:** Die Reihenfolge der Gates im Array ist die Reihenfolge der Durchfahrt. Es zählt immer nur das nächste Gate (Plan 6). Mit `n = gates.length` und dem Zähler `passed` (Anzahl gezählter Durchfahrten) gilt:

| | Rundkurs (`circuit`) | Sprint (`sprint`) |
|---|---|---|
| nächstes Gate | `gates[passed % n]` | `gates[passed]` |
| erste Durchfahrt | `gates[0]` beim Losfahren (Rundenbeginn, keine gewertete Runde) | `gates[0]` = Startlinie |
| Runde | `lap = min(laps, floor((passed − 1) / n) + 1)` für `passed ≥ 1` | immer 1 |
| im Ziel bei | `passed = laps · n + 1` | `passed = n` |

Die Rennzeit läuft für alle ab `startTick` (stehender Start), nicht ab der ersten Gate-Durchfahrt. Runde 1 enthält damit den Weg vom Startplatz zur Linie.

### 5.2 Downtown Loop

Rundkurs, 3 Runden, gegen den Uhrzeigersinn, durch die heutige Stadt (Straßenachsen bei −98, −46, 6, 58, 110). Die Strecke kreuzt sich nicht selbst, es gibt also keine Frontalbegegnungen.

```
          x=−98                        x=6          x=58
 z=110      ┌──────────◄── G3 ──────────────────────────┐
            │                                           │
            │                                           ▲ G2
 z=58       │                           ┌──── G1 ──►────┘
            │                           │
            ▼ G4                        ▲ G0 Start/Ziel (6,−10),
            │                           │    Startaufstellung bis z = −44
 z=−46      │                           └───◄── G7 ─────┐
            │                                           ▲ G6
 z=−98      └──────────── G5 ──►────────────────────────┘
```

- **Mittellinie** *(Startwert)*: (6,−10) → (6,58) → (58,58) → (58,110) → (−98,110) → (−98,−98) → (58,−98) → (58,−46) → (6,−46) → zurück. Länge 832 m, 8 Kurven zu 90° (2 rechts, 6 links).
- **Ideallinie:** Verrundung mit R = min(24 m, halbe Schenkellänge), Außen-Innen-Außen-Versatz bis 4 m. Das ergibt etwa 750 m pro Runde, Kurven mit rund 15 m/s, die längste Gerade (x = −98) mit rund 160 m. Geschätzte Rundenzeit 27–30 s, das ganze Rennen etwa 1:30.
- **Gates** *(Startwerte, Breite 16 m, jeweils mitten zwischen zwei Kreuzungen)*: G0 (6,−10) yaw 0 · G1 (32,58) π/2 · G2 (58,84) 0 · G3 (−20,110) −π/2 · G4 (−98,−20) π · G5 (−20,−98) π/2 · G6 (58,−72) 0 · G7 (32,−46) −π/2.
- **Startaufstellung** (yaw 0, versetzt in zwei Spuren): (3,2|−16), (8,8|−20), (3,2|−24), (8,8|−28), (3,2|−32), (8,8|−36), (3,2|−40), (8,8|−44). In derselben Spur liegen 8 m zwischen zwei Plätzen, diagonal 6,9 m.
- **Hints:** An jeder Kreuzung der Strecke sperrt eine Barrieren-Reihe die Seitenstraßen ab (19 Reihen zu je 12 m). An den Außenseiten der 8 Kurven stehen Pfeiltafeln, dazu Fahrbahnpfeile vor jeder Kurve.

### 5.3 Hill Sprint

Sprint vom Stadtrand im Norden durch die Stadt nach Süden, über den flachen Übergangsring hinaus in die Hügel, über drei Rampen zu einem Aussichtspunkt auf 13,8 m Höhe. Der Blick geht zurück auf die Stadt.

- **Mittellinie** *(Startwert)*: (58,64) → (58,−150) → (80,−200) → (110,−208) → (180,−208) → (230,−175) → (285,−140) → (322,−80) → (350,−35) → (350,20) → (362,40). Länge 728 m, etwa 25–30 s.
- Der Weg aus der Stadt führt nach Süden (x = 58), weil der Übergangsring des Geländes dort flach ist (≤ 6 % Steigung). Nach Osten wäre er bis zu 50 % steil (gemessen mit `getTerrainHeight` beim Entwurf, siehe Datentest 20.1).
- **Rampen** (in der Karte, E2; die Basis ist die Geländehöhe an der Hinterkante, Abschnitt 5.5):

| Rampe | Mitte | yaw | B × L × H | Gelände hinten/vorne | effektive Kante |
|---|---|---|---|---|---|
| R1 „Stadtausfahrt“ (Stahlrampe) | (58,−128) | π | 8 × 12 × 1,6 m | 0,00 / 0,00 m | 1,60 m |
| R2 „Feldweg“ (Erdrampe mit Holzkante) | (150,−208) | π/2 | 8 × 14 × 2,2 m | 4,50 / 4,90 m | 1,81 m |
| R3 „Kuppe“ (Erdrampe) | (350,−6) | 0 | 10 × 16 × 3,2 m | 10,58 / 12,20 m | 1,58 m |

- **Gates** *(Startwerte, Breite 16 m in der Stadt, 18–20 m draußen)*: G0 Start (58,64) yaw π · G1 (58,−72) π · G2 (69,−175) 2,727 · G3 (125,−208) π/2 · G4 (205,−191,5) 0,987 · G5 (303,5,−110) 0,553 · G6 (350,−24) 0 · G7 Ziel (356,30) 0,540, Breite 20.
- **Ziel** am lokalen Hochpunkt: Gelände 13,77 m, 20 m ringsum ≤ 13,54 m.
- **Startaufstellung** (yaw π): (60,8|70), (55,2|74), (60,8|78), (55,2|82), (60,8|86), (55,2|90), (60,8|94), (55,2|98).
- **Hints:** Sperren an den 4 Kreuzungen in der Stadt. Außerhalb Leitpfosten links und rechts alle 15 m im Abstand von 5,5 m zur Mittellinie (nur Optik). Pfeiltafeln an den 4 Knicken außerhalb der Stadt.
- **Freiraum:** Der Entwurf misst mindestens 7,3 m von der Mittellinie bis zum nächsten Collider (Bäume, Felsen). Bäume und Felsen bleiben, wo sie sind. Der Datentest (20.1) sichert das ab.

### 5.4 Ideallinie (`racingLine.ts`, `geometry.ts`)

- `buildRacingLine(track)`: Die Mittellinie wird an jeder Ecke mit einem Kreisbogen verrundet (Radius aus `lineOptions`, begrenzt auf die halbe Länge des kürzeren Schenkels). In der Kurve verschiebt sie sich außen-innen-außen um bis zu `apexShift`. Danach wird sie alle 2 m neu abgetastet. Das Ergebnis ist `{x, z, s, tx, tz, curvature}[]` mit Bogenlänge `s` und Einheitstangente.
- **Geschwindigkeitsprofil** je Fahrzeugklasse: `v(s) = min(vtop, sqrt(μ_eff · g / |κ|))` mit `μ_eff = 0,85 · gripFront` als Sicherheitsabschlag, danach ein Rückwärtsdurchlauf mit der Bremsverzögerung `0,8 · brakeDecel`. Es wird einmal pro Klasse und Strecke berechnet, beim Laden.
- **Projektion mit Fenster:** `project(line, x, z, hintIndex)` sucht nur ±40 Punkte (±80 m) um den letzten Index. So springt die Projektion nicht auf einen parallelen Schenkel, der 52 m entfernt liegt. Ohne Hinweis (neues Auto, Reset) wird global gesucht und der Treffer mit der kleinsten Abweichung vom Fortschritt des Autos genommen.
- Die Ideallinie dient den Bots, der Positionsberechnung (Restweg), der Falschfahrer-Erkennung, der Reset-Pose und der Minimap.

### 5.5 Karte: Rampen und Hügelstraße (`mapFeatures.ts`, `MAP_VERSION` = 3)

- `MAP_RAMPS` (R1–R3) gehen in `createSimWorld(..., ramps)`. Ihre Kantenwände (`rampEdgeColliders`) kommen **ans Ende** der Collider-Liste (Vertragsreihenfolge: Bäume, Felsen, Stadt, Rampenkanten). Damit ändert sich `worldHash`, deshalb `MAP_VERSION` 3. Alte Clients laden über den Hash-Abgleich neu (1b 3.2).
- **Rampenbasis:** `createSimWorld` nimmt als Basis künftig die Geländehöhe **an der Mitte der Hinterkante** statt unter der Rampenmitte. Auf ebenem Grund ist das dasselbe. Die Sandbox ist eben, deshalb bleiben alle Goldens mit Rampen unverändert (der Golden-Lauf beweist das). Auf dem Hang schließt die Rampe hinten bündig ans Gelände an, statt eine Stufe zu bilden.
- `rampEdgeColliders` bekommt die Geländehöhe an jeder Wand und setzt `top` auf die tatsächliche Höhe der Rampenfläche über dem Gelände an der Wand (auf ebenem Grund unverändert).
- `HILL_ROAD`: Polylinie von der Stadtgrenze bis zum Ziel, 10 m breit, nur Optik (Schotter-Asphalt-Band, das dem Gelände folgt). Es ist in allen Modi sichtbar, damit Free Roam den Weg zum Aussichtspunkt zeigt.

### 5.6 Renn-Welt (`raceWorld.ts`)

```ts
createRaceWorld(map: MapData, track: TrackDef): SimWorld
// = createSimWorld(map.terrain, [...map.colliders, ...trackColliders(track)], MAP_RAMPS, null)
//   + resetPose: (s) => Pose auf der Ideallinie (Abschnitt 10.3)
//   + slipstream: true
trackHash(track): string   // FNV-1a über canonicalStringify(track), wie worldHash
```

- `SimWorld` bekommt zwei optionale Felder: `resetPose?: (s: VehicleState) => boolean` und `slipstream?: boolean`. Die Karte selbst setzt keins davon. Party, Free Roam, Sandbox und alle Goldens laufen damit unverändert.
- Der Server baut die Renn-Welt einmal pro Strecke und Prozess (wie `MapData`), der Client beim Betreten des Race-Rooms und beim Streckenwechsel.

---

## 6. RaceRoom-State-Machine

### 6.1 Phasen

```
             alle Menschen bereit (1 s) oder ein Mensch bereit + 15 s
   ┌───────┐ ────────────────────────────────────────────────►┌───────────┐
   │ lobby │                                                   │ countdown │ T = startTick
   └───────┘◄─────────────┐                                    └───────────┘──────────┐
       ▲                  │ Abstimmung vorbei (alle Menschen                          ▼
       │                  │ haben gestimmt oder 15 s um)                        ┌─────────┐
       │             ┌─────────┐   alle Menschen im Ziel/DNF oder dnfTick      │ racing  │
       │             │ results │◄─────────────────────────────┐                └─────────┘
       │             └─────────┘                              │  erster Zieleinlauf  │
       │                                               ┌──────────┐◄───────────────┘
       │                                               │ finished │
       │                                               └──────────┘
       └── aus jeder Phase: kein Mensch mehr im Room → Bots raus, Phase lobby, Strecke bleibt
```

| Phase | Eintritt | Was passiert | Austritt |
|---|---|---|---|
| `lobby` | Room neu, nach `results`, oder alle Menschen weg | Jeder Mensch steht auf seinem Startplatz, eingefroren (Freeze wie im Countdown). Bereit-Schalter, Wahl von Strecke und Bot-Stärke. Kein Bot im Room. | Alle Menschen (≥ 1) bereit → nach `LOBBY_ALL_READY_TICKS` · mindestens einer bereit → spätestens nach `LOBBY_AUTOSTART_TICKS` |
| `countdown` | aus `lobby` bei T0 | Fahrer = bereite Menschen (höchstens 8). Nicht bereite Menschen werden Zuschauer. Bots füllen auf `RACE_FIELD_TARGET` auf. Alle Autos werden auf das Grid gesetzt (`spawnVehicle`, Event `spawn`). `startTick = T0 + COUNTDOWN_PREP_TICKS + COUNTDOWN_TICKS`. Freeze. Die rohen Gas-Inputs werden für den Launch aufgezeichnet. | T = `startTick` |
| `racing` | T = `startTick` | Launch-Mods, Start-Ghost, Gates, Fortschritt, Falschfahrer, Reset-Pose, Windschatten | erster Zieleinlauf |
| `finished` | erster Zieleinlauf bei T1 | wie `racing`; `dnfTick = T1 + DNF_AFTER_FIRST_TICKS`. Autos im Ziel fahren als Ghost weiter. | alle **Menschen** im Ziel oder DNF, oder T = `dnfTick` |
| `results` | aus `finished` | Wer nicht im Ziel ist, bekommt DNF. `raceResults` geht raus, die Bots bleiben stehen (Stopp-Input). Abstimmung `rematch`/`next`. | alle Menschen haben gestimmt, oder `RESULTS_TICKS` um |
| → `lobby` | | Strecke nach E10 (bei `next`: `TRACK_ROTATION`). Die Bots verlassen den Room. Das neue Grid gilt nach E15. Wer abgestimmt hat, gilt als bereit. | |

- **Bereit ab 1 Spieler:** Ein einzelner Mensch drückt „READY“, nach 1 s beginnt der Countdown, und die Bots füllen auf 6 auf.
- **Ein Mensch verlässt das Rennen** (Menü, Grace abgelaufen): Sein Auto verschwindet, in den Ergebnissen steht „DNF (left)“. Während der Grace bleibt das Auto als Idle-Ghost stehen (1b 5.4). Kommt der Spieler zurück, fährt er weiter.
- **Später Beitritt** (Phase `countdown` bis `results`): Der Spieler wird Zuschauer, ohne Auto. Die Kamera folgt dem Führenden, Tippen wechselt das Auto. In der nächsten Lobby bekommt er einen Startplatz.

### 6.2 Zeitfahren (`TimeTrialRoom`)

- Eine Instanz pro Spieler, höchstens 1 Mensch, keine Bots, kein Windschatten-Partner.
- Phasen: `lobby` (Strecke wählen, „START“) → `countdown` → `racing` → `results` (ohne `finished`, keine DNF-Frist). „RETRY“ ist jederzeit möglich (`timeTrialRestart`). Es beginnt sofort ein neuer Countdown mit der kürzeren Vorbereitung `TIMETRIAL_PREP_TICKS`.
- Der Ghost (Abschnitt 15) fährt ab `startTick` mit: die persönliche Bestzeit, sonst der Streckenrekord.

### 6.3 Bots als Mitglieder

- Ein Bot ist ein `RoomMember` mit `bot: BotController` und einer `BotSession` (`server/race/botRoster.ts`): eine echte `Session` mit einem Null-Transport (`readyState` OPEN, `send` tut nichts, `rttMs` 0, `connected` true). So laufen Slot-Vergabe, Snapshots, `memberInfo`, `stepWorld` und Events ohne Sonderwege.
- `MemberInfo` bekommt `bot?: boolean` (additiv). Clients zeigen „BOT“ am Namensschild.
- `Room.size` zählt künftig nur Menschen (`humanCount`). Davon hängen Instanzwahl, `stepAll` (leere Rooms ticken nicht), `sweep` und `/healthz`-Metriken ab. Bots halten einen Room also nie am Leben.
- `Room.takeInput`: Für Bots entfällt der Input-Puffer, stattdessen `m.bot.drive(car, ctx, car.input)` (Abschnitt 14). Die Idle- und Lag-Regeln gelten für Bots nicht.
- Bots heißen „Kalle“, „Uschi“, „Hotte“, „Gabi“, „Manni“, „Heike“, „Jupp“ (mit Tag „BOT“). Klasse und Farbe kommen aus einem Seed pro Room und Rennen.

### 6.4 Wer darf was (Nachrichten je Phase)

| Nachricht | lobby | countdown | racing/finished | results |
|---|---|---|---|---|
| `raceReady {ready}` | ja | – | – | – |
| `raceConfig {track?, botLevel?}` | ja (jeder Mensch, letzte gewinnt, 1 pro s) | – | – | – |
| `raceVote {choice}` | – | – | – | ja |
| `setCar` | ja (sofort, auf dem Startplatz) | nein (wirkt ab der nächsten Lobby) | nein | ja (wirkt in der Lobby) |
| `timeTrialRestart` | nur Zeitfahren, in jeder Phase | | | |
| `joinRoom` | jederzeit (1b-Regeln) | | | |

### 6.5 Instanzwahl (`lobby.ts`)

- **`race`:** zuerst ein Room in `lobby` mit Platz (die meisten Menschen zuerst, wie 1b), dann ein laufender Room mit Platz (Zuschauer bis zum nächsten Start), sonst eine neue Instanz. Die Lobby-Einblendung bietet „START OWN RACE“ an (`joinRoom {kind: 'race', fresh: true}` erzwingt eine neue Instanz). Wer nicht zuschauen will, fährt so sofort.
- **`timetrial`:** immer eine eigene neue Instanz. Sie schließt 60 s nach dem Verlassen (wie 1b).
- `race-1` existiert nicht dauerhaft, nur `party-1`.

---

## 7. Room-Tick im RaceRoom

Die Reihenfolge aus 1b 5.3 bleibt. Der RaceRoom füllt die vorhandenen Erweiterungspunkte, und `Room` bekommt drei kleine neue:

- `protected get world(): SimWorld`: Standard `map.simWorld`, im RaceRoom die Renn-Welt. `stepWorld`, `spawnVehicle` und `placeVehicle` nutzen ihn.
- `protected forceGhost(m, T): boolean`: `true` hält den Kontakt-Ghost-Boden wie bei Idle und Lag. Der Übergang auf `false` setzt `ghostHold` (niemand wird aus einer Überlappung geschleudert, 1b 5.4).
- Der Bot-Zweig in `takeInput` (6.3).

```
RaceRoom.step(T):
    für jedes Mitglied (nach id):
        Input nehmen (Mensch: Puffer/Wiederholung/Stopp · Bot: LineDriver)
        rohes Gas in countdownThrottle[m] merken (nur countdown)
        raceInputFilter(phase, T, startTick, input)      // shared, Abschnitt 12.1
    beforeStep(T):
        T == startTick: Launch-Ergebnis je Fahrer (launch.ts) → Fenster für mods.launch/bogged, Event 'launch'
        mods.launch/bogged aus den Fenstern
        forceGhost: Start-Ghost (T < startTick + 180), Falschfahrer, im Ziel, DNF
    Idle-/Lag-Regeln (1b), stepWorld(Fahrer, raceWorld)   // Windschatten in stepWorld
    afterStep(T):
        je Fahrer: Gate-Test p(T−1) → p(T) (Abschnitt 8), Fortschritt, Falschfahrer, verpasstes Gate
        Zieleinläufe → Event 'finish', ggf. Phase finished
        Phasenwechsel prüfen (Abschnitt 6.1)
        T % RACE_STATUS_EVERY == 0: raceStatus an alle
    T % 2 == 0: Events, Snapshot
```

Den Zustand vor dem Tick (`p(T−1)` für den Gate-Test) merkt sich der RaceRoom pro Fahrer in einem vorallokierten `{x, z}` vor `stepWorld`.

---

## 8. Zeitmessung und Gates (`gates.ts`)

**Kreuzung im Tick:** Das Auto bewegt sich im Tick T von `p0 = p(T−1)` nach `p1 = p(T)` (x, z; y spielt keine Rolle, ein Auto in der Luft über dem Gate zählt). Das Gate-Segment läuft von `a = c + l·w/2` nach `b = c − l·w/2`, mit `l` = links von `yaw`.

```
side(p)  = (p − c) · f                              // f = (sin yaw, cos yaw)
gezählt, wenn side(p0) < 0 ≤ side(p1)              // von hinten nach vorne, genau einmal
t        = side(p0) / (side(p0) − side(p1))        // Anteil im Tick, 0 < t ≤ 1
q        = p0 + t · (p1 − p0)                       // Kreuzungspunkt
innen    : |(q − c) · l| ≤ w/2 + GATE_TOLERANCE
Zeit     = (T − 1 + t − startTick) Ticks           // Float, Sub-Tick-genau
```

- Die Grenzregel `side(p0) < 0 ≤ side(p1)` zählt eine Kreuzung genau in einem Tick, auch wenn das Auto exakt auf der Linie stehen bleibt.
- **Nur das nächste Gate** wird geprüft (5.1). Rückwärts über ein Gate zählt nie. Ein Auto, das über die Start-/Ziellinie zurücksetzt und wieder vorfährt, gewinnt nichts, weil dort nicht das nächste Gate liegt.
- **Tick mit Teleport:** Hat die Sim im Tick einen Reset gemacht (`events.reset`) oder hat der Room das Auto gesetzt (Spawn, Grid), wird für diesen Tick kein Gate geprüft.
- **Rundenzeit** = Differenz zweier aufeinanderfolgender Durchfahrten von `gates[0]`. Runde 1 zählt ab `startTick`. **Zielzeit** = Zeit der letzten Pflicht-Durchfahrt.
- **Anzeige:** Die Zeiten liegen als Float-Ticks vor. Angezeigt werden Millisekunden: `round(ticks · 1000 / 60)`, als `m:ss.mmm`. Gleiche Float-Zeiten sind praktisch ausgeschlossen, bei Gleichstand entscheidet der kleinere Slot.
- Die Sub-Tick-Interpolation ist linear zwischen den Tick-Endpunkten. Die drei Substeps der Sim krümmen den Weg innerhalb eines Ticks um höchstens Millimeter, das ist unter der Anzeigegenauigkeit (1 ms ≈ 5 cm bei 50 m/s).

---

## 9. Fortschritt und Positionen (`progress.ts`, `standings.ts`)

Je Fahrer führt der Server `RaceProgress`: `passed`, `lap`, `lineIndex` (Projektionshinweis), `sLine` (Bogenlänge auf der Linie), `maxSSinceGate`, `gateTimes[]` (Float-Ticks je Durchfahrt), `lapTimes[]`, `bestLap`, `finishTicks | null`, `status` (`racing` | `finished` | `dnf` | `left`), `wrongWay`, `missedGate`.

**Restweg zum nächsten Gate** (E13): `remaining = s(nächstes Gate) − sLine`, auf dem Rundkurs modulo Rundenlänge. Liegt das Auto weiter als `OFF_LINE_DISTANCE` von der Linie entfernt, gilt die Luftlinie zum Gate-Mittelpunkt.

**Sortierschlüssel** (aufsteigend, stabil):

1. Status: `finished` vor `racing` vor `dnf` vor `left`
2. `finished`: `finishTicks` aufsteigend
3. `racing`/`dnf`: `passed` absteigend, dann `remaining` aufsteigend
4. Slot aufsteigend

Die Positionen werden jeden Tick für die Regeln berechnet (8 Autos, trivial) und mit `raceStatus` (5 Hz) verschickt.

**Abstand zum Vordermann** für den Split: Passiert Fahrer X die Durchfahrt k zur Zeit tX, und hat der direkt vor ihm Platzierte Y dieselbe Durchfahrt k bei tY passiert, dann ist `gapAhead = tX − tY`. Das geht im Event `gate` mit. Der Vordermann sieht denselben Wert mit umgekehrtem Vorzeichen als Vorsprung.

---

## 10. Falschfahrer, verpasste Gates, Reset

### 10.1 Falschfahrer

Ein Fahrer wird Falschfahrer, wenn eine der beiden Bedingungen `WRONG_WAY_ENTER_TICKS` lang ununterbrochen gilt:

- Geschwindigkeit ≥ `WRONG_WAY_MIN_SPEED` und `v̂ · t̂ < WRONG_WAY_DOT` (t̂ = Tangente der Ideallinie an der Projektion)
- `sLine` liegt mehr als `WRONG_WAY_BACKTRACK` unter `maxSSinceGate`

Er hört auf, Falschfahrer zu sein, wenn `v̂ · t̂ > 0,3` für `WRONG_WAY_EXIT_TICKS` gilt, oder bei einem Reset. Folgen: Kontakt-Ghost (Abschnitt 11), Banner „WRONG WAY“ und ein Flag im Snapshot (`CAR_RACE_GHOST`). Events `wrongWay {id, on}` gehen an alle, damit die anderen das Auto transparent sehen.

### 10.2 Verpasstes Gate

Liegt `sLine` mehr als `MISSED_GATE_DISTANCE` hinter `s(nächstes Gate)` und ist das Gate nicht gezählt, zeigt der HUD „MISSED CHECKPOINT“, und der Pfeil zeigt zurück. Es gibt keine Strafe, das Auto muss durch das Gate. Der Reset (10.3) setzt es vor das verpasste Gate.

### 10.3 Reset-Pose (`SimWorld.resetPose`)

Der Spieler hält Reset (1a 6.7). Die Sim ruft in der Renn-Welt `world.resetPose(s)` statt `moveToRoad` auf. Die Funktion hängt nur vom Fahrzeugzustand und der Strecke ab, deshalb rechnen Client-Prediction und Server dasselbe, und es gibt keinen Snap:

- globale Projektion der Position auf die Ideallinie (5.4), dort Position auf die Linie, `yaw` = Tangente
- Danach prüft der **Server**, ob die Projektion jenseits des nächsten Gates liegt (Abkürzung über einen parallelen Schenkel). Dann setzt er das Auto 5 m vor das nächste Gate zurück. Das ist selten und korrigiert der nächste Snapshot per Snap (> 4 m, 1b 8.4).
- Der Kontakt-Ghost nach dem Reset ist der bestehende der Sim: `RESET_GHOST_TICKS` (2 s) plus Overlap-Hold (E12).

---

## 11. Anti-Griefing: Ghost-Regeln im Rennen

Alle Fälle nutzen die bestehende Mechanik: `applyContactGhostFloor(car)` pro Tick und beim Ende `ghostHold`, bis keine Überlappung mehr besteht (1b 5.4). Es gibt keinen neuen Ghost-Mechanismus.

| Fall | Dauer | Wer entscheidet | Wie der Client es erfährt | Prediction |
|---|---|---|---|---|
| Startphase | `startTick` bis `startTick + 179` (3 s), alle Fahrer | Regel aus `startTick` | `raceState.startTick` | `raceGhostFloor(phase, t, startTick)` für das eigene Auto und die Autos im Kontakt-Set, identisch |
| Nach Reset | 120 Ticks + Overlap-Hold | Sim (`ghostTicks`) | im Zustand | identisch (Sim) |
| Falschfahrer | solange `wrongWay` | Server | Flag `CAR_RACE_GHOST` | Flag → Boden, wie `CAR_IDLE` in 1b |
| Im Ziel / DNF | bis zum Ende des Rennens | Server | Flag `CAR_RACE_GHOST` | wie oben |
| Schlechte Verbindung | 1b-Regel (RTT > 300 ms oder > 20 % fehlende Inputs über 2 s, Ende nach 5 s gut) | Server | `CAR_LAGGY` | wie 1b |
| Hintergrund, eingefroren, idle | 1b-Regel | Server | `CAR_IDLE` | wie 1b |

**Kontakt bleibt echt:** Außerhalb dieser Fälle rechnet `stepWorld` jeden Kontakt voll, mit den Impulsgrenzen aus 1a (8.2). Die Kontaktstärke im Rennen justiert der Playtest nach (Plan 8.3), der Hebel dafür ist `CONTACT_DV_CAP`.

---

## 12. Countdown, Freeze und Launch-Boost

### 12.1 Freeze (`inputFilter.ts`, Client und Server)

```ts
raceInputFilter(phase, t, startTick, input):
    wenn phase ∈ {lobby, countdown} oder t < startTick:
        input.throttle = 0; input.brake = 0            // kein Bremsen im Stand: sonst Rückwärtsgang nach 8 Ticks
        input.buttons &= BTN_HANDBRAKE                  // Handbremse erlaubt (Optik), kein Boost, Reset, Sprung
    sonst:
        input.buttons &= ~BTN_JUMP                      // E4
```

Das Lenkrad bleibt frei (die Räder drehen sichtbar). Die Prediction wendet genau denselben Filter an. Sonst würde sie im Countdown losfahren und der Server zurückholen.

### 12.2 Launch-Boost (`launch.ts`)

Der Server merkt sich im Countdown das **rohe** Gas jedes Fahrers (vor dem Filter, Ring über 64 Ticks). Der Client nimmt seine eigene Input-Historie. Bei T = S (`startTick`):

- Ist das rohe Gas bei S **nicht** ≥ `LAUNCH_THROTTLE` → `normal`.
- Sonst sei `e` der Tick der letzten steigenden Flanke (< 128 → ≥ 128) bis S, mit durchgehend gehaltenem Gas bis S:
  - `e ≥ S − LAUNCH_WINDOW_TICKS` → **`perfect`**: `mods.launch` für [S, S + 60), Beschleunigung × 1,6
  - `e < S − LAUNCH_WINDOW_TICKS` (zu früh gedrückt und gehalten) → **`early`**: `mods.bogged` für [S, S + 30), Beschleunigung × 0,5 („durchdrehende Räder“)

Das Fenster beginnt 1/3 s vor Grün. Wer den Rhythmus der drei Lichter mitgeht, trifft es. Ein perfekter Start bringt nach 1 s etwa 3–4 m *(Startwert, Messung im Unit-Test)*. Das ist spürbar, aber nicht entscheidend.

Das Event `launch {id, result, tick}` geht an alle (Anzeige „PERFECT START!“ bzw. „TOO EARLY“ und Auspuff-Effekt). Die Prediction rechnet das Ergebnis selbst aus ihrer Historie. Fehlt ein Input, wiederholt der Server den letzten, dann kann das Ergebnis abweichen. Dann korrigiert das Event den `modsFor`-Provider, und der Snapshot korrigiert den Zustand.

---

## 13. Windschatten (`sim/slipstream.ts`)

**Zustand:** `VehicleState.draft` (0..1), ratenbegrenzt. Weil er im Zustand liegt, startet die Reconciliation vom exakten Server-Wert. Abweichungen im Ziel während des Replays (≤ 12 Ticks) wirken wegen der Ratenbegrenzung nur um ≤ 0,2 auf `draft`.

**Ziel pro Tick** (in `stepWorld` vor den Kräften, nur wenn `world.slipstream`): Für Auto A mit `u ≥ DRAFT_MIN_SPEED` und ohne Ghost gilt jedes andere Auto B (ohne Ghost, `u_B ≥ DRAFT_MIN_SPEED`, Kursdifferenz ≤ `DRAFT_HEADING`) mit

```
d = B − A;  along = d · f_A;  lat = |d · l_A|
DRAFT_MIN ≤ along ≤ DRAFT_RANGE  und  lat ≤ 1,2 + 0,05 · along
Stärke = (1 − along / DRAFT_RANGE) · (1 − lat / (1,2 + 0,05 · along))
Ziel   = max über alle B
draft += clamp(Ziel − draft, −DRAFT_FALL·DT, DRAFT_RISE·DT)
```

Die Reihenfolge ist fest: nach id sortiert wie in `stepWorld`. Alle Ziele werden aus den Positionen vom Tick-Anfang berechnet, bevor sich ein Auto bewegt.

**Wirkung** (in `applyModifiers`, das künftig `draft` bekommt): `topSpeed += DRAFT_TOP_ADD · draft`, `accel *= 1 + DRAFT_ACCEL · draft`. In `finishTick` füllt der Windschatten zusätzlich das Boost-Meter mit `DRAFT_FILL · draft · DT`.

Nur den Luftwiderstand zu senken, würde nicht wirken. Der Antrieb deckt unterhalb von vtop den Widerstand ab, damit vtop exakt bleibt (1a 6.4, Schritt 2c). Deshalb hebt der Windschatten die Zielgeschwindigkeit an.

**Prediction:** Im Race-Room nimmt der Client zusätzlich zum Kontakt-Set bis zu 3 Autos in den Predict-Schritt auf, die im Kegel vor ihm fahren (`DRAFT_RANGE + 5 m`), extrapoliert wie die Kontakt-Autos (1b 8.5). `CONTACT_SET_MAX` bleibt bei 6.

**Codec:** `draft` kommt als f64 in den Self-Block. Der Codec-Test iteriert über alle Schlüssel von `createVehicleState()` und erzwingt das. Im Kompakt-Datensatz fehlt `draft`, `decodeRemoteState` setzt 0. Für die Optik (Windlinien) gibt es das Kompakt-Flag `CAR_DRAFTING` (Bit 15, `draft > 0,3`).

---

## 14. Serverseitige Bots (`lineDriver.ts`, `pursuit.ts`)

**Gleiche Sim:** Bots sind normale `SimCar`s in `stepWorld`, mit Kontakt, Windschatten, Launch und Reset. Nur ihr Input entsteht im Server statt im Browser.

**`LineDriver.drive(car, ctx, out)`** pro Tick:

1. Projektion auf die Ideallinie mit Fenster (5.4), plus der Querversatz des Bots (eigene Spur, siehe unten)
2. **Pure Pursuit** auf den Punkt `lookaheadBase + lookaheadTime · u` voraus (gemeinsamer Kern aus `pursuit.ts`: `steerForAngle`, `wrapAngle`)
3. **Geschwindigkeit:** Ziel `speedScale · v(s + Vorschau)` aus dem Klassenprofil. Gas und Bremse regeln das wie `RoadDriver` (0,35 + Fehler/5 bzw. Fehler/6).
4. **Verkehr:** Fährt ein Auto im Korridor ≤ 14 m voraus und langsamer, weicht der Bot auf die Seite mit mehr Platz aus (Querversatz bis ±3 m, in der Kurve nur nach außen). Sonst bremst er. **Bots rammen nie absichtlich.**
5. **Windschatten:** ab Stufe „mittel“ zieht der Bot auf Geraden hinter den Vordermann (Versatz auf dessen Spur), wenn der ≤ 25 m voraus ist.
6. **Boost** auf Geraden (Profil flach für ≥ 60 m), wenn `boostMeter ≥ 0,5`.
7. **Festgefahren:** die bestehende Stuck-Logik (zurücksetzen, nach 2 Versuchen Reset halten), jetzt mit der Reset-Pose der Renn-Welt.
8. **Countdown:** Der Bot gibt Gas in `[S − launchSkill, S]`. Leichte Bots treffen das Fenster selten, schwere oft (geseedet).

**Schwierigkeitsstufen** *(Startwerte)*:

| Stufe | `speedScale` | Vorschau (s) | Linienrauschen | Reaktionsverzug | Boost | Windschatten suchen | Launch perfekt |
|---|---|---|---|---|---|---|---|
| `easy` („leicht“) | 0,82 | 0,55 | ±1,5 m | 12 Ticks | nein | nein | 10 % |
| `medium` (Standard) | 0,92 | 0,45 | ±0,8 m | 6 Ticks | ja | ja | 40 % |
| `hard` („schwer“) | 0,98 | 0,40 | ±0,3 m | 2 Ticks | ja | ja | 80 % |

Das Linienrauschen ist ein geseedeter, langsam driftender Querversatz (Wert-Rauschen mit 3 s Periode), damit die Bots nicht wie ein Zug hintereinander fahren. Der Reaktionsverzug ist ein Ringpuffer der Lenk- und Pedal-Ausgaben. Zufall kommt nur aus `RandomSource` (geseedet pro Room und Rennen), nie aus `Math.random` (Stryker-Stabilität, `CLAUDE.md`).

**Kein Gummiband** in Phase 2. Ob es eins braucht, entscheidet der Playtest. Wenn ja, als ±4 % auf `speedScale` abhängig vom Abstand zum nächsten Menschen, nur bei `easy` und `medium`.

**Kosten:** Ein Bot kostet eine Projektion mit Fenster und ein paar Vergleiche. Budget pro Bot und Tick ≤ 5 µs.

---

## 15. Zeitfahren und Ghosts

### 15.1 Aufzeichnung

Der `TimeTrialRoom` zeichnet ab dem Grid-Spawn pro Tick den **tatsächlich verwendeten** Input auf (nach Wiederholung, Stopp und Filter, 4 B pro Tick), dazu die rohen Gas-Werte des Countdown-Fensters (für das Launch-Ergebnis). Nach dem Zieleinlauf entsteht ein `GhostRun`:

```ts
export interface GhostKey { trackId: TrackId; trackVersion: number; mapVersion: number; simHash: string }
export interface GhostRun {
    key: GhostKey;
    carType: CarClassId; profile: AssistProfile;
    playerKey: string;           // Phase 2: Session-Id; Phase 4: anonymer Geräte-Token (Plan 8.7)
    playerName: string;
    finishTicks: number;         // Float, Sub-Tick
    gateTicks: number[];         // Zeiten je Pflicht-Durchfahrt, für den Split
    spawnToStart: number;        // Ticks vom Grid-Spawn bis startTick
    inputs: Uint8Array;          // 4 B pro Tick ab dem Grid-Spawn
    recordedAt: number;
}
```

`simHash` = FNV-1a über `canonicalStringify` der ausgelieferten Sim-Defaults (`SIM_TUNING_DEFAULTS`, Klassen- und Assist-Defaults, Renn-Konstanten der Sim). Ändert sich die Abstimmung, passen alte Ghosts nicht mehr zum Key und werden nicht mehr angeboten.

### 15.2 Deterministische Nachsimulation (`replay.ts`)

`replayRun(track, run): {finishTicks, gateTicks, poses}` baut eine frische Renn-Welt mit einem Auto, setzt es auf Startplatz 0 (`spawnVehicle`) und spielt die Inputs Tick für Tick ab. Dabei laufen dieselben Funktionen wie im Room: `raceInputFilter`, Launch, `stepWorld` und der Gate-Test. Weil der Server im selben Prozess mit demselben Code rechnet, ist das Ergebnis bitgleich.

- Beim `submit` prüft der Server `replay.finishTicks === run.finishTicks` (exakt). Weicht es ab, ist das ein Bug (der Room hat Zustand, den der Replay nicht kennt), und der Lauf wird verworfen und geloggt. In Phase 4 prüft dieselbe Funktion eingereichte Läufe.
- Nebenbei entsteht die **Pose-Spur**: alle 3 Ticks (20 Hz) `x, z` (i24, 1/4096 m), `y` (i16, 1 cm), `yaw` (u16), `flipAngle` (u8), zusammen 13 B pro Probe. Für 90 s sind das rund 23 kB, als Base64 in JSON rund 31 kB. Sie wird einmal pro Ghost berechnet und beim Ghost im Speicher gehalten.

### 15.3 Speicher (`server/race/ghostStore.ts`)

```ts
export interface GhostStore {
    best(key: GhostKey): GhostRun | null;                       // Streckenrekord (alle Klassen)
    personalBest(key: GhostKey, playerKey: string): GhostRun | null;
    submit(run: GhostRun): { record: boolean; personal: boolean };
    poses(run: GhostRun): Uint8Array;                            // Pose-Spur (zwischengespeichert)
}
export class MemoryGhostStore implements GhostStore { /* Map<keyString, …>, LRU GHOST_PERSONAL_MAX */ }
```

**Vorbereitung SQLite (Phase 4)**, nur als Interface und Schema-Entwurf, in Phase 2 wird nichts davon gebaut:

```sql
CREATE TABLE ghosts (
  id INTEGER PRIMARY KEY, track_id TEXT NOT NULL, track_version INTEGER NOT NULL,
  map_version INTEGER NOT NULL, sim_hash TEXT NOT NULL, car_type TEXT NOT NULL, profile TEXT NOT NULL,
  player_key TEXT NOT NULL, player_name TEXT NOT NULL, finish_ticks REAL NOT NULL,
  gate_ticks TEXT NOT NULL, spawn_to_start INTEGER NOT NULL, inputs BLOB NOT NULL, recorded_at INTEGER NOT NULL
);
CREATE INDEX ghosts_best ON ghosts (track_id, track_version, map_version, sim_hash, finish_ticks);
CREATE INDEX ghosts_player ON ghosts (player_key, track_id, track_version, map_version, sim_hash, finish_ticks);
```

Ein gemeinsamer Vertragstest (`tests/server/ghostStore.contract.ts`) läuft in Phase 2 gegen `MemoryGhostStore` und in Phase 4 unverändert gegen `SqliteGhostStore`.

### 15.4 Wiedergabe

Der Client bekommt beim Countdown `ghostData` (15.2) und spielt die Spur ab `startTick` mit der Hermite-Interpolation aus `shared/net/interpolation.ts` ab. Der Ghost ist ein halbtransparentes Auto seiner Klasse mit dem Schild „GHOST 1:21.345“ und nimmt nicht an der Sim teil. Splits vergleichen die eigenen Gate-Zeiten mit `gateTicks` des Ghosts.

---

## 16. Protokoll v3

`PROTOCOL_VERSION` = 3 (E14). Clients mit Version 2 bekommen `reject {reason: 'version', reload: true}` (1b 3.2).

### 16.1 Binär

| Stelle | Änderung |
|---|---|
| Self-Block | + `draft` (f64) in `SELF_F64` |
| Mod-Bits (Self-Block, u8) | + `MOD_LAUNCH` (32), `MOD_BOGGED` (64) |
| Kompakt-Flags (u16) | + Bit 14 `CAR_RACE_GHOST` (Falschfahrer, im Ziel, DNF), Bit 15 `CAR_DRAFTING` |

Die Kompakt-Datensatzgröße (32 B) bleibt gleich.

### 16.2 JSON C→S (valibot, `ClientMessageSchema`)

- `ROOM_KINDS` = `['party', 'freeroam', 'race', 'timetrial']`. `hello.room` und `joinRoom.kind` gelten damit auch für die neuen Arten.
- `joinRoom {kind, fresh?: boolean, track?: TrackId}`
- `raceReady {ready: boolean}`
- `raceConfig {track?: TrackId, botLevel?: 'easy' | 'medium' | 'hard'}`
- `raceVote {choice: 'rematch' | 'next'}`
- `timeTrialRestart {}`

Alle gehen durch den bestehenden JSON-Token-Bucket (1b 11.7). Nachrichten in der falschen Phase oder im falschen Room werden ignoriert, zählen aber nicht als ungültig (Race-Condition beim Phasenwechsel).

### 16.3 JSON S→C (TS-Typen in `protocol.ts`)

```ts
type RacePhase = 'lobby' | 'countdown' | 'racing' | 'finished' | 'results';
interface RaceStateMsg {
    type: 'raceState';
    mode: 'race' | 'timetrial';
    phase: RacePhase;
    trackId: TrackId; trackVersion: number; trackHash: string;
    laps: number;
    botLevel: 'easy' | 'medium' | 'hard';
    startTick: number | null;       // ab countdown
    phaseEndTick: number | null;    // Lobby-Autostart, dnfTick, Ende der Ergebnisse
    racers: { id: string; grid: number; bot: boolean }[];
    ready: string[];                // Menschen, die bereit sind (lobby)
    votes: { rematch: number; next: number } | null;
}
// 5 Hz im Rennen: Positionen in Reihenfolge
interface RaceStatusMsg { type: 'raceStatus'; tick: number; order: { id: string; passed: number; lap: number; status: RacerStatus }[] }
interface RaceResultsMsg {
    type: 'raceResults'; trackId: TrackId;
    entries: { id: string; name: string; bot: boolean; carType: string; pos: number; status: RacerStatus;
               finishTicks: number | null; bestLapTicks: number | null }[];
    record?: { name: string; finishTicks: number };    // Zeitfahren
    personal?: { finishTicks: number; improved: boolean };
}
interface GhostDataMsg { type: 'ghostData'; kind: 'record' | 'personal'; name: string; carType: string;
                         finishTicks: number; gateTicks: number[]; hz: number; poses: string /* Base64 */ }
```

`roomState` bekommt `race?: RaceStateMsg` (ohne `type`) für Race- und Zeitfahr-Rooms, `MemberInfo` bekommt `bot?: boolean`.

### 16.4 Neue Events (`GameEvent`)

| Event | Felder | Empfänger |
|---|---|---|
| `gate` | `id, passed, gate, lap, tick, time` (Float-Ticks), `gapAhead?`, `lapTime?` | alle |
| `finish` | `id, pos, time` | alle |
| `wrongWay` | `id, on` | alle |
| `launch` | `id, result` (`perfect`/`early`/`normal`), `tick` | alle |
| `raceSpawn` | wie `spawn`, mit `grid` | alle (Grid-Aufstellung, der Client setzt die Prediction zurück) |

**Bandbreite:** Snapshot mit 8 Autos bei 30 Hz ≈ (16 + 158 + 7 · 32) B · 30 ≈ 12 kB/s, `raceStatus` ≈ 0,4 kB · 5 = 2 kB/s, Events < 1 kB/s. Das liegt weit unter dem Budget von 30 kB/s (1b 13.1).

---

## 17. Client

### 17.1 Prediction im Rennen

`Prediction` bekommt die Renn-Welt als `world` (Kollision mit Absperrungen, Reset-Pose, Windschatten) und drei Hooks:

- `filterInput(t, input)` → `raceInputFilter` mit `startTick` aus `raceState`, vor `stepOnce`
- `ghostFloor(t, car)` → `raceGhostFloor` für das eigene Auto und die Remote-Autos im Kontakt-Set, dazu das Flag `CAR_RACE_GHOST` (wie `CAR_IDLE`)
- `modsFor(t, mods)` → Launch-Fenster aus dem lokal berechneten Ergebnis, ersetzt durch das Event `launch`

Beim Streckenwechsel oder bei `raceSpawn` verwirft der Client Historie und Glättung (wie beim Room-Wechsel, 1b 9).

### 17.2 Race-HUD (`raceHud.ts`, DOM wie `hud.ts`)

| Element | Inhalt | Quelle |
|---|---|---|
| Position | „P2/6“ groß oben links | `raceStatus` |
| Runde | „LAP 2/3“ (Sprint: ausgeblendet) | eigenes `gate`-Event, lokal vorab |
| Zeit | „1:23.456“, läuft | `(C − startTick) · DT`, C = eigener Prediction-Tick, damit Zeit und sichtbare Position zusammenpassen; bei jedem `gate` durch die Server-Zeit ersetzt |
| Split | „−0.312“ grün / „+0.418“ rot, 3 s | Rennen: `gapAhead`; Zeitfahren: `gateTicks` des Ghosts |
| Nächstes-Gate-Pfeil | Pfeil oben mittig, relativ zur Kamerablickrichtung, mit Restweg „120 m“ | Strecke + eigene Pose; bei „MISSED CHECKPOINT“ rot |
| Countdown | Startampel (3 rote Lichter, dann Grün) und „3 · 2 · 1 · GO!“ groß mittig | `startTick` gegen die Clock-Schätzung (`serverTickAt`, 1b 3.7) |
| Banner | „PERFECT START!“, „TOO EARLY“, „WRONG WAY“, „FINAL LAP“, „FINISH – P2“ | Events |
| Zuschauer | „SPECTATING – next race after this one“ + „START OWN RACE“ | `raceState` |

Die Lobby-Einblendung zeigt Streckenname und Vorschaubild (Minimap der Strecke), die Fahrerliste mit Bereit-Häkchen, „READY“ groß, Strecke und Bot-Stärke als Segment-Schalter, die Autostart-Zeit, „TIME TRIAL“ (wechselt in den `timetrial`-Room) und die Autowahl. Die Ergebnis-Einblendung zeigt eine Tabelle (Pos, Name, Auto, Zeit, beste Runde, BOT-Tag), „REMATCH“, „NEXT TRACK“ und die verbleibende Zeit. Im Zeitfahren stehen dort Rekord, persönliche Bestzeit und „RETRY“.

Die Party-HUD-Teile (Scoreboard, HP, Munition) sind im Race-Room aus (`body.room-race`, wie `room-freeroam` in 1b 9).

### 17.3 Minimap

Im Race-Room schaltet `minimap.ts` in den Streckenmodus: Norden oben, die Grenzen aus `track.minimap` statt aus der Stadt, die Ideallinie als 3-px-Band, Gates als Querstriche (das nächste hervorgehoben), Start/Ziel kariert, alle Fahrer als Punkte in ihrer Farbe, das eigene Auto als Pfeil, der Ghost als hohler Kreis. Die statische Ebene (Linie, Gates) wird einmal pro Strecke gezeichnet (Muster `staticLayer`).

### 17.4 Gate-Visuals und Streckenausstattung

Der Look folgt [`world-look.md`](world-look.md): realistisch, ruhig, Sonnenuntergang.

- **Start/Ziel-Portal:** Aluminium-Traversenbogen über die ganze Straßenbreite, Banner mit Schachbrettband und „BULLI DRIVE“, darunter eine Startampel mit 5 Leuchten, die den Countdown spiegelt. Auf der Fahrbahn eine karierte Linie als Decal.
- **Checkpoints:** zwei schlanke Masten mit einem gespannten Stoffbanner („CP 3“), an der Unterkante ein LED-Streifen (emissiv, ins Bloom). Das nächste Gate leuchtet warm-weiß und pulsiert langsam. Durchfahrene Gates sind gedimmt, spätere leuchten schwach. Masten und Banner sind reine Optik und stehen auf dem Gehweg (±8 m).
- **Absperrungen:** rot-weiße Wasserbarrieren aus Kunststoff (2 m-Segmente, instanziert), Collider in der Renn-Welt (E3).
- **Pfeiltafeln:** weiß-rote Richtungstafeln auf zwei Pfosten an den Kurvenaußenseiten, Pfosten als Collider (r 0,35 wie die Schilderpfosten).
- **Leitpfosten** am Hill Sprint: weiß mit schwarzem Band und Reflektor, instanziert, nur Optik.
- **Rampen:** R1 als verzinkte Stahlrampe, R2/R3 als Erdrampen mit Holzbohlen-Kante (PBR). Sie sind in allen Modi sichtbar.
- **Sichtweite:** Am Hill Sprint soll das Ziel-Portal aus ~600 m zu sehen sein (Plan: Sichtweite 120–600 m). Die Kamera-`far` und der Höhennebel werden im Race-Room geprüft und bei Bedarf für den Hügelabschnitt angepasst. Tier low: 350 m.
- **Budget:** Die ganze Streckenausstattung kostet höchstens **+20 Draw Calls** und **+30 k Dreiecke**: pro Material ein gemergtes Mesh, Wiederholtes instanziert. Das misst `npm run screenshots` mit einer neuen Ansicht „race-start“.

### 17.5 Mobile-Layout

- **Steuerung im Rennen:** Auto-Gas ist für das Touch-Profil im Rennen standardmäßig an (Plan 8.6). Der Joystick lenkt nur. Rechts liegen die Buttons BRAKE (groß), BOOST, DRIFT und RESET (klein, halten). JUMP ist ausgeblendet (E4). Mit Auto-Gas sendet der Client im Countdown kein Gas. Auto-Gas setzt erst mit einem Tipp auf die GO-Zone (Bildmitte) ein, ohne Tipp einen Tick nach Grün. Ein Tipp im Fenster ist damit ein perfekter Start, kein Tipp ein normaler Start, ein zu früher Tipp ein Frühstart. Der Server wendet unverändert die Regel aus 12.2 an, und der Launch bleibt auch auf dem Handy eine Fähigkeit.
- **HUD kompakt:** Position, Runde und Zeit in einer Zeile oben links, der Split darunter. Die Minimap ist 120 px groß, oben rechts im Querformat und unter der Zeile im Hochformat. Der Nächstes-Gate-Pfeil sitzt oben mittig. Nichts davon überlappt Joystick, Buttons oder den Room-Chip. Das prüft die Render-Messung `touch-hud.spec.ts` für Hoch- und Querformat, auch auf kurzen Quer-Handys (Commit 6dcac3d).
- **Lobby, Ergebnisse:** als Vollbild-Sheet mit Buttons ≥ 48 px, scrollbar. Safe-Area-Insets werden eingehalten.
- Der Countdown steht oben, nicht mittig, damit der Daumen am Gas die Ampel nicht verdeckt.

### 17.6 Modus-Auswahl im Menü

- **Splash:** drei Optionen als Radiogruppe: **PARTY | FREE ROAM | RACE** (bestehende `.mode-option`, Tastatur- und ARIA-Verhalten bleiben).
- **Room-Chip-Panel im Spiel:** PARTY, FREE ROAM, RACE, TIME TRIAL.
- `preferredRoomKind` merkt sich auch `race` und `timetrial`.

---

## 18. Fix: Spawn-Fallback-Kandidaten an der Plaza (`spawn.ts`)

**Befund (Test-Audit, Regressions-Lock in `tests/server/spawn.test.ts`):** Die vier Plaza-Kandidaten des Fallbacks liegen bei `plaza ± 0,7 · halfSize` = ±11,2 m diagonal. Die Pflanzkübel stehen bei ±13 m diagonal. Der Abstand beträgt √2 · 1,8 = 2,55 m und liegt damit unter der Freihaltezone von 1,6 + 2 = 3,6 m. Deshalb bestehen diese Kandidaten `clearsStaticObstacles` nie. Der „defensive“ letzte Ausweg (−8,8 | −8,8) ist selbst einer von ihnen und liegt damit nahe an einem Kübel.

**Fix:** Die Kandidaten wandern auf die **Kantenmitten** der Plaza, im Abstand `d = (SPAWN_FOUNTAIN_CLEARANCE + halfSize) / 2 = (9 + 16) / 2 = 12,5 m` vom Mittelpunkt auf den Achsen: (−32,5 | −20), (−7,5 | −20), (−20 | −32,5), (−20 | −7,5). Handrechnung für (−7,5 | −20):

- Brunnen: 12,5 m ≥ 9 m ✓
- nächster Kübel (−7 | −7): √(0,5² + 13²) = 13,0 m ≥ 3,6 m ✓
- nächster Schirm (−12,46 | −12,46): √(4,96² + 7,54²) = 9,0 m ≥ 2,9 m ✓
- Plaza-Rand: 16 − 12,5 = 3,5 m innerhalb von `halfSize` ✓
- Schilderpfosten „SUNSET PLAZA“ bei (−22,6 | −37,9) und (−17,4 | −37,9) zum nächsten Kandidaten (−20 | −32,5): 5,99 m ✓ (`clearsStaticObstacles` kennt diese Pfosten nicht, deshalb hier von Hand geprüft)

Der letzte Ausweg ist der erste dieser Kandidaten, (−32,5 | −20).

**Test:** Der Regressions-Lock „never takes a plaza corner as a candidate“ wird ersetzt durch „every plaza candidate clears the static obstacles“ (alle vier Punkte von Hand, s. o.) und durch „the last resort clears the planters“. Der Test „returns the fixed last resort“ erwartet (−32,5 | −20). Dazu kommt ein neuer Fall: Gebäude über allen 25 Kreuzungen und ein Auto auf (−7,5 | −20). Erwartet wird der Plaza-Kandidat mit dem größten Abstand, (−32,5 | −20). **Mutationsprobe:** den Faktor der Kandidaten auf 0,7 · halfSize zurücksetzen → der neue Test wird rot.

Folgepunkt, nicht in Phase 2: `clearsStaticObstacles` prüft eine Handliste (Gebäude, Brunnen, Kübel, Schirme) statt der Collider-Liste aus `MapData`. Laternen, Palmen und Schilderpfosten fehlen darin. Eine Prüfung gegen das `SpatialGrid` wäre die dauerhafte Lösung (Abschnitt 24).

---

## 19. Budgets

| Posten | Budget | Messung |
|---|---|---|
| RaceRoom-Tick mit 8 Autos (davon 5 Bots) inkl. Regeln | Mittel ≤ 0,15 ms, p99 < 1 ms (CI < 2 ms) | Bot-Integrationstest (Tick-Histogramm wie 1b) |
| Renn-Regeln (Gates, Fortschritt, Positionen) je Tick | ≤ 0,03 ms | `npm run perf:sim -- --race` (loggt nur) |
| `LineDriver` je Bot und Tick | ≤ 5 µs | ebenda |
| Windschatten in `stepWorld` (8 Autos, O(n²)) | ≤ 0,01 ms | ebenda |
| Downlink pro Client im Rennen | ≤ 16 kB/s | Bot-Test |
| Client: Prediction mit Renn-Welt und bis zu 9 Autos im Predict | wie 1b 13.2 | Overlay `?debug=net` |
| Draw Calls durch die Streckenausstattung | ≤ +20 | `npm run screenshots` |
| Speicher Ghosts | ≤ 5 MB pro Prozess (LRU) | Unit-Test mit Grenzfall |
| E2E-Job gesamt | < 5 min wie bisher | CI-Laufzeit im PR nennen |

---

## 20. Testplan (Pyramide nach `CLAUDE.md`)

Erwartungswerte kommen aus Handrechnung, Geometrie, Physik oder als gekennzeichneter Regressions-Lock, nie aus dem getesteten Code. Jeder neue Test bekommt eine Mutationsprobe (im Commit genannt). Stryker bekommt die Gruppe `race` (`src/shared/race/**`, `src/shared/sim/slipstream.ts`, `src/server/race/**`, `src/server/rooms/RaceRoom.ts`, `src/server/rooms/TimeTrialRoom.ts`) und läuft vor dem Merge gezielt über die neuen Dateien.

### 20.1 Unit (Vitest, `tests/shared/race/*`, `tests/server/*`)

| Datei | Prüft | Erwartung aus |
|---|---|---|
| `gates.test.ts` | Kreuzung von (0,−1) nach (0,2) durch das Gate bei z = 0 → t = 1/3; rückwärts nicht; außerhalb von w/2 + 1 m nicht; genau auf der Linie genau einmal über zwei Ticks; Tick mit Reset nicht | Handrechnung |
| `timing.test.ts` | Zeit = (T − 1 + t − S) Ticks; Rundenzeiten als Differenzen; Anzeige m:ss.mmm (Rundung bei x,5 ms) | Handrechnung |
| `geometry.test.ts` | Verrundung einer 90°-Ecke mit R: Bogenlänge πR/2, Ersparnis (2 − π/2)·R; Resampling-Abstand 2 m ± 1e-9; Projektion zwischen zwei parallelen Schenkeln (52 m) bleibt mit Hinweis auf dem richtigen | Geometrie |
| `racingLine.test.ts` | v ≤ √(μ_eff·g·R) in jedem Bogen; Bremsdurchlauf: v(s) − v(s + ds) ≤ Bremsweg-Grenze; Gerade → vtop | Physik |
| `progress.test.ts`, `standings.test.ts` | Reihenfolge-Tabellen: im Ziel vor fahrend, mehr `passed` vor weniger, weniger Restweg vor mehr, DNF und left hinten, Gleichstand nach Slot; Runde aus `passed` (Rundkurs und Sprint, Grenzfälle `passed` = 0, 1, n, n + 1); `gapAhead` | Hand-Szenarien |
| `wrongWay.test.ts` | Ein 59 Ticks langes Gegenfahren löst nicht aus, 60 Ticks lösen aus; das Ende braucht 30 Ticks; Rückschritt 25 m ohne Wenden löst aus; unter 4 m/s nie | Regeldefinition (Grenzwerte) |
| `launch.test.ts` | Flanke bei S − 20 → perfect, bei S − 21 → early, kein Gas bei S → normal, Flanke bei S → perfect, zwischendurch losgelassen → neue Flanke zählt | Regeldefinition |
| `inputFilter.test.ts` | Im Countdown bleibt ein Auto 240 Ticks mit Gas und Bremse gedrückt stehen (auch kein Rückwärtsgang); Handbremse bleibt, Sprung im Rennen weg; Start-Ghost genau 180 Ticks | Physik (Stillstand) und Regel |
| `slipstream.test.ts` | Ziel-Geometrie (Kegelgrenzen, Kurs 21° → 0); Ratenbegrenzung; zwei Autos gleicher Klasse auf einer Geraden: der Hintermann (15 m) erreicht mehr als vtop + 2 m/s, allein genau vtop (± 0,01); ohne `world.slipstream` ändert sich nichts; **alle bestehenden Goldens bleiben bitgleich** | Physik und Regressions-Lock |
| `modifiers.test.ts` (erweitert) | launch ×1,6, bogged ×0,5 auf `accel`, draft auf `topSpeed` | Definition |
| `rampBase.test.ts` | Rampe auf schiefem Testgelände: Fläche an der Hinterkante = Gelände; Kantenwand-`top` = Rampenhöhe über dem Gelände an der Wand; ebene Sandbox unverändert | Handrechnung |
| `tracks.test.ts` (Datentest) | Für beide Strecken: Gates liegen in der Reihenfolge der Linie (s streng steigend); Gate-`yaw` weicht ≤ 20° von der Tangente ab; ≥ 8 Startplätze hinter `gates[0]`, gegenseitig ≥ 6 m, auf der Straße (`isOnRoad` bzw. Korridor), ≥ 2 m von Collidern; die Ideallinie hält ≥ 2,5 m Abstand zu allen Collidern der Renn-Welt; Steigung entlang der Linie ≤ 25 % außer auf Rampen; Hill-Sprint-Rampen: effektive Kante ≥ 1,2 m, Hinterkante bündig (≤ 0,05 m); Ziel am lokalen Hochpunkt (≥ 13 m, 20 m ringsum niedriger); Stadt-Gates frei von Kreuzungen | unabhängige Geometrie- und Welt-Bedingungen |
| `lineDriver.test.ts` | Ein Bot `medium` im Bulli fährt in Node auf der Renn-Welt eine Downtown-Runde ohne Reset in 24–40 s und einen Hill Sprint in 20–40 s; er weicht nie mehr als 8 m von der Linie ab; `hard` ist schneller als `medium`, `medium` schneller als `easy` (Mittel über 3 Seeds); feste Seeds | Grenzen aus Linienlänge / (vtop bzw. Kurvengeschwindigkeit); Ordnung statt exakter Werte |
| `replay.test.ts` | Ein im `TimeTrialRoom` mit geskripteten Inputs gefahrener Lauf wird von `replayRun` bitgleich reproduziert (Zielzeit, Gate-Zeiten, Endzustand `statesEqual`); ein geänderter Input-Tick ändert das Ergebnis | Zwei unabhängige Pfade (Room gegen Replay) |
| `ghostTrack.test.ts` | Kodieren/Dekodieren innerhalb der Quantisierung (x, z ± 1/8192 m, y ± 0,5 cm, yaw ± π/65536) | Quantisierungsgrenzen |
| `ghostStore.contract.ts` + `memoryGhostStore.test.ts` | Bestzeit ersetzt nur bei kleinerer Zeit; persönliche Bestzeit je `playerKey`; anderer `simHash` → kein Treffer; LRU verdrängt die älteste | Definition |
| `raceRoom.test.ts` | Mit Fake-Sessions und Tick-Schleife (wie `partyRoom.test.ts`): lobby → countdown nach 60 Ticks bei allen bereit bzw. 900 Ticks bei einem von zweien; Bots füllen auf 6 und gehen in der Lobby wieder; `startTick` = T0 + 240; Freeze (kein Auto bewegt sich vor S); zwei überlappende Autos trennen sich im Start-Ghost nicht und danach ohne Wegschleudern; `finished` → `results` genau bei T1 + 1800 mit DNF; alle Menschen im Ziel beenden früher; Abstimmung (Mehrheit, Gleichstand → next); später Beitritt = Zuschauer; alle Menschen weg → Bots weg, Room leer, `sweep` schließt; Falschfahrer-Flag im Snapshot; Reset landet auf der Linie vor dem nächsten Gate | Regeln (Tick-Zahlen) |
| `lobby.test.ts` (erweitert) | Instanzwahl `race` (Lobby vor laufendem, `fresh` neu), `timetrial` immer neu, Bots zählen nicht | Regeln |
| `protocol.test.ts`, `codec.test.ts` (erweitert) | neue Schemas nehmen Gültiges an und weisen Ungültiges ab; `draft` im Self-Block (Schlüssel-Iteration); neue Bits | Definition |
| `spawn.test.ts` | Abschnitt 18 | Handrechnung |

Lange Läufe (`lineDriver` mit ganzen Runden, `replay`) bekommen ein explizites Timeout und stehen in `tests/mutation/strykerSetup.ts`, wenn Stryker sie überspringen soll. Ziel: der ganze Unit-Lauf bleibt unter 15 s lokal.

### 20.2 Integration mit Bots (`tests/integration/race.test.ts`, echter Server-Prozess)

- **Bot-Rennen mit Kontakt (Exit-Kriterium):** 2 WebSocket-Bots (`tools/bots/bot.ts`, Modus `race`) treten einem Race-Room bei und melden sich bereit. Der Server füllt mit 4 Bots `medium` auf. Strecke Hill Sprint, damit der Lauf kurz bleibt (`raceConfig`). Nach dem Start-Ghost lenkt Bot A 1 s lang gezielt in Bot B (auf dem Grid nebeneinander). Geprüft wird: Beide sehen ein `contact`-Event. Beide WebSocket-Bots und mindestens 3 Server-Bots kommen ins Ziel. `raceResults` kommt bei beiden an, mit identischer Reihenfolge und Zeiten zwischen 20 und 60 s. Die Positionen in `raceStatus` passen zum Endergebnis. Der Tick bleibt im Budget (19). Der Test läuft einmal, mit Netsim 150/30/3 vor beiden WebSocket-Bots; ein zweiter Lauf ohne Netsim ist nicht nötig, weil die Netzschicht aus 1b unverändert und dort schon ohne Netsim getestet ist.
- **Manipulierte Clients im Rennen:** Ein Bot sendet im Countdown Gas mit Inputs aus der Zukunft (Tick + 100) und ungültige Werte. Sein Auto bewegt sich vor S nicht, die anderen Bots merken nichts (Tick, Positionen). Flut-Kick wie 1b.
- **Zeitfahren:** Ein Bot (`timetrial`) fährt den Hill Sprint und kommt ins Ziel. Ein zweiter Beitritt derselben Session (Reload innerhalb der Grace) bekommt beim nächsten Countdown `ghostData` mit genau dieser Zeit.
- **Laufzeit:** ≤ 90 s zusätzlich. Der ganze Bot-Job bleibt unter 5 min, das Ergebnis steht im PR.

### 20.3 E2E (Playwright, genau ein neuer Test)

`tests/e2e/race.spec.ts`, **nur im Projekt `mobile`** (Touch; der Tastaturweg ist durch die bestehenden Desktop-Tests und dieselbe UI abgedeckt):

1. Splash → RACE wählen → START
2. Lobby: Hill Sprint wählen, READY tippen → Countdown sichtbar (Ampel), dann „GO!“
3. Nach dem Start setzt `debugPlace` (E2E=1) das Auto 30 m vor das Ziel-Gate, der Test hält Gas bis zum Zieleinlauf
4. HUD zeigt Position, Zeit und dann „FINISH“. Die Ergebnis-Einblendung erscheint mit dem eigenen Namen und REMATCH/NEXT TRACK. REMATCH tippen → Lobby.

`debugPlace` setzt das Auto per Teleport, und der Gate-Test ignoriert diesen Tick (8). Damit das Rennen trotzdem endet, setzt `debugPlace` in einem Race-Room den Fortschritt auf die Projektion des Zielpunkts auf die Ideallinie: Alle Gates davor gelten als passiert (ohne Zeiten). Das gibt es nur im E2E-Server (`E2E=1`), wie `debugPlace` selbst. Zielzeit für den Test: ≤ 40 s.

Die Überlappungsfreiheit des Touch-HUD prüft `tests/e2e-render/touch-hud.spec.ts` (Render-Job, nicht der E2E-Job), dort um den Race-HUD im Hoch- und Querformat erweitert.

---

## 21. Exit-Kriterien (aus dem Plan, präzisiert)

- [ ] Bot-Rennen mit Kontakt in der CI grün (20.2)
- [ ] Manipulierte Clients (Input-Flut, Inputs aus der Zukunft, ungültige Werte) werden verworfen, ohne andere zu stören, auch im Countdown (20.2)
- [ ] Beide Strecken bestehen den Datentest (20.1). Ein Bot `medium` fährt beide ohne Reset.
- [ ] Zeitfahren: Ghost wird aufgezeichnet, bitgleich nachsimuliert und abgespielt
- [ ] Race-HUD, Lobby und Ergebnisse auf dem Handy ohne Überlappung (Render-Messung), E2E grün
- [ ] RaceRoom-Tick und Downlink im Budget (19)
- [ ] Party und Free Roam unverändert spielbar (bestehende E2E- und Bot-Tests grün, Goldens bitgleich)
- [ ] Playtest: mindestens 70 % der Tester wollen gleich noch ein Rennen fahren, auf Desktop und Handy. Das bleibt offen, bis der Nutzer testet, und blockiert den Merge nicht (wie der Blindtest in 1a).

---

## 22. Umsetzungsreihenfolge

Jeder Schritt ist ein Commit (oder wenige), nach dem das Spiel spielbar bleibt. Der PR wird am Ende gesquasht.

1. **Spawn-Fix** (18) mit Test
2. **`shared/race`-Kern:** Typen, Geometrie, Ideallinie, Gates, Fortschritt, Positionen, Falschfahrer, Launch, Filter, beide Strecken als Daten, Datentest. Das Verhalten des Spiels ändert sich nicht.
3. **Sim:** `draft`, Windschatten, Launch-/Bogged-Mods, `SimWorld.resetPose`/`slipstream`, Rampenbasis. Goldens bitgleich. Protokoll v3 (Codec, Bits).
4. **Karte:** `MAP_RAMPS`, Hügelstraße, `MAP_VERSION` 3, Rampen- und Straßenoptik im Client (in Free Roam sichtbar und fahrbar)
5. **`RaceRoom`** mit Phasen, Freeze, Gates, Zeiten, Ergebnissen (nur Menschen). Protokoll-Nachrichten, `ROOM_KINDS`, Instanzwahl, Menü „RACE“, minimaler Race-HUD. Damit ist das Rennen spielbar.
6. **Server-Bots:** `pursuit.ts` herauslösen, `LineDriver`, Stufen, Auffüllen, `BotSession`, `humanCount`
7. **Anti-Griefing** komplett (Start-Ghost, Falschfahrer, im Ziel), Reset-Pose, Launch- und Windschatten-Anzeige
8. **Zeitfahren:** `TimeTrialRoom`, `GhostStore`, Replay, Pose-Spur, `GhostCar`
9. **Visuals und Mobile:** Gate-Portal und -Bögen, Ampel, Absperrungen, Pfeiltafeln, Leitpfosten, Minimap-Streckenmodus, Mobile-Layout, Lobby und Ergebnisse
10. **Integration und E2E:** Bot-Modus `race`/`timetrial`, `race.test.ts`, `race.spec.ts`, Render-Messung, Budgets messen, Doku-Abschnitt 25 ausfüllen, `refactor-plan.md` aktualisieren

---

## 23. Risiken

| Risiko | Gegenmaßnahme |
|---|---|
| Prediction und Server weichen im Countdown oder beim Start ab (Freeze, Launch, Ghost) | Alle Renn-Regeln, die den Zustand betreffen, liegen als reine Funktionen in `shared/race` und laufen auf beiden Seiten. Launch und Ghost sind Fenster, die aus `startTick` folgen. |
| Windschatten erzeugt ständige kleine Korrekturen | `draft` im Zustand und ratenbegrenzt, Windschatten-Quellen im Predict-Set, Messwert „Korrektur pro Snapshot“ im Overlay |
| Bots fahren sich in der Stadt fest oder bilden einen Zug | Ideallinie mit Freiraum-Test, Linienrauschen, Ausweichen, Stuck-Logik mit Reset-Pose, Node-Test über ganze Runden |
| Leere Race-Rooms, Wartezeit als Zuschauer | Ab 1 Spieler mit Bots, „START OWN RACE“, Zeitfahren |
| Rempeln am Start oder in der ersten Kurve ruiniert Rennen | 3 s Start-Ghost, Overlap-Hold, Impulsgrenzen; Playtest-Hebel `CONTACT_DV_CAP` |
| Hill Sprint zu kurz oder zu flach | Rampen- und Streckenwerte sind Startwerte, der Datentest erlaubt Änderungen, `trackVersion` hält Ghosts sauber |
| E2E-Job überschreitet 5 min | nur ein neuer Test, Teleport vor das Ziel, Messung im PR |
| Ghost-Replay nicht bitgleich (versteckter Room-Zustand) | Replay-Test gegen den echten Room, Prüfung bei jedem `submit` mit Log |

---

## 24. Nicht Teil von Phase 2

- Persistenz (SQLite), Bestenlisten, Geräte-Token (Phase 4; hier nur Interface und Schema)
- Event-Marker in der offenen Welt, Umkreis-Einladungen (Phase 4)
- Strecken auf der kuratierten Map, `routeToTrack` (Phase 3)
- Gummiband für Bots (nur nach Playtest)
- `clearsStaticObstacles` gegen die volle Collider-Liste (Folgepunkt aus 18)
- Spatial Audio für Countdown und Windschatten (Phase 5; in Phase 2 nur die vorhandenen Sounds)

---

## 25. Umsetzung: Abweichungen und Stand

*Wird während der Umsetzung gefüllt: Abweichungen von dieser Spezifikation mit Grund, gemessene Werte (Budgets aus 19, Laufzeiten der Test-Ebenen, Draw Calls), Ergebnisse der Mutationsläufe und die im Playtest angepassten Startwerte.*

### 25.1 Schritte 2 und 3: Renn-Kern und Sim (`src/shared/race`, Windschatten, Launch)

**Abweichungen:**

| Stelle | Spezifikation | Umgesetzt | Grund |
|---|---|---|---|
| Downtown Loop, `lineOptions` (5.2) | R 24 m, Versatz 4 m | **R 19 m, Versatz 0** | An den inneren Kreuzungsecken stehen Laternen (8,1 m von der Kreuzungsmitte, r 0,7). Mit Versatz 0 hält die Linie 2,5 m Abstand nur bis R ≈ 19,9 m (gemessen: R 20 → 2,47 m, R 24 → 0,81 m). Jeder Versatz nach innen verschärft das. Runde 767 m statt ~750 m. |
| Außen-innen-außen (5.4) | Versatz bis `apexShift` | als seitlicher Versatz umgesetzt und getestet, **auf beiden Strecken 0** | Der Versatz verkleinert zwar die Krümmung im Scheitel, erhöht sie aber am Einlenkpunkt (R 16 m mit 1,5 m Versatz: kleinster Radius 7,9 m). Eine echte Ideallinie mit größerem Radius passt in der Stadt nicht zwischen die Laternen. |
| Hill Sprint, Mittellinie (5.3) | beginnt am Start (58,64) | **beginnt bei (58,104)** | Die Startplätze liegen hinter dem Start. Ohne Linie dahinter projizieren alle auf s = 0 und die Positionen am Start hängen am 25-m-Grenzwert der Luftlinie. |
| Hill Sprint, Start-Gate und Grid (5.3) | G0 (58,64), Grid z 70–98 | **G0 (58,66), Grid z 72–100** | z = 64 ist genau die Kante der Kreuzung (58,58). Der Datentest verlangt 2 m Abstand zu jeder Kreuzung. Der letzte Startplatz liegt 4 m vor der Kreuzung (58,110). |
| Freeze (12.1) | Lenkung bleibt frei | **Lenkung ebenfalls 0** | In der Sim schieben eingeschlagene Vorderräder ein stehendes Auto: gemessen 1,5 m in 240 Ticks. Die Räder drehen im Countdown deshalb nicht sichtbar mit. |
| Falschfahrer (10.1) | Ende nach 30 Ticks v̂·t̂ > 0,3 | zusätzlich **≥ 4 m/s**; das Ende setzt das Rückschritt-Maximum auf die aktuelle Stelle | Bei Stillstand ist v̂ nicht definiert. Ohne Neustart des Maximums würde ein Auto, das gewendet hat und noch 25 m hinter seinem weitesten Punkt liegt, sofort wieder Falschfahrer. |
| `maxSSinceGate` (9) | Bogenlänge | als **Fortschritt seit dem letzten Gate** (m) | Auf dem Rundkurs springt `sLine` an der Naht von L auf 0; der Fortschritt seit dem Gate nicht. |
| Globale Projektion mit Erwartung (5.4) | „kleinste Abweichung vom Fortschritt" | Kandidaten sind die **lokalen Minima** des Abstands innerhalb von 25 m | Sonst gewinnt irgendein Punkt im 25-m-Kreis, der zufällig näher an der Erwartung liegt, statt des nächsten Punkts des richtigen Schenkels. |
| Start-Ghost (11) | S bis S + 179 | `raceGhostFloor` nur in `racing`/`finished` | Im Countdown sind alle eingefroren; die Grid-Plätze liegen ≥ 6 m auseinander. |
| Protokoll v3 (16.1) | Schritt 3 | **in diesem Schritt**, nur der Binärteil (`draft` im Self-Block, `MOD_LAUNCH`/`MOD_BOGGED`, `CAR_RACE_GHOST`/`CAR_DRAFTING`) | `draft` liegt im Zustand, der Codec-Test erzwingt jeden Zustandsschlüssel im Self-Block. JSON-Nachrichten kommen mit dem RaceRoom. |
| Rampen in der Karte (5.5) | `MAP_VERSION` 3 | `MAP_RAMPS` und `HILL_ROAD` liegen in `world/mapFeatures.ts`, die Rampenbasis ist umgestellt; **`createRaceWorld` fügt die Rampen selbst hinzu**, `MAP_VERSION` bleibt 2 | Ohne Rampen-Optik im Client wären es unsichtbare Wände in Free Roam und Party. Schritt 4 nimmt sie mit der Optik in `MapData` auf; dann darf `createRaceWorld` sie nicht noch einmal anhängen. Die Strecken tragen schon `mapVersion` 3 (`MAP_VERSION_FOR_RACES`). |

**Goldens:** Mit `VehicleState.draft` bekommt jeder Golden-Frame das Feld `"draft": 0`. Neu erzeugt mit `UPDATE_GOLDEN=1`; der Diff enthält ausschließlich diese Zeilen (und das Komma davor). Alle anderen Werte und `golden-tuning.json` sind unverändert, die Windschatten-Konstanten liegen in `race/rules.ts`, nicht in `SIM_TUNING`.

**Gemessen (Datentest `tests/shared/race/tracks.test.ts`):**

| | Downtown Loop | Hill Sprint |
|---|---|---|
| Länge der Ideallinie | 767 m | 732 m (davon 38 m hinter dem Start) |
| kleinster Abstand Linie–Collider | 2,89 m (Laterne) | 6,70 m (Absperrung an der ersten Kreuzung) |
| größte Steigung außerhalb der Rampen | 0 % | 11,6 % |
| Absperrungen | 19 Reihen | 8 Reihen (4 Kreuzungen) |
| Rampenkante über Gelände | – | R1 1,60 m, R2 1,81 m, R3 1,58 m |
| Ziel | – | 13,77 m, im 20-m-Ring höchstens 13,58 m |

**Mutationslauf** (`MUTATION_GROUP=race`, neue Gruppe in `stryker.config.mjs` und im Workflow): 90 % gesamt; `gates.ts` und `inputFilter.ts` 100 %, `standings.ts` 98 %, `launch.ts` 96 %, `racingLine.ts` 91 %, `slipstream.ts` 91 %, `raceWorld.ts` 90 %, `geometry.ts` und `progress.ts` 87 %. Die Überlebenden sind überwiegend äquivalent: Grenzen `<` gegen `<=` auf Floats, die Größe der Scratch-Puffer, Schutzabfragen, die ein anderer Zweig schon abfängt, und die Fehlertexte. Die Streckendaten selbst (`tracks/*.ts`) laufen beim Laden und zählen für Stryker als statisch; sie prüft der Datentest.


### 25.2 Schritte 1, 5 bis 8 (Server) und der Bot-Test aus 10: RaceRoom, Bots, Zeitfahren, Spawn-Fix

**Umgesetzt:** Spawn-Fix (18), `RaceRoom` mit allen Phasen, Freeze, Launch, Gates, Positionen, Falschfahrer, Reset-Prüfung, DNF, Ergebnissen und Abstimmung; Anti-Griefing über `Room.forceGhost`; Server-Bots (`BotSession`, `LineDriver` mit drei Stufen, `pursuit.ts`); `TimeTrialRoom` mit Aufzeichnung, bitgleicher Nachsimulation (`replay.ts`), Pose-Spur (`ghostTrack.ts`) und `GhostStore`; Protokoll v3 JSON (16.2, 16.3); Instanzwahl (6.5); die Prediction-Hooks `filterInput` und `ghostFloor` (17.1); die Bot-Modi `race` und `timetrial` und `tests/integration/race.test.ts`. Der Browser (Menü, HUD, Lobby, Ergebnisse, Ghost-Auto, Launch-Mods in der Prediction) folgt in Schritt 9; bis dahin kommt kein Browser in einen Race-Room (das Menü bietet ihn noch nicht an).

**Abweichungen:**

| Stelle | Spezifikation | Umgesetzt | Grund |
|---|---|---|---|
| Event `raceSpawn` (16.4) | eigenes Event | **`spawn` mit `grid?`** | Dasselbe wie `spawn`; Client und Bots setzen die Prediction damit schon zurück. Ein zweiter Typ hätte jeden Empfänger doppelt verzweigt. |
| Zuschauer | – | neues Event **`despawn {id, tick}`** | Wer beim Countdown nicht bereit ist, verliert sein Auto; der eigene Client muss die Prediction anhalten (wie bei `killed`). |
| Zeitformel (8) | `T − 1 + t − S` | **`(T − 1 − S) + t`** | Gleiche Mathematik, aber die ganzen Ticks zuerst: Sonst hängen die letzten Bits vom Stand der Room-Uhr ab, und der Replay (zählt ab 0) wich um 1 ulp ab (im Test gefunden: 1651,2848471032878 gegen …288). |
| Aufzeichnung (15.1) | Input nach Filter + rohes Gas des Countdowns | **Input nach Wiederholung und Stopp, vor dem Renn-Filter** | Der Replay wendet `raceInputFilter` und den Launch selbst an; eine Spur statt zwei, dasselbe Ergebnis. |
| Ghost-Speicher (15.3) | Pose-Spur beim Ghost | **LRU der letzten 16 Pose-Spuren** | Grenzfall 2 Strecken · 64 Bestzeiten · 100 s: Inputs 3,07 MB; mit allen Pose-Spuren wären es 6,4 MB, mit dem LRU 3,49 MB (Budget 5 MB, Unit-Test). |
| Bot-Verkehr (14) | Korridor ≤ 14 m | **max(14 m, 2 s · Annäherungsgeschwindigkeit)**, Spurwechsel 6 m/s, unter 8 m zählt jedes Auto im Korridor | Mit 14 m prallt ein Bot mit 25 m/s auf ein stehendes Auto, bevor er 3 m versetzt hat (Unit-Test). |
| Bot-Rettung | Stuck-Logik | zusätzlich **Reset bei verpasstem Gate** und nach **2 s mehr als 25 m neben der Linie** | Ein Bot, der nach einem Rempler neben einem Gate vorbeirutschte, fuhr sonst ohne Wertung bis ans Linienende (im Room-Test gefunden). |
| Bot-Reaktionsverzug | Ringpuffer | im Countdown **mit dem Countdown-Gas gefüllt** | Sonst lässt ein Bot mit 12 Ticks Verzug bei Grün 12 Ticks lang das Gas los, und kein Bot kam je zum perfekten Start. |
| Bot-Klassen | aus Seed | alle fünf Klassen | – |
| Zeitfahren nach den Ergebnissen | – | Strecke bleibt ohne Stimme für `next` | Im Zeitfahren wechselt die Strecke nur auf Wunsch. |
| Integrationstest (20.2) | 2 WebSocket-Bots + 4 Server-Bots, ≥ 3 Server-Bots im Ziel | **4 WebSocket-Bots + 2 Server-Bots** (Vorgabe der Aufgabe); alle Spieler im Ziel, mindestens ein Server-Bot, DNF nur hinter allen Zielankünften | Mit vier Spielern ist der Test näher am Netzcode; ein Server-Bot, der nach dem letzten Spieler noch fährt, ist nach 6.1 DNF. |
| `raceResults` | – | die letzten `finish`-Events gehen **vor** `raceStatus` und `raceResults` raus (`Room.flushEventsNow`) | Sonst kam das Ergebnis vor dem Zieleinlauf des Letzten an (im Bot-Test gefunden). |
| Offene Linie | – | `writeProjection` wickelt `s` nur auf dem Rundkurs | Am Ende einer offenen Linie sprang `s` von der Länge auf 0 (im Test von `pointAt` gefunden). |

**Gemessen:**

| | Wert | Budget |
|---|---|---|
| Bot-Rennen Hill Sprint, 4 WebSocket-Bots (Netsim 150/30/3) + 2 Server-Bots | 37 s, Zeiten 23–31 s, Downlink 12,7 kB/s je Client, Tick p99 0,8 ms (lokal) | Downlink ≤ 16 kB/s, p99 < 2 ms |
| Zeitfahren im Bot-Test (Lauf, Reload, Ghost) | 28 s | – |
| `race.test.ts` gesamt | 66 s | ≤ 90 s |
| Unit-Lauf gesamt (96 Dateien, 1300 Tests) | 4,4 s | < 15 s |
| RaceRoom-Unit-Tests (20) / Zeitfahren (5) | 0,3 s / 0,2 s | – |
| `LineDriver` `medium`, Bulli allein | Downtown-Runde 34 s, Hill Sprint 25,6 s, ≤ 5,4 m neben der Linie, kein Reset | 24–40 s bzw. 20–40 s, ≤ 8 m |

**Mutationslauf** (`MUTATION_GROUP=race`, die Gruppe umfasst jetzt auch `src/server/race/**`, `RaceRoom.ts` und `TimeTrialRoom.ts`): 84 % gesamt; `botRoster.ts` 96 %, `pursuit.ts` 87 %, `ghostTrack.ts` 90 %, `ghostStore.ts` 85 %, `RaceRoom.ts` 82 %, `replay.ts` 82 %, `TimeTrialRoom.ts` 75 %, `lineDriver.ts` 60 %. Die Überlebenden in den Rooms sind überwiegend äquivalent: Aufräumen von Maps, die ein späterer Schritt ohnehin leert, Schutzabfragen (`!m || !car`), die ein anderer Zweig schon abfängt, Anfangswerte (`-1`), die vor der ersten Nutzung überschrieben werden, das Gate-Modulo des Rundkurses (kein Room-Test fährt eine zweite Runde; `progress.ts` testet die Runden), und der Log-Text eines verworfenen Laufs. Beim `LineDriver` überleben vor allem die Stellgrößen der Heuristik (Pedalregler, Vorschau, Knoten des Linienrauschens, Kurvenregel beim Ausweichen): Sie verschieben Rundenzeiten innerhalb der getesteten Grenzen, ohne dass sich ein prüfbarer Vertrag ändert; die Verträge (Linie, Zeiten, Stufen-Reihenfolge, Ausweichen, Windschatten-Spur, Reset, Launch-Anteile, Deckel der Geschwindigkeit) sind getestet. Der Reset-Check im Replay ist nur durch den Unit-Test von `resetBeforeNextGate` und die Gleichheit von Room und Replay abgedeckt, nicht durch einen Lauf, der ihn auslöst.

### 25.3 Schritte 9 und 10 (Client): Menü, Race-HUD, Lobby und Ergebnisse, Streckenausstattung, Ghost, Minimap, Mobile, E2E

**Umgesetzt:** RACE auf dem Splash und RACE/TIME TRIAL im Room-Chip-Menü (17.6); `src/client/race`: `raceModel.ts` (Nachrichten und Events → Ansichten, ohne DOM), `raceUi.ts` (HUD, Lobby-, Ergebnis- und Zuschauer-Einblendung, Taps → Nachrichten), `RaceClient.ts` (Renn-Welt für Prediction und `LocalVehicle`, die Hooks `filterInput`, `ghostFloor` und `modsFor` mit dem Launch, Touch-Auto-Gas, Zuschauerkamera), `TrackDressing.ts` (Start/Ziel-Portal mit Startampel, Checkpoints mit Banner und LED-Streifen, Wasserbarrieren, Pfeiltafeln, Leitpfosten, Pfeile und Startplatzmarken; Rampen und Hügelstraße), `GhostCar.ts` und `ghostPlayback.ts` (Zeitfahr-Ghost), `trackLayout.ts` und `trackMap.ts` (Platzierung und Streckenkarte, ohne three). Die Minimap hat den Streckenmodus (17.3). Die Prediction behandelt `CAR_RACE_GHOST` wie `CAR_IDLE` (eigenes Auto und Kontakt-Set, 11), entfernte Autos mit dem Flag sehen wie ein Ghost aus. Bots tragen „BOT“ am Namensschild. Das Event `despawn` blendet das Auto aus. Der E2E-Test `tests/e2e/race.mobile.spec.ts` (20.3), die Render-Messung des Race-HUD in `tests/e2e-render/touch-hud.spec.ts` und die Renn-Ansichten in `npm run screenshots`.

**Abweichungen:**

| Stelle | Spezifikation | Umgesetzt | Grund |
|---|---|---|---|
| Race-HUD auf dem Handy (17.5) | Zeile oben links, Minimap 120 px oben rechts (quer) bzw. unter der Zeile (hoch) | Die **Renn-Pille nimmt den Platz der Party-Punkte-Pille** ein (dieselben CSS-Regeln in allen Breakpoints, die Party-Pille ist im Rennen aus), die **Minimap bleibt auf dem Radarplatz** oben links | Diese Plätze sind schon in acht Viewports vermessen (Commit 6dcac3d). Die Render-Messung prüft jetzt auch das Race-HUD samt Countdown, Banner und GO-Zone gegen Steuerung, Pille, Karte und Room-Chip. |
| Nächstes-Gate-Pfeil (17.2) | oben mittig | **in der Renn-Pille**, rechts, mit Restweg | Oben mittig liegt auf dem Handy der Boost-Balken; in der Pille braucht der Pfeil keinen eigenen Platz. |
| Countdown-Uhr (17.2) | `startTick` gegen `serverTickAt` | gegen den **Render-Tick der eigenen Prediction** (C − 1 + α) | Die Inputs tragen den Tick C. Nur so fällt ein Druck bei Grün auf der Anzeige auch beim Server ins Launch-Fenster. |
| Runde (17.2) | eigenes `gate`-Event, lokal vorab | nur aus dem **`gate`-Event** des Servers | Das Event kommt eine halbe RTT später. Eine lokale Vorab-Zählung müsste Replays und Korrekturen zurücknehmen; Zeit und Split kommen ohnehin vom Server. |
| Split im Rennen (17.2) | grün „−0.312“ / rot „+0.418“ | Rennen: **Abstand zum Vordermann** aus `gapAhead`, immer rot „+“, der Führende sieht keinen; grün nur im Zeitfahren gegen die `gateTicks` des Ghosts | Der Server schickt nur `gapAhead`. |
| Ergebnis-Einblendung | mit `raceResults` | **2 s nach dem eigenen Zieleinlauf** (ohne eigenen Zieleinlauf sofort) | Mit einem Menschen im Rennen beginnt `results` im Tick des Zieleinlaufs; sonst sähe man „FINISH – P2“ und das Auto über der Linie nie. |
| Touch im Rennen (17.5) | Joystick lenkt nur; BRAKE groß, BOOST, DRIFT, RESET klein; JUMP aus | Joystick lenkt nur (mit Auto-Gas **aus** gibt der Stick nach vorn Gas), **BRAKE im Platz des Schießen-Buttons**, der Sprung-Button zeigt das Reset-Symbol und **setzt gehalten zurück** (ein Tipp springt nicht, E4), HUPE bleibt | Keine neuen Plätze im vermessenen Layout. |
| GO-Zone (17.5) | Tipp auf die Bildmitte | runder Knopf „TAP ON GREEN“ in der Bildmitte, nur im Countdown mit Auto-Gas, reagiert auf `pointerdown` | Das Fenster ist 1/3 s lang; ein `click` käme erst beim Loslassen. |
| Ghost-Wiedergabe (15.4) | Hermite aus `interpolation.ts` | Hermite mit **Catmull-Rom-Tangenten** (`ghostPlayback.ts`) | Die Pose-Spur hat keine Geschwindigkeiten. Eine gerade Fahrt mit konstanter Geschwindigkeit wird exakt wiedergegeben (Unit-Test). |
| Rampen und Hügelstraße (17.4, 5.5) | in allen Modi sichtbar | **nur in Race- und Zeitfahr-Rooms** | Schritt 4 (Rampen in `MapData`, `MAP_VERSION` 3) ist noch offen; außerhalb der Renn-Welt wären sichtbare Rampen ohne Collider. |
| LED-Streifen, Startampel (17.4) | emissiv, ins Bloom | HDR-Farben auf `MeshBasicMaterial`, per Instanzfarbe | Der Renderer hat kein Bloom; die Tonemap macht die hellen Werte zu Leuchten. |
| Startampel am Portal (17.4) | 5 Leuchten | 5 Leuchten; die drei Lichter des Countdowns zünden 1, 3 und 5 davon, bei Grün alle grün | – |
| Streckenkarte (17.3) | Norden oben | Norden (+z) oben, **+x links** (so wie von oben gesehen; ein Auto nach +z hat +x links) | Die Lobby-Vorschau und die Minimap zeigen die Strecke wie die 3D-Ansicht. |
| Autowahl in der Lobby | – | fünf Auto-Knöpfe; das eigene Modell wird wie auf dem Splash neu gebaut (`switchLocalCar` in `main.ts`) | – |
| E2E-Datei (20.3) | `tests/e2e/race.spec.ts` | **`tests/e2e/race.mobile.spec.ts`** | Das Projekt `mobile` nimmt `*mobile.spec.ts`, das Desktop-Projekt lässt sie aus. |
| E2E-Ablauf (20.3) | REMATCH → Lobby | REMATCH → die Einblendung verschwindet und **der nächste Countdown auf derselben Strecke** beginnt | Wer abstimmt, ist bereit; mit einem Menschen dauert die Lobby nur 1 s. Der neue `startTick` ist ein stabiler Beleg für Lobby und Rematch. |
| Bot-Test (20.2) | – | Der manipulierte Client D schickt im Countdown **alle 10 gelaufenen Ticks** statt auf festen Tick-Nummern (`tick % 20`) | Nach einem Stau im TCP-Modus der Netsim springt die Prediction eines Bots vor und übersprang die festen Nummern: in einem von fünf Läufen kamen nur 2 statt ≥ 3 Sendungen zustande. |

**Gemessen:**

| | Wert | Budget |
|---|---|---|
| Streckenausstattung (Hill Sprint / Downtown Loop, `npm run screenshots`, Ansichten `race-start` und `race-lobby`) | 7 Meshes (Props, Atlas, LEDs, Startampel, Rampen, Hügelstraße, Markierungen; Props und Rampen auch im Schattenpass), 11 960 / 8 926 Dreiecke | ≤ +20 Draw Calls, ≤ +30 k Dreiecke |
| Ziel-Portal aus 600 m (`race-finish-far`, Kamera-`far` 2600 m, Höhennebel) | sichtbar, Nebel rund ein Viertel | Sichtweite 120–600 m |
| E2E-Suite lokal (`npm run test:e2e`, 8 Tests inkl. Build) | 2:30 min, davon der Renn-Test 24–30 s | < 5 min, Renn-Test ≤ 40 s |
| Render-Messung Race-HUD (8 Viewports, Render-Job) | 28 s | – |
| Bot-Integration lokal (`npm run test:bots`) | 2:30 min | < 3 min |
| Unit-Lauf (101 Dateien, 1365 Tests) | 4,6 s | < 15 s |

Die Kamera-`far` (2600 m) und der Höhennebel brauchten für die Sichtweite keine Änderung; die Tier-Sichtweite 350 m des Low-Tiers gibt es im Renderer nicht als eigene Grenze (der Nebel ist für alle Tiers gleich).

**Tests und Mutationsproben:** Neue Unit-Tests in `tests/client/raceModel.test.ts` (Countdown und Launch-Fenster, Pfeilrichtung, Position, Uhr, Runde und FINAL LAP, Split gegen Vordermann und Ghost, Banner, Zuschauer, Neustart, Launch der Prediction, Restweg und verpasstes Gate, Gate-Leuchten, Lobby, Ergebnisse, Zeitfahr-Rekord, Verzögerung der Ergebnisse), `raceUi.test.ts` (happy-dom auf dem echten Markup), `ghostPlayback.test.ts`, `trackLayout.test.ts` (auch gegen die Collider der Renn-Welt), erweitert: `input.test.ts`, `mobileControls.test.ts`, `roomMenu.test.ts`, `simWorldClient.test.ts`, `tests/shared/net/prediction.test.ts`, `tests/shared/race/inputFilter.test.ts` (`racePhaseAt`, jetzt auch vom Bot benutzt). Jeder neue Test hat eine Mutationsprobe (Liste in der Commit-Nachricht). Stryker über die geänderten Shared-Dateien: `inputFilter.ts` 98,8 % (der Überlebende `startTick !== null` → `true` ist äquivalent, `tick < null` ist für Ticks ≥ 0 falsch), in `prediction.ts` überlebt auf den geänderten Zeilen nichts. Der Client-Code liegt außerhalb der Stryker-Konfiguration (`src/shared`, `src/server`).

**Offen:** Schritt 4 (Rampen in `MapData`, dann auch in Free Roam und Party sichtbar), der Playtest (21) und Messungen auf echten Geräten.
