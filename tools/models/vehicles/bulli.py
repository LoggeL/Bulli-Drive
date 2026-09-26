# Bulli Drive -- realistic VW T1 Samba ("bulli"), procedural Blender build.
#
# Builds the whole bus procedurally (no manual steps) in three LODs, exports one GLB per
# LOD plus report.json and, unless --no-render, Eevee look-dev stills under the Victoria
# Sunset HDRI. Shared helpers live in tools/models/lib (bd_common, bd_lookdev).
#
#   blender -b --factory-startup --python tools/models/vehicles/bulli.py -- \
#       [--out=<dir>] [--lods=2,1,0] [--no-render] [--views=front34,side] [--ortho] \
#       [--skylights=4] [--no-ao] [--icon=<png>]
#
# Normally run through tools/models/build-all.mjs, which also packs the GLBs (meshopt +
# KTX2) into public/models. Default output: tools/models/.out/bulli/.
#
# Axes / units: 1 BU = 1 m = 1 three.js unit. Blender is Z-up; the glTF exporter
# (export_yup) maps Blender (x, y, z) -> three (x, z, -y). The game drives the car
# towards three +Z, so the FRONT is built at Blender -Y. Driver's left = +X.
# Origin: ground level, centre of the footprint (bumper to bumper).
#
# Node convention (tools/models/README.md, snake_case):
#   car_bulli > body (all static parts, one primitive per material)
#             > wheel_fl/fr/rl/rr (Empty pivot, extras role/steer/side/radius) > wheel_xx_geo
#             > accessory_surfboard (roof rack + board, extras default_visible=false)
#             > socket_* (exhaust, nametag, underglow, headlight_l/r, taillight_l/r)
# Materials: paint_primary (player colour, clearcoat), paint_secondary (clearcoat),
# glass (transparent, also carries the contact-shadow blob) and ONE atlas material
# "bulli_atlas" (LOD2: "bulli_atlas_lod2") for chrome, rubber, trim, lamps (emissive),
# canvas, plate, interior, tyre tread and hubcaps -> 3-4 draw calls for the body.
# Defaults (user decision): 4 skylights per side, closed canvas sunroof, chrome bumpers,
# surfboard present but hidden (unlockable accessory), no eyes, real VW roundel.
import bpy, bmesh, math, os, sys, json, time
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

T0 = time.time()
HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.dirname(HERE)                       # tools/models
LIB = os.path.join(MODELS, "lib")
sys.path.insert(0, LIB)
from bd_common import *                              # noqa: E402,F403
import bd_lookdev                                    # noqa: E402

OPT = parse_args()
OUT = OPT.get("out", os.path.join(MODELS, ".out", "bulli"))
REN = os.path.join(OUT, "renders")
WORK = os.path.join(OUT, "work")
for d in (OUT, REN, os.path.join(OUT, "tex"), WORK):
    os.makedirs(d, exist_ok=True)
DO_RENDER = "no-render" not in OPT
SUFFIX = OPT.get("suffix", "")
VIEWS = OPT.get("views", "front34,side,rear34,chase").split(",")
LODS = [int(x) for x in str(OPT.get("lods", "2,1,0")).split(",")]
SCRIPT_HASH = files_hash([os.path.abspath(__file__), os.path.join(LIB, "bd_common.py")])
DIMS = json.load(open(os.path.join(MODELS, "ref", "dimensions.json")))["vehicles"]["bus"]
PLATE_SRC = os.path.join(MODELS, "src", "license_plate_bulli_512.png")
MODEL_ID = "bulli"

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
col = scene.collection

# --------------------------------------------------------------------------
# real dimensions (dimensions.json, 1 u = 1 m)
# --------------------------------------------------------------------------
LENGTH = DIMS["length_m"]["value"]            # 4.28 bumper to bumper
WIDTH = DIMS["width_m"]["value"]              # 1.80 incl. trim
HEIGHT = DIMS["height_m"]["value"]            # 1.94
WB = DIMS["wheelbase_m"]["value"]             # 2.40
TRACK_F = DIMS["track_front_m"]["value"]      # 1.375
TRACK_R = DIMS["track_rear_m"]["value"]       # 1.36
WR = DIMS["tire_diameter_m"]["value"] / 2     # 0.333
# axle positions from the blueprint side view (front overhang 0.95 m incl. bumper)
AXLE_F = -LENGTH / 2 + 0.945
AXLE_R = AXLE_F + WB
BELT = 1.262          # colour split red/cream, top edge of the belt swage
V_TIP_Z = 0.57        # tip of the cream "V" on the front
V_TIP_R = 0.035       # v3: rounded tip (hyperbolic blend, radius-like, m)
V_SLOPE = 1.05        # rise of the straight part of the V arms (dz/dx)
V_X = 0.78            # v3: the arms run tangentially into the belt swage here (front corners)
ARCH_R, ARCH_ZC = 0.40, 0.35


# --------------------------------------------------------------------------
# materials
# --------------------------------------------------------------------------
MAT_SPECS = {
    # name: base hex (sRGB), roughness, metallic, clearcoat, coat roughness, spec = Specular IOR Level
    # (0.5 = glTF default F0 4 %; exported as KHR_materials_specular), emissive hex + strength
    # v2: darker, more saturated red; base specular lowered so the clearcoat carries the reflection
    "paint_primary":   dict(col="#7A1418", rough=0.35, coat=1.0, coat_rough=0.03, spec=0.2),
    "paint_secondary": dict(col="#D6CBB2", rough=0.35, coat=1.0, coat_rough=0.03, spec=0.2),
    "chrome":          dict(col="#EDEDEF", rough=0.05, metal=1.0),
    # v3: lighter, less dense tint (critique: rear window read as a black slab in the chase view)
    "glass":           dict(col="#1C252C", rough=0.02, alpha=0.24),    # transparent (BLEND), no transmission
    "glass_dark":      dict(col="#0B0F13", rough=0.04),                # opaque: skylights, LOD2
    "rubber":          dict(col="#141414", rough=0.86),
    "tread":           dict(col="#171717", rough=0.92, region="tread"),
    "trim_dark":       dict(col="#0D0D0D", rough=0.75),
    "wheel_white":     dict(col="#E8E2D4", rough=0.5),
    "rim_paint":       dict(col="#D9D1BD", rough=0.3),
    "lamp_head":       dict(col="#CFCFC6", rough=0.12, metal=0.4, emit="#FFE3B6", estr=0.4),
    "lamp_tail":       dict(col="#6E0906", rough=0.10, emit="#FF2414", estr=0.35),
    "lamp_amber":      dict(col="#C8600E", rough=0.10, emit="#FF8A1E", estr=0.12),
    "canvas":          dict(col="#4F4338", rough=0.95),
    "plate":           dict(col="#FFFFFF", rough=0.45, region="plate"),
    "hubcap":          dict(col="#EDEDEF", rough=0.05, metal=1.0, region="hubcap"),
    # v3: lighter cabin + a faint emissive "bounce" (the cabin only gets light through the glass;
    # in the game it sits in the body's shadow and read as a dark hole through the rear window)
    "interior":        dict(col="#A69A86", rough=0.8, emit="#A69A86", estr=0.10),
    "headliner":       dict(col="#EFE8D6", rough=0.9, emit="#EFE8D6", estr=0.16),
    "floor":           dict(col="#4E473F", rough=0.95),
    "seat":            dict(col="#CFC2A4", rough=0.55, emit="#CFC2A4", estr=0.10),
    "ivory":           dict(col="#ECE4CE", rough=0.3),
    "surf_board":      dict(col="#EFE6CF", rough=0.28),
    "surf_stripe":     dict(col="#1D7686", rough=0.28),
    "cut_cap":         dict(col="#FF00FF", rough=1.0),                 # boolean helper, deleted
    "blob":            dict(col="#000000", rough=1.0),                 # placeholder -> 'glass' (blob region)
}


def make_material(name):
    """material factory for bd_common.get_mat (cached there per name)"""
    if name == "bulli_atlas":
        return make_atlas_material()
    if name == "bulli_atlas_lod2":
        return make_atlas_material(small=True)
    if name == "glass":
        return make_glass_material()
    s = MAT_SPECS[name]
    m = bpy.data.materials.new(name)
    b = principled(m)
    b.inputs["Base Color"].default_value = (*lin(s["col"]), 1)
    b.inputs["Roughness"].default_value = s["rough"]
    b.inputs["Metallic"].default_value = s.get("metal", 0.0)
    if "spec" in s:
        b.inputs["Specular IOR Level"].default_value = s["spec"]
    if s.get("coat"):
        b.inputs["Coat Weight"].default_value = s["coat"]
        b.inputs["Coat Roughness"].default_value = s.get("coat_rough", 0.03)
    if s.get("emit"):
        b.inputs["Emission Color"].default_value = (*lin(s["emit"]), 1)
        b.inputs["Emission Strength"].default_value = s["estr"]
    m.diffuse_color = (*lin(s["col"]), 1)
    m.use_backface_culling = True  # -> glTF doubleSided=false (catches flipped faces early)
    return m


set_material_factory(make_material)


def plate_pixels(w=256, h=128):
    """California 1963-69 plate (AI decal, tools/models/src) -> w x h RGBA float array
    (Blender pixel order: row 0 = bottom), transparent corners filled dark."""
    import numpy as np
    im = bpy.data.images.load(PLATE_SRC)
    im.scale(w, h)
    px = np.empty(w * h * 4, np.float32)
    im.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)
    a = px[..., 3:4]
    px[..., :3] = px[..., :3] * a + 0.02 * (1 - a)
    px[..., 3] = 1
    bpy.data.images.remove(im)
    return px


# ---- texture atlas (all LODs) ------------------------------------------------
# 512 x 512, Blender pixel convention (row 0 = bottom, v = 0 bottom):
#   y 448..512  palette: 16 x 2 cells of 32 px (flat PBR values, sampled at the cell centre)
#   y 320..448  x 0..256  licence plate (256 x 128)
#   y 256..320  tyre tread strip (512 x 64, u = circumference, v = across the tread)
# base + normal at 512 px, metal/rough + emissive at 128 px (same layout, cells 8 px).
# LINEAR + mipmaps; the 32 px cells survive down to mip 5.
ATLAS_CELLS = ["chrome", "glass_dark", "rubber", "trim_dark", "wheel_white", "rim_paint", "lamp_head",
               "lamp_tail", "lamp_amber", "canvas", "interior", "headliner", "floor", "seat", "ivory",
               "surf_board", "surf_stripe"]
ATLAS_PX, ATLAS_CELL, ATLAS_COLS = 512, 32, 16
REGIONS = {"plate": (0, 320, 256, 128), "tread": (0, 256, 512, 64), "hubcap": (256, 320, 128, 128)}
HUB_R = 0.142            # hubcap radius mapped onto the hubcap region (planar UVs)
HUB_LOGO_R = 0.050       # VW roundel radius on the hubcap


def atlas_uv(name):
    i = ATLAS_CELLS.index(name)
    cx, cy = i % ATLAS_COLS, i // ATLAS_COLS
    return ((cx * ATLAS_CELL + ATLAS_CELL / 2) / ATLAS_PX, (448 + cy * ATLAS_CELL + ATLAS_CELL / 2) / ATLAS_PX)


def region_uv(name, u, v):
    x0, y0, w, h = REGIONS[name]
    return ((x0 + u * w) / ATLAS_PX, (y0 + v * h) / ATLAS_PX)


def tread_height(W=512, H=64):
    """tyre tread height field (1 = block, 0 = groove), rows = across the tread (v), cols = circumference."""
    import numpy as np
    u = (np.arange(W) + 0.5) / W
    v = (np.arange(H) + 0.5) / H
    U, V = np.meshgrid(u, v)
    NP = 46                                              # tread pitches around the tyre
    h = np.ones((H, W), np.float32)
    for vc in (0.32, 0.68):                              # two circumferential grooves
        h = np.minimum(h, np.clip((np.abs(V - vc) - 0.030) / 0.012, 0, 1))
    ph = (U * NP + (V - 0.5) * 0.9) % 1.0                # slanted lateral grooves in the shoulders
    sh = (V < 0.30) | (V > 0.70)
    lat = np.clip((np.abs(ph - 0.5) - 0.40) / 0.03, 0, 1)
    h = np.where(sh, np.minimum(h, 1 - lat), h)
    ph2 = (U * NP * 2 + 0.25) % 1.0                      # sipes in the centre rib
    rib = (V > 0.36) & (V < 0.64)
    sip = np.clip((np.abs(ph2 - 0.5) - 0.44) / 0.03, 0, 1)
    h = np.where(rib, np.minimum(h, 1 - 0.55 * sip), h)
    # soften (box blur 3x3)
    k = np.pad(h, 1, mode="wrap")
    h = sum(k[1 + dy:1 + dy + H, 1 + dx:1 + dx + W] for dy in (-1, 0, 1) for dx in (-1, 0, 1)) / 9.0
    return h


def hub_logo_height(n):
    """VW roundel as a soft height field on an n x n grid covering the hubcap (radius HUB_R)"""
    import numpy as np
    c = (np.arange(n) + 0.5) / n * 2 - 1                      # -1..1 over the hubcap diameter
    X, Y = np.meshgrid(c, c)
    k = HUB_R / HUB_LOGO_R                                    # -> logo units (1 = roundel radius)
    X, Y = X * k, Y * k
    r = np.hypot(X, Y)
    ring_w = 0.16
    h = np.clip(1 - np.abs(r - (1 - ring_w / 2)) / (ring_w / 2), 0, 1)
    hw = 0.19 / 2
    for (a, b) in logo_strokes(1 - ring_w):
        ax, ay, bx, by = a.x, a.y, b.x, b.y
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        t = np.clip(((X - ax) * dx + (Y - ay) * dy) / L2, 0, 1)
        d = np.hypot(X - (ax + t * dx), Y - (ay + t * dy))
        h = np.maximum(h, np.clip(1 - d / hw, 0, 1) * (r < 1.0))
    h = np.clip(h * 1.6, 0, 1)
    return h ** 0.7


def make_atlas_material(small=False):
    """small=True: 64 px palette-only variant for LOD2 (same UV layout, nearest filtering)"""
    import numpy as np
    if small:
        return make_small_atlas()
    P, C = ATLAS_PX, ATLAS_CELL
    base = np.zeros((P, P, 4), np.float32)
    nrm = np.zeros((P, P, 4), np.float32)
    base[..., 3] = nrm[..., 3] = 1
    nrm[..., :3] = (0.5, 0.5, 1.0)
    p4 = P // 4
    mr = np.zeros((p4, p4, 4), np.float32)
    em = np.zeros((p4, p4, 4), np.float32)
    mr[..., 3] = em[..., 3] = 1
    mr[..., 0] = 1.0
    mr[..., 1] = 0.9
    for i, n in enumerate(ATLAS_CELLS):
        s = MAT_SPECS[n]
        cx, cy = i % ATLAS_COLS, i // ATLAS_COLS
        y0 = 448 + cy * C
        base[y0:y0 + C, cx * C:(cx + 1) * C, :3] = srgb(s["col"])
        q0 = y0 // 4
        sl = (slice(q0, q0 + C // 4), slice(cx * C // 4, (cx + 1) * C // 4))
        mr[sl[0], sl[1], 1] = s["rough"]
        mr[sl[0], sl[1], 2] = s.get("metal", 0.0)
        if s.get("emit"):
            e = srgb(s["emit"])
            k = min(1.0, s["estr"])
            em[sl[0], sl[1], :3] = [c * k for c in e]
    # hubcap: chrome with the VW roundel embossed (height field -> normals)
    x0, y0, w, h = REGIONS["hubcap"]
    base[y0:y0 + h, x0:x0 + w, :3] = srgb(MAT_SPECS["chrome"]["col"])
    mr[y0 // 4:(y0 + h) // 4, x0 // 4:(x0 + w) // 4, 1] = MAT_SPECS["chrome"]["rough"]
    mr[y0 // 4:(y0 + h) // 4, x0 // 4:(x0 + w) // 4, 2] = 1.0
    hl = hub_logo_height(w)
    dpx = 2 * HUB_R / w
    gx = (np.roll(hl, -1, 1) - np.roll(hl, 1, 1)) / (2 * dpx) * 0.0016
    gy = (np.roll(hl, -1, 0) - np.roll(hl, 1, 0)) / (2 * dpx) * 0.0016
    nv = np.stack([-gx, -gy, np.ones_like(gx)], -1)
    nv /= np.linalg.norm(nv, axis=-1, keepdims=True)
    nrm[y0:y0 + h, x0:x0 + w, :3] = nv * 0.5 + 0.5
    # licence plate
    x0, y0, w, h = REGIONS["plate"]
    base[y0:y0 + h, x0:x0 + w] = plate_pixels(w, h)
    mr[y0 // 4:(y0 + h) // 4, x0 // 4:(x0 + w) // 4, 1] = 0.45
    # tread: dark rubber, grooves darker, normal map from the height field
    x0, y0, w, h = REGIONS["tread"]
    ht = tread_height(w, h)
    base[y0:y0 + h, x0:x0 + w, :3] = (0.075 + 0.03 * ht)[..., None]
    mr[y0 // 4:(y0 + h) // 4, x0 // 4:(x0 + w) // 4, 1] = 0.92
    du_m, dv_m, depth = 2 * pi * WR / w, 0.104 / h, 0.0028    # metres per pixel, groove depth
    gx = (np.roll(ht, -1, 1) - np.roll(ht, 1, 1)) / (2 * du_m) * depth
    gy = (np.roll(ht, -1, 0) - np.roll(ht, 1, 0)) / (2 * dv_m) * depth
    gy[0], gy[-1] = 0, 0
    nv = np.stack([-gx, -gy, np.ones_like(gx)], -1)
    nv /= np.linalg.norm(nv, axis=-1, keepdims=True)
    nrm[y0:y0 + h, x0:x0 + w, :3] = nv * 0.5 + 0.5
    imgs = {}
    for key, arr, cs in (("base", base, "sRGB"), ("normal", nrm, "Non-Color"), ("mr", mr, "Non-Color"),
                         ("emissive", em, "sRGB")):
        jpg = key == "base"                     # plate + tread noise: JPEG q92 (70 -> ~25 KB), rest PNG
        imgs[key] = save_image("bulli_atlas_" + key, arr,
                               os.path.join(OUT, "tex", "bulli_atlas_%s.%s" % (key, "jpg" if jpg else "png")),
                               cs, fmt="JPEG" if jpg else "PNG", quality=92)
    return image_material("bulli_atlas", imgs, interpolation="Linear")


def make_small_atlas():
    import numpy as np
    P = 64
    k = ATLAS_PX // P
    base = np.zeros((P, P, 4), np.float32)
    mr = np.zeros((P, P, 4), np.float32)
    em = np.zeros((P, P, 4), np.float32)
    base[..., 3] = mr[..., 3] = em[..., 3] = 1
    mr[..., 0], mr[..., 1] = 1.0, 0.9
    base[..., :3] = 0.08
    C = ATLAS_CELL // k
    for i, n in enumerate(ATLAS_CELLS):
        s_ = MAT_SPECS[n]
        cx, cy = i % ATLAS_COLS, i // ATLAS_COLS
        y0 = 448 // k + cy * C
        sl = (slice(y0, y0 + C), slice(cx * C, (cx + 1) * C))
        base[sl[0], sl[1], :3] = srgb(s_["col"])
        mr[sl[0], sl[1], 1] = s_["rough"]
        mr[sl[0], sl[1], 2] = s_.get("metal", 0.0)
        if s_.get("emit"):
            em[sl[0], sl[1], :3] = [c * min(1.0, s_["estr"]) for c in srgb(s_["emit"])]
    imgs = {}
    for key, arr, cs in (("base", base, "sRGB"), ("mr", mr, "Non-Color"), ("emissive", em, "sRGB")):
        imgs[key] = save_image("bulli_atlas_lod2_" + key, arr, os.path.join(OUT, "tex", "bulli_atlas_lod2_%s.png" % key), cs)
    return image_material("bulli_atlas_lod2", imgs, interpolation="Closest")


# ---- transparent glass + contact-shadow blob (one BLEND material, 128 x 64) --------
#   left half: glass tint + alpha, right half: soft blob (black, alpha gradient, rough)
GLASS_PX = (128, 64)


def glass_uv():
    return (0.25, 0.5)


def blob_uv(u, v):
    return (0.5 + 0.5 * (0.03 + 0.94 * u), 0.03 + 0.94 * v)


def make_glass_material():
    import numpy as np
    W, H = GLASS_PX
    base = np.zeros((H, W, 4), np.float32)
    mr = np.zeros((H, W, 4), np.float32)
    mr[..., 3] = 1
    mr[..., 0] = 1
    s = MAT_SPECS["glass"]
    base[:, :W // 2, :3] = srgb(s["col"])
    base[:, :W // 2, 3] = s["alpha"]
    mr[:, :W // 2, 1] = s["rough"]
    # blob: rounded-rectangle falloff (superellipse), darkest under the centre
    yy, xx = np.meshgrid((np.arange(H) + 0.5) / H, (np.arange(W // 2) + 0.5) / (W // 2), indexing="ij")
    X, Y = (xx - 0.5) * 2, (yy - 0.5) * 2
    r = (np.abs(X) ** 4 + np.abs(Y) ** 4) ** 0.25
    a = (1 - np.clip((r - 0.45) / 0.55, 0, 1)) ** 1.6 * 0.72
    base[:, W // 2:, 3] = a
    mr[:, W // 2:, 1] = 1.0
    imgs = {}
    for key, arr, cs in (("base", base, "sRGB"), ("mr", mr, "Non-Color")):
        imgs[key] = save_image("bulli_glass_" + key, arr, os.path.join(OUT, "tex", "bulli_glass_%s.png" % key), cs,
                               alpha=(key == "base"))
    return image_material("glass", imgs, interpolation="Linear", alpha=True, emission=False, blend=True)


# --------------------------------------------------------------------------
# BODY SHELL: loft of plan-view rings. Each ring = front superellipse quadrant,
# straight side, rear superellipse quadrant (mirrored), parameters per height.
# --------------------------------------------------------------------------
# z, half width A, front extent F, rear extent R   (measured on t1_blueprint.png,
# heights rescaled to the real 1.94 m, width from dimensions.json)
ROWS = [
    (0.330, 0.815, 2.000, 1.975),
    (0.352, 0.852, 2.036, 2.008),
    (0.380, 0.864, 2.052, 2.024),
    (0.440, 0.868, 2.064, 2.034),
    (0.520, 0.870, 2.071, 2.039),
    (0.620, 0.871, 2.075, 2.041),
    (0.720, 0.872, 2.076, 2.041),
    (0.820, 0.873, 2.073, 2.040),
    (0.920, 0.874, 2.064, 2.038),
    (1.020, 0.875, 2.050, 2.035),
    (1.120, 0.876, 2.032, 2.030),
    (1.200, 0.878, 2.016, 2.026),
    (1.232, 0.882, 2.009, 2.026),
    (1.248, 0.886, 2.005, 2.029),   # belt swage peak
    (BELT, 0.878, 2.001, 2.022),
    (1.290, 0.866, 1.990, 2.013),
    (1.360, 0.852, 1.957, 2.000),
    (1.450, 0.835, 1.913, 1.985),
    (1.540, 0.818, 1.868, 1.968),
    (1.630, 0.802, 1.824, 1.951),
    (1.700, 0.789, 1.790, 1.938),
    (1.720, 0.785, 1.780, 1.935),
]
# v2: more tumblehome above the belt (critique: upper body too wide in the front view):
# the half width shrinks by an extra 5.8 cm up to the roof edge -> 15 cm in total from the belt
ROWS = [(z, A - (0.058 * ((z - 1.29) / 0.43) ** 1.2 if z > 1.29 else 0.0), F, R) for (z, A, F, R) in ROWS]
# roof: cubic Bezier from the roof edge (z0, tangent = rake of the wall below) to the flat
# top (zt, horizontal tangent), per direction side / front / rear. The z control points are
# shared, so every roof ring stays a horizontal slice. v2 removes the 11-25 deg kink the
# old ellipse had at z0 (front looked boxy) and makes the front "cap" rounder.
ROOF_Z0, ROOF_ZT = 1.72, 1.918
ROOF_D = (0.25, 0.50, 0.43)             # total inset side / front / rear
ROOF_HA = 0.105                         # vertical handle at the roof edge (along the rake)
ROOF_HB = (0.12, 0.25, 0.21)            # horizontal handle at the top
CROWN_Z = HEIGHT                        # 1.94 at the crown


def _rake(k):
    a, b = row_at(ROOF_Z0 - 0.06), row_at(ROOF_Z0)
    return max(0.0, (a[k] - b[k]) / 0.06)


def roof_at(t):
    """roof ring at Bezier parameter t (0 = roof edge, 1 = flat top): z, A, F, R"""
    z = bez(ROOF_Z0, ROOF_Z0 + ROOF_HA, ROOF_ZT, ROOF_ZT, t)
    base = row_at(ROOF_Z0)
    out = [z]
    for k in range(3):
        ins = bez(0.0, _rake(k) * ROOF_HA, ROOF_D[k] - ROOF_HB[k], ROOF_D[k], t)
        out.append(base[k] - ins)
    return tuple(out)


def roof_side_normal(t, s=1):
    """outward normal (x, z) of the roof side section at parameter t"""
    dz = bez_d(ROOF_Z0, ROOF_Z0 + ROOF_HA, ROOF_ZT, ROOF_ZT, t)
    di = bez_d(0.0, _rake(0) * ROOF_HA, ROOF_D[0] - ROOF_HB[0], ROOF_D[0], t)
    n = Vector((s * dz, 0, di))
    return n.normalized()


def shape_params(z):
    t = smoothstep(1.20, 1.40, z)
    return dict(bF=0.33, nF=3.0 + (2.6 - 3.0) * t, bR=0.24 + (0.30 - 0.24) * t, nR=3.5 + (3.0 - 3.5) * t)


def row_at(z):
    if z <= ROWS[0][0]:
        return ROWS[0][1:]
    for r0, r1 in zip(ROWS, ROWS[1:]):
        if z <= r1[0]:
            t = (z - r0[0]) / (r1[0] - r0[0])
            return tuple(a + (b - a) * t for a, b in zip(r0[1:], r1[1:]))
    return ROWS[-1][1:]


def quad_pts(a, b, n, count, lam=0.10):
    """superellipse quadrant from (0, b) [centre] to (a, 0) [side], count+1 points,
    spaced by arc length + lam * turning angle."""
    N = 400
    P = []
    for i in range(N + 1):
        t = (pi / 2) * (1 - i / N)
        c, s = max(math.cos(t), 0.0), max(math.sin(t), 0.0)
        P.append(Vector((a * c ** (2 / n), b * s ** (2 / n))))
    meas = [0.0]
    for i in range(1, N + 1):
        d = (P[i] - P[i - 1]).length
        ang = 0.0
        if 1 <= i < N:
            u1, u2 = (P[i] - P[i - 1]), (P[i + 1] - P[i])
            if u1.length > 1e-9 and u2.length > 1e-9:
                ang = u1.angle(u2, 0.0)
        meas.append(meas[-1] + d + lam * ang)
    out = []
    j = 0
    for k in range(count + 1):
        target = meas[-1] * k / count
        while j < N - 1 and meas[j + 1] < target:
            j += 1
        t = (target - meas[j]) / max(meas[j + 1] - meas[j], 1e-12)
        out.append(P[j].lerp(P[j + 1], min(1, max(0, t))))
    return out


def outline(A, F, R, bF, nF, bR, nR, q):
    """CCW (seen from +Z) ring, starting at the front centre (0, -F)."""
    fq = quad_pts(A, bF, nF, q["nqF"])      # centre -> side
    rq = quad_pts(A, bR, nR, q["nqR"])
    left = [Vector((u, -F + bF - v)) for (u, v) in fq]
    y0, y1 = -F + bF, R - bR
    for k in range(1, q["nS"]):
        left.append(Vector((A, y0 + (y1 - y0) * k / q["nS"])))
    left += [Vector((u, R - bR + v)) for (u, v) in reversed(rq)]
    right = [Vector((-p.x, p.y)) for p in reversed(left[1:-1])]
    return left + right


def ring_params(z, q):
    A, F, R = row_at(z)
    s = shape_params(z)
    return A, F, R, s["bF"], s["nF"], s["bR"], s["nR"]


def roof_ring(t):
    z, A, F, R = roof_at(t)
    s = shape_params(ROOF_Z0)
    return (z, A, F, R, s["bF"], s["nF"], s["bR"], s["nR"])


def _v_tip(x):
    return V_TIP_Z + V_SLOPE * (math.sqrt(x * x + V_TIP_R * V_TIP_R) - V_TIP_R)


def _v_straight_end():
    """x where the straight arm hands over to the ease into the belt (the ease is a parabola that
    starts with the arm's slope and ends horizontal at (V_X, BELT))"""
    lo, hi = 0.0, V_X
    for _ in range(60):
        xa = (lo + hi) / 2
        if _v_tip(xa) + V_SLOPE * (V_X - xa) / 2 > BELT:
            hi = xa
        else:
            lo = xa
    return (lo + hi) / 2


V_XA = _v_straight_end()


def z_v(x):
    """height of the V boundary on the front at lateral position x (v3: rounded tip, straight arms,
    tangential run into the belt swage like the real T1; v2 was a 4-point polyline with a sharp tip
    and a kink at the belt)"""
    x = abs(x)
    if x >= V_X:
        return BELT
    if x <= V_XA:
        return _v_tip(x)
    d = x - V_XA
    return _v_tip(V_XA) + V_SLOPE * d - V_SLOPE * d * d / (2 * (V_X - V_XA))


def v_pts(n):
    """n + 1 points along one V arm for the planar bisect cuts: denser at the rounded tip and in
    the ease into the belt, where the curve bends"""
    xs = [0.0, V_TIP_R * 0.6, V_TIP_R * 1.6]
    m = max(1, n - 5)
    for k in range(1, m + 1):
        xs.append(V_TIP_R * 1.6 + (V_XA - V_TIP_R * 1.6) * k / m)
    xs += [V_XA + (V_X - V_XA) * t for t in (0.4, 0.75, 1.0)]
    if n <= 4:
        xs = [0.0, V_TIP_R * 1.6, V_XA, V_XA + (V_X - V_XA) * 0.55, V_X]
    return [(x, z_v(x)) for x in xs]


def build_shell(q):
    mb = MB()
    specs = []
    rows = ROWS if q["rows"] is None else [ROWS[i] for i in q["rows"]]
    for r in rows:
        specs.append((r[0],) + ring_params(r[0], q))
    for ph in q["roof"]:
        specs.append(roof_ring(ph))
    zt, At, Ft, Rt, bF, nF, bR, nR = specs[-1]
    for k, dz in q["crown"]:
        specs.append((zt + dz, At * k, Ft * k, Rt * k, bF * k, nF, bR * k, nR))
    rings = []
    for (z, A, F, R, bF, nF, bR, nR) in specs:
        rings.append([mb.v((p.x, p.y, z)) for p in outline(A, F, R, bF, nF, bR, nR, q)])
    zs = [s[0] for s in specs]

    def mat_fn(i, j):
        zc = (zs[i] + zs[i + 1]) / 2
        return "paint_primary" if zc < BELT else "paint_secondary"
    mb.grid(rings, mat_fn, closed=True)
    ztop = CROWN_Z
    top = specs[-1]
    mb.fan(rings[-1], (0, (top[3] - top[2]) / 2 * 0.3, ztop), "paint_secondary")
    b0 = specs[0]
    mb.fan(rings[0], (0, (b0[3] - b0[2]) / 2, zs[0] - 0.005), "trim_dark", flip=True)
    bm = mb.bm
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    # cream V on the front: bisect along the two V arms, recolour above
    V_PTS = v_pts(q["v_n"])
    for side in (1, -1):
        for (x0, z0), (x1, z1) in zip(V_PTS, V_PTS[1:]):
            sub = []
            for f in bm.faces:
                c = f.calc_center_median()
                xs = [v.co.x * side for v in f.verts]
                if c.y < -1.5 and V_TIP_Z - 0.1 < c.z < BELT + 0.02 and max(xs) > x0 - 1e-4 and min(xs) < x1 + 1e-4:
                    sub.append(f)
            geom = list({v for f in sub for v in f.verts}) + list({e for f in sub for e in f.edges}) + sub
            nrm = Vector((-(z1 - z0) * side, 0, x1 - x0)).normalized()
            bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-5, plane_co=Vector((x0 * side, 0, z0)), plane_no=nrm)
    iP, iS = mb.mi("paint_primary"), mb.mi("paint_secondary")
    for f in bm.faces:
        c = f.calc_center_median()
        if f.material_index == iP and c.y < -1.55 and c.z < BELT and abs(c.x) < V_X + 0.02 and c.z > z_v(c.x) + 1e-4:
            f.material_index = iS
    return mb, specs


# --------------------------------------------------------------------------
# surface queries
# --------------------------------------------------------------------------
def to_bvh(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    t = BVHTree.FromBMesh(bm)
    bm.free()
    return t


class Surf:
    def __init__(self, bvh):
        self.bvh = bvh

    def ray(self, origin, direction, fallback=True):
        d = Vector(direction).normalized()
        loc, nrm, idx, dist = self.bvh.ray_cast(Vector(origin), d, 20.0)
        if loc is None and fallback:
            return Vector(origin) + d * 3.0, -d
        if loc is not None and nrm.dot(d) > 0:
            nrm = -nrm
        return loc, nrm

    def near(self, p):
        loc, nrm, idx, dist = self.bvh.find_nearest(Vector(p))
        return loc, nrm

    def front(self, x, z):
        return self.ray((x, -4.0, z), (0, 1, 0))

    def rear(self, x, z):
        return self.ray((x, 4.0, z), (0, -1, 0))

    def side(self, s, y, z):
        return self.ray((4.0 * s, y, z), (-s, 0, 0))


# --------------------------------------------------------------------------
# windows: rubber seal + (LOD0) chrome insert + dark glass, projected on the shell
# --------------------------------------------------------------------------
CUTS = []          # window cutters of the current LOD: (outer ring, inner ring) in world space
CUT_OUT, CUT_IN = 0.03, 0.07


def register_cut(P, outline, d, cen):
    """cutter ring under the middle of the seal, from CUT_OUT outside to CUT_IN inside the paint"""
    pts = inset(outline, d)
    CUTS.append(([P(p.x, p.y, CUT_OUT) for p in pts], [P(p.x, p.y, -CUT_IN) for p in pts],
                 P(cen.x, cen.y, CUT_OUT), P(cen.x, cen.y, -CUT_IN)))


def pane(mb, S, O, N, corners3d, radii, q, up=Vector((0, 0, 1)), small=False, grings=0, curved=False, cut=True):
    see_through = cut and q["holes"]
    gmat = "glass" if see_through else "glass_dark"
    N = Vector(N).normalized()
    U = up.cross(N)
    if U.length < 1e-6:
        U = Vector((1, 0, 0))
    U.normalize()
    # U x V = N  ->  V = N x U
    V = N.cross(U).normalized()
    uv = [Vector(((Vector(p) - O).dot(U), (Vector(p) - O).dot(V))) for p in corners3d]
    nc = q["sky_nc"] if small else q["nc"]
    # curved panes (windshield/rear) on coarse LODs: dense outline + 2 glass rings so the
    # glass follows the facets instead of cutting chords below the shell
    outer = rounded_poly(uv, radii, nc, min(q["maxseg"], 0.12 if not small else 0.2) if curved else q["maxseg"])
    if curved and not small:
        grings = max(grings, 2)
    cen = sum(outer, Vector((0, 0))) / len(outer)

    def P(u, v, off):
        p0 = O + U * u + V * v + N * 0.6
        loc, n = S.ray(p0, -N)
        return loc + n * off
    seal = 0.020 if not small else 0.014
    lvl = q["seal"] if not small else (1 if q["seal"] >= 3 else 0)   # skylights: one rubber ring on LOD0
    if lvl >= 3:
        spec = [(0.0, 0.0010, "rubber"), (0.004, 0.0065, "rubber"), (seal * 0.40, 0.0075, "chrome"),
                (seal * 0.62, 0.0070, "rubber"), (seal, 0.0030, None)]
    elif lvl >= 2:
        spec = [(0.0, 0.0015, "rubber"), (seal * 0.5, 0.0075, "rubber"), (seal, 0.0045, None)]
    elif lvl >= 1:
        spec = [(0.0, 0.0015, "rubber"), (seal, 0.0055, None)]
    else:
        spec = [(0.0, 0.012 if curved else 0.008, None)]
    rings = []
    for (d, off, _) in spec:
        pts = inset(outer, d) if d > 0 else outer
        rings.append([mb.v(P(p.x, p.y, off)) for p in pts])
    for i in range(len(rings) - 1):
        n = len(rings[i])
        for j in range(n):
            mb.f([rings[i][j], rings[i][(j + 1) % n], rings[i + 1][(j + 1) % n], rings[i + 1][j]], spec[i][2])
    glass_edge = inset(outer, spec[-1][0]) if spec[-1][0] > 0 else outer
    last = rings[-1]
    off = spec[-1][1]
    ng = grings if curved else min(grings, q["glass_rings"])
    for k in range(ng):
        s = 1 - (k + 1) / (ng + 1)
        pts = [cen + (p - cen) * s for p in glass_edge]
        ring = [mb.v(P(p.x, p.y, off)) for p in pts]
        n = len(ring)
        for j in range(n):
            mb.f([last[j], last[(j + 1) % n], ring[(j + 1) % n], ring[j]], gmat)
        last = ring
    mb.fan(last, P(cen.x, cen.y, off), gmat)
    if see_through:
        co = outer if not q.get("cut_nc") else rounded_poly(uv, radii, q["cut_nc"], q["cut_maxseg"])
        register_cut(P, co, max(seal * 0.45, 0.006), cen)


_DENSE = {}


def rear_half_dense(z):
    """left half of the plan outline at height z, from the rear centre forwards, + arc lengths"""
    key = round(z, 4)
    if key not in _DENSE:
        A, F, R, bF, nF, bR, nR = ring_params(z, None)
        ol = outline(A, F, R, bF, nF, bR, nR, dict(nqF=6, nqR=160, nS=30))
        half = ol[:len(ol) // 2 + 1]
        pts = list(reversed(half))
        cum = [0.0]
        for a, b in zip(pts, pts[1:]):
            cum.append(cum[-1] + (b - a).length)
        _DENSE[key] = (pts, cum)
    return _DENSE[key]


def pt_from_rear(z, sr, side):
    pts, cum = rear_half_dense(z)
    k = 0
    while k < len(cum) - 2 and cum[k + 1] < sr:
        k += 1
    t = (sr - cum[k]) / max(cum[k + 1] - cum[k], 1e-9)
    p = pts[k].lerp(pts[k + 1], min(1.0, max(0.0, t)))
    return Vector((p.x * side, p.y, z))


def sr_at(z, cond):
    pts, cum = rear_half_dense(z)
    for p, c in zip(pts, cum):
        if cond(p):
            return c
    return cum[-1]


def ring_pane(mb, S, side, corners_sz, radii, q):
    """window laid out in (arc length from the rear centre, z) -> wraps around the rear corners."""
    uv = [Vector((-sr * side, z)) for (sr, z) in corners_sz]
    outer = rounded_poly(uv, radii, q["nc"], q["corner_seg"])
    cen = sum(outer, Vector((0, 0))) / len(outer)

    def P(u, v, off):
        loc, n = S.near(pt_from_rear(v, -u * side, side))
        return loc + n * off
    seal = 0.020
    if q["seal"] >= 3:
        spec = [(0.0, 0.0010, "rubber"), (0.004, 0.0065, "rubber"), (seal * 0.40, 0.0075, "chrome"),
                (seal * 0.62, 0.0070, "rubber"), (seal, 0.0030, None)]
    elif q["seal"] >= 2:
        spec = [(0.0, 0.0012, "rubber"), (seal * 0.5, 0.0060, "rubber"), (seal, 0.0030, None)]
    elif q["seal"] >= 1:
        spec = [(0.0, 0.0012, "rubber"), (seal * 0.5, 0.0060, "rubber"), (seal, 0.0030, None)]
    else:
        spec = [(0.0, 0.004, None)]
    rings = []
    for (d, off, _) in spec:
        pts = inset(outer, d) if d > 0 else outer
        rings.append([mb.v(P(p.x, p.y, off)) for p in pts])
    for i in range(len(rings) - 1):
        n = len(rings[i])
        for j in range(n):
            mb.f([rings[i][j], rings[i][(j + 1) % n], rings[i + 1][(j + 1) % n], rings[i + 1][j]], spec[i][2])
    edge = inset(outer, spec[-1][0]) if spec[-1][0] > 0 else outer
    last = rings[-1]
    off = spec[-1][1]
    gmat = "glass" if q["holes"] else "glass_dark"
    nk = q["corner_rings"]
    for k in range(nk):
        sc = 1 - (k + 1) / (nk + 1)
        ring = [mb.v(P(*(cen + (p - cen) * sc), off)) for p in edge]
        n = len(ring)
        for j in range(n):
            mb.f([last[j], last[(j + 1) % n], ring[(j + 1) % n], ring[j]], gmat)
        last = ring
    mb.fan(last, P(cen.x, cen.y, off), gmat)
    if q["holes"]:
        co = outer if not q.get("cut_nc") else rounded_poly(uv, radii, q["cut_nc"], 0.16)
        register_cut(P, co, seal * 0.45, cen)


def seam(mb, S, pts3d, dirn, width=0.0035, off=0.0012, mat="trim_dark", seg=0.16):
    """dark panel gap: polyline of 3D points, projected along -dirn onto the shell."""
    P = [Vector(p) for p in pts3d]
    dense = []
    for a, b in zip(P, P[1:]):
        m = max(1, int(math.ceil((b - a).length / seg)))
        for k in range(m):
            dense.append(a.lerp(b, k / m))
    dense.append(P[-1])
    closed = (P[0] - P[-1]).length < 1e-6
    if closed:
        dense = dense[:-1]
    pts, nrms = [], []
    for p in dense:
        loc, n = S.ray(p + Vector(dirn) * 0.5, -Vector(dirn))
        pts.append(loc)
        nrms.append(n)
    strip(mb, pts, nrms, [(-width / 2, 0), (width / 2, 0)], mat, closed=closed, offset=off)


# --------------------------------------------------------------------------
# VW roundel (ring + two long diagonals + two W outer strokes)
# --------------------------------------------------------------------------
def logo_strokes(ri):
    ang = math.radians(68)
    dA = Vector((math.cos(-ang), math.sin(-ang)))        # down-right
    dB = Vector((-math.cos(-ang), math.sin(-ang)))       # down-left
    rm = ri + 0.04
    A0, A1 = -dA * rm, dA * rm                           # V left arm + W 3rd stroke
    B0, B1 = -dB * rm, dB * rm                           # V right arm + W 2nd stroke
    Pb = dB * ri * 0.98                                  # W bottom-left vertex
    Pbr = dA * ri * 0.98
    # W outer strokes: parallel to dA / dB up to the ring
    def to_ring(p, d):
        t = 0.0
        while (p + d * t).length < rm and t < 3:
            t += 0.005
        return p + d * t
    W1 = (to_ring(Pb, -dA), Pb)
    W4 = (to_ring(Pbr, -dB), Pbr)
    return [(A0, A1), (B0, B1), W1, W4]


def build_logo(mb, O, N, R, q, depth=0.012, stroke=0.17, ring_w=0.12, up=Vector((0, 0, 1))):
    N = Vector(N).normalized()
    U = up.cross(N).normalized()
    V = N.cross(U).normalized()
    M = Matrix((U, V, N)).transposed()
    segs = q["logo_seg"]
    ro, ri = R, R * (1 - ring_w)
    # ring: rounded profile
    prof = [(ri - 0.002, 0.0), (ri, depth * 0.55), (ri + (ro - ri) * 0.3, depth), (ro - (ro - ri) * 0.3, depth),
            (ro, depth * 0.55), (ro + 0.002, 0.0)]
    if segs <= 24:
        prof = [(ri, 0.0), (ri, depth), (ro, depth), (ro, 0.0)]
    lathe(mb, prof, segs, M, O, ["chrome"] * (len(prof) - 1))
    if q.get("logo_strokes", True):
        w = stroke * R
        h = depth * 0.92
        cross = [(-w / 2 - 0.001, 0.0), (-w / 2, h * 0.6), (-w * 0.28, h), (w * 0.28, h), (w / 2, h * 0.6), (w / 2 + 0.001, 0.0)]
        for (a, b) in logo_strokes(1 - ring_w):
            a3, b3 = O + M @ Vector((a.x * R, a.y * R, 0)), O + M @ Vector((b.x * R, b.y * R, 0))
            n0 = mb.nfaces()
            t = (b3 - a3).normalized()
            wv = N.cross(t).normalized()
            ra = [mb.v(a3 + wv * c + N * d) for (c, d) in cross]
            rb = [mb.v(b3 + wv * c + N * d) for (c, d) in cross]
            for j in range(len(cross) - 1):
                mb.f([ra[j], rb[j], rb[j + 1], ra[j + 1]], "chrome")
            mb.f(ra[::-1], "chrome")
            mb.f(rb, "chrome")
            bmesh.ops.recalc_face_normals(mb.bm, faces=mb.faces_since(n0))
    else:
        lathe(mb, [(0.0, depth * 0.6), (ri, depth * 0.6)], max(8, segs), M, O, ["chrome"])


# --------------------------------------------------------------------------
# lamps
# --------------------------------------------------------------------------
def headlight(mb, S, x, z, q):
    loc, n = S.front(x, z)
    n = (n + Vector((0, -0.25, 0))).normalized()
    M = frame_from_axis(n)
    prof = [(0.132, -0.03), (0.127, 0.006),                                     # body pod
            (0.116, 0.016), (0.108, 0.027), (0.097, 0.030), (0.089, 0.022),     # chrome ring
            (0.087, 0.022), (0.074, 0.030), (0.071, 0.029), (0.045, 0.036), (0.0, 0.040)]   # lens
    mats = ["paint_primary"] * 2 + ["chrome"] * 4 + ["lamp_head"] * 4
    if q["lamp"] >= 24:
        prof = [(0.132, -0.03), (0.127, 0.006), (0.113, 0.021), (0.099, 0.030), (0.089, 0.022),
                (0.074, 0.030), (0.045, 0.036), (0.0, 0.040)]
        mats = ["paint_primary", "chrome", "chrome", "chrome", "lamp_head", "lamp_head", "lamp_head"]
    elif q["lamp"] > 8:
        prof = [(0.128, -0.02), (0.122, 0.012), (0.098, 0.029), (0.086, 0.023), (0.0, 0.038)]
        mats = ["paint_primary", "chrome", "chrome", "lamp_head"]
    if q["lamp"] <= 8:
        prof = [(0.115, -0.01), (0.105, 0.025), (0.0, 0.034)]
        mats = ["chrome", "lamp_head"]
    lathe(mb, prof, q["lamp"], M, loc, mats)
    return loc + n * 0.04


def blinker(mb, S, x, z, q):
    loc, n = S.front(x, z)
    M = frame_from_axis(n)
    prof = [(0.056, -0.01), (0.055, 0.006), (0.048, 0.013), (0.032, 0.022), (0.0, 0.026)]
    mats = ["chrome", "chrome", "lamp_amber", "lamp_amber"]
    if q["lamp"] <= 20:
        prof, mats = [(0.052, -0.01), (0.048, 0.014), (0.0, 0.024)], ["chrome", "lamp_amber"]
    lathe(mb, prof, max(6, q["lamp"] * 3 // 5), M, loc, mats)


def taillight(mb, S, x, z, q):
    loc, n = S.rear(x, z)
    M = frame_from_axis(n)
    prof = [(0.055, -0.01), (0.054, 0.006), (0.050, 0.011), (0.047, 0.011), (0.034, 0.022), (0.0, 0.027)]
    mats = ["chrome", "chrome", "chrome", "lamp_tail", "lamp_tail"]
    Vl = M @ Vector((0, 1, 0))

    def mf(i, j, segs):
        if i < 3:
            return "chrome"
        t = 2 * pi * (j + 0.5) / segs
        return "lamp_amber" if math.sin(t) > 0.35 else "lamp_tail"
    # oval: local y (up) stretched
    Mo = frame_from_axis(n, up_hint=Vector((0, 0, 1)))
    if q["lamp"] <= 20:
        prof, mats = [(0.054, -0.01), (0.049, 0.012), (0.0, 0.024)], ["chrome", "lamp_tail"]
        mf = None if q["lamp"] <= 8 else (lambda i, j, segs: "chrome" if i == 0 else
                                          ("lamp_amber" if math.sin(2 * pi * (j + 0.5) / segs) > 0.35 else "lamp_tail"))
    lathe(mb, prof, max(8, q["lamp"] * 2 // 3), Mo, loc, mats, sx=1.0, sy=1.5, mat_fn=mf)
    return loc + n * 0.03


# --------------------------------------------------------------------------
# bumpers
# --------------------------------------------------------------------------
def bumper(mb, q, front=True):
    sgn = -1 if front else 1
    y_c = 2.105          # blade centre line at x = 0
    half = 0.865
    n = q["bumper_n"]
    xs = [-half + 2 * half * i / n for i in range(n + 1)]

    def yb(x):
        return sgn * (y_c - 0.20 * (abs(x) / half) ** 2.8)
    zc = 0.38 if front else 0.36
    prof = [(-0.020, 0.064), (-0.004, 0.068), (0.010, 0.066), (0.021, 0.058), (0.028, 0.045), (0.032, 0.024),
            (0.033, 0.0), (0.032, -0.024), (0.028, -0.045), (0.021, -0.058), (0.010, -0.066), (-0.004, -0.068),
            (-0.020, -0.064)]
    if q["bumper_n"] <= 12:
        prof = [(-0.02, 0.064), (0.018, 0.062), (0.033, 0.0), (0.018, -0.062), (-0.02, -0.064)]
    if q["bumper_n"] <= 8:
        prof = [(-0.02, 0.065), (0.03, 0.05), (0.03, -0.05), (-0.02, -0.065)]
    rings = []
    for x in xs:
        p = Vector((x, yb(x), zc))
        dx = 1e-3
        t = Vector((2 * dx, yb(x + dx) - yb(x - dx), 0)).normalized()
        o = Vector((t.y, -t.x, 0)) * (-sgn)       # outward (away from the car)
        if o.y * sgn < 0:
            o = -o
        rings.append([mb.v(p + o * d + Vector((0, 0, h))) for (d, h) in prof])
    n0 = mb.nfaces()
    for i in range(len(rings) - 1):
        for j in range(len(prof) - 1):
            mb.f([rings[i][j], rings[i + 1][j], rings[i + 1][j + 1], rings[i][j + 1]], "chrome")
    # rounded end caps
    for ri_, xe in ((0, xs[0]), (-1, xs[-1])):
        c = sum((v.co for v in rings[ri_]), Vector()) / len(prof)
        tip = mb.v(c + Vector((0.012 * (1 if xe > 0 else -1), 0.0, 0)))
        rr = rings[ri_]
        for j in range(len(prof) - 1):
            mb.f([rr[j], rr[j + 1], tip], "chrome")
    # back strip closing the C section (dark, hidden)
    for i in range(len(rings) - 1):
        mb.f([rings[i][-1], rings[i + 1][-1], rings[i + 1][0], rings[i][0]], "trim_dark")
    mb.recalc(n0)
    # over-riders (horns) and US towel bar
    hx = 0.49 if front else 0.505
    sides = q["tube"]
    for s in (1, -1):
        x = hx * s
        y0 = yb(x) + sgn * 0.012
        ztop = 0.61 if front else 0.60
        path = [(x, y0, zc - 0.07), (x, y0, zc + 0.05), (x, y0 + sgn * 0.004, ztop - 0.05),
                (x, y0 - sgn * 0.012, ztop - 0.012), (x, y0 - sgn * 0.035, ztop)]
        if q["bumper_n"] <= 8:
            path, radii = [path[0], path[2], path[4]], [0.031, 0.032, 0.025]
        elif q["bumper_n"] <= 12:
            path, radii = [path[0], path[2], path[3], path[4]], [0.030, 0.032, 0.029, 0.024]
        else:
            radii = [0.030, 0.033, 0.032, 0.029, 0.024]
        tube(mb, path, 0.033, sides, "chrome", radii=radii, cap_start=q["bumper_n"] > 8)
        if q["bumper_n"] > 12:
            # bracket to the body
            box(mb, (x * 0.93, sgn * (y_c - 0.06), zc - 0.01), (0.06, 0.08, 0.05), "trim_dark")
    if q["bumper_n"] <= 8:
        return
    zb = 0.545 if front else 0.53
    rb = 0.0155
    xo, xe = 0.745, 0.815
    if front:
        bar = [(xe, yb(xe) + sgn * 0.005, zc + 0.05), (xo + 0.02, yb(xo) + sgn * 0.012, zb - 0.02), (xo - 0.03, yb(xo - 0.03) + sgn * 0.014, zb)]
        stp = 0.1 if q["bumper_n"] > 12 else 0.245
        mid = [(hx - stp * k, yb(hx - stp * k) + sgn * 0.016, zb) for k in range(0, int(2 * hx / stp) + 1)]
        path = bar + [(x_, y_ + 0.0, z_) for (x_, y_, z_) in mid if x_ > -hx + 0.001] + [(-hx, yb(-hx) + sgn * 0.016, zb)]
        path += [(-p[0], p[1], p[2]) for p in reversed(bar)]
        tube(mb, path, rb, max(5, sides - 2), "chrome")
    else:
        for s in (1, -1):
            bar = [(s * xe, yb(xe) + sgn * 0.005, zc + 0.05), (s * (xo + 0.02), yb(xo) + sgn * 0.012, zb - 0.02),
                   (s * (xo - 0.03), yb(xo - 0.03) + sgn * 0.014, zb), (s * hx, yb(hx) + sgn * 0.016, zb)]
            tube(mb, bar, rb, max(6, sides - 2), "chrome")


# --------------------------------------------------------------------------
# wheel
# --------------------------------------------------------------------------
def build_wheel(q, name):
    mb = MB()
    M = Matrix(((0, 0, 1), (1, 0, 0), (0, 1, 0)))  # local Z (lathe axis) -> world X (axle)
    R = WR
    # 5.60-15 cross-ply: tread 0.104 m wide, sidewall r 0.192..0.3355; v2 whitewall r 0.212..0.272
    # (~41 % of the sidewall) with a black outer ring, painted rim, flat T1 hubcap with a lip
    if q["tire"] == "hi":
        prof = [(0.0, -0.062), (0.300, -0.084), (0.3355, -0.052),
                (0.3355, 0.052), (0.326, 0.074), (0.303, 0.0855), (0.272, 0.0885), (0.212, 0.0875),
                (0.203, 0.0845), (0.172, 0.0640), (0.142, 0.0650), (0.139, 0.0765),
                (0.124, 0.0860), (0.092, 0.0965), (0.050, 0.1025), (0.0, 0.1040)]
        mats = ["trim_dark", "rubber", "tread", "rubber", "rubber", "rubber", "wheel_white",
                "rubber", "rim_paint", "rim_paint", "chrome", "chrome", "hubcap", "hubcap", "hubcap"]
        uvb = {2: (0.0, 1.0)}
    elif q["tire"] == "mid":
        prof = [(0.0, -0.06), (0.300, -0.084), (0.3345, -0.052), (0.3345, 0.052), (0.300, 0.086),
                (0.272, 0.0885), (0.212, 0.0875), (0.172, 0.066), (0.142, 0.066), (0.100, 0.094), (0.0, 0.104)]
        mats = ["trim_dark", "rubber", "tread", "rubber", "rubber", "wheel_white", "rim_paint", "chrome",
                "hubcap", "hubcap"]
        uvb = {2: (0.0, 1.0)}
    else:
        prof = [(0.0, -0.06), (0.334, -0.06), (0.334, 0.06), (0.28, 0.085), (0.212, 0.088), (0.0, 0.10)]
        mats = ["rubber", "rubber", "rubber", "wheel_white", "chrome"]
        uvb = None
    assert len(mats) == len(prof) - 1, (len(mats), len(prof))
    lathe(mb, prof, q["wheel_segs"], M, Vector((0, 0, 0)), mats, uv_bands=uvb, uv_planar={"hubcap": HUB_R})
    return mb.obj(name, smooth_angle=40)


# --------------------------------------------------------------------------
# roof rack + surfboard (optional accessory)
# --------------------------------------------------------------------------
def build_surfboard(q, parent):
    mb = MB()
    sides = max(4, q["tube"] - 4)
    zbar = 1.995
    for yb in (-0.62, 0.98):
        # bar follows the roof cross-section 5 cm above the paint, clamps on the rain gutters
        path = []
        ts = [0.0, 0.3, 0.55, 0.8, 1.0] if q["surf_n"] > 8 else [0.0, 0.5, 1.0]
        half = []
        for t in ts:
            z_, A_, _, _ = roof_at(t)
            n_ = roof_side_normal(t)
            x = A_ + 0.045 * n_.x
            z = z_ + 0.045 * n_.z
            half.append((x, min(z, zbar)))
        half[-1] = (half[-1][0] - 0.05, zbar)
        path = [(x, yb, z) for (x, z) in half] + [(-x, yb, z) for (x, z) in reversed(half)]
        path = [(half[0][0] + 0.01, yb, 1.715)] + path + [(-half[0][0] - 0.01, yb, 1.715)]
        tube(mb, path, 0.0125, sides, "chrome")
        for s in (1, -1):
            if q["surf_n"] > 8:
                box(mb, (s * (half[0][0] + 0.004), yb, 1.718), (0.035, 0.05, 0.03), "trim_dark")
        if q["surf_n"] > 6:
            box(mb, (0.0, yb, zbar + 0.016), (0.50, 0.035, 0.012), "trim_dark")   # rubber pad under the board
    L, W, T = 2.75, 0.57, 0.075
    z0 = zbar + 0.022 + T / 2
    yc = 0.18
    NSb = q["surf_n"]
    ANG = [0, 40, 75, 86, 94, 105, 140, 180, 230, 310] if q["surf_n"] > 8 else (
        [0, 60, 80, 100, 120, 180, 270] if q["surf_n"] > 6 else [0, 75, 105, 180, 270])
    stations = []
    for i in range(NSb + 1):
        s_ = i / NSb                    # 0 = nose (front, -Y)
        y = yc - L / 2 + L * s_
        if s_ < 0.4:
            wv = W / 2 * math.sin(pi / 2 * (s_ / 0.4)) ** 0.55
        else:
            wv = W / 2 * (1 - 0.40 * ((s_ - 0.4) / 0.6) ** 2.2)
        wv = max(wv, 0.02)
        th = T * (0.55 + 0.45 * math.sin(pi * min(1, max(0.0, s_ * 1.05))) ** 0.5)
        rock = -0.06 * max(0.0, 1 - s_ / 0.22) ** 2      # nose rocker bends towards the roof (deck down)
        ring = []
        for deg in ANG:
            t = math.radians(deg)
            ring.append(mb.v((wv * math.cos(t), y, z0 + rock + th / 2 * math.sin(t) * (1.0 if math.sin(t) > 0 else 0.8))))
        stations.append(ring)
    stripe = {i for i, a in enumerate(ANG) if 70 < a < 110}
    n0 = mb.nfaces()
    mb.grid(stations, lambda i, j: "surf_stripe" if (j in stripe and (j + 1) % len(ANG) in stripe) else "surf_board", closed=True)
    mb.fan(stations[0], (0, yc - L / 2 - 0.01, z0 - 0.06), "surf_board", flip=True)
    mb.fan(stations[-1], (0, yc + L / 2 + 0.005, z0), "surf_board")
    mb.recalc(n0)
    # fin: at the tail (rear, +Y), pointing up, swept back towards the tail (v2: no "shark fin")
    yf, zf = yc + L / 2 - 0.20, z0 + T / 2 - 0.012
    fin = [(yf - 0.085, zf), (yf - 0.035, zf + 0.045), (yf + 0.025, zf + 0.090), (yf + 0.085, zf + 0.115),
           (yf + 0.072, zf + 0.080), (yf + 0.058, zf + 0.030), (yf + 0.050, zf)]
    n0 = mb.nfaces()
    nf = len(fin)
    fl = [mb.v((-0.004, y_, z_)) for y_, z_ in fin]
    fr = [mb.v((0.004, y_, z_)) for y_, z_ in fin]
    for k in range(1, nf - 1):                  # triangle fans (the outline is concave)
        mb.f([fl[0], fl[k + 1], fl[k]], "surf_stripe")
        mb.f([fr[0], fr[k], fr[k + 1]], "surf_stripe")
    for k in range(nf):
        mb.f([fl[k], fl[(k + 1) % nf], fr[(k + 1) % nf], fr[k]], "surf_stripe")
    mb.recalc(n0, soft=False)
    # two straps
    if q["surf_n"] > 8:
        for ys in (-0.62 + 0.06, 0.98 - 0.06):
            s_ = (ys - (yc - L / 2)) / L
            wv = W / 2 * (math.sin(pi / 2 * (s_ / 0.4)) ** 0.55 if s_ < 0.4 else (1 - 0.40 * ((s_ - 0.4) / 0.6) ** 2.2))
            box(mb, (0, ys, z0 + T / 2 + 0.002), (wv * 2 + 0.01, 0.035, 0.004), "trim_dark")
    o = mb.obj("accessory_surfboard", smooth_angle=50, parent=parent)
    o["default_visible"] = False
    o["role"] = "accessory"
    return o


# --------------------------------------------------------------------------
# details on the shell
# --------------------------------------------------------------------------
WINDOW_Z = (1.318, 1.690)
SIDE_WINDOWS = [(-0.684, -0.205), (-0.100, 0.379), (0.477, 0.955), (1.054, 1.540)]
WS_Z = (1.300, 1.735)          # v2: split windshield taller (top ~8 cm below the roof edge line)
N_SKY = int(OPT.get("skylights", 4))   # real 23-window Samba: 4 per side (blueprint 5, target 6)


def side_normal(s, z):
    A0, _, _ = row_at(z - 0.05)
    A1, _, _ = row_at(z + 0.05)
    slope = (A1 - A0) / 0.1
    return Vector((s * 1.0, 0, -slope)).normalized()   # outward, tilted up by the tumblehome


def sky_t():
    """roof-curve parameter where the surface normal is ~42 deg above horizontal"""
    best, bt = 9, 0.4
    for i in range(1, 100):
        t = i / 100
        n = roof_side_normal(t)
        e = abs(math.degrees(math.atan2(n.z, n.x)) - 42)
        if e < best:
            best, bt = e, t
    return bt


def skylight_spans():
    if N_SKY == 4:
        return SIDE_WINDOWS
    y0, y1 = SIDE_WINDOWS[0][0] - 0.55, SIDE_WINDOWS[-1][1]
    w = (y1 - y0) / N_SKY
    return [(y0 + k * w + 0.05, y0 + (k + 1) * w - 0.05) for k in range(N_SKY)]


def bench(mb, x0, x1, y_front, depth, z_seat, back_h, rake=0.12, mat="seat", q_int_hi=True):
    """bench seat: cushion + raked backrest (two boxes each, slightly rounded by a bevel ring)"""
    cx = (x0 + x1) / 2
    w = x1 - x0
    box(mb, (cx, y_front + depth / 2, z_seat - 0.05), (w, depth, 0.12), mat)
    # backrest: raked box behind the cushion
    M = Matrix.Rotation(-rake, 3, "X")
    box(mb, (cx, y_front + depth + 0.03 + back_h / 2 * math.sin(rake), z_seat + back_h / 2), (w, 0.10, back_h), mat, M=M)
    if q_int_hi:
        box(mb, (cx, y_front + depth / 2, z_seat - 0.20), (w * 0.9, depth * 0.8, 0.18), "floor")


def build_interior_furniture(mb, q):
    """low-poly cabin seen through the glass: dash, steering wheel, three benches"""
    # dashboard (body coloured top like the real T1) + dark lower panel
    yd = -1.70
    box(mb, (0, yd + 0.10, 1.215), (1.40, 0.20, 0.07), "paint_secondary")
    box(mb, (0, yd + 0.13, 1.08), (1.36, 0.10, 0.20), "interior")
    for s in (1, -1):                                             # round instrument / glovebox
        loc = Vector((s * 0.40, yd + 0.20, 1.12))
        lathe(mb, [(0.0, 0.0), (0.065, 0.0), (0.065, 0.012), (0.0, 0.012)], q["int_seg"],
              frame_from_axis(Vector((0, 1, 0.3))), loc, ["trim_dark", "chrome", "trim_dark"])
    # steering wheel (left-hand drive -> driver at +X), big thin ivory rim, steep column
    c = Vector((0.40, -1.36, 1.22))
    ax = Vector((0, 0.45, 1.0)).normalized()                     # wheel axis (towards the driver / up)
    Mw = frame_from_axis(ax)
    segs = q["int_seg"] * 2
    rim = [c + Mw @ Vector((0.20 * math.cos(2 * pi * k / segs), 0.20 * math.sin(2 * pi * k / segs), 0)) for k in range(segs)]
    tube(mb, rim, 0.012, 5 if q["int_seg"] > 8 else 4, "ivory", closed=True)
    for a in (pi / 2 + 0.3, pi / 2 - 0.3 + pi):
        tube(mb, [c, c + Mw @ Vector((0.19 * math.cos(a), 0.19 * math.sin(a), 0))], 0.009, 4, "ivory",
             cap_start=False, cap_end=False)
    tube(mb, [c - ax * 0.02, c - ax * 0.55], 0.02, 5, "trim_dark", cap_start=False)
    # benches: cab bench, middle bench, rear bench over the engine
    hi = q["int_seg"] > 8
    bench(mb, -0.74, 0.74, -1.30, 0.42, 0.80, 0.52, q_int_hi=hi)
    bench(mb, -0.72, 0.30, -0.35, 0.44, 0.80, 0.48, q_int_hi=hi)
    bench(mb, -0.72, 0.72, 0.55, 0.44, 0.90, 0.38, q_int_hi=hi)
    # bulkhead behind the cab bench (low partition)
    box(mb, (0, -0.78, 0.95), (1.50, 0.04, 0.34), "interior")
    # luggage deck over the engine, seen through the rear window from the chase camera
    box(mb, (0, 1.53, 0.99), (1.50, 0.78, 0.04), "interior")


def build_details(S, q, specs):
    mb = MB()
    sockets = {}
    # ---------------- windows ----------------
    z0, z1 = WINDOW_Z
    zc = (z0 + z1) / 2
    for s in (1, -1):
        N = side_normal(s, zc)
        for (ya, yb_) in SIDE_WINDOWS:
            O, _ = S.side(s, (ya + yb_) / 2, zc)
            pane(mb, S, O, N, [(s * 0.9, ya, z0), (s * 0.9, yb_, z0), (s * 0.9, yb_, z1), (s * 0.9, ya, z1)], 0.05, q)
        # cab door window incl. vent wing: one opening, raked front edge along the A pillar
        O, _ = S.side(s, -1.20, zc)
        pane(mb, S, O, N, [(s * 0.9, -1.625, z0), (s * 0.9, -0.84, z0), (s * 0.9, -0.84, z1), (s * 0.9, -1.515, z1)],
             [0.03, 0.045, 0.045, 0.05], q)
        if q["vent_bar"]:                                         # vent wing divider
            a, na = S.side(s, -1.455, z0 + 0.024)
            b, nb = S.side(s, -1.372, z1 - 0.024)
            tube(mb, [a + na * 0.0055, b + nb * 0.0055], 0.0058, q["vent_bar"], "chrome")
        # rear corner window: wraps from the side (y ~ 1.69) around to x ~ 0.57 on the rear
        sa = sr_at(zc, lambda p: p.x >= 0.575)
        sb = sr_at(zc, lambda p: p.y <= 1.695)
        ring_pane(mb, S, s, [(sa, z0), (sb, z0), (sb, z1), (sa, z1)], 0.05, q)
        # skylights (opaque dark glass) curving with the roof edge
        if q["skylights"]:
            ts = sky_t()
            zt, At, _, _ = roof_at(ts)
            Ns = roof_side_normal(ts, s)
            Vs = Vector((-s * abs(Ns.z), 0, abs(Ns.x))).normalized()      # up the roof, in the surface
            hh = 0.068
            for (ya, yb_) in skylight_spans():
                O, _ = S.ray(Vector((s * At, (ya + yb_) / 2, zt)) + Ns * 0.5, -Ns)
                corners = [O + Vector((0, ya + 0.012 - O.y, 0)) - Vs * hh, O + Vector((0, yb_ - 0.012 - O.y, 0)) - Vs * hh,
                           O + Vector((0, yb_ - 0.012 - O.y, 0)) + Vs * hh, O + Vector((0, ya + 0.012 - O.y, 0)) + Vs * hh]
                pane(mb, S, O, Ns, corners, 0.035, q, up=Vector((0, 0, 1)), small=True, cut=False,
                     grings=1 if q["sky_curved"] else 0, curved=q["sky_curved"])
        if q["seams"]:
            for (ya, yb_) in SIDE_WINDOWS[:2]:                      # sliding-window dividers
                ym = (ya + yb_) / 2 + 0.03
                a, na = S.side(s, ym, z0 + 0.022)
                b, nb = S.side(s, ym, z1 - 0.022)
                tube(mb, [a + na * 0.005, b + nb * 0.005], 0.0055, 4, "chrome", cap_start=False, cap_end=False)
            for zh in (0.93, 1.17):                                 # cab door hinges at the front edge
                loc, n = S.side(s, -1.628, zh)
                tube(mb, [loc - Vector((0, 0, 0.035)), loc + n * 0.009 - Vector((0, 0, 0.02)),
                          loc + n * 0.009 + Vector((0, 0, 0.02)), loc + Vector((0, 0, 0.035))], 0.011, 6, "chrome")
    mb.part("windows_side")
    # windshield (split, v2 taller) + rear window
    for s in (1, -1):
        O, N = S.front(s * 0.34, 1.52)
        N = Vector((N.x * 0.5, N.y, N.z)).normalized()
        pane(mb, S, O, N, [(s * 0.035, O.y, WS_Z[0]), (s * 0.665, O.y, WS_Z[0]), (s * 0.60, O.y, WS_Z[1]),
                           (s * 0.035, O.y, WS_Z[1])], [0.035, 0.09, 0.11, 0.035], q, grings=0 if q["holes"] else 2,
             curved=not q["holes"] and q["seal"] < 3)
    O, N = S.rear(0, 1.49)
    pane(mb, S, O, N, [(-0.41, O.y, 1.318), (0.41, O.y, 1.318), (0.41, O.y, 1.665), (-0.41, O.y, 1.665)], 0.055, q,
         grings=0 if q["holes"] else 1, curved=not q["holes"] and q["seal"] < 3)
    mb.part("windows_front_rear")

    # ---------------- V swage bead + chrome belt loop ----------------
    if q["strips"]:
        arm = [Vector((x, -3, z)) for (x, z) in v_pts(q["strip_arm"])]
        arm[-1] = Vector((V_X, -3, 1.2535))
        BEAD = 0.0075                                     # v3: taller, crisper swage (was 5.5 mm)
        if q["bead"]:
            for sgn in (1, -1):
                pts, nrms = [], []
                for p in arm[:-1] + [Vector((V_X, -3, BELT - 0.004))]:
                    loc, n = S.ray(Vector((p.x * sgn, -4, p.z - 0.004)), (0, 1, 0))
                    pts.append(loc)
                    nrms.append(n)
                n0 = mb.nfaces()
                prof = [(-0.032, -0.0015), (-0.019, 0.0026), (-0.008, 0.0064), (0.0, BEAD), (0.008, 0.0064),
                        (0.019, 0.0026), (0.032, -0.0015)] if q["bead"] == "hi" else \
                       [(-0.028, -0.0015), (-0.010, 0.0058), (0.0, BEAD), (0.010, 0.0058), (0.028, -0.0015)]
                strip(mb, pts, nrms, prof, "paint_primary")
                iS = mb.mi("paint_secondary")
                for fc in mb.faces_since(n0):
                    c = fc.calc_center_median()
                    if c.z > z_v(c.x) + 1e-4:
                        fc.material_index = iS
                mb.recalc(n0)
            mb.part("v_bead")
        A, F, R, bF, nF, bR, nR = ring_params(1.2535, q)
        qq = dict(q, nqF=q["strip_nq"], nqR=q["strip_nq"], nS=2)
        ol = outline(A, F, R, bF, nF, bR, nR, qq)
        k0 = next(i for i, p in enumerate(ol) if p.x >= V_X)
        k1 = max(i for i, p in enumerate(ol) if p.x <= -V_X and p.y < 0)
        belt = [Vector((p.x, p.y, 1.2535)) for p in ol[k0:k1 + 1]]
        loop = []
        for p in arm[:-1]:                    # tip -> left corner
            loop.append(("f", p))
        for p in belt:
            loop.append(("n", p))
        for p in reversed(arm[1:-1]):         # right corner -> tip
            loop.append(("f", Vector((-p.x, p.y, p.z))))
        pts, nrms = [], []
        for kind, p in loop:
            if kind == "f":
                loc, n = S.ray(Vector((p.x, -4, p.z - 0.004)), (0, 1, 0))
                if q["bead"]:
                    loc = loc + n * (BEAD - 0.0015)          # chrome sits on the bead crest
            else:
                loc, n = S.near(p)
            pts.append(loc)
            nrms.append(n)
        prof = [(-0.012, -0.001), (-0.0105, 0.0045), (-0.005, 0.0072), (0.005, 0.0072), (0.0105, 0.0045), (0.012, -0.001)]
        if q["strip_nq"] < 8:
            prof = [(-0.011, 0.0), (0.0, 0.007), (0.011, 0.0)]
        strip(mb, pts, nrms, prof, "chrome", closed=True)
        mb.part("belt_trim")
        # rocker trim between the wheel arches
        for s in (1, -1):
            pts, nrms = [], []
            for i in range(9):
                y = -0.76 + 1.53 * i / 8
                loc, n = S.side(s, y, 0.418)
                pts.append(loc)
                nrms.append(n)
            strip(mb, pts, nrms, [(-0.009, -0.001), (-0.006, 0.005), (0.006, 0.005), (0.009, -0.001)]
                  if q["strip_nq"] >= 8 else [(-0.009, -0.001), (0.0, 0.005), (0.009, -0.001)], "chrome")
        # rain gutter (sides + over the windshield)
        A, F, R, bF, nF, bR, nR = ring_params(1.705, q)
        ol = outline(A, F, R, bF, nF, bR, nR, dict(q, nqF=q["strip_nq"], nqR=4, nS=4))
        lim = R - bR + 0.02
        half = len(ol) // 2
        leftp = [p for p in ol[:half + 1] if p.y < lim]
        rightp = [Vector((-p.x, p.y)) for p in leftp[1:]]
        path = list(reversed(rightp)) + leftp
        pts, nrms = [], []
        for p in path:
            zz = 1.712 if p.y > -F + bF * 0.5 else 1.748      # rises over the (taller) windshield
            loc, n = S.near(Vector((p.x, p.y, zz)))
            pts.append(loc)
            nrms.append(n)
        gp = [(-0.010, -0.001), (-0.010, 0.010), (-0.002, 0.014), (0.009, 0.006), (0.010, -0.001)] if q["strip_nq"] >= 8 \
            else [(-0.010, -0.001), (-0.006, 0.013), (0.010, -0.001)]
        strip(mb, pts, nrms, gp, "paint_secondary")
        mb.part("rocker_gutter")
        # wheel arch lips
        for s in (1, -1):
            for ya in (AXLE_F, AXLE_R):
                pts, nrms = [], []
                th0 = math.asin((0.345 - ARCH_ZC) / (ARCH_R + 0.012))
                na_ = q["arch_n"]
                for i in range(na_ + 1):
                    th = th0 + (pi - 2 * th0) * i / na_
                    y = ya + (ARCH_R + 0.012) * math.cos(th)
                    z = ARCH_ZC + (ARCH_R + 0.012) * math.sin(th)
                    loc, n = S.side(s, y, z)
                    pts.append(loc)
                    nrms.append(n)
                strip(mb, pts, nrms, [(-0.014, -0.001), (-0.009, 0.004), (0.004, 0.005), (0.012, -0.001)], "paint_primary")
        mb.part("arch_lips")

    # ---------------- lamps ----------------
    for s in (1, -1):
        sockets["socket_headlight_" + ("l" if s > 0 else "r")] = headlight(mb, S, s * 0.545, 0.775, q)
        if q["lamp"] > 8:
            blinker(mb, S, s * 0.625, 1.005, q)
        sockets["socket_taillight_" + ("l" if s > 0 else "r")] = taillight(mb, S, s * 0.635, 0.705, q)
    mb.part("lamps")

    # ---------------- VW emblems ----------------
    O, N = S.front(0, 1.02)
    build_logo(mb, O + N * 0.004, N, 0.158, q)
    if q["rear_logo"]:
        O, N = S.rear(0, 1.14)
        build_logo(mb, O + N * 0.003, N, 0.072, dict(q, logo_seg=max(12, q["logo_seg"] // 2)))
    if q["plate"]:
        O, N = S.rear(0, 0.64)
        N = Vector((N.x, N.y, 0)).normalized()
        U = Vector((0, 0, 1)).cross(N).normalized()
        V = N.cross(U).normalized()
        w, h = 0.305, 0.152
        base = O + N * 0.006
        if q["plate"] is True:     # textured (atlas plate region)
            vs = [mb.v(base + U * (sx * w / 2) + V * (sy * h / 2)) for (sx, sy) in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
            fc = mb.f(vs, "plate")
            # U = up x N points to the viewer's right when seen from behind -> u follows U
            mb.set_uv(fc, vs, [(0, 0), (1, 0), (1, 1), (0, 1)])
        else:
            box(mb, base - N * 0.002, (w, 0.006, h), "trim_dark", M=Matrix((U, N, Vector((0, 0, 1)))).transposed())
        box(mb, O + N * 0.02 + Vector((0, 0, 0.106)), (0.13, 0.04, 0.035), "chrome", M=Matrix((U, N, Vector((0, 0, 1)))).transposed())
    mb.part("logos_plate")

    # ---------------- bumpers ----------------
    bumper(mb, q, front=True)
    bumper(mb, q, front=False)
    mb.part("bumpers")

    # ---------------- mirrors, wipers, handles ----------------
    if q["mirrors"]:
        for s in (1, -1):
            base, n = S.side(s, -1.655, 1.215)
            p1 = base + Vector((s * 0.05, -0.012, 0.055))
            head = base + Vector((s * 0.10, -0.03, 0.105))       # v2: shorter, sturdier arm
            tube(mb, [base - Vector((s * 0.01, 0, 0)), p1, head], 0.0115, max(5, q["tube"] - 3), "chrome")
            M = frame_from_axis(Vector((0.18 * s, 1, 0)))
            prof = [(0.0, -0.016), (0.040, -0.013), (0.057, -0.005), (0.059, 0.004), (0.054, 0.008), (0.0, 0.008)]
            if q["lamp"] <= 20:
                prof = [(0.0, -0.016), (0.052, -0.010), (0.059, 0.004), (0.0, 0.008)]
            lathe(mb, prof, max(12, q["lamp"] * 2 // 3), M, head + Vector((0, 0.01, 0)), ["chrome"] * (len(prof) - 1))
    if q["wipers"]:
        for s in (1, -1):
            a, na = S.front(s * 0.42, 1.30)
            b, nb = S.front(s * 0.60, 1.58)
            a, b = a + na * 0.010, b + nb * 0.012
            tube(mb, [a, a.lerp(b, 0.5) + na * 0.003, b], 0.0032, 4, "trim_dark")      # v2: thin arm
            c1, c2 = a.lerp(b, 0.25) + na * 0.004, b + nb * 0.001
            tube(mb, [c1, c2], 0.0038, 4, "rubber", up=na)                               # blade
            box(mb, a - na * 0.004, (0.016, 0.016, 0.016), "chrome")
    if q["handles"]:
        hs = [(1, -0.87), (-1, -0.87), (-1, -0.18), (-1, -0.12)]
        for s, y in hs:
            loc, n = S.side(s, y, 1.06)
            p0, p1 = loc + n * 0.012 + Vector((0, -0.055, 0)), loc + n * 0.012 + Vector((0, 0.055, 0))
            tube(mb, [loc + Vector((0, -0.06, 0)) - n * 0.002, p0, p1, loc + Vector((0, 0.06, 0)) - n * 0.002],
                 0.008, 6, "chrome")
        loc, n = S.rear(0, 0.885)
        tube(mb, [loc + Vector((-0.05, 0, 0)) - n * 0.002, loc + Vector((-0.045, 0, 0)) + n * 0.014,
                  loc + Vector((0.045, 0, 0)) + n * 0.014, loc + Vector((0.05, 0, 0)) - n * 0.002], 0.0085, 6, "chrome")
    mb.part("mirrors_wipers_handles")

    # ---------------- panel seams ----------------
    if q["seams"] == "rear":
        Y = Vector((0, 1, 0))
        for poly in ([(-0.49, 0.965), (0.49, 0.965), (0.49, 1.70), (-0.49, 1.70), (-0.49, 0.965)],
                     [(-0.49, 0.47), (0.49, 0.47), (0.49, 0.93), (-0.49, 0.93), (-0.49, 0.47)]):
            seam(mb, S, [(x, 1.9, z) for (x, z) in poly], Y, width=0.005, seg=0.5)
        mb.part("seams")
    elif q["seams"]:
        Rd = ARCH_R + 0.045
        yb = -0.790
        zr = ARCH_ZC + math.sqrt(max(Rd ** 2 - (yb - AXLE_F) ** 2, 0.0))
        a_r = math.atan2(zr - ARCH_ZC, yb - AXLE_F)
        zf_ = 0.62
        a_f = math.atan2(zf_ - ARCH_ZC, -math.sqrt(Rd ** 2 - (zf_ - ARCH_ZC) ** 2))
        arc = [(AXLE_F + Rd * math.cos(a_r + (a_f - a_r) * k / 12), ARCH_ZC + Rd * math.sin(a_r + (a_f - a_r) * k / 12))
               for k in range(13)]
        for s in (1, -1):
            X = Vector((s, 0, 0))
            # v2: cab door runs down to the sill and wraps the front wheel arch
            door = [(-1.642, 0.68), (-1.645, 1.26), (-1.60, 1.40), (-1.515, 1.705), (yb, 1.705)] + arc + [(-1.642, 0.68)]
            seam(mb, S, [(s * 0.8, y, z) for (y, z) in door], X)
            if s < 0:   # cargo double doors on the right (kerb) side
                cd = [(-0.735, 0.40), (-0.735, 1.705), (0.43, 1.705), (0.43, 0.40)]
                seam(mb, S, [(s * 0.8, y, z) for (y, z) in cd + [cd[0]]], X)
                seam(mb, S, [(s * 0.8, -0.155, 0.40), (s * 0.8, -0.155, 1.705)], X)
                for yh in (-0.70, 0.395):                        # cargo door hinges
                    for zh in (0.62, 1.10):
                        loc, n = S.side(s, yh, zh)
                        tube(mb, [loc - Vector((0, 0, 0.03)), loc + n * 0.008 - Vector((0, 0, 0.018)),
                                  loc + n * 0.008 + Vector((0, 0, 0.018)), loc + Vector((0, 0, 0.03))], 0.009, 5, "chrome")
        Y = Vector((0, 1, 0))
        hatch = [(-0.49, 0.965), (0.49, 0.965), (0.49, 1.70), (-0.49, 1.70), (-0.49, 0.965)]
        seam(mb, S, [(x, 1.9, z) for (x, z) in hatch], Y)
        lid = [(-0.49, 0.47), (0.49, 0.47), (0.49, 0.93), (-0.49, 0.93), (-0.49, 0.47)]
        seam(mb, S, [(x, 1.9, z) for (x, z) in lid], Y)
        # fuel flap (right rear quarter)
        fl = [(-1, 1.48 + 0.055 * math.cos(2 * pi * k / 12), 1.07 + 0.055 * math.sin(2 * pi * k / 12)) for k in range(13)]
        seam(mb, S, [(-0.8, y, z) for (_, y, z) in fl], Vector((-1, 0, 0)), seg=0.1)
        mb.part("seams")

    # ---------------- engine louvers (both rear quarters) ----------------
    if q["louvers"]:
        for s in (1, -1):
            for k in range(8):
                z = 0.865 + 0.042 * k
                pts, nrms = [], []
                for i in (range(4) if s > 0 else range(3, -1, -1)):   # keeps the slit below the bump on both sides
                    loc, n = S.side(s, 1.285 + 0.29 * i / 3, z)
                    pts.append(loc)
                    nrms.append(n)
                if q["louvers"] == "hi":
                    strip(mb, pts, nrms, [(-0.011, 0.0005), (-0.004, 0.0065), (0.006, 0.0055), (0.011, 0.0005)], "paint_primary")
                    strip(mb, pts, nrms, [(-0.0155, 0.0006), (-0.0105, 0.0006)], "trim_dark")
                else:
                    strip(mb, pts, nrms, [(-0.012, 0.001), (0.004, 0.001)], "trim_dark")
        mb.part("louvers")

    # ---------------- canvas sunroof ----------------
    if q["sunroof"]:
        yA, yB, xw = -1.02, 0.50, 0.50
        nx = 6 if q["sunroof"] == "hi" else 2
        ny = 8 if q["sunroof"] == "hi" else 2
        grid_ = []
        for j in range(ny + 1):
            y = yA + (yB - yA) * j / ny
            row = []
            for i in range(nx + 1):
                x = -xw + 2 * xw * i / nx
                loc, n = S.ray((x, y, 3.0), (0, 0, -1))
                row.append(mb.v(loc + n * 0.006))
            grid_.append(row)
        for j in range(ny):
            for i in range(nx):
                mb.f([grid_[j][i], grid_[j][i + 1], grid_[j + 1][i + 1], grid_[j + 1][i]], "canvas")
        fr = [(-xw - 0.02, yA - 0.02), (xw + 0.02, yA - 0.02), (xw + 0.02, yB + 0.02), (-xw - 0.02, yB + 0.02), (-xw - 0.02, yA - 0.02)]
        dense = []
        for (xa, ya_), (xb, yb2) in zip(fr, fr[1:]):
            m = 6 if q["sunroof"] == "hi" else 2
            for k in range(m):
                dense.append(Vector((xa + (xb - xa) * k / m, ya_ + (yb2 - ya_) * k / m, 3.0)))
        pts, nrms = [], []
        for p in dense:
            loc, n = S.ray(p, (0, 0, -1))
            pts.append(loc)
            nrms.append(n)
        strip(mb, pts, nrms, [(-0.016, 0.0), (-0.012, 0.008), (0.012, 0.008), (0.016, 0.0)], "rubber", closed=True)
        if q["sunroof"] == "hi":     # canvas bows
            for yk in (-0.72, -0.42, -0.12, 0.18):
                bow = []
                for x in (-xw, -xw / 2, 0.0, xw / 2, xw):
                    loc, n = S.ray((x, yk, 3.0), (0, 0, -1))
                    bow.append(loc + n * 0.007)
                tube(mb, bow, 0.006, 5, "canvas", cap_start=False, cap_end=False)
        # v2: flat folded canvas at the rear edge (elliptic, top ~3 cm above the roof -> 1.97 m)
        rl, rn = S.ray((0, yB - 0.07, 3.0), (0, 0, -1))
        roll = []
        for x in (-xw + 0.03, -0.25, 0.0, 0.25, xw - 0.03):
            loc, n = S.ray((x, rl.y, 3.0), (0, 0, -1))
            roll.append(Vector((x, rl.y, loc.z + 0.012)))
        nv0 = len(mb.bm.verts)
        tube(mb, roll, 0.034, max(6, q["tube"]), "canvas", radii=[0.026, 0.033, 0.035, 0.033, 0.026])
        mb.bm.verts.ensure_lookup_table()
        for k in range(nv0, len(mb.bm.verts)):
            v = mb.bm.verts[k]
            zc_ = min(roll, key=lambda p: abs(p.x - v.co.x)).z
            v.co.z = zc_ + (v.co.z - zc_) * 0.5
        mb.part("sunroof")

    # ---------------- rear: exhaust, underbody ----------------
    if q["under"] == "lo":
        box(mb, (0, 1.93, 0.30), (0.80, 0.18, 0.14), "trim_dark")         # silencer
        tube(mb, [(0.18, 1.96, 0.26), (0.18, 2.13, 0.25)], 0.021, 5, "chrome")
        mb.part("underbody")
    elif q["under"]:
        box(mb, (0, 1.45, 0.34), (0.95, 0.75, 0.16), "trim_dark")         # engine / gearbox
        box(mb, (0, 1.93, 0.30), (0.80, 0.18, 0.14), "trim_dark")         # silencer
        tube(mb, [(0.18, 1.96, 0.26), (0.18, 2.06, 0.255), (0.18, 2.13, 0.25)], 0.021, 8, "chrome")
        for ya in (AXLE_F - 0.06, AXLE_F + 0.06):                          # front torsion bar tubes
            tube(mb, [(-0.60, ya, 0.305), (0.60, ya, 0.305)], 0.033, 6, "trim_dark")
        for s in (1, -1):                                                   # rear swing axles + drums
            tube(mb, [(0.0, AXLE_R, 0.34), (s * 0.55, AXLE_R, WR)], 0.04, 6, "trim_dark")
        for s in (1, -1):                                                   # brake drums / backing plates
            for ya in (AXLE_F, AXLE_R):
                M = Matrix(((0, 0, 1), (1, 0, 0), (0, 1, 0)))
                lathe(mb, [(0.0, 0.0), (0.12, 0.0), (0.125, 0.06), (0.0, 0.06)], 10, M,
                      Vector((s * (TRACK_F / 2 - 0.16), ya, WR)), ["trim_dark"] * 3)
        box(mb, (0, -0.25, 0.30), (1.0, 2.6, 0.04), "trim_dark")         # floor pan / frame
        mb.part("underbody")
    sockets["socket_exhaust"] = Vector((0.18, 2.14, 0.25))

    # ---------------- cabin + contact-shadow blob ----------------
    if q["interior"]:
        build_interior_furniture(mb, q)
        mb.part("interior_furniture")
    if q["blob"]:
        vs = [mb.v((sx * 1.22, sy * 2.55, 0.012)) for (sx, sy) in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        fc = mb.f(vs, "blob")
        mb.set_uv(fc, vs, [(0, 0), (1, 0), (1, 1), (0, 1)])
        mb.part("shadow_blob")
    return mb, sockets


def build_inner_shell(q):
    """closed, coarse inner solid 4.5 cm inside the paint (floor, walls, headliner); gets the same
    window cutters as the body, then its normals are flipped so it faces into the cabin."""
    mb = MB()
    d = 0.045
    specs = []
    for z in q["int_rows"]:
        A, F, R = row_at(z)
        s = shape_params(z)
        specs.append((z, A - d, F - d, R - d, s["bF"], s["nF"], s["bR"], s["nR"]))
    for t in q["int_roof"]:
        z, A, F, R = roof_at(t)
        s = shape_params(ROOF_Z0)
        specs.append((z - d, A - d * (1.0 - 0.3 * t), F - d, R - d, s["bF"], s["nF"], s["bR"], s["nR"]))
    qq = dict(nqF=q["int_nq"], nqR=q["int_nq"], nS=q["int_nS"])
    rings = [[mb.v((p.x, p.y, z)) for p in outline(A, F, R, bF, nF, bR, nR, qq)] for (z, A, F, R, bF, nF, bR, nR) in specs]
    mb.grid(rings, lambda i, j: "interior", closed=True)
    top, bot = specs[-1], specs[0]
    mb.fan(rings[-1], (0, (top[3] - top[2]) / 2 * 0.3, top[0] + 0.006), "headliner")
    mb.fan(rings[0], (0, (bot[3] - bot[2]) / 2, bot[0]), "floor", flip=True)
    bmesh.ops.recalc_face_normals(mb.bm, faces=mb.bm.faces)
    return mb


# --------------------------------------------------------------------------
# LOD settings
# --------------------------------------------------------------------------
Q = {
    # v2: every LOD uses the atlas (paint_primary, paint_secondary, bulli_atlas, glass -> <= 8 calls incl.
    # the 4 wheels); LOD0/1 get window openings + a cabin, LOD2 keeps opaque glass and merges the wheels.
    0: dict(nqF=14, nqR=12, nS=6, rows=None, roof=[0.08, 0.17, 0.27, 0.38, 0.5, 0.62, 0.74, 0.87, 1.0],
            crown=[(0.72, 0.0135), (0.40, 0.019)], seal=3, glass_rings=2, nc=3, maxseg=0.28, sky_nc=1,
            skylights=True, sky_curved=True, strips=True, strip_nq=12, strip_arm=14, v_n=12, arch_n=18, lamp=28, logo_seg=32,
            logo_strokes=True, rear_logo=True, wheel_segs=48, tire="hi", seams=True, louvers="hi",
            bumper_n=16, tube=8, mirrors=True, wipers=True, handles=True, sunroof="hi", under=True, plate=True,
            surf_n=12, holes=True, vent_bar=6, bead="hi", interior=True, blob=True, arch_segs=48,
            corner_seg=0.13, corner_rings=2,
            int_rows=[0.47, 0.85, 1.20, 1.40, 1.58, 1.70], int_roof=[0.5, 1.0], int_nq=5, int_nS=4, int_seg=10,
            merge_wheels=False),
    1: dict(nqF=6, nqR=5, nS=2, rows=[0, 2, 4, 7, 11, 13, 14, 15, 17, 19, 21], roof=[0.25, 0.55, 1.0],
            crown=[(0.5, 0.017)], seal=1, glass_rings=0, nc=2, maxseg=0.9, sky_nc=1,
            skylights=True, sky_curved=False, strips=True, strip_nq=6, strip_arm=7, v_n=7, arch_n=12, lamp=20, logo_seg=20,
            logo_strokes=True, rear_logo=False, wheel_segs=22, tire="mid", seams="rear", louvers="lo",
            bumper_n=10, tube=6, mirrors=True, wipers=False, handles=False, sunroof="lo", under="lo", plate=True,
            surf_n=6, holes=True, vent_bar=0, bead="lo", interior=True, blob=True, arch_segs=32,
            corner_seg=0.25, corner_rings=1, cut_nc=1, cut_maxseg=2.0,
            int_rows=[0.47, 1.20, 1.70], int_roof=[1.0], int_nq=3, int_nS=2, int_seg=6,
            merge_wheels=False),
    2: dict(nqF=4, nqR=3, nS=1, rows=[0, 2, 6, 10, 13, 14, 17, 21], roof=[0.4, 1.0], crown=[],
            seal=0, glass_rings=1, nc=1, maxseg=2.0, sky_nc=1,
            skylights=False, sky_curved=False, strips=False, strip_nq=4, strip_arm=2, v_n=4, arch_n=4, lamp=8, logo_seg=8,
            logo_strokes=False, rear_logo=False, wheel_segs=10, tire="lo", seams=False, louvers=False,
            bumper_n=6, tube=4, mirrors=False, wipers=False, handles=False, sunroof=None, under=False, plate=False,
            surf_n=5, holes=False, vent_bar=0, bead=False, interior=False, blob=False, arch_segs=12,
            corner_seg=0.2, corner_rings=1, merge_wheels=True),
}


# --------------------------------------------------------------------------
# assemble one LOD
# --------------------------------------------------------------------------
REGION_MATS = ("tread", "plate", "hubcap")
ATLAS_NAME = ["bulli_atlas"]
GLASSY = ("glass", "blob")
INTERIOR_MATS = ("interior", "headliner", "floor", "seat", "ivory")


def atlasify(o):
    """v2: paint_primary / paint_secondary keep their own clearcoat materials, glass + blob share the
    transparent 'glass' material, everything else goes onto bulli_atlas (palette cell or UV region)."""
    me = o.data
    names = [m.name for m in me.materials]
    used = {names[p.material_index] for p in me.polygons}
    keep = [n for n in ("paint_primary", "paint_secondary") if n in used]
    new_names = list(keep)
    AT = ATLAS_NAME[0]
    if any(n not in keep and n not in GLASSY for n in used):
        new_names.append(AT)
    if any(n in GLASSY for n in used):
        new_names.append("glass")
    if not me.uv_layers:
        me.uv_layers.new(name="UVMap")
    while len(me.uv_layers) > 1:                 # exactly one UV set named UVMap (glTF TEXCOORD_0)
        me.uv_layers.remove(me.uv_layers[-1])
    me.uv_layers[0].name = "UVMap"
    me.uv_layers.active = me.uv_layers[0]
    me.uv_layers[0].active_render = True
    uvl = me.uv_layers[0].data
    new_idx = []
    for p in me.polygons:
        n = names[p.material_index]
        if n in keep:
            for li in p.loop_indices:
                uvl[li].uv = (0.0, 0.0)
            new_idx.append(new_names.index(n))
        elif n == "glass":
            for li in p.loop_indices:
                uvl[li].uv = glass_uv()
            new_idx.append(new_names.index("glass"))
        elif n == "blob":
            for li in p.loop_indices:
                uvl[li].uv = blob_uv(*uvl[li].uv)
            new_idx.append(new_names.index("glass"))
        elif n.startswith("bulli_atlas"):  # already atlased (LOD2: merged wheels)
            new_idx.append(new_names.index(AT))
        elif n in REGION_MATS:
            for li in p.loop_indices:
                uvl[li].uv = region_uv(n, *uvl[li].uv)
            new_idx.append(new_names.index(AT))
        else:
            uv = atlas_uv(n)
            for li in p.loop_indices:
                uvl[li].uv = uv
            new_idx.append(new_names.index(AT))
    me.materials.clear()          # NOTE: resets polygon material indices -> assign afterwards
    for n in new_names:
        me.materials.append(get_mat(n))
    me.polygons.foreach_set("material_index", new_idx)
    me.update()


def make_cutters():
    mb = MB()
    for (outer, inner, co, ci) in CUTS:
        ro = [mb.v(p) for p in outer]
        ri = [mb.v(p) for p in inner]
        n = len(ro)
        for j in range(n):
            mb.f([ro[j], ro[(j + 1) % n], ri[(j + 1) % n], ri[j]], "rubber")
        mb.fan(ro, co, "cut_cap")
        mb.fan(ri, ci, "cut_cap")
    bmesh.ops.recalc_face_normals(mb.bm, faces=mb.bm.faces)
    return mb.obj("window_cutters", mat_sharp=False)


REQUIRED_NODES = ["body", "wheel_fl", "wheel_fr", "wheel_rl", "wheel_rr", "wheel_fl_geo", "wheel_fr_geo",
                  "wheel_rl_geo", "wheel_rr_geo", "accessory_surfboard", "socket_exhaust", "socket_nametag"]


def build_lod(lod):
    q = Q[lod]
    t0 = time.time()
    CUTS.clear()
    ATLAS_NAME[0] = "bulli_atlas_lod2" if lod == 2 else "bulli_atlas"
    root = empty("car_bulli", (0, 0, 0))
    root["car_type"] = "bulli"
    root["model"] = "VW T1 Samba 23-window (1963)"
    root["lod"] = lod
    root["forward"] = "+Z (three.js) / -Y (Blender)"
    root["left"] = "+X"
    root["units"] = "1 u = 1 m"
    root["blender"] = bpy.app.version_string
    root["script_sha1"] = SCRIPT_HASH
    root["length_m"], root["width_m"], root["height_m"], root["wheelbase_m"] = LENGTH, WIDTH, HEIGHT, WB
    root["collision_half_extents"] = [0.90, 0.97, 2.14]   # three x, y, z
    root["materials_note"] = "paint_primary = player colour (clone per car), emissiveIntensity on bulli_atlas = lights"
    root["wheels_merged"] = bool(q["merge_wheels"])
    rep = {"lod": lod, "objects": {}, "build_s": 0, "timing": {}}

    shell_mb, specs = build_shell(q)
    shell = shell_mb.obj("body", smooth_angle=38, parent=root, mat_sharp=False)
    S = Surf(to_bvh(shell))
    # wheel arches: boolean with cylinders, the cutter faces become the dark wheel houses
    cutters = []
    for s in (1, -1):
        for ya in (AXLE_F, AXLE_R):
            mb = MB()
            M = Matrix(((0, 0, 1), (1, 0, 0), (0, 1, 0)))
            x0 = 0.56 if s > 0 else -1.4
            lathe(mb, [(0.0, 0.0), (ARCH_R, 0.0), (ARCH_R, 0.84), (0.0, 0.84)], q["arch_segs"], M,
                  Vector((x0, ya, ARCH_ZC)), ["trim_dark"] * 3)
            cutters.append(mb.obj("cutter"))
    for c in cutters:
        mod = shell.modifiers.new("arch", "BOOLEAN")
        mod.operation = "DIFFERENCE"
        mod.solver = "EXACT"
        mod.object = c
        if hasattr(mod, "material_mode"):
            mod.material_mode = "TRANSFER"
    apply_all_modifiers(shell)
    for c in cutters:
        bpy.data.objects.remove(c, do_unlink=True)
    det_mb, sockets = build_details(S, q, specs)
    parts = dict(det_mb.parts)
    # window openings: same cutter set for the body and the (coarse) inner cabin shell
    t = time.time()
    rep["window_cuts"] = len(CUTS)
    rep["shell_tris_before_cuts"] = tri_count(shell)
    if CUTS:
        wc = make_cutters()
        boolean_cut(shell, wc)
        rep["removed_cap_faces"] = delete_faces_with(shell, {"cut_cap"})
        if q["interior"]:
            inner = build_inner_shell(q).obj("inner", smooth_angle=50, mat_sharp=False)
            rep["inner_tris_before_cuts"] = tri_count(inner)
            boolean_cut(inner, wc)
            delete_faces_with(inner, {"cut_cap", "rubber"})
            bm = bmesh.new()
            bm.from_mesh(inner.data)
            bmesh.ops.reverse_faces(bm, faces=bm.faces)
            ih = next(i for i, m in enumerate(inner.data.materials) if m.name == "headliner")
            iw = next(i for i, m in enumerate(inner.data.materials) if m.name == "interior")
            for f in bm.faces:
                if f.material_index == iw and f.calc_center_median().z > 1.66:
                    f.material_index = ih
            bm.to_mesh(inner.data)
            bm.free()
            parts["inner_shell"] = tri_count(inner)
            join([shell, inner], shell)
        bpy.data.objects.remove(wc, do_unlink=True)
    rep["timing"]["window_booleans_s"] = round(time.time() - t, 2)
    shell_tris = tri_count(shell)
    det = det_mb.obj("details", smooth_angle=40)
    join([shell, det], shell)
    shell.data.name = "body"
    resmooth_by_material(shell, 38.0, "paint_")
    # wheels
    wheel_mesh = None
    wheel_objs = []
    for nm, x, y, steer in (("wheel_fl", TRACK_F / 2, AXLE_F, True), ("wheel_fr", -TRACK_F / 2, AXLE_F, True),
                            ("wheel_rl", TRACK_R / 2, AXLE_R, False), ("wheel_rr", -TRACK_R / 2, AXLE_R, False)):
        e = empty(nm, (x, y, WR), root, role="wheel", steer=steer, radius=round(WR, 4),
                  side=("left" if x > 0 else "right"), axle=("front" if steer else "rear"))
        if wheel_mesh is None:
            wt = build_wheel(q, "wheel")
            wheel_mesh = wt.data
            wheel_mesh.name = "wheel"
            atlasify(wt)
            bpy.data.objects.remove(wt, do_unlink=True)
        if q["merge_wheels"]:
            # LOD2: wheel geometry baked into the body (-> 3 draw calls), pivots stay for the API
            g = bpy.data.objects.new(nm + "_tmp", wheel_mesh.copy())
            col.objects.link(g)
            g.matrix_world = Matrix.Translation((x, y, WR)) @ (Matrix.Rotation(pi, 4, "Z") if x < 0 else Matrix.Identity(4))
            wheel_objs.append(g)
            empty(nm + "_geo", (0, 0, 0), e, role="wheel_geo_merged")
            continue
        g = bpy.data.objects.new(nm + "_geo", wheel_mesh)
        col.objects.link(g)
        g.parent = e
        if x < 0:
            g.rotation_euler = (0, 0, pi)   # hubcap outwards; pivot axes stay identical on both sides
    if wheel_objs:
        bpy.context.view_layer.update()
        for g in wheel_objs:
            g.data.transform(g.matrix_world)
            g.matrix_world = Matrix.Identity(4)
        join([shell] + wheel_objs, shell)
    board = build_surfboard(q, root)
    for k, v in sockets.items():
        empty(k, tuple(v), root, role="socket")
    empty("socket_nametag", (0, 0, 2.45), root, role="socket")
    empty("socket_underglow", (0, 0, 0.05), root, role="socket")
    bpy.context.view_layer.update()
    # ambient occlusion in the vertex colours (LOD0/1), baked before the atlas remap so the
    # cabin materials can be recognised (longer rays, softer strength inside)
    if lod < 2 and "no-ao" not in OPT:
        wheel_geos = [o for o in root.children_recursive if o.name.endswith("_geo") and o.type == "MESH"]
        rep["ao_body"] = bake_ao(shell, [shell] + wheel_geos, samples=32 if lod == 0 else 20,
                                 skip=GLASSY, interior_mats=INTERIOR_MATS, interior_strength=0.25)
        if wheel_geos:
            w0 = wheel_geos[0]
            rep["ao_wheel"] = bake_ao(w0, [w0], samples=24 if lod == 0 else 16, dist=0.10, strength=0.8,
                                      skip=GLASSY, interior_mats=INTERIOR_MATS)
    atlasify(shell)
    atlasify(board)
    bpy.context.view_layer.update()
    # ---- report ----
    rep["shell_tris_after_cuts"] = shell_tris
    rep["detail_parts_tris"] = parts
    rep["body_primitives"] = [m.name for m in shell.data.materials]
    summarize_lod(root, rep, {0: 25000, 1: 8000, 2: 2000}[lod], REQUIRED_NODES)
    rep["build_s"] = round(time.time() - t0, 2)
    return root, rep


def set_paint_coat(on):
    for n in ("paint_primary", "paint_secondary"):
        m = get_mat(n)
        b = principled(m)
        b.inputs["Coat Weight"].default_value = 1.0 if on else 0.0


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------
def main():
    """build, export and (optionally) render every LOD. pickup.py imports this module for the
    T1 shell and parts without running it."""
    report = {"model": MODEL_ID, "blender": bpy.app.version_string, "script_sha1": SCRIPT_HASH, "lods": {},
              "axes": {"units": "1 u = 1 m", "forward": "three +Z (Blender -Y)", "left": "three +X", "up": "three +Y",
                       "origin": "ground, footprint centre"},
              "dims_used": {"length": LENGTH, "width": WIDTH, "height": HEIGHT, "wheelbase": WB, "track_f": TRACK_F,
                            "track_r": TRACK_R, "wheel_radius": WR, "axle_f_y": AXLE_F, "axle_r_y": AXLE_R}}
    car0 = None
    for lod in LODS:
        set_paint_coat(lod < 2)
        root, rep = build_lod(lod)
        rep["glb"] = export_glb(root, os.path.join(OUT, "%s_lod%d.glb" % (MODEL_ID, lod)))
        report["lods"][lod] = rep
        print("LOD", lod, json.dumps({k: rep[k] for k in ("triangles_total", "draw_calls_est", "size_m", "budget_ok",
                                                             "required_nodes_ok", "shell_tris_after_cuts", "window_cuts", "timing")}))
        print("   parts", rep["detail_parts_tris"], rep["objects"])
        if lod == 0:
            car0 = root
        else:
            delete_hierarchy(root)
    if car0 is not None:
        set_paint_coat(True)
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "%s_lod0.blend" % MODEL_ID))
        if "ortho" in OPT:
            report["ortho"] = bd_lookdev.render_ortho(WORK)
        if "icon" in OPT:
            # car-select icon (build-all.mjs --icons); its own render scene, so before/without the views
            bd_lookdev.wire_ao_for_render(("paint_primary", "paint_secondary", "bulli_atlas"))
            report["icon"] = bd_lookdev.render_icon(car0, bd_lookdev.load_env("victoria_sunset_2k"), OPT["icon"],
                                                   bd_lookdev.icon_size(OPT))
        elif DO_RENDER:
            report["renders"] = bd_lookdev.render_views(
                car0, bd_lookdev.load_env("victoria_sunset_2k"), REN, SUFFIX, VIEWS,
                ao_materials=("paint_primary", "paint_secondary", "bulli_atlas", "bulli_atlas_lod2"))
    report["build_s"] = round(time.time() - T0, 1)
    json.dump(report, open(os.path.join(OUT, "report.json"), "w"), indent=1)
    print("DONE", report["build_s"], "s")


if __name__ == "__main__":
    main()
