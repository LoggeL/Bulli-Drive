#!/bin/zsh
# Generates one texture image with the Codex CLI imagegen skill (OpenAI image_gen tool).
#   tools/textures/generated/gen.sh <prompt-name> <out.png>
# The prompt is read from prompts/<prompt-name>.txt. The raw image is then prepared with the
# scripts in prep/ (keying, seamless wrap, atlas packing) and encoded by tools/textures/build.mjs.
set -eu
name=$1
out=$2
here=${0:A:h}
wd=$(mktemp -d)
prompt=$(cat "$here/prompts/$name.txt")
codex=${CODEX:-/Applications/ChatGPT.app/Contents/Resources/codex}
"$codex" exec --skip-git-repo-check -C "$wd" "Use the imagegen skill (built-in image_gen tool) to generate ONE image: $prompt After generating, copy the resulting PNG to $out and print its final path."
