# Car models (tools/models)

(The building kit of the phase 3 map lives in [`buildings/`](buildings/README.md): its own
Blender scripts, atlas and budgets, output in `public/models/kit`.)

The cars are built procedurally in Blender (no hand modelling, no downloaded
meshes), packed for the web and committed to `public/models`. The game loads
them with `src/client/assets/ModelCache.ts` and keeps its procedural box cars
as the fallback whenever a model is missing or fails to load.

```
tools/models/
  build-all.mjs        Blender build + pack for every car in models.json
  pack.mjs             raw GLB -> KTX2 textures -> gltfpack (meshopt) -> budget check
  models.json          registry: car type id -> Blender script, LODs
  budgets.json         triangle / draw call / byte budgets, required nodes and extensions
  vehicles/bulli.py    VW T1 Samba (1963, 23 windows); importable (main() only runs as a script)
  vehicles/beetle.py   VW 1200 Kaefer (1963): body loft + four fender lofts + running boards
  vehicles/pickup.py   VW T1 Pritsche (1963): the T1 shell of bulli.py cut behind the cab, load bed
  vehicles/sport.py    Porsche 356 B T6 Coupe (1963): one smooth body loft, stylised crest
  vehicles/jeep.py     VW Typ 181 (1973): linear (flat panel) loft, open tub, bolted-on fenders
  lib/bd_common.py     shared Blender helpers (mesh builder, lathe/tube/box, booleans,
                       per-vertex AO bake, glTF export, LOD report)
  lib/bd_car.py        car framework of the four cars after the T1: material specs + atlas
                       (palette, plate, tread, hubcap relief, crest), glass, Catmull-Rom lofts,
                       windows + boolean cutters, lamps, bumpers, wheels, surfboard,
                       assemble() (node convention) and main() (LOD loop, export, renders)
  lib/bd_lookdev.py    Eevee look-dev renders + orthographic blueprint renders
  lib/make_env.py      sun-clamped HDRI + sun direction for the look-dev renders
  lib/compare_blueprint.py  overlays the ortho renders on a car's blueprint (--car=<id>)
  ref/dimensions.json  real dimensions of all five cars (sources inside)
  ref/blueprints.json  pixel mapping of the blueprint views per car (for the overlays)
  ref/blueprint_prompt.txt  prompt of the AI blueprint sheets
  ref/*_blueprint.jpg  AI-generated orthographic reference sheets (T1, Kaefer,
                       T1 Pritsche, 356, Typ 181) for modelling and overlays
  src/                 small inputs of the builds (licence plate decals, one per car)
```

Two product shots per car, both Eevee renders of LOD0 in the factory paint
(`bd_lookdev.render_icon`, transparent film):

- the small icon of the race lobby's car picker (`public/icons/car-<id>.webp`),
  trimmed and fitted into 156 x 96 px by `build-all.mjs --icons`;
- the main menu's car card (`public/icons/car-<id>-menu.webp`, 640 x 360),
  the same shot at `--icon-size=1280x720`, by `tools/ui/menu-renders.mjs`
  (docs/ui.md 4.3; the menu shows it desaturated, the paint is picked apart).

## Running it

```bash
npm --prefix tools ci                          # once: gltf-transform, gltfpack, ktx2-encoder, sharp
npm --prefix tools run models                  # all cars: Blender build + pack -> public/models
node tools/models/build-all.mjs --only=bulli   # one car
node tools/models/build-all.mjs --skip-blender # re-pack tools/models/.out without Blender
node tools/models/build-all.mjs --render       # also Eevee stills (needs the look-dev inputs below)
node tools/models/build-all.mjs --only=bulli --icons  # also the race lobby's icon -> public/icons/car-bulli.webp
node tools/ui/menu-renders.mjs --only=bulli           # the menu's card -> public/icons/car-bulli-menu.webp
```

Blender 5.2 LTS (`$BLENDER`, else `/opt/homebrew/bin/blender`,
`/Applications/Blender.app`, or `blender` on the PATH). A full build of the
Bulli takes about 5 s. Raw output (GLB per LOD, textures, `report.json`,
`blender.log`, a `.blend` of LOD0) lands in `tools/models/.out/<id>/`, which is
git-ignored. Both steps are deterministic: re-running them reproduces the
committed files byte for byte (the unit test compares the hashes in
`public/models/manifest.json`).

Look-dev renders and blueprint overlays:

```bash
npm --prefix tools run textures:fetch          # HDRIs + asphalt for the render scene
python3 tools/models/lib/make_env.py           # sun-clamped HDRI (needs numpy)
blender -b --factory-startup --python tools/models/vehicles/bulli.py -- --lods=0 --views=front34,side --ortho
python3 tools/models/lib/compare_blueprint.py  # -> .out/bulli/work/overlay_*.png
python3 tools/models/lib/compare_blueprint.py --car=sport   # other cars: after <id>.py --ortho
```

### How the four cars after the T1 are built

All four follow the same recipe (see the header of each script):

1. **Measure the blueprint.** Ruler crops of the sheet (1 px grid lines every 25 px) give
   the side silhouette, the plan widths and the front/rear sections in pixels. The AI
   sheets are not exactly to scale, so lengths, heights and widths are fitted separately
   to the real values of `ref/dimensions.json` (px/m per view in `ref/blueprints.json`).
2. **Body as lofted stations.** `bd_car.loft` interpolates half cross-sections (bottom
   centre -> top centre, mirrored) with a centripetal Catmull-Rom spline across and along
   the car; `linear_u/linear_v` gives flat panels (Typ 181). Stations are metres behind
   the front bumper tip (`s`); degenerate stations (all x = 0) close nose and tail.
   The Kaefer adds four fenders as separate closed lofts of superellipse loops, the 356
   carries its fender crowns in the section points, the Pritsche reuses the T1 shell of
   `bulli.py` and removes the bus body behind the cab with a boolean prism.
3. **Details on the surface** (`Surf` rays): windows with rubber seal + chrome insert on
   LOD0 and a boolean cutter each (see-through glass, inner shell for the cabin), seams,
   trims, lamps, badges, bumpers, plate, mirrors, wipers, interior, underbody.
4. **Wheel arches** are boolean cylinders (trapezoid prisms on the 181); LOD2 of the
   Kaefer lifts the fender loops over the wheels instead of cutting.
5. **Iterate** on Eevee renders (`--views=front34,side,rear34,chase`) and the ortho
   overlays until proportions and silhouette match; every car went through at least two
   rounds (docs/cars.md).

The Porsche 356 sheet `ref/sport_blueprint.jpg` (it replaced the Karmann Ghia sheet of the
prototype) was generated for this build with the same prompt as the other sheets; prompt
and car description are in `ref/blueprint_prompt.txt`.

## Conventions (every car must follow them)

- **Units and axes:** 1 unit = 1 m. Blender Z-up; the exporter maps Blender
  (x, y, z) to three.js (x, z, -y). The car faces three **+Z** (built at
  Blender -Y), driver's left is **+X**. Origin on the ground, centre of the
  footprint (bumper to bumper).
- **Nodes** (snake_case, checked by `budgets.json` and the tests):
  - `car_<id>`: root, extras with `car_type`, `lod`, real `length_m`,
    `width_m`, `height_m`, `wheelbase_m`, `collision_half_extents`
  - `body`: all static parts, one primitive per material
  - `wheel_fl`, `wheel_fr`, `wheel_rl`, `wheel_rr`: empty pivots at the wheel
    centres with extras `role: "wheel"`, `steer`, `radius`, `side`, `axle`;
    the geometry hangs below as `wheel_xx_geo` (LOD2: merged into the body,
    `wheel_xx_geo` stays as an empty so the API is the same)
  - `accessory_surfboard`: roof rack and board, extras
    `default_visible: false` (unlockable, hidden by default)
  - `socket_exhaust`, `socket_nametag`, `socket_underglow`,
    `socket_headlight_l/r`, `socket_taillight_l/r`: empties for effects
- **Materials:** `paint_primary` (player colour, clearcoat; clone it per car
  before tinting), `paint_secondary` (clearcoat), `glass` (BLEND; the left
  half of its texture is the window tint, the right half the soft contact
  blob under the car, see `src/client/assets/carMaterials.ts`) and one atlas
  material `<id>_atlas` (LOD2 `<id>_atlas_lod2`) for everything else: a
  16x2 palette of flat PBR cells plus UV regions for the licence plate, the
  tyre tread and the hubcap (VW roundel embossed in the normal map; `bd_car` adds
  a `crest` region and a plain ring relief for the 356). Lamps
  are emissive cells of the atlas, so `emissiveIntensity` of the atlas
  material switches the lights.
- **Vertex colours:** LOD0/LOD1 carry baked ambient occlusion in `COLOR_0`
  (three.js multiplies it into the base colour).
- **No eyes** on any car; the real VW logo stays (user decision). The Porsche 356 gets
  a stylised crest drawn procedurally into the atlas (`crest` region), not the
  trademark artwork.
- **Defaults of the Bulli:** 4 skylights per side, closed canvas sunroof,
  chrome bumpers.
- **In the game** (`src/client/vehicle/GltfCarBody.ts`, see `docs/cars.md`):
  uniform scale per car (`MODEL_SCALE`, Bulli 1.15 to fill the sim hull),
  LOD by camera distance (0-25 / 25-70 / >70 m), every material cloned per
  car, the glass blob discarded (the game draws its own contact shadow), the
  tail (red) and amber cells of the atlas emissive map lit as brake lights
  and blinkers, so keep lamp colours clearly red / amber / white.

## Budgets

`budgets.json` holds the limits the pack step and
`tests/client/modelBudgets.test.ts` enforce:

| LOD | Triangles | Primitives (draw calls) | Bytes (packed) | Use |
|---|---|---|---|---|
| 0 | 25 000 | 10 | 350 KB | own car, close cars on desktop |
| 1 | 8 000 | 10 | 160 KB | mid distance, own car on weak phones |
| 2 | 2 000 | 4 | 48 KB | far cars |

The four cars after the T1 have stricter limits (`modelTriangles`): 20 000 / 7 000 /
2 000 triangles. All LODs of one car together: at most 560 KB.

| Car | LOD0 | LOD1 | LOD2 | Bytes (all LODs) |
|---|---|---|---|---|
| bulli | 24 719 | 7 965 | 1 960 | 341 KB |
| beetle | 18 763 | 6 976 | 1 838 | 297 KB |
| pickup | 16 261 | 5 991 | 1 764 | 284 KB |
| sport | 14 944 | 5 151 | 1 509 | 253 KB |
| jeep | 8 151 | 3 457 | 1 593 | 215 KB | The mobile frame budget (tier
low, iPhone 12/13: at most 150 draw calls including the shadow pass, 500k
triangles) is why other cars use LOD1/LOD2 on phones.

## Packing

`pack.mjs` never runs the default `gltf-transform optimize` (it merges and
drops the wheel nodes). Instead:

1. restores the clearcoat roughness Blender 5.2 drops on export,
2. encodes every texture to KTX2 with `tools/lib/ktx2.mjs`
   ([ktx2-encoder](https://github.com/gz65555/ktx2-encoder), the Basis
   Universal encoder as WASM, so no native `toktx`/`basisu` is needed):
   base colour 512 px as ETC1S, normals as UASTC, textures up to 128 px as
   UASTC,
3. runs `gltfpack -cc -kn -km -ke` (meshopt compression and quantisation,
   keeping named nodes, materials and extras; KTX2 images pass through),
4. checks the result against `budgets.json` and writes
   `public/models/manifest.json` (file, content hash, bytes, triangles,
   primitives per LOD, wheel radius, real dimensions).

## Adding a car

1. Write `vehicles/<id>.py` on top of `lib/bd_car.py` (copy the structure of
   `sport.py`: `init(...)`, stations, `details(S, q)`, `arches(q)`, `surf(...)`,
   `Q` per LOD, `build_lod(lod)` -> `assemble(...)`, `main(...)`), use the
   dimensions from `ref/dimensions.json` and the blueprint in `ref/` (add its
   mapping to `ref/blueprints.json` for the overlays), and a plate decal
   `src/license_plate_<id>_512.png`.
2. Register it in `models.json` with the car type id of
   `src/client/vehicle/CarModel.ts` (`beetle`, `pickup`, `sport`, `jeep`).
3. `node tools/models/build-all.mjs --only=<id> --icons` and
   `node tools/ui/menu-renders.mjs --only=<id>`, check the look-dev renders,
   run `npm test`, commit the script and `public/models/<id>_lod*.glb` plus
   the manifest, `public/icons/car-<id>.webp` and `public/icons/car-<id>-menu.webp`.
4. In the game: add the id to `GLTF_TYPES` (`src/client/vehicle/CarModel.ts`) and a
   scale to `MODEL_SCALE` (`src/client/vehicle/GltfCarBody.ts`) that fits the sim hull.
