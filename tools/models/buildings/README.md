# Building kit (tools/models/buildings)

Procedural Blender kit of the buildings and props of the curated map Bulli Bay (phase 3,
`docs/phase-3-design.md`), in the realistic look of the G1 world: four building families, the
pier, guardrails, cliff and rock blocks, beach props and the elements of the party arena. Every
piece is parametric (width or bays, storeys, depth, seed) and exported with three LODs into one
meshopt GLB per group; all groups share one KTX2 texture atlas. **Not used by the game yet**: the
chunk builder of phase 3 M4 will place and merge the pieces.

```
tools/models/buildings/
  kit.json          registry: groups -> Blender module, category, pieces with their parameters
  budgets.json      triangle / primitive / byte budgets, atlas budget, worst-case view scenarios
  atlas.json        atlas layout: tile regions (seamless materials), decals, palette
  make_atlas.py     builds the 2048 px atlas masters (albedo, normal, ARM, emissive) from atlas.json
  kit.py            Blender entry: builds one group (all pieces, all LODs), bakes AO, exports a GLB
  build-kit.mjs     atlas -> Blender -> KTX2 + gltfpack -> budget check -> public/models/kit
  preview.mjs       renders the packed kit with three.js (GLTFLoader + KTX2 + meshopt) in Chromium
  lib/bd_kit.py     atlas UVs, mesh accumulator, walls with openings, roofs, solids, AO, export
  lib/bd_kit_render.py   Eevee look-dev scenes for the review stills
  pieces/           one module per group: downtown, spanish, beach, industrial, pier, roadside,
                    rocks, beachprops, arena (build(spec, lod) and render(...))
  src/              AI sheets of the atlas (shop fronts, windows and doors, shop signs)
```

## Running it

```bash
npm --prefix tools ci                                   # once
npm --prefix tools run textures:fetch                   # Poly Haven sources (incl. the kit_* roles)
node tools/textures/generated/sources.mjs unpack <archive.tar>   # G1 sources (the cliff rock)
python3 tools/models/lib/make_env.py                    # only for --render (look-dev HDRI)
npm --prefix tools run kit                              # everything -> public/models/kit
node tools/models/buildings/build-kit.mjs --only=downtown --skip-atlas
node tools/models/buildings/build-kit.mjs --render=/tmp/kit --tag=v1   # + Eevee stills per group
npm --prefix tools run kit:preview -- --out=/tmp/kit    # three.js stills of the packed kit
```

Needs Python 3 with numpy and Pillow (atlas), Blender 5.2 LTS (`$BLENDER`, else
`/opt/homebrew/bin/blender` ...), Node 22. A full build takes about 35 s (most of it the KTX2 encode
of the 2048 px albedo); a group alone with `--skip-atlas` about 3 s. The build is deterministic:
running it again reproduces every file byte for byte (the unit test compares the hashes of
`public/models/kit/manifest.json`).

## Output (public/models/kit)

- `kit_<group>.glb`: root `kit_<group>`, one node per piece (name = piece id) with extras, one
  mesh child per LOD `<piece>_lod0..2`. Positions are quantised (gltfpack), UVs are floats
  (`-vtf`) so pieces can be merged without per-mesh texture transforms.
- `kit_atlas_{albedo,normal,arm,emissive}.ktx2`: the atlas, referenced by the GLBs' single material
  `kit_atlas` through `images[].uri` (gltfpack `-tr`), so every group shares one download and one
  GPU copy. glTF convention (no flipY), encoded with `tools/lib/ktx2.mjs` like the car textures:
  albedo 2048 ETC1S, normal 1024 UASTC, ARM 1024 ETC1S (R = AO, G = roughness, B = metalness,
  used as metallicRoughness and occlusion texture), emissive 512 ETC1S.
- `manifest.json`: per group file, bytes, hash, pieces with category, footprint, height and the
  triangles of every LOD; the atlas files; totals.

Piece extras: `kit_piece`, `group`, `category` (budget class), `footprint` {minX, maxX, minZ,
maxZ} in three.js metres (the `obox` collider), `height` (highest vertex of all LODs: collider
top), `overhang` (how far awnings, eaves, steps or canopies reach beyond the footprint),
`foundation` (depth below the ground the walls or piles reach, for sloped lots), `lods`,
`lod_distances` (switch distances in m, from kit.json per category) and `params` (the kit.json
parameters plus resolved variant choices).

## Conventions

- 1 unit = 1 m, Blender Z-up, exported Y-up (Blender -Y becomes three.js +Z).
- **Buildings**: origin on the ground at the middle of the street front; the front faces three.js
  +Z, the building extends to -Z. Footprint x = -width/2 .. +width/2, z = -depth .. 0. Walls go
  `foundation` metres below the ground so a lot on a slope (the design allows 2.5 m) never shows a
  gap. Frontage: downtown `bays` x 4 m, industrial `bays` x 6 m, spanish and beach `width`.
- **Linear props** (guardrail segment, pier segment, barriers, containers): run along +X from
  x = 0; traffic or visitor side faces three.js +Z. Guardrail segment 3.81 m with its post at
  x = 0 (the next segment brings the next post); the end terminal extends to -X (`start`) or +X
  (`finish`). Pier segments 10 x 9 m, deck top at the origin (map: y = 5), piles 14 m deep.
- **One material** `kit_atlas` for everything, one primitive per LOD: a chunk that merges all kit
  pieces costs one draw call. `COLOR_0` = tint (stucco, siding, cladding and container colours
  of the variant) x baked per-vertex ambient occlusion (ground plane included) x a light grime
  gradient near the ground. three.js multiplies it into the base colour.
- **Atlas tiles without wrap sampling**: tiling materials (stucco, brick, lap siding, corrugated
  sheet, roof tiles, deck planks, rock, gravel, concrete, roll-up shutter, container side, awning
  canvas) are square regions with wrapped padding; the geometry is cut at every texture period, so
  each face samples inside its region (tested per triangle). Coarse LODs double the period (fewer
  cuts). Decals (shop fronts, windows, doors, signs) map one element per opening; palette cells
  give flat PBR colours to small parts (frames, metals, lamps, paint).
- Seeds pick variants with an integer xorshift (`bd_kit.Rng`), never Python's `random`.

## Families and pieces (kit.json)

| Group | Pieces | Parameters | What varies per seed |
|---|---|---|---|
| downtown | 6 (3-6 bays, 2-3 storeys, one corner building) | bays, floors, depth, corner | brick or tinted stucco, shops per 1-2 bays (bakery, hardware, books) with sign boards, awnings (4 canvas colours), a street door to the upper floors, window type (6/6 sash, 1/1 with blind), paired or single windows, cornice, moulded window surrounds, roof units |
| spanish | 5 (10-16 m, 1-2 storeys, rectangle or L) | width, depth, floors, plan, garage | stucco tint, gable or hip roof, wing side, garage side, grilles, balcony |
| beach | 4 (8-11 m, 1-2 storeys, house or surf/fish shop) | width, depth, floors, shop | siding and roof colours, gable to the street or along it, window type, steps side, shop sign |
| industrial | 3 (24-48 m, 7-10 m eaves) | bays, depth, eave, dock | cladding and roof colours, sign (cannery / fish co.), side door, loading dock |
| pier | plain, lamp (lamps + bench), end | length, width, pile_depth, kind | - |
| roadside | guardrail segment, end terminals | kind, length, dir | - |
| rocks | 3 boulders, slab, 2 cliff blocks | size, shape, strata, seed | shape (fractal noise + strata) |
| beachprops | lifeguard tower, surfboard rack | kind, paint, seed | tower paint, board colours |
| arena | K-rail, water barriers (red, white), grandstand, floodlight mast, containers 20 ft (2) and 40 ft | kind, length, rows, height, color, seed | container colour |

The generators accept any parameter values; kit.json is the catalogue that gets exported. To add
a variant, add an entry with a new id and seed, run the build, look at the renders (`--render`) and
run `npm test`.

## LODs and budgets (budgets.json)

| Category | LOD0 | LOD1 | LOD2 | Switch distances |
|---|---|---|---|---|
| building | 4 000 | 2 500 | 600 | 60 / 180 m |
| landmark | 3 000 | 1 500 | 400 | 80 / 250 m |
| prop | 1 600 | 800 | 300 | 35 / 110 m |

LOD0 has recessed openings, sills, lintels, pilasters, cornices, awnings, grilles, rafter tails,
roof units, gutters and railings; LOD1 keeps the massing, shallow openings, awnings and signs;
LOD2 is the massing with flush openings on the atlas (design section 10, "Kisten mit Atlas").
One primitive per LOD, the coarsest LOD at most half of LOD0, at most 420 KB per group GLB and
1.8 MB for all groups, the atlas at most 1.7 MB with at least 80 px/m on every tile. Scenarios:
a Main Street view with 8/16/24 downtown buildings at LOD0/1/2 stays under 90 000 triangles, the
harbour with 3 halls per LOD under 15 000 (shares of the 500k tier low frame budget).

Today: all groups 1.48 MB, the atlas 1.04 MB; the largest pieces are the corner building
(3 116 / 2 162 / 532 triangles) and the L-shaped two-storey house (1 965 / 1 127 / 253).

## Tests

`tests/tools/models/buildingKit.test.ts` decodes the committed GLBs (meshopt) and checks: files
and hashes against the manifest, byte and triangle budgets, the scenarios, one primitive per LOD
and non-increasing LOD triangles, every piece of kit.json with its LODs, category, parameters and
LOD distances, the footprint and height extras against the vertex bounds of every LOD, the
frontage against the parameters (bays x 4 m / 6 m, width), UVs of every triangle inside one atlas
region, winding against the normals, faces on the footprint sides turned outwards, vertex colours
never black, the atlas layout (inside, no overlap, texel density) and the KTX2 headers.

## Review renders

`--render=<dir> --tag=<t>` writes Eevee stills per group (`<group>_<view>_<t>.png`) with the
Victoria Sunset HDRI (sun clamped out) and a sun lamp; `preview.mjs` renders the packed files the
way the game will load them. Every family went through at least two rounds of changes on these
renders (see docs/assets.md, "Gebäude-Kit").
