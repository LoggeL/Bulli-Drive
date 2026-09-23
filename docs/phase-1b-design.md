# Phase 1b: Server-autoritativer Netz-Kern – verbindliche Spezifikation

**Stand:** 2026-09-23 · **Branch:** `net/phase-1b` (auf `main` e40eafc) · Bezug: [`refactor-plan.md`](refactor-plan.md) Abschnitt 0 (Entscheidungen), 5 (Phase 1b), 6 (Netcode kompakt) · Sim-Grundlage: [`phase-1a-design.md`](phase-1a-design.md), vor allem die Abschnitte 5, 6.3, 7, 8, 10, 18, 23 und 24

Dieses Dokument ist die verbindliche Grundlage für Phase 1b. Struktur, Nachrichten, Reihenfolgen im Tick, Budgets und die Umsetzungsreihenfolge sind verbindlich. Zahlen, die als Startwert markiert sind, werden mit Netsim und Bots nachjustiert. Abweichungen werden wie in 1a in einem eigenen Abschnitt am Ende dokumentiert, nicht still umgesetzt.

**Rahmen (aus den Nutzerentscheidungen, nicht verhandelbar):**

- **Ein Netzmodell für alle Room-Typen:** Der Server simuliert, der Client schickt nur Eingaben und sagt voraus. Kein Client bestimmt mehr seine Position.
- **Echtes Rempeln auf beiden Seiten**, auch später im Rennen. Der Server rechnet den Kontakt mit `stepWorld` für alle Autos.
- **Der Party-Modus bleibt** (Schießen, Coins, Powerups, HP, Scoreboard, Mega-Ram) als eigener Room-Typ `PartyRoom`. Er ist der Standard beim Beitritt. Dazu kommt `FreeRoamRoom` ohne Kampf.
- **Mobile ist gleichwertig:** Jede Regel, jedes Budget und jedes Exit-Kriterium gilt auch für Touch-Geräte im Mobilfunknetz.
- **Der Server läuft 24/7:** Deploys und Neustarts trennen Spieler nur kurz. Hängt der Tick, fällt das über `/healthz` auf.
- **Neue Features gehen direkt live**, ohne Feature-Flag, nach grüner CI per Squash-Merge. Deshalb muss jeder Merge-Punkt (Abschnitt 17) ein vollständig spielbares Spiel sein.
- `src/shared` bleibt frei von three, DOM und Node-Globals (`tests/shared/purity.test.ts`). Neu dazu kommt `src/shared/net`.

---

## 1. Überblick

```
Client (60 Hz, läuft der Server-Zeit um „Lead“ voraus)            Server (60 Hz pro Room)
────────────────────────────────────────────────────              ─────────────────────────────────────
InputManager.sampleTick ─► Input-Historie ─► predict (stepWorld:  ─► input {seq, tick, 3–8 Inputs} ─►  InputBuffer je Spieler (1–3 Ticks Puffer)
   eigenes Auto + Kontakt-Set)                                                                        │
        ▲                                                                                              ▼
        │ reconcile: Zustand(T_s) übernehmen,                                                  Room.step(T): Inputs (oder Wiederholung/Stopp),
        │ Ticks T_s+1..C erneut simulieren,                                                    Party-Regeln, stepWorld(alle Autos), Events
        │ Differenz als Render-Offset abbauen                                                          │
        │                                                                                              ▼
snapshot (20 Hz, binär) ◄──────────────────────────────────────────────────────────────────── alle 3 Ticks: Snapshot je Empfänger
events (JSON, gebündelt) ◄───────────────────────────────────────────────────────────────────  (Self-Block voll, andere kompakt)
ping ─► / ◄─ pong {tick}  (Clock-Sync, 1 Hz)
```

Die Sim aus 1a ändert sich dabei nicht. 1b baut Rooms, Protokoll, Server-Tick, Prediction und Robustheit um sie herum.

---

## 2. Room-Modell

### 2.1 Begriffe und Aufteilung

Heute liegt der Zustand in Modul-Singletons (`server/state.ts: players`, `server/world.ts: powerups, powerupsById, trees, coins, coinsById, cityData`, `server/net.ts: wss`). In 1b werden daraus drei Ebenen:

| Ebene | Lebensdauer | Inhalt | Herkunft heute |
|---|---|---|---|
| **`Session`** (`server/session.ts`) | Verbindung + 30 s Grace | `playerId`, `sessionToken`, `connId`, `ws`, Name, Farbe, `carType`, Assist-Profil, Rate-Limit-Zähler, RTT-Schätzung, aktueller Room | `Player` in `server/types.ts` (Verbindungsteil), `index.ts` |
| **`RoomMember`** (`server/rooms/Room.ts`) | Mitgliedschaft in einem Room | `slot` (u8), `SimCar`, `InputBuffer`, letzter Input, Fehl-Ticks, `ready`, `spawned`, `idle`, `laggy` | `Player` (Positionsteil) |
| **`PartyMemberState`** (`server/party/state.ts`) | Mitgliedschaft im PartyRoom | HP, Score, Powerup-Fenster `{type → endTick}`, Respawn-Schild, Tod bis Tick, Schuss-Cooldown, Ram-Cooldowns je Gegner | `Player` (Kampfteil), Timer in `handlers.ts` |

Unveränderliche Kartendaten (`MapData`: generierte Welt, `SimWorld`, `RoadGrid`, Spawn-Kandidaten) gibt es **einmal pro Karte** im Prozess (`server/maps.ts`). Alle Rooms derselben Karte teilen sie; sie werden nie mutiert. Veränderlich und damit Instanzfelder sind nur Mitglieder, Items (Coins und Powerups mit `collected` und Reset-Tick) und Timer.

| Singleton heute | wird in 1b |
|---|---|
| `players` (`state.ts:6`) | `SessionRegistry` (global, nach Token und ID) + `Room.members` (`Map<playerId, RoomMember>`) |
| `powerups`, `powerupsById`, `coins`, `coinsById` (`world.ts:4-9`) | `PartyRoom.items` (`ItemState` pro Room, Startwerte aus `MapData`) |
| `trees`, `cityData`, `initWorld` | `MapData` (einmal, unveränderlich) |
| `randomSpawn`, `getPublicPlayers`, `getScoreboard` | Methoden von `Room` bzw. `PartyRoom` (Abstand nur zu Mitgliedern des eigenen Rooms) |
| `broadcast`, `broadcastScoreboard` (`net.ts`) | `Room.broadcast(msg)` über die eigenen Mitglieder; `net.ts` behält nur `safeSend` und die Backpressure |
| `handlers.ts` (ein Switch für alles) | `server/protocol/dispatch.ts` (Session-Nachrichten) → `Room.onMessage` → `PartyRoom`-Handler in `server/party/*` |
| `setTimeout` je Spieler (Powerups, Schild, Respawn, Item-Reset) | Zähler in Ticks, abgearbeitet in `Room.step` (Abschnitt 5.5) |

### 2.2 Klassen

```ts
// server/rooms/Room.ts
export type RoomKind = 'party' | 'freeroam';           // 'race' ab Phase 2

export abstract class Room {
    readonly id: string;                 // 'party-1', 'freeroam-2'
    readonly kind: RoomKind;
    readonly map: MapData;
    tick = 0;                            // u32, zählt nur, solange Mitglieder da sind
    readonly members = new Map<string, RoomMember>();
    snapshotEvery = 3;                   // 60/3 = 20 Hz (Rennen später 2 → 30 Hz)
    emptySinceMs = 0;

    join(session: Session): RoomMember;  // Slot vergeben, roomState senden, playerJoined an alle
    leave(member: RoomMember, reason: LeaveReason): void;
    onInput(member: RoomMember, packet: InputPacket): void;
    onMessage(member: RoomMember, msg: RoomMessage): void;
    step(): void;                        // genau ein Tick (Abschnitt 5.3)

    // Erweiterungspunkte für PartyRoom / FreeRoamRoom / später RaceRoom
    protected abstract beforeStep(t: number): void;        // Mods, Schild, Ghost
    protected abstract afterStep(t: number): void;         // Kontakte, Pickups, Timer
    protected filterInput(member: RoomMember, input: VehicleInput, t: number): void {}  // RaceRoom: Gas vor Start ignorieren
    protected abstract roomStateExtras(member: RoomMember): object;
}
```

- **`PartyRoom`** (`server/rooms/PartyRoom.ts`, Regeln in `server/party/*`): das heutige Spiel mit allen Party-Regeln aus `handlers.ts`, jetzt im Tick. Standard-Room beim Beitritt.
- **`FreeRoamRoom`** (`server/rooms/FreeRoamRoom.ts`): dieselbe Karte, Rempeln, Sprung und Hupe, aber ohne Items, Schüsse, HP und Scoreboard. `shoot` wird ignoriert. Nach dem Spawn gilt nur der Kontakt-Ghost aus der Sim (`ghostTicks = RESET_GHOST_TICKS`).
- **`RaceRoom`** (Phase 2) nutzt dieselbe Basis: `snapshotEvery = 2`, `filterInput` für den Countdown, `afterStep` für Gates. 1b baut ihn nicht, verbaut ihn aber nicht.

### 2.3 Lobby, Instanzen, Join, Leave, Wechsel

`server/rooms/lobby.ts` (`RoomManager`):

- **`MAX_PLAYERS_PER_ROOM = 32`** (ENV `MAX_PLAYERS_PER_ROOM`). Zusätzlich `MAX_CONNECTIONS = 160` für den ganzen Prozess; darüber wird eine neue Verbindung mit Code 4002 abgelehnt.
- **Instanzwahl `findOrCreate(kind)`:** Der Room dieser Art mit den **meisten** Mitgliedern unter dem Limit (Spieler sollen sich treffen), bei Gleichstand die kleinste Nummer. Sind alle voll, entsteht eine neue Instanz mit der nächsten freien Nummer (`party-2`, …).
- `party-1` existiert immer. Alle anderen Instanzen werden 60 s nach dem letzten Verlassen geschlossen (`EMPTY_ROOM_TTL_MS`). Leere Rooms ticken nicht.
- **Join:** nach `hello` in den gewünschten Room (`hello.room`, Standard `party`). Der Server schickt `roomState`. Das Auto entsteht erst mit `ready` (nach dem Splash-Screen) und dem Event `spawn`; bis dahin ist das Mitglied Zuschauer und nicht in der Sim.
- **Leave:** beim Ablauf der Grace (Abschnitt 11.1), bei `joinRoom` in einen anderen Room, bei Kick. Alle anderen bekommen `playerLeft`. Der Slot wird erst nach 5 s wieder vergeben, damit späte Snapshots nicht einem neuen Spieler zugeordnet werden.
- **Wechsel `joinRoom {kind}`:** atomar: `leave` im alten Room, `join` im neuen (über `findOrCreate`), neuer `roomState`, dann sofort `spawn` (der Spieler war schon `ready`). Name, Farbe, Karosse und Profil bleiben (Session). Score und HP gehören zur Party-Mitgliedschaft und verfallen beim Verlassen, wie heute beim Trennen. Der Client verwirft Prediction, Interpolation und Clock-Sync und startet sie für den neuen Room neu.
- Rate-Limit: höchstens ein `joinRoom` pro 2 s.

---

## 3. Protokoll v2

### 3.1 Grundsätze

- **`PROTOCOL_VERSION = 2`** in `src/shared/protocol.ts`. Jede inkompatible Änderung erhöht sie.
- **Zwei Rahmenarten auf einem WebSocket:**
  - **Text (JSON)** für alles außer dem heißen Pfad. Jede Client→Server-Nachricht wird mit valibot geprüft (`ClientMessageSchema`, wie heute). Server→Client-Typen sind TS-Typen in derselben Datei.
  - **Binär** nur für `input` (C→S) und `snapshot` (S→C). Das erste Byte ist die Art (`0x01` input, `0x02` snapshot). Kodierung in `src/shared/net/codec.ts` mit `DataView`, little endian. Der Server dekodiert `input` in ein Objekt und prüft es dann mit `InputPacketSchema` (valibot), damit auch der Binärpfad eine einzige Schemaquelle hat.
- **Begründung für binär:** Bei 32 Spielern und 20 Hz bleiben pro Client 30 kB/s ÷ 20 = 1,5 kB pro Snapshot, also < 47 B pro Auto. JSON braucht für Pose, Geschwindigkeit, Input und Flags ~180 B pro Auto (≈ 115 kB/s). Der Plan sah Binär „nach Messung“ vor; die Rechnung ist eindeutig, deshalb gleich binär.
- **Keine Deltas:** Jeder Snapshot ist vollständig. Ein übersprungener Snapshot (Backpressure) schadet nicht, es gibt keine Acks für den Downlink. Das Budget reicht ohne Deltas (Abschnitt 13).
- **Kein `permessage-deflate`** (CPU und Latenz). `TCP_NODELAY` ist an (ws-Standard, wird im Test geprüft).
- **WebSocket ist TCP:** „Verlust“ heißt im Netz Head-of-Line-Blocking (Verzögerung aller folgenden Nachrichten um etwa eine Retransmit-Zeit), nicht fehlende Pakete. Die Input-Redundanz bleibt trotzdem, weil der Server Inputs bei Überlast oder Rate-Limit verwerfen kann, weil die Dev-Netsim auch echtes Verwerfen testet und weil ein späterer Datagramm-Transport (WebTransport) dasselbe Format nutzen soll.
- **Nicht endliche Zahlen** werden am Protokollrand abgewiesen: JSON über `v.finite()`, Binär-Inputs sind per Konstruktion Ganzzahlen, Snapshots prüft der Client auf endliche Werte und verwirft sonst den ganzen Snapshot (mit Log).

### 3.2 Handshake und Versionsprüfung

```
Client                                   Server
  │ open                                   │
  │── hello ──────────────────────────────►│  Version prüfen, Token prüfen, Room wählen
  │◄────────────────────────────── welcome │  (oder reject + close 4000/4001/4002)
  │◄──────────────────────────── roomState │
  │── ping (5× im Abstand von 100 ms) ────►│
  │◄──────────────────────────────── pong  │
  │── ready (nach dem Splash) ────────────►│
  │◄──────────────── events [spawn …]      │
  │── input (60 Hz, binär) ───────────────►│
  │◄─────────────── snapshot (20 Hz, binär)│
```

| Nachricht | Felder | Regeln |
|---|---|---|
| `hello` (C→S) | `protocolVersion`, `build` (Meta-Stempel der Seite oder `null` im Dev-Server), `connId` (zufällig pro Seitenladung, nur im Speicher), `sessionToken?`, `resume?` (Ticket aus 11.3), `name`, `carType`, `profile` (`standard`/`touch`), `room` (`party`/`freeroam`) | Erste Nachricht. Kommt 5 s lang kein gültiges `hello`, schließt der Server mit 4001. |
| `welcome` (S→C) | `playerId`, `sessionToken`, `resumed` (bool), `serverBuild`, `tickRate` (60), `snapshotRate` (20) | |
| `reject` (S→C) | `reason` (`version`/`hello`/`full`), `reload` (bool) | Danach Close mit 4000/4001/4002. |
| `roomState` (S→C) | `roomId`, `kind`, `tick`, `world {seed, mapVersion, worldHash}`, `members [{id, slot, name, color, carType, ready}]`, Party: `items {powerups: [{id, type, collected}], coins: [{id, collected}]}`, `scoreboard`, `health` je Mitglied | Nach `welcome` und nach jedem Room-Wechsel. |

**Alte Clients:** Ein Client mit `protocolVersion ≠ 2` bekommt `reject {reason: 'version', reload: true}` und Close 4000. Der v2-Client zeigt „Neue Version – wird geladen“ und lädt neu, höchstens einmal pro `serverBuild` (Schutz über `sessionStorage` wie in `buildVersion.ts`; greift der Schutz, erscheint ein Button „Neu laden“). Kein v1/v2-Adapter.

**Der heute live laufende v1-Client** schickt kein `hello`. Er bekommt nach 5 s Close 4001. Er hat keinen Handler dafür und keinen Reconnect, bleibt also stehen, bis der Nutzer neu lädt; danach greift `ensureCurrentBuild` und lädt den v2-Client. Eine Reload-Aufforderung kann man diesem einen alten Stand nicht mehr beibringen. Das betrifft nur Tabs, die über den Deploy von 1b hinweg offen sind (der Deploy trennt sie ohnehin), und wird einmalig hingenommen.

**Build-Abgleich:** Ist `welcome.serverBuild ≠ hello.build` bei gleicher Protokollversion (neuer Deploy ohne Protokolländerung), lädt der Client ebenfalls einmal neu. Das passiert nur direkt nach einem Reconnect, also wenn der Spieler ohnehin kurz getrennt war. Token und Resume-Ticket liegen in `sessionStorage` und überleben den Reload (Abschnitt 11).

**Welt aus dem Seed:** `roomState.world` enthält nur `seed` (heute `WORLD_SEED`), `mapVersion` und `worldHash` (FNV-1a über die kanonisch serialisierte `generateWorld(seed)`-Ausgabe und die Collider-Liste aus 6). Der Client erzeugt Stadt, Bäume, Coins, Powerups und Collider selbst mit denselben shared-Funktionen. Stimmt sein Hash nicht, lädt er neu (Build-Versatz). Das ersetzt die 20 kB schwere `init`-Nachricht durch < 1 kB und garantiert, dass Client und Server dieselben Collider haben.

### 3.3 Uplink `input` (binär, `0x01`)

| Offset | Typ | Feld |
|---|---|---|
| 0 | u8 | Art = `0x01` |
| 1 | u8 | `count` n (1–8) |
| 2 | u8 | `clientFlags`: Bit 0 `FROZEN` (Modal, Kontextverlust), Bit 1 `HIDDEN` (Tab im Hintergrund) |
| 3 | u32 | `seq` des neuesten Inputs |
| 7 | u32 | `tick` des neuesten Inputs (Ziel-Server-Tick) |
| 11 + 4k | i8, u8, u8, u8 | Input k (k = 0 ist der neueste): `steer`, `throttle`, `brake`, `buttons` |

- Input k hat `seq − k` und `tick − k`. Der Client erzeugt genau einen Input pro eigenem Tick, deshalb sind Ticks und Seqs aufeinanderfolgend. Nach einem harten Resync (Abschnitt 8.3) springt `tick`, `seq` zählt weiter; das Paket enthält dann nur Inputs ab dem Sprung.
- **Redundanz:** `n = Ticks seit dem letzten Paket + 2`, höchstens 8. Bei 60 FPS ist das ein Paket pro Tick mit dem aktuellen und den zwei vorherigen Inputs (dreifach). Bei 30 FPS gehen zwei neue Ticks plus zwei alte in einem Paket mit.
- Größe bei n = 3: 23 B, bei 60 Hz 1,4 kB/s (+ WebSocket-Header mit Maske 6 B pro Rahmen).
- `VehicleInput` ist schon in 1a quantisiert (`steer` −127..127, `throttle`/`brake` 0..255, `buttons` Bitmaske), der Codec überträgt ihn verlustfrei.
- Schuss und Hupe bleiben JSON-Nachrichten (`shoot`, `honk`), weil sie selten sind und keine Sim-Eingabe.

### 3.4 Downlink `snapshot` (binär, `0x02`)

Ein Snapshot pro Empfänger und Snapshot-Tick. Der Kompaktteil (alle Autos) wird pro Room und Snapshot **einmal** kodiert; pro Empfänger kommen nur Kopf und Self-Block davor.

**Kopf (16 B):**

| Offset | Typ | Feld |
|---|---|---|
| 0 | u8 | Art = `0x02` |
| 1 | u8 | `flags`: Bit 0 Self-Block vorhanden |
| 2 | u32 | `serverTick` T_s (Zustand **nach** Tick T_s) |
| 6 | u32 | `lastProcessedSeq` des Empfängers (`0xFFFFFFFF` = noch keiner) |
| 10 | i8 | `inputSlack`: kleinster Vorlauf (in Ticks) der Inputs dieses Empfängers seit dem letzten Snapshot, gemessen beim Eintreffen: `input.tick − aktueller Server-Tick`; −128 = nichts empfangen |
| 11 | u8 | `bufferTarget` (1–3), Ziel für den Vorlauf |
| 12 | u8 | `carCount` |
| 13 | u8 | `missedInputs`: Ticks seit dem letzten Snapshot, für die der Server wiederholen musste |
| 14 | u16 | reserviert |

**Self-Block (≈ 150 B), nur für den Empfänger:** der **volle** `VehicleState` seines Autos in voller Präzision, damit die Reconciliation exakt vom Server-Zustand startet (1a, Abschnitt 18):

- `slot` u8
- 16 × f64: `x, y, z, yaw, vx, vy, vz, yawRate, steerAngle, loadX, rearGrip, betaPrev, boostMeter, flipAngle, flipRate, scale`
- Zähler: `airTicks` u8, `driftTicks` u16, `driftLowTicks` u8, `wallTicks` u8, `jumpCooldown` u8, `resetHold` u8, `reverseHold` u8, `ghostTicks` u16, `ghostExit` u8, `prevButtons` u8
- Bits u8: `grounded`, `boosting`, `wasGhost`
- `mods` u8 (Turbo, Mega, Super-Jump, Ghost, Schild) und der **tatsächlich verwendete** Input des Ticks T_s (4 B)

Der Codec-Test iteriert über alle Schlüssel von `createVehicleState()`. Kommt in der Sim ein Feld dazu, schlägt er fehl, bis es im Self-Block steht.

**Kompakt-Datensatz pro Auto (32 B), für alle anderen lebenden Autos:**

| Feld | Typ | Quantisierung | Bereich |
|---|---|---|---|
| `slot` | u8 | | |
| `flags` | u16 | Bits: grounded, boosting, drifting, turbo, mega, superJump, ghost, shield, respawnShield, idle, laggy, flipping, wasGhost, ghostExit > 0 | |
| `x`, `z` | i24 je | 1/4096 m | ±2048 m |
| `y` | i16 | 1 cm | ±327 m |
| `yaw` | u16 | 2π/65536 (gewickelt) | |
| `vx`, `vy`, `vz` | i16 je | 1 cm/s | ±327 m/s |
| `yawRate` | i16 | 1 mrad/s | ±32 rad/s |
| `steerAngle` | i8 | 1/200 rad | ±0,635 rad (δ0 ≤ 34°) |
| letzter Input | 4 B | wie Uplink | |
| `scale` | u8 | (s − 1)·100 | 1–3,55 |
| `flipAngle` | u8 | 2π/256 | |
| `boostMeter`, `rearGrip` | u8 je | ×255 | 0–1 |
| `loadX` | i8 | 0,25 m/s² | ±31,75 |
| `ghostTicks` | u8 | gesättigt | |

`decodeRemoteState(record, out: VehicleState)` in `shared/net/codec.ts` füllt einen vollständigen Zustand für die Extrapolation: `betaPrev` aus v und yaw, `airTicks = grounded ? 0 : COYOTE_TICKS + 1`, `driftTicks = drifting ? 1 : 0`, `wallTicks = 255`, `prevButtons = input.buttons` (kein erneuter Sprung), `flipRate` nominal `2π/1,1 s` bei `flipping`, übrige Zähler 0.

Tote Autos und Mitglieder ohne `ready` fehlen im Snapshot. Welcher Slot zu welchem Spieler gehört, steht in `roomState` und `playerJoined`.

### 3.5 Weitere JSON-Nachrichten

**C→S:** `hello`, `ready`, `ping {t}`, `joinRoom {kind}`, `setCar {carType, profile}`, `rename {name}`, `honk`, `shoot {targetId}`, `visibility {hidden}`, im E2E-Modus zusätzlich `debugPlace {x, z, yaw}` (Abschnitt 15.4). Entfallen: `update`, `collectPowerup`, `collectCoin`, `respawnShieldExpired`, `playerReady` (heißt jetzt `ready`), `setCarType` (jetzt `setCar`).

**S→C:** `reject`, `welcome`, `roomState`, `playerJoined {id, slot, name, color, carType}`, `playerLeft {id, reason}`, `playerUpdated {id, name?, carType?}`, `pong {t, tick, sub}`, `events {tick, list}`, `scoreboard`, `shutdown {reconnectInMs, resume?}`, `kicked {reason}`. Entfallen: `init`, `update`, `newPlayer`, `removePlayer`, `shieldBreak` (wird heute nie gesendet) und die Einzelnachrichten, die jetzt Events sind.

### 3.6 Events

Events entstehen im Tick, werden pro Room gesammelt und **vor** dem Snapshot desselben Snapshot-Ticks als eine Nachricht `events {tick, list}` gesendet. Jedes Event trägt seinen eigenen Tick. TCP liefert sie zuverlässig und geordnet aus, es gibt keine Duplikate.

| Event | Felder | Empfänger |
|---|---|---|
| `spawn` | `id, tick, x, z, yaw` | alle |
| `contact` | `a, b, dv, x, z` (nur ab Δv ≥ 3 m/s, pro Paar höchstens alle 6 Ticks) | Mitglieder im Umkreis von 150 m |
| `pickup` | `kind` (`coin`/`powerup`), `itemId, playerId`, bei Powerups `type, startTick, endTick` | alle |
| `itemReset` | `kind, itemId` | alle |
| `hit` | `target, source, damage, health, cause` (`shot`/`ram`) | alle |
| `killed` | `target, killer, killerName, targetName, cause` | alle |
| `respawn` | `id, tick, x, z, yaw, health` | alle |
| `carChanged` | `id, carType, profile, tick` | alle |
| `honk` | `id` | alle außer dem Hupenden |

Score-Änderungen kommen weiter als `scoreboard` (höchstens einmal pro Snapshot-Tick, nur bei Änderung).

### 3.7 Clock-Sync

- Der Client sendet `ping {t}` (`t` = `performance.now()` des Clients) nach dem Join fünfmal im Abstand von 100 ms, danach einmal pro Sekunde.
- Der Server antwortet sofort mit `pong {t, tick, sub}`: der aktuelle Room-Tick und der Anteil `sub` (0..1) des laufenden Tick-Intervalls.
- Der Client rechnet `rtt = now − t` und `serverTickAt(now) = tick + sub + (rtt/2)/DT_ms`. Er behält die letzten 8 Proben und nutzt die mit der **kleinsten** RTT (geringste Warteschlange) als Offset, glättet die Änderung des Offsets mit 0,1 pro Probe und schätzt den Jitter als Spanne p90 − p10 der RTTs.
- Die Uhr dient nur der Erstschätzung und der Interpolationszeit. Den Vorlauf der Inputs regelt der Client über `inputSlack` (Abschnitt 8.3), weil der direkt misst, was zählt.

---

## 4. Konstanten (`src/shared/net/constants.ts`)

| Konstante | Wert | Bedeutung |
|---|---|---|
| `SNAPSHOT_EVERY` | 3 | Party/FreeRoam: 20 Hz |
| `INPUT_REDUNDANCY` | 2 | ältere Inputs pro Paket zusätzlich |
| `INPUT_MAX_PER_PACKET` | 8 | |
| `INPUT_MAX_AHEAD` | 30 Ticks | Inputs weiter in der Zukunft werden verworfen |
| `INPUT_REPEAT_TICKS` | 15 (250 ms) | danach Stopp-Input |
| `BUFFER_TARGET_MIN/MAX` | 1 / 3 Ticks | Ziel-Vorlauf der Inputs am Server |
| `HISTORY_TICKS` | 128 | Input- und Zustandshistorie des Clients (2,1 s) |
| `INTERP_DELAY_TICKS` | 6 (100 ms) | Remote-Interpolation, adaptiv bis 9 |
| `EXTRAPOLATE_MAX_TICKS` | 15 (250 ms) | |
| `CONTACT_RADIUS` | 15 m + \|v_rel\|·Lead, höchstens 45 m; Verlassen bei +5 m | Kontakt-Set (8.5) |
| `CONTACT_SET_MAX` | 6 Remote-Autos | |
| `SMOOTH_TAU_MIN/MAX` | 100 / 200 ms | Render-Offset |
| `SNAP_DISTANCE` / `SNAP_YAW` | 4 m / 45° | |
| `CONTACT_EVENT_MIN_DV` | 3 m/s | |
| `IDLE_AFTER_TICKS` | 60 (1 s) ohne Input | Idle-Ghost |
| `IDLE_KICK_MS` | 10 min | |
| `GRACE_MS` | 30 000 | |
| `LAGGY_RTT_MS` / `LAGGY_MISS_RATE` | 300 ms / 20 % über 2 s | Lag-Ghost, Ende nach 5 s gutem Netz |

---

## 5. Server

### 5.1 Tick-Scheduler (`server/tick.ts`)

Ein Scheduler für den ganzen Prozess treibt alle Rooms. Jeder Room hat seinen eigenen Tick-Zähler; pro Scheduler-Tick werden die nicht leeren Rooms in fester Reihenfolge (nach `id`) gestuft.

```ts
const TICK_MS = 1000 / 60;
let next = performance.now();
function loop(): void {
    const now = performance.now();
    let n = 0;
    while (now >= next && n < 4) { stepAllRooms(); next += TICK_MS; n++; }   // Drift-Korrektur: next läuft absolut
    if (now - next > 250) { next = now; metrics.overruns++; }                // Hänger: nicht nachholen
    lastTickAt = now;
    setTimeout(loop, Math.max(0, next - performance.now()));
}
```

`next` läuft absolut weiter, deshalb driftet der Takt nicht; `setTimeout`-Ungenauigkeit (±1–2 ms) spielt keine Rolle, weil Clients sich an Tick-Nummern und nicht an der Wanduhr orientieren. Nach einem Hänger über 250 ms wird nicht nachgeholt; die Clients korrigieren über `inputSlack`. Jede Tick-Dauer geht in ein Histogramm (`metrics`, für `/healthz` und den Bot-Test).

### 5.2 Input-Puffer (`server/rooms/InputBuffer.ts`, Validierung in `server/validation/inputs.ts`)

- Ringpuffer mit 64 Einträgen je Mitglied, Index `tick & 63`, Eintrag `{tick, seq, input, flags}`.
- **Annahme** eines Pakets beim Eintreffen, jeder Input einzeln:
  - `tick ≤ lastStepped` (schon simuliert): verworfen, zählt als „spät“.
  - `tick > room.tick + INPUT_MAX_AHEAD`: verworfen, zählt als „zu früh“ (Clock kaputt oder Manipulation).
  - Slot schon mit gleichem `tick` belegt: ignoriert (Redundanz).
  - sonst gespeichert.
- **Klemmung** (zusätzlich zum Schema): `steer` auf −127..127, `throttle`/`brake` 0..255, `buttons & 0x0F` (nur bekannte Bits).
- `inputSlack` des Empfängers = Minimum von `tick − room.tick` über alle angenommenen neuesten Inputs seit dem letzten Snapshot.
- **`bufferTarget`** je Mitglied aus dem Jitter der eintreffenden Pakete (Spanne p90 − p10 der Ankunftsabstände über 2 s): < 8 ms → 1, < 25 ms → 2, sonst 3.
- **Rate-Limit:** höchstens 150 Input-Pakete pro Sekunde (Token-Bucket, Burst 30); mehr wird verworfen. Über 2 s dauerhaft mehr als 240 pro Sekunde oder mehr als 10 ungültige Nachrichten in 10 s → `kicked {reason: 'policy'}`, Close 4003. Andere Spieler merken davon nichts.

### 5.3 Ablauf eines Room-Ticks

```
Room.step():
    T = ++tick
    für jedes Mitglied (sortiert nach id):
        in = inputs.take(T)
        wenn in:            car.input = in; lastInput = in; missing = 0; lastProcessedSeq = in.seq; frozen = in.flags.FROZEN
        sonst wenn missing < INPUT_REPEAT_TICKS:  car.input = lastInput; missing++     // Wiederholung ≤ 250 ms
        sonst:              car.input = stopInput(car.state); missing++                 // neutral + Bremse
        filterInput(member, car.input, T)                                               // RaceRoom: Countdown
    beforeStep(T)          // Mods aus Powerup-Fenstern, Schild, Idle-/Lag-Ghost (5.4)
    stepWorld(lebende gespawnte Autos, map.simWorld)
    afterStep(T)           // Kontakt-Events, Mega-Ram-Schaden, Pickups, Timer, Idle-Übergänge (5.5)
    wenn T % snapshotEvery == 0: flushEvents(); sendSnapshots()
```

- **`stopInput(state)`** (`shared/sim/inputs.ts`, identisch auf Client und Server): `steer = 0`, `buttons = 0`; bei u > 0,5 m/s `brake = 255`, bei u < −0,5 m/s `throttle = 255` (bremst Rückwärtsfahrt, 1a Abschnitt 19.2), sonst beides 0. So bremst das Auto bis zum Stand, ohne nach 8 Ticks in den Rückwärtsgang zu gehen.
- `stepWorld` sortiert nach `id` mit `<` (1a 8.3). Die Reihenfolge der Map-Einfügung spielt keine Rolle.
- **Tuning:** Der Server liest `SIM_TUNING`, `VEHICLE_CLASSES` und `ASSIST_PROFILES` nur als Defaults und schreibt nie hinein. Beim Start prüft er `tuningIsDefault()` und bricht sonst ab (Schutz gegen versehentliche Imports).
- Klasse und Assist-Profil kommen aus der Session (`hello`, `setCar`). `setCar` wirkt zum nächsten Tick über `refreshCarParams` und erzeugt `carChanged`.

### 5.4 Idle, Hintergrund, Einfrieren, schlechte Verbindung

Ersetzt den AFK-Hack (`main.ts`, Grau färben nach 3 s ohne Bewegung) und löst die offene Einfrier-Regel aus 1a Abschnitt 18:

- **Einfrieren (Modal, Kontextverlust):** Der Client tickt weiter, verwendet selbst `stopInput` und setzt `FROZEN`. Server und Prediction rechnen damit dasselbe; beim Schließen des Modals springt nichts.
- **Hintergrund:** `visibilitychange` → `visibility {hidden: true}` und `HIDDEN` im nächsten Paket. Danach kommen in der Regel keine Inputs mehr (Browser drosseln Timer).
- **Idle** = `FROZEN` oder `HIDDEN` oder 60 Ticks ohne Input. Folgen: Stopp-Input ab 250 ms, **Kontakt-Ghost** (die Sim-Regel `ghostTicks = max(ghostTicks, 2)` vor jedem Tick), Flag `idle` im Snapshot (Clients zeigen das Auto grau mit „ZZZ“ wie heute), im Party-Modus unverwundbar und ohne Schussrecht (wie heute AFK). Idle endet mit dem ersten Input ohne `FROZEN`/`HIDDEN`; danach `ghostTicks = 60`, und der Server hält `ghostTicks ≥ 1`, solange sich die Hüllkreise mit einem anderen Auto überlappen (kein Herausschleudern).
- **Tod** ist Server-Zustand: Das Auto verlässt die Sim bis zum Respawn.
- **Schlechte Verbindung (`laggy`):** RTT > 300 ms oder > 20 % wiederholte Inputs über 2 s → Kontakt-Ghost wie bei Idle, Flag `laggy`; Ende nach 5 s unter den Schwellen. So zerstören Spieler mit sehr hoher RTT das Rempeln der anderen nicht (Plan, Anti-Griefing).
- **Idle-Kick:** nach 10 min Idle `kicked {reason: 'idle'}`, Close 4004. Der Client zeigt „Weiterspielen“ und verbindet neu. Hält den Speicher im 24/7-Betrieb stabil.
- Die Ghost-Regel für Idle und Lag heißt `applyContactGhostFloor(car, flags)` und liegt in `shared/sim`, damit die Client-Prediction sie für Remote-Autos mit gesetztem Flag genauso anwendet.

### 5.5 Party-Regeln im Tick (`server/party/*`, Konstanten in `shared/party/rules.ts`)

Alle Zeiten werden Ticks: `ticks = ms / 1000 · 60`.

| Regel | heute | 1b |
|---|---|---|
| Powerup-Dauer | `setTimeout` (5 s / 8 s) | Fenster `[startTick, endTick)` je Typ: speed/size/jump/magnet 300, shield/ghost 480 Ticks. `beforeStep` setzt daraus `car.mods`. Erneutes Aufnehmen verlängert auf `T + Dauer`. |
| Powerup aufnehmen | Client meldet `collectPowerup`, Server prüft 15 m | Server prüft im Tick: 2D-Abstand Auto–Powerup < 6 m (Client-Radius 5 m + 1 m Toleranz). `pickup` mit Fenster. |
| Coin aufnehmen | Client meldet `collectCoin`, Server prüft 35 m | Server prüft im Tick: < 4 m, mit Magnet < 7 m (Client 3 / 6 m + 1 m). +10 Score. |
| Item-Reset | `setTimeout` 20 s / 15 s | `resetTick` = T + 1200 / 900 |
| Schuss | `shoot {targetId}`, 150 m, Cooldown 400 ms | unverändert zielbasiert (Plan 6), aber gegen **Server-Positionen** im aktuellen Tick, Cooldown 24 Ticks, Schütze nicht idle/tot, Ziel nicht Schild/Respawn-Schild/Ghost/idle. Schaden 25, gegen Mega ×0,4. |
| Mega-Ram | Client-Abstandstest schickt `shoot` | **aus dem Kontaktimpuls:** Hat Auto B im Tick einen Auto-Kontakt mit `carImpactId = A`, `A.mods.mega` und `B.events.carImpact = Δv ≥ 4 m/s`, dann Schaden `min(60, round(2,5 · Δv))`, gegen Mega ×0,4. Cooldown 60 Ticks je Paar (A, B). Gleiche Schutzregeln wie beim Schuss. Ursache `ram`. Ein Rammstoß mit 10 m/s Δv kostet damit 25 HP wie heute. |
| Respawn-Schild | Client zählt 3 s nach dem Losfahren, schickt `respawnShieldExpired`; Server-Kappe 8 s | Server: endet 180 Ticks nachdem das Auto erstmals über 1 m/s fährt, spätestens 480 Ticks nach dem Spawn. Flag im Snapshot; die Nachricht entfällt. |
| Tod und Respawn | `setTimeout` 3 s | Tod: Auto verlässt die Sim, `killed`; nach 180 Ticks `respawn` an `randomSpawn()` (Abstand zu Mitgliedern **dieses** Rooms), Yaw längs der Straße, `resetVehicle`, HP 100, Mods aus. |
| Score, Kill-Belohnung | unverändert (10 pro Coin, 50 pro Kill) | unverändert |

Kontakt-Events für Effekte: aus `events.carImpact`/`carImpactId` jedes Autos, ab 3 m/s, pro Paar höchstens alle 6 Ticks.

### 5.6 Snapshots senden

- Alle `snapshotEvery` Ticks: Kompaktteil einmal in einen wiederverwendeten Puffer kodieren. Pro Empfänger einen `Buffer` mit Kopf + Self-Block + Kompaktteil (ohne den eigenen Datensatz) erzeugen und senden.
- **Backpressure:** Ist `ws.bufferedAmount > 64 kB`, wird der Snapshot für diesen Empfänger übersprungen (kein Delta, also unschädlich). Nach 5 s dauerhaft über 256 kB wird die Verbindung geschlossen (Grace beginnt).
- `events` gehen vorher als Text an alle Empfänger (gefiltert nach 3.6).

### 5.7 CPU-Budget Server

| Posten | Budget | Grundlage |
|---|---|---|
| `stepWorld` mit 32 Autos | ≤ 0,3 ms | gemessen 0,17 ms (1a, 19) |
| Party-Regeln (Pickups 55 Items × 32 Autos, Timer, Kontakte) | ≤ 0,1 ms | |
| Snapshot (1× Kompaktteil + 32 × Kopf/Self, alle 3 Ticks) | ≤ 0,15 ms pro Snapshot-Tick | |
| **Room-Tick mit 32 Autos gesamt** | **Mittel ≤ 0,5 ms, p99 < 2 ms** (Exit-Kriterium), in der CI p99 < 4 ms (langsame Runner) | Bot-Test misst |
| Prozess mit 4 vollen Rooms | ≤ 15 % eines Kerns | 4 × 60 × 0,5 ms |
| Speicher | stabil über 7 Tage (Phase-4-Exit); in 1b: Bot-Soak 30 min ohne Wachstum > 10 % nach Warm-up | |

Keine Allokationen im heißen Pfad außer den Sende-Puffern; Input-Ringe und Kodier-Puffer sind vorallokiert.

---

## 6. Collider-Welt in shared

Voraussetzung für die Server-Sim: Der Server braucht exakt die Collider, die heute der Client beim Bauen von Stadt und Umgebung in `state.obstacles` schiebt (1a, 7.2 und 18).

- **Neu `src/shared/world/props.ts`:** Platzierung aller kollidierenden Props als Daten (Bänke, Teich, Parkbäume, Palmen, Laternen, Schilderpfosten, Pflanzkübel, Sonnenschirme, Brunnen) aus `CityData`, den Layout-Konstanten und `positionHash`. Der Client rendert seine Props aus diesen Daten, damit Optik und Kollision nicht auseinanderlaufen können.
- **Neu `src/shared/world/colliderGen.ts`:** `buildWorldColliders(world: GeneratedWorld): ColliderInput[]` in der verbindlichen Reihenfolge **Bäume, Felsen, Stadt** (Gebäude, dann die Props in der Reihenfolge der heutigen `push`-Stellen in `city.ts`). Die `top`-Werte kommen aus `COLLIDER_TOPS`.
- **Felsen mit eigenem Zufallsstrom:** `ROCK_COLLIDER_SEED` liefert nur Position und Größe; die Optik (Material, Rotation, y-Skala, zweiter Stein) zieht aus einem abgeleiteten Seed. Die übrige Szenerie (Büsche usw.) bekommt ebenfalls einen eigenen Seed. Die Felsen stehen danach **einmalig an anderen Stellen**. Das ist gewollt (1a, 18: sonst verschiebt jede Optikänderung die Collider) und wird im Commit vermerkt.
- **`MapData`** (`server/maps.ts`, auf dem Client `client/world/mapData.ts`) = `generateWorld(seed)` + `createSimWorld(terrain, buildWorldColliders(world), [], cityRoadGrid())` + `worldHash`.
- **Paritätstest in zwei Schritten:**
  1. Solange die Client-`push`-Stellen noch existieren: E2E-Test vergleicht `__bulliDebug.obstacles()` **Index für Index** mit `buildWorldColliders` für alle Einträge außer den Felsen (Toleranz 1e-9), die Felsen werden als Anzahl und Bereich geprüft.
  2. Danach löscht derselbe Schritt die `push`-Stellen; der Client baut `state.obstacles` nicht mehr, `simWorldClient.ts` nimmt `MapData`. Ab dann sichert ein Node-Golden-Hash über die geordnete Collider-Liste die Parität, und der E2E-Test prüft, dass jedes gerenderte kollidierende Prop an einer Collider-Position steht.
- `obstaclesToColliders` und `Obstacle.top` entfallen danach; `legacyPhysics.ts` (einziger anderer Leser) ist dann schon gelöscht (Abschnitt 12).

---

## 7. Tuning online

- Online gilt nur das Default-Tuning (1a, 18). Das Panel lädt mit `?tune=1` nur noch zusammen mit `?sandbox=1`. Ohne Sandbox zeigt die Seite einen kurzen Hinweis „Tuning nur in der Sandbox“ und lädt das Panel nicht.
- Vor dem `hello` prüft der Client `tuningIsDefault()` und ruft sonst `resetTuning()` auf (z. B. nach HMR mit Panel).
- Die Sandbox bleibt offline und unverändert (eigener `FixedStepLoop`, kein Netz). `LocalVehicle` bekommt dafür zwei Antriebe: `OfflineDriver` (heutiger Pfad) und `NetDriver` (Abschnitt 8).
- Langfristig (nicht in 1b) wird das Tuning als Parameter an `stepWorld` übergeben statt als Modul-Global gelesen.

---

## 8. Client: Prediction und Reconciliation

### 8.1 Module

Die reine Netzlogik ohne DOM und three liegt in **`src/shared/net/`**, damit Node-Tests und die Bots (Abschnitt 15.2) sie unverändert nutzen:

| Datei | Inhalt |
|---|---|
| `shared/net/constants.ts` | Abschnitt 4 |
| `shared/net/codec.ts`, `quant.ts` | Input- und Snapshot-Kodierung, `decodeRemoteState` |
| `shared/net/clock.ts` | `ClockSync` (Proben, Offset, Jitter, `serverTickAt`) |
| `shared/net/leadControl.ts` | Vorlauf-Regler (8.3) |
| `shared/net/prediction.ts` | `Prediction`: Historie, `predictTick`, `reconcile`, Render-Offset |
| `shared/net/contactSet.ts` | Auswahl und Extrapolation der Remote-Autos im Kontaktradius |
| `shared/net/interpolation.ts` | Snapshot-Puffer je Remote-Auto, Hermite, Extrapolation |
| `shared/sim/inputs.ts` | `stopInput`, `applyContactGhostFloor` |

Im Browser kommen dazu `client/net/connection.ts` (WebSocket, Handshake, Reconnect, Sichtbarkeit), `client/net/dispatch.ts` (JSON-Router, ersetzt `network/websocket.ts`), `client/net/netsim.ts` (Abschnitt 11.5), `client/vehicle/NetDriver.ts` (Prediction im Spiel-Frame), `client/vehicle/RemoteVehicle.ts` (Darstellung eines Mitspielers) und `client/party/*` (Coins, Powerups, Projektile, Scoreboard, verschoben aus `world/` und `ui/`).

### 8.2 Tick-Zählung

Der Client simuliert Tick `C` = der Server-Tick, in dem sein Input angewendet wird. `C` läuft der aktuellen Server-Zeit um den **Lead** voraus (≈ RTT/2 + Puffer + halbes Snapshot-Intervall). Ein Input für Tick `C` wird gesampelt, lokal sofort angewendet und mit `tick = C` gesendet. Der Snapshot für `T_s` enthält den Zustand **nach** Tick `T_s`.

### 8.3 Vorlauf-Regelung (Zeitdehnung)

- **Start:** `C = ceil(serverTickAt(now) + rtt/2/DT + bufferTarget)` nach den ersten fünf Pongs.
- **Laufend:** Fehler `e = inputSlack − bufferTarget` (gleitender Mittelwert über 4 Snapshots). Der `FixedStepLoop` bekommt einen Faktor `rate`: Wanduhr-Dauer eines Ticks = DT/`rate`, `rate = 1 − clamp(0,01·e, −0,05, +0,05)`. Zu früh (e > 0) → langsamer ticken, zu spät → schneller. Die Sim rechnet immer mit DT; nur das Tempo der Ticks in Wanduhrzeit ändert sich um höchstens ±5 %, was niemand sieht.
- **Harter Resync:** bei |e| > 8 Ticks oder `inputSlack = −128` über 1 s nach vorhandener Verbindung: `C` auf den Sollwert setzen, Historie leeren, Zustand beim nächsten Snapshot hart übernehmen (Snap, kein Offset).
- `?debug=net` zeigt Lead, Slack, `rate` und Resyncs.

### 8.4 Historie, Predict, Reconcile

```ts
interface HistoryEntry {           // Ring mit HISTORY_TICKS Einträgen, Index tick & 127
    tick: number; seq: number;
    input: VehicleInput;           // Kopie
    state: VehicleState;           // vorhergesagter Zustand NACH diesem Tick (copyVehicleState)
}
```

**Pro Client-Tick C** (`NetDriver.tick`):

1. `input = inputManager.sampleTick()`, bei Modal/Kontextverlust `stopInput(state)` und `FROZEN`.
2. Mods für C aus den bekannten Fenstern: Powerups aus `pickup`-Events (`startTick ≤ C < endTick`), Schild und Ghost-Floors aus den Flags des letzten Snapshots (für alle Ticks nach T_s konstant gehalten).
3. `cars = [eigenes Auto, …Kontakt-Set]`, Remote-Autos darin mit ihrem wiederholten letzten Input; `stepWorld(cars, world)`.
4. Historie[C] = Input + Zustand; Input in das nächste Paket.

**Pro Snapshot mit T_s** (`Prediction.reconcile`):

1. Historie bis `T_s` abschneiden (alles ≤ T_s ist beim Server erledigt, verwendet oder durch Wiederholung ersetzt). `lastProcessedSeq` < `seq` von Historie[T_s] zeigt, dass der Server wiederholt hat → Metrik „verlorene Inputs“.
2. **Vergleich:** Weicht Historie[T_s].state vom Self-Block um weniger als 1 mm (Position), 1 mm/s (Geschwindigkeit) und 1e-4 rad (Yaw) ab **und** ist das Kontakt-Set leer, wird nichts neu gerechnet (häufigster Fall ohne Kontakt).
3. **Sonst Replay:** Render-Pose des aktuellen Ticks merken (`before`). Eigenes Auto := Self-Block. Kontakt-Set-Autos := `decodeRemoteState` ihres Datensatzes aus diesem Snapshot. Dann für `t = T_s+1 … C`: Input aus Historie[t], Mods für t, Remote-Autos mit Input-Repeat, `stepWorld`, Historie[t].state überschreiben.
4. **Offset:** `offset += before − after` (Position x, y, z und Yaw über den kürzesten Bogen). Ist |Positionsoffset| ≥ 4 m oder |Yaw-Offset| ≥ 45°: Offset = 0 (Snap), Kamera-Snap.
5. Snapshot nicht älter als der zuletzt verarbeitete (TCP ordnet, aber nach einem Resync können alte im Puffer liegen).

**Render-Offset:** Die dargestellte Pose ist interpolierte Sim-Pose + Offset. Der Offset klingt exponentiell ab, `τ = 100 ms + 100 ms · clamp(|offset|/2 m, 0, 1)`, also 100–200 ms; unter 1 mm wird er 0. Nach einer Korrektur mit Auto-Kontakt in den letzten 300 ms gilt dasselbe τ, der Offset wird aber spätestens 300 ms nach seinem Entstehen auf 0 gesetzt (Plan 6: „nie länger als 300 ms“). Kamera, Nametag und Effekte folgen der dargestellten Pose, die Sim nie.

**Spawn, Respawn, Wagenwechsel:** Das Event bringt Tick `T0` und Pose. Der Client setzt den Zustand zum Tick T0 mit `placeVehicle`/`resetVehicle` (dieselben shared-Funktionen wie der Server) und spielt T0+1 … C aus der Historie nach. Vor dem ersten `spawn` sagt er nichts voraus.

**Determinismus-Anspruch:** Im selben JS-Motor (Node-Tests) ist die Vorhersage ohne Kontakt und ohne verlorene Inputs **bitgleich** mit dem Server; der Test prüft Korrektur = 0 exakt. Zwischen V8/JSC im Browser und Node auf Linux entstehen Ulp-Abweichungen (1a, 24.2), die über ≈ 11 Replay-Ticks im Bereich 1e-12 m bleiben. Der Kipppunkt bei exakt vtop (1a, 24.2) wird über die Korrektur-Metrik beobachtet, aber nicht geändert.

### 8.5 Kontakt-Set (Remote-Autos in der lokalen Prediction)

- **Auswahl bei jedem Snapshot:** Remote-Autos mit `d < 15 m + |v_rel| · Lead_s` (höchstens 45 m), verlassen erst bei +5 m (Hysterese), höchstens die 6 nächsten. Die Plan-Angabe „ca. 15–20 m“ gilt für langsame Autos; bei 2 × 85 m/s frontal schließen Autos in 250 ms 42 m, deshalb wächst der Radius mit der Relativgeschwindigkeit.
- **Extrapolation:** Ausgehend vom Snapshot-Zustand werden sie in der lokalen Prediction als **dynamische** Sim-Autos (`kinematic = false`) mit ihrem zuletzt bekannten Input (Input-Repeat) auf den Tick C vorausgerechnet, zusammen mit dem eigenen Auto. Ein Stoß wirkt dadurch lokal sofort und auf beide.
- **Grenze 250 ms:** Liegt `C − T_s` über 15 Ticks, rechnet der Client den Remote-Wagen nur bis `T_s + 15` mit Input-Repeat und danach mit konstantem Tempo als kinematisches Auto weiter. **Weicher Kontakt bei hoher RTT:** `contactScale` des Remote-Autos = 1 bis Lead 9 Ticks (150 ms), linear auf 0,5 bei 15 Ticks, darüber 0,5. Die endgültige Wirkung kommt vom Server.
- Party-Ghost, Idle, Lag und Respawn-Schild wirken über Mods, Flags und `applyContactGhostFloor` wie auf dem Server.
- **Kosten:** Replay ≈ Lead in Ticks (bei 150 ms RTT ≈ 11) × (1 + ≤ 6) Autos pro Snapshot. Gemessen in 1a: 6 Autos ≈ 0,02 ms pro Tick in Chromium → ≈ 0,25 ms pro Snapshot, 5 ms/s; auf dem Handy mit Faktor 4 ≈ 20 ms/s (2 % eines 60-FPS-Frame-Budgets). Autos außerhalb des Sets werden nie mitsimuliert.

### 8.6 Remote-Autos darstellen (`RemoteVehicle`)

- **Fern (nicht im Kontakt-Set): Hermite-Interpolation mit 100 ms Verzögerung.** Renderzeit `r = serverTickAt(now) − INTERP_DELAY_TICKS` (in Ticks mit Bruchteil). Puffer der letzten 8 Proben `{tick, x, y, z, yaw, v, yawRate, flags}`. Zwischen den beiden Proben um `r` kubisch Hermite für x, y, z mit den Geschwindigkeiten als Tangenten, Yaw über den kürzesten Bogen mit `yawRate` als Tangente. Liegt `r` hinter der neuesten Probe, linear extrapolieren bis 250 ms, dann halten. Trifft danach eine Probe ein, wird die Differenz wie beim eigenen Auto als Offset (τ 100 ms) abgebaut. Sprung > 20 m oder `respawn`: Snap.
- **Adaptive Verzögerung:** Liegt der Anteil der Frames mit Extrapolation über 5 % (Jitter, TCP-Stau), steigt die Verzögerung schrittweise bis 9 Ticks (150 ms) und sinkt nach 10 s ohne Mangel wieder.
- **Nah (im Kontakt-Set):** Darstellung mit der vorhergesagten Pose aus 8.5, interpoliert mit dem `alpha` des eigenen Autos, plus eigenem Offset bei Korrekturen. So stimmen sichtbarer und gespürter Kontakt überein.
- **Überblendung:** Gewicht `w` wandert beim Eintritt in 300 ms von 0 auf 1, beim Austritt zurück; Pose = Lerp(interpoliert, vorhergesagt, w), Yaw über den kürzesten Bogen.
- Räder, Lenkeinschlag (`steerAngle`), Drift-Rauch (`drifting`), Boost-Feuer (`boosting`), Mega-Skala (`scale`), Salto (`flipAngle`), Schild, Ghost und Idle-Grau kommen aus dem Datensatz. Nametag und Kontaktschatten folgen der dargestellten Pose.

### 8.7 Party auf dem Client

- **Coins:** optimistisch wie heute: Berührt die vorhergesagte Pose einen Coin (3 m, Magnet 6 m), verschwindet er sofort mit Ton und Partikeln. Kommt binnen 600 ms kein `pickup` mit dieser `itemId`, erscheint er wieder. Keine `collect`-Nachricht mehr.
- **Powerups:** Wirkung erst mit dem `pickup`-Event (sie ändert die Mods und damit die Prediction). Die Reconciliation spielt ab `startTick` mit den neuen Mods nach; die kleine Korrektur wird geglättet. HUD-Timer aus `endTick − C`.
- **Schüsse:** unverändert lokal dargestellt, Treffer gegen die **dargestellten** Remote-Posen, dann `shoot {targetId}`; Entscheidung und Schaden vom Server (`hit`).
- **Mega-Ram:** kein Client-Code mehr; Ton und Hitmarker beim `hit` mit `cause: 'ram'`.
- Der alte AFK-Code in `main.ts` entfällt, das Grau kommt aus dem Flag `idle`.

---

## 9. Welt, Menü und Room-Wechsel im Client

- **Splash-Screen:** zusätzlich Umschalter „PARTY | FREE ROAM“ (Standard Party, gemerkt in `localStorage['bulli-room-kind']`), groß genug für Touch.
- **Im Spiel:** im ABOUT-/Menü-Fenster „Modus wechseln“; das HUD zeigt den Room (`Party · 1`).
- `body.room-freeroam` blendet Party-Elemente aus (HP-Leiste, Scoreboard, Schuss-Button und E-Hinweis, Powerup-Anzeige, Coins und Powerup-Marker).
- Beim Wechsel bleibt die Szene (gleiche Karte, `worldHash` gleich); nur Items, Mitglieder und Netzzustand werden neu aufgebaut.

---

## 10. Legacy-Physik wird in 1b gelöscht

Mit server-autoritativem Netz ist der client-autoritative Pfad nicht mehr kompatibel: Die Legacy-Physik schickt Positionen, der Server nimmt ab 1b nur noch Inputs an und rechnet selbst mit der v2-Sim. Ein Legacy-Client hätte keine Prediction, würde vom Server ständig überschrieben und bräuchte einen zweiten Protokollpfad. Deshalb wird der Notausgang `?physics=legacy` gelöscht, bevor das Netz umgestellt wird (Umsetzungsschritt 2). v2 läuft seit dem Livegang ohne bekannte Probleme.

Gelöscht werden:

- `client/vehicle/legacyPhysics.ts`, `PHYSICS_LEGACY`/`PHYSICS_V2` in `flags.ts` (v2 ist dann einfach „die Physik“) und das Auswerten von `?physics=`
- die Legacy-Zweige in `controls/keyboard.ts`, `controls/mobile.ts` (Filter 18/s), `main.ts` (`updateChaseCamera` mit `SPEED_BOOST_FACTOR`, Legacy-Mega-Ram, AFK-Hack erst in Schritt 8c), `ui/hud.ts` und `ui/speedoScale.ts` (Skala 400 km/h), `entities/Bulli.ts` (Legacy-Bewegung, Timer pro Frame), `e2eHook.ts` (`physics`), `debug/perfMonitor.ts` (`sim: null`)
- `LEGACY_CAMERA` in `camera/ChaseCamera.ts` und der Profilwechsel im Panel
- `.legacy-only` in `index.html` und `style.css`; `body.physics-v2` und `.v2-only` werden zu normalen Regeln
- in `shared/constants.ts`: `LEGACY_SPEED_TICKS_PER_SECOND`, `LEGACY_CAR_MAX_SPEED`, `SPEED_BOOST_FACTOR`
- die Legacy-E2E-Tests (`desktop.spec.ts`, `mobile.spec.ts`, `multiplayer.spec.ts` in ihrer Legacy-Form, Legacy-Teile von `physics-default.spec.ts` und `perf-overlay.spec.ts`), `--physics=legacy` in `perf-baseline` und `screenshots`
- in Schritt 8a mit dem Protokoll: die Nachricht `update` in beide Richtungen, `sendMovementSnapshot`, `remoteProxies.ts` (1a, 8.5) und `PROXY_CONTACT_SCALE`; `kinematic` und `contactScale` bleiben in der Sim (Kontakt-Set, 8.5)

Die Adapterfelder von `Bulli` (`speed` in u/Tick, `maxSpeed`) bleiben in 1b, weil HUD, Motorsound und Partikel sie lesen; ihre Umstellung auf m/s ist ein eigener Aufräumpunkt nach 1b. Die offene Aufgabe „E2E für eine gemischte Session aus v2 und Legacy“ (1a, 22.4) entfällt.

---

## 11. Robustheit und Betrieb

### 11.1 Session-Token, Grace, Reconnect

- **Token:** 128 Bit Zufall (base64url) aus `crypto.randomBytes`, in `welcome`, beim Client in `sessionStorage['bulli-session']` (pro Tab; zwei Tabs = zwei Spieler wie heute).
- **Verbindungsabbruch** (Close, Heartbeat-Timeout): Die Session bleibt 30 s bestehen. Das Auto bleibt im Room als **Idle-Ghost** (Stopp-Input, Flag `idle`), damit andere nicht gegen ein führerloses Auto prallen, aber sehen, wo es steht. Nach 30 s: `leave`, Session gelöscht.
- **Wiederaufnahme:** `hello` mit gültigem Token einer Session in Grace → dieselbe `playerId`, derselbe Slot, dasselbe Auto, Party-Zustand erhalten, `welcome {resumed: true}` + `roomState`. Der Client übernimmt den Zustand beim ersten Snapshot hart (Snap).
- **Duplizierte Tabs** kopieren `sessionStorage`. Ist die Session des Tokens noch verbunden, entscheidet `connId`: gleich (dieselbe Seite, alter Socket tot, aber noch nicht erkannt) → Übernahme, der alte Socket wird mit 4005 geschlossen; verschieden (duplizierter Tab) → neue Session.
- **Heartbeat:** WebSocket-Ping alle 10 s (bisher 30 s), Terminate ohne Pong nach weiteren 10 s. Hält auch Proxys mit Idle-Timeout (Cloudflare 100 s) offen, wenn ein Tab im Hintergrund keine Inputs schickt.
- **Reconnect mit Backoff (Client):** 0,5 s, 1 s, 2 s, 4 s, dann alle 8 s, jeweils ±20 % Zufall, unbegrenzt. Nach Close 1012 (Neustart) erster Versuch nach `shutdown.reconnectInMs` (Standard 1,5 s). Ab 1 s Trennung Overlay „Verbindung wird wiederhergestellt …“ (Touch-tauglich, mit Button „Neu laden“ nach 30 s). Während der Trennung sagt der Client höchstens 250 ms voraus und hält das Auto dann an; Remote-Autos frieren nach der Extrapolation ein.
- **Close-Codes:** 4000 Version (Reload), 4001 Hello fehlt/ungültig, 4002 voll, 4003 Policy (Flut, ungültig), 4004 Idle-Kick, 4005 Session übernommen, 1012 Neustart, 1001 Server fährt herunter. Automatischer Reconnect bei 1006, 1012, 1001; bei 4003 und 4005 nur per Button.

### 11.2 Graceful Shutdown

- `SIGTERM`/`SIGINT` → keine neuen Verbindungen (`server.close()`), Scheduler stoppt nach dem laufenden Tick, an jeden Client `shutdown {reconnectInMs: 1500, resume}`, 300 ms warten (Senden abschließen), alle Sockets mit 1012 schließen, `process.exit(0)` spätestens nach 5 s (Docker wartet standardmäßig 10 s).
- `uncaughtException`/`unhandledRejection` → loggen, `exit(1)`; die Restart-Policy startet neu.

### 11.3 Resume-Ticket über Neustarts

Ein Neustart verliert alle Sessions im Speicher. Damit Spieler nach einem Deploy nicht ihren Party-Score verlieren:

- `shutdown.resume` ist ein Ticket `base64url(payload).base64url(HMAC-SHA256(payload, SESSION_SECRET))`, `payload = {v: 1, name, color, carType, profile, roomKind, score, exp: jetzt + 120 s}`. Der Client legt es in `sessionStorage` ab und schickt es im nächsten `hello` mit.
- Der neue Prozess prüft Signatur und Ablauf und übernimmt Farbe und (im Party-Room) den Score. HP starten voll, das Auto spawnt neu.
- `SESSION_SECRET` kommt aus der Umgebung (in Dokploy als Secret setzen). Fehlt es, erzeugt der Prozess einen Zufallswert; Tickets eines früheren Prozesses sind dann ungültig, und der Spieler startet mit Score 0 (Name und Karosse kommen ohnehin aus `localStorage`). Kein Volume nötig.

### 11.4 `/healthz`, Docker, Restart-Policy

- **`GET /healthz`** → 200 mit `{ok, uptimeS, build, rooms, players, lastTickAgeMs, tickP99Ms}`, wenn der letzte Scheduler-Tick weniger als 1000 ms her ist, sonst 503. Blockiert die Event-Loop, antwortet der Endpunkt gar nicht (Timeout) und gilt ebenfalls als ungesund. `no-store`.
- **Dockerfile:** `HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 CMD wget -qO- http://127.0.0.1:${PORT:-8000}/healthz || exit 1` (BusyBox-`wget` ist in `node:22-alpine` vorhanden).
- **Restart-Policy:** Dokploy betreibt Anwendungen als Docker-Swarm-Service; Swarm ersetzt einen als `unhealthy` markierten Task automatisch und startet nach einem Exit neu. Für Betrieb mit `docker run`/Compose steht `restart: unless-stopped` in der Doku (`docs/ops.md`, neu); ein reines `docker run` startet bei `unhealthy` nicht neu, das wird dort genannt. Offene Frage 8 des Plans (Hoster-Details) ist damit für den Neustart beantwortet.
- **CI-Container-Smoke** prüft `/healthz` (200, `ok: true`) statt `/build-version.txt` und zusätzlich, dass `docker stop` den Container innerhalb von 6 s mit Exit-Code 0 beendet (Graceful Shutdown).

### 11.5 Dev-Netsim

- **Client:** `?netsim=RTT,JITTER,LOSS[,MODE]`, z. B. `?netsim=150,30,3`. RTT wird auf beide Richtungen halbiert (je 75 ms), Jitter gleichverteilt ±Jitter/2 pro Richtung, Verlust in Prozent pro Nachricht. `MODE = tcp` (Standard): Ein „verlorenes“ Paket kommt um 200 ms + RTT später, und alle folgenden Nachrichten derselben Richtung warten dahinter (Head-of-Line wie bei TCP, Reihenfolge bleibt). `MODE = drop`: Nachricht wird verworfen (nur für Robustheitstests; Snapshots und Inputs dürfen fehlen, Events nicht, deshalb verwirft `drop` nur Binärrahmen). Das Flag wirkt in jedem Build, betrifft nur den eigenen Tab und ist deshalb auch live zum Testen erlaubt. `?debug=net` zeigt die aktive Netsim.
- **Server:** ENV `NETSIM="rtt=150,jitter=30,loss=3,mode=tcp"`, gleiche Semantik pro Verbindung. Wirkt nur, wenn `NODE_ENV !== 'production'` oder `NETSIM_ALLOW=1`.
- Beide addieren sich, wenn beide aktiv sind.

### 11.6 Anti-Cheat

Implizit durch die Server-Sim: Der Client liefert nur Inputs im gültigen Wertebereich, also keine Teleports, kein Tempo über der Physik, keine Wandfahrten. Pickups und Treffer entscheidet der Server gegen seinen Zustand. Bleiben: Input-Flut (Rate-Limit, 5.2), Inputs aus der Zukunft (Tick-Fenster), ungültige Werte (Schema, Klemmung, Kick nach 10 Fehlern), Schussrate (Cooldown in Ticks), Aimbot-artige Schüsse (Reichweite 150 m; bewusst nicht weiter geprüft, Party ist ein Spaßmodus).

---

## 12. Metriken und Debug

- `?debug=net` (Overlay, neben `?debug=perf`): RTT, Jitter, Lead, Slack, `rate`, Snapshots/s, Korrektur pro Snapshot (Mittel und Maximum in cm, ohne und mit Kontakt getrennt), Snaps, Replay-Ticks pro Snapshot, Größe des Kontakt-Sets, verlorene Inputs, Bandbreite ein/aus (Text und Binär getrennt), aktive Netsim.
- `window.__bulliNet` (nur mit `?e2e=1`): dieselben Werte als Objekt für Tests.
- Server: `metrics` (Tick-Histogramm, Overruns, Bytes pro Room, Kicks) im `/healthz`-Ergebnis zusammengefasst, ausführlich unter `/metrics.json` nur mit `METRICS=1`.

---

## 13. Budgets

### 13.1 Bandbreite pro Client (Downlink, 32 Spieler im selben Room, alle im Snapshot)

| Posten | Größe | pro Sekunde |
|---|---|---|
| Kopf | 16 B | |
| Self-Block | ~150 B | |
| 31 Kompakt-Datensätze | 31 × 32 B = 992 B | |
| **Snapshot** | **≈ 1 160 B** × 20 Hz | **≈ 23,2 kB/s** |
| WebSocket-Rahmen (4 B) | | 0,1 kB/s |
| Events, Scoreboard, Pong (Schätzung Party mit viel Action) | | ≈ 1,5 kB/s |
| **Summe Nutzdaten** | | **≈ 25 kB/s ≤ 30 kB/s** |
| TCP/IP-Header (~20 Segmente × 52 B), nicht im Budget | | ≈ 1 kB/s |

Uplink: ≈ 1,7 kB/s (Inputs 60 Hz) + Pings. Server gesamt bei einem vollen Room ≈ 32 × 25 kB/s ≈ 0,8 MB/s (6,4 Mbit/s). Zum Vergleich heute (Phase 0): 8 Spieler ≈ 28 kB/s pro Client, quadratisch wachsend.

**Reserve, falls Messungen es verlangen** (nicht in 1b gebaut): Autos über 250 m nur jeden zweiten Snapshot (Interest-Staffelung, Phase 4), Kompaktdatensatz ohne `rearGrip`/`loadX`/`boostMeter` für ferne Autos (−3 B).

### 13.2 CPU Client

| Posten | Budget (Referenz-Handy, Tier low) |
|---|---|
| eigene Prediction 60 Hz (1 + Kontakt-Set) | ≤ 0,2 ms pro Frame |
| Replay pro Snapshot (≤ 15 Ticks × ≤ 7 Autos) | ≤ 1 ms, im Mittel ≤ 0,3 ms |
| Interpolation aller Remote-Autos | ≤ 0,2 ms pro Frame bei 31 Autos |
| Dekodieren eines Snapshots | ≤ 0,1 ms |
| **Netz-Code gesamt** | **p95 ≤ 1 ms pro Frame** |

Server: Abschnitt 5.7.

---

## 14. Offene Punkte aus 1a und ihre Lösung

| 1a | Punkt | Lösung in 1b |
|---|---|---|
| 18 | Snapshot-Felder (Pose, Filter, Flags, Gameplay, letzter Input, Mods) | Self-Block voll (3.4), Codec-Test über alle Zustandsschlüssel |
| 18 | Assist-Profil und Klasse gehören zu den Server-Settings | `hello`/`setCar` (3.2, 5.3) |
| 18, 24.2 | Ulp-Abweichungen V8/JSC/Node | Reconciliation fängt sie; Metrik; Node-Test bitgleich |
| 18, 23.5 | Globales Tuning | online nur Default, Panel nur in der Sandbox, `tuningIsDefault` vor `hello`, Server bricht bei Abweichung ab (7, 5.3) |
| 18, 23.5 | Einfrieren (Modal, Tod, Kontextverlust) | Client tickt mit Stopp-Input + `FROZEN`, Server Idle-Ghost; Tod ist Server-Zustand (5.4) |
| 18, 23.5 | Fels-RNG und Collider-Reihenfolge | eigener Strom, Reihenfolge Bäume–Felsen–Stadt als Vertrag, Paritätstest Index für Index (6) |
| 18, 23.2 | NaN | Validierung am Protokollrand (3.1) zusätzlich zur Sim-Absicherung |
| 23.3 | Powerup-Timer bei eingefrorener Sim | Timer laufen auf dem Server in Ticks, unabhängig vom Client |
| 8.5 | halbseitiger Kontakt gegen Proxies, Legacy-Mega-Ram | beidseitiger Kontakt im Server; Kontakt-Set (8.5); Ram aus Impuls (5.5) |
| 24.2 | Kipppunkt bei exakt vtop | beobachtet, nicht geändert |
| 22.4 | E2E gemischte Session v2/Legacy | entfällt (10) |

---

## 15. Testplan

### 15.1 Unit (Vitest, `tests/shared/net/*`, `tests/server/*`)

- **Protokoll/Codec:** Round-Trip für Input (n = 1…8, Grenzen der Wertebereiche, Tick-Sprung) und Snapshot (0, 1, 32 Autos; Self-Block bitgleich; Kompaktwerte innerhalb der halben Quantisierungsstufe); `decodeRemoteState` liefert endliche, vollständige Zustände; kaputte Längen, zu große `count`, NaN im Self-Block → abgewiesen. Test über alle Schlüssel von `createVehicleState()`. valibot-Schemas aller JSON-Nachrichten mit gültigen, ungültigen und NaN-Feldern.
- **Tick-Scheduler:** mit falscher Uhr: 60 Ticks pro Sekunde über 10 min ohne Drift, höchstens 4 Nachhol-Ticks, Hänger > 250 ms springt.
- **InputBuffer:** spät/zu früh/doppelt, Wiederholung genau 15 Ticks, danach `stopInput`; `stopInput` bremst aus 30 m/s und aus −10 m/s bis zum Stand und fährt nicht rückwärts an; Klemmung; `inputSlack`/`bufferTarget`.
- **Room/Party:** Join/Leave/Wechsel mit Slots; Instanzen (33. Spieler → `party-2`, Schließen nach 60 s leer); Powerup-Fenster; Pickup-Radien; Schuss-Regeln wie `tests/server/handlers.test.ts` heute, portiert auf Ticks; Mega-Ram-Schaden aus Δv (unter 4 m/s kein Schaden, 10 m/s = 25, Cooldown 60 Ticks); Respawn-Schild; Idle-/Lag-Ghost.
- **Reconciliation deterministisch mit simulierter Latenz** (`tests/shared/net/reconcile.test.ts`): Room (ohne WebSocket, mit `Transport`-Attrappe) und zwei `Prediction`-Clients in einer Tick-Schleife, Nachrichten in einer Verzögerungs-Warteschlange (Tick-basiert, Seed-gesteuert):
  1. 0 Latenz, keine Kontakte → Korrektur exakt 0 über 1 000 Ticks.
  2. 9 Ticks je Richtung, Jitter ±2, keine Verluste, kein Kontakt → Korrektur exakt 0 (bitgleich, gleicher Motor).
  3. Wie 2 mit 3 % Verlust (TCP-Modus) → mittlere Korrektur < 10 cm, keine Snaps.
  4. Frontal, T-Bone und PIT zwischen den beiden Clients → beide sehen den Stoß im ersten vorhergesagten Tick nach dem Kontakt; nach ≤ 300 ms ist der Render-Offset 0; Server-Endzustände wie beim Golden-Szenario ohne Netz (Toleranz 1e-9).
  5. Pickup mit Turbo während der Latenz → eine Korrektur, danach wieder 0.
  6. Harter Resync bei Uhrsprung.
- **Clock/Lead:** Konvergenz auf `bufferTarget` in < 3 s bei RTT 20–300 ms; `rate` bleibt in ±5 %.
- **Interpolation:** Hermite trifft die Stützstellen exakt, Yaw über ±π, Extrapolation endet nach 250 ms, Snap ab 20 m.
- **Collider-Parität:** Golden-Hash der geordneten Collider-Liste, Felsen nicht in Gebäuden oder auf Straßen.

### 15.2 Integration mit Bot-Clients (`tools/bots`, `tests/integration/*`)

- **`tools/bots/bot.ts`:** headless Node-Client über echte WebSockets (`ws`), nutzt `shared/net` (Codec, Clock, Lead, Prediction) unverändert, keine three/DOM-Abhängigkeit.
- **Fahren:** Pure Pursuit über das Straßennetz aus `cityRoadGrid()`: zufällige Route über Kreuzungen, Zielpunkt 12 m + 0,4 s·v voraus, Wunschtempo 20–35 m/s, vor 90°-Kurven 12 m/s. Modus `ram`: sucht das nächste Auto und fährt es an. Modi `idle`, `reconnect` (Socket hart schließen, nach 1–5 s mit Token zurück), `hop` (Room-Wechsel alle 20 s), `flood` (Manipulation).
- **CLI:** `npm run bots -- --url ws://127.0.0.1:8500/ws --count 32 --mix drive:24,ram:6,reconnect:1,hop:1 --netsim 150,30,3 --duration 120`.
- **CI-Test** (`npm run test:integration`, eigener Job): Server im Prozess auf Port 0, 8 Bots, 30 s, Netsim 150/30/3 TCP. Prüft:
  - jeder Bot bekommt ≥ 18 Snapshots/s, keine nicht endlichen Werte;
  - mittlere Korrektur ohne Kontakt < 10 cm, Snaps nur nach Reconnect/Resync;
  - mindestens 3 Kontakt-Events, bei denen beide Autos laut Server eine Geschwindigkeitsänderung ≥ 3 m/s haben;
  - Reconnect innerhalb der Grace → gleiche `playerId` und gleicher Slot; nach 30 s ohne Rückkehr verschwindet das Auto;
  - Room-Wechsel: der Bot taucht im neuen Room auf und in den Snapshots des alten nicht mehr;
  - Flood-/NaN-Bot wird gekickt, alle anderen Bots behalten ihre Snapshot-Rate;
  - Tick p99 < 4 ms (CI), Downlink pro Bot < 30 kB/s.
- **Manuell/nächtlich:** 32 Bots, 10 min, Tick p99 < 2 ms, Downlink ≤ 30 kB/s; Soak 30 min ohne Speicherwachstum > 10 % nach Warm-up.

### 15.3 E2E (Playwright)

- **`net-contact.spec.ts` (Desktop):** zwei Browser-Kontexte im selben Party-Room. Mit `debugPlace` (nur bei `E2E=1` im Server) stehen die Autos 20 m frontal voreinander; A fährt Vollgas, B steht. Beide Seiten sehen die Wirkung: Bei A sinkt die eigene Geschwindigkeit, bei B steigt sie (aus `__bulliNet`/Snapshot), und jede Seite sieht das andere Auto verschoben. Einmal ohne und einmal mit `?netsim=150,30,3` auf beiden Seiten.
- **`net-mobile.spec.ts` (iPhone 13):** Touch-Client verbindet, fährt mit Auto-Gas, bekommt Snapshots, das Touch-HUD zeigt den Room; Overlay bei Trennung überdeckt keine Bedienelemente.
- **`net-reconnect.spec.ts`:** eigener Server auf einem freien Port: SIGTERM → Overlay → Neustart → der Client ist binnen 5 s wieder im Spiel (mit Resume-Ticket gleicher Score).
- **`net-version.spec.ts`:** ein `hello` mit Version 1 wird mit 4000 abgelehnt, der Client lädt einmal neu.
- **`rooms.spec.ts`:** Splash mit FREE ROAM → keine Party-HUD-Elemente; Wechsel im Menü zurück zur Party.
- Bestehende v2-Tests laufen weiter (Sandbox offline unverändert; Multiplayer-Tests auf das neue Protokoll umgestellt).

### 15.4 Test-Hooks

- `debugPlace {x, z, yaw}` nimmt der Server nur an, wenn er mit `E2E=1` läuft (Playwright-`webServer.env`); sonst ist die Nachricht ungültig (zählt als Policy-Fehler).
- `__bulliDebug.placeLocalCar` schickt online `debugPlace` statt die Sim lokal zu versetzen.

---

## 16. Exit-Kriterien (aus dem Plan, präzisiert)

- Bei 150 ms RTT, 30 ms Jitter und 3 % Verlust (Netsim TCP) fährt sich das eigene Auto ohne sichtbares Rubberbanding: **mittlere Korrektur ohne Kontakt < 10 cm**, gemessen im Bot-Test und im Playtest-Overlay. Remote-Autos laufen flüssig (Extrapolationsanteil < 5 %).
- Rempeln fühlt sich für beide Seiten nachvollziehbar an: Playtest Desktop gegen Handy, beide mit Netsim 150/30/3.
- Server-Tick mit 32 Autos p99 < 2 ms (Referenz lokal), Downlink ≤ 30 kB/s pro Client.
- Reconnect innerhalb von 30 s behält den Spieler; Container-Neustart trennt nur kurz; hängender Tick fällt über `/healthz` auf und führt zum Neustart.
- Party-Modus spielbar wie vorher (Schießen, Coins, Powerups, HP, Scoreboard, Mega-Ram), FreeRoam wählbar, alles auch auf dem Handy.
- Legacy-Physik und altes `update`-Protokoll sind gelöscht.

---

## 17. Umsetzungsreihenfolge

Jeder Schritt ist ein Commit (oder eine kleine Folge) mit grünem `npm run ci` und grüner E2E-Suite; das Spiel ist nach jedem Schritt vollständig spielbar. **Merge-Punkte** (Squash auf `main`, geht live) sind markiert.

1. **Spezifikation** (dieses Dokument). *Merge-Punkt A.*
2. **Legacy-Physik löschen** (Abschnitt 10 ohne die Protokollteile). Das Spiel ist danach v2-only, Protokoll unverändert. *Merge-Punkt B.*
3. **Collider-Welt nach shared** (Abschnitt 6): `props.ts`, `colliderGen.ts`, Fels-Seeds, Paritäts-E2E, dann Client auf `MapData` umstellen und `push`-Stellen löschen; Golden-Hash. Einzige sichtbare Änderung: Felsen stehen anders. *Merge-Punkt C.*
4. **Rooms serverseitig** (Abschnitt 2): `Session`, `Room`, `PartyRoom` (heutige Handler und Welt als Instanzfelder, Timer noch als `setTimeout`), `RoomManager` mit 32er-Limit und Instanzen; weiterhin Protokoll v1, nur `party`. Server-Tests portiert. *Merge-Punkt D.*
5. **Betrieb:** `/healthz`, `HEALTHCHECK`, Graceful Shutdown (Close 1012), Heartbeat 10 s, `uncaughtException` → Exit, CI-Smoke auf `/healthz` und `docker stop`, `docs/ops.md`. *Merge-Punkt E.*
6. **`shared/net` pur:** Konstanten, Codec, Quantisierung, Clock, Lead-Regler, InputBuffer, `stopInput`, `applyContactGhostFloor`, Prediction, Kontakt-Set, Interpolation, mit allen Unit-Tests aus 15.1 inklusive Reconciliation mit simulierter Latenz (gegen einen Test-Room). Nicht verdrahtet, keine Verhaltensänderung. *Merge-Punkt F.*
7. **Handshake v2:** `hello`/`welcome`/`reject`, `PROTOCOL_VERSION = 2`, Session-Token (noch ohne Grace), Welt aus dem Seed mit `worldHash`, `roomState`; Gameplay noch über `update`. Tuning-Sperre online (Abschnitt 7).
8. **Die Umstellung** (in dieser Reihenfolge auf dem Branch, gemeinsam gemergt):
   - 8a. Server-Tick-Scheduler, `Room.step` mit `stepWorld`, Input-Uplink binär, Snapshots binär, Events; Client `NetDriver` mit Prediction/Reconciliation/Render-Offset, Remote-Autos zunächst linear interpoliert (100 ms); `update`, `remoteProxies.ts`, `sendMovementSnapshot` gelöscht. Party-Regeln noch mit den alten Timern, aber gegen Server-Positionen.
   - 8b. Dev-Netsim Client und Server, `?debug=net`, `__bulliNet`.
   - 8c. Party-Regeln im Tick (5.5): Timer in Ticks, Pickups serverseitig, Mega-Ram aus Kontaktimpuls, Respawn-Schild, Tod/Respawn; Idle/Sichtbarkeit/Einfrieren/Lag-Ghost (5.4); AFK-Hack gelöscht.
   - 8d. Remote-Darstellung vollständig: Hermite mit adaptiver Verzögerung, Kontakt-Set mit Extrapolation und Überblendung, weicher Kontakt bei hoher RTT; E2E `net-contact.spec.ts` mit und ohne Netsim; Bot-Grundgerüst mit 8 Bots in der CI.
   - *Merge-Punkt G* nach 8d: vollständiger Multiplayer mit Party-Modus auf dem neuen Netz.
9. **Reconnect:** Grace 30 s, `connId`-Regel, Backoff, Overlay, Close-Codes, `shutdown`-Nachricht mit Resume-Ticket (`SESSION_SECRET`); E2E Reconnect und Version. *Merge-Punkt H.*
10. **FreeRoamRoom und Menü:** Room-Wahl im Splash, Wechsel im Spiel, `body.room-freeroam`, automatische Instanzen im Client sichtbar; `rooms.spec.ts`. *Merge-Punkt I.*
11. **Bots vollständig und Budgets:** alle Bot-Modi, `npm run bots`, Integrationstest-Job in der CI, 32-Bot-Messung und Soak lokal, Werte in `docs/baseline.md`; Plan-Status und ein Abschnitt „Umsetzung: Abweichungen und Messwerte“ in diesem Dokument. *Merge-Punkt J* = Phase 1b fertig.

**Stand der Umsetzung:** Schritt 3, Schritt 4 und der Room-Teil von Schritt 10 (FreeRoamRoom, Auswahl im Splash, Wechsel im Spiel) sind als ein Arbeitsschritt „Rooms und Collider“ vor Schritt 2 umgesetzt, noch auf Protokoll v1 (Abschnitt 20.1). Danach folgten im Arbeitsschritt „Server-Sim und Protokoll“ Schritt 2, Schritt 7, 8a und 8c vollständig sowie Teile von 6, 8b und 8d (Abschnitt 20.2). Der Arbeitsschritt „Client-Prediction“ hat die Glättung aller vorhergesagten und interpolierten Autos in `shared/net` vervollständigt, die Tests dazu ergänzt und die letzten Reste der Legacy-Physik entfernt (Abschnitt 20.3). Offen sind die Dev-Netsim und `?debug=net` (8b), der Rest von 8d (E2E `net-contact.spec.ts` mit Netsim, Bots in der CI), Schritt 5 (Betrieb), Schritt 9 (Reconnect) und Schritt 11.

Schritt 8 ist bewusst ein einziger Merge: Zwischen 8a und 8d wäre der Party-Modus live schlechter als heute (alte Timer, lineare Interpolation). Jeder Commit in 8 bleibt trotzdem für sich lauffähig und getestet.

---

## 18. Risiken

| Risiko | Gegenmittel |
|---|---|
| TCP-Head-of-Line bei Mobilfunkverlust erzeugt Stöße von 200–400 ms | adaptive Interpolationsverzögerung, Extrapolation ≤ 250 ms, `bufferTarget` bis 3, Lag-Ghost; Netsim-Modus `tcp` testet genau das |
| Replay-Kosten auf schwachen Handys | Kontakt-Set ≤ 6, Replay nur bei Abweichung, Budget-Messung per `?debug=perf`/`?debug=net` auf dem Referenz-Handy |
| Rempeln fühlt sich verzögert oder doppelt an | beidseitige lokale Wirkung im Kontakt-Set, Offset ≤ 300 ms, weicher Kontakt bei hoher RTT; Playtest Desktop gegen Handy |
| Große Umstellung (Schritt 8) bricht Party-Details | Party-Tests portiert vor der Umstellung (Schritt 4), Merge erst nach 8d, Bot- und E2E-Suite |
| v1-Tabs nach dem Deploy stehen still | einmalig hingenommen (3.2); ab v2 gibt es Reject mit Reload |
| Felsen stehen nach Schritt 3 anders | einmalig, dokumentiert; nur Optik und Kollision außerhalb der Stadt |
| Bandbreite überschreitet das Budget bei 32 Spielern | 25 kB/s gerechnet; Reserve in 13.1; Messung im Bot-Test |
| Tick-Hänger durch GC oder langsame Rooms | keine Allokation im heißen Pfad, Tick-Histogramm, `/healthz`, Overrun-Zähler |
| Speicherlecks im 24/7-Betrieb | Idle-Kick, Grace-Ablauf, Room-TTL, Soak-Test |

## 19. Nicht Teil von 1b

RaceRoom, Gates, Zeitmessung, serverseitige Bots als Mitspieler (Phase 2; die Bot-Fahrlogik aus `tools/bots` wird dort wiederverwendet), Interest-Management und Distanz-Staffelung (Phase 4, nur falls gemessen nötig), Delta-Kompression, Lag-Kompensation für Schüsse, WebTransport, persistente Scores, Umstellung der `Bulli`-Adapterfelder auf m/s, Tuning als `stepWorld`-Parameter.

---

## 20. Umsetzung: Abweichungen und Stand

### 20.1 Rooms und Collider (Schritte 3, 4 und Room-Teil von 10)

Umgesetzt in den Commits „Port the static colliders to shared world code“, „Build the client's collision world from the shared colliders“, „Split the server into sessions and room instances“ und „Let players choose between Party and Free Roam“. Das Netzmodell ist unverändert (Clients schicken weiter `update`).

**Reihenfolge.** Der Arbeitsschritt fasst die Schritte 3 und 4 mit FreeRoam und Menü aus Schritt 10 zusammen und kommt **vor** dem Löschen der Legacy-Physik (Schritt 2). Folgen:

- `state.obstacles` bleibt als abgeleitete Sicht (`collidersToObstacles` in `client/vehicle/simWorldClient.ts`) auf die geteilte Collider-Liste bestehen, weil `legacyPhysics.ts` und die E2E-Hilfe `placeOnClearRunway` Kreise und Rechtecke lesen. Sie entfällt mit Schritt 2. `obstaclesToColliders` ist schon gelöscht; die v2-Sim bekommt die Liste direkt (`state.worldColliders`).
- Die Room-Wahl läuft über Protokoll v1 statt über `hello`/`roomState` (kommen in Schritt 7):
  - Room-Art beim Verbinden als URL-Parameter `/ws?room=freeroam` (Standard `party`).
  - `joinRoom {kind}` (C→S, valibot `picklist`), Antwort `roomJoined {room, spawn, players, powerups, coins, scoreboard}` statt `roomState` + `spawn`-Event; der Client setzt das Auto sofort an `spawn`.
  - `init` trägt zusätzlich `room {id, kind, index}`.
  - Alles ist additiv, `PROTOCOL_VERSION` bleibt 1: Ein Tab mit dem alten Client ignoriert die neuen Felder und landet wie bisher in der Party (`party-1`).
- Über `MAX_CONNECTIONS` (160, ENV) wird eine Verbindung mit Close 4002 abgewiesen, ohne `reject`-Nachricht (gibt es in v1 nicht).
- Party-Timer laufen wie in Schritt 4 vorgesehen noch mit `setTimeout`, jetzt pro Mitgliedschaft (`server/party/state.ts`) und beim Verlassen oder Schließen des Rooms gelöscht. Item-Reset-Timer gehören dem Room.

**Server-Struktur.** `server/session.ts` (Verbindung, Name, Farbe, Karosse, Rate-Limits, Transport-Schnittstelle für Tests), `server/rooms/Room.ts` (Mitglieder, Slots, Join/Leave, Relay von `update`/`honk`, Broadcast nur an eigene Mitglieder), `PartyRoom.ts` (Regeln aus dem früheren `handlers.ts`, unverändert), `FreeRoamRoom.ts`, `lobby.ts` (`RoomManager`: `findOrCreate`, `switch`, `sweep`), `spawn.ts` (Abstand nur zu Autos des eigenen Rooms), `dispatch.ts` (Session-Nachrichten `rename`, `setCarType`, `joinRoom`, Rest an den Room), `maps.ts`. Gelöscht: `state.ts`, `world.ts`, `handlers.ts`, `net.ts`, `types.ts`. Slots (u8, Wiedervergabe nach 5 s) werden schon vergeben, aber noch nicht übertragen.

**MapData.** `createMapData(seed)` liegt in `src/shared/world/mapData.ts` (nicht nur serverseitig), damit Client und Server dieselbe Funktion nutzen; `server/maps.ts` hält eine Instanz pro Seed. `worldHash` = FNV-1a (32 Bit, hex) über `canonicalStringify({world, colliders})` (sortierte Schlüssel, Zahlen per `String`, also auch `Infinity`). Golden: `cd1d366c`. Neu `MAP_VERSION = 2`. Der Client baut seine Collider noch aus der `init`-Welt (`buildWorldColliders({trees, city})`); die Welt aus dem Seed folgt in Schritt 7.

**Collider und Props.** `src/shared/world/props.ts` enthält Park, Plaza, Laternen, Boulevard-Palmen, Schilder und Felsen als Daten, `colliderGen.ts` die Liste in der Vertragsreihenfolge. `city.ts` und `environment.ts` rendern aus denselben Daten und pushen nichts mehr.

- **Felsen:** `ROCK_COLLIDER_SEED` („ROCK“) zieht pro Versuch genau drei Werte (x, z, Größe), auch für verworfene Versuche; `ROCK_VISUAL_SEED` („ROCV“) zieht pro Felsen genau sieben Werte (Material, zwei Rotationen, Höhe, ob es einen zweiten Stein gibt, dessen zwei Rotationen, auch wenn es keinen gibt). Büsche und Blumen nutzen `SCENERY_SEED` („BULL“) jetzt von Anfang an und stehen deshalb ebenfalls einmalig an anderen Stellen. Vorher 38 Felsen mit 29 Collidern, jetzt 34 mit 27. Offline (ohne Stadt) gibt es nur die Felsen-Collider.
- **Paritätstest:** Schritt 1 (Index für Index gegen die alten `push`-Stellen, Toleranz 1e-9, Felsen nur Form und Bereich) lief im ersten Commit grün. Danach prüft `tests/e2e/collider-parity.spec.ts`, dass die Collider-Liste des Browsers bitgleich der in Node gebauten ist und dass zu jedem Collider genau ein gerendertes Objekt mit `userData.collider` an seiner Position steht (Gebäude, Bäume, Felsen, Bänke, Teich, Parkbäume, Pflanzkübel, Schirme, Brunnen, Laternen, Palmen, Schilderpfosten). Der Node-Golden-Hash über die geordnete Liste steht in `tests/shared/colliderGen.test.ts` (239 Collider: 120 Bäume, 27 Felsen, 92 Stadt).

**Client.** 

- Im Spiel gibt es kein Menü-Fenster (ABOUT ist nur im Splash erreichbar). Statt „Modus wechseln“ im ABOUT-Fenster zeigt ein **Room-Chip** neben dem Rang-Chip den Modus und die Instanz („PARTY“ / „ROOM 1“, zweizeilig statt „Party · 1“, damit er auf schmalen Handys neben den Rang-Chip passt) und öffnet ein kleines Menü „Game mode“ mit PARTY und FREE ROAM. Desktop und Handy hochkant: Chip unter dem Rang-Chip (hochkant sitzt oben mittig die Boost-Anzeige, der Killfeed rückt unter die Score-Pille); übrige Touch-Layouts: links daneben.
- Nach einem Wechsel sind die Buttons 2 s gesperrt (Server-Rate-Limit); ohne Antwort geben sie nach 5 s wieder frei.
- `body.room-freeroam` blendet zusätzlich Killfeed, Respawn-Overlay und die HP-Balken der Nametags aus; die Taste E schießt in Free Roam nicht. `body.room-party` ist gesetzt, solange man in der Party ist.
- Der Splash-Screen scrollt jetzt bei zu wenig Höhe (Handy quer), statt START abzuschneiden.
- E2E: `rooms.spec.ts` (Desktop) und `rooms-mobile.spec.ts` (iPhone 13, Layout in drei Viewports).

### 20.2 Server-Sim und Protokoll v2 (Schritte 2, 7, 8a, 8c, Teile von 6, 8b, 8d)

Umgesetzt in den Commits „Delete the legacy physics“ und „Let the server simulate every car“. Die Clients schicken nur noch Eingaben; `update` gibt es nicht mehr.

**Legacy gelöscht (Schritt 2).** Wie in Abschnitt 10, mit diesen Abweichungen:

- `body.physics-v2` bleibt als feste Klasse in `index.html` stehen. Sie trägt nur noch die Spezifität der bisherigen Regeln in `style.css`; `.v2-only` und `.legacy-only` sind weg. Ein altes `?physics=legacy` bewirkt nichts mehr.
- `desktop.spec.ts` prüft jetzt dasselbe (Canvas, HUD, Scoreboard, Tacho) mit der v2-Physik. `mobile.spec.ts` und `multiplayer.spec.ts` (Legacy-Form) sind gelöscht, `v2-mobile.spec.ts` und `v2-multiplayer.spec.ts` decken sie ab.
- `collidersToObstacles`, `state.obstacles`, `Obstacle` und `__bulliDebug.obstacles()` sind entfernt; `placeOnClearRunway` liest `__bulliDebug.colliders()`.
- `PROXY_CONTACT_SCALE` ist aus dem Tuning entfernt (Golden-Tuning angepasst). Das Golden-Szenario `proxy-bump-sport` bleibt als kinematisches Auto mit `contactScale = 0.7` bestehen, weil die Prediction genau diesen Fall für weit extrapolierte Remote-Autos nutzt (8.5).
- Die Tuning-Sperre aus Abschnitt 7 ist mit drin: `?tune=1` lädt das Panel nur mit `?sandbox=1`, sonst zeigt die Seite einen Hinweis. Vor dem `hello` setzt der Client ein verändertes Tuning zurück, der Server startet nicht mit abweichendem Tuning.

**Protokoll v2.** `PROTOCOL_VERSION = 2`, Schemas in `shared/protocol.ts`, Binärrahmen in `shared/net/codec.ts`, Handshake in `server/handshake.ts`. Abweichungen von 3.2 bis 3.6:

- `roomState` trägt `room {id, kind, index}` statt `roomId`/`kind`, außerdem `preview {x, z, yaw}`: eine freie Stelle, auf die die Kamera hinter dem Splash-Screen schaut, bis das Auto spawnt. `items` ist in Free Roam `null`.
- `welcome` enthält zusätzlich `color` und `name` (der Server bereinigt den Namen), `reject` zusätzlich `serverProtocol`. Der Reload-Schutz für `reject {reload}`, den Build-Abgleich nach `welcome` und einen abweichenden `worldHash` läuft je über einen eigenen `sessionStorage`-Schlüssel; der Build-Abgleich nutzt denselben Schlüssel wie `buildVersion.ts`, damit eine Seite nicht zweimal neu lädt.
- `playerJoined {member}` mit dem vollständigen `MemberInfo` (inklusive `profile`), gesendet, sobald das Mitglied `ready` ist. `playerUpdated` trägt auch `profile`.
- Im Event `pickup` heißt der Powerup-Typ `powerupType` (`type` ist der Event-Typ).
- Der Self-Block trägt zusätzlich die Auto-Flags (u16), damit der Client Idle, Lag und Schild seines eigenen Autos kennt: 149 B statt ≈ 150 B.
- `debugPlace` merkt sich der Server, bis das Auto existiert (ein Test darf direkt nach `ready` platzieren). Ohne `E2E=1` zählt die Nachricht als ungültig.
- `joinRoom` ist unverändert, die Antwort ist jetzt `roomState` (statt `roomJoined` aus 20.1), der Spawn kommt als Event. Der URL-Parameter `?room=` entfällt, die Room-Art steht in `hello.room`.
- Ohne `SESSION_SECRET`, Grace und Resume (Schritt 9): Das Token wird vergeben und im `sessionStorage` abgelegt, aber noch nicht ausgewertet. Nach einer Trennung zeigt der Client einen Hinweis mit „Reload“-Button (`#net-notice`).

**Server-Tick (5.1–5.6).** `server/tick.ts` wie spezifiziert, `RoomManager.stepAll` stuft die Rooms mit Mitgliedern nach `id`. `Room.step` in der Reihenfolge aus 5.3; neu dazu kommt am Ende des Ticks `spawnAndPlace` (Spawn, Wagenwechsel, `debugPlace`), damit der Zustand nach Tick T der Startzustand ist, den auch der Client für T einsetzt.

- **Spawn:** Jeder Spawn und Respawn nutzt `spawnVehicle` aus `shared/sim/vehicle.ts` (alles auf Anfang, auf den Boden, Kontakt-Ghost `RESET_GHOST_TICKS`), in Party wie in Free Roam. Die Richtung folgt der Straße unter dem Spawnpunkt (zufällig eine der beiden Fahrtrichtungen), auf der Plaza und auf Kreuzungen eine der vier Achsen.
- **Input-Puffer:** `inputSlack` ist das Minimum über **alle neuen** Inputs eines Snapshot-Fensters (Tick über dem höchsten bisher empfangenen), auch über die verspäteten mit Wert ≤ 0, nicht nur über den jeweils neuesten eines Pakets. Kamen nach einem Hänger zwei oder mehr Ticks in einem Paket, war sonst nur der neueste sichtbar, und der Client erfuhr nie, dass die älteren zu spät kamen (gemessen: ein Viertel der Ticks verpasst bei gemeldetem Slack 1). Redundante Kopien schon empfangener Inputs zählen nicht.
- **Lag-Ghost:** Fenster 5 s (300 Ticks) statt 2 s, gleiche Quote von 20 %; verpasste Inputs zählen erst ab dem ersten Input nach dem Spawn (vorher startet der Client noch, dafür gibt es die Idle-Regel). In E2E-Läufen mit Software-WebGL hängt eine Seite mehrmals für 300–500 ms (Shader beim ersten Einsatz, GC, zwei Seiten auf einer GPU); mit 2 s wurde dadurch fast jeder Spieler zeitweise zum Ghost, und Rempeln fiel zufällig aus. Die RTT kommt aus WebSocket-Pings alle 2 s (Median der letzten fünf), damit ein einzelner Hänger des Servers niemanden zum Ghost macht. Die Pings dienen zugleich als Heartbeat (Abbruch nach 20 s ohne Pong).
- **Idle:** Ein Paket ohne `HIDDEN` beendet auch den per `visibility` gemeldeten Hintergrund.
- **Party (5.5):** wie spezifiziert, Timer als Fenster in Ticks (`server/party/state.ts`, Zahlen in `shared/party/rules.ts`). Die Ram-Abklingzeit je Paar läuft auch dann an, wenn ein Schild den Schaden verhindert (wie beim Schuss). Schüsse werden beim Eintreffen gegen den aktuellen Server-Zustand geprüft.

**Client (8).** Die reine Netzlogik liegt in `shared/net/` (Codec, Clock, Lead, Prediction mit Kontakt-Set, Interpolation) und in der gemeinsamen Klasse `NetClient` (`shared/net/client.ts`: Clock, Lead, Prediction, Input-Pakete, Slots, Powerup-Fenster), die Browser, Node-Tests und später die Bots gleich nutzen. `client/net/netDriver.ts` ergänzt nur Eingaben, `LocalVehicle`-Anbindung und den Render-Offset; `client/net/remotes.ts` stellt die Remote-Autos dar. `network/websocket.ts` bleibt der JSON-Router (ein eigenes `client/net/dispatch.ts` hätte nur Dateinamen verschoben). Abweichungen:

- **Tick-Zählung statt Zeitdehnung des `FixedStepLoop`:** C folgt `anker + jetzt/DT + lead`. Der Anker ist der Clock-Offset beim Start (nach drei Pongs, weil der erste Pong in einer gerade ladenden Seite lange liegen bleibt) und wird danach nicht mehr verschoben; nur der Lead-Regler bewegt `lead`. Vorteil gegenüber dem Frame-Akkumulator: Ein Frame, der wegen der Obergrenze von 8 Ticks oder 250 ms Zeit verliert, lässt C nicht hinter die Server-Zeit fallen.
- **Lead-Regler asymmetrisch:** Kommen Inputs zu spät (e ≤ −2), steigt der Lead sofort um den Fehlbetrag; zu früh senkt ihn nur mit höchstens 5 % der Tick-Zeit pro Snapshot (±5 % Tempo), außer bei mehr als 16 Ticks (Uhrsprung). Nach einem Sprung ignoriert er die Meldungen eine RTT plus 250 ms lang, weil sie noch Inputs von vor dem Sprung beschreiben; ohne diese Totzeit schaukelte er sich zwischen +18 und −18 Ticks auf. Ein Client, dessen Seite immer wieder kurz hängt, behält so den Vorlauf, den er braucht, statt nach jedem Hänger wieder zu knapp zu werden.
- **Ticks auch zwischen den Frames:** Ein Timer (alle 4 ms) rechnet die fälligen Ticks und schickt die Inputs, auch wenn der nächste Frame auf sich warten lässt. Mit Software-WebGL liefen zwei Seiten mit 4–8 FPS; die Inputs kamen dann in Stößen von bis zu 15 Ticks und größtenteils zu spät. Auf schwachen Handys hilft das genauso. Pro Aufruf höchstens 20 Ticks, weiter hinten springt C nach vorn. Die Frame-Ereignisse (Sound, Partikel) sammelt `LocalVehicle` bis zum nächsten Frame.
- **Kontakt-Set:** in `prediction.ts` statt eines eigenen `contactSet.ts`. Sind Autos im Set, wird jeder Snapshot nachgerechnet (auch bei exakter Übereinstimmung), damit die Remote-Autos wieder auf C kommen.
- **Doppelte Ereignisse:** Bringt eine Korrektur einen Sprung oder Reset, den der Spieler schon gesehen hat, ein paar Ticks später noch einmal (der Server bekam den Input zu spät), zählt `LocalVehicle` ihn nicht erneut (Abstand kleiner als Sprung-Cooldown bzw. Reset-Haltezeit).
- **Respawn-Schild in der Prediction:** Bis zum ersten Snapshot nach einem Spawn nimmt der Client den Schild an, danach gilt das Flag des letzten Snapshots (8.4, Schritt 2). Der Schild ändert nur Kontaktmasse und Wand-Restitution; ohne Kontakt entsteht keine Korrektur.
- **Remote-Darstellung:** Hermite mit adaptiver Verzögerung und die Überblendung zum Kontakt-Set (300 ms) sind schon da (Teil von 8d). Idle-Autos werden grau mit „ZZZ“ (Flag statt AFK-Hack).
- **`__bulliNet`** (Teil von 8b) liefert Lead, Slack, Korrekturen, Snaps, verpasste Inputs und die Flags der Remote-Autos für die Tests. Das Overlay `?debug=net` und die Netsim fehlen noch.

**Tests.** Unit: Codec und Quantisierung, valibot-Schemas v2, Handshake (Version 1 und 3 → 4000 mit Reload, kaputtes hello → 4001), Scheduler (10 min ohne Drift, höchstens 4 Nachhol-Ticks, Hänger), Input-Puffer, `stopInput`, Rooms und Party im Tick (Pickups, Fenster, Schüsse, Mega-Ram aus Δv, Respawn-Schild, Idle-/Lag-Ghost, Kontakt-Events), Clock und Lead, Interpolation. Die Reconciliation-Tests (`tests/shared/net/reconcile.test.ts`) verbinden die echten Rooms mit `NetClient`-Clients über Links mit Latenz, Jitter und TCP-Verlust in simulierter Zeit (`harness.ts`):

| Fall | Ergebnis |
|---|---|
| 0 Latenz, 1000 Ticks Slalom mit Handbremse und Boost | jede Korrektur exakt 0, keine verpassten Inputs |
| 9 Ticks je Richtung, ±2 Ticks Jitter | jede Korrektur exakt 0 (bitgleich) |
| RTT 150 ms, 30 ms Jitter, 3 % Verlust (TCP-Modus, Exit-Kriterium) | mittlere Korrektur 2–8 cm (60 s, drei Seeds), p99 6–6,5 cm, 2–5 Snaps auf 1200 Snapshots |
| RTT 300 ms, ±2 Ticks, 3 % Verlust | Mittel 3–3,5 cm, 2 Snaps auf 1200 Snapshots |
| RTT 150 ms, 30 ms Jitter, kein Verlust, 60 s | jede Korrektur exakt 0, kein verpasster Input |
| Frontal mit 5 Ticks Latenz | beide Clients spüren den Stoß in einem eigenen Vorhersage-Tick, danach wieder exakt 0; der Server endet bitgleich mit einem Lauf ohne Netz |
| Turbo-Pickup mit 9 Ticks Latenz | eine Korrektur, danach exakt 0 |
| Uhr des Clients springt um 500 ms | Lead springt, danach wieder exakt 0 |

Die Vorgabe „keine Snaps“ bei 3 % Verlust (15.1, Fall 3) ist nicht erreichbar: Ein verlorenes Paket hält im TCP-Modus alles Folgende 200 ms + RTT auf; bei 60 Paketen pro Sekunde steht der Uplink damit gut die Hälfte der Zeit. Nach 250 ms Wiederholung bremst der Server das Auto (5.3), und die Abweichung zum weiterfahrenden Client überschreitet gelegentlich 4 m. Der Test verlangt deshalb höchstens 1 % Snaps; die mittlere Korrektur bleibt unter 10 cm.

E2E: `joinGame` wartet, bis der Server das Auto gespawnt hat und die Prediction läuft. `v2-multiplayer.spec.ts` prüft den Stoß jetzt gegen den Server (Bob wird geschoben, Bob ist bei Alice im Kontakt-Set, die Autos durchdringen sich auf ihrem Bildschirm nicht) und fährt den Anlauf bis zu dreimal, wenn eine hängende Seite zwischendurch zum Lag-Ghost wurde. Die Tacho-Vergleiche nutzen die Geschwindigkeit des gezeigten Frames, weil die Sim online auch zwischen den Frames rechnet. Playwright und die Skripte (`screenshots`, `perf:baseline`) starten den Server mit `E2E=1`.

### 20.3 Client-Prediction und Glättung (Rest von 8a und 8d, Schritt 2 vollständig)

Umgesetzt in den Commits „Fade out corrections of every predicted car on screen“, „Remove the last traces of the legacy physics“ und einem Folge-Commit für die Coins. Prediction, Replay, Kontakt-Set mit Extrapolation, Clock-Sync, Lead-Regler, Party auf Protokoll v2 und die Tuning-Sperre standen schon (20.2); dieser Schritt prüft sie gegen 8 und schließt die Lücken.

**Render-Offset in `shared/net/renderOffset.ts`.** Der Offset des eigenen Autos lag nur im Browser (`NetDriver`) und war damit in Node nicht testbar. Jetzt gehört er zu `NetClient`: `RenderOffset` (Übernehmen der Differenz, Abklingen mit τ = 100–200 ms, Schluss unter 1 mm, spätestens 300 ms nach einer Kontakt-Korrektur, Snap ab 4 m oder 45° bzw. bei nicht endlichen Werten) und `interpolatePose`. `NetClient.reconcileSnapshot(snap, now, alpha)` merkt sich die gezeigte Pose vor der Korrektur, rechnet ab und setzt den Offset gegen die neue Pose mit demselben `alpha`. Der Browser gibt das `alpha` des letzten Frames mit und misst am `LocalVehicle` (Hooks `ownPose`, `afterReplay`); Node-Tests und später die Bots nutzen das Paar der Prediction. `decayOffsets` baut alle Offsets pro Frame ab. `cameraSnap` sitzt ebenfalls in `NetClient`. Neue Zähler: `stats.offsetMax`, `stats.renderSnaps`.

**Abweichungen und Ergänzungen zu 8.4–8.7:**

- **Offset für die Autos im Kontakt-Set** (8.6, „plus eigenem Offset bei Korrekturen“): Bisher fehlte er. Jeder Snapshot setzt die Autos im Set auf den Server-Zustand zurück und rechnet sie neu bis C; lenkte der Fahrer anders als vorhergesagt, sprang das Auto mit 20 Hz. Jedes `PredictedRemote` hat jetzt einen eigenen `RenderOffset`, der die gezeigte Pose über die Korrektur hält. Beim Eintritt ins Set beginnt er bei 0 (dort überblendet `remotes.ts` 300 ms).
- **Offset nach der Extrapolation ferner Autos** (8.6): `RemoteTrack` merkt sich die Renderzeit des letzten Frames. Kommt eine Probe an, nachdem die Pose schon über die neueste hinaus extrapoliert war, übernimmt ein Offset die Differenz zwischen gezeigter und neu interpolierter Pose. Das Abklingen folgt demselben Gesetz wie beim eigenen Auto (100–200 ms je nach Größe) statt fest 100 ms, damit es nur eine Regel gibt. Ein Teleport (> 20 m) löscht den Offset.
- **Yaw** interpoliert `interpolatePose` über den kürzesten Bogen; die vorhergesagten Remote-Autos starten mit dem gewickelten Yaw aus dem Kompaktdatensatz.
- **Coins** (8.7): Ein optimistisch eingesammelter Coin wartet `max(600 ms, RTT + 300 ms)` auf das `pickup`-Event statt fest 600 ms. Die Bestätigung braucht etwa eine RTT plus Puffer und Snapshot-Intervall; bei RTT über 300 ms erschien der Coin sonst kurz wieder.
- **Legacy (Schritt 2) vollständig:** `body.physics-v2` ist aus `index.html` entfernt, die Regeln in `style.css` sind normale Regeln. Wo die Klasse nur Spezifität trug, stehen die Werte jetzt in den Grundregeln (`.controls-hint` mit `max-content`, `.hint-row` mit `0 0.6rem`; die verdeckten `:first-child`/`:last-child`-Abstände sind gelöscht), `#interaction-prompt` behält mit dem Präfix `body` seinen Vorrang vor Grund- und Touch-Regel. `physics-default.spec.ts` heißt jetzt `drive-controls.spec.ts` und prüft weiter, dass ein altes `?physics=legacy` nichts bewirkt. `LocalVehicle.respawn()` und `moving` (Reste des Positionsprotokolls) sind gelöscht. Plan, Baseline und Playtest-Doku bieten `?physics=legacy` und `--physics=v2` nicht mehr an.
- **Tuning-Sperre:** neuer E2E-Test, dass `?tune=1` online nur den Hinweis zeigt, kein Panel und kein `__bulliTune` lädt und das Spiel trotzdem verbindet.

**Tests.** `tests/shared/net/renderOffset.test.ts` (Halten der Pose, Aufsummieren, τ, Schluss unter 1 mm, 300-ms-Grenze nach Kontakt, Snap-Schwellen, Yaw über ±π) und drei neue Fälle in `interpolation.test.ts` (späte Probe nach Extrapolation, kein Offset bei normaler Interpolation, Teleport). In `reconcile.test.ts` rendert `FrameProbe` (`harness.ts`) das eigene Auto mit 60 FPS in simulierter Zeit wie der Browser und misst pro Frame den **Sprung**: wie weit sich das Bild über die Bewegung des Autos auf dem (korrigierten) vorhergesagten Pfad hinaus bewegt. Ohne Offset wäre das die ganze Korrektur. Die Schwelle ist ein Frame Abklingen des größten geglätteten Offsets, 4 m · (1 − e^(−16,7/200)) ≈ 0,33 m.

| Fall | Ergebnis |
|---|---|
| RTT 150 ms, 30 ms Jitter, 3 % Verlust (TCP), 30 s Slalom, zwei Seeds | größter Sprung 0,29–0,30 m pro Frame (Schwelle 0,33 m), p99 0,22 m; ohne Offset bis 3,8 m. Snaps höchstens 1 % der Frames. Die großen Offsets (bis 3,6 m) stammen von den Stopps nach Head-of-Line-Blockaden (20.2). |
| danach Netz sauber (75 ms je Richtung, kein Jitter, kein Verlust) | nach 2 s jede Korrektur exakt 0, Offset 0, kein Sprung über 1e-9 m |
| Nachbar im Kontakt-Set lenkt alle 12 Ticks um, 150 ms RTT | Sprünge des Nachbarn p99 0,04 m statt 0,12 m ohne Offset, Maximum 0,09 m |
| Frontalstoß, 150 ms RTT, 30 ms Jitter | beide Seiten korrigieren mit Kontakt, kein Sprung über der Schwelle (eigenes Auto ≤ 1 cm), der Offset ist spätestens 300 ms nach der letzten Kontakt-Korrektur 0 (gemessen 194 ms) |

Die Schwelle ist bewusst die Obergrenze der Regel aus 8.4, keine Ermessenszahl: Ein größerer Sprung hieße, dass eine Korrektur ohne Offset durchkommt. Ob 0,3 m pro Frame bei seltenen Stopps im Mobilfunknetz stört, zeigt erst der Playtest mit Netsim (16).
