# Bulli Drive -- Porsche 356 B T6 Coupe (1962/63) ("sport"), procedural Blender build.
#
#   blender -b --factory-startup --python tools/models/vehicles/sport.py -- \
#       [--out=<dir>] [--lods=2,1,0] [--no-render] [--views=front34,side] [--ortho] [--no-ao] [--icon=<png>]
#
# Built on tools/models/lib/bd_car.py. The 356 is one smooth shell: a Catmull-Rom loft of half
# cross-sections whose points carry the fender crowns and haunches (no separate fenders like the
# Kaefer). Stations measured on ref/sport_blueprint.jpg (AI sheet, generated for this build) and
# fitted to the real dimensions (ref/dimensions.json, de.wikipedia Porsche 356). Badge: a stylised
# crest (atlas region, bd_car.crest_pixels), no photographic trademark artwork.
# Station positions s are metres behind the front bumper tip; Blender y = s - LENGTH / 2.
import os, sys, math, json
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "lib"))
from bd_car import *                                  # noqa: E402,F403
import bd_car                                         # noqa: E402
from mathutils import Vector, Matrix                  # noqa: E402

DIMS = json.load(open(os.path.join(bd_car.MODELS, "ref", "dimensions.json")))["vehicles"]["sport"]
LENGTH = DIMS["length_m"]["value"]            # 4.01
WIDTH = DIMS["width_m"]["value"]              # 1.67
HEIGHT = DIMS["height_m"]["value"]            # 1.31
WB = DIMS["wheelbase_m"]["value"]             # 2.10
TRACK_F = DIMS["track_front_m"]["value"]      # 1.306
TRACK_R = DIMS["track_rear_m"]["value"]       # 1.272
WR = DIMS["tire_diameter_m"]["value"] / 2     # 0.326
S_AXLE_F = 0.83                               # blueprint: front overhang 43.5 % of both overhangs
S_AXLE_R = S_AXLE_F + WB
Y0 = -LENGTH / 2


def Y(s):
    return Y0 + s


init("sport", "Porsche 356 B T6 Coupe (1963)", DIMS,
     specs={"paint_primary": dict(col="#A9ABA8"),            # silver grey (Silbermetallic, calm)
            "rim_paint": dict(col="#BFC1C2", rough=0.3, metal=0.6),
            "interior": dict(col="#6F665C"), "seat": dict(col="#8A7F72"), "headliner": dict(col="#DDD6C8")},
     hub_logo="ring", hub_r=0.105, hub_logo_r=0.05, wheel_radius=WR, tread_width=0.125)

# --------------------------------------------------------------------------
# body: 11 points per half section, bottom centre -> top centre:
#   0 bottom centre, 1 floor edge, 2 lower side, 3 max width, 4 fender side, 5 fender shoulder,
#   6 fender crest / belt, 7 valley or greenhouse base, 8 bonnet edge / roof edge, 9 roof side, 10 crown
# (side 232.5 px/m, heights 248 px/m, plan 219 px/m)
# --------------------------------------------------------------------------
def _deg(s, z0, z1):
    return (s, [(0, z0 + (z1 - z0) * k / 10) for k in range(11)])


BODY = [
    _deg(0.050, 0.33, 0.45),
    (0.105, [(0, 0.28), (0.36, 0.28), (0.48, 0.30), (0.55, 0.37), (0.555, 0.42), (0.52, 0.46), (0.45, 0.49), (0.34, 0.51), (0.22, 0.52), (0.10, 0.525), (0, 0.53)]),
    (0.200, [(0, 0.23), (0.55, 0.23), (0.70, 0.28), (0.76, 0.45), (0.745, 0.60), (0.69, 0.70), (0.61, 0.73), (0.50, 0.70), (0.36, 0.69), (0.18, 0.685), (0, 0.685)]),
    (0.400, [(0, 0.22), (0.60, 0.22), (0.77, 0.27), (0.82, 0.45), (0.80, 0.62), (0.73, 0.76), (0.63, 0.80), (0.52, 0.78), (0.38, 0.77), (0.20, 0.765), (0, 0.765)]),
    (0.830, [(0, 0.24), (0.62, 0.24), (0.78, 0.30), (0.835, 0.48), (0.82, 0.64), (0.75, 0.78), (0.64, 0.83), (0.53, 0.825), (0.38, 0.838), (0.20, 0.845), (0, 0.846)]),
    (1.200, [(0, 0.22), (0.66, 0.22), (0.79, 0.28), (0.835, 0.48), (0.825, 0.66), (0.76, 0.80), (0.67, 0.85), (0.57, 0.86), (0.40, 0.885), (0.20, 0.897), (0, 0.90)]),
    (1.560, [(0, 0.21), (0.68, 0.21), (0.80, 0.27), (0.835, 0.48), (0.825, 0.66), (0.77, 0.80), (0.69, 0.86), (0.62, 0.90), (0.45, 0.915), (0.22, 0.922), (0, 0.925)]),
    (1.680, [(0, 0.21), (0.68, 0.21), (0.80, 0.27), (0.835, 0.48), (0.825, 0.66), (0.77, 0.80), (0.69, 0.87), (0.64, 0.95), (0.57, 1.07), (0.30, 1.09), (0, 1.095)]),
    (1.820, [(0, 0.21), (0.68, 0.21), (0.80, 0.27), (0.835, 0.48), (0.83, 0.65), (0.78, 0.79), (0.69, 0.875), (0.635, 0.975), (0.525, 1.215), (0.30, 1.245), (0, 1.25)]),
    (2.100, [(0, 0.21), (0.68, 0.21), (0.80, 0.27), (0.835, 0.48), (0.83, 0.64), (0.78, 0.78), (0.70, 0.86), (0.64, 0.97), (0.525, 1.24), (0.32, 1.29), (0, 1.30)]),
    (2.400, [(0, 0.21), (0.68, 0.21), (0.80, 0.27), (0.835, 0.48), (0.83, 0.64), (0.78, 0.78), (0.70, 0.86), (0.64, 0.97), (0.525, 1.245), (0.32, 1.30), (0, 1.31)]),
    (2.800, [(0, 0.22), (0.66, 0.22), (0.80, 0.28), (0.835, 0.48), (0.83, 0.66), (0.79, 0.79), (0.72, 0.87), (0.64, 0.96), (0.50, 1.18), (0.30, 1.225), (0, 1.237)]),
    (3.100, [(0, 0.24), (0.62, 0.24), (0.78, 0.30), (0.815, 0.48), (0.81, 0.66), (0.76, 0.79), (0.66, 0.86), (0.57, 0.93), (0.45, 1.03), (0.26, 1.075), (0, 1.09)]),
    (3.400, [(0, 0.27), (0.56, 0.27), (0.72, 0.32), (0.77, 0.48), (0.76, 0.64), (0.70, 0.76), (0.60, 0.82), (0.50, 0.85), (0.38, 0.875), (0.20, 0.89), (0, 0.895)]),
    (3.650, [(0, 0.30), (0.45, 0.30), (0.60, 0.34), (0.66, 0.46), (0.64, 0.58), (0.58, 0.66), (0.48, 0.69), (0.38, 0.70), (0.26, 0.705), (0.13, 0.71), (0, 0.71)]),
    (3.820, [(0, 0.32), (0.36, 0.32), (0.48, 0.35), (0.52, 0.43), (0.50, 0.50), (0.44, 0.535), (0.36, 0.55), (0.27, 0.555), (0.18, 0.558), (0.09, 0.56), (0, 0.56)]),
    (3.910, [(0, 0.34), (0.20, 0.34), (0.28, 0.36), (0.31, 0.40), (0.30, 0.44), (0.26, 0.46), (0.20, 0.47), (0.15, 0.473), (0.10, 0.475), (0.05, 0.476), (0, 0.477)]),
    _deg(3.950, 0.35, 0.46),
]


def body_stations(inset_d=0.0, s_range=None, keep=None):
    out = []
    for i, (s, prof) in enumerate(BODY):
        if s_range and not (s_range[0] <= s <= s_range[1]):
            continue
        if keep is not None and i not in keep:
            continue
        pts = []
        for k, (x, z) in enumerate(prof):
            if inset_d:
                x = max(0.0, x - inset_d) if x > 0 else 0.0
                z = z + inset_d if k <= 2 else (z - inset_d if k >= 8 else z)
            pts.append(Vector((x, Y(s), z)))
        out.append(pts)
    return out


def build_body(q):
    mb = MB()
    loft(mb, body_stations(keep=q.get("keep")), q["body_u"], q["body_v"], lambda c: "paint_primary")
    return mb


# --------------------------------------------------------------------------
# details
# --------------------------------------------------------------------------
def details(S, q):
    mb = MB()
    sockets = {}
    # ---------------- windows ----------------
    for sx in (1, -1):
        N = Vector((sx, 0, 0.30)).normalized()
        O, _ = S.side(sx, Y(2.1), 1.0)
        pane(mb, S, O, N, [(sx * 0.7, Y(1.72), 0.86), (sx * 0.7, Y(2.43), 0.86), (sx * 0.7, Y(2.43), 1.14),
                           (sx * 0.7, Y(1.93), 1.14)], [0.02, 0.03, 0.04, 0.06], q)
        if q["vent_bar"]:
            a, na = S.side(sx, Y(1.93), 0.87)
            b, nb = S.side(sx, Y(1.96), 1.13)
            tube(mb, [a + na * 0.006, b + nb * 0.006], 0.005, q["vent_bar"], "chrome")
        O, _ = S.side(sx, Y(2.65), 1.0)
        pane(mb, S, O, N, [(sx * 0.7, Y(2.47), 0.86), (sx * 0.7, Y(2.90), 0.86), (sx * 0.7, Y(2.72), 1.13),
                           (sx * 0.7, Y(2.47), 1.14)], [0.03, 0.06, 0.12, 0.04], q)
    mb.part("windows_side")
    O, N = S.front(0, 1.07)
    cs = [S.front(x, z)[0] for (x, z) in ((-0.60, 0.94), (0.60, 0.94), (0.50, 1.205), (-0.50, 1.205))]
    pane(mb, S, O, N, cs, [0.05, 0.05, 0.07, 0.07], q, grings=q["ws_rings"], curved=q["curved"])
    O, N = S.rear(0, 1.09)
    cs = [S.rear(x, z)[0] for (x, z) in ((0.43, 0.99), (-0.43, 0.99), (-0.40, 1.19), (0.40, 1.19))]
    pane(mb, S, O, N, cs, [0.09, 0.09, 0.11, 0.11], q, grings=min(1, q["ws_rings"]), curved=q["curved"])
    mb.part("windows_front_rear")

    # ---------------- seams and trim ----------------
    if q["seams"]:
        for sx in (1, -1):
            X = Vector((sx, 0, 0))
            door = [(1.36, 0.86), (1.33, 0.78), (1.32, 0.45), (1.36, 0.40), (2.44, 0.40), (2.48, 0.45), (2.48, 0.86)]
            seam(mb, S, [(sx * 0.9, Y(s), z) for (s, z) in door], X)
        Z = Vector((0, 0, 1))
        lid = [(0.0, 0.14), (0.24, 0.20), (0.40, 0.40), (0.52, 0.80), (0.57, 1.10), (0.50, 1.40), (0.0, 1.46)]
        seam(mb, S, [(x, Y(s), 3.0) for (x, s) in lid] + [(-x, Y(s), 3.0) for (x, s) in reversed(lid[:-1])], Z, seg=0.08)
        lid = [(0.0, 3.26), (0.40, 3.27), (0.46, 3.45), (0.42, 3.68), (0.0, 3.73)]
        seam(mb, S, [(x, Y(s), 3.0) for (x, s) in lid] + [(-x, Y(s), 3.0) for (x, s) in reversed(lid[:-1])], Z, seg=0.08)
        mb.part("seams")
    if q["strips"]:
        for sx in (1, -1):                                   # rocker chrome strip
            pts = [Vector((sx * 0.9, Y(s), 0.33)) for s in (1.34, 1.6, 1.9, 2.2, 2.46)]
            on_surface_strip(mb, S, pts, (sx, 0, 0), [(-0.008, -0.001), (-0.005, 0.005), (0.005, 0.005), (0.008, -0.001)], "chrome")
        # bonnet handle spear
        pts = [Vector((0, Y(s), 3.0)) for s in (0.16, 0.25, 0.36, 0.48)]
        pts2, nrm = [], []
        for k, p in enumerate(pts):
            loc, n = S.ray(p, (0, 0, -1))
            pts2.append(loc)
            nrm.append(n)
        prof = [(-0.018, -0.001), (-0.012, 0.012), (0.012, 0.012), (0.018, -0.001)]
        strip(mb, pts2[:2], nrm[:2], prof, "chrome")
        strip(mb, pts2[1:], nrm[1:], [(-0.009, -0.001), (0.0, 0.008), (0.009, -0.001)], "chrome")
        mb.part("trim")
    if q["louvers"]:                                          # twin engine grilles on the lid
        for sx in (1, -1):
            xc = sx * 0.095
            for k in range(-4, 5):
                x = xc + k * 0.016
                a, na = S.ray((x, Y(3.40), 3.0), (0, 0, -1))
                b, nb = S.ray((x, Y(3.60), 3.0), (0, 0, -1))
                strip(mb, [a, a.lerp(b, 0.5), b], [na, na.lerp(nb, 0.5), nb], [(-0.004, 0.003), (0.004, 0.003)], "chrome")
            frame = [(xc - 0.078, 3.39), (xc + 0.078, 3.39), (xc + 0.078, 3.61), (xc - 0.078, 3.61), (xc - 0.078, 3.39)]
            seam(mb, S, [(x, Y(s), 3.0) for (x, s) in frame], Vector((0, 0, 1)), width=0.012, off=0.0015, mat="trim_dark", seg=0.05)
        mb.part("grilles")
    if q["handles"]:
        for sx in (1, -1):
            loc, n = S.side(sx, Y(2.30), 0.73)
            p0, p1 = loc + n * 0.014 + Vector((0, -0.045, 0)), loc + n * 0.014 + Vector((0, 0.045, 0))
            tube(mb, [loc + Vector((0, -0.05, 0)) - n * 0.002, p0, p1, loc + Vector((0, 0.05, 0)) - n * 0.002],
                 0.007, 6, "chrome")
        mb.part("handles")

    # ---------------- lamps ----------------
    for sx in (1, -1):
        loc, n = S.front(sx * 0.64, 0.64)
        n = (n + Vector((0, -0.7, 0.05))).normalized()
        sockets["socket_headlight_" + ("l" if sx > 0 else "r")] = headlight(mb, loc, n, 0.112, q)
        if q["lamp"] > 8:
            loc, n = S.front(sx * 0.64, 0.445)
            round_lamp(mb, loc, n, 0.028, q, lens="lamp_amber")
            # horn grille: chrome-rimmed dark slot
            a, na = S.front(sx * 0.605, 0.452)
            b, nb = S.front(sx * 0.48, 0.452)
            strip(mb, [a, b], [na, nb], [(-0.014, 0.002), (-0.011, 0.005), (0.011, 0.005), (0.014, 0.002)], "chrome")
            strip(mb, [a, b], [na, nb], [(-0.010, 0.0055), (0.010, 0.0055)], "trim_dark")
        loc, n = S.rear(sx * 0.56, 0.49)
        sockets["socket_taillight_" + ("l" if sx > 0 else "r")] = round_lamp(
            mb, loc, n, 0.075, q, lens="lamp_tail", sx=1.0, sy=0.42, depth=0.03,
            mat_fn=lambda i, j, segs, sx=sx: "chrome" if i < 3 else (
                "lamp_amber" if math.cos(2 * math.pi * (j + 0.5) / segs) * sx < -0.1 else "lamp_tail"))
        if q["lamp"] > 8:
            loc, n = S.rear(sx * 0.56, 0.405)
            round_lamp(mb, loc, n, 0.034, q, lens="lamp_tail", sy=0.35, depth=0.012)          # reflector
    mb.part("lamps")

    # ---------------- badges, plate ----------------
    if q["plate"]:
        O, N = S.rear(0, 0.56)
        plate(mb, O, N, q)
    if q["logo_seg"] > 8:
        O, N = S.ray((0, Y(0.52), 3.0), (0, 0, -1))
        N2 = (N + Vector((0, -0.4, 0))).normalized()
        crest(mb, O + N * 0.003, N2, 0.045, 0.055, up=Vector((0, 1, 0)))
    mb.part("badges")

    # ---------------- bumpers (blade wrapping round the corners, tall over-riders) ----------------
    for front in (True, False):
        sg = -1 if front else 1
        s_mid = 0.03 if front else LENGTH - 0.035
        zc = 0.33 if front else 0.35
        nb = q["bumper_n"]
        path = []
        for i in range(nb + 1):
            t = -1 + 2 * i / nb
            a = t * 1.25
            x = 0.80 * math.sin(a) / math.sin(1.25)
            y = Y(s_mid) - sg * 0.32 * (1 - math.cos(a)) / (1 - math.cos(1.25))
            path.append((x, y))
        blade(mb, path, zc, q, scale=(0.9, 0.62), outward=lambda x, y, sg=sg: (x * 0.8, sg * 1.0))
        for sx in (1, -1):
            x = sx * 0.39
            ay = math.asin(0.39 / 0.80 * math.sin(1.25))
            y0 = Y(s_mid) - sg * 0.32 * (1 - math.cos(ay)) / (1 - math.cos(1.25)) + sg * 0.012
            overrider(mb, x, y0, sg, 0.20, 0.47 if front else 0.48, q, r=0.026)
    mb.part("bumpers")

    # ---------------- mirror, wipers ----------------
    if q["mirrors"]:
        base, n = S.ray((0.66, Y(1.45), 3.0), (0, 0, -1))
        head = base + Vector((0.0, 0.0, 0.10))
        tube(mb, [base, head], 0.007, max(5, q["tube"] - 3), "chrome")
        M = frame_from_axis(Vector((0.1, -1, 0)))
        lathe(mb, [(0.0, -0.014), (0.038, -0.010), (0.048, -0.003), (0.05, 0.004), (0.0, 0.008)],
              max(12, q["lamp"] * 2 // 3), M, head, ["chrome"] * 4)
    if q["wipers"]:
        for sx in (1, -1):
            a, na = S.front(sx * 0.12 + 0.10, 0.935)
            b, nb = S.front(sx * 0.12 + 0.10 - 0.36, 0.955)
            a, b = a + na * 0.01, b + nb * 0.012
            tube(mb, [a, b], 0.0032, 4, "trim_dark")
            box(mb, a - na * 0.004, (0.014, 0.014, 0.014), "chrome")
    mb.part("mirror_wipers")

    # ---------------- underbody, exhaust ----------------
    if q["under"]:
        box(mb, (0, Y(2.0), 0.20), (1.1, 2.6, 0.04), "trim_dark")
        box(mb, (0, Y(3.45), 0.34), (0.8, 0.6, 0.26), "trim_dark")
        for sx in (1, -1):
            tube(mb, [(0, Y(S_AXLE_R), 0.32), (sx * 0.5, Y(S_AXLE_R), WR)], 0.033, 6, "trim_dark")
    p0, p1 = Vector((-0.39, Y(3.80), 0.21)), Vector((-0.39, Y(4.02), 0.20))
    tube(mb, [p0, p1], 0.026, 8 if q["tube"] > 6 else 5, "chrome")
    sockets["socket_exhaust"] = Vector((-0.39, Y(4.03), 0.20))
    mb.part("underbody")

    # ---------------- cabin ----------------
    if q["interior"]:
        box(mb, (0, Y(1.66), 0.82), (1.22, 0.14, 0.10), "paint_primary")        # dashboard
        box(mb, (0, Y(1.64), 0.72), (1.14, 0.08, 0.12), "interior")
        for k, x in enumerate((0.28, 0.40, 0.52)):                             # instruments
            loc = Vector((x, Y(1.74), 0.83))
            lathe(mb, [(0.0, 0.0), (0.045, 0.0), (0.045, 0.01), (0.0, 0.01)], q["int_seg"],
                  frame_from_axis(Vector((0, 1, 0.3))), loc, ["trim_dark", "chrome", "trim_dark"])
        c = Vector((0.38, Y(1.98), 0.86))
        ax = Vector((0, 0.8, 1.0)).normalized()
        Mw = frame_from_axis(ax)
        segs = q["int_seg"] * 2
        rim = [c + Mw @ Vector((0.20 * math.cos(2 * pi * k / segs), 0.20 * math.sin(2 * pi * k / segs), 0)) for k in range(segs)]
        tube(mb, rim, 0.011, 5 if q["int_seg"] > 8 else 4, "ivory", closed=True)
        tube(mb, [c - ax * 0.02, c - ax * 0.4], 0.018, 5, "trim_dark", cap_start=False)
        for sx in (1, -1):                                                     # bucket seats
            box(mb, (sx * 0.36, Y(2.30), 0.38), (0.44, 0.46, 0.12), "seat")
            box(mb, (sx * 0.36, Y(2.58), 0.66), (0.42, 0.10, 0.56), "seat", M=Matrix.Rotation(-0.25, 3, "X"))
        box(mb, (0, Y(2.85), 0.45), (1.05, 0.34, 0.10), "seat")                # small rear bench
        box(mb, (0, Y(3.05), 0.64), (1.05, 0.10, 0.36), "seat", M=Matrix.Rotation(-0.55, 3, "X"))
        mb.part("interior")
    if q["blob"]:
        vs = [mb.v((sx * 1.10, sy * 2.30, 0.012)) for (sx, sy) in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        fc = mb.f(vs, "blob")
        mb.set_uv(fc, vs, [(0, 0), (1, 0), (1, 1), (0, 1)])
    return mb, sockets


def inner_shell(q):
    if not q["interior"]:
        return None
    mb = MB()
    st = body_stations(inset_d=0.045, s_range=(1.55, 3.12))
    loft(mb, st, q["inner_u"], 1, lambda c: "headliner" if c.z > 1.12 else ("floor" if c.z < 0.35 else "interior"),
         cap=(True, True))
    bmesh.ops.recalc_face_normals(mb.bm, faces=mb.bm.faces)
    return mb


def arches(q):
    out = []
    for sx in (1, -1):
        for s_ax, r in ((S_AXLE_F, 0.36), (S_AXLE_R, 0.345)):
            x0 = 0.42 if sx > 0 else -1.4
            out.append((arch_cutter(Y(s_ax), WR + 0.005, r, x0, width=0.98, segs=q["arch_segs"]), ["body"]))
    return out


def surf(S, q, root):
    mb = MB()
    ys = (Y(1.95), Y(2.70))
    roof_rack(mb, S, q, ys, 0.50, 1.39)
    surfboard_board(mb, q, (ys[0] + ys[1]) / 2, 1.39 + 0.022 + 0.0375, L=2.3, W=0.54, T=0.07)
    return finish_surfboard(mb, root)


Q = {
    0: dict(body_u=[2, 2, 3, 3, 3, 3, 3, 3, 3, 2], body_v=[1, 2, 2, 3, 3, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 1, 1],
            inner_u=2, ws_rings=0, curved=False,
            seal=3, glass_rings=2, nc=3, maxseg=0.28, sky_nc=1, strips=True, seams=True, louvers=True, handles=True,
            lamp=28, logo_seg=28, bumper_n=18, tube=8, mirrors=True, wipers=True, plate=True,
            under=True, interior=True, blob=True, holes=True, vent_bar=6, int_seg=10, tire="hi", wheel_segs=32,
            arch_segs=40, surf_n=12, merge_wheels=False, smooth=40),
    1: dict(body_u=[1, 1, 2, 2, 2, 2, 2, 2, 2, 1], body_v=[1, 1, 1, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
            inner_u=1, ws_rings=0, curved=False,
            seal=1, glass_rings=0, nc=2, maxseg=0.9, sky_nc=1, strips=True, seams=False, louvers=False, handles=False,
            lamp=14, logo_seg=14, bumper_n=10, tube=5, mirrors=True, wipers=False, plate=True,
            under=False, interior=True, blob=True, holes=True, vent_bar=0, int_seg=6, tire="mid", wheel_segs=16,
            arch_segs=16, surf_n=6, merge_wheels=False, smooth=40),
    2: dict(body_u=1, keep=[0, 1, 2, 3, 4, 5, 6, 8, 10, 11, 12, 13, 14, 15, 16, 17], body_v=1,
            inner_u=1, ws_rings=0, curved=False,
            seal=0, glass_rings=0, nc=1, maxseg=2.0, sky_nc=1, strips=False, seams=False, louvers=False, handles=False,
            lamp=8, logo_seg=8, bumper_n=6, tube=4, mirrors=False, wipers=False, plate=False,
            under=False, interior=False, blob=False, holes=False, vent_bar=0, int_seg=4, tire="lo", wheel_segs=8,
            arch_segs=8, surf_n=4, merge_wheels=True, smooth=40),
}

WHEEL = dict(R=WR, w=0.125, bead=0.19, ww=None, rim="rim_paint", hub_r=0.105, hub_h=0.05, holes=0.152, n_holes=10,
             hole_size=(0.014, 0.009))


def build_lod(lod):
    q = Q[lod]
    parts = {"body": build_body(q)}
    wheels = [("wheel_fl", TRACK_F / 2, Y(S_AXLE_F), True), ("wheel_fr", -TRACK_F / 2, Y(S_AXLE_F), True),
              ("wheel_rl", TRACK_R / 2, Y(S_AXLE_R), False), ("wheel_rr", -TRACK_R / 2, Y(S_AXLE_R), False)]
    props = dict(model="Porsche 356 B T6 Coupe (1963)", length_m=LENGTH, width_m=WIDTH, height_m=HEIGHT, wheelbase_m=WB,
                 collision_half_extents=[0.86, 0.68, 2.08])
    return assemble(lod, q, props, parts, arches, details, inner_shell, surf, WHEEL, wheels, nametag_z=1.75)


if __name__ == "__main__":
    main(build_lod, {"length": LENGTH, "width": WIDTH, "height": HEIGHT, "wheelbase": WB, "track_f": TRACK_F,
                     "track_r": TRACK_R, "wheel_radius": WR, "axle_f_y": Y(S_AXLE_F), "axle_r_y": Y(S_AXLE_R)})
