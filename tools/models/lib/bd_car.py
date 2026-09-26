# Shared car framework for the Blender builds after the T1: Kaefer (beetle), T1 Pritsche (pickup),
# Porsche 356 (sport) and Typ 181 (jeep), tools/models/vehicles/<id>.py.
#
# bulli.py (the first car) keeps its own, older copy of most of this; the structure is the same:
#
#   CAR = init("beetle", ...)                    materials, atlas, plate, hubcap logo of this car
#   loft(...)                                    Catmull-Rom body surfaces from station profiles
#   Surf / pane / seam / strip                   details projected onto the body
#   headlight / taillight / blinker / bumper / build_logo / crest / build_wheel / surfboard
#   assemble(lod, q, parts)                      the node convention of tools/models/README.md
#   main(build_lod)                              LOD loop, export, report, renders, icon
#
# Axes and units as everywhere: 1 BU = 1 m, Blender Z-up, the car faces Blender -Y (three +Z),
# driver's left = +X, origin on the ground at the centre of the footprint.
import bpy, bmesh, math, os, sys, json, time
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree
from bd_common import *                      # noqa: F401,F403
import bd_common
import bd_lookdev

LIB = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.dirname(LIB)
CAR = {}                                     # config of the car being built (init)

# --------------------------------------------------------------------------
# materials
# --------------------------------------------------------------------------
# name: base hex (sRGB), roughness, metallic, clearcoat, coat roughness, spec (Specular IOR Level),
# emissive hex + strength, region (UV region of the atlas instead of a flat cell)
BASE_SPECS = {
    "paint_primary":   dict(col="#7A1418", rough=0.35, coat=1.0, coat_rough=0.03, spec=0.2),
    "paint_secondary": dict(col="#D6CBB2", rough=0.35, coat=1.0, coat_rough=0.03, spec=0.2),
    "chrome":          dict(col="#EDEDEF", rough=0.05, metal=1.0),
    "glass":           dict(col="#1C252C", rough=0.02, alpha=0.24),
    "glass_dark":      dict(col="#0B0F13", rough=0.04),
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
    "crest":           dict(col="#C9A24A", rough=0.3, metal=0.6, region="crest"),
    "interior":        dict(col="#A69A86", rough=0.8, emit="#A69A86", estr=0.10),
    "headliner":       dict(col="#EFE8D6", rough=0.9, emit="#EFE8D6", estr=0.16),
    "floor":           dict(col="#4E473F", rough=0.95),
    "seat":            dict(col="#CFC2A4", rough=0.55, emit="#CFC2A4", estr=0.10),
    "ivory":           dict(col="#ECE4CE", rough=0.3),
    "surf_board":      dict(col="#EFE6CF", rough=0.28),
    "surf_stripe":     dict(col="#1D7686", rough=0.28),
    "paint_black":     dict(col="#141516", rough=0.42),
    "steel_dark":      dict(col="#2B2C2E", rough=0.55, metal=0.7),
    "wood":            dict(col="#8B6B47", rough=0.82),
    "cut_cap":         dict(col="#FF00FF", rough=1.0),                 # boolean helper, deleted
    "blob":            dict(col="#000000", rough=1.0),                 # placeholder -> 'glass' (blob region)
}
BASE_CELLS = ["chrome", "glass_dark", "rubber", "trim_dark", "wheel_white", "rim_paint", "lamp_head",
              "lamp_tail", "lamp_amber", "canvas", "interior", "headliner", "floor", "seat", "ivory",
              "surf_board", "surf_stripe", "paint_black", "steel_dark", "wood"]
ATLAS_PX, ATLAS_CELL, ATLAS_COLS = 512, 32, 16
REGIONS = {"plate": (0, 320, 256, 128), "tread": (0, 256, 512, 64), "hubcap": (256, 320, 128, 128),
           "crest": (384, 384, 64, 64)}
PAINTS = ("paint_primary", "paint_secondary")
GLASSY = ("glass", "blob")
INTERIOR_MATS = ("interior", "headliner", "floor", "seat", "ivory")
REGION_MATS = ("tread", "plate", "hubcap", "crest")


def init(model_id, name, dims, specs=None, cells=None, hub_logo="vw", hub_r=0.125, hub_logo_r=0.05,
         wheel_radius=0.33, tread_width=0.104, extra_hash=()):
    """sets up the build of one car: output dirs, material specs (BASE_SPECS + overrides), atlas
    cells, hubcap logo ("vw", "ring" or None), licence plate tools/models/src/license_plate_<id>_512.png."""
    opt = parse_args()
    here = os.path.join(MODELS, "vehicles", model_id + ".py")
    out = opt.get("out", os.path.join(MODELS, ".out", model_id))
    for d in (out, os.path.join(out, "renders"), os.path.join(out, "tex"), os.path.join(out, "work")):
        os.makedirs(d, exist_ok=True)
    s = {k: dict(v) for k, v in BASE_SPECS.items()}
    for k, v in (specs or {}).items():
        s[k] = dict(s.get(k, {}), **v)
    CAR.clear()
    CAR.update(id=model_id, name=name, dims=dims, opt=opt, out=out, specs=s,
               cells=list(cells or BASE_CELLS), hub_logo=hub_logo, hub_r=hub_r, hub_logo_r=hub_logo_r,
               wr=wheel_radius, tread_w=tread_width, atlas=[model_id + "_atlas"],
               plate=os.path.join(MODELS, "src", "license_plate_%s_512.png" % model_id),
               hash=files_hash([here, os.path.join(LIB, "bd_common.py"), os.path.abspath(__file__)]
                               + list(extra_hash)),
               lods=[int(x) for x in str(opt.get("lods", "2,1,0")).split(",")],
               cuts=[])
    assert len(CAR["cells"]) <= 32, "atlas has 16 x 2 palette cells"
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bd_common.MATS.clear()
    set_material_factory(make_material)
    return CAR


def make_material(name):
    cid = CAR["id"]
    if name == cid + "_atlas":
        return make_atlas_material()
    if name == cid + "_atlas_lod2":
        return make_small_atlas()
    if name == "glass":
        return make_glass_material()
    s = CAR["specs"][name]
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
    m.use_backface_culling = True
    return m


def set_paint_coat(on):
    for n in PAINTS:
        b = principled(get_mat(n))
        b.inputs["Coat Weight"].default_value = 1.0 if on else 0.0


# ---- atlas -------------------------------------------------------------------
def atlas_uv(name):
    i = CAR["cells"].index(name)
    cx, cy = i % ATLAS_COLS, i // ATLAS_COLS
    return ((cx * ATLAS_CELL + ATLAS_CELL / 2) / ATLAS_PX, (448 + cy * ATLAS_CELL + ATLAS_CELL / 2) / ATLAS_PX)


def region_uv(name, u, v):
    x0, y0, w, h = REGIONS[name]
    return ((x0 + u * w) / ATLAS_PX, (y0 + v * h) / ATLAS_PX)


def plate_pixels(w=256, h=128):
    import numpy as np
    im = bpy.data.images.load(CAR["plate"])
    im.scale(w, h)
    px = np.empty(w * h * 4, np.float32)
    im.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)
    a = px[..., 3:4]
    px[..., :3] = px[..., :3] * a + 0.02 * (1 - a)
    px[..., 3] = 1
    bpy.data.images.remove(im)
    return px


def tread_height(W=512, H=64):
    import numpy as np
    u = (np.arange(W) + 0.5) / W
    v = (np.arange(H) + 0.5) / H
    U, V = np.meshgrid(u, v)
    NP = 46
    h = np.ones((H, W), np.float32)
    for vc in (0.32, 0.68):
        h = np.minimum(h, np.clip((np.abs(V - vc) - 0.030) / 0.012, 0, 1))
    ph = (U * NP + (V - 0.5) * 0.9) % 1.0
    sh = (V < 0.30) | (V > 0.70)
    lat = np.clip((np.abs(ph - 0.5) - 0.40) / 0.03, 0, 1)
    h = np.where(sh, np.minimum(h, 1 - lat), h)
    ph2 = (U * NP * 2 + 0.25) % 1.0
    rib = (V > 0.36) & (V < 0.64)
    sip = np.clip((np.abs(ph2 - 0.5) - 0.44) / 0.03, 0, 1)
    h = np.where(rib, np.minimum(h, 1 - 0.55 * sip), h)
    k = np.pad(h, 1, mode="wrap")
    return sum(k[1 + dy:1 + dy + H, 1 + dx:1 + dx + W] for dy in (-1, 0, 1) for dx in (-1, 0, 1)) / 9.0


def logo_strokes(ri):
    """VW roundel strokes (unit roundel), same construction as bulli.py"""
    ang = math.radians(68)
    dA = Vector((math.cos(-ang), math.sin(-ang)))
    dB = Vector((-math.cos(-ang), math.sin(-ang)))
    rm = ri + 0.04
    A0, A1 = -dA * rm, dA * rm
    B0, B1 = -dB * rm, dB * rm
    Pb = dB * ri * 0.98
    Pbr = dA * ri * 0.98

    def to_ring(p, d):
        t = 0.0
        while (p + d * t).length < rm and t < 3:
            t += 0.005
        return p + d * t
    return [(A0, A1), (B0, B1), (to_ring(Pb, -dA), Pb), (to_ring(Pbr, -dB), Pbr)]


def hub_logo_height(n):
    """hubcap relief on an n x n grid covering the hubcap (radius hub_r): VW roundel ("vw"), a
    pressed concentric ring ("ring") or nothing"""
    import numpy as np
    c = (np.arange(n) + 0.5) / n * 2 - 1
    X, Y = np.meshgrid(c, c)
    if CAR["hub_logo"] == "ring":
        r = np.hypot(X, Y)
        return np.clip(1 - np.abs(r - 0.62) / 0.05, 0, 1) * 0.8 + np.clip(1 - np.abs(r - 0.3) / 0.04, 0, 1) * 0.5
    if CAR["hub_logo"] != "vw":
        return np.zeros((n, n), np.float32)
    k = CAR["hub_r"] / CAR["hub_logo_r"]
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
    return np.clip(h * 1.6, 0, 1) ** 0.7


def crest_pixels(n=64):
    """stylised coat of arms (Porsche 356 bonnet badge, not the trademark artwork): gold shield,
    quartered with red/black stripes and black antler zigzags, small gold centre shield.
    RGBA float, rows bottom-up, shield alpha as a mask for the base colour."""
    import numpy as np
    c = (np.arange(n) + 0.5) / n
    X, Y = np.meshgrid(c * 2 - 1, c)             # X -1..1, Y 0 (bottom) .. 1 (top)
    gold, red, black = np.array([0.80, 0.62, 0.26]), np.array([0.62, 0.08, 0.06]), np.array([0.05, 0.05, 0.05])
    # shield: flat top, straight sides, rounded point at the bottom
    top = Y < 0.94
    side = np.abs(X) < 0.86 * np.where(Y > 0.45, 1.0, np.sqrt(np.clip(Y / 0.45, 0, 1)) ** 0.8)
    inside = top & side & (Y > 0.03)
    img = np.zeros((n, n, 3)) + 0.55                # dark chrome surround (rim)
    rim_in = (Y < 0.90) & (np.abs(X) < 0.80 * np.where(Y > 0.47, 1.0, np.sqrt(np.clip((Y - 0.05) / 0.42, 0, 1)) ** 0.8)) & (Y > 0.08)
    img[inside] = gold * 0.9
    q_tl = rim_in & (X < 0) & (Y > 0.48)
    q_br = rim_in & (X > 0) & (Y <= 0.48)
    stripes = (np.floor(Y * 14) % 2 == 0)
    for q in (q_tl, q_br):
        img[q & stripes] = red
        img[q & ~stripes] = black
    q_tr = rim_in & (X >= 0) & (Y > 0.48)
    q_bl = rim_in & (X <= 0) & (Y <= 0.48)
    img[q_tr | q_bl] = gold
    for q, x0, y0 in ((q_tr, 0.4, 0.72), (q_bl, -0.4, 0.26)):   # antlers: two black zigzag bars
        for dy in (-0.09, 0.09):
            zz = np.abs((Y - y0 - dy) - 0.03 * np.sin((X - x0) * 24)) < 0.025
            img[q & zz & (np.abs(X - x0) < 0.3)] = black
    cs = (np.abs(X) < 0.26) & (Y > 0.34) & (Y < 0.64)
    img[cs] = gold * 1.05
    img[cs & (np.hypot(X * 1.3, Y - 0.5) < 0.1)] = black       # horse, reduced to a dark mark
    out = np.ones((n, n, 4), np.float32)
    out[..., :3] = img
    out[..., 3] = inside.astype(np.float32)
    return out


def make_atlas_material():
    import numpy as np
    specs, cells, P, C = CAR["specs"], CAR["cells"], ATLAS_PX, ATLAS_CELL
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
    for i, n in enumerate(cells):
        s = specs[n]
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
    # hubcap: chrome with the relief in the normal map
    x0, y0, w, h = REGIONS["hubcap"]
    hs = specs["hubcap"]
    base[y0:y0 + h, x0:x0 + w, :3] = srgb(hs["col"])
    mr[y0 // 4:(y0 + h) // 4, x0 // 4:(x0 + w) // 4, 1] = hs["rough"]
    mr[y0 // 4:(y0 + h) // 4, x0 // 4:(x0 + w) // 4, 2] = hs.get("metal", 1.0)
    hl = hub_logo_height(w)
    dpx = 2 * CAR["hub_r"] / w
    gx = (np.roll(hl, -1, 1) - np.roll(hl, 1, 1)) / (2 * dpx) * 0.0016
    gy = (np.roll(hl, -1, 0) - np.roll(hl, 1, 0)) / (2 * dpx) * 0.0016
    nv = np.stack([-gx, -gy, np.ones_like(gx)], -1)
    nv /= np.linalg.norm(nv, axis=-1, keepdims=True)
    nrm[y0:y0 + h, x0:x0 + w, :3] = nv * 0.5 + 0.5
    # crest (only drawn where a car uses it; harmless otherwise)
    x0, y0, w, h = REGIONS["crest"]
    cp = crest_pixels(w)
    base[y0:y0 + h, x0:x0 + w, :3] = cp[..., :3] * cp[..., 3:4] + np.array(srgb("#B8B8B8")) * (1 - cp[..., 3:4])
    mr[y0 // 4:(y0 + h) // 4, x0 // 4:(x0 + w) // 4, 1] = 0.25
    mr[y0 // 4:(y0 + h) // 4, x0 // 4:(x0 + w) // 4, 2] = 0.55
    # licence plate
    x0, y0, w, h = REGIONS["plate"]
    base[y0:y0 + h, x0:x0 + w] = plate_pixels(w, h)
    mr[y0 // 4:(y0 + h) // 4, x0 // 4:(x0 + w) // 4, 1] = 0.45
    # tread
    x0, y0, w, h = REGIONS["tread"]
    ht = tread_height(w, h)
    base[y0:y0 + h, x0:x0 + w, :3] = (0.075 + 0.03 * ht)[..., None]
    mr[y0 // 4:(y0 + h) // 4, x0 // 4:(x0 + w) // 4, 1] = 0.92
    du_m, dv_m, depth = 2 * math.pi * CAR["wr"] / w, CAR["tread_w"] / h, 0.0028
    gx = (np.roll(ht, -1, 1) - np.roll(ht, 1, 1)) / (2 * du_m) * depth
    gy = (np.roll(ht, -1, 0) - np.roll(ht, 1, 0)) / (2 * dv_m) * depth
    gy[0], gy[-1] = 0, 0
    nv = np.stack([-gx, -gy, np.ones_like(gx)], -1)
    nv /= np.linalg.norm(nv, axis=-1, keepdims=True)
    nrm[y0:y0 + h, x0:x0 + w, :3] = nv * 0.5 + 0.5
    imgs = {}
    name = CAR["id"] + "_atlas"
    for key, arr, cs in (("base", base, "sRGB"), ("normal", nrm, "Non-Color"), ("mr", mr, "Non-Color"),
                         ("emissive", em, "sRGB")):
        jpg = key == "base"
        imgs[key] = save_image(name + "_" + key, arr,
                               os.path.join(CAR["out"], "tex", "%s_%s.%s" % (name, key, "jpg" if jpg else "png")),
                               cs, fmt="JPEG" if jpg else "PNG", quality=92)
    return image_material(name, imgs, interpolation="Linear")


def make_small_atlas():
    import numpy as np
    specs, cells = CAR["specs"], CAR["cells"]
    P = 64
    k = ATLAS_PX // P
    base = np.zeros((P, P, 4), np.float32)
    mr = np.zeros((P, P, 4), np.float32)
    em = np.zeros((P, P, 4), np.float32)
    base[..., 3] = mr[..., 3] = em[..., 3] = 1
    mr[..., 0], mr[..., 1] = 1.0, 0.9
    base[..., :3] = 0.08
    C = ATLAS_CELL // k
    for i, n in enumerate(cells):
        s_ = specs[n]
        cx, cy = i % ATLAS_COLS, i // ATLAS_COLS
        y0 = 448 // k + cy * C
        sl = (slice(y0, y0 + C), slice(cx * C, (cx + 1) * C))
        base[sl[0], sl[1], :3] = srgb(s_["col"])
        mr[sl[0], sl[1], 1] = s_["rough"]
        mr[sl[0], sl[1], 2] = s_.get("metal", 0.0)
        if s_.get("emit"):
            em[sl[0], sl[1], :3] = [c * min(1.0, s_["estr"]) for c in srgb(s_["emit"])]
    name = CAR["id"] + "_atlas_lod2"
    imgs = {}
    for key, arr, cs in (("base", base, "sRGB"), ("mr", mr, "Non-Color"), ("emissive", em, "sRGB")):
        imgs[key] = save_image(name + "_" + key, arr, os.path.join(CAR["out"], "tex", "%s_%s.png" % (name, key)), cs)
    return image_material(name, imgs, interpolation="Closest")


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
    s = CAR["specs"]["glass"]
    base[:, :W // 2, :3] = srgb(s["col"])
    base[:, :W // 2, 3] = s["alpha"]
    mr[:, :W // 2, 1] = s["rough"]
    yy, xx = np.meshgrid((np.arange(H) + 0.5) / H, (np.arange(W // 2) + 0.5) / (W // 2), indexing="ij")
    X, Y = (xx - 0.5) * 2, (yy - 0.5) * 2
    r = (np.abs(X) ** 4 + np.abs(Y) ** 4) ** 0.25
    base[:, W // 2:, 3] = (1 - np.clip((r - 0.45) / 0.55, 0, 1)) ** 1.6 * 0.72
    mr[:, W // 2:, 1] = 1.0
    imgs = {}
    for key, arr, cs in (("base", base, "sRGB"), ("mr", mr, "Non-Color")):
        imgs[key] = save_image("%s_glass_%s" % (CAR["id"], key), arr,
                               os.path.join(CAR["out"], "tex", "%s_glass_%s.png" % (CAR["id"], key)), cs,
                               alpha=(key == "base"))
    return image_material("glass", imgs, interpolation="Linear", alpha=True, emission=False, blend=True)


# --------------------------------------------------------------------------
# lofted surfaces (centripetal Catmull-Rom, interpolating)
# --------------------------------------------------------------------------
def _cr_eval(P, i, t, closed=False, alpha=0.5, linear=False):
    """point on the centripetal Catmull-Rom spline through P at segment i (P[i] -> P[i+1]), t in 0..1"""
    n = len(P)
    if linear:
        return P[i].lerp(P[(i + 1) % n], t)
    if closed:
        p0, p1, p2, p3 = P[(i - 1) % n], P[i], P[(i + 1) % n], P[(i + 2) % n]
    else:
        p1, p2 = P[i], P[i + 1]
        p0 = P[i - 1] if i > 0 else p1 + (p1 - p2)
        p3 = P[i + 2] if i + 2 < n else p2 + (p2 - p1)
    if (p2 - p1).length < 1e-9:
        return p1.copy()

    def tj(ti, a, b):
        return ti + max((b - a).length, 1e-6) ** alpha
    t0 = 0.0
    t1 = tj(t0, p0, p1)
    t2 = tj(t1, p1, p2)
    t3 = tj(t2, p2, p3)
    tt = t1 + (t2 - t1) * t
    A1 = p0 * ((t1 - tt) / (t1 - t0)) + p1 * ((tt - t0) / (t1 - t0))
    A2 = p1 * ((t2 - tt) / (t2 - t1)) + p2 * ((tt - t1) / (t2 - t1))
    A3 = p2 * ((t3 - tt) / (t3 - t2)) + p3 * ((tt - t2) / (t3 - t2))
    B1 = A1 * ((t2 - tt) / (t2 - t0)) + A2 * ((tt - t0) / (t2 - t0))
    B2 = A2 * ((t3 - tt) / (t3 - t1)) + A3 * ((tt - t1) / (t3 - t1))
    return B1 * ((t2 - tt) / (t2 - t1)) + B2 * ((tt - t1) / (t2 - t1))


def sample_curve(P, subs, closed=False, linear=False):
    """points along the spline through P; subs = samples per segment (int or list per segment).
    Open curves include both end points."""
    P = [Vector(p) for p in P]
    nseg = len(P) if closed else len(P) - 1
    out = []
    for i in range(nseg):
        k = subs[i] if isinstance(subs, (list, tuple)) else subs
        for j in range(k):
            out.append(_cr_eval(P, i, j / k, closed, linear=linear))
    if not closed:
        out.append(P[-1].copy())
    return out


def loft_grid(stations, u_subs, v_subs, closed_u=False, linear_u=False, linear_v=False):
    """stations: list of control curves (lists of 3D points, same count). Returns the sampled grid
    rows[v][u] (Vectors)."""
    curves = [sample_curve(st, u_subs, closed=closed_u, linear=linear_u) for st in stations]
    nu = len(curves[0])
    cols = [sample_curve([c[j] for c in curves], v_subs, linear=linear_v) for j in range(nu)]
    return [[cols[j][i] for j in range(nu)] for i in range(len(cols[0]))]


def loft(mb, stations, u_subs, v_subs, mat_fn, mirror=True, closed_u=False, cap=(False, False),
         linear_u=False, linear_v=False, flip=False, soft=True):
    """Lofted surface into the mesh builder. mirror=True: stations are half profiles (x >= 0) from
    the bottom centre to the top centre, mirrored to x < 0 into one closed ring (points on x = 0 are
    shared). mirror=False + closed_u: periodic closed profiles (e.g. a fender). mat_fn(centre) ->
    material name. cap: fan-close the first / last ring. Returns the grid rows (Vectors)."""
    rows = loft_grid(stations, u_subs, v_subs, closed_u=closed_u, linear_u=linear_u, linear_v=linear_v)
    n0 = mb.nfaces()
    rings = []
    for row in rows:
        if mirror:
            # the end points lie on the centre plane, the others on or right of it
            half = [mb.v((0.0 if j in (0, len(row) - 1) else max(p.x, 0.0), p.y, p.z)) for j, p in enumerate(row)]
            mirrored = []
            for j in range(len(row) - 2, 0, -1):
                v = half[j]
                mirrored.append(v if abs(v.co.x) < 1e-5 else mb.v((-v.co.x, v.co.y, v.co.z)))
            rings.append(half + mirrored)
        else:
            rings.append([mb.v(p) for p in row])
    closed = mirror or closed_u
    n = len(rings[0])
    m = n if closed else n - 1
    for i in range(len(rings) - 1):
        for j in range(m):
            a, b = rings[i][j], rings[i][(j + 1) % n]
            c, d = rings[i + 1][(j + 1) % n], rings[i + 1][j]
            ctr = (a.co + b.co + c.co + d.co) / 4
            q = [a, b, c, d]
            mb.f(q[::-1] if flip else q, mat_fn(ctr))
    for k, ri in ((0, 0), (1, -1)):
        if cap[k]:
            ring = rings[ri]
            ctr = sum((v.co for v in ring), Vector()) / len(ring)
            mb.fan(ring, ctr, mat_fn(ctr), flip=(k == 0) != flip)
    mb.recalc(n0, soft=soft)
    return rows


def mirror_x(mb, n0):
    """duplicates the faces created since n0 mirrored to -x (flipped winding)"""
    fs = mb.faces_since(n0)
    vmap = {}
    for f in fs:
        vs = []
        for v in f.verts:
            if v not in vmap:
                vmap[v] = mb.v((-v.co.x, v.co.y, v.co.z))
            vs.append(vmap[v])
        nf = mb.f(vs[::-1], mb.mats[f.material_index])
        if nf is not None and f in mb.soft:
            mb.soft.add(nf)
        if nf is not None and f in mb.face_uv:
            uvs = mb.face_uv[f]
            mb.face_uv[nf] = {(-k[0], k[1], k[2]): uv for k, uv in uvs.items()}


# --------------------------------------------------------------------------
# surface queries
# --------------------------------------------------------------------------
def to_bvh(objs):
    tmp = bmesh.new()
    for o in (objs if isinstance(objs, (list, tuple)) else [objs]):
        b = bmesh.new()
        b.from_mesh(o.data)
        b.transform(o.matrix_world)
        m2 = bpy.data.meshes.new("_s")
        b.to_mesh(m2)
        b.free()
        tmp.from_mesh(m2)
        bpy.data.meshes.remove(m2)
    bmesh.ops.triangulate(tmp, faces=tmp.faces)
    t = BVHTree.FromBMesh(tmp)
    tmp.free()
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

    def top(self, x, y):
        return self.ray((x, y, 4.0), (0, 0, -1))


# --------------------------------------------------------------------------
# windows (seal + glass projected on the body; see-through panes register a boolean cutter)
# --------------------------------------------------------------------------
CUT_OUT, CUT_IN = 0.03, 0.07


def register_cut(P, outline_pts, d, cen):
    pts = inset(outline_pts, d)
    CAR["cuts"].append(([P(p.x, p.y, CUT_OUT) for p in pts], [P(p.x, p.y, -CUT_IN) for p in pts],
                        P(cen.x, cen.y, CUT_OUT), P(cen.x, cen.y, -CUT_IN)))


def pane(mb, S, O, N, corners3d, radii, q, up=Vector((0, 0, 1)), small=False, grings=0, curved=False, cut=True,
         seal_mat="rubber", chrome=True, outline_uv=None):
    """window on the surface S: outline = rounded polygon of corners3d (projected into the plane
    through O with normal N) or outline_uv (2D points in that plane). LOD0 (q seal 3): rubber seal
    with a chrome insert; see-through (q holes) registers a cutter for the window boolean."""
    see_through = cut and q["holes"]
    gmat = "glass" if see_through else "glass_dark"
    N = Vector(N).normalized()
    U = up.cross(N)
    if U.length < 1e-6:
        U = Vector((1, 0, 0))
    U.normalize()
    V = N.cross(U).normalized()
    nc = q["sky_nc"] if small else q["nc"]
    if outline_uv is not None:
        outer = [Vector(p) for p in outline_uv]
    else:
        uv = [Vector(((Vector(p) - O).dot(U), (Vector(p) - O).dot(V))) for p in corners3d]
        outer = rounded_poly(uv, radii, nc, min(q["maxseg"], 0.12 if not small else 0.2) if curved else q["maxseg"])
    if curved and not small:
        grings = max(grings, 2)
    cen = sum(outer, Vector((0, 0))) / len(outer)

    def P(u, v, off):
        p0 = O + U * u + V * v + N * 0.6
        loc, n = S.ray(p0, -N)
        return loc + n * off
    seal = 0.020 if not small else 0.014
    lvl = q["seal"] if not small else (1 if q["seal"] >= 3 else 0)
    if lvl >= 3 and chrome:
        spec = [(0.0, 0.0010, seal_mat), (0.004, 0.0065, seal_mat), (seal * 0.40, 0.0075, "chrome"),
                (seal * 0.62, 0.0070, seal_mat), (seal, 0.0030, None)]
    elif lvl >= 2 or (lvl >= 3 and not chrome):
        spec = [(0.0, 0.0015, seal_mat), (seal * 0.5, 0.0075, seal_mat), (seal, 0.0045, None)]
    elif lvl >= 1:
        spec = [(0.0, 0.0015, seal_mat), (seal, 0.0055, None)]
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
        register_cut(P, outer, max(seal * 0.45, 0.006), cen)
    return P, U, V


def seam(mb, S, pts3d, dirn, width=0.0035, off=0.0012, mat="trim_dark", seg=0.16):
    """dark panel gap: polyline of 3D points projected along -dirn onto the surface"""
    Pp = [Vector(p) for p in pts3d]
    dense = []
    for a, b in zip(Pp, Pp[1:]):
        m = max(1, int(math.ceil((b - a).length / seg)))
        for k in range(m):
            dense.append(a.lerp(b, k / m))
    dense.append(Pp[-1])
    closed = (Pp[0] - Pp[-1]).length < 1e-6
    if closed:
        dense = dense[:-1]
    pts, nrms = [], []
    for p in dense:
        loc, n = S.ray(p + Vector(dirn) * 0.5, -Vector(dirn))
        pts.append(loc)
        nrms.append(n)
    strip(mb, pts, nrms, [(-width / 2, 0), (width / 2, 0)], mat, closed=closed, offset=off)


def on_surface_strip(mb, S, pts3d, dirn, prof, mat, closed=False, near=False):
    """trim strip (chrome belt line, rocker) following points projected onto the surface"""
    pts, nrms = [], []
    for p in pts3d:
        loc, n = S.near(p) if near else S.ray(Vector(p) + Vector(dirn) * 0.5, -Vector(dirn))
        pts.append(loc)
        nrms.append(n)
    strip(mb, pts, nrms, prof, mat, closed=closed)


def boolean_cut(target, cutter):
    """window boolean (EXACT with self-intersection handling: cutters on strongly curved panels, e.g. the
    Kaefer rear window, fold slightly and made the plain EXACT solver drop the whole body)"""
    mod = target.modifiers.new("win", "BOOLEAN")
    mod.operation = "DIFFERENCE"
    mod.solver = "EXACT"
    mod.use_self = True
    mod.object = cutter
    if hasattr(mod, "material_mode"):
        mod.material_mode = "TRANSFER"
    apply_all_modifiers(target)


def make_cutters():
    mb = MB()
    for (outer, inner, co, ci) in CAR["cuts"]:
        ro = [mb.v(p) for p in outer]
        ri = [mb.v(p) for p in inner]
        n = len(ro)
        for j in range(n):
            mb.f([ro[j], ro[(j + 1) % n], ri[(j + 1) % n], ri[j]], "rubber")
        mb.fan(ro, co, "cut_cap")
        mb.fan(ri, ci, "cut_cap")
    bmesh.ops.recalc_face_normals(mb.bm, faces=mb.bm.faces)
    return mb.obj("window_cutters", mat_sharp=False)


# --------------------------------------------------------------------------
# badges and lamps
# --------------------------------------------------------------------------
def build_logo(mb, O, N, R, q, depth=0.012, stroke=0.17, ring_w=0.12, up=Vector((0, 0, 1)), mat="chrome"):
    """VW roundel in chrome (ring + strokes), like bulli.py"""
    N = Vector(N).normalized()
    U = up.cross(N).normalized()
    V = N.cross(U).normalized()
    M = Matrix((U, V, N)).transposed()
    segs = q["logo_seg"]
    ro, ri = R, R * (1 - ring_w)
    prof = [(ri - 0.002, 0.0), (ri, depth * 0.55), (ri + (ro - ri) * 0.3, depth), (ro - (ro - ri) * 0.3, depth),
            (ro, depth * 0.55), (ro + 0.002, 0.0)]
    if segs <= 24:
        prof = [(ri, 0.0), (ri, depth), (ro, depth), (ro, 0.0)]
    lathe(mb, prof, segs, M, O, [mat] * (len(prof) - 1))
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
                mb.f([ra[j], rb[j], rb[j + 1], ra[j + 1]], mat)
            mb.f(ra[::-1], mat)
            mb.f(rb, mat)
            bmesh.ops.recalc_face_normals(mb.bm, faces=mb.faces_since(n0))
    else:
        lathe(mb, [(0.0, depth * 0.6), (ri, depth * 0.6)], max(8, segs), M, O, [mat])


def crest(mb, O, N, w, h, up=Vector((0, 0, 1)), depth=0.004):
    """flat badge with the atlas crest region (shield), slightly raised"""
    N = Vector(N).normalized()
    U = up.cross(N).normalized()
    V = N.cross(U).normalized()
    base = O + N * depth
    vs = [mb.v(base + U * (sx * w / 2) + V * (sy * h / 2)) for (sx, sy) in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    fc = mb.f(vs, "crest")
    mb.set_uv(fc, vs, [(0, 0), (1, 0), (1, 1), (0, 1)])


def plate(mb, O, N, q, w=0.305, h=0.152, lamp=True):
    """licence plate (atlas plate region) standing on the surface point O with normal N"""
    N = Vector((N.x, N.y, 0)).normalized()
    U = Vector((0, 0, 1)).cross(N).normalized()
    V = N.cross(U).normalized()
    base = O + N * 0.006
    if q["plate"]:
        vs = [mb.v(base + U * (sx * w / 2) + V * (sy * h / 2)) for (sx, sy) in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        fc = mb.f(vs, "plate")
        mb.set_uv(fc, vs, [(0, 0), (1, 0), (1, 1), (0, 1)])
        if lamp:
            box(mb, O + N * 0.02 + V * (h / 2 + 0.03), (0.13, 0.04, 0.035), "chrome",
                M=Matrix((U, N, Vector((0, 0, 1)))).transposed())


def headlight(mb, loc, n, R, q, pod_mat="paint_primary", pod=True):
    """round headlight (R = outer radius of the chrome ring) facing n, like the T1 lamp scaled"""
    M = frame_from_axis(n)
    k = R / 0.132
    prof = [(0.132, -0.03), (0.127, 0.006), (0.116, 0.016), (0.108, 0.027), (0.097, 0.030), (0.089, 0.022),
            (0.087, 0.022), (0.074, 0.030), (0.071, 0.029), (0.045, 0.036), (0.0, 0.040)]
    mats = [pod_mat] * 2 + ["chrome"] * 4 + ["lamp_head"] * 4
    if q["lamp"] >= 24:
        prof = [(0.132, -0.03), (0.127, 0.006), (0.113, 0.021), (0.099, 0.030), (0.089, 0.022),
                (0.074, 0.030), (0.045, 0.036), (0.0, 0.040)]
        mats = [pod_mat, "chrome", "chrome", "chrome", "lamp_head", "lamp_head", "lamp_head"]
    elif q["lamp"] > 8:
        prof = [(0.128, -0.02), (0.122, 0.012), (0.098, 0.029), (0.086, 0.023), (0.0, 0.038)]
        mats = [pod_mat, "chrome", "chrome", "lamp_head"]
    if q["lamp"] <= 8:
        prof = [(0.115, -0.01), (0.105, 0.025), (0.0, 0.034)]
        mats = ["chrome", "lamp_head"]
    if not pod and mats[0] == pod_mat:
        prof, mats = prof[1:], mats[1:]
    lathe(mb, [(r * k, h * k) for (r, h) in prof], q["lamp"], M, loc, mats)
    return loc + n * 0.04 * k


def round_lamp(mb, loc, n, R, q, lens="lamp_amber", ring="chrome", sx=1.0, sy=1.0, mat_fn=None, depth=None):
    """small lamp (blinker, tail light): chrome ring + domed lens, optionally oval (sx, sy)"""
    d = depth if depth is not None else R * 0.5
    M = frame_from_axis(n, up_hint=Vector((0, 0, 1)))
    prof = [(R, -0.01), (R * 0.98, 0.006), (R * 0.9, d * 0.45), (R * 0.84, d * 0.45), (R * 0.6, d * 0.85), (0.0, d)]
    mats = [ring, ring, ring, lens, lens]
    segs = max(8, q["lamp"] * 2 // 3)
    if q["lamp"] <= 20:
        prof, mats = [(R, -0.01), (R * 0.9, d * 0.5), (0.0, d)], [ring, lens]
        if mat_fn:
            mf = mat_fn
            mat_fn = (lambda i, j, s: ring if i == 0 else mf(3, j, s))
    if q["lamp"] <= 8:
        mat_fn = None
        segs = 6
    lathe(mb, prof, segs, M, loc, mats, sx=sx, sy=sy, mat_fn=mat_fn)
    return loc + n * d


# --------------------------------------------------------------------------
# bumpers
# --------------------------------------------------------------------------
BLADE_HI = [(-0.020, 0.064), (-0.004, 0.068), (0.010, 0.066), (0.021, 0.058), (0.028, 0.045), (0.032, 0.024),
            (0.033, 0.0), (0.032, -0.024), (0.028, -0.045), (0.021, -0.058), (0.010, -0.066), (-0.004, -0.068),
            (-0.020, -0.064)]
BLADE_MID = [(-0.02, 0.064), (0.018, 0.062), (0.033, 0.0), (0.018, -0.062), (-0.02, -0.064)]
BLADE_LO = [(-0.02, 0.065), (0.03, 0.05), (0.03, -0.05), (-0.02, -0.065)]


def blade(mb, path, zc, q, mat="chrome", scale=(1.0, 1.0), back_mat="trim_dark", prof=None, outward=None):
    """bumper blade swept along the plan polyline path [(x, y)] at height zc; the profile (d = out of
    the car, h = up) is scaled by scale=(depth, height). outward(x, y) -> 2D outward direction
    (default: away from the car centre along y)."""
    if prof is None:
        prof = BLADE_HI if q["bumper_n"] > 12 else (BLADE_MID if q["bumper_n"] > 8 else BLADE_LO)
    prof = [(d * scale[0], h * scale[1]) for (d, h) in prof]
    rings = []
    P = [Vector((x, y, zc)) for (x, y) in path]
    for i, p in enumerate(P):
        t = (P[min(i + 1, len(P) - 1)] - P[max(i - 1, 0)]).normalized()
        o = Vector((t.y, -t.x, 0))
        ref = Vector(outward(p.x, p.y) + (0,)) if outward else Vector((0, 1 if p.y > 0 else -1, 0))
        if o.dot(ref) < 0:
            o = -o
        rings.append([mb.v(p + o * d + Vector((0, 0, h))) for (d, h) in prof])
    n0 = mb.nfaces()
    for i in range(len(rings) - 1):
        for j in range(len(prof) - 1):
            mb.f([rings[i][j], rings[i + 1][j], rings[i + 1][j + 1], rings[i][j + 1]], mat)
        mb.f([rings[i][-1], rings[i + 1][-1], rings[i + 1][0], rings[i][0]], back_mat)
    for ri_, sgn in ((0, -1), (-1, 1)):
        rr = rings[ri_]
        c = sum((v.co for v in rr), Vector()) / len(rr)
        t = (P[-1] - P[-2]).normalized() if ri_ == -1 else (P[0] - P[1]).normalized()
        tip = mb.v(c + t * 0.012)
        for j in range(len(prof) - 1):
            mb.f([rr[j], rr[j + 1], tip], mat)
    mb.recalc(n0)


def overrider(mb, x, y0, sgn, zlo, ztop, q, r=0.033, mat="chrome"):
    """vertical bumper horn (over-rider), leaning back at the top; sgn = -1 front, +1 rear"""
    path = [(x, y0, zlo), (x, y0, zlo + 0.12), (x, y0 + sgn * 0.004, ztop - 0.05),
            (x, y0 - sgn * 0.012, ztop - 0.012), (x, y0 - sgn * 0.035, ztop)]
    if q["bumper_n"] <= 8:
        path, radii = [path[0], path[2], path[4]], [r * 0.94, r * 0.97, r * 0.76]
    elif q["bumper_n"] <= 12:
        path, radii = [path[0], path[2], path[3], path[4]], [r * 0.91, r * 0.97, r * 0.88, r * 0.73]
    else:
        radii = [r * 0.91, r, r * 0.97, r * 0.88, r * 0.73]
    tube(mb, path, r, q["tube"], mat, radii=radii, cap_start=q["bumper_n"] > 8)


# --------------------------------------------------------------------------
# wheels
# --------------------------------------------------------------------------
def build_wheel(q, name, style):
    """wheel as one lathe around the axle (local Z -> world X), hubcap outwards (+X).
    style: R (tyre radius), w (tread width), bead (rim radius), ww (whitewall (r0, r1) or None),
    rim ("rim_paint" / "paint_primary" / "paint_black" ...), hub_r, hub_h (dome height), holes (rim
    vent ring radius or None), hub_mat ("hubcap")."""
    mb = MB()
    M = Matrix(((0, 0, 1), (1, 0, 0), (0, 1, 0)))
    R, w, bead = style["R"], style["w"], style["bead"]
    hw = w / 2
    ww = style.get("ww")
    rim = style.get("rim", "rim_paint")
    hub_r, hub_h = style.get("hub_r", 0.125), style.get("hub_h", 0.03)
    side_z = hw + 0.034                               # outer sidewall bulge
    rim_face = hw + 0.012                            # flange plane
    if q["tire"] == "hi":
        prof = [(0.0, -hw * 0.6), (R - 0.035, -hw - 0.032), (R + 0.0025, -hw),
                (R + 0.0025, hw), (R - 0.007, hw + 0.022), (R - 0.030, side_z - 0.0015)]
        mats = ["trim_dark", "rubber", "tread", "rubber", "rubber"]
        if ww:
            prof += [(ww[1], side_z + 0.002), (ww[0], side_z + 0.001)]
            mats += ["rubber", "wheel_white"]
        else:
            prof += [((R + bead) / 2, side_z + 0.002)]
            mats += ["rubber"]
        prof += [(bead + 0.011, side_z - 0.003), (bead, rim_face + 0.008), (bead - 0.012, rim_face + 0.004)]
        mats += ["rubber", "rubber", rim]
        # rim dish down to the hubcap edge
        prof += [(hub_r + 0.02, rim_face - 0.012), (hub_r + 0.004, rim_face - 0.011), (hub_r, rim_face - 0.001)]
        mats += [rim, rim, "chrome"]
        prof += [(hub_r * 0.88, rim_face + hub_h * 0.45), (hub_r * 0.62, rim_face + hub_h * 0.8),
                 (hub_r * 0.3, rim_face + hub_h * 0.97), (0.0, rim_face + hub_h)]
        mats += ["hubcap", "hubcap", "hubcap", "hubcap"]
        uvb = {2: (0.0, 1.0)}
    elif q["tire"] == "mid":
        prof = [(0.0, -hw * 0.6), (R - 0.033, -hw - 0.03), (R + 0.0015, -hw), (R + 0.0015, hw),
                (R - 0.033, side_z)]
        mats = ["trim_dark", "rubber", "tread", "rubber"]
        if ww:
            prof += [(ww[1], side_z + 0.002), (ww[0], side_z + 0.001)]
            mats += ["rubber", "wheel_white"]
        prof += [(bead, rim_face + 0.006), (hub_r + 0.01, rim_face - 0.012), (hub_r, rim_face), (hub_r * 0.55, rim_face + hub_h * 0.8),
                 (0.0, rim_face + hub_h)]
        mats += ["rubber", rim, "chrome", "hubcap", "hubcap"]
        uvb = {2: (0.0, 1.0)}
    else:
        prof = [(0.0, -hw * 0.6), (R, -hw - 0.01), (R, hw + 0.01)]
        mats = ["rubber", "rubber"]
        if ww:
            prof += [(ww[1], side_z), (ww[0], side_z)]
            mats += ["rubber", "wheel_white"]
        prof += [(bead, rim_face + 0.004), (0.0, rim_face + hub_h)]
        mats += ["rubber", rim if hub_r < 0.09 else "chrome"]
        uvb = None
    assert len(mats) == len(prof) - 1, (len(mats), len(prof))
    lathe(mb, prof, q["wheel_segs"], M, Vector((0, 0, 0)), mats, uv_bands=uvb, uv_planar={"hubcap": CAR["hub_r"]})
    if style.get("holes") and q["tire"] == "hi":
        # ring of dark vent holes on the rim dish (decals just above the paint of the dish cone)
        rr = style["holes"]
        k = style.get("n_holes", 8)
        r0, h0 = bead - 0.012, rim_face + 0.004
        r1, h1 = hub_r + 0.02, rim_face - 0.012
        hd = h0 + (h1 - h0) * (r0 - rr) / (r0 - r1) + 0.0015
        hl, hh = style.get("hole_size", (0.022, 0.012))
        for i in range(k):
            a = 2 * math.pi * (i + 0.5) / k
            c = Vector((hd, math.cos(a) * rr, math.sin(a) * rr))
            t = Vector((0, -math.sin(a), math.cos(a)))
            rad = Vector((0, math.cos(a), math.sin(a)))
            n = 8 if style.get("round_holes") else 4
            ring = [mb.v(c + t * (hl * math.cos(2 * pi * (j + 0.5) / n) * (1.0 if n == 8 else 1.41))
                         + rad * (hh * math.sin(2 * pi * (j + 0.5) / n) * (1.0 if n == 8 else 1.41))) for j in range(n)]
            mb.f(ring[::-1], "trim_dark")
    return mb.obj(name, smooth_angle=40)


# --------------------------------------------------------------------------
# surfboard (hidden accessory)
# --------------------------------------------------------------------------
def surfboard_board(mb, q, yc, z0, L=2.6, W=0.56, T=0.075, x0=0.0, pitch=0.0):
    """board lying along Y (nose towards -Y) centred at (x0, yc), deck bottom at z0 - T/2"""
    NSb = q["surf_n"]
    ANG = [0, 40, 75, 86, 94, 105, 140, 180, 230, 310] if NSb > 8 else (
        [0, 60, 80, 100, 120, 180, 270] if NSb > 6 else [0, 75, 105, 180, 270])
    Mp = Matrix.Rotation(pitch, 3, "X")
    ctr = Vector((x0, yc, z0))
    stations = []
    for i in range(NSb + 1):
        s_ = i / NSb
        y = -L / 2 + L * s_
        wv = W / 2 * math.sin(pi / 2 * (s_ / 0.4)) ** 0.55 if s_ < 0.4 else W / 2 * (1 - 0.40 * ((s_ - 0.4) / 0.6) ** 2.2)
        wv = max(wv, 0.02)
        th = T * (0.55 + 0.45 * math.sin(pi * min(1, max(0.0, s_ * 1.05))) ** 0.5)
        rock = 0.06 * max(0.0, 1 - s_ / 0.22) ** 2
        ring = []
        for deg in ANG:
            t = math.radians(deg)
            p = Vector((wv * math.cos(t), y, rock + th / 2 * math.sin(t) * (1.0 if math.sin(t) > 0 else 0.8)))
            ring.append(mb.v(ctr + Mp @ p))
        stations.append(ring)
    stripe = {i for i, a in enumerate(ANG) if 70 < a < 110}
    n0 = mb.nfaces()
    mb.grid(stations, lambda i, j: "surf_stripe" if (j in stripe and (j + 1) % len(ANG) in stripe) else "surf_board", closed=True)
    mb.fan(stations[0], ctr + Mp @ Vector((0, -L / 2 - 0.01, 0.05)), "surf_board", flip=True)
    mb.fan(stations[-1], ctr + Mp @ Vector((0, L / 2 + 0.005, 0)), "surf_board")
    mb.recalc(n0)
    yf, zf = L / 2 - 0.20, T / 2 - 0.012
    fin = [(yf - 0.085, zf), (yf - 0.035, zf + 0.045), (yf + 0.025, zf + 0.090), (yf + 0.085, zf + 0.115),
           (yf + 0.072, zf + 0.080), (yf + 0.058, zf + 0.030), (yf + 0.050, zf)]
    n0 = mb.nfaces()
    nf = len(fin)
    fl = [mb.v(ctr + Mp @ Vector((-0.004, y_, z_))) for y_, z_ in fin]
    fr = [mb.v(ctr + Mp @ Vector((0.004, y_, z_))) for y_, z_ in fin]
    for k in range(1, nf - 1):
        mb.f([fl[0], fl[k + 1], fl[k]], "surf_stripe")
        mb.f([fr[0], fr[k], fr[k + 1]], "surf_stripe")
    for k in range(nf):
        mb.f([fl[k], fl[(k + 1) % nf], fr[(k + 1) % nf], fr[k]], "surf_stripe")
    mb.recalc(n0, soft=False)


def roof_rack(mb, S, q, ys, x_half, z_bar):
    """two chrome bars across the roof at the given y: straight at z_bar over the roof, legs down to
    clamps on the roof edge at +-x_half"""
    sides = max(4, q["tube"] - 4)
    for yb in ys:
        foot, n = S.top(x_half, yb)
        foot = foot + n * 0.012
        path = [(foot.x, yb, foot.z), (x_half - 0.02, yb, z_bar - 0.03), (x_half - 0.07, yb, z_bar),
                (-(x_half - 0.07), yb, z_bar), (-(x_half - 0.02), yb, z_bar - 0.03), (-foot.x, yb, foot.z)]
        tube(mb, path, 0.0125, sides, "chrome")
        if q["surf_n"] > 8:
            for sx in (1, -1):
                box(mb, (sx * foot.x, yb, foot.z), (0.035, 0.05, 0.03), "trim_dark")
        if q["surf_n"] > 6:
            box(mb, (0.0, yb, z_bar + 0.016), (0.46, 0.035, 0.012), "trim_dark")


def finish_surfboard(mb, parent):
    o = mb.obj("accessory_surfboard", smooth_angle=50, parent=parent)
    o["default_visible"] = False
    o["role"] = "accessory"
    return o


# --------------------------------------------------------------------------
# atlas remap
# --------------------------------------------------------------------------
def atlasify(o):
    """paints keep their clearcoat materials, glass + blob share 'glass', everything else goes onto
    the atlas (palette cell or UV region)"""
    me = o.data
    names = [m.name for m in me.materials]
    used = {names[p.material_index] for p in me.polygons}
    keep = [n for n in PAINTS if n in used]
    new_names = list(keep)
    AT = CAR["atlas"][0]
    if any(n not in keep and n not in GLASSY for n in used):
        new_names.append(AT)
    if any(n in GLASSY for n in used):
        new_names.append("glass")
    if not me.uv_layers:
        me.uv_layers.new(name="UVMap")
    while len(me.uv_layers) > 1:
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
        elif n.startswith(CAR["id"] + "_atlas"):
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
    me.materials.clear()
    for n in new_names:
        me.materials.append(get_mat(n))
    me.polygons.foreach_set("material_index", new_idx)
    me.update()


# --------------------------------------------------------------------------
# assembly of one LOD
# --------------------------------------------------------------------------
REQUIRED_NODES = ["body", "wheel_fl", "wheel_fr", "wheel_rl", "wheel_rr", "wheel_fl_geo", "wheel_fr_geo",
                  "wheel_rl_geo", "wheel_rr_geo", "accessory_surfboard", "socket_exhaust", "socket_nametag",
                  "socket_underglow", "socket_headlight_l", "socket_headlight_r", "socket_taillight_l",
                  "socket_taillight_r"]
BUDGET = {0: 20000, 1: 7000, 2: 2000}


def arch_cutter(y, zc, r, x0, width=0.9, segs=32, name="cutter", mat="trim_dark"):
    """cylinder along X from x0 (towards +X, width) for a wheel-arch boolean"""
    mb = MB()
    M = Matrix(((0, 0, 1), (1, 0, 0), (0, 1, 0)))
    lathe(mb, [(0.0, 0.0), (r, 0.0), (r, width), (0.0, width)], segs, M, Vector((x0, y, zc)), [mat] * 3)
    return mb.obj(name)


def boolean_diff(target, cutters):
    for c in cutters:
        mod = target.modifiers.new("cut", "BOOLEAN")
        mod.operation = "DIFFERENCE"
        mod.solver = "EXACT"
        mod.object = c
        if hasattr(mod, "material_mode"):
            mod.material_mode = "TRANSFER"
    apply_all_modifiers(target)


def assemble(lod, q, root_props, shell_parts, arch_fn, details_fn, inner_fn, surf_fn, wheel_style, wheels,
             nametag_z, cut_targets=None):
    """one LOD of a car following tools/models/README.md.
    shell_parts: {name: MB} painted body pieces (the first one gets the window cuts unless cut_targets)
    arch_fn(q) -> [(cutter object, [part names])] wheel-arch booleans
    details_fn(S, q) -> (MB, sockets dict) everything projected on the body (S = all shell parts)
    inner_fn(q) -> MB or None: closed coarse inner shell (gets the window cuts, then flipped)
    surf_fn(S, q, root) -> accessory_surfboard object
    wheels: [(name, x, y, steer)] with the wheel centre height = wheel_style R."""
    t0 = time.time()
    CAR["cuts"].clear()
    cid = CAR["id"]
    CAR["atlas"][0] = cid + ("_atlas_lod2" if lod == 2 else "_atlas")
    root = empty("car_" + cid, (0, 0, 0))
    root["car_type"] = cid
    root["lod"] = lod
    root["forward"] = "+Z (three.js) / -Y (Blender)"
    root["left"] = "+X"
    root["units"] = "1 u = 1 m"
    root["blender"] = bpy.app.version_string
    root["script_sha1"] = CAR["hash"]
    for k, v in root_props.items():
        root[k] = v
    root["materials_note"] = "paint_primary = player colour (clone per car), emissiveIntensity on %s_atlas = lights" % cid
    root["wheels_merged"] = bool(q["merge_wheels"])
    rep = {"lod": lod, "objects": {}, "build_s": 0, "timing": {}}
    objs = {}
    for name, mb in shell_parts.items():
        objs[name] = mb.obj(name, smooth_angle=q.get("smooth", 38), mat_sharp=False)
    S = Surf(to_bvh(list(objs.values())))
    rep["shell_tris"] = {n: tri_count(o) for n, o in objs.items()}
    for cutter, targets in arch_fn(q):
        for tn in targets:
            if tn in objs:
                boolean_diff(objs[tn], [cutter])
        bpy.data.objects.remove(cutter, do_unlink=True)
    det_mb, sockets = details_fn(S, q)
    parts = dict(det_mb.parts)
    t = time.time()
    rep["window_cuts"] = len(CAR["cuts"])
    names = list(objs)
    main_name = names[0]
    if CAR["cuts"]:
        wc = make_cutters()
        for tn in (cut_targets or [main_name]):
            boolean_cut(objs[tn], wc)
            delete_faces_with(objs[tn], {"cut_cap"})
        inner_mb = inner_fn(q) if inner_fn else None
        if inner_mb is not None:
            inner = inner_mb.obj("inner", smooth_angle=50, mat_sharp=False) if isinstance(inner_mb, MB) else inner_mb
            boolean_cut(inner, wc)
            delete_faces_with(inner, {"cut_cap", "rubber"})
            bm = bmesh.new()
            bm.from_mesh(inner.data)
            bmesh.ops.reverse_faces(bm, faces=bm.faces)
            bm.to_mesh(inner.data)
            bm.free()
            parts["inner_shell"] = tri_count(inner)
            objs["inner"] = inner
        bpy.data.objects.remove(wc, do_unlink=True)
    rep["timing"]["window_booleans_s"] = round(time.time() - t, 2)
    rep["shell_tris_after_cuts"] = {n: tri_count(o) for n, o in objs.items()}
    body = objs[main_name]
    others = [o for n, o in objs.items() if n != main_name]
    det = det_mb.obj("details", smooth_angle=40)
    join([body] + others + [det], body)
    body.name = "body"
    body.data.name = "body"
    body.parent = root
    resmooth_by_material(body, q.get("smooth", 38), "paint_")
    rep["invalid_fixed"] = bool(body.data.validate(verbose=False))   # degenerate faces left by the booleans
    # wheels
    R = wheel_style["R"]
    wheel_mesh = None
    wheel_objs = []
    for nm, x, y, steer in wheels:
        e = empty(nm, (x, y, R), root, role="wheel", steer=steer, radius=round(R, 4),
                  side=("left" if x > 0 else "right"), axle=("front" if steer else "rear"))
        if wheel_mesh is None:
            wt = build_wheel(q, "wheel", wheel_style)
            wheel_mesh = wt.data
            wheel_mesh.name = "wheel"
            atlasify(wt)
            bpy.data.objects.remove(wt, do_unlink=True)
        if q["merge_wheels"]:
            g = bpy.data.objects.new(nm + "_tmp", wheel_mesh.copy())
            bpy.context.scene.collection.objects.link(g)
            g.matrix_world = Matrix.Translation((x, y, R)) @ (Matrix.Rotation(pi, 4, "Z") if x < 0 else Matrix.Identity(4))
            wheel_objs.append(g)
            empty(nm + "_geo", (0, 0, 0), e, role="wheel_geo_merged")
            continue
        g = bpy.data.objects.new(nm + "_geo", wheel_mesh)
        bpy.context.scene.collection.objects.link(g)
        g.parent = e
        if x < 0:
            g.rotation_euler = (0, 0, pi)
    if wheel_objs:
        bpy.context.view_layer.update()
        for g in wheel_objs:
            g.data.transform(g.matrix_world)
            g.matrix_world = Matrix.Identity(4)
        join([body] + wheel_objs, body)
    board = surf_fn(S, q, root)
    for k, v in sockets.items():
        empty(k, tuple(v), root, role="socket")
    empty("socket_nametag", (0, 0, nametag_z), root, role="socket")
    empty("socket_underglow", (0, 0, 0.05), root, role="socket")
    bpy.context.view_layer.update()
    if lod < 2 and "no-ao" not in CAR["opt"]:
        wheel_geos = [o for o in root.children_recursive if o.name.endswith("_geo") and o.type == "MESH"]
        rep["ao_body"] = bake_ao(body, [body] + wheel_geos, samples=32 if lod == 0 else 20,
                                 skip=GLASSY, interior_mats=INTERIOR_MATS, interior_strength=0.25)
        if wheel_geos:
            w0 = wheel_geos[0]
            rep["ao_wheel"] = bake_ao(w0, [w0], samples=24 if lod == 0 else 16, dist=0.10, strength=0.8,
                                      skip=GLASSY, interior_mats=INTERIOR_MATS)
    atlasify(body)
    atlasify(board)
    bpy.context.view_layer.update()
    rep["detail_parts_tris"] = parts
    rep["body_primitives"] = [m.name for m in body.data.materials]
    summarize_lod(root, rep, BUDGET[lod], REQUIRED_NODES)
    rep["build_s"] = round(time.time() - t0, 2)
    return root, rep


def main(build_lod, dims_used):
    """LOD loop (2, 1, 0 by default): build, export <out>/<id>_lod<n>.glb, report.json, LOD0 .blend,
    then (options) --ortho blueprint renders, --icon=<png> car-select icon or Eevee look-dev views."""
    T0 = time.time()
    cid, out, opt = CAR["id"], CAR["out"], CAR["opt"]
    report = {"model": cid, "blender": bpy.app.version_string, "script_sha1": CAR["hash"], "lods": {},
              "axes": {"units": "1 u = 1 m", "forward": "three +Z (Blender -Y)", "left": "three +X", "up": "three +Y",
                       "origin": "ground, footprint centre"}, "dims_used": dims_used}
    car0 = None
    for lod in CAR["lods"]:
        set_paint_coat(lod < 2)
        root, rep = build_lod(lod)
        rep["glb"] = export_glb(root, os.path.join(out, "%s_lod%d.glb" % (cid, lod)))
        report["lods"][lod] = rep
        print("LOD", lod, json.dumps({k: rep[k] for k in ("triangles_total", "draw_calls_est", "size_m", "budget_ok",
                                                             "required_nodes_ok", "window_cuts", "timing")}))
        print("   parts", rep["detail_parts_tris"], rep["objects"])
        print("   shell", rep["shell_tris"], "->", rep["shell_tris_after_cuts"])
        if lod == min(CAR["lods"]):
            car0 = root
        else:
            delete_hierarchy(root)
    if car0 is not None:
        set_paint_coat(True)
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out, "%s_lod%d.blend" % (cid, min(CAR["lods"]))))
        views = opt.get("views", "front34,side,rear34,chase").split(",")
        if "ortho" in opt:
            report["ortho"] = bd_lookdev.render_ortho(os.path.join(out, "work"))
        if "icon" in opt:
            bd_lookdev.wire_ao_for_render(PAINTS + (cid + "_atlas",))
            report["icon"] = bd_lookdev.render_icon(car0, bd_lookdev.load_env("victoria_sunset_2k"), opt["icon"],
                                                   bd_lookdev.icon_size(opt))
        elif "no-render" not in opt:
            report["renders"] = bd_lookdev.render_views(
                car0, bd_lookdev.load_env("victoria_sunset_2k"), os.path.join(out, "renders"), opt.get("suffix", ""),
                views, ao_materials=PAINTS + (cid + "_atlas", cid + "_atlas_lod2"))
    report["build_s"] = round(time.time() - T0, 1)
    json.dump(report, open(os.path.join(out, "report.json"), "w"), indent=1)
    print("DONE", report["build_s"], "s")
