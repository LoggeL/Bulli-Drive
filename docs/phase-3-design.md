# Phase 3: Kuratierte Map „Bulli Bay“ – Konzept und technische Spezifikation

**Stand:** 2026-09-24 · **Branch:** `map/phase-3` (auf `main` e1fccbd) · Bezug: [`refactor-plan.md`](refactor-plan.md) Abschnitt 0 (Entscheidung 3), 5 (Phase 3), 6 (Determinismus) · Grundlagen: [`phase-1a-design.md`](phase-1a-design.md) (Sim, Collider), [`phase-1b-design.md`](phase-1b-design.md) (`MapData`, `worldHash`), Phase 2 (`docs/phase-2-design.md` auf `game/phase-2-racing`: `TrackDef`, Gates, Ideallinie), [`world-look.md`](world-look.md) (Look, Tiers, Draw Calls), [`assets.md`](assets.md) (Pipeline, Budgets)

Dieses Dokument beschreibt die Karte, die Datenformate und die Budgets für Phase 3. Das Datenformat, die Interpolation des Heightfields und die Modulgrenzen sind verbindlich. Zahlen, die als *Startwert* markiert sind, werden beim Bau der Karte, im Tuning-Panel und bei Messungen nachjustiert. Abweichungen kommen wie in 1a/1b in einen eigenen Abschnitt am Ende und werden nicht still umgesetzt.

**Rahmen (aus den Nutzerentscheidungen, nicht verhandelbar):**

- Eine **kuratierte Map von 1,5–2 km** mit handgebauten Straßen-Splines als JSON. Es gibt kein Streaming: Die ganze Karte wird beim Start geladen, Chunks dienen nur dem Culling und dem Merging (Plan, Entscheidung 3).
- **Mobile ist gleichwertig:** Jedes Budget gilt für Tier low (iPhone 12/13) genauso wie für den Desktop.
- **Der Party-Modus bleibt** und bekommt eine eigene Zone (Plan 8.5).
- **Server-autoritativ:** Der Server simuliert mit derselben shared-Sim. Der Boden (Heightfield) muss auf Client und Server exakt gleich sein.
- **Neue Features gehen direkt live**, ohne Feature-Flag. Die Karte geht deshalb erst live, wenn sie als Ganzes spielbar ist (Abschnitt 14).
- `src/shared` bleibt frei von three, DOM und Node-Globals (`tests/shared/purity.test.ts`).

---

## 1. Kurzfassung

Bulli Bay ist eine fiktive kalifornische Küstenkleinstadt auf einem Quadrat von 2 × 2 km, davon rund 1,8 × 1,8 km befahrbar. Im Westen liegt der Pazifik mit Strand, Pier und Promenade. Dahinter liegen ein Downtown-Raster mit Main Street und Plaza, ein Wohnviertel am Hang, im Süden Hafen und Industrie mit der Party-Arena auf einem stillgelegten Cannery-Parkplatz. Im Nordosten führen Serpentinen zu einem Aussichtspunkt auf 145 m. Die Küstenstraße läuft im Norden und Süden an Klippen entlang. An der Ausfallstraße nach Osten stehen Tankstelle und Diner. Offroad gibt es am Strand, in den Dünen und auf Feldwegen im Ranchland.

Technisch besteht die Karte aus drei Quellen: `roads.json` (Knoten, Kanten mit Catmull-Rom- oder Bézier-Kurven, Querschnittsprofile), `map.json` (Zonen, Plätze, Landmarken, Spawns, Party-Arena, Strecken-Routen) und einem Grundgelände. Ein Bake-Werkzeug (`tools/map/bake.ts`) erzeugt daraus deterministisch eine Binärdatei `terrain.bhf` mit Heightfield (2 m, Uint16, 1 cm Auflösung), Oberflächen-Raster und Zonen-Maske. Client und Server laden dieselben Bytes und interpolieren mit derselben Funktion aus `src/shared/map/heightfield.ts` bilinear. Neue Strecken entstehen mit `routeToTrack` aus einer Liste von Kanten.

![Luftbild-Konzeptskizze von Bulli Bay](img/phase-3-map-concept.png)

*Konzeptskizze (KI-generiert mit Codex-imagegen, 960 px, auf 160 Farben reduziert). Sie zeigt Stimmung und grobe Anordnung, nicht die Maße. Maßgeblich sind die Koordinaten in Abschnitt 3. Abweichungen der Skizze: Die Main Street läuft dort von Norden nach Süden statt vom Pier nach Osten, die Dünen liegen nördlich von Downtown statt zwischen Strand und Nordklippen, die Party-Arena liegt östlich der Industrie statt hinter der Cannery, und der Maßstabsbalken passt nicht zu 2 km. Bild ist nur Dokumentation, kein Spiel-Asset.*

---

## 2. Entscheidungen dieser Phase (selbst getroffen)

| # | Frage | Entscheidung | Begründung |
|---|---|---|---|
| E1 | Größe der Karte | **2000 × 2000 m** Datenfläche (x, z ∈ [−1000, 1000]), davon ca. **1,8 × 1,8 km befahrbar**. Der Rand von 100 m ist Kulisse (Meer, steile Hänge). | Liegt im Rahmen von 1,5–2 km. Ein gerades Quadrat mit 8 × 8 Chunks zu 250 m. Der Rand verhindert, dass man die Welt „enden“ sieht. |
| E2 | Himmelsrichtung | **Norden = −z, Osten = +x.** In der Draufsicht von oben (rechtshändig, y oben) liegt dann Osten rechts, wenn Norden oben ist. Das Meer liegt im Westen (−x). | Mit dieser Zuordnung stimmen Karte und Fahrersicht überein (links vom Auto bei yaw = π, also Blick nach Norden, ist −x = Westen). Die Minimap muss dieselbe Ausrichtung zeigen; die Integration bekommt dafür einen Achsen-Test (Abschnitt 15). |
| E3 | Heightfield-Raster und Kodierung | **2 m**, 1001 × 1001 Stützpunkte, **Uint16 mit Offset −20 m und Skala 0,01 m** (Bereich −20 … 635,35 m). Kein Float16. | Float16 hat bei 128–256 m Höhe nur 12,5 cm Auflösung, und das Dekodieren braucht Bit-Arbeit. Uint16 mit 1 cm ist exakt, ganzzahlig und komprimiert gut (Messung in 6.2). 2 m genügen für Kehren mit 15 m Radius und für Böschungen. |
| E4 | Gleichheit Client/Server | **Dieselbe Datei, dieselbe Funktion.** Das Heightfield wird nicht zur Laufzeit berechnet, sondern gebacken und als Asset ausgeliefert. `heightAt` nutzt nur +, −, ×, ÷ und `Math.floor` auf Double. | IEEE-754 rundet diese Operationen exakt, und JavaScript kennt keine FMA-Kontraktion. Damit ist das Ergebnis in V8, JavaScriptCore und SpiderMonkey bitgleich (Plan 6: „vorberechnetes Heightfield“). Keine Sinus-Summen mehr im Sim-Boden. |
| E5 | Wer rechnet das Road-Corridor-Flatten? | **Nur das Bake-Werkzeug** (Node, `tools/map`). Die Laufzeit liest das Ergebnis. | Das Flatten ist teuer (Distanzfeld über 1 Mio. Punkte) und muss nicht auf dem Handy laufen. Es gibt nur eine Wahrheit: die Bytes der Datei. |
| E6 | Oberflächen in der Sim | **Oberflächen-Raster 2 m** (Uint8, nächste Zelle) in derselben Datei, abgefragt an der Vorder- und Hinterachse. | Die Sim hat `offroadGrip`/`offroadDrag` schon je Klasse („take effect in phase 3“). Ein Raster ist O(1) und auf beiden Seiten gleich; ein Abstandstest zu allen Splines wäre teurer und nicht exakt gleich. |
| E7 | Terrain-Rendering | **Ein Terrain-Mesh für die ganze Karte als CDLOD** (Quadtree, ein instanziertes Patch, Höhen aus einer Float-Textur, Geomorphing). LOD0 hat genau das 2-m-Raster. | 1–2 Draw Calls für das ganze Gelände statt einem pro Chunk und LOD. Nah an der Kamera liegen die Mesh-Ecken genau auf den Stützpunkten, also passt die Optik zur Sim. |
| E8 | Neue Collider-Formen | **`segment`** (Kapsel entlang einer Strecke, für Leitplanken, Geländer, Zäune, Kartenrand) und **`obox`** (gedrehte Box, für Gebäude an schrägen Straßen, Container). | Kreisketten würden an Leitplanken holpern und die Anzahl der Collider aufblähen. Kreis gegen Kapsel und Kreis gegen gedrehte Box sind einfache, exakte Tests. Die bestehenden Karten nutzen die neuen Formen nicht, alle Goldens bleiben gleich. |
| E9 | Brücken und Ebenen übereinander | **Keine** in v1. Die einzige „Ebene über Wasser“ ist der Pier, und er liegt im Heightfield. | Ein Heightfield kann nur eine Höhe pro Punkt. Brücken bräuchten Deck-Flächen in der Sim, den Ramps ähnlich. Das kann später kommen (Abschnitt 17). |
| E10 | Party-Zone | **Arena „Cannery Lot“** am Hafen, 180 × 140 m, umzäunt. Der PartyRoom spawnt nur dort, seine Sim-Welt hat einen Zaun als Grenze. | Plan 8.5: eigene Zone statt der ganzen Karte, damit sich Free Roam und Party nicht stören. Kampf und Coins brauchen Dichte. |
| E11 | Phase-2-Strecken | **Portieren**, nicht die alte Stadt mitführen. `downtown-loop` und `hill-sprint` behalten ihre IDs, bekommen eine Route auf Bulli Bay und eine neue `mapVersion`. | Der Plan erlaubt beides. Zwei Karten im Build verdoppeln Assets, Tests und Pflege. Bestenlisten gibt es erst in Phase 4, verloren gehen nur Ghosts aus dem Zeitfahren (per `trackVersion` ungültig). |
| E12 | Zufall der Bestückung | **Integer-Hash je (Kante, Los-Index) bzw. (Chunk, Zelle)**, kein fortlaufender RNG-Strom. | Ändert man eine Straße, ändern sich nur die Gebäude an dieser Straße, nicht die der ganzen Stadt. Keine `Math.sin`-Hashes (Plan 7, Risiko „Math.sin“). |
| E13 | Datei-Kompression | **Zeilen-Prädiktor im Format** (dekodiert in `src/shared`) plus **Brotli/Gzip über HTTP** mit dem bestehenden Mechanismus aus `server/staticAssets.ts` (wie bei den HDRIs). | Kein zusätzlicher Dekompressor im Client, keine Node-Abhängigkeit in `shared`. Der Server liest die Datei roh vom Datenträger. |
| E14 | Brücke Phase 2 → 3 | Neue Module liegen in **`src/shared/map/`** und **`tools/map/`**. `src/shared/world/*`, `src/client/world/*` und `src/server/*` bleiben bis zur Integration unverändert. | Phase 2 läuft parallel und ändert `shared/race`, `server/rooms` und das HUD. Getrennte Ordner vermeiden Konflikte; die Integration folgt nach dem Merge von Phase 2 (Abschnitt 14). |

---

## 3. Die Karte

### 3.1 Koordinaten, Maße, Höhen

- 1 u = 1 m. Datenfläche x, z ∈ [−1000, 1000]. **Norden = −z, Osten = +x** (E2). In diesem Dokument stehen Punkte als `(x | z)`.
- **Meeresspiegel y = 0.** Der Meeresboden fällt bis −12 m ab, der Strand liegt bei 0–3 m, Downtown bei 4–14 m (sanft nach Osten steigend), das Wohnviertel bei 10–50 m, der Aussichtspunkt bei 145 m, die Klippenstraße bei 30–45 m.
- Befahrbare Grenze: ein Polygon ca. 100 m innerhalb des Quadrats. Im Westen ist das Meer die Grenze (Wasser-Reset, Abschnitt 7).

### 3.2 Übersicht (nicht maßstäblich)

```
                       N (−z)
 z=−1000  ~~~~~~~~~~~~~~│PCH│ Nordklippen (35–45 m)            Wildnis, Chaparral
          ~~~~~~~~~~~~~ │   │                                        ▲ Lookout 145 m
          ~~~~~~~~~~~~~ │   │                                   ╭─╮╭─╯
          ~~~~~~~~~~~~~~ \  │                               ╭──╯ ╰╯  Ridge Road
 z=−400   ~~~~~~~~~~~ ░░Dünen░ ╲                          ╭─╯   (6 Kehren)
          ~~~~~~~~~~ ░░░░░░░░   ╲         Wohnviertel      │     Hügel „Bulli Ridge“
          ~~~~~~~~~~ ▒Strand▒ ║ ┼──┼──┼──┼   „Seaview       │
          ~~~~~~~~~~ ▒▒▒▒▒▒▒▒ ║ ┼──┼PL┼──┼    Heights“      │
 z=0      ~~~~ Pier ═══════════╬═Main St═╬════════ Canyon Road ════ ⛽ Diner ═══════► Ost (+x)
          ~~~~~~~~~~ ▒▒▒▒▒▒▒▒ ║ ┼──┼──┼──┼   (Kurven,
          ~~~~~~~~~~ ▒▒▒▒▒▒▒▒ ║ ┼──┼──┼──┼    Sackgassen)        Ranchland, Feldwege
 z=+300   ~~~~~~~~~~~~~~~~~~~ ╚═══ Harbor Blvd ════╗              (Eichen, Gras gold)
          ~~~~ Wellenbrecher  ┃ Kais  Cannery ▣▣  ║ Container
          ~~~~~ ═════╗ Becken ┃ ▣▣ ┌─Party-Arena─┐ ║
          ~~~~~~~~~~ ║ ~~~~~~ ┃    │ Cannery Lot │ ║
 z=+700   ~~~~~~~~~~~~~~~~~~~ ╲    └─────────────┘
          ~~~~~~~~~~~~~~~~~~~~ ╲ Südklippen (30 m), PCH nach Süden
 z=+1000  ~~~~~~~~~~~~~~~~~~~~~~│PCH│
        x=−1000        −600          −200          +200          +600         +1000
```

### 3.3 Zonen

| Zone | Lage (x \| z) *Startwert* | Höhe | Charakter | Straßen | Befahrbar abseits der Straße |
|---|---|---|---|---|---|
| **Pazifik** | westlich der Wasserlinie, x < −650 … −620 | Boden bis −12 m | Meer mit Brandung, Horizont | – | nein (Wasser-Reset) |
| **Strand & Pier** | x −680 … −590, z −320 … +260; Pier bei z −20 von x −590 bis −805 | 0–3 m, Pier-Deck +5 m | breiter Sandstrand, Rettungsschwimmer-Türme, Pier aus Holz mit Geländer | Pier (Holz, 10 m, Schritttempo), Strandzufahrten | ja: Sand, nasser Sand an der Wasserlinie |
| **Promenade** | entlang x ≈ −560, z −330 … +280 | 3–5 m | Ocean Boulevard mit Palmen-Mittelstreifen, Fußgänger-Promenade zum Meer, Surf-Shop | PCH-Abschnitt, 2 + 2 Spuren | nein (Bordstein) |
| **Downtown** | x −540 … −200, z −260 … +200 | 4–14 m | Raster aus 4 Avenues (N–S bei x −470, −390, −310, −230) und 5 Streets (O–W bei z −240, −130, −20, +90, +200). **Main Street** = z −20 vom Pier nach Osten. **Plaza** nördlich der Main Street zwischen 2nd und 3rd Ave (Brunnen aus `fountain.ts`). **Palm Park** zwischen 3rd und 4th Ave südlich der Main Street. Zwei- bis viergeschossige Stuckhäuser, Läden, Markisen | Main St 1 + 1 mit Schrägparken, Avenues 1 + 1, Ampeln an der Main Street | nein |
| **Wohnviertel „Seaview Heights“** | x −200 … +380, z −480 … +260 | 10–50 m | geschwungene Straßen, Sackgassen, Einfamilienhäuser mit Garagen, Gärten, Zypressen | 1 + 1, schmal (7 m), keine Mittellinie | Vorgärten nein (Bordstein), Böschungen am Hang ja |
| **Hügel „Bulli Ridge“** | x +250 … +920, z −920 … −250 | 30–145 m | goldenes Trockengras, Chaparral, Felsen, Eichen. **Aussichtspunkt** (+640 \| −760) mit Parkplatz, Münzfernrohr, Blick auf die Bucht | **Ridge Road** mit 6 Kehren (R 14–20 m), Steigung bis 12 % | ja: Gras, Erde; steile Hänge bremsen |
| **Nordklippen & Küstenstraße** | x −640 … −500, z −1000 … −330 | 30–45 m auf einem Felsband | Steilküste, Leitplanken, Aussichtsbuchten | **PCH** 1 + 1, 9 m, Leitplanke meerseitig | nein (Leitplanke / Felswand) |
| **Dünen** | x −680 … −560, z −480 … −320 | 3–15 m | Sanddünen mit Strandhafer, Holzzaun-Reste | Sandpisten | ja: Sand |
| **Industrie & Hafen** | x −620 … +120, z +300 … +760; Hafenbecken x −660 … −480, z +340 … +640 | 2–6 m (Kais 2,5 m) | Cannery, Lagerhallen, Containerlager, Fischmarkt, Kräne, Wellenbrecher mit Leuchtturm | Harbor Blvd 1 + 1 (Beton), Kai-Straße, Gleisspur (Optik) | nein (Kaikante mit Poller-Kette) |
| **Party-Arena „Cannery Lot“** | x −260 … −80, z +520 … +660 | 3 m | stillgelegter Parkplatz der Cannery: rissiger Asphalt, verblasste Stellplätze, Container als Deckung, 2 Rampen, Laderampen, Maschendrahtzaun | Zufahrt vom Harbor Blvd | innerhalb des Zauns frei |
| **Ausfallstraße, Tankstelle & Diner** | Canyon Road von (−200 \| −20) nach (+1000 \| +40); Diner und Tankstelle bei (+560 \| +60) | 20–35 m | „Bulli's Diner“ und „Seaside Service“ (Ladenfronten aus `storefront_atlas`), Parkplatz, Neon | Canyon Road 1 + 1 mit Standstreifen, 11 m | Parkplatz ja |
| **Südklippen** | x −600 … −300, z +760 … +1000 | 25–35 m | Steilküste wie im Norden | PCH nach Süden | nein |
| **Ranchland** | x +150 … +920, z +250 … +920 | 20–70 m | Weiden, Eichen, Holzzäune, Scheune | **Fire Roads** (Erde, Schotter), Anschluss an Diner und Ridge Road | ja: Gras, Erde |

### 3.4 Straßennetz *(Startwerte)*

| Straße | Verlauf | Länge | Profil |
|---|---|---|---|
| Pacific Coast Highway (PCH, „SR 1“) | Nordrand (−560 \| −1000) → Klippen → Ocean Blvd → Harbor → Südklippen → (−500 \| +1000) | ca. 2,6 km | 1 + 1 (Klippen), 2 + 2 (Ocean Blvd), Leitplanken an Klippen |
| Main Street + Canyon Road | Pier (−590 \| −20) → Downtown → durch Seaview Heights → Diner → Ostrand | ca. 1,6 km | 1 + 1, in Downtown mit Schrägparken |
| Downtown-Raster | 4 Avenues à 460 m, 5 Streets à 340 m | ca. 3,5 km | 1 + 1, Bordstein, Gehweg 3 m |
| Seaview Heights | Schleifen und Sackgassen | ca. 4,5 km | 1 + 1 schmal, Bordstein |
| Ridge Road | Canyon Road (+380 \| −60) → Aussichtspunkt | ca. 2,1 km | 1 + 1, 8 m, Leitplanken talseitig |
| Harbor Blvd, Kai- und Werksstraßen | Hafen und Industrie | ca. 2,5 km | Beton, 1 + 1, teils ohne Markierung |
| Fire Roads, Sandpisten | Ranchland, Dünen, Strand, Anschluss an die Klippen | ca. 5 km | Erde, Schotter, Sand, 5–7 m |
| **Summe** | | **ca. 22 km**, davon ca. 16 km befestigt | |

### 3.5 Spawns und Landmarken

- **Free-Roam-Spawns** (je 4 Plätze): Plaza, Diner-Parkplatz, Strandparkplatz am Pier, Aussichtspunkt. Der Server verteilt reihum und prüft den Mindestabstand wie heute.
- **Landmarken** (handplatziert in `map.json`, nicht prozedural): Pier mit Pier-Restaurant am Kopf, Plaza-Brunnen, Leuchtturm am Wellenbrecher, Wasserturm „Bulli Bay“ über dem Wohnviertel, Cannery-Halle mit Schornstein, Diner und Tankstelle, Aussichtspunkt mit Parkplatz, Rettungsschwimmer-Türme.
- **Minimap:** Namen der Zonen und Straßen kommen aus `map.json`/`roads.json`.

---

## 4. Rennstrecken

Alle Strecken liegen auf den Splines und entstehen mit `routeToTrack` (Abschnitt 13). Längen und Zeiten sind *Startwerte* aus der Planung, die Bots messen sie nach.

| # | ID / Name | Art | Verlauf | Länge | Belag | Charakter | geschätzte Zeit |
|---|---|---|---|---|---|---|---|
| T1 | `downtown-loop` „Downtown Loop“ (**Port** aus Phase 2) | Rundkurs, 3 Runden, gegen den Uhrzeigersinn | Start/Ziel auf der Main Street zwischen 3rd und 4th Ave (Richtung Osten) → 4th Ave nach Norden → Cliff St (z −240) nach Westen → Ocean Blvd an der Promenade nach Süden → z +90 nach Osten → 3rd Ave nach Norden am Palm Park vorbei → Main Street | ca. 1,3 km | Asphalt | 6 Kurven zu 90° (5 links, 1 rechts), zwei lange Geraden (Cliff St, Promenade), Bordsteine, kein Selbstkreuzen | ca. 55 s pro Runde, 2:45 gesamt |
| T2 | `coast-sprint` „Coast Sprint“ | Sprint | PCH vom Nordrand über die Klippen, hinunter zum Ocean Blvd, am Hafen vorbei auf die Südklippen, Ziel an der Aussichtsbucht (−480 \| +940) | ca. 2,4 km | Asphalt | schnell (bis ca. 180 km/h), lange Bögen, Leitplanken, Gefälle von 40 m auf 4 m | ca. 65 s |
| T3 | `hill-sprint` „Ridge Climb“ (**Port** aus Phase 2 „Hill Sprint“) | Sprint | Plaza → Main Street → Canyon Road → Ridge Road mit 6 Kehren → Aussichtspunkt | ca. 2,6 km, +140 m | Asphalt, eine Schotter-Abkürzung | Hill-Climb; drei Rampen wie im Original (Stadtausfahrt, Schotter-Abkürzung, Kuppe vor dem Ziel) | ca. 1:45 |
| T4 | `harbor-circuit` „Harbor Circuit“ | Rundkurs, 3 Runden, im Uhrzeigersinn | Harbor Blvd → Kaistraße entlang des Beckens → Schikane durch das Containerlager → hinter der Cannery zurück | ca. 1,2 km | Beton, kurzes Erdstück | eng, technisch, Rempeln an der Schikane | ca. 55 s pro Runde, 2:45 gesamt |
| T5 | `dune-rally` „Dune Rally“ (Bonus) | Sprint | Strandparkplatz → Strand nach Norden → Dünen → Sandpiste hinauf auf die Nordklippen → Ziel an der PCH-Aussichtsbucht | ca. 1,6 km | Sand, Erde | Offroad, springende Dünenkämme, stark für den Typ 181 | ca. 75 s |
| T6 | `grand-tour` „Grand Tour“ (später) | Sprint | durch alle Zonen: Pier → Downtown → Seaview → Ridge → Ranch → Hafen → Südklippen | ca. 6 km | gemischt | lange Tour, Event-Marker in Phase 4 | ca. 3:30 |

Die Strecken kreuzen sich untereinander, aber keine Strecke kreuzt sich selbst (keine Frontalbegegnungen im Rennen). Wo eine Route eine Kreuzung durchfährt, sperrt `routeToTrack` die anderen Äste mit Barrieren-Reihen (wie die Hints in Phase 2).

---

## 5. Straßen-Spline-Format (`roads.json`)

### 5.1 Dateien

```
src/shared/maps/bulli-bay/
  roads.json        # Straßennetz (Quelle, vom Spline-Editor geschrieben, per Hand editierbar)
  map.json          # Zonen, Plätze, Landmarken, Spawns, Party-Arena, Grenze, Strecken-Routen
  base.json         # Grundgelände: Formen (Küstenlinie, Hügel, Klippen) + Rausch-Parameter
tools/map/
  bake.ts           # roads + map + base → public/maps/bulli-bay/terrain.bhf (+ Vorschau-PNG)
public/maps/bulli-bay/
  terrain.bhf       # gebacken, im Repo (deterministisch, Content-Hash im Manifest)
  manifest.json     # { mapId, mapVersion, files: { terrain: { hash, bytes } }, roadsHash, mapHash }
```

JSON-Quellen liegen unter `src/shared/maps`, damit Server und Client sie über Imports erhalten (Vite bündelt sie für den Client, Node liest sie direkt). Das gebackene Heightfield liegt als Asset unter `public/`, weil es zu groß für das JS-Bundle ist; der Server liest dieselbe Datei beim Start von der Platte.

### 5.2 Schema

Alle Längen in m, Punkte als `[x, z]`. Die Datei wird beim Laden mit valibot geprüft (`src/shared/map/roadSchema.ts`), wie das Protokoll.

```ts
interface RoadNetworkFile {
    format: 'bulli-roads';
    version: 1;
    mapId: string;                          // 'bulli-bay'
    profiles: Record<string, RoadProfile>;  // Querschnitts-Vorlagen, z.B. 'downtown', 'pch-cliff'
    nodes: RoadNode[];
    edges: RoadEdge[];
    areas: RoadArea[];                      // Plätze, Parkplätze, Arena, Kai
}

interface RoadNode {
    id: string;
    x: number; z: number;
    y?: number;                 // feste Höhe (sonst aus dem Gelände, 6.4)
    kind: 'junction' | 'joint' | 'end';
    // joint: genau 2 Kanten, tangentenstetig durchlaufen (C1)
    // junction: ≥ 3 Kanten oder ausdrücklich Kreuzung
    junction?: {
        shape: 'auto' | 'roundabout';
        radius?: number;        // Trimm-Radius; auto = max. halbe Kantenbreite + 2 m
        control: 'signal' | 'stop' | 'yield' | 'none';
        crosswalks: boolean;
        cornerRadius?: number;  // Bordstein-Radius der Ecken, Standard 6 m
    };
}

type Curve =
    | { type: 'catmullRom'; points: [number, number][] }       // innere Stützpunkte zwischen from und to
    | { type: 'bezier'; segments: { c1: [number, number]; c2: [number, number]; to?: [number, number] }[] };
      // stückweise kubisch; der Endpunkt des letzten Segments ist der Knoten `to`

interface RoadEdge {
    id: string;                 // stabil, auch Hash-Schlüssel der Bestückung (E12)
    name?: string;              // 'Main Street'
    from: string; to: string;   // Knoten-IDs; Richtung = Stationierung s = 0 bei from
    curve: Curve;
    profile: string;            // Schlüssel in profiles
    overrides?: Partial<RoadProfile>;
    oneWay?: boolean;
    maxGrade?: number;          // Längsneigung, Standard 0.08 (Ridge Road 0.12)
    elevation?: { s: number; y: number }[];   // optionale Höhen-Pins
    rails?: RailRange[];        // Leitplanken und Geländer
    walls?: { side: 'left' | 'right'; from: number; to: number }[];   // Stützmauern (erzwingt senkrechte Böschung)
    tags?: string[];            // 'pch', 'track:coast-sprint', …
}

interface RoadProfile {
    width: number;              // befahrbare Fahrbahnbreite zwischen den Bordsteinen/Rändern
    lanes: [number, number];    // Spuren vorwärts / rückwärts (0 bei Einbahn)
    surface: 'asphalt' | 'concrete' | 'dirt' | 'gravel' | 'sand' | 'wood';
    markings: {
        center: 'none' | 'dashedWhite' | 'dashedYellow' | 'solidYellow' | 'doubleYellow';
        lanes: 'none' | 'dashed';
        edges: boolean;         // weiße Randlinie
        parking?: 'none' | 'parallel' | 'angled';
    };
    curb: { left: boolean; right: boolean; height: number };   // Standard 0,15 m
    sidewalk: { left: number; right: number };                 // Breite, 0 = keiner
    shoulder: number;           // Bankett (befahrbar, Oberfläche der Umgebung), Standard 1 m
    wear: number;               // 0..1, nur Optik (Flicken, Risse, Radspuren)
}

interface RailRange {
    side: 'left' | 'right';     // links/rechts in Kantenrichtung
    from: number; to: number;   // Stationierung s in m; to = -1 bis zum Kantenende
    kind: 'wbeam' | 'concrete' | 'wood' | 'fence';
    offset?: number;            // Abstand vom Fahrbahnrand, Standard 0,5 m
}

interface RoadArea {
    id: string;
    polygon: [number, number][];    // gegen den Uhrzeigersinn
    y?: number;                     // feste Höhe, sonst Mittelwert des Geländes
    surface: RoadProfile['surface'];
    curb: boolean;
    markings?: 'none' | 'parking' | 'plazaPavers';
    connects: string[];             // Knoten, an denen Straßen anschließen
}
```

Beispiel (gekürzt):

```json
{
  "format": "bulli-roads", "version": 1, "mapId": "bulli-bay",
  "profiles": {
    "pch-cliff": { "width": 9, "lanes": [1, 1], "surface": "asphalt",
                   "markings": { "center": "doubleYellow", "lanes": "none", "edges": true },
                   "curb": { "left": false, "right": false, "height": 0 },
                   "sidewalk": { "left": 0, "right": 0 }, "shoulder": 1.5, "wear": 0.4 }
  },
  "nodes": [
    { "id": "pch-n0", "x": -560, "z": -1000, "kind": "end" },
    { "id": "pch-n1", "x": -585, "z": -700, "kind": "joint" },
    { "id": "ocean-main", "x": -560, "z": -20, "kind": "junction",
      "junction": { "shape": "auto", "control": "signal", "crosswalks": true } }
  ],
  "edges": [
    { "id": "pch-cliff-1", "name": "Pacific Coast Highway", "from": "pch-n0", "to": "pch-n1",
      "curve": { "type": "catmullRom", "points": [[-548, -900], [-575, -800]] },
      "profile": "pch-cliff", "maxGrade": 0.07,
      "rails": [{ "side": "right", "from": 0, "to": -1, "kind": "wbeam" }],
      "tags": ["pch", "track:coast-sprint"] }
  ],
  "areas": []
}
```

### 5.3 Auswertung (`src/shared/map/spline.ts`, `roadNetwork.ts`)

- **Catmull-Rom zentripetal** (α = 0,5) durch `from`, die Stützpunkte und `to`. Zentripetal vermeidet Schlaufen und Spitzen bei ungleichen Abständen.
- **Phantom-Punkte an den Enden:** An einem `joint` nimmt der Auswerter den ersten Stützpunkt der Nachbarkante als Phantom, damit der Übergang tangentenstetig (C1) ist. An `junction` und `end` wird gespiegelt (`2·p0 − p1`), die Straße läuft also gerade in die Kreuzung.
- **Bézier:** stückweise kubisch mit expliziten Anfassern. An einem `joint` prüft der Validator, dass die Anfasser beider Seiten kollinear sind (Toleranz 1°).
- **Bogenlänge:** Jede Kante wird zuerst mit 64 Parameterschritten je Segment abgetastet und über die kumulierte Sehnenlänge auf **genau 1 m** umparametrisiert (das letzte Stück ist kürzer). Ergebnis je Kante: `RoadSample[]` mit `{x, z, tx, tz, s, curvature}`. Dieselben Samples nutzen Bake, Ribbon-Mesh, Reset-Ziele und `routeToTrack`.
- **Räumlicher Index:** ein Gitter mit 16 m Zellen über alle Samples für „nächste Straße zu (x, z)“ (Reset, Minimap, Bots).
- **Determinismus:** Die Samples brauchen `Math.sqrt` und dürfen zwischen Engines um einzelne ULPs abweichen. Das ist unkritisch: In die Sim fließen sie nur über das gebackene Heightfield (bitgleich, E4) und über Reset-Posen und Gates, die der Server vorgibt.

### 5.4 Kreuzungen und Plätze

- Jede Kante wird am `junction`-Knoten um den Trimm-Radius gekürzt. Die Kreuzungsfläche ist das Polygon aus den gekürzten Kantenenden, deren Ecken mit `cornerRadius` verrundet werden (Bordstein-Bögen). Sie wird als eigenes Mesh-Stück erzeugt.
- **Markierungen:** Haltelinien bei `stop`/`signal`, Zebrastreifen bei `crosswalks`, keine Mittellinie in der Kreuzungsfläche. Ampeln werden wie heute im Shader geschaltet (`world-look.md`, Straßenmöbel).
- **Kreisverkehr** (`roundabout`): Der Knoten wird zu einer geschlossenen Ringkante mit Radius `radius` (Standard 18 m, Fahrbahn 7 m) und einer Mittelinsel mit Bordstein (Collider `circle`, top 0,3 m, überfahrbar per Sprung). Die Äste schließen tangential an.
- **Areas** (Plaza, Parkplätze, Arena, Kai) sind Polygone mit fester Höhe. Straßen enden an ihren `connects`-Knoten.

### 5.5 Markierungen, Bordsteine, Leitplanken

- **Markierungen** entstehen im Straßen-Shader aus UV (u quer, v = s längs) und je Vertex kodiertem Markierungstyp. Es gibt keine eigenen Meshes und keine Decals. Die Stile folgen dem heutigen Look (gelbe Mittellinie, weiße Ränder, abgefahren).
- **Bordsteine** sind eine Extrusion entlang der Fahrbahnkante (0,15 m, Beton) im Hardscape-Mesh des Chunks. Mit Bordstein gibt es auf dieser Seite einen `segment`-Collider mit top 0,15 m. Die Sim lässt ihn überfahren, wenn das Auto schnell genug ist bzw. springt; das entspricht dem heutigen `top`-Verhalten.
- **Leitplanken** (`rails`): Pfosten alle 2 m als InstancedMesh, Holm als Ribbon im Chunk. In der Sim ist jede Leitplanke eine Kette von `segment`-Collidern mit höchstens 8 m Länge (top 0,8 m, r 0,15 m).
- **Leitplanken-Pflicht:** Der Datentest (Abschnitt 15) findet Stellen, an denen das Gelände innerhalb von 4 m neben dem Fahrbahnrand mehr als 2 m abfällt, und verlangt dort eine `rails`- oder `walls`-Angabe (oder das Tag `noRail`).

---

## 6. Heightfield

### 6.1 Dateiformat `terrain.bhf` (Bulli Heightfield)

Little Endian, 64-Byte-Kopf, danach die Ebenen hintereinander.

| Offset | Typ | Feld | Wert |
|---|---|---|---|
| 0 | u8[4] | magic | `BDHF` |
| 4 | u16 | version | 1 |
| 6 | u16 | flags | bit 0 = Höhen mit Prädiktor kodiert |
| 8 | u16 | cols | 1001 |
| 10 | u16 | rows | 1001 |
| 12 | f32 | cellSize | 2.0 |
| 16 | f32 | originX | −1000 |
| 20 | f32 | originZ | −1000 |
| 24 | f32 | heightOffset | −20.0 |
| 28 | f32 | heightScale | 0.01 |
| 32 | f32 | waterLevel | 0.0 |
| 36 | u16 | surfaceCell | 2 (Raster wie die Höhen, `cols × rows`) |
| 38 | u16 | zoneCell | 8 (250 × 250 Zellen) |
| 40 | u32 | mapVersion | |
| 44 | u8[16] | sourceHash | FNV-1a-128 über `roads.json`, `map.json`, `base.json` und die Bake-Version |
| 60 | u32 | reserved | 0 |
| 64 | u16[cols·rows] | heights | Zeile für Zeile (z außen, x innen), mit Prädiktor (6.2) |
| … | u8[cols·rows] | surface | Oberflächen-ID je Stützpunkt (Tabelle 8.1) |
| … | u8[250·250] | zones | Zonen-ID je 8-m-Zelle (Tabelle 11.1) |

Die f32-Felder sind nur beschreibend (0,01 ist in f32 nicht exakt darstellbar). `decodeHeightfield` prüft sie mit Toleranz gegen die Konstanten der Karte und rechnet danach nur mit den Double-Konstanten aus dem Code (`0.01`, `-20`, `2` als JS-Literale). So hängt das Ergebnis nicht an f32-Rundungen.

### 6.2 Kodierung und Download-Budget

- **Prädiktor:** `r = q[i,j] − q[i−1,j] − q[i,j−1] + q[i−1,j−1]` (Rand: nur links bzw. oben), Zickzack auf Uint16. Dekodiert in `src/shared/map/heightfield.ts` (rein, ohne Node oder DOM).
- **Transport:** Brotli (Fallback Gzip) über HTTP, vorberechnet beim Serverstart mit dem Mechanismus aus `server/staticAssets.ts` (wie die HDRIs), Content-Hash als `?v=`, Cache `immutable`.
- **Messung beim Entwurf** (synthetisches Gelände 1001², Hügel bis 290 m, 20 % Meer, Python-Probe): roh 2,0 MB; mit Prädiktor und Gzip 0,26–0,30 MB; mit xz 0,23 MB. Die echte Karte hat mehr Ebenen (Straßen, Meer, Plätze) und dürfte kleiner sein.
- **Budget:** `terrain.bhf` **≤ 600 KB über die Leitung** (erwartet ca. 300 KB), davon Oberflächen- und Zonen-Ebene ≤ 80 KB. `roads.json` + `map.json` + `base.json` zusammen ≤ 150 KB komprimiert. Neue Texturen der Karte (Fels-Klippe, Erde, nasser Sand, Leitplanke, Pier-Holz, Wasser-Normalen, Container) ≤ 2,5 MB KTX2. `public/models` + `public/textures` + `public/maps` bleiben unter den 30 MB aus `assets.md` (heute 9,6 MB).

### 6.3 Abfrage: bilineare Interpolation (verbindlich)

Eine einzige Funktion in `src/shared/map/heightfield.ts`. Sim (`SimWorld.terrainHeight`), Spawns, Reset, Bots, Client-Ribbons und Props nutzen sie alle.

```ts
// q: Uint16Array der dekodierten Höhen, cols = rows = 1001, CELL = 2, ORIGIN = -1000
export function heightAt(hf: Heightfield, x: number, z: number): number {
    let gx = (x - ORIGIN) / CELL;
    let gz = (z - ORIGIN) / CELL;
    if (gx < 0) gx = 0; else if (gx > COLS - 1) gx = COLS - 1;   // außerhalb: Randwert
    if (gz < 0) gz = 0; else if (gz > ROWS - 1) gz = ROWS - 1;
    let i = Math.floor(gx); if (i > COLS - 2) i = COLS - 2;
    let j = Math.floor(gz); if (j > ROWS - 2) j = ROWS - 2;
    const fx = gx - i, fz = gz - j;
    const k = j * COLS + i;
    const h00 = hf.q[k], h10 = hf.q[k + 1], h01 = hf.q[k + COLS], h11 = hf.q[k + COLS + 1];
    const top = h00 + (h10 - h00) * fx;
    const bottom = h01 + (h11 - h01) * fx;
    return HEIGHT_OFFSET + (top + (bottom - top) * fz) * HEIGHT_SCALE;
}
```

- Die Reihenfolge der Operationen ist Teil des Vertrags. Wer sie ändert, ändert die Sim (Golden-Lauf, `mapVersion`).
- **NaN und ±Infinity** als Eingabe liefern NaN bzw. den Randwert; die Sim klemmt Positionen ohnehin auf `bound`.
- **Gradient:** Die Sim behält die zentrale Differenz mit `GRADIENT_STEP` 0,5 m über `terrainHeight` (`vehicle.ts`). Sie glättet die Knicke an den Zellgrenzen der bilinearen Fläche, und am Sim-Code ändert sich nichts.
- **Kosten:** 2 Divisionen, 2 `floor`, 4 Array-Zugriffe, ca. 10 Flops. Das ist billiger als die heutige Sinus-Summe.
- **Speicher:** Die Höhen bleiben als `Uint16Array` (2,0 MB) im Speicher. Kein Float-Array auf dem Server.

### 6.4 Bake: Grundgelände, Road-Corridor-Flatten, Böschungen (`tools/map/bake.ts`)

Das Bake läuft in Node, ist deterministisch (gleiche Eingabe → gleiche Bytes, Test) und schreibt zusätzlich ein Vorschau-PNG (Höhen-Schummerung, Straßen, Zonen) für Reviews.

1. **Grundgelände** aus `base.json`: Küstenlinie als Polygon (Meeresboden-Profil −12 m draußen, Strandprofil 0–3 m über 60 m), Hügelmassen als Formen mit Zielhöhe und Abfall-Profil, Klippen als Linien mit Kantenhöhe und Steilhang, dazu fBm-Rauschen aus einem Integer-Hash (4 Oktaven, 60–480 m Wellenlänge, Amplitude je Zone). Kein `Math.sin`.
2. **Höhenprofil jeder Kante:** Das natürliche Gelände unter der Mittellinie wird über 60 m gleitend gemittelt. Höhen-Pins (`elevation`, Knoten-`y`) werden fest gesetzt. Danach begrenzen ein Vorwärts- und ein Rückwärtslauf die Längsneigung auf `maxGrade`, und Kuppen und Wannen werden mit einem Mindestradius von 150 m ausgerundet (kein Abheben auf normalen Straßen, außer auf gewollten Kuppen).
3. **Knoten:** Die Höhe eines Kreuzungsknotens ist der Mittelwert der Kantenprofile (oder `y`). Die Kanten laufen mit ihrer Längsneigung darauf zu. Kreuzungsflächen und Areas sind eben.
4. **Querprofil:** Die Fahrbahn ist quer eben (kein Dachprofil in v1, E-Frage in 17). Die ebene Zone reicht über die Fahrbahn hinaus bis **Bordstein + Gehweg + Bankett, mindestens aber 2 Rasterzellen (4 m) über den befahrbaren Rand**. So hat jede Zelle, die die Fahrbahn berührt, vier Ecken auf Straßenhöhe, und die bilineare Fläche ist dort exakt die Straße.
5. **Böschungen:** Außerhalb der ebenen Zone wird zum natürlichen Gelände übergeblendet, mit höchstens **1 : 1,5** (33,7°) in Einschnitt und Damm: `h = clamp(natürlich, straße − d/1,5, straße + d/1,5)` mit `d` = Abstand zur ebenen Zone. Der Übergang wird über 3 m weich gezeichnet. Wo `walls` gesetzt ist, entsteht statt der Böschung eine senkrechte Stützmauer (Optik + `segment`-Collider mit top ∞ auf der Bergseite bzw. Leitplanke auf der Talseite).
6. **Mehrere Korridore:** Für jeden Stützpunkt zählt der nächste Korridor (Distanzfeld). Liegen zwei Korridore näher als ihre Böschungen, entscheidet die tiefere Straße im Damm bzw. die höhere im Einschnitt nicht: Der Validator meldet es, und der Autor setzt Pins oder Mauern. Keine stillen Mischhöhen.
7. **Wasser:** Unter dem Meer bleibt das Grundgelände. Der Pier ist eine Area mit `y = 5` und Oberfläche `wood`. Er hebt das Heightfield als schmalen Streifen an; das Terrain-Mesh zeichnet dort ein Loch (Oberfläche `wood` → discard), und das Pier-Modell mit Pfählen ersetzt die Optik.
8. **Quantisieren:** `q = round((h + 20) / 0.01)`, geklemmt auf 0 … 65535.
9. **Oberflächen- und Zonen-Raster** rastern Straßen (Fahrbahn + 1 m), Areas, Strand, Dünen und Zonen-Polygone in fester Prioritätsreihenfolge (Tabelle 8.1).

---

## 7. Wasserlinie und Meer

- **Meeresspiegel y = 0.** Das Meer ist eine Ebene bis zum Horizont (ein Draw Call). Der Wasser-Shader nutzt die Wassertiefe aus einer Tiefen-Textur (8 m, aus dem Heightfield abgeleitet) für Farbe, Schaum an der Brandungslinie und Transparenz im Flachwasser.
- **Sim:** `waterDepth(x, z) = waterLevel − heightAt(x, z)`. Ab 0,6 m Tiefe am Fahrzeugmittelpunkt gilt das Auto als „im Wasser“: kein Antrieb, starke Dämpfung, kein Boost. Nach 1,0 s im Wasser setzt die Sim es zurück auf die nächste Straße (Free Roam) bzw. auf die Ideallinie (Rennen). Die Schwelle liegt so, dass man am flachen Strand durchs Wasser fahren kann.
- **Pier und Kaikanten:** Geländer und Poller-Ketten als `segment`-Collider, damit man nicht versehentlich ins Wasser fällt. Die Strandseite ist offen.

---

## 8. Oberflächen und Offroad in der Sim

### 8.1 Oberflächen-IDs *(Startwerte)*

| ID | Oberfläche | Griff-Faktor `g` | Rollwiderstand `d` (m/s²) | befestigt | Priorität beim Rastern |
|---|---|---|---|---|---|
| 0 | Asphalt | 1,00 | 0,0 | ja | 9 (höchste) |
| 1 | Beton (Kai, Plaza, Arena) | 0,97 | 0,0 | ja | 8 |
| 2 | Holz (Pier) | 0,90 | 0,1 | ja | 10 |
| 3 | Schotter | 0,80 | 0,4 | nein | 6 |
| 4 | Erde / Feldweg | 0,75 | 0,5 | nein | 5 |
| 5 | Gras | 0,70 | 0,8 | nein | 2 |
| 6 | Sand (trocken, Dünen) | 0,60 | 1,6 | nein | 3 |
| 7 | nasser Sand | 0,72 | 0,9 | nein | 4 |
| 8 | Fels | 0,85 | 0,3 | nein | 1 |
| 9 | Wasser (Meeresboden) | – | – | nein | 0 |

- **Anwendung:** Die Sim liest die Oberfläche an der Vorder- und Hinterachse (Kreismittelpunkte bei ±`colliderOffset`). Auf befestigten Flächen gilt `μ · g`. Auf unbefestigten gilt `μ · g · offroadGrip` und zusätzlich der Rollwiderstand `d · offroadDrag` der Klasse (heute 0,85–1,00 bzw. 0,2–1,0, der Typ 181 ist offroad am stärksten).
- `VehicleParams.offroadGrip/offroadDrag` existieren bereits. Die Sim bekommt `SimWorld.surfaceAt(x, z)`; Welten ohne Raster (Sandbox, heutige Stadt) liefern immer 0, die Goldens bleiben gleich.
- **Optik:** Das Terrain-Shading liest dasselbe Raster als R8-Textur und mischt Gras, trockenes Gras, Erde, Sand und Fels (plus Hangneigung für Fels). Staubpartikel hinter dem Auto hängen an der Oberfläche.

### 8.2 Neue Collider (E8)

```ts
| { kind: 'segment'; ax: number; az: number; bx: number; bz: number; r: number; base: number; top: number }
| { kind: 'obox'; x: number; z: number; hw: number; hd: number; yaw: number; base: number; top: number }
```

- **Kreis gegen Kapsel:** nächster Punkt auf dem Segment, dann wie Kreis gegen Kreis. **Kreis gegen gedrehte Box:** Kreismittelpunkt ins Box-System drehen, dann der bestehende Box-Test. `sin`/`cos` des Box-Winkels werden beim Aufbau einmal berechnet und gespeichert (der Server rechnet sie selbst; kleine ULP-Abweichungen zum Client korrigiert die Reconciliation).
- Das `SpatialGrid` wird auf die Kartenfläche parametrisiert (heute fest: Ursprung −512, 64 Zellen). Für Bulli Bay: Ursprung −1000, 16-m-Zellen, 125 × 125.
- Geschätzte Collider-Zahl: ca. 1 800 Gebäude (`obox`), 2 500 Bäume und Palmen (`circle`), 6 000 Leitplanken-, Bordstein- und Zaun-Segmente, 400 Sonstige. Das ist mit dem CSR-Gitter unkritisch (Test: Kosten pro Tick mit 32 Autos, Abschnitt 15).

### 8.3 Kartengrenze und Out-of-Track-Reset

- **Grenze:** Das Polygon aus `map.json` wird als Kette von `segment`-Collidern (top ∞) gebaut, soweit dort kein Meer liegt. Am Meer greift der Wasser-Reset.
- **Reset-Ziel im Free Roam:** Die heutige `RoadGrid` wird durch eine Funktion ersetzt: nächstes Straßen-Sample (Index, 5.3), Fahrtrichtung der Straße, die dem Yaw des Autos am nächsten liegt, Spurmitte der passenden Richtung. Auf Areas die Mitte der Area. Die Sim-Schnittstelle bleibt `resetPose`, wie Phase 2 sie für das Rennen einführt.
- **Automatischer Reset:** im Wasser (7), unterhalb von y = −20 oder außerhalb der Grenze. Im Rennen zusätzlich die Regeln aus Phase 2 (verpasstes Gate, Falschfahrer).

---

## 9. Chunks (250 m)

- **Raster:** 8 × 8 Chunks über das Datenquadrat. `cx = floor((x + 1000) / 250)`, `cz` analog, `chunkId = cz · 8 + cx`. Objekte gehören zu dem Chunk, in dem ihr Mittelpunkt liegt; ihre Bounding-Box wird in die Chunk-AABB eingerechnet.
- **Kein Streaming:** Alle Chunks werden beim Start gebaut (im Splash, auf Mobile verteilt über mehrere Frames, Ziel ≤ 1,5 s auf dem Referenz-Handy). Chunks steuern nur Culling und Merging.
- **Inhalt je Chunk** (je ein gemergtes Mesh):

| Mesh | Material | Inhalt |
|---|---|---|
| `road` | Straßen-Shader (Asphalt, Beton, Erde, Sand, Holz per Vertex-Attribut; Markierungen im Shader) | Fahrbahnen, Kreuzungsflächen, Areas |
| `hardscape` | Beton-PBR | Bordsteine, Gehwege, Stützmauern, Kaikanten |
| `facade` | Fassaden-Atlas (heute `city.ts`) | Gebäudewände |
| `roof` | Ziegel/Kies per Attribut | Dächer, Gesimse |
| `trim` | Markisen, Ladenfronten | Details |
| `rail` | verzinkter Stahl / Holz | Leitplanken-Holme, Geländer, Zäune |

- **Global instanziert** (ein InstancedMesh je Art, Sichtbarkeit je Chunk über einen Instanz-Bereich, der bei Chunk-Wechsel neu gepackt wird, höchstens alle 250 ms): Palmen (Stamm, Wedel, Impostor), Baum-Karten, Büsche, Felsen, Straßenmöbel (5 Arten), Leitplanken-Pfosten, Container, Poller.
- **Terrain:** ein CDLOD-Mesh für die ganze Karte (E7). Blätter des Quadtrees 62,5 m, Patch 32 × 32 Quads, LOD0 = 2 m bis ca. 150 m (Tier low: 100 m), dann 4, 8, 16 m mit Geomorphing. Höhen aus einer R32F-Textur (1001², 4 MB), Oberflächen aus R8 (1 MB). Dazu ein Horizont-Ring aus Kulissen-Hügeln (wie heute, ein Call).
- **Culling:** Frustum gegen die Chunk-AABB, Distanz-Culling nach Sichtweite des Tiers (Nebel verdeckt die Kante). Schatten nur für Chunks innerhalb der Schatten-Reichweite (±60 m bzw. ±45 m).

---

## 10. Budgets je Tier

Gemessen wie in `world-look.md` mit Schatten-Pass (`frameStats.ts`), an festen Kamerapunkten (`npm run screenshots`: Main Street, Plaza, Promenade, Ridge-Kehre, Aussichtspunkt, Hafen, Arena mit 8 Autos).

| | high (Desktop) | low (Handy) | software (SwiftShader, E2E) |
|---|---|---|---|
| **Draw Calls inkl. Schatten** | **≤ 300** (Plan-Exit), Ziel ≤ 220 | **≤ 150** | ≤ 110 |
| Dreiecke | ≤ 1,2 Mio. | ≤ 500 k | ≤ 300 k |
| Sichtweite (Nebel-Ende) | 600 m | 350 m | 220 m |
| sichtbare Chunks (typisch) | 12–16 | 6–9 | 4–6 |
| Terrain LOD0 | 2 m bis 150 m | 2 m bis 100 m | 4 m bis 80 m |
| Gebäude-Details | Gesimse, Markisen, Ladenfronten | ohne Gesimse | Kisten mit Atlas |
| Palmen-Impostor ab | 170 m | 110 m | 80 m |
| GPU-Speicher (Geometrie + Texturen) | ≤ 350 MB | **≤ 180 MB** | ≤ 150 MB |
| JS-Heap nach 20 min | ≤ 250 MB, stabil | **≤ 150 MB, stabil (iOS ohne Tab-Reload)** | – |
| Ziel-FPS | 60 (Referenz-Desktop) | ≥ 30 (Referenz-Handy) | Fahrstrecke im E2E wie heute |

**Aufteilung der Draw Calls, Tier high** *(Schätzung beim Entwurf)*: Chunks 14 × ca. 5 = 70, Terrain 2, Meer 1, Himmel 1, Horizont 1, instanzierte Arten ca. 18, 8 Autos ca. 40 (LOD), Gates/HUD/Effekte ca. 15 → ca. 150 im Haupt-Pass; Schatten-Pass (nur nahe Chunks, Autos, Palmen, Möbel) ca. 50 → **ca. 200**. Tier low: 8 Chunks × 4 = 32, Instanzen 14, Autos 30, Rest 15, Schatten 30 → **ca. 125**.

**Speicher auf dem Server** je Karte: Heightfield 2,0 MB, Oberflächen 1,0 MB, Zonen 62 KB, Straßen-Samples (22 km × 1 m × ca. 48 B) ca. 1,1 MB, Collider ca. 0,8 MB, Gitter ca. 0,3 MB → **≤ 6 MB**, einmal pro Prozess (MapData wird von allen Rooms geteilt).

**Ladezeit:** Karte bis spielbar ≤ 4 s auf dem Desktop, ≤ 8 s auf dem Handy im WLAN (Download ≤ 3,5 MB neu für Karte und Kartentexturen).

---

## 11. Zonen-Masken und prozedurale Bestückung

### 11.1 Zonen-IDs und Regeln *(Startwerte)*

| ID | Zone | Gebäude | Vegetation | Props |
|---|---|---|---|---|
| 0 | Wildnis | – | Chaparral, Felsen, Eichen (Poisson 18 m) | – |
| 1 | Downtown | geschlossene Zeile, Lose 12–24 m breit, 0 m Rücksprung, 2–4 Geschosse, Läden im EG | Palmen an der Main Street alle 18 m | Laternen, Ampeln, Bänke, Hydranten, Mülleimer |
| 2 | Wohnen | Einzelhäuser, Lose 18–26 m, Rücksprung 6 m, 1–2 Geschosse, Garagen | Zypressen, Büsche, Rasen | Briefkästen, Zäune (nur Optik) |
| 3 | Industrie/Hafen | Hallen 40–80 m, Rücksprung 10 m | kaum | Container, Paletten, Kräne (Landmarke), Poller |
| 4 | Strand | Rettungstürme (Landmarke) | – | Volleyballnetze, Sonnenschirme (Optik) |
| 5 | Dünen | – | Strandhafer, Zaun-Reste | – |
| 6 | Hügel | – | Trockengras, Eichen, Felsen | Weidezäune |
| 7 | Klippen | – | Felsen, Sukkulenten | – |
| 8 | Party-Arena | – | – | Container, Rampen (aus `map.json`, handplatziert) |
| 9 | Park/Plaza | – | Palmen, Beete | Bänke, Schirme, Brunnen |
| 10 | Ranch | Scheune (Landmarke) | Eichen, Gras | Holzzäune |

### 11.2 Verfahren

- **Gebäude** entstehen entlang der Straßenkanten (Frontage): Für jede Kante in der Reihenfolge ihrer IDs werden Lose links und rechts abgelegt, Ausrichtung nach der Tangente (daher `obox`). Ein Los fällt weg, wenn es einen Korridor (Fahrbahn + Gehweg + 1 m) oder ein bereits gesetztes Los schneidet, außerhalb seiner Zone liegt oder das Gelände unter der Grundfläche mehr als 2,5 m Höhenunterschied hat. Varianten (Geschosse, Farbe, Dach, Laden) kommen aus `hash(edgeId, seite, losIndex)` (E12).
- **Bäume, Felsen, Büsche:** Poisson-Scheiben je Chunk aus `hash(chunkId, zelle)`, mit Abstand zu Korridoren (Fahrbahn/2 + Bankett + 2 m) und zu Gebäuden.
- **Wer rechnet was:** Alles mit Collider (Gebäude, Bäume, Palmen, Felsen über 0,5 m, Container, Leitplanken) entsteht in `src/shared` und läuft auf Server und Client gleich; es geht in `worldHash` ein. Reine Optik (Gras, Büsche, Blumen, Zäune ohne Collider, Strandschirme) entsteht nur im Client.
- **Handplatzierte Overrides** in `map.json`: Landmarken, gesperrte Lose (`noBuild`-Polygone), fest gesetzte Gebäude (z.B. Diner, Cannery, Pier-Restaurant).

---

## 12. Party-Arena „Cannery Lot“

- 180 × 140 m bei (−170 | +590), Beton/rissiger Asphalt, Maschendrahtzaun ringsum (`segment`, top ∞), ein Tor zum Harbor Blvd, das im PartyRoom geschlossen ist (Collider nur in der Party-Welt).
- **Inhalt:** 12 Container als Deckung (`obox`), 2 Rampen (bestehendes `RampDef`), eine Laderampe als Plateau (Area mit `y = 4,2`, Kanten als Collider), zwei Lichtmasten als Landmarke.
- **Items:** 30 Coin- und 25 Powerup-Punkte als feste Liste in `map.json` (heute zufällig über die Stadt, `worldGen.ts`). Spawns: 16 Plätze am Rand mit Blick zur Mitte.
- **PartyRoom-Welt:** `createPartyWorld(map)` = Karten-Collider + Tor + Arena-Grenze, `bound` = Arena. Der Rest der Karte ist sichtbar, aber nicht erreichbar.

---

## 13. `routeToTrack` und Migration der Phase-2-Strecken

### 13.1 Routen in `map.json`

```json
{
  "id": "coast-sprint", "name": "Coast Sprint", "kind": "sprint", "laps": 1, "trackVersion": 1,
  "route": ["pch-cliff-1", "pch-cliff-2", "pch-cliff-3", "ocean-1", "ocean-2", "harbor-pch-1", "-bluff-2"],
  "start": { "edge": "pch-cliff-1", "s": 40 },
  "finish": { "edge": "bluff-2", "s": 30 },
  "gateSpacing": 220,
  "ramps": [],
  "hints": { "autoBarriers": true, "chevronCurvature": 0.025 }
}
```

`-` vor einer Kanten-ID heißt: gegen die Kantenrichtung. Ein Rundkurs endet an dem Knoten, an dem er beginnt.

### 13.2 Algorithmus (`src/shared/map/routeToTrack.ts`)

1. **Prüfen:** Aufeinanderfolgende Kanten teilen einen Knoten; ein Rundkurs ist geschlossen; keine Kante kommt zweimal vor; Einbahnstraßen nur in Fahrtrichtung. Fehler mit Kanten-ID, keine stille Reparatur.
2. **Mittellinie:** Samples der Kanten (5.3) aneinanderhängen. Durch jede Kreuzung eine Hermite-Kurve zwischen den gekürzten Enden (Tangenten der Kanten), damit die Linie C1 bleibt. Auf 2 m neu abtasten (passt zur Projektion mit Fenster ±40 Punkte aus Phase 2).
3. **Gates:** Start/Ziel bei `start` (Rundkurs) bzw. Start und Ziel getrennt. Dazwischen ein Gate nach jeder Kreuzung, an der die Route abbiegen könnte, und sonst spätestens alle `gateSpacing` m. Kein Gate innerhalb von 25 m nach einer Kreuzung oder mitten in einer Kehre (Krümmung > 1/30 m). Breite = Fahrbahnbreite + 2 m, `yaw` aus der Tangente.
4. **Startaufstellung:** 8 Plätze hinter dem Start, zwei Reihen auf den Spurmitten (±Breite/4), 8 m Abstand, versetzt wie in Phase 2, Blick entlang der Tangente. Jeder Platz muss auf der Fahrbahn liegen (Test).
5. **Hints:** An jeder durchfahrenen Kreuzung sperrt eine Barrieren-Reihe jeden nicht befahrenen Ast am gekürzten Ende. Pfeiltafeln außen an Kurven mit Krümmung über `chevronCurvature`. Rampen aus der Route kommen als `RampDef` in die Renn-Welt.
6. **Ergebnis:** ein `TrackDef` im Format von Phase 2 (`centerline`, `gates`, `grid`, `hints`, `minimap` = Bounding-Box + 40 m, `mapVersion` der Karte). Weil die Mittellinie schon verrundet ist, setzt `routeToTrack` `lineOptions = { radius: 0, apexShift: 3 }`; die Ideallinie verschiebt in Kurven nur noch außen-innen-außen.

Bis Phase 2 gemergt ist, definiert `src/shared/map/trackTypes.ts` eine strukturgleiche Kopie der benötigten Typen. Bei der Integration wird sie durch den Import aus `src/shared/race/types.ts` ersetzt; ein Typ-Test (`satisfies`) stellt die Gleichheit schon vorher sicher.

### 13.3 Migration (E11)

| Phase-2-Strecke | Neu auf Bulli Bay | Was gleich bleibt | Was sich ändert |
|---|---|---|---|
| `downtown-loop` | T1 „Downtown Loop“ im Downtown-Raster | ID, Rundkurs, 3 Runden, gegen den Uhrzeigersinn, nur 90°-Kurven im Stadtraster, Barrieren an Seitenstraßen | 6 statt 8 Kurven, ca. 1,3 km statt 832 m, lange Gerade an der Promenade, `mapVersion`, `trackVersion` + 1 |
| `hill-sprint` | T3 „Ridge Climb“ | ID, Sprint von der Stadt zum Aussichtspunkt, drei Rampen | Serpentinen statt Hügelpiste, ca. 2,6 km, +140 m, Name, `mapVersion`, `trackVersion` + 1 |

- Die handgesetzten Gates der Phase 2 fallen weg; `routeToTrack` erzeugt sie. `tracks/downtownLoop.ts` und `tracks/hillSprint.ts` werden durch die Routen in `map.json` ersetzt, `tracks/index.ts` baut die `TrackDef`s beim Laden der Karte.
- **Bots:** Die Pure-Pursuit-Bots aus Phase 2 fahren auf der Ideallinie und brauchen nichts Neues. Der Bot-Integrationstest fährt jede Strecke einmal (Abschnitt 15).
- **Ghosts:** Ghosts des Zeitfahrens sind an `trackVersion` gebunden und werden mit dem Port ungültig. Persistente Bestenlisten gibt es erst in Phase 4, also geht nichts Dauerhaftes verloren.
- **Alte Stadt:** `cityGen.ts`, `city.ts`, `streetLayout.ts`, die Sinus-Terrain-Funktion und `RoadGrid` werden mit dem Umschalten auf Bulli Bay gelöscht (Löschen ist Teil des Exit-Kriteriums, Plan 5). Brauchbare Bausteine (Gebäude-Kit, Fassaden-Atlas, Möbel, Palmen, Brunnen) wandern in den Chunk-Builder.

---

## 14. Module und Umsetzungsreihenfolge

### 14.1 Neue Module (dieser Branch, ohne Integration)

```
src/shared/map/
  types.ts            # RoadNetworkFile, RoadProfile, RoadSample, Heightfield, Surface-/Zonen-IDs
  roadSchema.ts       # valibot-Schema für roads.json und map.json
  spline.ts           # Catmull-Rom zentripetal, Bézier, Bogenlänge, Resampling 1 m
  roadNetwork.ts      # Kanten auswerten, Phantom-Punkte, Kreuzungs-Trimmung, Sample-Index, nächste Straße
  heightfield.ts      # Format lesen/schreiben (Prädiktor), heightAt, surfaceAt, zoneAt, waterDepth
  corridor.ts         # Höhenprofil je Kante, Flatten, Böschung (vom Bake genutzt, rein und testbar)
  routeToTrack.ts     # Route → TrackDef
  trackTypes.ts       # strukturgleiche TrackDef-Typen bis zum Merge von Phase 2
src/shared/maps/bulli-bay/{roads,map,base}.json
tools/map/bake.ts, tools/map/preview.ts
tests/shared/map/*.test.ts
```

### 14.2 Reihenfolge

| Schritt | Inhalt | Merge-Punkt |
|---|---|---|
| M1 | Formate, `heightAt`, Splines, Flatten, Bake, `routeToTrack`, Vorschau-PNG, erste Fassung von `roads.json` (Downtown, Promenade, PCH) | Branch, kein Spiel-Einfluss |
| — | **Merge von Phase 2** abwarten | |
| M2 | Three-Upgrade (eigener PR mit Screenshot-Vergleich, Plan 5) | live |
| M3 | Sim-Integration: `SimWorld` aus dem Heightfield, `surfaceAt`, Wasser, `segment`/`obox`, Gitter-Parameter, Reset auf Straßen. Sandbox und alte Stadt laufen unverändert (Goldens gleich) | live (ohne sichtbare Änderung) |
| M4 | Client: CDLOD-Terrain, Straßen-Ribbons, Chunk-Builder, Gebäude, Props, Meer. Entwickelt mit `?map=bulli-bay` **nur im Dev-Build** (`import.meta.env.DEV`) | Branch |
| M5 | Strecken (Port + neue), Party-Arena, Spawns, Minimap; Default auf Bulli Bay umschalten, alte Stadt löschen | **live = Phase-3-Release** |
| M6 | Restliche Zonen verfeinern (Ranch, Dünen, Grand Tour), Budgets auf echten Geräten | live, je `mapVersion` + 1 |

Jeder Merge-Punkt ist ein vollständig spielbares Spiel (Rahmen). Weil neue Features ohne Flag live gehen, geht die Karte erst mit M5 live und dann mit allen Pflicht-Zonen und beiden portierten Strecken.

---

## 15. Tests (Testpyramide)

**Unit (Vitest, `tests/shared/map`)**, Erwartungswerte von Hand oder aus Geometrie, nie aus dem getesteten Code:

- `heightAt`: 2 × 2-Raster mit Handwerten (Ecken exakt, Mitte = Mittelwert, Kantenmitte, Klemmung außerhalb, letzte Zeile/Spalte). Prädiktor: Hin- und Rückweg an einer kleinen Handmatrix, Zickzack an ±1, ±32767.
- Dateikopf: falsche Magic, falsche Version, abgeschnittene Datei → Fehler.
- Splines: Catmull-Rom durch kollineare Punkte ist die Gerade (Länge von Hand); Viertelkreis aus 4 Stützpunkten hat die Bogenlänge π·R/2 ± 0,5 %; C1 an einem `joint` (Tangentenwinkel links/rechts < 0,1°); Resampling liefert Abstände von genau 1 m ± 1 mm.
- Flatten: gerade Straße über einem 20 %-Hang → Fahrbahn eben, Böschung nie steiler als 1 : 1,5 (Messung an allen Stützpunkten), Längsneigung ≤ `maxGrade`; jede Zelle unter der Fahrbahn hat vier Ecken auf Straßenhöhe.
- `routeToTrack` auf einem handgebauten Mini-Netz (Quadrat mit einer Querstraße): Gate-Anzahl, Reihenfolge, Richtung, Barrieren genau an den nicht befahrenen Ästen, Grid-Plätze auf der Fahrbahn, Fehler bei Lücke in der Route.
- Bake-Determinismus: zweimal backen → identische Bytes (Regressions-Lock auf den Hash erst, wenn die Karte steht, mit Begründung im Commit).

**Datentests auf der echten Karte** (Unit-Ebene, lesen die JSONs und `terrain.bhf`): jede Kante verbunden, keine unbeabsichtigten Überschneidungen von Korridoren, Leitplanken-Pflicht (5.5), Längsneigung je Kante, alle Strecken ohne Selbstkreuzung und mit Freiraum ≥ 1 m zu Collidern, alle Spawns auf befahrbarem Boden über dem Wasser, `terrain.bhf` passt zum `sourceHash` der Quellen (sonst: „bake vergessen“), Dateigrößen im Budget (6.2).

**Integration:** Server lädt Bulli Bay, Bot-Rennen je Strecke mit Kontakt; ein Tick mit 32 Autos bleibt unter 2 ms (p99) trotz größerer Collider-Zahl.

**E2E (wenige):** Karte laden und fahren (Desktop und Touch), Draw Calls und Dreiecke im Tier low an drei festen Punkten im Budget, Minimap-Achsen (Punkt links vom Auto erscheint links).

**Mutationsprobe:** für jeden neuen Test einmal (Vorzeichen im Prädiktor, `fx`/`fz` vertauscht, Böschung 1 : 1 statt 1 : 1,5, Gate-Richtung umgedreht) und im Commit nennen (CLAUDE.md).

---

## 16. Risiken

| Risiko | Gegenmaßnahme |
|---|---|
| Der Bau der Karte frisst die Zeit | Bake-Vorschau-PNG und Datentests statt Handkontrolle, prozedurale Bestückung, zuerst Downtown + Promenade + PCH, Spline-Editor im worldviewer |
| Straße und Gelände passen optisch nicht (Gelände sticht durch die Fahrbahn) | ebene Zone ≥ 2 Zellen über den Rand, LOD0 = Raster nah an der Kamera, Ribbon aus `heightAt` + 3 cm und Polygon-Offset |
| iOS-Speicher bei ganzer Karte | Budgets Tier low (Abschnitt 10), gemergte Chunks statt Einzel-Meshes, Soak-Test 20 min auf dem Gerät |
| Leitplanken fühlen sich hart oder klebrig an | Kapsel-Collider mit dem bestehenden Wand-Gleiten, Tunneling-Test mit 85 m/s schräg gegen eine Leitplanke |
| Serpentinen zu eng für die Renn-Kamera | Kehren-Radius ≥ 14 m, Kamera-Test an der Kehre (Screenshot) |
| Brücken fehlen später doch | Deck-Flächen als Erweiterung der Rampen-Logik (17) |

---

## 17. Offene Punkte (entschieden, sobald sie drankommen)

- **Brücken/Unterführungen:** nicht in v1 (E9). Falls nötig: Deck-Flächen wie Rampen mit Ober- und Unterseite.
- **Querneigung/Dachprofil:** v1 ohne (Fahrbahn quer eben). Überhöhte Kurven erst, wenn das Fahrgefühl im Playtest danach verlangt.
- **Tag/Nacht:** nicht Teil von Phase 3. Laternen und Neon sind schon emissiv.
- **Verkehr (KI-Autos):** nicht geplant; Bots gibt es nur im Rennen.

## 18. Abweichungen

*(noch keine)*
