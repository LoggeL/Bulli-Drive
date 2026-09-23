# Bulli Drive -- VW 1200 Kaefer (Typ 1, export, 1963) ("beetle"), procedural Blender build.
#
#   blender -b --factory-startup --python tools/models/vehicles/beetle.py -- \
#       [--out=<dir>] [--lods=2,1,0] [--no-render] [--views=front34,side] [--ortho] [--no-ao] [--icon=<png>]
#
# Built on tools/models/lib/bd_car.py (materials, atlas, windows, lamps, wheels, assembly). The
# body is a Catmull-Rom loft of half cross-sections (stations along the car) measured on
# ref/beetle_blueprint.jpg and rescaled to the real dimensions of ref/dimensions.json; the four
# fenders are separate lofts of superellipse loops that dive into the body (the crease where they
# meet is the typical Kaefer look), the wheel arches are boolean cuts like on the T1.
# Station positions s are metres behind the front bumper tip; Blender y = s - LENGTH / 2.
import os, sys, math, json
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "lib"))
from bd_car import *                                  # noqa: E402,F403
import bd_car                                         # noqa: E402
from mathutils import Vector, Matrix                  # noqa: E402

DIMS = json.load(open(os.path.join(bd_car.MODELS, "ref", "dimensions.json")))["vehicles"]["beetle"]
LENGTH = DIMS["length_m"]["value"]            # 4.079
WIDTH = DIMS["width_m"]["value"]              # 1.54
HEIGHT = DIMS["height_m"]["value"]            # 1.50
WB = DIMS["wheelbase_m"]["value"]             # 2.40
TRACK_F = DIMS["track_front_m"]["value"]      # 1.306
TRACK_R = DIMS["track_rear_m"]["value"]       # 1.288
WR = DIMS["tire_diameter_m"]["value"] / 2     # 0.3275
S_AXLE_F = 0.72                               # front axle behind the bumper tip (blueprint 0.70, wheelbase 2.40)
S_AXLE_R = S_AXLE_F + WB
Y0 = -LENGTH / 2


def Y(s):
    return Y0 + s


init("beetle", "VW 1200 Kaefer (1963)", DIMS,
     specs={"paint_primary": dict(col="#6F8FA6"),           # L380 "Gulf blue"-like, calm
            "rim_paint": dict(col="#6F8FA6", rough=0.35),
            "interior": dict(col="#8C8173"), "seat": dict(col="#B7AC98"), "headliner": dict(col="#E4DCCB")},
     hub_logo="vw", hub_r=0.118, hub_logo_r=0.042, wheel_radius=WR, tread_width=0.10)

# --------------------------------------------------------------------------
# body: half cross-sections, bottom centre -> top centre (x, z); measured on the blueprint
# (side 231 px/m, heights 248 px/m, plan widths x 1.048 to the real 1.54 m over the fenders)
# --------------------------------------------------------------------------
BODY = [
    (0.105, [(0, 0.31), (0, 0.31), (0, 0.33), (0, 0.37), (0, 0.42), (0, 0.46), (0, 0.49), (0, 0.51), (0, 0.52)]),
    (0.140, [(0, 0.29), (0.22, 0.28), (0.30, 0.31), (0.32, 0.37), (0.30, 0.44), (0.22, 0.50), (0.14, 0.545), (0.07, 0.565), (0, 0.57)]),
    (0.220, [(0, 0.27), (0.30, 0.26), (0.38, 0.30), (0.40, 0.40), (0.36, 0.52), (0.27, 0.60), (0.18, 0.66), (0.09, 0.69), (0, 0.70)]),
    (0.400, [(0, 0.26), (0.34, 0.25), (0.42, 0.30), (0.44, 0.45), (0.43, 0.62), (0.38, 0.74), (0.28, 0.81), (0.15, 0.84), (0, 0.85)]),
    (0.650, [(0, 0.25), (0.38, 0.24), (0.46, 0.30), (0.49, 0.50), (0.48, 0.72), (0.45, 0.84), (0.36, 0.91), (0.19, 0.947), (0, 0.955)]),
    (0.950, [(0, 0.25), (0.42, 0.24), (0.52, 0.30), (0.55, 0.55), (0.555, 0.80), (0.53, 0.93), (0.44, 0.99), (0.23, 1.02), (0, 1.027)]),
    (1.220, [(0, 0.24), (0.50, 0.235), (0.60, 0.29), (0.635, 0.55), (0.645, 0.86), (0.62, 0.98), (0.53, 1.03), (0.28, 1.05), (0, 1.055)]),
    (1.300, [(0, 0.24), (0.53, 0.235), (0.63, 0.29), (0.648, 0.55), (0.65, 0.88), (0.625, 0.99), (0.54, 1.045), (0.30, 1.078), (0, 1.085)]),
    (1.480, [(0, 0.24), (0.54, 0.235), (0.635, 0.29), (0.65, 0.55), (0.65, 0.89), (0.615, 1.03), (0.53, 1.20), (0.38, 1.245), (0, 1.275)]),
    (1.620, [(0, 0.24), (0.54, 0.235), (0.635, 0.29), (0.65, 0.55), (0.65, 0.89), (0.61, 1.05), (0.52, 1.28), (0.37, 1.345), (0, 1.39)]),
    (1.950, [(0, 0.24), (0.54, 0.235), (0.635, 0.29), (0.65, 0.55), (0.65, 0.89), (0.61, 1.06), (0.52, 1.33), (0.36, 1.41), (0, 1.475)]),
    (2.300, [(0, 0.24), (0.54, 0.235), (0.635, 0.29), (0.65, 0.55), (0.65, 0.89), (0.61, 1.06), (0.52, 1.345), (0.36, 1.43), (0, 1.50)]),
    (2.750, [(0, 0.24), (0.53, 0.235), (0.63, 0.29), (0.645, 0.55), (0.645, 0.89), (0.60, 1.06), (0.51, 1.31), (0.355, 1.38), (0, 1.44)]),
    (3.050, [(0, 0.25), (0.50, 0.245), (0.60, 0.30), (0.63, 0.55), (0.62, 0.88), (0.57, 1.05), (0.47, 1.21), (0.33, 1.29), (0, 1.345)]),
    (3.300, [(0, 0.27), (0.45, 0.26), (0.54, 0.31), (0.57, 0.55), (0.56, 0.86), (0.52, 1.02), (0.43, 1.12), (0.30, 1.18), (0, 1.23)]),
    (3.500, [(0, 0.29), (0.40, 0.28), (0.48, 0.33), (0.50, 0.55), (0.49, 0.80), (0.45, 0.92), (0.37, 1.00), (0.21, 1.03), (0, 1.04)]),
    (3.680, [(0, 0.31), (0.34, 0.30), (0.41, 0.35), (0.43, 0.55), (0.41, 0.70), (0.37, 0.78), (0.29, 0.83), (0.16, 0.855), (0, 0.86)]),
    (3.840, [(0, 0.33), (0.26, 0.33), (0.31, 0.37), (0.32, 0.47), (0.30, 0.56), (0.26, 0.61), (0.20, 0.64), (0.11, 0.655), (0, 0.66)]),
    (3.940, [(0, 0.35), (0.16, 0.35), (0.20, 0.38), (0.21, 0.42), (0.20, 0.46), (0.17, 0.48), (0.12, 0.495), (0.06, 0.50), (0, 0.505)]),
    (3.970, [(0, 0.36), (0, 0.36), (0, 0.38), (0, 0.41), (0, 0.44), (0, 0.46), (0, 0.475), (0, 0.48), (0, 0.485)]),
]

# fenders: (s, x_in, x_top, x_out, z_bot, z_c, z_top, n) -> superellipse loop per station
FENDER_F = [
    (0.100, 0.50, 0.535, 0.57, 0.44, 0.50, 0.55, 2.0),
    (0.130, 0.36, 0.54, 0.665, 0.34, 0.51, 0.665, 2.2),
    (0.240, 0.22, 0.56, 0.74, 0.30, 0.53, 0.76, 2.4),
    (0.450, 0.20, 0.575, 0.77, 0.28, 0.55, 0.815, 2.5),
    (0.720, 0.22, 0.58, 0.77, 0.28, 0.55, 0.825, 2.5),
    (0.970, 0.30, 0.60, 0.765, 0.27, 0.52, 0.80, 2.5),
    (1.130, 0.45, 0.65, 0.75, 0.26, 0.38, 0.56, 2.3),
    (1.240, 0.56, 0.68, 0.74, 0.25, 0.29, 0.36, 2.2),
    (1.270, 0.62, 0.69, 0.73, 0.255, 0.27, 0.29, 2.0),
]
FENDER_R = [
    (2.640, 0.60, 0.66, 0.72, 0.25, 0.27, 0.30, 2.0),
    (2.700, 0.52, 0.64, 0.745, 0.245, 0.30, 0.38, 2.2),
    (2.850, 0.40, 0.62, 0.765, 0.25, 0.42, 0.62, 2.4),
    (3.050, 0.30, 0.60, 0.775, 0.26, 0.52, 0.83, 2.5),
    (3.300, 0.28, 0.585, 0.775, 0.27, 0.55, 0.86, 2.5),
    (3.600, 0.26, 0.57, 0.76, 0.28, 0.54, 0.80, 2.5),
    (3.850, 0.30, 0.55, 0.70, 0.30, 0.50, 0.68, 2.4),
    (3.990, 0.42, 0.54, 0.62, 0.36, 0.48, 0.58, 2.2),
    (4.020, 0.50, 0.54, 0.57, 0.44, 0.48, 0.52, 2.0),
]
FENDER_ANGLES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330]


def fender_loop(x_in, x_top, x_out, z_bot, zc, z_top, n, angles=FENDER_ANGLES):
    pts = []
    for a in angles:
        t = math.radians(a)
        c, s = math.cos(t), math.sin(t)
        cc = math.copysign(abs(c) ** (2 / n), c)
        ss = math.copysign(abs(s) ** (2 / n), s)
        x = x_top + (x_out - x_top) * cc if cc >= 0 else x_top + (x_top - x_in) * cc
        z = zc + (z_top - zc) * ss if ss >= 0 else zc + (zc - z_bot) * ss
        pts.append((x, z))
    return pts


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
                z = z + inset_d if k <= 2 else (z - inset_d if k >= 6 else z)
            pts.append(Vector((x, Y(s), z)))
        out.append(pts)
    return out


def build_body(q):
    mb = MB()
    loft(mb, body_stations(keep=q.get("keep")), q["body_u"], q["body_v"], lambda c: "paint_primary")
    return mb


def build_fenders(q):
    mb = MB()
    for table in (FENDER_F, FENDER_R):
        n0 = mb.nfaces()
        rows = [row for i, row in enumerate(table) if i in q.get("fender_keep", range(len(table)))]
        if q.get("no_arch"):
            # LOD2: no boolean arches, the fender loops lift over the wheel instead
            rows = [row if min(abs(row[0] - S_AXLE_F), abs(row[0] - S_AXLE_R)) > 0.3 else
                    row[:4] + (0.64, max(row[5], 0.70), row[6], row[7]) for row in rows]
        st = [[Vector((x, Y(row[0]), z)) for (x, z) in fender_loop(*row[1:], angles=q["fender_angles"])] for row in rows]
        loft(mb, st, q["fender_u"], q["fender_v"], lambda c: "paint_primary", mirror=False, closed_u=True,
             cap=(True, True))
        mirror_x(mb, n0)
    return mb


def build_boards(q):
    """running boards between the fenders: rubber mat with a chrome edge on a dark carrier"""
    mb = MB()
    for sx in (1, -1):
        y0, y1 = Y(1.20), Y(2.70)
        box(mb, (sx * 0.68, (y0 + y1) / 2, 0.245), (0.13, y1 - y0, 0.035), "rubber")
        if q["strips"]:
            box(mb, (sx * 0.748, (y0 + y1) / 2, 0.248), (0.012, y1 - y0, 0.03), "chrome")
    return mb


# --------------------------------------------------------------------------
# details
# --------------------------------------------------------------------------
def details(S, q):
    mb = MB()
    sockets = {}
    # ---------------- windows ----------------
    for sx in (1, -1):
        N = Vector((sx, 0, 0.18)).normalized()
        # door window incl. vent wing (front edge follows the A pillar)
        O, _ = S.side(sx, Y(1.8), 1.14)
        pane(mb, S, O, N, [(sx * 0.7, Y(1.33), 0.985), (sx * 0.7, Y(2.255), 0.985), (sx * 0.7, Y(2.255), 1.305),
                           (sx * 0.7, Y(1.52), 1.305)], [0.03, 0.035, 0.05, 0.10], q)
        if q["vent_bar"]:
            a, na = S.side(sx, Y(1.715), 1.0)
            b, nb = S.side(sx, Y(1.715), 1.29)
            tube(mb, [a + na * 0.006, b + nb * 0.006], 0.0055, q["vent_bar"], "chrome")
        # rear quarter window: straight front edge, rounded rear
        O, _ = S.side(sx, Y(2.66), 1.14)
        pane(mb, S, O, N, [(sx * 0.7, Y(2.36), 0.985), (sx * 0.7, Y(2.98), 0.985), (sx * 0.7, Y(2.78), 1.30),
                           (sx * 0.7, Y(2.36), 1.305)], [0.03, 0.09, 0.14, 0.04], q)
    mb.part("windows_side")
    # windshield / rear window: corners taken on the surface (the panes are raked ~45 deg)
    O, N = S.front(0, 1.2)
    cs = [S.front(x, z)[0] for (x, z) in ((-0.47, 1.075), (0.47, 1.075), (0.44, 1.335), (-0.44, 1.335))]
    pane(mb, S, O, N, cs, [0.06, 0.06, 0.07, 0.07], q, grings=q["ws_rings"], curved=q["curved"])
    O, N = S.rear(0, 1.18)
    cs = [S.rear(x, z)[0] for (x, z) in ((0.36, 1.075), (-0.36, 1.075), (-0.36, 1.29), (0.36, 1.29))]
    pane(mb, S, O, N, cs, [0.10, 0.10, 0.10, 0.10], q, grings=min(1, q["ws_rings"]), curved=q["curved"])
    mb.part("windows_front_rear")

    # ---------------- trim ----------------
    if q["strips"]:
        for sx in (1, -1):
            # belt line: chrome strip from the front fender over the doors to the rear fender
            pts = [Vector((sx * 0.9, Y(s), z)) for s, z in ((1.02, 0.905), (1.4, 0.905), (1.9, 0.90), (2.4, 0.895),
                                                                 (2.9, 0.885), (3.25, 0.87))]
            on_surface_strip(mb, S, pts, (sx, 0, 0), [(-0.006, -0.001), (0.0, 0.0045), (0.006, -0.001)], "chrome")
        # bonnet strip + handle
        pts = [Vector((0, Y(s), 3.0)) for s in (0.27, 0.45, 0.7, 0.95, 1.12)]
        on_surface_strip(mb, S, pts, (0, 0, 1), [(-0.006, -0.001), (0.0, 0.005), (0.006, -0.001)], "chrome")
        mb.part("trim")
    if q["seams"]:
        for sx in (1, -1):
            X = Vector((sx, 0, 0))
            door = [(1.29, 0.985), (1.29, 0.30), (2.32, 0.30), (2.32, 0.985)]
            seam(mb, S, [(sx * 0.8, Y(s), z) for (s, z) in door], X)
            for zh in (0.52, 0.80):                               # door hinges
                loc, n = S.side(sx, Y(1.30), zh)
                tube(mb, [loc - Vector((0, 0, 0.03)), loc + n * 0.008 - Vector((0, 0, 0.015)),
                          loc + n * 0.008 + Vector((0, 0, 0.015)), loc + Vector((0, 0, 0.03))], 0.009, 5, "chrome")
        Z = Vector((0, 0, 1))
        hood = [(0.0, 0.16), (0.2, 0.30), (0.38, 0.60), (0.50, 0.95), (0.55, 1.18), (0.0, 1.21)]
        hood_pts = [(x, Y(s), 3.0) for (x, s) in hood] + [(-x, Y(s), 3.0) for (x, s) in reversed(hood[:-1])]
        seam(mb, S, hood_pts, Z, seg=0.08)
        lid = [(0.0, 3.42), (0.36, 3.46), (0.40, 3.62), (0.30, 3.82), (0.0, 3.90)]
        lid_pts = [(x, Y(s), 3.0) for (x, s) in lid] + [(-x, Y(s), 3.0) for (x, s) in reversed(lid[:-1])]
        seam(mb, S, lid_pts, Z, seg=0.08)
        mb.part("seams")
    if q["louvers"]:
        for row, zz in enumerate((0.0, 1.0)):
            for k in range(-9, 10):
                if abs(k) < 1 and row:
                    continue
                x = k * 0.028
                a, na = S.ray((x, Y(3.52 + 0.07 * row), 3.0), (0, 0, -1))
                b, nb = S.ray((x, Y(3.60 + 0.07 * row), 3.0), (0, 0, -1))
                strip(mb, [a, b], [na, nb], [(-0.006, 0.001), (0.006, 0.001)], "trim_dark")
        mb.part("louvers")
    if q["handles"]:
        for sx in (1, -1):
            loc, n = S.side(sx, Y(2.20), 0.87)
            p0, p1 = loc + n * 0.014 + Vector((0, -0.05, 0)), loc + n * 0.014 + Vector((0, 0.05, 0))
            tube(mb, [loc + Vector((0, -0.055, 0)) - n * 0.002, p0, p1, loc + Vector((0, 0.055, 0)) - n * 0.002],
                 0.008, 6, "chrome")
        mb.part("handles")

    # ---------------- lamps ----------------
    for sx in (1, -1):
        loc, n = S.front(sx * 0.535, 0.525)
        n = (n + Vector((0, -0.4, 0.0))).normalized()
        sockets["socket_headlight_" + ("l" if sx > 0 else "r")] = headlight(mb, loc, n, 0.098, q)
        if q["lamp"] > 8:
            # torpedo blinker on the fender top: chrome body, amber lens at the front
            base, bn = S.top(sx * 0.51, Y(0.58))
            c = base + bn * 0.022
            M = frame_from_axis(Vector((0, -1, 0)))
            lathe(mb, [(0.0, -0.075), (0.018, -0.06), (0.026, -0.02), (0.026, 0.01), (0.022, 0.03), (0.0, 0.045)],
                  max(8, q["lamp"] // 2), M, c, ["chrome", "chrome", "chrome", "lamp_amber", "lamp_amber"])
        loc, n = S.rear(sx * 0.555, 0.575)
        n = (n + Vector((0, 0.3, 0))).normalized()
        sockets["socket_taillight_" + ("l" if sx > 0 else "r")] = round_lamp(
            mb, loc, n, 0.047, q, lens="lamp_tail", sx=1.0, sy=1.45,
            mat_fn=lambda i, j, segs: "chrome" if i < 3 else ("lamp_amber" if math.sin(2 * math.pi * (j + 0.5) / segs) > 0.45 else "lamp_tail"))
    mb.part("lamps")

    # ---------------- badges, plate ----------------
    O, N = S.front(0, 0.64)
    build_logo(mb, O + N * 0.003, N, 0.042, q)
    if q["plate"]:
        O, N = S.rear(0, 0.50)
        plate(mb, O, N, q)
    loc, n = S.rear(0, 0.61)                                  # plate light housing ("Pope's nose")
    if q["lamp"] > 8:
        M = frame_from_axis((n + Vector((0, 0, -0.6))).normalized())
        lathe(mb, [(0.0, -0.01), (0.07, 0.0), (0.06, 0.025), (0.0, 0.035)], max(8, q["lamp"] // 2), M, loc,
              ["paint_primary", "paint_primary", "paint_primary"], sx=1.0, sy=0.55)
    mb.part("badges")

    # ---------------- bumpers ----------------
    for front in (True, False):
        sg = -1 if front else 1
        s_mid = 0.045 if front else LENGTH - 0.045
        zc = 0.36 if front else 0.365
        half = 0.70
        nb = q["bumper_n"]
        path = []
        for i in range(nb + 1):
            x = -half + 2 * half * i / nb
            t = abs(x) / half
            y = Y(s_mid) - sg * (0.13 * t ** 3.2)
            path.append((x, y))
        blade(mb, path, zc, q, scale=(1.0, 0.78))
        for sx in (1, -1):
            x = sx * 0.37
            y0 = Y(s_mid) - sg * 0.13 * (0.37 / half) ** 3.2 + sg * 0.01
            overrider(mb, x, y0, sg, zc - 0.10, 0.50, q, r=0.028)
            if q["bumper_n"] > 12:
                box(mb, (sx * 0.40, y0 - sg * 0.09, zc - 0.01), (0.05, 0.16, 0.05), "trim_dark")
        if q["bumper_n"] > 8:
            zb, rb = 0.445, 0.0125
            ye = lambda x: Y(s_mid) - sg * 0.13 * (abs(x) / half) ** 3.2 + sg * 0.02
            bar = [(x, ye(x), zb) for x in (-0.37, -0.2, 0.0, 0.2, 0.37)]
            ends = [(0.58, ye(0.58) - sg * 0.005, zc + 0.045), (0.55, ye(0.55), zb - 0.025), (0.50, ye(0.5), zb)]
            path = [(x, y, z) for (x, y, z) in ends] + [p for p in reversed(bar)] + [(-x, y, z) for (x, y, z) in reversed(ends)]
            tube(mb, path, rb, max(5, q["tube"] - 2), "chrome")
    mb.part("bumpers")

    # ---------------- mirror, wipers ----------------
    if q["mirrors"]:
        base, n = S.side(1, Y(1.33), 0.93)
        head = base + Vector((0.10, -0.02, 0.17))
        tube(mb, [base, base + Vector((0.05, 0, 0.08)), head], 0.008, max(5, q["tube"] - 3), "chrome")
        M = frame_from_axis(Vector((0.15, -1, 0)))
        lathe(mb, [(0.0, -0.014), (0.04, -0.011), (0.052, -0.004), (0.054, 0.004), (0.0, 0.008)],
              max(12, q["lamp"] * 2 // 3), M, head, ["chrome"] * 4)
    if q["wipers"]:
        for sx in (1, -1):
            a, na = S.front(sx * 0.10 + 0.12, 1.085)
            b, nb = S.front(sx * 0.10 + 0.12 - 0.34, 1.12)
            a, b = a + na * 0.01, b + nb * 0.012
            tube(mb, [a, b], 0.0032, 4, "trim_dark")
            box(mb, a - na * 0.004, (0.014, 0.014, 0.014), "chrome")
    mb.part("mirror_wipers")

    # ---------------- underbody, exhaust ----------------
    if q["under"]:
        box(mb, (0, Y(2.0), 0.21), (0.9, 2.6, 0.05), "trim_dark")                 # floor pan / backbone
        box(mb, (0, Y(3.55), 0.36), (0.75, 0.55, 0.26), "trim_dark")              # engine
        for sx in (1, -1):
            tube(mb, [(0, Y(S_AXLE_R), 0.33), (sx * 0.52, Y(S_AXLE_R), WR)], 0.035, 6, "trim_dark")
        for ya in (Y(S_AXLE_F) - 0.07, Y(S_AXLE_F) + 0.07):
            tube(mb, [(-0.55, ya, 0.30), (0.55, ya, 0.30)], 0.03, 6, "trim_dark")
    for sx in (1, -1):
        p0 = Vector((sx * 0.17, Y(3.86), 0.22))
        p1 = Vector((sx * 0.17, Y(4.05), 0.215))
        tube(mb, [p0, p1], 0.022, 8 if q["tube"] > 6 else 5, "chrome")
    sockets["socket_exhaust"] = Vector((0.17, Y(4.06), 0.215))
    mb.part("underbody")

    # ---------------- cabin ----------------
    if q["interior"]:
        box(mb, (0, Y(1.36), 0.93), (1.18, 0.16, 0.10), "paint_primary")      # dashboard (body colour)
        box(mb, (0, Y(1.34), 0.82), (1.10, 0.10, 0.14), "interior")
        c = Vector((0.36, Y(1.62), 0.98))
        ax = Vector((0, 0.55, 1.0)).normalized()
        Mw = frame_from_axis(ax)
        segs = q["int_seg"] * 2
        rim = [c + Mw @ Vector((0.19 * math.cos(2 * pi * k / segs), 0.19 * math.sin(2 * pi * k / segs), 0)) for k in range(segs)]
        tube(mb, rim, 0.011, 5 if q["int_seg"] > 8 else 4, "ivory", closed=True)
        tube(mb, [c - ax * 0.02, c - ax * 0.45], 0.018, 5, "trim_dark", cap_start=False)
        for sx in (1, -1):                                                   # front seats
            box(mb, (sx * 0.30, Y(2.05), 0.50), (0.46, 0.46, 0.12), "seat")
            box(mb, (sx * 0.30, Y(2.33), 0.80), (0.44, 0.10, 0.56), "seat", M=Matrix.Rotation(-0.2, 3, "X"))
        box(mb, (0, Y(2.78), 0.50), (1.10, 0.44, 0.12), "seat")               # rear bench
        box(mb, (0, Y(3.05), 0.78), (1.10, 0.10, 0.48), "seat", M=Matrix.Rotation(-0.35, 3, "X"))
        box(mb, (0, Y(3.30), 0.92), (0.95, 0.30, 0.03), "interior")          # parcel shelf
        mb.part("interior")
    if q["blob"]:
        vs = [mb.v((sx * 1.05, sy * 2.35, 0.012)) for (sx, sy) in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        fc = mb.f(vs, "blob")
        mb.set_uv(fc, vs, [(0, 0), (1, 0), (1, 1), (0, 1)])
    return mb, sockets


def inner_shell(q):
    if not q["interior"]:
        return None
    mb = MB()
    st = body_stations(inset_d=0.045, s_range=(1.29, 3.31))
    loft(mb, st, q["inner_u"], 1, lambda c: "headliner" if c.z > 1.30 else ("floor" if c.z < 0.4 else "interior"),
         cap=(True, True))
    bmesh.ops.recalc_face_normals(mb.bm, faces=mb.bm.faces)
    return mb


def arches(q):
    out = []
    if q.get("no_arch"):
        return out
    for sx in (1, -1):
        for s_ax, r in ((S_AXLE_F, 0.365), (S_AXLE_R, 0.355)):
            x0 = 0.36 if sx > 0 else -1.3
            out.append((arch_cutter(Y(s_ax), WR + 0.005, r, x0, width=0.94, segs=q["arch_segs"]),
                        ["body", "fenders"]))
    return out


def surf(S, q, root):
    mb = MB()
    ys = (Y(1.85), Y(2.75))
    roof_rack(mb, S, q, ys, 0.50, 1.575)
    surfboard_board(mb, q, (ys[0] + ys[1]) / 2, 1.575 + 0.022 + 0.0375, L=2.35, W=0.54, T=0.07)
    return finish_surfboard(mb, root)


A12 = FENDER_ANGLES
A8 = [0, 45, 90, 135, 180, 225, 270, 315]
Q = {
    0: dict(body_u=[3, 3, 3, 3, 3, 3, 4, 3], body_v=[2, 2, 2, 2, 2, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1],
            fender_u=2, fender_v=[1, 2, 2, 2, 2, 2, 2, 1], fender_angles=A12, inner_u=2, ws_rings=0, curved=False,
            seal=3, glass_rings=2, nc=3, maxseg=0.28, sky_nc=1, strips="hi", seams=True, louvers=True, handles=True,
            lamp=28, logo_seg=28, logo_strokes=True, bumper_n=16, tube=8, mirrors=True, wipers=True, plate=True,
            under=True, interior=True, blob=True, holes=True, vent_bar=6, int_seg=10, tire="hi", wheel_segs=30,
            arch_segs=40, surf_n=12, merge_wheels=False),
    1: dict(body_u=2, keep=[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19], body_v=1,
            fender_u=1, fender_v=[1, 2, 1, 1, 1, 2, 1, 1], fender_angles=A12, inner_u=1, ws_rings=0, curved=False,
            seal=1, glass_rings=0, nc=2, maxseg=0.9, sky_nc=1, strips="lo", seams=False, louvers=False, handles=False,
            lamp=14, logo_seg=14, logo_strokes=True, bumper_n=9, tube=5, mirrors=True, wipers=False, plate=True,
            under=False, interior=True, blob=True, holes=True, vent_bar=0, int_seg=6, tire="mid", wheel_segs=14,
            arch_segs=16, surf_n=6, merge_wheels=False),
    2: dict(body_u=1, keep=[0, 1, 2, 3, 5, 6, 8, 10, 12, 13, 14, 15, 16, 17, 18, 19], body_v=1,
            fender_u=1, fender_v=1, fender_angles=A8, fender_keep=[0, 1, 2, 4, 5, 6, 8], inner_u=1, ws_rings=0,
            curved=False, no_arch=True,
            seal=0, glass_rings=0, nc=1, maxseg=2.0, sky_nc=1, strips=False, seams=False, louvers=False, handles=False,
            lamp=8, logo_seg=8, logo_strokes=False, bumper_n=5, tube=4, mirrors=False, wipers=False, plate=False,
            under=False, interior=False, blob=False, holes=False, vent_bar=0, int_seg=4, tire="lo", wheel_segs=8,
            arch_segs=8, surf_n=4, merge_wheels=True),
}

WHEEL = dict(R=WR, w=0.10, bead=0.19, ww=(0.222, 0.282), rim="rim_paint", hub_r=0.118, hub_h=0.036)


def build_lod(lod):
    q = Q[lod]
    parts = {"body": build_body(q), "fenders": build_fenders(q), "boards": build_boards(q)}
    wheels = [("wheel_fl", TRACK_F / 2, Y(S_AXLE_F), True), ("wheel_fr", -TRACK_F / 2, Y(S_AXLE_F), True),
              ("wheel_rl", TRACK_R / 2, Y(S_AXLE_R), False), ("wheel_rr", -TRACK_R / 2, Y(S_AXLE_R), False)]
    props = dict(model="VW 1200 Kaefer (1963)", length_m=LENGTH, width_m=WIDTH, height_m=HEIGHT, wheelbase_m=WB,
                 collision_half_extents=[0.80, 0.78, 2.12])
    return assemble(lod, q, props, parts, arches, details, inner_shell, surf, WHEEL, wheels, nametag_z=1.95)


if __name__ == "__main__":
    main(build_lod, {"length": LENGTH, "width": WIDTH, "height": HEIGHT, "wheelbase": WB, "track_f": TRACK_F,
                     "track_r": TRACK_R, "wheel_radius": WR, "axle_f_y": Y(S_AXLE_F), "axle_r_y": Y(S_AXLE_R)})
