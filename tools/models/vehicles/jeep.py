# Bulli Drive -- VW Typ 181 Kurierwagen ("The Thing", ~1973) ("jeep"), procedural Blender build.
#
#   blender -b --factory-startup --python tools/models/vehicles/jeep.py -- \
#       [--out=<dir>] [--lods=2,1,0] [--no-render] [--views=front34,side] [--ortho] [--no-ao] [--icon=<png>]
#
# Built on tools/models/lib/bd_car.py. The 181 is made of flat, slightly bevelled panels, so the
# body is a LINEAR loft (polyline sections, straight between stations): bonnet with the flat
# fender tops, open tub (rim, inner walls, floor; the firewall and the wall behind the rear seat
# come from double stations 1 mm apart), rear deck and a flat rear face. The bolted-on fender
# panels with their trapezoid wheel openings are extruded plates, the openings in the body are
# boolean prisms. Windshield up, soft top folded on the rear deck (like ref/jeep_blueprint.jpg).
# Station positions s are metres behind the front bumper tip; Blender y = s - LENGTH / 2.
import os, sys, math, json
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "lib"))
from bd_car import *                                  # noqa: E402,F403
import bd_car                                         # noqa: E402
from mathutils import Vector, Matrix                  # noqa: E402

DIMS = json.load(open(os.path.join(bd_car.MODELS, "ref", "dimensions.json")))["vehicles"]["jeep"]
LENGTH = DIMS["length_m"]["value"]            # 3.78
WIDTH = DIMS["width_m"]["value"]              # 1.64
HEIGHT = DIMS["height_m"]["value"]            # 1.62 with the top closed; open ~1.50 (windshield)
WB = DIMS["wheelbase_m"]["value"]             # 2.40
TRACK_F = DIMS["track_front_m"]["value"]      # 1.324
TRACK_R = DIMS["track_rear_m"]["value"]       # 1.416
WR = DIMS["tire_diameter_m"]["value"] / 2     # 0.3225
S_AXLE_F = DIMS["overhang_front_m"]["value"]  # 0.60
S_AXLE_R = S_AXLE_F + WB
Y0 = -LENGTH / 2
XS = 0.80                                     # body side
XF = 0.822                                    # fender panels (1.64 m over the fenders)


def Y(s):
    return Y0 + s


init("jeep", "VW Typ 181 (1973)", DIMS,
     specs={"paint_primary": dict(col="#B8612E", rough=0.42, coat=0.6),      # Signalorange, a little faded
            "canvas": dict(col="#232323", rough=0.9),
            "seat": dict(col="#2A2A2A", rough=0.7, emit="#2A2A2A", estr=0.08),
            "interior": dict(col="#3A3835", rough=0.85, emit="#3A3835", estr=0.05),
            "floor": dict(col="#262524", rough=0.95)},
     hub_logo="vw", hub_r=0.058, hub_logo_r=0.042, wheel_radius=WR, tread_width=0.15)

# --------------------------------------------------------------------------
# body sections (half, x >= 0), polylines; BEV marks corners that get a small bevel
# --------------------------------------------------------------------------
BEV = 0.018


def sect(pts, bev):
    """polyline [(x, z, bevel?)] -> points with each flagged corner split in two (bevel), so every
    station has the same point count"""
    out = []
    P = [Vector((x, z)) for (x, z, _) in pts]
    for i, (x, z, b) in enumerate(pts):
        if not b or i in (0, len(pts) - 1):
            out.append(P[i])
            continue
        d0 = (P[i - 1] - P[i])
        d1 = (P[i + 1] - P[i])
        e0 = min(bev, d0.length * 0.45) if d0.length > 1e-6 else 0.0
        e1 = min(bev, d1.length * 0.45) if d1.length > 1e-6 else 0.0
        out.append(P[i] + (d0.normalized() * e0 if e0 else Vector((0, 0))))
        out.append(P[i] + (d1.normalized() * e1 if e1 else Vector((0, 0))))
    return out


def hood(s):
    t = min(1.0, max(0.0, (s - 0.13) / 0.87))
    return 0.45 + 0.28 * t, 0.84 + 0.13 * t, 0.86 + 0.155 * t      # edge x, edge z, centre z


# 10 corners per section: bottom centre, bottom edge, chamfer, side, side top, top outer, inner 1,
# inner 2, inner 3, centre  (True = bevelled corner)
def S_front(s):
    hx, hz, hc = hood(s)
    return [(0, 0.33, False), (0.62, 0.33, True), (XS, 0.40, True), (XS, 0.70, False), (XS, 0.80, True),
            (hx + 0.02, 0.80, True), (hx, hz, True), (hx * 0.6, (hz + hc) / 2 + 0.004, False), (hx * 0.3, hc - 0.002, False), (0, hc, False)]


def S_cowl(s, side_top):
    hx, hz, hc = hood(s)
    return [(0, 0.29, False), (0.66, 0.29, True), (XS, 0.36, True), (XS, 0.70, False), (XS, side_top, True),
            (hx + 0.03, max(side_top, hz) + 0.005, True), (hx, hz, True), (hx * 0.6, (hz + hc) / 2 + 0.004, False), (hx * 0.3, hc - 0.002, False), (0, hc, False)]


def S_closed(zt, zb=0.29, zrim=1.04):
    return [(0, zb, False), (0.66, zb, True), (XS, zb + 0.07, True), (XS, 0.70, False), (XS, zrim, True),
            (XS - 0.04, zrim, True), (XS - 0.06, zt, True), (0.5, zt, False), (0.25, zt, False), (0, zt, False)]


def S_open(zrim=1.04):
    return [(0, 0.29, False), (0.66, 0.29, True), (XS, 0.36, True), (XS, 0.70, False), (XS, zrim, True),
            (XS - 0.04, zrim, True), (XS - 0.04, 0.44, True), (0.5, 0.40, False), (0.25, 0.40, False), (0, 0.40, False)]


STATIONS = [
    (0.130, S_front(0.13)),
    (0.300, S_front(0.30)),
    (0.730, S_front(0.73)),
    (0.860, S_cowl(0.86, 0.95)),
    (1.000, S_cowl(1.00, 1.00)),
    (1.100, S_closed(1.00, zrim=1.04)),
    (1.101, S_open()),
    (2.950, S_open()),
    (2.951, S_closed(1.04)),
    (3.400, S_closed(1.04, zb=0.30)),
    (3.600, S_closed(0.965, zb=0.30, zrim=0.955)),
]


def body_stations(bev):
    return [[Vector((p.x, Y(s), p.y)) for p in sect(prof, bev)] for (s, prof) in STATIONS]


def build_body(q):
    mb = MB()
    loft(mb, body_stations(q["bev"]), 1, 1, lambda c: "paint_primary", linear_u=True, linear_v=True, cap=(True, True))
    return mb


def prism(mb, poly_sz, x0, x1, mat, side=1):
    """polygon in (s, z) extruded along x from x0 to x1 (both signs by side), closed"""
    n0 = mb.nfaces()
    a = [mb.v((side * x0, Y(s), z)) for (s, z) in poly_sz]
    b = [mb.v((side * x1, Y(s), z)) for (s, z) in poly_sz]
    n = len(poly_sz)
    for i in range(n):
        mb.f([a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]], mat)
    for tri in _ear_clip(poly_sz):
        mb.f([a[k] for k in tri], mat)
        mb.f([b[k] for k in tri[::-1]], mat)
    bmesh.ops.recalc_face_normals(mb.bm, faces=mb.faces_since(n0))


def _ear_clip(poly):
    """triangulates a simple polygon (list of 2D points) -> index triples"""
    idx = list(range(len(poly)))
    area = sum(poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1] for i in idx)
    if area < 0:
        idx.reverse()
    out = []
    guard = 0
    while len(idx) > 3 and guard < 1000:
        guard += 1
        for k in range(len(idx)):
            i0, i1, i2 = idx[k - 1], idx[k], idx[(k + 1) % len(idx)]
            A, B, C = Vector(poly[i0]), Vector(poly[i1]), Vector(poly[i2])
            cr = (B - A).x * (C - A).y - (B - A).y * (C - A).x
            if cr <= 1e-9:
                continue
            inside = False
            for j in idx:
                if j in (i0, i1, i2):
                    continue
                P = Vector(poly[j])
                d1 = (B - A).x * (P - A).y - (B - A).y * (P - A).x
                d2 = (C - B).x * (P - B).y - (C - B).y * (P - B).x
                d3 = (A - C).x * (P - C).y - (A - C).y * (P - C).x
                if d1 >= 0 and d2 >= 0 and d3 >= 0:
                    inside = True
                    break
            if not inside:
                out.append((i0, i1, i2))
                idx.pop(k)
                break
    if len(idx) == 3:
        out.append(tuple(idx))
    return out


def arch_poly(sc, z_low=0.37, z_top=0.69, half_top=0.16, half_bot=0.30):
    return [(sc - half_bot, z_low), (sc - half_top, z_top), (sc + half_top, z_top), (sc + half_bot, z_low)]


def build_fenders(q):
    """bolted-on fender panels (plates 2.2 cm proud of the side) with trapezoid wheel openings"""
    mb = MB()
    af, ar = arch_poly(S_AXLE_F), arch_poly(S_AXLE_R)
    front = [(0.14, 0.40), (0.14, 0.795), (0.73, 0.795), (0.97, 0.37)] + [af[3], af[2], af[1], af[0]]
    rear = [(2.60, 0.37), (2.83, 0.795), (3.30, 0.795), (3.55, 0.37)] + [ar[3], ar[2], ar[1], ar[0]]
    for poly in (front, rear):
        for sx in (1, -1):
            prism(mb, poly, XS - 0.004, XF, "paint_primary", side=sx)
    return mb


def arches(q):
    out = []
    for sx in (1, -1):
        for sc in (S_AXLE_F, S_AXLE_R):
            mb = MB()
            poly = [(sc - 0.30, 0.10)] + arch_poly(sc) + [(sc + 0.30, 0.10)]
            prism(mb, poly, 0.52, 1.2, "trim_dark", side=sx)
            out.append((mb.obj("arch_cutter"), ["body", "fenders"]))
    return out


# --------------------------------------------------------------------------
# details
# --------------------------------------------------------------------------
def details(S, q):
    mb = MB()
    sockets = {}
    X = Vector((1, 0, 0))
    # ---------------- windshield (frame in body colour, flat glass, no body cut) ----------------
    b0, t0 = Vector((0, Y(1.02), 1.03)), Vector((0, Y(1.376), 1.50))
    up = (t0 - b0).normalized()
    wn = Vector((0, -up.z, up.y))                                  # forward normal of the glass
    hw = 0.66
    fr = q["tube"]
    corners = [b0 + Vector((-hw, 0, 0)), b0 + Vector((hw, 0, 0)), t0 + Vector((hw, 0, 0)), t0 + Vector((-hw, 0, 0))]
    tube(mb, corners + [corners[0]], 0.024, 4 if fr <= 6 else 6, "paint_primary", cap_start=False, cap_end=False)
    inset_g = [Vector((c.x * 0.965, c.y, c.z)) + up * (0.03 if k < 2 else -0.03) for k, c in enumerate(corners)]
    vs = [mb.v(p) for p in inset_g]
    mb.f(vs, "glass")
    mb.f(vs[::-1], "glass")
    for sx in (1, -1):                                             # hinges / posts down to the cowl
        tube(mb, [Vector((sx * hw, Y(1.00), 0.97)), corners[0 if sx < 0 else 1]], 0.02, 5, "paint_primary")
    mb.part("windshield")
    if q["wipers"]:
        for sx in (1, -1):
            a = b0 + Vector((sx * 0.05 + 0.1, 0, 0)) + wn * 0.03 + up * 0.03
            b = a + Vector((-0.40, 0, 0)) + up * 0.05
            tube(mb, [a, b], 0.0035, 4, "trim_dark")
    # ---------------- panel work: bonnet, doors, ribs ----------------
    if q["seams"]:
        # bonnet lid (trapezoid) and the front panel ribs
        lid = [(0.40, 0.16), (0.60, 0.95), (-0.60, 0.95), (-0.40, 0.16), (0.40, 0.16)]
        seam(mb, S, [(x, Y(s), 3.0) for (x, s) in lid], Vector((0, 0, 1)), width=0.005, seg=0.2)
        for sx in (1, -1):
            door_f = [(1.17, 1.035), (1.17, 0.58), (1.24, 0.53), (1.90, 0.53), (1.95, 0.58), (1.95, 1.035)]
            door_r = [(1.99, 1.035), (1.99, 0.58), (2.04, 0.53), (2.67, 0.53), (2.72, 0.58), (2.72, 1.035)]
            for d in (door_f, door_r):
                seam(mb, S, [(sx * 1.2, Y(s), z) for (s, z) in d], Vector((sx, 0, 0)), width=0.005, seg=0.3)
                for zh in (0.62, 0.94):                              # hinges
                    loc, n = S.side(sx, Y(d[0][0] + 0.03), zh)
                    box(mb, loc + n * 0.008, (0.03, 0.05, 0.07), "paint_primary")
        mb.part("seams")
    if q["ribs"]:
        for sx in (1, -1):
            for (s0, s1, z) in ((1.25, 1.88, 0.90), (1.25, 1.88, 0.67), (2.06, 2.64, 0.90), (2.06, 2.64, 0.67),
                                (1.0, 2.55, 0.43), (3.33, 3.53, 0.92), (0.92, 1.10, 0.90)):
                a, na = S.side(sx, Y(s0), z)
                b, nb = S.side(sx, Y(s1), z)
                strip(mb, [a, b], [na, nb], [(-0.022, 0.0), (-0.012, 0.008), (0.012, 0.008), (0.022, 0.0)], "paint_primary")
        for x in (-0.33, -0.16, 0.16, 0.33):                          # vertical ribs on the front panel
            a, na = S.front(x, 0.52)
            b, nb = S.front(x, 0.76)
            strip(mb, [a, b], [na, nb], [(-0.018, 0.0), (-0.010, 0.007), (0.010, 0.007), (0.018, 0.0)], "paint_primary")
        for x in (-0.30, -0.12, 0.12, 0.30):                          # bonnet ribs
            a, na = S.ray((x * 0.95, Y(0.25), 3.0), (0, 0, -1))
            b, nb = S.ray((x * 1.25, Y(0.90), 3.0), (0, 0, -1))
            strip(mb, [a, b], [na, nb], [(-0.02, 0.0), (-0.012, 0.006), (0.012, 0.006), (0.02, 0.0)], "paint_primary")
        mb.part("ribs")
    if q["handles"]:
        for sx in (1, -1):
            for s_ in (1.80, 2.58):
                loc, n = S.side(sx, Y(s_), 0.90)
                box(mb, loc + n * 0.012, (0.02, 0.14, 0.025), "chrome")
        mb.part("handles")
    # ---------------- lamps ----------------
    for sx in (1, -1):
        loc, n = S.front(sx * 0.66, 0.63)
        sockets["socket_headlight_" + ("l" if sx > 0 else "r")] = headlight(mb, loc, n, 0.105, q)
        if q["lamp"] > 8:
            loc, n = S.top(sx * 0.70, Y(0.24))
            box(mb, loc + Vector((0, 0, 0.02)), (0.09, 0.07, 0.04), "lamp_amber")
        # tail light: tall rounded box, amber / red / clear
        loc, n = S.rear(sx * 0.57, 0.78)
        base = loc + n * 0.018
        for (dz, h, m) in ((0.07, 0.07, "lamp_amber"), (0.0, 0.07, "lamp_tail"), (-0.07, 0.07, "ivory")):
            box(mb, base + Vector((0, 0, dz)), (0.15, 0.035, h), m)
        sockets["socket_taillight_" + ("l" if sx > 0 else "r")] = base + Vector((0, 0.02, 0))
        if q["lamp"] > 8:
            loc, n = S.rear(sx * 0.57, 0.57)
            box(mb, loc + n * 0.006, (0.10, 0.012, 0.04), "lamp_tail")
    mb.part("lamps")
    # ---------------- badge, plate, louvers ----------------
    O, N = S.front(0, 0.66)
    build_logo(mb, O + N * 0.003, N, 0.05, q)
    if q["plate"]:
        O, N = S.rear(0, 0.71)
        plate(mb, O, N, q, lamp=False)
    if q["louvers"]:
        for gx in (-0.29, 0.0, 0.29):                                 # rear lid louvers (3 groups)
            for k in range(6):
                z = 0.95 - k * 0.033
                a, na = S.rear(gx - 0.11, z)
                b, nb = S.rear(gx + 0.11, z)
                strip(mb, [a, b], [na, nb], [(-0.006, 0.001), (0.006, 0.001)], "trim_dark")
        for sx in (1, -1):                                            # side louvers on the rear quarters
            for k in range(5):
                z = 0.965 - k * 0.028
                a, na = S.side(sx, Y(3.30 - 0.03 * k), z)
                b, nb = S.side(sx, Y(3.52), z)
                strip(mb, [a, b], [na, nb], [(-0.006, 0.001), (0.006, 0.001)], "trim_dark")
        lid = [(-0.46, 1.05), (0.46, 1.05), (0.46, 0.66), (-0.46, 0.66), (-0.46, 1.05)]
        seam(mb, S, [(x, 4.0, z) for (x, z) in lid], Vector((0, 1, 0)), width=0.005, seg=0.3)
        mb.part("louvers")
    # ---------------- bumpers (black steel beams) ----------------
    for front in (True, False):
        sg = -1 if front else 1
        s0, s1 = (0.0, 0.13) if front else (3.60, 3.78)
        z0, z1 = (0.36, 0.49) if front else (0.39, 0.52)
        box(mb, (0, Y((s0 + s1) / 2) + (0.0 if front else 0.0), (z0 + z1) / 2), (1.58, s1 - s0, z1 - z0), "paint_black")
        for sx in (1, -1):
            box(mb, (sx * 0.81, Y((s0 + s1) / 2), (z0 + z1) / 2), (0.06, s1 - s0 + 0.01, z1 - z0 + 0.01), "rubber")
    mb.part("bumpers")
    # ---------------- mirrors ----------------
    if q["mirrors"]:
        for sx in (1, -1):
            base = Vector((sx * 0.80, Y(1.05), 1.0))
            head = Vector((sx * 0.90, Y(1.02), 1.07))
            tube(mb, [base, head], 0.008, 4, "trim_dark")
            box(mb, head + Vector((0, 0, 0.0)), (0.13, 0.03, 0.13), "trim_dark")
        mb.part("mirrors")
    # ---------------- cabin (open: floor, dash, seats, wheel) ----------------
    if q["interior"]:
        box(mb, (0, Y(1.16), 0.93), (1.50, 0.10, 0.12), "paint_primary")      # dash top in body colour
        box(mb, (0, Y(1.15), 0.80), (1.46, 0.08, 0.16), "interior")
        loc = Vector((0.38, Y(1.215), 0.86))
        lathe(mb, [(0.0, 0.0), (0.07, 0.0), (0.07, 0.012), (0.0, 0.012)], q["int_seg"],
              frame_from_axis(Vector((0, 1, 0.25))), loc, ["trim_dark", "chrome", "trim_dark"])
        c = Vector((0.38, Y(1.50), 0.92))
        ax = Vector((0, 0.55, 1.0)).normalized()
        Mw = frame_from_axis(ax)
        segs = q["int_seg"] * 2
        rim = [c + Mw @ Vector((0.19 * math.cos(2 * pi * k / segs), 0.19 * math.sin(2 * pi * k / segs), 0)) for k in range(segs)]
        tube(mb, rim, 0.013, 5 if q["int_seg"] > 8 else 4, "trim_dark", closed=True)
        for a in (0.3, pi - 0.3, 1.5 * pi):
            tube(mb, [c, c + Mw @ Vector((0.18 * math.cos(a), 0.18 * math.sin(a), 0))], 0.01, 4, "trim_dark",
                 cap_start=False, cap_end=False)
        tube(mb, [c - ax * 0.02, c - ax * 0.45], 0.02, 5, "trim_dark", cap_start=False)
        for sx in (1, -1):                                                     # front seats with headrests
            box(mb, (sx * 0.36, Y(1.78), 0.55), (0.46, 0.48, 0.12), "seat")
            box(mb, (sx * 0.36, Y(2.05), 0.88), (0.44, 0.10, 0.62), "seat", M=Matrix.Rotation(-0.12, 3, "X"))
            box(mb, (sx * 0.36, Y(2.10), 1.24), (0.26, 0.08, 0.16), "seat")
        box(mb, (0, Y(2.55), 0.55), (1.30, 0.46, 0.12), "seat")                 # rear bench
        box(mb, (0, Y(2.85), 0.84), (1.30, 0.10, 0.56), "seat", M=Matrix.Rotation(-0.1, 3, "X"))
        tube(mb, [(0.0, Y(1.25), 0.45), (0.0, Y(1.35), 0.62)], 0.012, 4, "trim_dark")   # gear lever
        mb.part("interior")
    # ---------------- folded soft top on the rear deck ----------------
    n_c = max(6, q["tube"] + 2)
    for (yc, zc, r, sy_, sz_, xh) in ((3.20, 1.155, 0.13, 1.75, 0.85, 0.70), (3.17, 1.29, 0.09, 1.9, 0.6, 0.64)):
        nv0 = len(mb.bm.verts)
        xs = [-xh, -xh * 0.97, -xh * 0.5, 0.0, xh * 0.5, xh * 0.97, xh]
        tube(mb, [(x, 0.0, 0.0) for x in xs], r, n_c, "canvas",
             radii=[r * 0.75, r * 0.93, r, r * 1.02, r, r * 0.93, r * 0.75])
        mb.bm.verts.ensure_lookup_table()
        for k in range(nv0, len(mb.bm.verts)):
            v = mb.bm.verts[k]
            v.co = Vector((v.co.x, Y(yc) + v.co.y * sy_, zc + v.co.z * sz_))
    if q["seams"]:
        for sx in (1, -1):                                            # top bows folded down
            tube(mb, [(sx * 0.72, Y(2.97), 1.05), (sx * 0.72, Y(3.00), 1.30), (sx * 0.72, Y(3.35), 1.33),
                      (sx * 0.72, Y(3.45), 1.06)], 0.012, 4, "trim_dark")
    mb.part("soft_top")
    # ---------------- underbody, exhaust ----------------
    if q["under"]:
        box(mb, (0, Y(1.9), 0.25), (0.9, 2.6, 0.06), "trim_dark")
        box(mb, (0, Y(3.25), 0.38), (0.9, 0.55, 0.22), "trim_dark")
        for sx in (1, -1):
            tube(mb, [(0, Y(S_AXLE_R), 0.34), (sx * 0.58, Y(S_AXLE_R), WR)], 0.04, 6, "trim_dark")
            tube(mb, [(sx * 0.29, Y(3.40), 0.29), (sx * 0.29, Y(3.84), 0.28)], 0.022, 6, "chrome")
    else:
        for sx in (1, -1):
            tube(mb, [(sx * 0.29, Y(3.55), 0.29), (sx * 0.29, Y(3.84), 0.28)], 0.022, 4, "chrome")
    sockets["socket_exhaust"] = Vector((0.29, Y(3.85), 0.28))
    mb.part("underbody")
    if q["blob"]:
        vs = [mb.v((sx * 1.10, sy * 2.15, 0.012)) for (sx, sy) in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        fc = mb.f(vs, "blob")
        mb.set_uv(fc, vs, [(0, 0), (1, 0), (1, 1), (0, 1)])
    return mb, sockets


def surf(S, q, root):
    """board on two bars across the tub rims (clamped to the windshield frame and the rear deck)"""
    mb = MB()
    zb = 1.56
    sides = max(4, q["tube"] - 4)
    for s_, z0 in ((1.40, 1.50), (3.05, 1.37)):
        y = Y(s_)
        tube(mb, [(0.70, y, z0), (0.66, y, zb), (-0.66, y, zb), (-0.70, y, z0)], 0.0125, sides, "chrome")
        if q["surf_n"] > 6:
            box(mb, (0.0, y, zb + 0.016), (0.46, 0.035, 0.012), "trim_dark")
    surfboard_board(mb, q, Y(2.22), zb + 0.022 + 0.0375, L=2.5, W=0.56, T=0.075)
    return finish_surfboard(mb, root)


Q = {
    0: dict(bev=BEV, seams=True, ribs=True, handles=True, louvers=True, lamp=28, logo_seg=28, logo_strokes=True,
            plate=True, mirrors=True, wipers=True, interior=True, under=True, blob=True, tube=8, int_seg=10,
            tire="hi", wheel_segs=32, surf_n=12, merge_wheels=False, smooth=30, holes=False, seal=0, nc=1,
            maxseg=1.0, sky_nc=1, glass_rings=0, bumper_n=16),
    1: dict(bev=BEV, seams=False, ribs=True, handles=False, louvers=False, lamp=14, logo_seg=14, logo_strokes=True,
            plate=True, mirrors=True, wipers=False, interior=True, under=False, blob=True, tube=5, int_seg=6,
            tire="mid", wheel_segs=16, surf_n=6, merge_wheels=False, smooth=30, holes=False, seal=0, nc=1,
            maxseg=1.0, sky_nc=1, glass_rings=0, bumper_n=10),
    2: dict(bev=0.0, seams=False, ribs=False, handles=False, louvers=False, lamp=8, logo_seg=8, logo_strokes=False,
            plate=False, mirrors=False, wipers=False, interior=False, under=False, blob=False, tube=4, int_seg=4,
            tire="lo", wheel_segs=8, surf_n=4, merge_wheels=True, smooth=30, holes=False, seal=0, nc=1,
            maxseg=1.0, sky_nc=1, glass_rings=0, bumper_n=6),
}

WHEEL = dict(R=WR, w=0.15, bead=0.19, ww=None, rim="paint_black", hub_r=0.058, hub_h=0.03, holes=0.125, n_holes=8,
             hole_size=(0.017, 0.017), round_holes=True)


def build_lod(lod):
    q = Q[lod]
    parts = {"body": build_body(q), "fenders": build_fenders(q)}
    wheels = [("wheel_fl", TRACK_F / 2, Y(S_AXLE_F), True), ("wheel_fr", -TRACK_F / 2, Y(S_AXLE_F), True),
              ("wheel_rl", TRACK_R / 2, Y(S_AXLE_R), False), ("wheel_rr", -TRACK_R / 2, Y(S_AXLE_R), False)]
    props = dict(model="VW Typ 181 (1973)", length_m=LENGTH, width_m=WIDTH, height_m=1.50, wheelbase_m=WB,
                 collision_half_extents=[0.82, 0.75, 1.89])
    return assemble(lod, q, props, parts, arches, details, None, surf, WHEEL, wheels, nametag_z=1.9)


if __name__ == "__main__":
    main(build_lod, {"length": LENGTH, "width": WIDTH, "height": 1.50, "wheelbase": WB, "track_f": TRACK_F,
                     "track_r": TRACK_R, "wheel_radius": WR, "axle_f_y": Y(S_AXLE_F), "axle_r_y": Y(S_AXLE_R)})
