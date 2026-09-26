# Building kit (tools/models/buildings)

Procedural Blender kit of the buildings and props of the curated map Bulli Bay (phase 3,
`docs/phase-3-design.md`), in the realistic look of the G1 world: four building families (Main
Street in four styles), five landmarks, the pier, guardrails, cliff and rock blocks, beach props
and the elements of the party arena. Every piece is parametric (width or bays, storeys, depth,
seed) and exported with three LODs into one meshopt GLB per group; all groups share one KTX2
texture atlas. The game loads it since phase 3 M4 (`src/client/world/kit.ts`) and merges the
pieces per cell and LOD (`kitCells.ts`, `mapWorld.ts`).

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
  pieces/           one module per family: downtown (groups downtown and downtown_revival),
                    spanish, beach, industrial, pier, roadside, rocks, beachprops, landmarks,
                    arena (build(spec, lod) and render(...))
  src/              AI sheets of the atlas (shop fronts, windows and doors, two sheets of signs)
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
  each face samples inside its region (tested per triangle). Every LOD keeps the same period, so a
  LOD switch never changes the texel density (tested per tile region). Decals (shop fronts, windows, doors, signs) map one element per opening; palette cells
  give flat PBR colours to small parts (frames, metals, lamps, paint).
- Seeds pick variants with an integer xorshift (`bd_kit.Rng`), never Python's `random`.

## Families and pieces (kit.json)

| Group | Pieces | Parameters | What varies per seed |
|---|---|---|---|
| downtown | 7 (3-6 bays, 1-3 storeys, one corner building): 2 brick, 5 stucco | bays, floors, depth, style, corner | style `brick` (older blocks: brick, sash windows, cornice) or `stucco` (tinted stucco, moulded surrounds, cornice); shops per 1-2 bays with sign boards (4 fronts, 11 trades: bakery, hardware, books, coffee, taqueria, ice cream, cycles, realty, tackle, surf, diner; neighbours differ), awnings (4 canvas colours), a street door to the upper floors, window type, paired or single windows, roof units |
| downtown_revival | 7 (2-5 bays, 1-3 storeys, one corner building): 3 mission, 4 deco | as downtown | style `mission` (Mission / Spanish Colonial Revival: lime-white stucco, arched windows and door, clay tile pent roof along the parapet, curved central parapet) or `deco` (Art Deco / Streamline: pastel stucco, accent-coloured pilaster fins at the bay lines rising above a stepped central parapet, three speed lines) |
| spanish | 5 (10-16 m, 1-2 storeys, rectangle or L) | width, depth, floors, plan, garage | stucco tint, gable or hip roof, wing side, garage side, grilles, balcony |
| beach | 4 (8-11 m, 1-2 storeys, house or surf/fish shop) | width, depth, floors, shop | siding and roof colours, gable to the street or along it, window type, steps side, shop sign |
| industrial | 3 (24-48 m, 7-10 m eaves) | bays, depth, eave, dock | cladding and roof colours, sign (cannery / fish co.), side door, loading dock |
| pier | plain, lamp (lamps + bench), end | length, width, pile_depth, kind | - |
| roadside | guardrail segment, end terminals | kind, length, dir | - |
| rocks | 3 boulders, slab, 2 cliff blocks | size, shape, strata, seed | shape (fractal noise + strata) |
| beachprops | lifeguard tower, surfboard rack | kind, paint, seed | tower paint, board colours |
| landmarks | lighthouse (18 m tapered tower, gallery, lantern), water tower (tank on four braced legs), Streamline diner ("BULLI'S DINER" roof sign), 1950s gas station (canopy with "SEASIDE SERVICE" fascia, pumps, office with service bay, pylon sign), quay crane (slewing jib crane on an 8 x 8 m caisson, lattice jib 20 m out over the water at the front) | kind, seed | diner tint, tower paint |
| arena | K-rail, water barriers (red, white), grandstand, floodlight mast, containers 20 ft (2) and 40 ft | kind, length, rows, height, color, seed | container colour |

The generators accept any parameter values; kit.json is the catalogue that gets exported. To add
a variant, add an entry with a new id and seed, run the build, look at the renders (`--render`) and
run `npm test`.

## LODs and budgets (budgets.json)

| Category | LOD0 | LOD1 | LOD2 | Switch distances |
|---|---|---|---|---|
| building | 4 000 | 2 500 | 1 000 | 60 / 180 m |
| landmark | 3 000 | 1 500 | 400 | 80 / 250 m |
| prop | 1 600 | 800 | 300 | 35 / 110 m |

LOD0 has recessed openings, sills, lintels, pilasters, cornices, awnings, grilles, rafter tails,
roof units, gutters and railings; LOD1 keeps the massing, shallow openings, awnings and signs;
LOD2 is the massing with flush openings on the atlas (design section 10, "Kisten mit Atlas").
Every LOD keeps the texel density of LOD0 (a coarser texture period made brick twice as coarse
at LOD2, visible when the LOD switches); the cuts at the texture periods therefore stay, which is
why the LOD2 budget of a building is 1 000 triangles and the coarsest LOD may keep 60 % of LOD0
(the plain halls: their LOD0 has few details to drop). Pieces whose LOD0 already fits the
coarsest LOD's budget (small landmarks and props) are exempt from the fraction. One primitive per
LOD, at most 440 KB per group GLB and 2.4 MB for all groups, the atlas at most 1.7 MB with at
least 80 px/m on every tile. Scenarios: a Main Street view with 8/16/24 buildings of one downtown
group at LOD0/1/2 stays under 90 000 triangles (today 81 000 and 68 000), the harbour with 3 halls
per LOD under 15 000 (shares of the 500k tier low frame budget).

Today: 11 groups, 52 pieces, all groups 2.06 MB, the atlas 1.03 MB; the largest pieces are the
brick corner building (3 104 / 2 116 / 940 triangles) and the deco corner building
(2 016 / 1 790 / 984).

**Per-piece LODs and chunk merging.** The chunk builder (M4) merges the kit pieces of a 250 m
chunk into one mesh; after the merge a piece can no longer switch its own LOD. Until the three.js
upgrade (M2) brings `BatchedMesh` with per-instance LODs, the builder merges per LOD level into
sub-cells of 62.5 m (16 per chunk) and switches the sub-cell as a whole at the category
distances; the per-piece distances in the extras are the input for that. Decided in the design
(A41).

**Signs.** 14 sign boards (two AI sheets) share the sign column of the atlas in slots of
256 x 63 px (about 66 px/m on a 3.8 m board, half of the six 512 px signs before; readable from
the street, soft from the sidewalk). Two slots are free. A sign per instance (UV swap by the
chunk builder) would lift the repetition further; today every piece carries its own shops.

**Vegetation (next group, not built yet).** Palms (Mexican fan and Canary Island date), Monterey
cypress, coast live oak and chaparral shrubs need alpha-tested foliage cards: a second material
`kit_foliage` (alpha test, double-sided) with its own atlas of frond and leaf cards (the G1 palm
fronds in `tools/textures/.cache/gen-work/world/tex` are a start) and trunks on the kit atlas. The
single-material rule of the kit holds per material, so a chunk costs two draw calls. Planned as
the next kit step together with the scatter of design section 11.2.

## Tests

`tests/tools/models/buildingKit.test.ts` decodes the committed GLBs (meshopt) and checks: files
and hashes against the manifest, byte and triangle budgets, the scenarios, one primitive per LOD
and non-increasing LOD triangles, every piece of kit.json with its LODs, category, parameters and
LOD distances, the footprint and height extras against the vertex bounds of every LOD, the
frontage against the parameters (bays x 4 m / 6 m, width), UVs of every triangle inside one atlas
region, winding against the normals, faces on the footprint sides turned outwards, vertex colours
never black, the atlas layout (inside, no overlap, texel density) and the KTX2 headers.

## Review renders

`--render=<dir> --tag=<t>` writes Eevee stills per group (`<group>_<view>_<t>.png`) under a
physical sky (Blender Sky Texture, multiple scattering, sea level, light marine haze, no landscape
in the background) and a warm sun lamp; the Victoria Sunset HDRI of the earlier rounds put Lion's
Head (Cape Town) behind every still and is still available with `BD_KIT_SKY=victoria`; `preview.mjs` renders the packed files the
way the game will load them. Every family went through at least two rounds of changes on these
renders (see docs/assets.md, "Gebäude-Kit").
