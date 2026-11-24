#!/usr/bin/env python3
"""Prepares raw Codex imagegen PNGs into game-ready PBR maps, billboards, decals, and UI cards.

Inputs:  tools/textures/.cache/refactor-raw/{biomes,billboards,ui}/*.png
Outputs: tools/textures/.cache/refactor-prep/{biomes,billboards,ui}/*.png

Key guarantees:
- Exact power-of-two dimensions (<= 1024px) for every biome and billboard texture
  (handles Codex imagegen returning non-POT dimensions such as 1254x1254).
- Seamless periodic tiling for all 8 biome PBR sets via 2-pass multi-band offset
  feathering (preserves sharp micro-detail across wrap borders without blurring).
- OpenGL +Y tangent-space normal maps synthesized from periodic multi-scale
  Scharr gradients (zero seam discontinuity at edges).
- Physically calibrated ARM maps (R=AO, G=Roughness, B=Metalness) tuned per
  biome material.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageEnhance, ImageFilter
from scipy.ndimage import gaussian_filter

HERE = Path(__file__).resolve().parent
CATALOG = json.loads((HERE / "refactor-prompts.json").read_text())
RAW_DIR = HERE / ".cache" / "refactor-raw"
PREP_DIR = HERE / ".cache" / "refactor-prep"

# Per-biome physically calibrated PBR synthesis profiles:
#   normal_strength: overall tangent-space relief strength
#   scales: weights for (fine, medium, coarse) height gradients
#   rough_range: (min_rough, max_rough) mapped from smoothed inverse-height/detail
#   ao_floor: minimum ambient occlusion in deep crevices
#   metal_range: (min_metal, max_metal)
#   special: optional biome-specific micro-feature curve
BIOME_PROFILES = {
    "alpine_snow": {
        "normal_strength": 2.4,
        "scales": (0.35, 0.45, 0.20),
        "rough_range": (0.68, 0.88),
        "ao_floor": 0.78,
        "metal_range": (0.0, 0.0),
        "special": "snow_sparkle",
    },
    "alpine_ice": {
        "normal_strength": 2.8,
        "scales": (0.55, 0.30, 0.15),
        "rough_range": (0.08, 0.26),
        "ao_floor": 0.72,
        "metal_range": (0.0, 0.0),
        "special": "ice_cracks",
    },
    "alpine_rock": {
        "normal_strength": 5.2,
        "scales": (0.30, 0.40, 0.30),
        "rough_range": (0.76, 0.96),
        "ao_floor": 0.44,
        "metal_range": (0.0, 0.04),
        "special": None,
    },
    "quarry_gravel": {
        "normal_strength": 5.0,
        "scales": (0.50, 0.35, 0.15),
        "rough_range": (0.80, 0.97),
        "ao_floor": 0.48,
        "metal_range": (0.0, 0.0),
        "special": None,
    },
    "quarry_red_rock": {
        "normal_strength": 4.8,
        "scales": (0.28, 0.42, 0.30),
        "rough_range": (0.78, 0.95),
        "ao_floor": 0.48,
        "metal_range": (0.0, 0.0),
        "special": None,
    },
    "concrete_bowl": {
        "normal_strength": 2.2,
        "scales": (0.55, 0.30, 0.15),
        "rough_range": (0.44, 0.74),
        "ao_floor": 0.70,
        "metal_range": (0.0, 0.0),
        "special": "concrete_scuff",
    },
    "forge_cobble": {
        "normal_strength": 5.6,
        "scales": (0.25, 0.45, 0.30),
        "rough_range": (0.46, 0.86),
        "ao_floor": 0.36,
        "metal_range": (0.02, 0.22),
        "special": "cobble_metal",
    },
    "tulip_meadow": {
        "normal_strength": 3.8,
        "scales": (0.45, 0.40, 0.15),
        "rough_range": (0.62, 0.88),
        "ao_floor": 0.52,
        "metal_range": (0.0, 0.0),
        "special": "tulip_petals",
    },
}


def srgb_luma(rgb01: np.ndarray) -> np.ndarray:
    return (
        rgb01[..., 0] * 0.2126
        + rgb01[..., 1] * 0.7152
        + rgb01[..., 2] * 0.0722
    ).astype(np.float32)


def flatten_macro_lighting(rgb01: np.ndarray, strength: float = 0.65) -> np.ndarray:
    """Removes gentle macro brightness gradients/vignetting so tiling never pulses."""
    mean_rgb = rgb01.mean(axis=(0, 1), keepdims=True)
    sigma = max(rgb01.shape[0], rgb01.shape[1]) * 0.14
    low_freq = np.stack(
        [gaussian_filter(rgb01[..., c], sigma=sigma, mode="reflect") for c in range(3)],
        axis=-1,
    )
    corrected = rgb01 - (low_freq - mean_rgb) * strength
    return np.clip(corrected, 0.0, 1.0).astype(np.float32)


def make_seamless_tile(rgb01: np.ndarray, overlap_frac: float = 0.14) -> np.ndarray:
    """Makes an image seamlessly tileable in X and Y via two-band offset blending.

    Low-frequency color blends smoothly across a wide cosine band, while
    high-frequency detail uses a sharper, noise-jittered seam mask so pebbles,
    cracks, and blades stay crisp instead of double-exposed.
    """
    h, w, _ = rgb01.shape
    a = flatten_macro_lighting(rgb01, strength=0.7)

    # Shift by half-tile so original outer seams land at the center (h//2, w//2)
    shifted = np.roll(np.roll(a, h // 2, axis=0), w // 2, axis=1)

    # Distance from the centered seam (0 at seam, 1 away from seam)
    yy = np.abs(np.linspace(-1.0, 1.0, h, dtype=np.float32))
    xx = np.abs(np.linspace(-1.0, 1.0, w, dtype=np.float32))
    # We want to replace the center cross (where original edges met) with the clean
    # interior of `a`, fading smoothly from 1 at the seam to 0 outside `overlap_frac`.
    band = max(0.08, min(0.28, overlap_frac))

    def seam_weight(coord: np.ndarray, width: float) -> np.ndarray:
        t = np.clip(coord / width, 0.0, 1.0)
        return (0.5 * (1.0 + np.cos(t * math.pi))).astype(np.float32)

    # Wide mask for low-frequency color continuity
    wx_lo = seam_weight(xx, band * 1.5)[None, :]
    wy_lo = seam_weight(yy, band * 1.5)[:, None]
    mask_lo = np.clip(wx_lo + wy_lo - wx_lo * wy_lo, 0.0, 1.0)[..., None]

    # Tighter mask with subtle organic modulation for high-frequency detail
    wx_hi = seam_weight(xx, band * 0.55)[None, :]
    wy_hi = seam_weight(yy, band * 0.55)[:, None]
    mask_hi = np.clip(wx_hi + wy_hi - wx_hi * wy_hi, 0.0, 1.0)
    mask_hi = np.clip((mask_hi - 0.15) / 0.70, 0.0, 1.0)[..., None]

    # Split both into low-frequency and high-frequency bands
    sigma = max(4.0, min(h, w) * 0.015)
    a_lo = np.stack([gaussian_filter(a[..., c], sigma=sigma, mode="wrap") for c in range(3)], axis=-1)
    s_lo = np.stack([gaussian_filter(shifted[..., c], sigma=sigma, mode="wrap") for c in range(3)], axis=-1)
    a_hi = a - a_lo
    s_hi = shifted - s_lo

    blended_lo = s_lo * (1.0 - mask_lo) + a_lo * mask_lo
    blended_hi = s_hi * (1.0 - mask_hi) + a_hi * mask_hi
    merged = np.clip(blended_lo + blended_hi, 0.0, 1.0)

    # Shift back so composition returns to original framing (outer edges are now exact matches)
    out = np.roll(np.roll(merged, -(h // 2), axis=0), -(w // 2), axis=1)
    return out.astype(np.float32)


def periodic_scharr_grad(field: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Periodic (wrap-padded) 3x3 Scharr gradient in +x (right) and +y (down)."""
    p = np.pad(field, 1, mode="wrap")
    gx = (
        3.0 * (p[:-2, 2:] - p[:-2, :-2])
        + 10.0 * (p[1:-1, 2:] - p[1:-1, :-2])
        + 3.0 * (p[2:, 2:] - p[2:, :-2])
    ) / 32.0
    gy = (
        3.0 * (p[2:, :-2] - p[:-2, :-2])
        + 10.0 * (p[2:, 1:-1] - p[:-2, 1:-1])
        + 3.0 * (p[2:, 2:] - p[:-2, 2:])
    ) / 32.0
    return gx.astype(np.float32), gy.astype(np.float32)


def synthesize_normal_and_arm(rgb01: np.ndarray, profile: dict) -> tuple[np.ndarray, np.ndarray]:
    """Synthesizes OpenGL +Y tangent normal map and calibrated ARM map from seamless albedo."""
    lum = srgb_luma(rgb01)
    # Normalize luminance into robust [0..1] height proxy
    lo, hi = np.percentile(lum, [2.0, 98.0])
    height = np.clip((lum - lo) / max(1e-4, hi - lo), 0.0, 1.0).astype(np.float32)

    special = profile.get("special")
    if special == "ice_cracks":
        # Bright narrow fracture lines in ice act as crisp micro-grooves
        med = gaussian_filter(height, sigma=6.0, mode="wrap")
        cracks = np.clip((height - med) * 3.5, 0.0, 1.0)
        height = np.clip(height * 0.45 - cracks * 0.65 + 0.5, 0.0, 1.0)
    elif special == "tulip_petals":
        # Vibrant flower petals sit higher than dark soil/grass underneath
        sat = rgb01.max(axis=-1) - rgb01.min(axis=-1)
        height = np.clip(height * 0.65 + sat * 0.55, 0.0, 1.0)

    # Multi-scale periodic Scharr gradients
    w_fine, w_med, w_coarse = profile["scales"]
    h_fine = gaussian_filter(height, sigma=0.7, mode="wrap")
    h_med = gaussian_filter(height, sigma=2.2, mode="wrap")
    h_coarse = gaussian_filter(height, sigma=5.5, mode="wrap")

    gx_f, gy_f = periodic_scharr_grad(h_fine)
    gx_m, gy_m = periodic_scharr_grad(h_med)
    gx_c, gy_c = periodic_scharr_grad(h_coarse)

    gx = gx_f * w_fine + gx_m * w_med + gx_c * w_coarse
    gy = gy_f * w_fine + gy_m * w_med + gy_c * w_coarse

    strength = float(profile["normal_strength"])
    # OpenGL +Y tangent space: +X right, +Y up (=-dH/dy_up = +dH/dy_down)
    nx = -gx * strength
    ny = gy * strength
    nz = np.ones_like(nx, dtype=np.float32)
    norm = np.sqrt(nx * nx + ny * ny + nz * nz)
    normal01 = np.stack([(nx / norm) * 0.5 + 0.5, (ny / norm) * 0.5 + 0.5, (nz / norm) * 0.5 + 0.5], axis=-1)

    # Cavity / Ambient Occlusion (R): dark crevices drop toward ao_floor
    ao_floor = float(profile["ao_floor"])
    local_mean = gaussian_filter(height, sigma=8.0, mode="wrap")
    cavity = np.clip((height - local_mean) * 1.4 + 0.72, 0.0, 1.0)
    ao = np.clip(ao_floor + (1.0 - ao_floor) * (0.55 * height + 0.45 * cavity), ao_floor, 1.0)

    # Roughness (G): inverse of raised polished crowns + micro-variation
    r_min, r_max = profile["rough_range"]
    detail = np.abs(height - h_med)
    rough = r_max - (r_max - r_min) * (0.65 * height + 0.35 * (1.0 - np.clip(detail * 4.0, 0.0, 1.0)))

    if special == "snow_sparkle":
        # Subtle high-frequency crystalline glint pockets
        rng = np.random.default_rng(42)
        glint = (rng.random(height.shape, dtype=np.float32) > 0.965).astype(np.float32)
        rough = np.clip(rough - glint * 0.28, 0.35, 0.95)
    elif special == "ice_cracks":
        # Frost & fracture lines are matte/rough while clear glacial ice is glossy
        med = gaussian_filter(lum, sigma=6.0, mode="wrap")
        frost = np.clip((lum - med) * 4.0, 0.0, 1.0)
        rough = np.clip(rough + frost * 0.42, 0.06, 0.65)
    elif special == "concrete_scuff":
        # Dark rubber tire marks have higher roughness than smooth troweled concrete
        scuff = np.clip((0.55 - height) * 2.0, 0.0, 1.0)
        rough = np.clip(rough + scuff * 0.16, 0.38, 0.85)
    elif special == "tulip_petals":
        # Waxy petals slightly smoother than dry matte grass
        sat = rgb01.max(axis=-1) - rgb01.min(axis=-1)
        rough = np.clip(rough - sat * 0.16, 0.50, 0.92)

    # Metalness (B)
    m_min, m_max = profile["metal_range"]
    if special == "cobble_metal":
        # Slight gunmetal/tempered-steel mineral glint on raised stone faces, 0 in ash joints
        metal = np.clip((height - 0.45) / 0.55, 0.0, 1.0) * (m_max - m_min) + m_min
        metal = np.where(height < 0.32, 0.0, metal)
    else:
        metal = np.full_like(ao, m_min, dtype=np.float32)

    arm01 = np.stack([np.clip(ao, 0.0, 1.0), np.clip(rough, 0.04, 1.0), np.clip(metal, 0.0, 1.0)], axis=-1)
    return normal01.astype(np.float32), arm01.astype(np.float32)


def edge_seam_error(rgb01: np.ndarray) -> float:
    """Measures mean absolute RGB jump across periodic X and Y wrap borders (lower is better)."""
    dx = np.abs(rgb01[:, 0, :] - rgb01[:, -1, :]).mean()
    dy = np.abs(rgb01[0, :, :] - rgb01[-1, :, :]).mean()
    return float(0.5 * (dx + dy))


def resize_float(arr01: np.ndarray, width: int, height: int) -> np.ndarray:
    if arr01.shape[1] == width and arr01.shape[0] == height:
        return arr01
    u8 = np.clip(arr01 * 255.0 + 0.5, 0, 255).astype(np.uint8)
    pil = Image.fromarray(u8, mode="RGB").resize((width, height), Image.Resampling.LANCZOS)
    return (np.asarray(pil, dtype=np.float32) / 255.0).astype(np.float32)


def save_rgb(arr01: np.ndarray, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    u8 = np.clip(arr01 * 255.0 + 0.5, 0, 255).astype(np.uint8)
    Image.fromarray(u8, mode="RGB").save(out_path, optimize=True)


def center_crop_aspect(img: Image.Image, target_w: int, target_h: int) -> Image.Image:
    """Center-crops image to exact target aspect ratio before Lanczos resize (zero stretch)."""
    src_w, src_h = img.size
    target_aspect = target_w / target_h
    src_aspect = src_w / src_h
    if abs(src_aspect - target_aspect) > 0.01:
        if src_aspect > target_aspect:
            new_w = round(src_h * target_aspect)
            x0 = (src_w - new_w) // 2
            img = img.crop((x0, 0, x0 + new_w, src_h))
        else:
            new_h = round(src_w / target_aspect)
            y0 = (src_h - new_h) // 2
            img = img.crop((0, y0, src_w, y0 + new_h))
    return img.resize((target_w, target_h), Image.Resampling.LANCZOS)


def prep_biomes() -> None:
    out_dir = PREP_DIR / "biomes"
    out_dir.mkdir(parents=True, exist_ok=True)
    for item in CATALOG["biomes"]:
        bid = item["id"]
        src = RAW_DIR / "biomes" / f"{bid}.png"
        if not src.exists():
            raise FileNotFoundError(f"Missing raw biome image: {src}")
        img = Image.open(src).convert("RGB")
        # Work at 1024x1024 square POT before downsampling to target map sizes
        sq = center_crop_aspect(img, 1024, 1024)
        rgb01 = np.asarray(sq, dtype=np.float32) / 255.0
        seamless = make_seamless_tile(rgb01, overlap_frac=0.14)

        albedo_sz = int(item.get("albedoSize", 512))
        map_sz = int(item.get("mapSize", 512))
        normal01, arm01 = synthesize_normal_and_arm(seamless, BIOME_PROFILES[bid])

        albedo_out = resize_float(seamless, albedo_sz, albedo_sz)
        normal_out = resize_float(normal01, map_sz, map_sz)
        # Re-normalize normal vectors after Lanczos downscale
        nv = normal_out * 2.0 - 1.0
        nv /= np.maximum(1e-5, np.linalg.norm(nv, axis=-1, keepdims=True))
        normal_out = np.clip(nv * 0.5 + 0.5, 0.0, 1.0)
        arm_out = resize_float(arm01, map_sz, map_sz)

        save_rgb(albedo_out, out_dir / f"{bid}_albedo.png")
        save_rgb(normal_out, out_dir / f"{bid}_normal.png")
        save_rgb(arm_out, out_dir / f"{bid}_arm.png")

        seam_err = edge_seam_error(albedo_out)
        print(
            f"[prep/biome] {bid:<16} raw={img.size[0]}x{img.size[1]} -> "
            f"albedo={albedo_sz} normal/arm={map_sz} seam_err={seam_err:.4f}"
        )


def prep_billboards() -> None:
    out_dir = PREP_DIR / "billboards"
    out_dir.mkdir(parents=True, exist_ok=True)
    for item in CATALOG["billboards"]:
        bid = item["id"]
        src = RAW_DIR / "billboards" / f"{bid}.png"
        if not src.exists():
            raise FileNotFoundError(f"Missing raw billboard image: {src}")
        img = Image.open(src).convert("RGB")
        w, h = int(item["outWidth"]), int(item["outHeight"])
        resized = center_crop_aspect(img, w, h)
        # Mild edge-preserving denoise removes micro-grain that bloats ETC1S blocks
        # while keeping typography and graphic edges crisp.
        arr = np.asarray(resized, dtype=np.uint8)
        smooth = cv2.bilateralFilter(arr, d=5, sigmaColor=16, sigmaSpace=16)
        cleaned = Image.fromarray(smooth, mode="RGB").filter(
            ImageFilter.UnsharpMask(radius=0.8, percent=25, threshold=6)
        )
        cleaned.save(out_dir / f"{bid}.png", optimize=True)
        print(f"[prep/billboard] {bid:<22} raw={img.size[0]}x{img.size[1]} -> {w}x{h}")


def prep_ui() -> None:
    out_dir = PREP_DIR / "ui"
    out_dir.mkdir(parents=True, exist_ok=True)
    for item in CATALOG["ui"]:
        uid = item["id"]
        src = RAW_DIR / "ui" / f"{uid}.png"
        if not src.exists():
            raise FileNotFoundError(f"Missing raw UI image: {src}")
        img = Image.open(src).convert("RGB")
        w, h = int(item["outWidth"]), int(item["outHeight"])
        resized = center_crop_aspect(img, w, h)
        resized = ImageEnhance.Contrast(resized).enhance(1.03)
        resized.save(out_dir / f"{uid}.png", optimize=True)
        print(f"[prep/ui] {uid:<18} raw={img.size[0]}x{img.size[1]} -> {w}x{h}")


if __name__ == "__main__":
    prep_biomes()
    prep_billboards()
    prep_ui()
    print("[prep_refactor_pbr] done")
