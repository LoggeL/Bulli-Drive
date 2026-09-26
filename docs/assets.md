# Assets: Herkunft, Lizenzen, Pipeline und Budgets

**Stand:** 2026-09-25 · Grafik-Schritt G1 „Asset-Pipeline“ (realistischer Stil, ruhig-naturgetreue Farbstimmung), ergänzt um Phase 3: die Karte Bulli Bay und das Gebäude-Kit im Spiel (Abschnitte 7 und 8).

Dieses Dokument listet jede Binärdatei unter `public/models`, `public/textures` und `public/maps` mit Herkunft und Lizenz, dazu die Entscheidungen zur Pipeline. Die Werkzeuge selbst sind in [`tools/models/README.md`](../tools/models/README.md) und [`tools/textures/README.md`](../tools/textures/README.md) beschrieben.

## 1. Überblick

| Bereich | Quelle | Lizenz | Im Repo | Größe |
|---|---|---|---|---|
| Automodelle (`public/models`) | eigene prozedurale Blender-Skripte (`tools/models`) | eigenes Werk des Projekts | GLB (meshopt + KTX2), 3 LODs je Auto, 5 Autos | 1,4 MB (Bulli 0,34 MB, die anderen 0,22–0,30 MB) |
| Car-Select-Icons (`public/icons`) | Eevee-Render der eigenen Modelle (`build-all.mjs --icons`) | eigenes Werk des Projekts | WebP mit Alpha, 156×96 | 7 KB (Bulli) |
| PBR-Texturen (`public/textures/pbr`) | Poly Haven | CC0 1.0 | KTX2 | 2,35 MB (seit Phase 3 M4 ohne die Texturen der alten Stadt) |
| Generierte Texturen (`public/textures/generated`) | KI-generiert (Codex CLI, imagegen-Skill, OpenAI `image_gen`), eigene Nachbearbeitung | Nutzungsrechte beim Projekt, **kein** CC0 | KTX2 + JSON | 1,22 MB (seit Phase 3 M4 ohne Fassaden- und Ladenfront-Atlas) |
| HDRIs (`public/textures/hdri`) | Poly Haven | CC0 1.0 | Radiance `.hdr`, 1k | 2,7 MB |
| Referenzen (`tools/models/ref`) | KI-generierte Blaupausen, Maße aus Sekundärquellen | nur Arbeitsmaterial, nicht im Spiel | JPG + JSON | 1,5 MB |
| Nummernschild-Decals (`tools/models/src`) | KI-generiert, eigene Nachbearbeitung | wie oben | PNG 512×256, 5 Stück | 1,2 MB |
| Gebäude-Kit (`public/models/kit`, Phase 3, seit M4 im Spiel) | eigene prozedurale Blender-Skripte (`tools/models/buildings`), Atlas aus Poly-Haven-Texturen, KI-Bögen und der G1-Felstextur | Geometrie eigenes Werk; Atlas gemischt (siehe Abschnitt 7) | 11 GLBs (meshopt, 3 LODs je Teil, mit Hafenkran) + 4 KTX2 | 3,1 MB (GLBs 2,09 MB, Atlas 1,03 MB) |
| Karte Bulli Bay (`public/maps/bulli-bay`, Phase 3) | eigene Daten: handgebaute Straßen-Splines und Zonen (`src/shared/maps/bulli-bay/*.json`), gebacken von `tools/map/bake.ts` | eigenes Werk des Projekts | `terrain.bhf` (Heightfield, Oberflächen, Zonen) + `manifest.json` | 3,07 MB roh, 307 KB über die Leitung (Brotli) |
| Quellbögen des Kits (`tools/models/buildings/src`) | KI-generiert (Codex-imagegen) | Nutzungsrechte beim Projekt, **kein** CC0 | JPG, 4 Stück | 2,0 MB |

Summe der Binär-Assets: rund 18,6 MB, davon 13,9 MB ausgeliefert (Stand Phase 3: `public/models` 4,55 MB, `public/textures` 6,32 MB, `public/maps` 3,07 MB roh); davor rund 16,2 MB, davon 12,1 MB ausgeliefert (Stand Schritt „building-kit“); vorher rund 12,4 MB, davon 9,6 MB ausgeliefert (Stand Schritt „vier Autos“; vorher 10,3 / 8,6 MB) (Obergrenze laut Plan ~30 MB). Ein Unit-Test (`tests/client/modelBudgets.test.ts`) hält `public/models` + `public/textures` unter 30 MB.

Quelltexturen in voller Auflösung liegen nicht im Repo. `npm --prefix tools run textures:fetch` lädt sie reproduzierbar (MD5-geprüft) nach `tools/textures/.cache`.

## 2. Automodelle

- **VW T1 Samba (1963, 23 Fenster)**, `bulli_lod{0,1,2}.glb`: vollständig prozedural aus `tools/models/vehicles/bulli.py` (Blender 5.2 LTS). Maße nach `tools/models/ref/dimensions.json` (Werksangaben über Sekundärquellen, Quellen in der Datei). Keine fremden Meshes, keine gekauften oder heruntergeladenen Modelle.
- **Käfer 1963, T1-Pritsche, Porsche 356 B T6 und Typ 181** (`beetle`, `pickup`, `sport`, `jeep`, je `_lod{0,1,2}.glb`): ebenso vollständig prozedural aus `tools/models/vehicles/<id>.py` auf der gemeinsamen Bibliothek `tools/models/lib/bd_car.py`. Die Pritsche nutzt die T1-Karosserie aus `bulli.py`. Maße in `tools/models/ref/dimensions.json`; für den 356 ersetzen die Werte der de.wikipedia (356 B T6: 4,01 × 1,67 × 1,31 m, Radstand 2,10 m) die bisherigen Karmann-Ghia-Werte des Eintrags `sport`.
- **Blaupausen:** `tools/models/ref/*_blueprint.jpg` sind KI-generierte orthografische Referenzbögen (Codex-imagegen). `sport_blueprint.jpg` zeigt seit diesem Schritt den Porsche 356 B T6 (vorher Karmann Ghia); der Prompt steht in `tools/models/README.md`. Die Pixel-Zuordnung der Ansichten steht in `tools/models/ref/blueprints.json`.
- **VW-Logo:** das echte VW-Rundzeichen als Geometrie (Front, Heck) und als Normal-Map-Prägung auf den Radkappen. Käfer (Haube, Radkappen), Pritsche (Front, Radkappen) und Typ 181 (Frontblech, Nabenkappen) tragen es ebenso.
- **Porsche 356:** kein fotografisches oder originalgetreues Markenlogo. Auf der Haube sitzt ein stilisiertes Wappen, das `bd_car.crest_pixels` prozedural in den Atlas malt (goldener Schild, rot-schwarze Streifen, schwarze Geweihstangen, ohne Schriftzug und ohne Pferd). Die Radkappen haben nur eine gepresste Ringsicke. Das ist eine bewusste Nutzerentscheidung für dieses private Projekt (Plan, Entscheidung 5). Das Porsche-Wappen ist eine Marke der Dr. Ing. h.c. F. Porsche AG; die stilisierte Anlehnung wird im privaten Fanprojekt bewusst genutzt.
- **Nummernschilder:** kalifornische Schilder im Stil 1963–69 mit erfundenen Kennzeichen: „BULLI“, „KAEFER“, „PICKUP“, „356 B“ und „THING“ (KI-generiert, siehe Abschnitt 4).
- **Surfbrett:** Teil jedes Modells, standardmäßig ausgeblendet (freischaltbares Zubehör).
- **Im Spiel** seit Schritt „Bulli T1“: Maßstab 1,15 (passend zur Sim-Hülle), LOD nach Entfernung, Lampen und Material-Klone pro Auto. Details in [`docs/cars.md`](cars.md).
- **Icons:** `public/icons/car-<id>.webp` sind Renders von LOD0 für die Autoauswahl im Startbildschirm (5 × 5–7 KB).
- Die prozeduralen Kasten-Autos in `src/client/vehicle/CarModel.ts` bleiben nur noch als Rückfall, falls die Modelle nicht laden.

## 3. Poly-Haven-Texturen und HDRIs (CC0 1.0)

Alle Dateien von [polyhaven.com](https://polyhaven.com), Lizenz [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Namensnennung ist nicht nötig, sie ist als Dank vorgesehen („HDRIs & textures: Poly Haven, CC0“).

| Rolle | Poly-Haven-Asset | Autoren | Kachel | Im Spiel |
|---|---|---|---|---|
| `asphalt` | [Asphalt 02](https://polyhaven.com/a/asphalt_02) | Rob Tuytel | 3,0 m | Albedo/ARM 1024, Normal 512 |
| `asphalt_clean` | [Clean Asphalt](https://polyhaven.com/a/clean_asphalt) | Dimitrios Savva | 2,1 m | nicht im Spiel, nur Boden der Blender-Look-dev-Renders (`publish: []`) |
| `sidewalk` | [Concrete Floor 03](https://polyhaven.com/a/concrete_floor_03) | Rob Tuytel, Matterfield | 2,5 m | 512 |
| `stucco` | [White Stucco](https://polyhaven.com/a/white_stucco) | Amal Kumar | 2,0 m | 512 (per Vertex-Farbe getönt) |
| `roof_tiles` | [Clay Roof Tiles 02](https://polyhaven.com/a/clay_roof_tiles_02) | Amal Kumar | 2,5 m | nicht mehr einzeln ausgeliefert (seit Phase 3 M4 nur im Kit-Atlas, Abschnitt 7) |
| `roof_gravel` | [Tarred Gravel](https://polyhaven.com/a/tarred_gravel) | Dimitrios Savva | 2,2 m | 256 |
| `grass` | [Leafy Grass](https://polyhaven.com/a/leafy_grass) | Charlotte Baglioni | 2,0 m | Albedo 512 (Rasen der Gärten und des Parks; Normal- und ARM-Map seit Phase 3 M4 nicht mehr ausgeliefert) |
| `grass_dry` | [Withered Grass](https://polyhaven.com/a/withered_grass) | Charlotte Baglioni | 2,0 m | 512 |
| `sand` | [Aerial Beach 01](https://polyhaven.com/a/aerial_beach_01) | Rob Tuytel | 30 m | 256 |
| HDRI | [Victoria Sunset](https://polyhaven.com/a/victoria_sunset) | Greg Zaal | – | 1k `.hdr` (IBL, Reflexionen) |
| HDRI | [Qwantani Sunset (Pure Sky)](https://polyhaven.com/a/qwantani_sunset_puresky) | Greg Zaal, Jarod Guest | – | 1k `.hdr` (Himmel) |

Die Sonnenhöhe beider HDRIs liegt bei 4–6°. Das DirectionalLight des Spiels wird unabhängig gesetzt, nur der Azimut sollte zur HDRI passen (Sonne bei u ≈ 0,6 der Equirect-Breite; `tools/models/lib/make_env.py` misst das).

## 4. Generierte Texturen (KI)

**Erzeugung:** Codex CLI (`codex exec`) mit dem imagegen-Skill und dem eingebauten OpenAI-Tool `image_gen`. Die Prompts liegen wörtlich in `tools/textures/generated/prompts/`, die Nachbearbeitung (Freistellen per Chroma-Key, horizontal nahtlos, Atlas-Packing, Emissive- und ARM-Masken) in `tools/textures/generated/prep/`.

**Rechtslage:** Nach den OpenAI-Nutzungsbedingungen liegen die Rechte am Output beim Nutzer, soweit übertragbar. KI-Bilder genießen in vielen Rechtsordnungen keinen eigenen Urheberrechtsschutz. Für dieses private Projekt ist die Nutzung unproblematisch. Die Bilder sind **nicht** CC0 und werden nicht als CC0 ausgegeben.

**Marken und Namen:** Alle Firmennamen sind erfunden („Bulli's Diner“, „Golden Coast Surf“, „Seaside Service“). Eine frühere Tankstellen-Variante („Pacific Gas & Service“) wurde wegen der Nähe zu PG&E verworfen und ist nicht im Repo. Straßenschilder folgen MUTCD/Caltrans (öffentliche Verkehrszeichen), das Nummernschild zeigt ein erfundenes Kennzeichen.

| Datei (`public/textures/generated/`) | Inhalt | Prompt(s) |
|---|---|---|
| `rock_albedo` | Klippenfels (Gelände-Shader; auch Quelle der Fels-Region im Kit-Atlas) | `rock_cliff` |
| `palm_trunk`, `palm_trunk_normal`, `palm_fronds`, `fan_fronds` | Palmen (Stamm kachelbar, Wedel freigestellt) | `palm_trunk_v2`, `palm_fronds`, `fan_fronds` |
| `tree_cards` (+ `tree_cards.json`), `shrubs` | Baum-Karten (Eiche, Zypresse), Büsche | `tree_cards`, `shrub_card` |
| `world_noise` | kachelbares Makro-Rauschen (prozedural erzeugt, keine KI) | – |
| `tools/models/src/license_plate_bulli_512.png` | Nummernschild „BULLI“ | `license_plate` |
| `tools/models/src/license_plate_{beetle,pickup,sport,jeep}_512.png` | Nummernschilder „KAEFER“, „PICKUP“, „356 B“, „THING“ | `license_plate` mit ersetztem Kennzeichen; Zuschnitt `tools/textures/generated/prep/plates.py` |

Nicht mehr ausgeliefert (G1-Nacharbeit): der Straßenschilder-Atlas (`street_signs`) und der Diner-Innenraum (`diner_interior`); beide wurden nie geladen. Seit Phase 3 M4 (Bulli Bay statt der alten Stadt) außerdem der Fassaden-Atlas (`facade_albedo_tint`, `facade_arm`, `facade_emissive`), die Ladenfronten (`storefront_atlas`, `storefront_emissive`) und `rock_normal`: Die Gebäude kommen aus dem Kit (Abschnitt 7). Prompts und Prep-Schritte bleiben in `tools/textures/generated/`, die Rohbilder im Quellen-Archiv.

Die KTX2-Dateien sind die kanonischen Kopien. Die Rohbilder und aufbereiteten Quellen (55 Dateien, 71 MB) sind nicht im Repo, sondern in einem Tar-Archiv außerhalb davon; `tools/textures/generated/sources.json` listet jede Datei mit SHA-256, `sources.mjs unpack` stellt den Arbeitsbaum für die Prep-Skripte wieder her (siehe `tools/textures/README.md`).

## 5. Entscheidungen zur Pipeline

1. **KTX2 ohne native Werkzeuge.** `toktx` und `basisu` gibt es nicht als brauchbares npm-Paket (`basisu` auf npm ist ein 22-MB-Binärpaket eines Drittanbieters). Der Prototyp nutzte ein natives `gltfpack`-Release, weil der npm-Build von gltfpack keinen BasisU-Encoder hat. Stattdessen nutzt die Pipeline [`ktx2-encoder`](https://github.com/gz65555/ktx2-encoder) (MIT), den offiziellen Basis-Universal-Encoder als WASM. Das läuft auf jedem System mit Node 22, ohne Binärdownload. `gltfpack` (npm, WASM) übernimmt nur noch meshopt und Quantisierung und reicht die KTX2-Bilder durch.
2. **Kodierung:** Farbe ETC1S (klein, transkodiert zu ETC2/BC1/BC7/ASTC), Normalen UASTC + Zstandard (ETC1S-Blöcke wären in der Beleuchtung sichtbar), Texturen bis 128 px immer UASTC (Palettenzellen bleiben exakt). Alle Mipmaps im File.
3. **flipY beim Kodieren** für alle Einzeltexturen, damit UVs und Tangenten wie bei JPG/PNG mit `TextureLoader` funktionieren. Texturen in GLBs bleiben in der glTF-Konvention.
4. **Deterministisch:** Blender-Build, Pack und Textur-Build erzeugen bei gleichem Input dieselben Bytes. Das Modell-Manifest trägt Content-Hashes, die der Unit-Test prüft. Der Client hängt sie als `?v=` an die GLB-URLs, damit CDN und Browser nie ein altes Modell zu einem neuen Manifest liefern.
5. **Basis-Transcoder aus three.js:** Der `KTX2Loader` von three r186 verweist mit `new URL(…, import.meta.url)` auf seinen `basis_transcoder.js/.wasm`; Vite legt beide mit Content-Hash unter `assets/` ab. Damit ist er wie alle gehashten Assets unbegrenzt cachebar und passt immer zur three-Version (mit r160 brauchte es dafür ein eigenes Vite-Plugin).
6. **Laden während des Splash-Screens:** `startModelPreload` in `main.ts` lädt nach dem Anlegen des Renderers alle LODs des Geräte-Tiers (Software-Rendering ohne LOD0) und kompiliert danach die Shader mit den Lichtern der Szene vor (`renderer.compileAsync` mit Ziel-Szene, `initTexture`). Die GLTF-, KTX2- und meshopt-Loader sind ein eigener, nachgeladener Chunk. Schlägt irgendetwas fehl, bleiben die prozeduralen Autos. Ein E2E-Test prüft beide Wege.
7. **HDRIs als `.hdr`:** three r160 konnte UASTC-HDR in KTX2 nicht lesen; r186 kann es, für die zwei 1k-Dateien lohnt der Umstieg aber nicht, sie laden weiter über den `HDRLoader`. Die 1k-Dateien genügen für IBL. Auf Mobile sind HDRIs laut Prototyp optional (prozeduraler Himmel, konstanter IBL-Boden); das entscheidet der Welt-Schritt.

## 6. Budgets

| | Grenze | Bulli heute |
|---|---|---|
| LOD0 | 25 000 Dreiecke, 10 Primitives, 350 KB | 24 719, 9, 206 KB |
| LOD1 | 8 000 Dreiecke, 10 Primitives, 160 KB | 7 965, 9, 111 KB |
| LOD2 | 2 000 Dreiecke, 4 Primitives, 48 KB | 1 960, 4, 24 KB |
| alle LODs eines Autos | 560 KB | 341 KB |
| `public/models` + `public/textures` | 30 MB | 10,9 MB (mit dem Gebäude-Kit, ohne die Texturen der alten Stadt) |
| `terrain.bhf` über die Leitung ([`phase-3-design.md`](phase-3-design.md) 6.2) | 600 KB | 307 KB Brotli, 361 KB Gzip |
| Mobile Tier low (iPhone 12/13), ganzes Bild | ≤ 150 Draw Calls inkl. Schatten, ≤ 500k Dreiecke, KTX2 Pflicht, kein Post | Straßenansicht quer mit T1: 119 Calls, 237k Dreiecke |

Grenzwerte pro LOD stehen maschinenlesbar in `tools/models/budgets.json` und werden beim Packen und im Unit-Test geprüft.

## 7. Gebäude-Kit (Phase 3, Schritt „building-kit“)

Werkzeug, Konventionen und Budgets: [`tools/models/buildings/README.md`](../tools/models/buildings/README.md). Seit Phase 3 M4 im Spiel: `src/client/world/kit.ts` lädt alle Gruppen und den Atlas, `kitCells.ts` und `mapWorld.ts` führen die Teile je Zelle und LOD zusammen.

**Geometrie:** vollständig prozedural in Blender 5.2 aus `tools/models/buildings/pieces/*.py` und `lib/bd_kit.py`, keine fremden Meshes. Vier Gebäudefamilien (Downtown-Geschäftshaus in vier Stilen: Backstein, Putz, Mission Revival, Art déco; Spanish-Revival-Wohnhaus, Strandhaus/Surfshop, Industrie- und Hafenhalle), fünf Landmarken (Leuchtturm, Wasserturm, Diner, Tankstelle, Hafenkran auf Senkkasten), Pier-Segmente, Leitplanke mit Endstücken, Felsen und Klippenblöcke, Rettungsturm und Surfbrett-Ständer, Party-Arena (K-Rail, Wasserbarrieren, Tribüne, Flutlichtmast, Container 20 und 40 Fuß).

**Gemeinsamer Atlas** `public/models/kit/kit_atlas_{albedo,normal,arm,emissive}.ktx2` (Layout `tools/models/buildings/atlas.json`, gebaut von `make_atlas.py`, kodiert mit `tools/lib/ktx2.mjs`):

| Region | Quelle | Autoren | Lizenz |
|---|---|---|---|
| Putz (`stucco`), Dachziegel (`roof_tiles`), Dachkies (`gravel`) | Poly Haven White Stucco, Clay Roof Tiles 02, Tarred Gravel (dieselben Quellen wie G1) | Amal Kumar; Amal Kumar; Dimitrios Savva | CC0 1.0 |
| Ziegel (`brick`) | [Large Red Bricks](https://polyhaven.com/a/large_red_bricks) | Rob Tuytel | CC0 1.0 |
| Stülpschalung (`siding`, gedreht) | [White Planks Clean](https://polyhaven.com/a/white_planks_clean) | Rob Tuytel | CC0 1.0 |
| Wellblech (`corrugated`) | [Corrugated Iron 02](https://polyhaven.com/a/corrugated_iron_02) | Jenelle van Heerden, Sergej Majboroda | CC0 1.0 |
| Pier- und Veranda-Dielen (`deck`) | [Wood Planks Grey](https://polyhaven.com/a/wood_planks_grey) | Rob Tuytel | CC0 1.0 |
| Beton (`concrete`) | [Concrete Wall 008](https://polyhaven.com/a/concrete_wall_008) | Dario Barresi, Charlotte Baglioni | CC0 1.0 |
| Rolltor (`shutter`) | [Painted Metal Shutter](https://polyhaven.com/a/painted_metal_shutter) | Dario Barresi, Rico Cilliers, Charlotte Baglioni | CC0 1.0 |
| Container-Wand (`container`) | [Container Side](https://polyhaven.com/a/container_side) | Dimitrios Savva | CC0 1.0 |
| Fels (`rock`) | G1-Klippenfels `rock_cliff` (KI, Abschnitt 4) | – | wie Abschnitt 4 |
| Ladenfronten (Bäckerei, Eisenwaren, Buchladen, Surfshop) | KI-Bogen `kit_storefronts` | – | Nutzungsrechte beim Projekt, kein CC0 |
| Fenster und Türen (Schiebefenster, Rollo-Fenster, Flügelfenster, Bogenfenster, Bogentür, Kassettentür, Stahltür, Fabrikfenster) | KI-Bogen `kit_windows_doors` | – | wie oben |
| Ladenschilder „SEAVIEW BOOKS“, „BAY HARDWARE“, „SUNSET BAKERY“, „DRIFTWOOD SURF“, „HARBOR FISH CO.“, „BULLI BAY CANNERY“ | KI-Bogen `kit_signs` | – | wie oben; alle Namen erfunden, keine Marken |
| Ladenschilder „BLUE WAVE COFFEE“, „LA PLAYA TAQUERIA“, „SCOOPS ICE CREAM“, „PACIFIC CYCLES“, „BULLI'S DINER“, „SEASIDE SERVICE“, „SANDPIPER REALTY“, „PIER TACKLE & BAIT“ | KI-Bogen `kit_signs_2` (Codex-imagegen, Prompt `tools/textures/generated/prompts/kit_signs_2.txt`) | – | wie oben; alle Namen erfunden, keine Marken |
| Markisenstoffe, Farbpalette (32 PBR-Zellen) | prozedural in `make_atlas.py` | – | eigenes Werk |

Die Poly-Haven-Quellen holt `npm --prefix tools run textures:fetch` (Rollen `kit_*` in `tools/textures/textures.json`, `"publish": []`, also nicht nach `public/textures`). Die KI-Bögen entstanden mit Codex-imagegen (`tools/textures/generated/gen.sh`, Prompts wörtlich in `tools/textures/generated/prompts/kit_*.txt`) und liegen als JPG in `tools/models/buildings/src`; die Zuschnitte stehen in `atlas.json`. Die Schilder „MARINA SUPPLY“ und „COAST DRUG“ des Bogens werden nicht genutzt.

**Pipeline-Entscheidungen des Kits:**

1. **Ein Material, ein Atlas für alle Teile.** Jedes LOD ist genau ein Primitive des Materials `kit_atlas`; ein Chunk, der alle Kit-Teile zusammenführt, kostet einen Draw Call (plus Schatten). Varianten (Putz-, Schalungs-, Blech- und Containerfarben) stecken in `COLOR_0` (Tönung × gebackene AO × leichte Bodenverschmutzung).
2. **Kacheln ohne Wrap-Sampler:** Die Geometrie wird an jeder Texturperiode geschnitten, jede Fläche sampelt innerhalb ihrer Atlas-Region (Unit-Test je Dreieck). So lassen sich Teile beliebig zusammenführen, und die Mip-Stufen bluten nur über die gewrappten Ränder (32 px auf 2048).
3. **Atlas neben den GLBs, per URI referenziert** (glTF `images[].uri` + `KHR_texture_basisu`, gltfpack `-tr`), nicht in `public/textures`: der Test `worldTextures.test.ts` verlangt dort nur Texturen, die der Client heute anfordert. glTF-Konvention (kein flipY) wie bei den Auto-Texturen.
4. **Deterministisch:** Atlas, Blender-Build und Packen erzeugen bei gleichen Quellen dieselben Bytes; das Manifest trägt Hashes, die der Unit-Test prüft.

**Budgets** (`tools/models/buildings/budgets.json`, geprüft beim Packen und in `tests/tools/models/buildingKit.test.ts`): Dreiecke je LOD nach Kategorie (Gebäude 4 000 / 2 500 / 1 000, Landmarken 3 000 / 1 500 / 400, Props 1 600 / 800 / 300), ein Primitive je LOD, gröbstes LOD höchstens 60 % von LOD0 (ausgenommen Teile, deren LOD0 schon ins Budget des gröbsten LODs passt), gleiche Texeldichte in allen LODs (Test je Kachel-Region), höchstens 440 KB je Gruppen-GLB und 2,4 MB für alle, Atlas höchstens 1,7 MB und mindestens 80 px/m je Kachel, Szenario Main Street (8/16/24 Gebäude einer Downtown-Gruppe in LOD0/1/2) unter 90 000 Dreiecken. Die Grenzen für LOD2, Anteil und Bytes stiegen mit der zweiten Runde (Befund 11 aus dem Review): Mit gleicher Texeldichte bleiben die Schnitte an den Texturperioden auch im groben LOD, und Main Street hat jetzt 14 statt 6 Häuser.

**Review-Renderings:** Seit der zweiten Runde unter einem physikalischen Himmel (Blender Sky Texture, Meereshöhe, leichter Küstendunst, ohne Landschaft), vorher mit dem Victoria-Sunset-HDRI, das den Lion's Head (Kapstadt) hinter jedes Bild stellte. Eevee-Stills je Familie in mehreren Runden (Downtown v1–v3, Spanish/Strand/Halle v1, v3, v4, Props v1–v3) und three.js-Stills der gepackten Dateien (`preview.mjs`), außerhalb des Repos abgelegt. Geändert wurde dabei unter anderem: Schilder vor die Pilaster, keine gleichen Nachbarläden, Eingangstür zu den Obergeschossen, Fensterfaschen, Bodenverschmutzung, Pier-Verstrebungen in der Jochebene und hellere Dielen, Leitplanken-Distanzstücke am abgesenkten Ende, kräftigere Felsschichten, echte Surfbrett-Umrisse, Aluminium-Flutlichtköpfe, Bogen-Faschen am Spanish-Revival-Haus, Regenrinnen am Strandhaus, Lichtbänder und Blechbahnen-Variation an den Hallen, breitere Ränder der kleinen Kacheln gegen Mip-Bluten und eine AO je Vertex statt je Ecke (vorher zeichnete sie das Schnittraster auf den Dächern nach). Zweite Runde nach dem Review (Befund 11): Main Street in Putz, Mission Revival und Art déco statt überwiegend Backstein (2 von 14 Häusern), 14 statt 6 Schilder, 1- bis 3-geschossig, gleiche Texeldichte in allen LODs, Landmarken; Fehler aus den Renderings: Rückseiten der Deco-Lisenen in der Fassadenebene, Schildwiederholung an Nachbarläden.

## 8. Karte Bulli Bay (Phase 3)

Format, Bake und Budgets: [`phase-3-design.md`](phase-3-design.md) Abschnitte 5 und 6.

- **Quellen** (`src/shared/maps/bulli-bay`): `roads.json` (Straßen-Splines, Kreuzungen, Plätze; von Hand gesetzt, seit dem worldviewer auch mit dessen Spline-Editor), `map.json`, `zones.json` (Zonen-Polygone), `base.json` (Parameter des Grundgeländes), `pois.json` (Landmarken, Spawns, Party-Zone, Items), `tracks.json` (sechs Strecken). Alles eigenes Werk des Projekts; zusammen 64 KB, als Quelltext im Build (`scripts/copy-map-sources.mjs`).
- **Gebacken** (`public/maps/bulli-bay`): `terrain.bhf` (1001 × 1001 Höhen im 2-m-Raster, Oberflächen, Zonen) und `manifest.json` (Hashes, Größen, Statistik) aus `npx tsx tools/map/bake.ts`, deterministisch (gleiche Quellen, gleiche Bytes; `--check` und der Datentest `tests/tools/map/bulliBay.test.ts` erkennen ein vergessenes Bake). Das Grundgelände ist prozedurales Rauschen aus `base.json`, kein Geländemodell einer echten Küste. Die Karte bildet keinen echten Ort nach: „Bulli Bay“ und die Viertel sind erfunden, die Straßennamen erfunden oder allgemein kalifornisch (Main Street, Harbor Boulevard, Pacific Coast Highway als Name der Küstenstraße).
- **Vorschaubilder** (`docs/img/phase-3-map-concept.png`, `phase-3-map-preview.png`): die Konzeptskizze und eine Draufsicht aus `tools/map/preview.ts`, beide eigenes Werk.
- **Straßenmöbel** (Laternen, Ampelmasten, Hydranten, Bänke, Mülleimer), Zäune, Streuung und Requisiten der Zonen haben keine eigenen Dateien: Ihre Geometrie entsteht zur Laufzeit im Client (`src/client/world/streetFurniture.ts`, `scatter.ts`) aus den Modellen von G1 und dem Kit, texturiert mit den Texturen der Abschnitte 3, 4 und 7.
