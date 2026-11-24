# Licences: textures

- `pbr/*`, `hdri/*`: Poly Haven (https://polyhaven.com), CC0 1.0. Authors per
  file in `manifest.json` (Rob Tuytel, Dimitrios Savva, Matterfield, Amal Kumar,
  Charlotte Baglioni, Greg Zaal, Jarod Guest). Thank you!
- `generated/*`: AI-generated (OpenAI image_gen via the Codex CLI) and
  post-processed by the project; not CC0. All shop names are invented.
  `generated/world_noise` is procedural.
- `biomes/*`, `billboards/*`, and `../ui/map-*.webp`: AI-generated via the
  Codex imagegen skill (`gpt-image-2`, prompts in `tools/textures/prompts/`),
  seamless-tiled and PBR-synthesized (`prep_refactor_pbr.py`) and encoded to
  KTX2/WebP by `tools/textures/build-refactor.mjs`; project-owned, not CC0.

Full provenance, prompts and pipeline: `docs/assets.md` in the repository.
