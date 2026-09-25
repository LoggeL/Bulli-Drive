# Textures (tools/textures)

World textures and HDRIs for the realistic look. Sources are downloaded (CC0,
Poly Haven) or were generated once with an image model; the game only gets
compressed results in `public/textures`. Full-resolution sources are not in
git: `fetch.mjs` downloads them again, byte-identical (md5-checked).

```
tools/textures/
  textures.json   what to fetch and encode: Poly Haven PBR sets (albedo, normal,
                  ARM = AO/roughness/metalness), HDRIs, generated textures, sizes
  fetch.mjs       downloads the CC0 sources into .cache (skips files that are there)
  build.mjs       KTX2-encodes into public/textures + manifest.json (incremental)
  generated/      how the AI textures were made: prompts/, gen.sh (Codex imagegen),
                  prep/ (keying, seamless wrap, atlas packing; Python + Pillow),
                  sources.mjs + sources.json (archive of the raw images)
../lib/ktx2.mjs   the KTX2 encoder settings shared with tools/models
```

```bash
npm --prefix tools ci
npm --prefix tools run textures          # fetch + build
node tools/textures/build.mjs --force    # re-encode everything
```

## Output

- `public/textures/pbr/<material>_<albedo|normal|arm>.ktx2`: asphalt,
  sidewalk, stucco, roof_tiles, roof_gravel, grass, grass_dry, sand. Real
  tile size per material in the manifest (`tileMeters`). `asphalt_clean` is
  fetched for the Blender look-dev only (`"publish": []`).
- `public/textures/generated/*.ktx2` (+ the tree card sidecar with the atlas
  rects, which `tests/client/worldTextures.test.ts` holds against
  `TREE_UV` in `vegetation.ts`): facade bands with a tint mask in alpha,
  storefront atlas (diner, surf shop, gas station) with emissive map, rock,
  palm trunk and fronds, fan palm fronds, tree cards (oak, cypress), shrubs,
  macro noise. The same test fails when a shipped texture is not requested
  by the client or a requested one is missing (the street sign atlas and the
  diner interior were dropped for that reason).
- `public/textures/hdri/*.hdr`: Victoria Sunset (IBL/reflections) and
  Qwantani Sunset Pure Sky (sky), both 1k Radiance files, loaded with three's
  HDRLoader (r160's KTX2Loader could not read UASTC HDR). `fetch.mjs` also downloads Victoria at 2k
  for the Blender look-dev renders. The game server sends them Brotli or
  gzip compressed with a content ETag (`src/server/staticAssets.ts`); the
  hashed KTX2 and GLB URLs (`?v=<hash>`) are cached for a year.
- `public/textures/manifest.json`: per texture file, kind, size, encoding,
  bytes, hashes; per PBR material its maps, tile size, authors and source.

## Encoding

| kind | used for | encoding | three.js colour space |
|---|---|---|---|
| `color` | albedo, emissive, decals | ETC1S (BasisLZ), sRGB transfer | sRGB (from the KTX2 header) |
| `data` | ARM, noise | ETC1S, linear | none |
| `normal` | normal maps (OpenGL, +Y) | UASTC + RDO + Zstandard | none |

Textures of 128 px and less always use UASTC. All files have full mip chains.
Every standalone KTX2 is encoded with **flipY**, so it samples exactly like
the same JPG/PNG loaded by `THREE.TextureLoader` (flipY = true); compressed
textures cannot be flipped at upload time. Load them with the page's single
`KTX2Loader` (`getKTX2Loader` in `src/client/assets/gltfLoader.ts`).

## Generated textures

The AI textures (Codex CLI, imagegen skill with OpenAI's `image_gen`) have no
public source to download again, and a new generation never gives the same
image. Their KTX2 files in `public/textures/generated` are the canonical
copies; `build.mjs` keeps them when the prepared source is not in
`.cache/generated/`.

The raw generations and the prepared sources (55 files, 71 MB: too large for
git) are kept in one tar archive outside the repository.
`generated/sources.json` (in git) lists every file with its SHA-256:

```bash
# where the archive lies: ~/.cache/bulli-drive/generated-sources-v1.tar on the
# machine that built G1 (archive sha256 9217a3cb…a85f). Copy it to durable
# storage (e.g. a GitHub release asset) and point BD_GEN_SOURCES at it.
node tools/textures/generated/sources.mjs unpack <archive.tar | https URL>
#   -> tools/textures/.cache/gen-work, verified file by file; that is the
#      prep scripts' default BD_GEN_ROOT
node tools/textures/generated/sources.mjs pack <gen-root> <out.tar>
#   after new generations: rewrites sources.json and the archive
```

To change one texture: unpack the archive, generate a new raw image with
`generated/gen.sh <prompt> <out.png>` into the work tree, prepare it with the
script in `generated/prep/` (layout `assets/gen/raw`, `assets/facade`,
`assets/decals`, `world/gen/raw`, `world/tex`), then
`node tools/textures/build.mjs --import-generated=tools/textures/.cache/gen-work/world/tex`
and pack a new archive version.
Licensing and the brand rules (invented shop names only) are in
[docs/assets.md](../../docs/assets.md).
