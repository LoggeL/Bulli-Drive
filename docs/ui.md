# UI: Ladebildschirm und Hauptmenü

**Stand:** 2026-09-26 · Branch `ui/menu-refactor` (auf `main` = Phase 3 live) · Konzept vor der Umsetzung.
Auftrag: „also refactor the loading screen and main menu“. Der Ladebildschirm und das Hauptmenü sollen zum realistischen, ruhig-naturgetreuen Look von Bulli Bay passen ([`world-look.md`](world-look.md)) und sich auf Desktop und Handy gleich gut bedienen lassen.

Die Entscheidungen in diesem Dokument hat der Workflow ohne Rückfragen getroffen. Jede steht mit ihrer Begründung in Abschnitt 12 („Entscheidungen“).

## 1. Ausgangslage

![Vorher: Loader, Menü Desktop, Menü iPhone 13, Menü iPhone SE quer](img/ui-before.jpg)

Die Vorher-Aufnahmen liegen vollständig unter `/private/tmp/claude-501/gfx/ui/before/` (Desktop 1440×900, iPhone 13 hoch, iPhone SE quer, Pixel 7; jeweils Loader und Menü). Den Loader haben wir mit zurückgehaltenem WebSocket aufgenommen, sonst ist er lokal nach 1,4 s weg.

| Befund | Wo |
|---|---|
| Der Loader ist ein Cartoon-Bus aus SVG-Rechtecken mit Scherzsätzen („Polishing headlights…“, „Adding racing stripes…“). Er hat mit dem Spiel optisch nichts zu tun. | `index.html` #loading-screen |
| Der Fortschrittsbalken ist eine Endlos-Animation (`loader-slide`) und zeigt keinen echten Stand. | `style.css` `.loader-bar-fill` |
| Beim Übergang blendet der Loader über dem Menü aus. Beide Bildschirme sind verschieden aufgebaut, dadurch springt das Layout (Bus mitten über den Autokarten). | `websocket.ts` `removeLoader` |
| Das Menü ist eine einzelne Spalte auf einem Farbverlauf. Das Spiel wird dahinter bereits gezeichnet (Vorschau-Spawn), ist aber vollständig verdeckt. Dieses Bild kostet also Rechenzeit, ohne dass jemand es sieht. | `.splash-bg`, `main.ts` |
| Typografie: Righteous, Quicksand und Permanent Marker kommen von Google Fonts. Ohne dieses Netz (z. B. im E2E-Lauf und in den Screenshot-Skripten) fällt die Schrift auf `cursive` zurück. | `index.html` `<link>` |
| Auf dem iPhone SE quer liegen Autowahl, Modus und START unterhalb der sichtbaren Fläche, man muss scrollen. Auf dem iPhone 13 hoch sitzt START ganz unten am Rand. | Screenshots |
| Die Autowahl zeigt 52×32-px-Renderings, der fünfte Wagen rutscht in eine zweite Zeile. Werte der Autos fehlen ganz. | `.car-selector-row` |
| Die Spielerfarbe würfelt der Server als beliebige 24-Bit-Farbe (`handshake.ts`), der Client entsättigt sie nachträglich (`carPaintColor`). Wählen kann man sie nicht. | Server, `carMaterials.ts` |
| Hilfetexte nennen Q/„Jump“, das wird parallel entfernt (Branch `sim/airborne-no-jump`). | Menü, About-Modal |

Die Ladezeiten haben wir lokal auf einem M5 Pro gemessen (Resource Timing, Desktop-Tier). Der Code umfasst 1,8 MB in 9 Chunks, die Welttexturen 3,5 MB in 28 Dateien, das HDRI 1,8 MB, das Gebäude-Kit 1,9 MB in 17 Dateien, die Automodelle 0,9 MB in 16 Dateien und die Karte 0,36 MB. Zusammen sind das rund 10 MB. Im Lite-Tier sind es rund 5 MB, dort fehlen das HDRI und die meisten PBR-Texturen.

## 2. Leitidee und visuelle Sprache

**„Showroom am Pier“.** Das Menü ist kein Formular vor einem Farbverlauf. Das echte Spiel rendert dahinter das gewählte Auto, das in der Abendsonne am Kopf des Piers von Bulli Bay steht. Die Bedienelemente liegen als ruhiges Glas-Overlay darüber. Auch der Ladebildschirm zeigt dieses Bild, allerdings vorgerendert. Beim Übergang vom Loader ins Menü wird das Standbild dadurch nur lebendig, das Layout springt nicht.

Mockups als Stilreferenz (Codex-imagegen, Originale unter `/private/tmp/claude-501/gfx/ui/mockup-*.png`):

| Desktop | Handy hoch |
|---|---|
| ![Mockup Desktop](img/ui-mockup-desktop.jpg) | ![Mockup Handy](img/ui-mockup-phone.jpg) |

Aus den Mockups übernehmen wir die Glasflächen, die schmale Versal-Schrift mit weiter Laufweite, den gedämpften Bernstein als einzigen Akzent, die Autoreihe unten mit Werten, die runden Lack-Chips, das Bottom-Sheet auf dem Handy und den Start-Button im Daumenbereich.

Bewusst abweichend von den Mockups:

- Die KI-Bilder sind satter und dramatischer als unser Spiel. Das echte Bild ist das hellere, dunstige Grading aus `world-look.md`, wir übertreiben nichts.
- Requisiten wie Wegweiser, Kisten und die Stadt auf der Klippe gibt es auf der Karte nicht. Der Showroom zeigt nur Bulli Bay.
- Das Namensfeld bekommt eine sichtbare Beschriftung (a11y), ein Platzhalter allein reicht nicht.
- Die Lack-Chips sitzen auf dem Desktop im Panel beim Auto und schweben nicht frei am Rand.
- Die Werte-Balken tragen Zahlen, reine Balken sind nicht lesbar.

### Tokens

| Token | Wert | Verwendung |
|---|---|---|
| `--ui-ink` | `#121416` | Glasbasis: `rgba(18,20,22,.64)`, `backdrop-filter: blur(18px)`, ohne Filter-Unterstützung `.86` |
| `--ui-ink-2` | `#1E2226` | Felder, Karten |
| `--ui-line` | `rgba(243,235,221,.14)` | 1-px-Kanten |
| `--ui-paper` | `#F3EBDD` | Text (Kontrast auf `--ui-ink` ≈ 15:1) |
| `--ui-paper-2` | `rgba(243,235,221,.72)` | Nebentext (≥ 7:1 auf der Glasbasis) |
| `--ui-amber` | `#E0A84A` | einziger Akzent: Auswahl, Fortschritt, Start |
| `--ui-on-amber` | `#1B1712` | Text auf dem Start-Button (≈ 9:1) |
| `--ui-danger` | `#E06A5A` | Fehler, Verbindungsprobleme |
| Radius | 12 px Panels, 10 px Karten, Pille für den Start-Button | |
| Bewegung | 180–240 ms `cubic-bezier(.2,.7,.2,1)` | Mit `prefers-reduced-motion` nur Überblendungen, keine Kamerafahrt |

Damit der Text auch vor dem hellen Sonnenuntergang lesbar bleibt, liegt auf dem Desktop links ein Scrim (Verlauf von 55 % Ink auf 0) und auf dem Handy unten ein Sheet mit 80 % Ink. Die Kontraste prüfen wir am hellsten Bildbereich der Key-Art.

**Schrift:** Barlow und Barlow Semi Condensed (SIL OFL). Wir liefern sie selbst aus unter `public/fonts/` als Latin-Subset in WOFF2, zusammen etwa 60 KB. Zwei Schnitte werden vorgeladen (`<link rel=preload>`), dazu kommt `font-display: swap`. So hängt nichts mehr an Google Fonts. Der Schriftzug „BULLI DRIVE“ ist ein inline-SVG aus Pfaden, damit er beim ersten Paint steht und keine Schrift nachgeladen werden muss. Die Pfade erzeugt `tools/ui/wordmark.mjs` einmalig aus dem Font (opentype.js in `tools/`). Das echte VW-Logo bleibt am Auto (Nutzerentscheidung), in den Schriftzug kommt es nicht.

Die HUD-Typografie (Righteous/Quicksand) ist nicht Teil dieses Auftrags. Wir gleichen sie später an, siehe Abschnitt 13.

## 3. Ladebildschirm

### 3.1 Aufbau

```
┌──────────────────────────────────────────────────────────────┐
│ [Key-Art: Pier im Abendlicht, Bulli im Anschnitt, vollflächig]│
│                                                              │
│  BULLI DRIVE                         (Wortmarke, SVG)        │
│                                                              │
│                                                              │
│  ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔░░░░░░░░░░░░  64 %                   │
│  Loading the bay · textures 18/28                            │
│  Tip: Hold SPACE through a corner – drifting fills boost.    │
└──────────────────────────────────────────────────────────────┘
```

- **Hintergrund:** Die Key-Art füllt die Fläche (`object-fit: cover`), der Bildschwerpunkt liegt auf dem Auto (`object-position` je Format). Auf dem Desktop wird die 1920er-Variante geladen, auf dem Handy ein Hochformat-Ausschnitt mit 900 px Breite (`<picture>` mit `media`).
- **Sofort sichtbar:** Das kritische CSS steht inline in `<head>` (etwa 3 KB). Ein Blur-Platzhalter der Key-Art ist als Base64-WebP mit ≤ 1,5 KB inline eingebettet. Die Key-Art wird mit `fetchpriority=high` vorgeladen. Der erste Paint zeigt Platzhalter, Wortmarke und Balken ohne ein Byte Game-Code.
- **Fortschrittsbalken:** 2 px hoch, Bernstein auf 14 % Paper, mit Prozentzahl in Tabellenziffern. Er zeigt den echten Stand aus 3.2, bleibt monoton und wird weich interpoliert (maximal 30 %/s Aufholrate, damit er nicht springt). Der Balken hat `role="progressbar"` mit `aria-valuenow`.
- **Statuszeile:** Sie nennt den laufenden Schritt mit Zählern, z. B. „Loading the bay · textures 18/28“ oder „Warming up shaders“. Sie liegt in `aria-live="polite"`, wird aber höchstens alle 2 s angesagt.
- **Tipps:** Ein Tipp alle 7 s mit Überblendung. Die Liste richtet sich nach der Eingabe: Tastatur, Touch (`pointer: coarse`) oder Gamepad (sobald eines verbunden ist). Keine Scherzsätze, nichts zu Sprung oder Q. Beispiele: „Hold SPACE through a corner – drifting fills your boost.“, „SHIFT burns boost.“, „Hold R to reset onto the road.“, „F honks.“, „Party: E shoots.“; Touch: „AUTO gives gas for you – steer with the stick.“, „Hold the reset button to get back on the road.“; Gamepad: „RT gas, LT brake, A drift, B boost.“
- **Fehlerfälle:** Die Anzeigen aus `contextLoss.ts` (WebGL verweigert) und `connectionOverlay.ts` erscheinen im selben Glas-Stil über der Key-Art. Kein Schritt darf den Balken endlos stehen lassen, jeder hat ein Timeout (3.2).

### 3.2 Echter Fortschritt

Neues reines Modul `src/client/ui/loadProgress.ts`, ohne DOM und ohne three.js:

```ts
interface LoadTask { id: TaskId; weight: number; label: string; fraction: number; state: 'pending'|'running'|'done'|'skipped'|'timedOut'; count?: [done: number, total: number] }
createLoadProgress(tasks, clock) → { start(id), report(id, fraction, count?), done(id), skip(id), overall(): number /* 0..1, monoton */, status(): string, whenPhase(phase): Promise<void> }
```

Die Gesamtzahl ist Σ(w·f)/Σw über alle nicht übersprungenen Schritte. Übersprungene Schritte, etwa das HDRI im Lite-Tier, fallen aus dem Nenner. Der Balken springt dabei nicht zurück, weil `overall()` monoton bleibt. Die Statuszeile nennt den laufenden Schritt mit dem größten offenen Gewicht.

| Schritt (`TaskId`) | Quelle des Fortschritts | Gewicht Desktop | Gewicht Handy/Lite | Phase |
|---|---|---|---|---|
| `code`: Spiel-Code (Chunks `index`, `three`) | Inline-Bootstrap: `load`-Events der `modulepreload`-Links, gewichtet mit den Chunk-Größen, die ein kleines Vite-Plugin beim Build als `data-size` einträgt | 20 | 25 | Loader |
| `connect`: Verbindung, `welcome`, `roomState` | `websocket.ts` | 5 | 5 | Loader |
| `map`: Karte laden und Gelände bauen | Fetch `map.json` und `createMapScene` (CPU, zwei Teilschritte je 50 %) | 15 | 20 | Loader |
| `textures`: Welttexturen | `worldTextureProgress()` (gibt es schon), Zähler n/28 | 25 | 15 | Loader |
| `kit`: Gebäude-Kit (GLB + KTX2) | neu: Zähler je Datei in `mapScene.startKitPreload` | 15 | 15 | Loader |
| `car`: Modell des gewählten Autos | `ModelCache`, neu je Autotyp abfragbar | 5 | 5 | Loader |
| `hdri`: Umgebung | `lighting.ts` (nur im Desktop-Tier, sonst `skip`) | 7 | – | Loader |
| `warmup`: Shader-Warmup | `renderer.compileAsync(scene, showroomCamera)` für das erste Showroom-Bild | 8 | 10 | Loader |
| `cars`: die übrigen vier Autos | `ModelCache` | 5 | 5 | Menü (Start-Button) |
| `audio`: Motor-Samples dekodieren | `initSounds` (braucht eine Nutzergeste, startet erst beim Klick) | – | – | Start |

Die Gewichte sind erwartete Anteile an der Wanduhr, keine Bytes. Startwerte stammen aus der Messung oben und aus einer Schätzung für ein 4G-Handy. `?debug=load` loggt die gemessene Zeitleiste. Damit kalibrieren wir die Gewichte in U5 einmal je Tier nach und dokumentieren sie hier.

**Phasen:** Der Loader bleibt stehen, bis alle Schritte der Phase „Loader“ fertig sind. Erst dann ist das erste Showroom-Bild vollständig texturiert und kompiliert. Ein Schritt, der sein Timeout überschreitet, geht auf `timedOut`. Das Timeout ist `ASSET_WAIT_MS` = 20 s für den ganzen Loader wie heute, dazu kommen je Schritt Obergrenzen. Der Loader geht dann trotzdem, und der Rest läuft sichtbar auf dem Start-Button weiter. `assetGate.ts` geht in diesem Modell auf: Der Start wartet auf die Phase „Menü“, die heutige Wartelogik mit Timeout bleibt.

Heute verschwindet der Loader, sobald die Welt gebaut ist. Texturen und Modelle laden danach unsichtbar hinter dem Menü weiter. Künftig ist der Loader etwas länger zu sehen, die Zeit bis zum Losfahren bleibt gleich, weil das Asset-Gate heute schon am START wartet. Dafür sieht man im Menü nie eine untexturierte Welt.

**Bootstrap vor dem Game-Code:** Ein Inline-Skript von etwa 1 KB legt `window.__bulliLoad` als Warteschlange an und zählt die `code`-Fortschritte. `loadProgress.ts` übernimmt die Warteschlange, sobald `main.ts` läuft. Das Skript steht neben dem vorhandenen Stale-Client-Guard und ändert dessen Verhalten nicht.

### 3.3 Key-Art

**Entscheidung:** Die Key-Art ist ein echtes In-Engine-Render und kein KI-Bild. Sie zeigt dieselbe Einstellung wie das erste Showroom-Bild: Pier-Kopf, Bulli in Werkslack, Kamera auf der Orbit-Startpose, Sonnenuntergang aus `map.json`. Das hat drei Gründe:

1. Der Wechsel vom Loader zum Menü ist dann eine Überblendung zwischen zwei fast gleichen Bildern (400 ms), kein Schnitt.
2. Karte, Licht und Grading stimmen automatisch mit dem Spiel überein.
3. Sie lässt sich reproduzierbar neu erzeugen, wenn sich Karte oder Modelle ändern.

Wir erzeugen sie mit `tools/ui/keyart.ts`. Das Skript nutzt die Infrastruktur von `scripts/screenshots.ts` (Produktionsbuild, GPU, `?e2e=1`, feste Kamera) und blendet das HUD aus. Es rendert 2560×1440 mit DPR 2 und schreibt mit `cwebp -q 72` `public/ui/keyart-1920.webp` (≤ 250 KB), `public/ui/keyart-portrait-900.webp` (≤ 120 KB) und den Blur-Platzhalter (≤ 1,5 KB). Ein Unit-Test prüft diese Größengrenzen (Abschnitt 10).

Fallback nur, wenn das Render nicht trägt (etwa zu leerer Vordergrund): eine Codex-imagegen-Key-Art im Stil der Mockups, ausdrücklich „calm, naturalistic, not oversaturated“, mit dem Prompt unter `tools/ui/keyart-prompt.md`. Dann ist allerdings der Übergang zum Menü ein Schnitt mit Überblendung, und das Bild passt nur ungefähr zur Karte.

## 4. Hauptmenü

### 4.1 Showroom

- **Ort:** Die Karte bekommt einen neuen POI `showroom` in `pois.json` mit Stellplatz, Hero-Gierwinkel und Kameradaten, am Kopf des Piers (−700…−760, −20). Die Sonne steht West-Nordwest über dem Pazifik und fällt als Streiflicht von hinten seitlich ein, dahinter liegen Meer und Pier-Restaurant. Die Scout-Aufnahmen `pier.png` und `lookout.png` (unter `/private/tmp/claude-501/gfx/ui/scout/`) zeigen, dass der Aussichtspunkt zu leer wirkt. Der Pier trägt als Motiv.
- **Das Auto:** Es ist das eigene Auto (`state.bulli`) vor `ready`. Es fährt nicht und wird nicht simuliert, es steht nur lokal auf dem Showroom-Platz. Andere Spieler sehen es nicht, weil der Server es erst beim Spawn setzt. Wechselt man das Auto, wird der Wagen in 250 ms getauscht: Er senkt sich 0,3 m ab, kurzes Ausblenden, der neue kommt. Im Karussell wird das nächste Modell schon vorgewärmt.
- **Kamera:** Neue Klasse `ShowroomCamera`. Die Posen berechnet eine reine Funktion `showroomPose(t, params)`, damit sie testbar ist. Die Kamera schwingt pendelnd ±35° um den Hero-Winkel (Dreiviertel von vorn), bei 6,5 m Abstand, 1,35 m Höhe und 35° FOV, mit einer Periode von 40 s. Sie macht bewusst keine volle Umrundung, damit das Gegenlicht und der Pier im Bild bleiben. `camera.setViewOffset` verschiebt das Auto aus der UI: auf dem Desktop in die rechten 60 %, auf dem Handy hoch in die oberen 55 %.
- **Kosten:** Auf Handys zeichnet der Showroom mit höchstens 30 fps, auf dem Desktop voll. Draw Calls und Dreiecke bleiben im Budget des Tiers (Desktop ≤ 300 Calls/1,2 Mio. Dreiecke, Handy ≤ 150/500 k), gemessen mit der neuen Screenshot-Ansicht `showroom`. Das Rendern hinter einem verdeckenden Menü entfällt, weil das Menü nicht mehr verdeckt.
- **Andere Spieler** fahren sichtbar vorbei, wenn sie in der Nähe sind (Remote-Autos wie im Spiel). Das belebt die Szene. Die Nametags der anderen blenden wir im Menü aus.

### 4.2 Layouts

**Desktop (≥ 1024 px breit, Querformat):**

```
┌──────────────────────────────────────────────────────────────────────┐
│┌──────────────┐                                       [⚙] [♪] [?]    │
││ BULLI DRIVE  │                                                      │
││ Driver name  │                ╭──────────╮                          │
││ [Logge     ] │               (  3D-Auto   )        Lack  ● ● ● ●    │
││              │                ╰──────────╯              ● ● ● ●    │
││ ▣ PARTY      │                                                      │
││ ▢ FREE ROAM  │   ‹ [Bulli][Beetle][Pickup][356][181] ›              │
││ ▢ RACE       │     Top speed 180 km/h ▬▬▬▬▬▬▭  Accel ▬▬▬▭  1500 kg  │
││ [  DRIVE   ] │                                                      │
│└──────────────┘  WASD drive · SPACE drift · SHIFT boost · R reset    │
└──────────────────────────────────────────────────────────────────────┘
```

Das linke Panel ist 360 px breit und vertikal zentriert. Autoreihe und Werte liegen unten mittig im Bereich des Autos. Die Lack-Chips stehen in einer kleinen Glaskarte rechts neben dem Auto, zwei Reihen à vier.

**Handy hoch** (iPhone 13, Pixel 7, ab 360×640): Oben liegen Wortmarke und ⚙, darunter die Showroom-Fläche (etwa 50–55 %) mit Autoname, Pfeilen ‹ ›, Punkten und den drei Werten. Unten folgt ein Glas-Sheet mit acht Lack-Chips (44 px), dem Namensfeld mit Label, den Modi als Segmentsteuerung mit einer Zeile Beschreibung und einem vollbreiten DRIVE-Button (56 px) im Daumenbereich über `env(safe-area-inset-bottom)`. Im Karussell wischt man auf der Showroom-Fläche. Unter 700 px Höhe (iPhone SE hoch) werden die Werte zu einer Zeile, und die Lack-Chips wandern in eine horizontal scrollende Reihe. DRIVE bleibt ohne Scrollen sichtbar.

**Handy quer** (iPhone SE quer 667×375 und kleiner): Das Auto steht links vollflächig, rechts liegt ein Panel von 320 px, das intern scrollt. DRIVE klebt am unteren Rand des Panels (`position: sticky`), Name, Lack und Modus stehen darüber. Das behebt den heutigen Befund, dass START unter der sichtbaren Fläche liegt. Die Autopfeile sitzen links und rechts am Auto. Die Safe Areas der Notch-Seiten werden eingehalten.

### 4.3 Elemente

| Element | Verhalten |
|---|---|
| **Name** | Sichtbares Label „Driver name“. Der gespeicherte Name wird vorbelegt (`bulli-player-name`), maximal 20 Zeichen. Enter startet. |
| **Autowahl** | Karussell mit fünf Karten. Die Renderings sind neu, im Dreiviertel-Profil mit 320×180 bei 2×, als WebP je ≤ 20 KB, gerendert aus den Blender-Skripten (`tools/models/build-all.mjs --icons --menu`). Die heutigen 52×32-Icons bleiben für die Race-Lobby. Der Wechsel tauscht das 3D-Auto (4.1). Namen in der UI: Bulli, Beetle, Pickup, 356, Type 181. Die IDs (`bulli`, `beetle`, `pickup`, `sport`, `jeep`) bleiben. |
| **Werte** | Topspeed in km/h (`topSpeed`·3,6: Bulli 180, Beetle 173, Pickup 169, 356 198, 181 176), Beschleunigung als Balken (`accel`, 8,0–11,0 m/s²) und Masse in kg (900–2000). Die Balken zeigen `0,35 + 0,65·(v − min)/(max − min)` über die fünf Klassen, damit kein Auto leer aussieht. Alles kommt aus `VEHICLE_CLASSES` und wird nirgends kopiert. Dazu kommt eine Zeile Charakter („Balanced, a little playful“, aus den Kommentaren der Klassen übernommen). |
| **Lack** | Acht Chips, Radiogruppe (Abschnitt 5). Vorausgewählt ist der zuletzt gewählte Lack, beim ersten Besuch der Werkslack des Autos, der zu seinem Rendering passt. |
| **Modus** | Drei Karten mit Radiogruppe: **Party**: „Coins, powerups, shooting – bump everyone.“ **Free Roam**: „Cruise the bay. Bumping allowed.“ **Race**: „6 tracks, lobby with bots. Time trial from the room menu.“ Bei gewähltem Race erscheint der Hinweis „You start in the race lobby – pick track and bots there.“ Die Wahl merkt sich wie heute `bulli-room-kind`, das Zeitfahren zählt als Race. |
| **DRIVE** | Großer Pillen-Button. Solange die Menü-Phase noch lädt (übrige Autos, Zeitüberschreitungen aus dem Loader), füllt sich der Button von links, und das Label lautet „LOADING 64 %“. Ein Klick darauf ist trotzdem erlaubt: Er merkt den Start vor (Label „STARTING…“) und fährt los, sobald alles da ist oder das Timeout abläuft. Ein zweiter Klick bricht nichts ab. |
| **Steuerungshinweis** | Eine Zeile je Eingabeart, ohne Q: Tastatur „WASD drive · SPACE drift · SHIFT boost · R reset · F horn“ (in der Party zusätzlich „E shoot“), Touch „Stick steer · AUTO gas · DRIFT · BOOST · hold reset“, Gamepad „RT gas · LT brake · A drift · B boost · View reset“. |
| **⚙ Einstellungen** | Dialog (`<dialog>`, Fokusfalle, Esc schließt). **Graphics**: Auto / Lite / High (Abschnitt 7). **Sound**: On/Off, als Master-Gain in `sounds.ts`, gespeichert unter `bulli-sound`. **Controls**: Registerkarten Keyboard / Touch / Gamepad mit voller Belegung; vorausgewählt ist die erkannte Eingabeart. |
| **♪** | Schnellschalter für Ton an/aus, gleicher Zustand wie in den Einstellungen. |
| **? About** | Kompakt in drei Zeilen: was das Spiel ist, Credits (Modelle: eigene Blender-Skripte; Texturen/HDRI: Poly Haven CC0 u. a. laut `LICENSES.md`; Schrift: Barlow, OFL), Build-Version. Die Party-Powerups stehen als Liste darunter, ohne „Jump“. |

### 4.4 Bedienung und a11y

- **Tastatur:** Die Tab-Reihenfolge ist Name → Autowahl → Lack → Modus → DRIVE → ⚙/♪/?. In Karussell und Radiogruppen wechseln die Pfeiltasten die Wahl (Roving Tabindex wie heute bei `.mode-option`). Enter im Namensfeld startet. Q/E als Kürzel für die Autowahl gibt es nicht, weil sie mit dem Spiel kollidieren würden.
- **Gamepad** (Standard-Mapping aus `input/gamepad.ts`, abgefragt nur solange das Menü offen ist): Steuerkreuz oder linker Stick hoch/runter wandert zwischen den Zeilen (Name überspringt es), links/rechts ändert die Wahl der Zeile, LB/RB wechselt das Auto überall, A aktiviert bzw. startet, Menu öffnet die Einstellungen, B schließt Dialoge. Der Fokusring ist dabei der sichtbare Cursor.
- **Touch:** Ziele sind mindestens 44×44 px, DRIVE hat 56 px. Wischen im Showroom wechselt das Auto. Kein Hover-only.
- **Screenreader:** Das Karussell trägt `role="group"` und `aria-roledescription="carousel"`, die gewählte Karte `aria-current`. Beim Wechsel wird „Beetle – 173 km/h, 900 kg“ angesagt. Die Lack-Chips haben Namen („Sea Green“). Das Canvas ist `aria-hidden`.
- **Fokus:** Ein 2-px-Ring in `--ui-paper` mit 2 px Abstand, immer über `:focus-visible`. Beim Öffnen des Menüs bekommt auf Geräten mit Tastatur das Namensfeld den Fokus, auf Touch-Geräten nichts, damit nicht sofort die Bildschirmtastatur aufgeht.
- **Kontraste:** Text mindestens 4,5:1 und große Schrift mindestens 3:1, jeweils auf dem hellsten Hintergrund. Einmalig lokal mit axe-core geprüft, nicht in CI.
- **Bewegung:** Mit `prefers-reduced-motion` steht die Showroom-Kamera still, und die Übergänge sind Überblendungen.

## 5. Lackfarbe (Protokoll v5)

Neues Modul `src/shared/paints.ts` mit `PAINT_IDS` und je Lack Name und sRGB-Hex. Startwerte, die im Lookdev (Showroom-Licht und Blender-Renders) nachjustiert werden:

| ID | Name | Hex |
|---|---|---|
| `sea` | Sea Green | `#5E8C7A` |
| `cream` | Pearl White | `#E6DFCC` |
| `red` | Sealing Red | `#8E2A28` |
| `blue` | Dove Blue | `#5C7C95` |
| `ochre` | Ochre | `#B8862F` |
| `orange` | Signal Orange | `#C8612A` |
| `silver` | Silver | `#9A9FA3` |
| `anthracite` | Anthracite | `#2A2C2E` |

Protokolländerungen:

- **`hello.paint?`**: `v.optional(v.picklist(PAINT_IDS))`. Damit steht die Farbe schon beim `welcome` fest, und das Showroom-Auto ist sofort richtig lackiert.
- **Neue Client-Nachricht `{ type: 'setPaint', paint }`** für einen Wechsel im Menü (und später im Spiel). Der Server setzt `session.color` auf den Hex-Wert des Lacks und teilt es dem Raum mit. Der Wechsel teilt sich das Rate-Limit mit `setCar`.
- **`playerUpdated.color?: number`** (additiv). Remote-Autos tauschen damit ihr Lackmaterial, ohne das Modell neu zu bauen.
- Ohne `paint` wählt der Server einen zufälligen Lack aus der Palette statt einer beliebigen 24-Bit-Farbe. Das gilt auch für die Race-Bots: `BOT_COLORS` wird durch die Palette ersetzt. Resume-Tickets behalten die Farbe wie heute.
- **Client:** `carPaintColor` erkennt Paletten-Hexwerte und übernimmt sie unverändert, weil sie bereits im Lookdev abgestimmt sind. Andere Werte, etwa von alten Tickets, werden wie heute gemappt. Die zweite Farbe (Creme-Oberteil bei Bulli und Pickup) bleibt fest am Modell.
- **`PROTOCOL_VERSION` 4 → 5.** Die neue Nachricht würde ein alter Server abweisen, und laut `protocol.ts` wird bei jeder inkompatiblen Änderung erhöht. Deploys laufen ohnehin über den Build-Check mit Neuladen. Der parallele Branch `sim/airborne-no-jump` fasst womöglich ebenfalls Protokollbits an. Wer zuletzt merged, legt beide Änderungen in eine Version zusammen (siehe Abschnitt 13).

## 6. Übergang Menü → Spiel

Ziel ist eine durchgehende Kamerafahrt vom Showroom in die Verfolgerkamera, ohne schwarzes Bild und ohne harten Schnitt. Der Spawn kann hunderte Meter entfernt sein (Party-Arena am Cannery Lot), und bei einem Moduswechsel steht er vorher gar nicht fest. Deshalb liegt der Schnitt im Himmel:

1. **Kran nach oben (0–0,7 s):** Die UI blendet aus (CSS, 240 ms). Die Kamera steigt vom Showroom auf etwa 30 m und neigt sich auf +26° nach oben, Richtung Sonne. Bei 35° vertikalem FOV liegt die Bildunterkante dann 8,5° über dem Horizont, im Bild ist nur noch Himmel.
2. **Unsichtbarer Wechsel:** Solange nur Himmel zu sehen ist, springt die Kamera über den Spawn-Punkt, sobald der Server gespawnt hat (`net.spawned`). Blickrichtung und Neigung bleiben dabei gleich. Der Himmel (HDRI oder analytischer Himmel, Nebel, Sonne) hängt nur von der Blickrichtung ab, deshalb ist der Wechsel nicht zu sehen. Dauert der Spawn länger, treibt die Kamera langsam weiter im Himmel. Nach 2 s geht es mit der Vorschau-Position des Servers weiter.
3. **Anflug (0,7–1,8 s):** Die Kamera sinkt ab und schwenkt mit Ease-out auf die Pose hinter dem Auto. `ChaseCamera` bekommt dafür `startFrom(pose)` und übernimmt mit ihrer normalen Dämpfung. Motor-Sound und HUD blenden in den letzten 300 ms ein.

Liegt der Spawn nahe am Showroom (unter 150 m, gleicher Raum), entfällt der Himmel. Die Kamera fliegt dann direkt als Hermite-Kurve von der Orbit- zur Verfolgerpose. Mit `prefers-reduced-motion` gibt es keinen Kran: Das letzte Showroom-Bild wird per `createImageBitmap` festgehalten und über 200 ms auf das erste Verfolgerbild überblendet. Die Posen berechnet `transitionPose(t, from, to, cutAt)` als reine Funktion (Test in Abschnitt 10). Das Canvas wird nie geleert, und die Deckkraft der Overlays geht nie über ein Bild ohne gezeichneten Frame.

## 7. Grafik-Einstellung und Lite

- **Auto / Lite / High** wird unter `bulli-graphics` gespeichert. Vorrang in `safeMode.ts`: URL `?lite=` > Nutzereinstellung > Trouble-Timer (`bulli-safe-mode-until`) > automatische Tier-Erkennung. „High“ erzwingt den Desktop-Tier mit HDRI und MSAA auch auf Handys. Bekommt das Gerät Grafikprobleme (Kontextverlust), fällt das Spiel wie heute auf Lite zurück, und die Einstellung zeigt dann „Auto (Lite after graphics trouble)“. MSAA und Tier gelten ab dem nächsten Laden, deshalb bietet der Dialog bei einer Änderung „Apply & reload“ an.
- **Lite im Menü:** kein laufender 3D-Showroom. Der Hintergrund ist die Key-Art. Das gewählte Auto wird einmal pro Wechsel (Auto oder Lack) als Einzelbild mit three.js in ein 640-px-Canvas gerendert: nur das Auto, Studio-Licht, transparenter Hintergrund, über die Key-Art gelegt. Der Render-Loop zeichnet im Menü sonst nichts, so wie heute unter dem Loader. Der Übergang ins Spiel ist dann eine Überblendung von 300 ms.
- Ist WebGL nicht verfügbar, gibt es wie heute die Meldung aus `contextLoss.ts`, jetzt im neuen Stil.

## 8. Architektur und Dateien

| Datei | Inhalt |
|---|---|
| `index.html` | Neuer `#loading-screen` (Key-Art-`<picture>`, Wortmarke als SVG, Balken, Status, Tipp), inline kritisches CSS, Bootstrap `__bulliLoad`. Neues Markup für `#splash-screen`: Die ID bleibt, siehe unten. About-Modal und alte Loader-Skripte entfallen. |
| `src/client/ui/loadProgress.ts` | Reines Fortschrittsmodell (3.2) |
| `src/client/ui/loadingScreen.ts` | Bindung an das DOM, Tipps, Übergabe an das Menü. `loadingScreenCovers` bleibt. |
| `src/client/ui/menu/menuState.ts` | Reiner Zustand: Auto, Lack, Modus, Name, Laden und Speichern mit injizierbarem Storage, Navigation (Karussell mit Umlauf, Zeilen- und Wertewechsel für Tastatur und Gamepad) |
| `src/client/ui/menu/menu.ts` | Controller: DOM, Events, Gamepad-Polling, Start-Ablauf. Ersetzt die Splash-Teile aus `screens.ts` und `roomMenu.ts` (`initModeSelector`, `applySplashChoice`). |
| `src/client/ui/menu/carStats.ts` | Werte und Balken aus `VEHICLE_CLASSES` |
| `src/client/ui/menu/settingsDialog.ts`, `src/client/ui/settings.ts` | Einstellungen und ihre Speicherung |
| `src/client/camera/ShowroomCamera.ts` | `showroomPose`, `transitionPose` (rein) und die Klasse |
| `src/client/ui/menu.css` | Stile für Loader und Menü. Die alten Splash- und Loader-Regeln fliegen aus `style.css` (etwa 400 Zeilen). |
| `src/shared/paints.ts`; `protocol.ts`; `server/handshake.ts`, `dispatch.ts`, `rooms/Room.ts`, `race/botRoster.ts` | Lack (Abschnitt 5) |
| `src/shared/maps/bulli-bay/pois.json` | POI `showroom` |
| `public/ui/keyart-*.webp`, `public/fonts/*.woff2`, `public/icons/car-*-menu.webp` | Assets mit Lizenzen in `LICENSES.md` |
| `tools/ui/keyart.ts`, `tools/ui/wordmark.mjs`, `tools/ui/keyart-prompt.md` | Erzeugung der Assets |
| `vite.config.ts` | Plugin: Chunk-Größen als `data-size` an den `modulepreload`-Links |
| `scripts/screenshots.ts` | Neue Ansichten `loader`, `menu`, `menu-phone`, `menu-landscape`, `showroom` für Vorher/Nachher und das Draw-Call-Budget |

**Stabile Selektoren:** `#loading-screen`, `#splash-screen` (Klasse `hidden` nach dem Start), `#splash-name-input`, `.mode-option[data-room]` (`role="radio"`, `aria-checked`) und `#start-btn` bleiben als IDs bzw. Klassen erhalten. So müssen `tests/e2e/fixtures.ts` und die Unit-Tests (`indexHtml`, `roomMenu`, `loadingScreen`) nur dort angepasst werden, wo sich das Verhalten ändert. Ein Beispiel: `openGame` wartet weiter auf den entfernten Loader und das sichtbare Menü.

## 9. Performance-Budgets

| Messgröße | Budget |
|---|---|
| Inline-CSS + Inline-JS im `<head>` | ≤ 6 KB (ohne den Stale-Guard) |
| Blur-Platzhalter inline | ≤ 1,5 KB |
| Key-Art | Desktop ≤ 250 KB, Handy ≤ 120 KB |
| Schriften | ≤ 60 KB WOFF2, zwei davon vorgeladen |
| Menü-Renderings der Autos | je ≤ 20 KB |
| Showroom-Bild | im Draw-Call- und Dreiecksbudget des Tiers, Handy ≤ 30 fps |
| Erster Paint des Loaders | ohne JS, nur HTML + Inline-CSS + Platzhalter |

## 10. Tests (Pyramide)

Wir testen auf der niedrigsten Ebene. Erwartungswerte kommen von Hand oder aus der Physik, nie aus dem Code, der getestet wird. Für jeden neuen Test machen wir die Mutationsprobe.

**Unit (Vitest):**

- `loadProgress`: Gesamtwert per Handrechnung (z. B. Gewichte 20/5/15, Anteile 1/1/0,5 → 32,5/40 = 0,8125). `skip` nimmt einen Schritt aus dem Nenner, ohne dass der Balken zurückgeht. Monotonie bei einem rückläufigen `report`. Timeouts mit skriptierter Uhr. Die Statuszeile wählt den laufenden Schritt mit dem größten offenen Gewicht.
- `menuState`: Karussell läuft in beide Richtungen um (5 → 1). Tastatur- und Gamepad-Navigation wird auf die Zeilen abgebildet. Wiederherstellen aus dem Storage, mit Rückfall bei ungültigen Werten und bei einem werfenden Storage.
- `carStats`: 356 → 198 km/h und Balken 1,0; Pickup 169 km/h und Balken 0,35; Beetle 900 kg (Handrechnung aus den Klassentabellen).
- `showroomPose`/`transitionPose`: Bei t = 0 steht die Orbitpose, am Schnittpunkt ist die Neigung ≥ halbes FOV + Rand (nur Himmel), am Ende steht die Verfolgerpose. Keine Sprünge über ε zwischen 1-ms-Proben außer am Schnitt. Reduced Motion ergibt keinen Kran.
- `safeMode`: Vorrang URL > Einstellung > Trouble > Auto als Tabelle.
- `shared/protocol`: `setPaint` gültig und ungültig, `hello` mit und ohne `paint`, `playerUpdated.color`. Die Versionsnummer ist 5.
- `server/room`, `server/handshake`: `setPaint` setzt `session.color` auf den Paletten-Hexwert und sendet `playerUpdated` mit `color` an den Raum. Rate-Limit gemeinsam mit `setCar`. Ohne `paint` stammt die Farbe aus der Palette (Zufall injiziert über `RandomSource`).
- `carMaterials`: Paletten-Hexwerte gehen unverändert durch, andere Werte werden weiter gemappt.
- `indexHtml`: Loader-Markup mit `role="progressbar"`, inline kritisches CSS vorhanden, kein Google-Fonts-Link, Key-Art vorgeladen, kein „Q“ und kein „jump“ in Menü- und Hilfetexten, stabile Selektoren vorhanden.
- Asset-Größen: Die Key-Art-Varianten und die Menü-Renderings halten ihre Budgets (Dateigröße auf der Platte).

**Integration:** Keine neuen Tests. Der Lack-Weg ist mit den Server-Unit-Tests abgedeckt, Protokoll und Tick ändern sich nicht.

**E2E:** Keine neue Spec. Die Anpassungen:

- `fixtures.ts` bekommt die geänderten Wartebedingungen (Loader bis „Showroom bereit“).
- Der Mobile-Join prüft einmal `topmostAtCenter('#start-btn')`, dass DRIVE ohne Scrollen tippbar ist. Der Helper existiert schon.
- Die Suite bleibt unter 5 Minuten. Die längere Loader-Phase verschiebt nur die Wartezeit vom START zum Laden.

**Render/Screenshots:** Neue Ansichten in `scripts/screenshots.ts` für Vorher/Nachher und für das Draw-Call-Budget. Das ist kein CI-Gate.

**Stryker:** `src/shared/paints.ts` und die geänderten Server-Dateien liegen im Mutationsbereich und bekommen ihren gezielten Lauf vor dem Merge.

## 11. Umsetzungsschritte

Jeder Schritt ist für sich lauffähig und mergebar.

| Schritt | Inhalt |
|---|---|
| **U1 Loader** | Schriften selbst ausliefern, Wortmarke, Key-Art-Skript und Assets, `loadProgress` mit allen Quellen, Inline-CSS und Bootstrap, Tipps, Fehler-Overlays im neuen Stil. Das Menü bleibt vorerst das alte, liegt aber auf der Key-Art. |
| **U2 Menü-Overlay** | Layouts Desktop, hoch und quer, Karussell mit Renderings und Werten, Modus-Karten, DRIVE mit Fortschritt, Einstellungsdialog, About, a11y, Tastatur und Gamepad. Hintergrund noch Key-Art bzw. Lite-Einzelbild. `fixtures.ts` wird angepasst. |
| **U3 Lack** | `paints.ts`, Protokoll v5, Server, Chips, Remote-Update |
| **U4 Showroom und Übergang** | POI, `ShowroomCamera`, Autotausch, Kran-Übergang, Reduced Motion, fps-Deckel auf Handys |
| **U5 Feinschliff** | Gewichte kalibrieren (`?debug=load`), Screenshots Nachher an denselben vier Geräten, Budgets, axe-Check, Stryker, Doku aktualisieren |

## 12. Entscheidungen

| # | Entscheidung | Warum |
|---|---|---|
| D1 | Key-Art als In-Engine-Render statt KI-Bild; Codex nur als Fallback | Übergang ohne Schnitt, stimmt mit der Karte überein, reproduzierbar |
| D2 | Showroom am Pier-Kopf, nicht am Aussichtspunkt | Der Aussichtspunkt wirkt im Scout-Bild leer (Parkplatz, Zaun). Am Pier stehen Wasser, Gegenlicht und Wiedererkennung im Bild |
| D3 | Übergang über einen Schnitt im Himmel statt Kamerafahrt über die Karte | Der Spawn ist weit weg oder vorab unbekannt (Moduswechsel). Ein Flug über hunderte Meter würde Terrain- und Kit-Streaming mitten im Übergang auslösen |
| D4 | Loader bleibt, bis das erste Showroom-Bild vollständig ist | Keine untexturierte Welt im Menü. Die Gesamtzeit bis zum Fahren ändert sich nicht, weil das Gate heute schon wartet |
| D5 | Lack aus einer kuratierten Palette von 8 statt freiem Farbwähler | Passt zum ruhig-naturgetreuen Look, und die Paletten-Hexwerte lassen sich im Lookdev abstimmen |
| D6 | `PROTOCOL_VERSION` → 5 | Eine neue Nachricht ist mit alten Servern inkompatibel, die Regel in `protocol.ts` verlangt das |
| D7 | Stabile IDs und Klassen für den Join-Flow behalten | Die E2E-Fixtures ändern sich minimal, keine neuen Specs |
| D8 | UI-Sprache bleibt Englisch | Wie das HUD und die Race-Oberfläche. Deutsch nur in der Doku |
| D9 | Barlow selbst ausgeliefert statt Google Fonts | Kein Fallback auf `cursive` ohne Netz, ruhige technische Anmutung, OFL |
| D10 | Grafik „High“ ist auch auf Handys wählbar | Die Nutzer entscheiden selbst. Der Rückfall nach Kontextverlust auf Lite bleibt als Sicherheitsnetz |
| D11 | Kein Sprung und kein Q in Menü- und Hilfetexten | Das Entfernen läuft parallel auf `sim/airborne-no-jump`. Beim Ship rebasen wir darauf und gleichen die HUD-Hinweise (`jump-hint`, `#btn-flip`) dort ab |

## 13. Offene Punkte

- **HUD-Typografie:** Das HUD auf die neue Schrift und die neuen Tokens umstellen. Das ist ein eigener Schritt, weil HUD-Goldens und Render-Tests betroffen sind.
- **Einstellungen im Spiel:** Den Dialog auch aus dem Raum-Menü (`roomMenu.ts`) öffnen können. Die Komponente ist dafür vorbereitet.
- **Spielerzahl je Modus:** Die Modus-Karten könnten zeigen, wie viele Spieler gerade in einem Modus sind. Dafür bräuchte es einen öffentlichen Endpunkt oder eine Lobby-Nachricht vor `ready`, das ist nicht Teil dieses Auftrags.
- **Merge mit `sim/airborne-no-jump`:** Beide Branches fassen wohl Protokoll und HUD-Hinweise an. Die Versionsnummer und die Steuerungstexte legen wir beim zweiten Merge zusammen.
