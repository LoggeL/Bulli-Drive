# Car models (tools/models)

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
  vehicles/bulli.py    VW T1 Samba (1963, 23 windows)
  lib/bd_common.py     shared Blender helpers (mesh builder, lathe/tube/box, booleans,
                       per-vertex AO bake, glTF export, LOD report)
  lib/bd_lookdev.py    Eevee look-dev renders + orthographic blueprint renders
  lib/make_env.py      sun-clamped HDRI + sun direction for the look-dev renders
  lib/compare_blueprint.py  overlays the ortho renders on the T1 blueprint
  ref/dimensions.json  real dimensions of all five cars (sources inside)
  ref/*_blueprint.jpg  AI-generated orthographic reference sheets (T1, Kaefer,
                       T1 Pritsche, 356, Typ 181) for modelling and overlays
  src/                 small inputs of the builds (licence plate decal)
```

## Running it

```bash
npm --prefix tools ci                          # once: gltf-transform, gltfpack, ktx2-encoder, sharp
npm --prefix tools run models                  # all cars: Blender build + pack -> public/models
node tools/models/build-all.mjs --only=bulli   # one car
node tools/models/build-all.mjs --skip-blender # re-pack tools/models/.out without Blender
node tools/models/build-all.mjs --render       # also Eevee stills (needs the look-dev inputs below)
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
```

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
  tyre tread and the hubcap (VW roundel embossed in the normal map). Lamps
  are emissive cells of the atlas, so `emissiveIntensity` of the atlas
  material switches the lights.
- **Vertex colours:** LOD0/LOD1 carry baked ambient occlusion in `COLOR_0`
  (three.js multiplies it into the base colour).
- **No eyes** on any car; the real VW logo stays (user decision).
- **Defaults of the Bulli:** 4 skylights per side, closed canvas sunroof,
  chrome bumpers.

## Budgets

`budgets.json` holds the limits the pack step and
`tests/client/modelBudgets.test.ts` enforce:

| LOD | Triangles | Primitives (draw calls) | Bytes (packed) | Use |
|---|---|---|---|---|
| 0 | 25 000 | 10 | 350 KB | own car, close cars on desktop |
| 1 | 8 000 | 10 | 160 KB | mid distance, own car on weak phones |
| 2 | 2 000 | 4 | 48 KB | far cars |

All LODs of one car together: at most 560 KB. The Bulli is at 205 / 111 /
23 KB with 24 415 / 7 995 / 1 942 triangles. The mobile frame budget (tier
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

1. Write `vehicles/<id>.py` on top of `lib/bd_common.py` (copy the structure of
   `bulli.py`: material factory, `build_lod(lod)`, `summarize_lod`,
   `export_glb`), use the dimensions from `ref/dimensions.json` and the
   blueprint in `ref/`.
2. Register it in `models.json` with the car type id of
   `src/client/vehicle/CarModel.ts` (`beetle`, `pickup`, `sport`, `jeep`).
3. `node tools/models/build-all.mjs --only=<id>`, check the look-dev renders,
   run `npm test`, commit the script and `public/models/<id>_lod*.glb` plus
   the manifest.
