# Assets: Herkunft, Lizenzen, Pipeline und Budgets

**Stand:** 2026-09-23 · Grafik-Schritt G1 „Asset-Pipeline“ (realistischer Stil, ruhig-naturgetreue Farbstimmung).

Dieses Dokument listet jede Binärdatei unter `public/models` und `public/textures` mit Herkunft und Lizenz, dazu die Entscheidungen zur Pipeline. Die Werkzeuge selbst sind in [`tools/models/README.md`](../tools/models/README.md) und [`tools/textures/README.md`](../tools/textures/README.md) beschrieben.

## 1. Überblick

| Bereich | Quelle | Lizenz | Im Repo | Größe |
|---|---|---|---|---|
| Automodelle (`public/models`) | eigene prozedurale Blender-Skripte (`tools/models`) | eigenes Werk des Projekts | GLB (meshopt + KTX2), 3 LODs je Auto | 333 KB (Bulli) |
| Car-Select-Icons (`public/icons`) | Eevee-Render der eigenen Modelle (`build-all.mjs --icons`) | eigenes Werk des Projekts | WebP mit Alpha, 156×96 | 7 KB (Bulli) |
| PBR-Texturen (`public/textures/pbr`) | Poly Haven | CC0 1.0 | KTX2 | 3,3 MB |
| Generierte Texturen (`public/textures/generated`) | KI-generiert (Codex CLI, imagegen-Skill, OpenAI `image_gen`), eigene Nachbearbeitung | Nutzungsrechte beim Projekt, **kein** CC0 | KTX2 + JSON | 2,3 MB |
| HDRIs (`public/textures/hdri`) | Poly Haven | CC0 1.0 | Radiance `.hdr`, 1k | 2,7 MB |
| Referenzen (`tools/models/ref`) | KI-generierte Blaupausen, Maße aus Sekundärquellen | nur Arbeitsmaterial, nicht im Spiel | JPG + JSON | 1,5 MB |
| Nummernschild-Decal (`tools/models/src`) | KI-generiert, eigene Nachbearbeitung | wie oben | PNG 512×256 | 0,2 MB |

Summe der neuen Binär-Assets: rund 10,3 MB, davon 8,6 MB ausgeliefert (Obergrenze laut Plan ~30 MB). Ein Unit-Test (`tests/client/modelBudgets.test.ts`) hält `public/models` + `public/textures` unter 30 MB.

Quelltexturen in voller Auflösung liegen nicht im Repo. `npm --prefix tools run textures:fetch` lädt sie reproduzierbar (MD5-geprüft) nach `tools/textures/.cache`.

## 2. Automodelle

- **VW T1 Samba (1963, 23 Fenster)**, `bulli_lod{0,1,2}.glb`: vollständig prozedural aus `tools/models/vehicles/bulli.py` (Blender 5.2 LTS). Maße nach `tools/models/ref/dimensions.json` (Werksangaben über Sekundärquellen, Quellen in der Datei). Keine fremden Meshes, keine gekauften oder heruntergeladenen Modelle.
- **VW-Logo:** das echte VW-Rundzeichen als Geometrie (Front, Heck) und als Normal-Map-Prägung auf den Radkappen. Das ist eine bewusste Nutzerentscheidung für dieses private Projekt (Plan, Entscheidung 5). Die Marke gehört der Volkswagen AG.
- **Nummernschild:** kalifornisches Schild im Stil 1963–69 mit dem erfundenen Kennzeichen „BULLI“ (KI-generiert, siehe Abschnitt 4).
- **Surfbrett:** Teil jedes Modells, standardmäßig ausgeblendet (freischaltbares Zubehör).
- **Im Spiel** seit Schritt „Bulli T1“: Maßstab 1,15 (passend zur Sim-Hülle), LOD nach Entfernung, Lampen und Material-Klone pro Auto. Details in [`docs/cars.md`](cars.md).
- **Icon:** `public/icons/car-bulli.webp` ist ein Render von LOD0 für die Autoauswahl im Startbildschirm.
- Käfer, T1-Pritsche, Porsche 356 und Typ 181 folgen in späteren Schritten. Bis dahin bleiben sie prozedural im Spiel (`src/client/vehicle/CarModel.ts`).

## 3. Poly-Haven-Texturen und HDRIs (CC0 1.0)

Alle Dateien von [polyhaven.com](https://polyhaven.com), Lizenz [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Namensnennung ist nicht nötig, sie ist als Dank vorgesehen („HDRIs & textures: Poly Haven, CC0“).

| Rolle | Poly-Haven-Asset | Autoren | Kachel | Im Spiel |
|---|---|---|---|---|
| `asphalt` | [Asphalt 02](https://polyhaven.com/a/asphalt_02) | Rob Tuytel | 3,0 m | Albedo/ARM 1024, Normal 512 |
| `asphalt_clean` | [Clean Asphalt](https://polyhaven.com/a/clean_asphalt) | Dimitrios Savva | 2,1 m | 512 (ruhige Rennlinie) |
| `sidewalk` | [Concrete Floor 03](https://polyhaven.com/a/concrete_floor_03) | Rob Tuytel, Matterfield | 2,5 m | 512 |
| `stucco` | [White Stucco](https://polyhaven.com/a/white_stucco) | Amal Kumar | 2,0 m | 512 (per Vertex-Farbe getönt) |
| `roof_tiles` | [Clay Roof Tiles 02](https://polyhaven.com/a/clay_roof_tiles_02) | Amal Kumar | 2,5 m | 512 |
| `roof_gravel` | [Tarred Gravel](https://polyhaven.com/a/tarred_gravel) | Dimitrios Savva | 2,2 m | 256 |
| `grass` | [Leafy Grass](https://polyhaven.com/a/leafy_grass) | Charlotte Baglioni | 2,0 m | 512 |
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
| `facade_albedo_tint`, `facade_arm`, `facade_emissive` | Fassaden-Atlas, 4 Geschoss-Bänder, Alpha = Tönungsmaske für den Stuck | `facade_atlas` |
| `storefront_atlas`, `storefront_emissive` | Ladenfronten Diner, Surfshop, Tankstelle; Neon/Innenlicht | `diner_front`, `surfshop_front_v2`, `gas_station_front_v2` |
| `diner_interior` | Innenraum hinter den Diner-Scheiben | `diner_interior` |
| `rock_albedo`, `rock_normal` | Klippenfels | `rock_cliff` |
| `palm_trunk`, `palm_trunk_normal`, `palm_fronds`, `fan_fronds` | Palmen (Stamm kachelbar, Wedel freigestellt) | `palm_trunk_v2`, `palm_fronds`, `fan_fronds` |
| `tree_cards` (+ `tree_cards.json`), `shrubs` | Baum-Karten (Eiche, Zypresse), Büsche | `tree_cards`, `shrub_card` |
| `street_signs` (+ `street_signs_atlas_1k.json`) | 8 Schilder: STOP, 35 mph, Kurve, ONE WAY, OCEAN AVE, PCH, Chevron, CA-1 | `street_signs` |
| `world_noise` | kachelbares Makro-Rauschen (prozedural erzeugt, keine KI) | – |
| `tools/models/src/license_plate_bulli_512.png` | Nummernschild „BULLI“ | `license_plate` |

Die KTX2-Dateien sind die kanonischen Kopien. Die aufbereiteten Quellen (1–2 MB je Bild) sind nicht im Repo; wer eine Textur ändert, erzeugt sie neu (siehe `tools/textures/README.md`).

## 5. Entscheidungen zur Pipeline

1. **KTX2 ohne native Werkzeuge.** `toktx` und `basisu` gibt es nicht als brauchbares npm-Paket (`basisu` auf npm ist ein 22-MB-Binärpaket eines Drittanbieters). Der Prototyp nutzte ein natives `gltfpack`-Release, weil der npm-Build von gltfpack keinen BasisU-Encoder hat. Stattdessen nutzt die Pipeline [`ktx2-encoder`](https://github.com/gz65555/ktx2-encoder) (MIT), den offiziellen Basis-Universal-Encoder als WASM. Das läuft auf jedem System mit Node 22, ohne Binärdownload. `gltfpack` (npm, WASM) übernimmt nur noch meshopt und Quantisierung und reicht die KTX2-Bilder durch.
2. **Kodierung:** Farbe ETC1S (klein, transkodiert zu ETC2/BC1/BC7/ASTC), Normalen UASTC + Zstandard (ETC1S-Blöcke wären in der Beleuchtung sichtbar), Texturen bis 128 px immer UASTC (Palettenzellen bleiben exakt). Alle Mipmaps im File.
3. **flipY beim Kodieren** für alle Einzeltexturen, damit UVs und Tangenten wie bei JPG/PNG mit `TextureLoader` funktionieren. Texturen in GLBs bleiben in der glTF-Konvention.
4. **Deterministisch:** Blender-Build, Pack und Textur-Build erzeugen bei gleichem Input dieselben Bytes. Das Modell-Manifest trägt Content-Hashes, die der Unit-Test prüft. Der Client hängt sie als `?v=` an die GLB-URLs, damit CDN und Browser nie ein altes Modell zu einem neuen Manifest liefern.
5. **Basis-Transcoder aus three.js:** Ein Vite-Plugin (`vite.config.ts`) liefert `basis_transcoder.js/.wasm` der installierten three-Version unter `assets/basis-<hash>/` aus. Damit ist er wie alle gehashten Assets unbegrenzt cachebar und passt immer zur three-Version.
6. **Laden während des Splash-Screens:** `startModelPreload` in `main.ts` lädt nach dem Anlegen des Renderers alle LODs des Geräte-Tiers (Software-Rendering ohne LOD0) und kompiliert danach die Shader mit den Lichtern der Szene vor (`renderer.compileAsync` mit Ziel-Szene, `initTexture`). Die GLTF-, KTX2- und meshopt-Loader sind ein eigener, nachgeladener Chunk. Schlägt irgendetwas fehl, bleiben die prozeduralen Autos. Ein E2E-Test prüft beide Wege.
7. **HDRIs als `.hdr`:** three r160 kann UASTC-HDR in KTX2 noch nicht lesen. Die 1k-Dateien genügen für IBL. Auf Mobile sind HDRIs laut Prototyp optional (prozeduraler Himmel, konstanter IBL-Boden); das entscheidet der Welt-Schritt.

## 6. Budgets

| | Grenze | Bulli heute |
|---|---|---|
| LOD0 | 25 000 Dreiecke, 10 Primitives, 350 KB | 24 719, 9, 206 KB |
| LOD1 | 8 000 Dreiecke, 10 Primitives, 160 KB | 7 965, 9, 111 KB |
| LOD2 | 2 000 Dreiecke, 4 Primitives, 48 KB | 1 960, 4, 24 KB |
| alle LODs eines Autos | 560 KB | 341 KB |
| `public/models` + `public/textures` | 30 MB | 8,6 MB |
| Mobile Tier low (iPhone 12/13), ganzes Bild | ≤ 150 Draw Calls inkl. Schatten, ≤ 500k Dreiecke, KTX2 Pflicht, kein Post | Straßenansicht quer mit T1: 119 Calls, 237k Dreiecke |

Grenzwerte pro LOD stehen maschinenlesbar in `tools/models/budgets.json` und werden beim Packen und im Unit-Test geprüft.
