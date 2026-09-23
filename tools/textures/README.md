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
                  prep/ (keying, seamless wrap, atlas packing; Python + Pillow)
../lib/ktx2.mjs   the KTX2 encoder settings shared with tools/models
```

```bash
npm --prefix tools ci
npm --prefix tools run textures          # fetch + build
node tools/textures/build.mjs --force    # re-encode everything
```

## Output

- `public/textures/pbr/<material>_<albedo|normal|arm>.ktx2`: asphalt,
  asphalt_clean, sidewalk, stucco, roof_tiles, roof_gravel, grass, grass_dry,
  sand. Real tile size per material in the manifest (`tileMeters`).
- `public/textures/generated/*.ktx2` (+ JSON sidecars with atlas rects):
  facade bands with a tint mask in alpha, storefront atlas (diner, surf shop,
  gas station) with emissive map, diner interior, rock, palm trunk and fronds,
  fan palm fronds, tree cards (oak, cypress), shrubs, street sign atlas,
  macro noise.
- `public/textures/hdri/*.hdr`: Victoria Sunset (IBL/reflections) and
  Qwantani Sunset Pure Sky (sky), both 1k Radiance files; three r160's
  KTX2Loader cannot read UASTC HDR. `fetch.mjs` also downloads Victoria at 2k
  for the Blender look-dev renders.
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
public source to download again. Their KTX2 files in
`public/textures/generated` are the canonical copies; `build.mjs` keeps them
when the prepared source is not in `.cache/generated/`. To change one:
generate a new raw image with `generated/gen.sh <prompt> <out.png>`, prepare
it with the script in `generated/prep/` (set `BD_GEN_ROOT` to a work tree
with the layout `assets/gen/raw`, `assets/facade`, `assets/decals`,
`world/gen/raw`, `world/tex`), then
`node tools/textures/build.mjs --import-generated=<work tree>/world/tex`.
Licensing and the brand rules (invented shop names only) are in
[docs/assets.md](../../docs/assets.md).
