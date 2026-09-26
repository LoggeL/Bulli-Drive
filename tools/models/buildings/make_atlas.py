# Builds the shared texture atlas of the building kit from atlas.json (2048 px masters):
#   albedo (sRGB), normal (OpenGL, +Y), arm (R = AO, G = roughness, B = metalness), emissive.
#
#   python3 tools/models/buildings/make_atlas.py            -> tools/models/.out/kit/atlas/*.png
#
# Inputs (see atlas.json "_doc"):
#   tools/textures/.cache/polyhaven/<role>/<role>_{albedo,normal,arm}_1k.jpg
#       npm --prefix tools run textures:fetch (the kit_* roles are fetched with publish: [])
#   $BD_GEN_ROOT/world/tex/rock_{albedo,normal}_1k.jpg   (the G1 cliff rock)
#       node tools/textures/generated/sources.mjs unpack <archive>  (default BD_GEN_ROOT)
#   tools/models/buildings/src/kit_*.jpg                  (AI sheets, committed)
# Needs Python 3 with numpy and Pillow. Deterministic: same inputs -> same PNG bytes.
import json
import os
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.dirname(HERE)
TOOLS = os.path.dirname(MODELS)
CACHE = os.path.join(TOOLS, "textures", ".cache")
GEN_ROOT = os.environ.get("BD_GEN_ROOT", os.path.join(CACHE, "gen-work"))
OUT = os.path.join(MODELS, ".out", "kit", "atlas")
SPEC = json.load(open(os.path.join(HERE, "atlas.json")))
N = SPEC["size"]

FLAT_NORMAL = np.array([0.5, 0.5, 1.0], np.float32)


def load(path, mode="RGB"):
    if not os.path.exists(path):
        raise SystemExit("missing %s (see the header of make_atlas.py)" % path)
    return np.asarray(Image.open(path).convert(mode), np.float32) / 255.0


def resize(a, w, h):
    """float image -> (h, w) with Lanczos, per channel in 16 bit to keep precision"""
    chans = []
    for c in range(a.shape[2]):
        im = Image.fromarray(np.clip(a[..., c] * 65535.0 + 0.5, 0, 65535).astype(np.uint16))
        im = im.convert("I").resize((w, h), Image.LANCZOS)
        chans.append(np.asarray(im, np.float32) / 65535.0)
    return np.clip(np.stack(chans, -1), 0.0, 1.0)


def source_maps(src):
    """{"albedo", "normal", "arm"} float arrays of a tile source"""
    kind, _, name = src.partition(":")
    if kind == "polyhaven":
        d = os.path.join(CACHE, "polyhaven", name)
        return {m: load(os.path.join(d, "%s_%s_1k.jpg" % (name, m))) for m in ("albedo", "normal", "arm")}
    if kind == "g1" and name == "rock":
        t = os.path.join(GEN_ROOT, "world", "tex")
        alb = load(os.path.join(t, "rock_albedo_1k.jpg"))
        arm = np.stack([np.ones(alb.shape[:2], np.float32), np.full(alb.shape[:2], 0.9, np.float32),
                        np.zeros(alb.shape[:2], np.float32)], -1)
        return {"albedo": alb, "normal": load(os.path.join(t, "rock_normal_1k.jpg")), "arm": arm}
    raise SystemExit("unknown tile source " + src)


def rotate_ccw(maps):
    """rotate a PBR set by 90 deg counter-clockwise (boards vertical -> horizontal); the normal
    vector turns with the image: (x, y) -> (-y, x)"""
    out = {m: np.ascontiguousarray(np.rot90(a, 1)) for m, a in maps.items()}
    n = out["normal"].copy()
    out["normal"][..., 0] = 1.0 - n[..., 1]
    out["normal"][..., 1] = n[..., 0]
    return out


def neutralize(albedo, target):
    """albedo -> neutral grey with the source's luminance detail, mean `target` (tinted per vertex)"""
    lum = albedo @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    lum = lum * (target / max(1e-4, float(lum.mean())))
    return np.repeat(np.clip(lum, 0, 1)[..., None], 3, -1)


def stripes(colors, w, h):
    """awning canvas: vertical stripes (period = content width), weave noise, faded top"""
    rng = np.random.default_rng(7)
    a = np.zeros((h, w, 3), np.float32)
    c0 = np.array([int(colors[0][i:i + 2], 16) for i in (1, 3, 5)], np.float32) / 255
    c1 = np.array([int(colors[1][i:i + 2], 16) for i in (1, 3, 5)], np.float32) / 255
    x = (np.arange(w) + 0.5) / w
    band = ((x * 4) % 1.0) < 0.5
    a[:] = np.where(band[None, :, None], c0, c1)
    weave = 1.0 + 0.035 * np.sin(np.arange(w) * 2.1)[None, :, None] * np.sin(np.arange(h) * 1.9)[:, None, None]
    noise = 1.0 + 0.03 * rng.standard_normal((h, w, 1)).astype(np.float32)
    fade = 1.0 + 0.06 * np.linspace(1, 0, h, dtype=np.float32)[:, None, None]
    return np.clip(a * weave * noise * fade, 0, 1)


def wrap_pad(a, pad):
    return np.pad(a, ((pad, pad), (pad, pad), (0, 0)), mode="wrap")


def edge_pad(a, pad):
    return np.pad(a, ((pad, pad), (pad, pad), (0, 0)), mode="edge")


def hexrgb(h):
    return np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)], np.float32) / 255


def main():
    alb = np.zeros((N, N, 3), np.float32) + 0.5
    nrm = np.zeros((N, N, 3), np.float32) + FLAT_NORMAL
    arm = np.zeros((N, N, 3), np.float32)
    arm[..., 0] = 1.0
    arm[..., 1] = 0.8
    emi = np.zeros((N, N, 3), np.float32)

    def put(target, rect, block):
        x, y, w, h = rect
        target[y:y + h, x:x + w] = block[:h, :w]

    for name, t in SPEC["tiles"].items():
        x, y, w, h = t["rect"]
        pad = t["pad"]
        cw, ch = w - 2 * pad, h - 2 * pad
        if t["source"] == "procedural:stripes":
            a = stripes(t["colors"], cw, ch)
            maps = {"albedo": a, "normal": np.zeros_like(a) + FLAT_NORMAL,
                    "arm": np.stack([np.ones(a.shape[:2]), np.full(a.shape[:2], 0.85), np.zeros(a.shape[:2])], -1).astype(np.float32)}
        else:
            src = source_maps(t["source"])
            if t.get("rotate"):
                src = rotate_ccw(src)
            r = t.get("repeat", 1)
            maps = {}
            for m, a in src.items():
                one = resize(a, cw // r, ch // r)
                maps[m] = np.tile(one, (r, r, 1))
                if maps[m].shape[0] != ch or maps[m].shape[1] != cw:
                    maps[m] = resize(maps[m], cw, ch)
            if "neutral" in t:
                maps["albedo"] = neutralize(maps["albedo"], t["neutral"])
            if "gain" in t:
                maps["albedo"] = np.clip(maps["albedo"] * t["gain"], 0, 1)
        put(alb, t["rect"], wrap_pad(maps["albedo"], pad))
        put(nrm, t["rect"], wrap_pad(maps["normal"], pad))
        put(arm, t["rect"], wrap_pad(maps["arm"], pad))

    sheets = {}
    for name, d in SPEC["decals"].items():
        x, y, w, h = d["rect"]
        pad = d["pad"]
        cw, ch = w - 2 * pad, h - 2 * pad
        src = d["source"].split(":", 1)[1]
        if src not in sheets:
            sheets[src] = load(os.path.join(HERE, "src", src))
        x0, y0, x1, y1 = d["crop"]
        a = resize(sheets[src][y0:y1, x0:x1], cw, ch)
        put(alb, d["rect"], edge_pad(a, pad))
        rough = np.full((h, w), d.get("rough", 0.5), np.float32)
        metal = np.full((h, w), d.get("metal", 0.0), np.float32)
        put(arm, d["rect"], np.stack([np.ones((h, w), np.float32), rough, metal], -1))
        if d.get("emissive"):
            lum = a @ np.array([0.2126, 0.7152, 0.0722], np.float32)
            k = np.clip((lum - 0.62) / 0.3, 0, 1) ** 2 * d["emissive"]
            put(emi, d["rect"], edge_pad(a * k[..., None], pad))

    p = SPEC["palette"]
    px, py, pw, ph = p["rect"]
    cell = p["cell"]
    cols = pw // cell
    for i, (name, col, rough, metal, emit) in enumerate(p["colors"]):
        cx, cy = px + (i % cols) * cell, py + (i // cols) * cell
        c = hexrgb(col)
        alb[cy:cy + cell, cx:cx + cell] = c
        arm[cy:cy + cell, cx:cx + cell] = (1.0, rough, metal)
        if emit:
            emi[cy:cy + cell, cx:cx + cell] = c * emit

    os.makedirs(OUT, exist_ok=True)
    for name, a in (("albedo", alb), ("normal", nrm), ("arm", arm), ("emissive", emi)):
        path = os.path.join(OUT, "kit_atlas_%s.png" % name)
        Image.fromarray(np.clip(a * 255.0 + 0.5, 0, 255).astype(np.uint8), "RGB").save(path, optimize=False, compress_level=6)
        print("ATLAS", name, path, os.path.getsize(path))


if __name__ == "__main__":
    main()
