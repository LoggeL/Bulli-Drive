# Bulli Drive -- VW T1 Pritschenwagen (Typ 261, single cab, ~1963) ("pickup"), procedural Blender build.
#
#   blender -b --factory-startup --python tools/models/vehicles/pickup.py -- \
#       [--out=<dir>] [--lods=2,1,0] [--no-render] [--views=front34,side] [--ortho] [--no-ao] [--icon=<png>]
#
# The Pritsche shares the whole front of the Samba, so this script imports bulli.py as a module
# (its main() only runs as a script) and reuses the T1 shell (plan-view ring loft with the cream V),
# lamps, bumpers, logo and panel seams. What differs: a boolean box removes the bus body behind
# the cab and above the load floor (0.94 m), leaving the cab with its flat back wall and a small
# rear window; the load bed (2.6 x 1.57 m, ref/dimensions.json) has a wooden floor, three drop
# sides with painted stakes (like ref/pickup_blueprint.jpg) and the locker ("Tresor") under it.
# Materials, atlas, windows, assembly: tools/models/lib/bd_car.py. Bumpers painted in the cream
# of paint_secondary like on the blueprint; no whitewalls (working truck).
import os, sys, math, json
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "lib"))
sys.path.insert(0, HERE)
import bulli as t1                                    # noqa: E402  (T1 geometry; resets the scene)
from bd_car import *                                  # noqa: E402,F403
import bd_car                                         # noqa: E402
from mathutils import Vector, Matrix                  # noqa: E402
from mathutils.bvhtree import BVHTree                 # noqa: E402

DIMS = json.load(open(os.path.join(bd_car.MODELS, "ref", "dimensions.json")))["vehicles"]["pickup"]
LENGTH = t1.LENGTH                            # the T1 shell (4.28 m; Pritsche 4.29)
WIDTH = DIMS["width_m"]["value"]
HEIGHT = DIMS["height_m"]["value"]            # 1.92
WB = t1.WB
WR = t1.WR
Y_CAB = -0.775                                # back wall of the cab (blueprint: 1.37 m behind the bumper)
Z_BED = 0.94                                  # load floor (blueprint 0.936)
BOARD_H = DIMS["side_board_height_m"]["value"]   # 0.375
BED_X = 0.865                                 # outer face of the drop sides (flush with the T1 body)
Y_BED_END = 1.955                             # rear edge of the bed (2.6 m bed + cab gap)

init("pickup", "VW T1 Pritsche (1963)", DIMS,
     specs={"paint_primary": dict(col="#6F8A70"),            # L 532 Ancona-like green, calm
            "paint_secondary": dict(col="#D9CFB6"),
            "wood": dict(col="#85684B", rough=0.8)},
     hub_logo="vw", hub_r=0.125, hub_logo_r=0.05, wheel_radius=WR, tread_width=0.104,
     extra_hash=[os.path.join(HERE, "bulli.py")])


class PlaneSurf:
    """ray target: the flat cab back wall (plane y = Y_CAB, normal +Y)"""
    def ray(self, origin, direction, fallback=True):
        o, d = Vector(origin), Vector(direction).normalized()
        t = (Y_CAB - o.y) / d.y if abs(d.y) > 1e-9 else 0.0
        return o + d * t, Vector((0, 1, 0))


# --------------------------------------------------------------------------
# shell: T1 bus shell minus the box behind the cab / above the load floor
# --------------------------------------------------------------------------
def build_body(q):
    mb, _ = t1.build_shell(q)
    return mb


def box_cutter(x0, x1, y0, y1, z0, z1, mat, name="cutter"):
    mb = MB()
    box(mb, ((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), (x1 - x0, y1 - y0, z1 - z0), mat)
    return mb.obj(name, mat_sharp=False)


def bed_cutter(q):
    """prism along x: everything behind the cab wall above the load floor, plus a rounded cut of the
    roof's rear edge (radius 0.16 m) like the real cab"""
    mb = MB()
    n_arc = 6 if q["tire"] == "hi" else (3 if q["tire"] == "mid" else 1)
    yz = [(3.0, Z_BED), (Y_CAB, Z_BED), (Y_CAB, 1.78)]
    for k in range(1, n_arc + 1):
        a = (pi / 2) * k / n_arc
        yz.append((Y_CAB - 0.16 + 0.16 * math.cos(a), 1.78 + 0.16 * math.sin(a)))
    yz += [(Y_CAB - 0.16, 3.0), (3.0, 3.0)]
    n0 = mb.nfaces()
    a_ = [mb.v((-2.0, y, z)) for (y, z) in yz]
    b_ = [mb.v((2.0, y, z)) for (y, z) in yz]
    n = len(yz)
    for i in range(n):
        mb.f([a_[i], a_[(i + 1) % n], b_[(i + 1) % n], b_[i]], "cut_wall")
    mb.fan(a_, Vector((-2.0, 1.0, 2.0)), "cut_wall")
    mb.fan(b_, Vector((2.0, 1.0, 2.0)), "cut_wall", flip=True)
    bmesh.ops.recalc_face_normals(mb.bm, faces=mb.faces_since(n0))
    return mb.obj("bed_cutter", mat_sharp=False)


def arches(q):
    out = []
    for s in (1, -1):
        for ya in (t1.AXLE_F, t1.AXLE_R):
            x0 = 0.56 if s > 0 else -1.4
            out.append((arch_cutter(ya, t1.ARCH_ZC, t1.ARCH_R, x0, width=0.84, segs=q["arch_segs"]), ["body"]))
    out.append((bed_cutter(q), ["body"]))
    return out


def fix_wall(obj):
    """the faces left by the bed cutter: back wall two-tone like the cab, load floor dark"""
    me = obj.data
    names = [m.name for m in me.materials]
    if "cut_wall" not in names:
        return
    for n in ("paint_primary", "paint_secondary", "trim_dark"):
        if n not in names:
            me.materials.append(get_mat(n))
            names.append(n)
    iw = names.index("cut_wall")
    for p in me.polygons:
        if p.material_index == iw:
            c = p.center
            if p.normal.z > 0.7:
                p.material_index = names.index("trim_dark")
            else:
                p.material_index = names.index("paint_secondary" if c.z > t1.BELT else "paint_primary")


# --------------------------------------------------------------------------
# details
# --------------------------------------------------------------------------
def v_bead_and_belt(mb, S, q):
    """cream V swage on the front and the chrome belt strip round the cab (T1, bulli.py)"""
    arm = [Vector((x, -3, z)) for (x, z) in t1.v_pts(q["strip_arm"])]
    arm[-1] = Vector((t1.V_X, -3, 1.2535))
    BEAD = 0.0075
    if q["bead"]:
        for sgn in (1, -1):
            pts, nrms = [], []
            for p in arm[:-1] + [Vector((t1.V_X, -3, t1.BELT - 0.004))]:
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
                if c.z > t1.z_v(c.x) + 1e-4:
                    fc.material_index = iS
            mb.recalc(n0)
    A, F, R, bF, nF, bR, nR = t1.ring_params(1.2535, q)
    ol = t1.outline(A, F, R, bF, nF, bR, nR, dict(q, nqF=q["strip_nq"], nqR=q["strip_nq"], nS=8))
    prof = [(-0.012, -0.001), (-0.0105, 0.0045), (-0.005, 0.0072), (0.005, 0.0072), (0.0105, 0.0045), (0.012, -0.001)]
    if q["strip_nq"] < 8:
        prof = [(-0.011, 0.0), (0.0, 0.007), (0.011, 0.0)]
    for sgn in (1, -1):
        side = [p for p in ol if p.x * sgn >= t1.V_X and p.y < Y_CAB - 0.01]
        side.sort(key=lambda p: p.y)
        pts, nrms = [], []
        for p in arm[:-1]:
            loc, n = S.ray(Vector((p.x * sgn, -4, p.z - 0.004)), (0, 1, 0))
            if q["bead"]:
                loc = loc + n * (BEAD - 0.0015)
            pts.append(loc)
            nrms.append(n)
        for p in side + [Vector((sgn * A, Y_CAB - 0.012))]:
            loc, n = S.near(Vector((p.x, p.y, 1.2535)))
            pts.append(loc)
            nrms.append(n)
        strip(mb, pts, nrms, prof, "chrome")


def bed(mb, q):
    """load bed: wooden floor, drop sides (wood planks) with painted stakes and top rails"""
    y0, y1 = Y_CAB + 0.03, Y_BED_END
    ym, L = (y0 + y1) / 2, y1 - y0
    zt = Z_BED + BOARD_H
    box(mb, (0, ym, Z_BED + 0.012), (BED_X * 2 - 0.02, L, 0.024), "wood")
    if q["planks"]:
        for k in range(1, 10):                                     # plank gaps
            x = -0.78 + k * 0.156
            box(mb, (x, ym, Z_BED + 0.0245), (0.006, L - 0.01, 0.002), "trim_dark")
    t = 0.03
    sides = [((BED_X - t / 2, ym), (t, L)), ((-BED_X + t / 2, ym), (t, L)), ((0, y1 - t / 2), (BED_X * 2, t)),
             ((0, y0 + t / 2), (BED_X * 2, t))]
    for (cx, cy), (sx_, sy_) in sides:
        box(mb, (cx, cy, (Z_BED + zt) / 2), (sx_, sy_, BOARD_H), "wood")
        if q["planks"]:
            for zz in (Z_BED + BOARD_H / 3, Z_BED + 2 * BOARD_H / 3):
                ox = 0.0022 * (1 if cx > 0 else -1) if sx_ < 0.1 else 0.0
                oy = 0.0022 if cy > ym and sx_ >= 0.1 else (-0.0022 if sx_ >= 0.1 else 0.0)
                box(mb, (cx + ox, cy + oy, zz), (sx_ + 0.004 if sx_ < 0.1 else sx_ - 0.02, sy_ + 0.004 if sy_ < 0.1 else sy_ - 0.02, 0.005), "trim_dark")
        # painted top rail
        box(mb, (cx, cy, zt + 0.012), (sx_ + 0.01, sy_ + 0.01, 0.024), "paint_primary")
    # stakes (vertical, painted) and hinges on the lower edge
    ys = [y0 + 0.03, y0 + L * 0.34, y0 + L * 0.67, y1 - 0.03]
    for sgn in (1, -1):
        for y in ys:
            box(mb, (sgn * (BED_X + 0.012), y, (Z_BED + zt) / 2 + 0.01), (0.022, 0.05, BOARD_H + 0.04), "paint_primary")
            if q["planks"]:
                box(mb, (sgn * (BED_X + 0.014), y, Z_BED - 0.01), (0.03, 0.08, 0.035), "trim_dark")
    for x in (-0.55, 0.0, 0.55):
        box(mb, (x, y1 + 0.012, (Z_BED + zt) / 2 + 0.01), (0.05, 0.022, BOARD_H + 0.04), "paint_primary")
    # bed frame under the floor: painted carrier rails along the sides
    for sgn in (1, -1):
        box(mb, (sgn * (BED_X - 0.035), ym, Z_BED - 0.035), (0.07, L, 0.07), "paint_primary")
    box(mb, (0, y1 - 0.035, Z_BED - 0.035), (BED_X * 2, 0.07, 0.07), "paint_primary")


def details(S, q):
    mb = MB()
    sockets = {}
    # ---------------- windows (cab only) ----------------
    z0, z1 = t1.WINDOW_Z
    zc = (z0 + z1) / 2
    for s in (1, -1):
        N = t1.side_normal(s, zc)
        O, _ = S.side(s, -1.20, zc)
        pane(mb, S, O, N, [(s * 0.9, -1.625, z0), (s * 0.9, -0.87, z0), (s * 0.9, -0.87, z1), (s * 0.9, -1.515, z1)],
             [0.03, 0.045, 0.045, 0.05], q)
        if q["vent_bar"]:
            a, na = S.side(s, -1.455, z0 + 0.024)
            b, nb = S.side(s, -1.372, z1 - 0.024)
            tube(mb, [a + na * 0.0055, b + nb * 0.0055], 0.0058, q["vent_bar"], "chrome")
    for s in (1, -1):                                               # split windshield
        O, N = S.front(s * 0.34, 1.52)
        N = Vector((N.x * 0.5, N.y, N.z)).normalized()
        pane(mb, S, O, N, [(s * 0.035, O.y, t1.WS_Z[0]), (s * 0.665, O.y, t1.WS_Z[0]), (s * 0.60, O.y, t1.WS_Z[1]),
                           (s * 0.035, O.y, t1.WS_Z[1])], [0.035, 0.09, 0.11, 0.035], q,
             grings=0 if q["holes"] else 2, curved=not q["holes"] and q["seal"] < 3)
    PS = PlaneSurf()                                                # cab rear window in the flat back wall
    O = Vector((0, Y_CAB, 1.56))
    pane(mb, PS, O, Vector((0, 1, 0)), [(-0.34, Y_CAB, 1.45), (0.34, Y_CAB, 1.45), (0.34, Y_CAB, 1.66),
                                         (-0.34, Y_CAB, 1.66)], 0.05, q)
    mb.part("windows")
    # ---------------- V bead, belt, rocker, gutter, arch lips ----------------
    if q["strips"]:
        v_bead_and_belt(mb, S, q)
        for s in (1, -1):                                           # rocker trim under the cab door
            pts, nrms = [], []
            for i in range(5):
                loc, n = S.side(s, -0.76 + 0.7 * i / 4, 0.418)
                pts.append(loc)
                nrms.append(n)
            strip(mb, pts, nrms, [(-0.009, -0.001), (0.0, 0.005), (0.009, -0.001)], "chrome")
        A, F, R, bF, nF, bR, nR = t1.ring_params(1.705, q)
        ol = t1.outline(A, F, R, bF, nF, bR, nR, dict(q, nqF=q["strip_nq"], nqR=4, nS=12))
        half = len(ol) // 2
        leftp = [p for p in ol[:half + 1] if p.y < Y_CAB - 0.02]
        rightp = [Vector((-p.x, p.y)) for p in leftp[1:]]
        path = list(reversed(rightp)) + leftp
        pts, nrms = [], []
        for p in path:
            zz = 1.712 if p.y > -F + bF * 0.5 else 1.748
            loc, n = S.near(Vector((p.x, p.y, zz)))
            pts.append(loc)
            nrms.append(n)
        gp = [(-0.010, -0.001), (-0.010, 0.010), (-0.002, 0.014), (0.009, 0.006), (0.010, -0.001)] if q["strip_nq"] >= 8 \
            else [(-0.010, -0.001), (-0.006, 0.013), (0.010, -0.001)]
        strip(mb, pts, nrms, gp, "paint_secondary")
        for s in (1, -1):
            for ya in (t1.AXLE_F, t1.AXLE_R):
                pts, nrms = [], []
                th0 = math.asin((0.345 - t1.ARCH_ZC) / (t1.ARCH_R + 0.012))
                for i in range(q["arch_n"] + 1):
                    th = th0 + (pi - 2 * th0) * i / q["arch_n"]
                    loc, n = S.side(s, ya + (t1.ARCH_R + 0.012) * math.cos(th), t1.ARCH_ZC + (t1.ARCH_R + 0.012) * math.sin(th))
                    pts.append(loc)
                    nrms.append(n)
                strip(mb, pts, nrms, [(-0.014, -0.001), (-0.009, 0.004), (0.004, 0.005), (0.012, -0.001)], "paint_primary")
        mb.part("trim")
    # ---------------- lamps, logo, plate ----------------
    for s in (1, -1):
        sockets["socket_headlight_" + ("l" if s > 0 else "r")] = t1.headlight(mb, S, s * 0.545, 0.775, q)
        if q["lamp"] > 8:
            t1.blinker(mb, S, s * 0.625, 1.005, q)
        sockets["socket_taillight_" + ("l" if s > 0 else "r")] = t1.taillight(mb, S, s * 0.635, 0.705, q)
    O, N = S.front(0, 1.02)
    t1.build_logo(mb, O + N * 0.004, N, 0.158, q)
    if q["plate"]:
        O, N = S.rear(0, 0.64)
        plate(mb, O, N, q)
    mb.part("lamps_logo_plate")
    # ---------------- panel seams: cab doors, locker, rear panel ----------------
    if q["seams"]:
        Rd = t1.ARCH_R + 0.045
        yb = -0.80
        zr = t1.ARCH_ZC + math.sqrt(max(Rd ** 2 - (yb - t1.AXLE_F) ** 2, 0.0))
        a_r = math.atan2(zr - t1.ARCH_ZC, yb - t1.AXLE_F)
        zf_ = 0.62
        a_f = math.atan2(zf_ - t1.ARCH_ZC, -math.sqrt(Rd ** 2 - (zf_ - t1.ARCH_ZC) ** 2))
        arc = [(t1.AXLE_F + Rd * math.cos(a_r + (a_f - a_r) * k / 12), t1.ARCH_ZC + Rd * math.sin(a_r + (a_f - a_r) * k / 12))
               for k in range(13)]
        for s in (1, -1):
            X = Vector((s, 0, 0))
            door = [(-1.642, 0.68), (-1.645, 1.26), (-1.60, 1.40), (-1.515, 1.705), (yb, 1.705)] + arc + [(-1.642, 0.68)]
            seam(mb, S, [(s * 0.8, y, z) for (y, z) in door], X)
            for zh in (0.93, 1.17):
                loc, n = S.side(s, -1.628, zh)
                tube(mb, [loc - Vector((0, 0, 0.035)), loc + n * 0.009 - Vector((0, 0, 0.02)),
                          loc + n * 0.009 + Vector((0, 0, 0.02)), loc + Vector((0, 0, 0.035))], 0.011, 6, "chrome")
            locker = [(-0.70, 0.46), (0.52, 0.46), (0.52, 0.90), (-0.70, 0.90), (-0.70, 0.46)]   # "Tresor" door
            seam(mb, S, [(s * 0.8, y, z) for (y, z) in locker], X)
            seam(mb, S, [(s * 0.8, 1.73, 0.50), (s * 0.8, 1.73, 0.90)], X)
        mb.part("seams")
    if q["handles"]:
        for s, y in ((1, -0.93), (-1, -0.93), (1, -0.15), (-1, -0.15)):
            loc, n = S.side(s, y, 1.06 if y < -0.5 else 0.70)
            p0, p1 = loc + n * 0.012 + Vector((0, -0.055, 0)), loc + n * 0.012 + Vector((0, 0.055, 0))
            tube(mb, [loc + Vector((0, -0.06, 0)) - n * 0.002, p0, p1, loc + Vector((0, 0.06, 0)) - n * 0.002], 0.008, 6, "chrome")
        mb.part("handles")
    if q["louvers"]:
        for s in (1, -1):
            for k in range(6):
                z = 0.63 + 0.042 * k
                pts, nrms = [], []
                for i in (range(4) if s > 0 else range(3, -1, -1)):
                    loc, n = S.side(s, 1.285 + 0.29 * i / 3, z)
                    pts.append(loc)
                    nrms.append(n)
                strip(mb, pts, nrms, [(-0.012, 0.001), (0.004, 0.001)], "trim_dark")
        mb.part("louvers")
    # ---------------- load bed ----------------
    bed(mb, q)
    mb.part("bed")
    # ---------------- mirrors, wipers ----------------
    if q["mirrors"]:
        for s in (1, -1):
            base, n = S.side(s, -1.655, 1.215)
            p1 = base + Vector((s * 0.05, -0.012, 0.055))
            head = base + Vector((s * 0.10, -0.03, 0.105))
            tube(mb, [base - Vector((s * 0.01, 0, 0)), p1, head], 0.0115, max(5, q["tube"] - 3), "chrome")
            M = frame_from_axis(Vector((0.18 * s, 1, 0)))
            lathe(mb, [(0.0, -0.016), (0.052, -0.010), (0.059, 0.004), (0.0, 0.008)], max(12, q["lamp"] * 2 // 3),
                  M, head + Vector((0, 0.01, 0)), ["chrome"] * 3)
    if q["wipers"]:
        for s in (1, -1):
            a, na = S.front(s * 0.42, 1.30)
            b, nb = S.front(s * 0.60, 1.58)
            a, b = a + na * 0.010, b + nb * 0.012
            tube(mb, [a, a.lerp(b, 0.5) + na * 0.003, b], 0.0032, 4, "trim_dark")
            box(mb, a - na * 0.004, (0.016, 0.016, 0.016), "chrome")
    mb.part("mirrors_wipers")
    # ---------------- underbody, exhaust ----------------
    if q["under"]:
        box(mb, (0, 1.45, 0.34), (0.95, 0.75, 0.16), "trim_dark")
        box(mb, (0, 1.93, 0.30), (0.80, 0.18, 0.14), "trim_dark")
        box(mb, (0, -0.25, 0.30), (1.0, 2.6, 0.04), "trim_dark")
        for s in (1, -1):
            tube(mb, [(0.0, t1.AXLE_R, 0.34), (s * 0.55, t1.AXLE_R, WR)], 0.04, 6, "trim_dark")
    tube(mb, [(0.18, 1.96, 0.26), (0.18, 2.13, 0.25)], 0.021, 8 if q["tube"] > 6 else 5, "chrome")
    sockets["socket_exhaust"] = Vector((0.18, 2.14, 0.25))
    mb.part("underbody")
    # ---------------- cab interior ----------------
    if q["interior"]:
        yd = -1.70
        box(mb, (0, yd + 0.10, 1.215), (1.40, 0.20, 0.07), "paint_secondary")
        box(mb, (0, yd + 0.13, 1.08), (1.36, 0.10, 0.20), "interior")
        c = Vector((0.40, -1.36, 1.22))
        ax = Vector((0, 0.45, 1.0)).normalized()
        Mw = frame_from_axis(ax)
        segs = q["int_seg"] * 2
        rim = [c + Mw @ Vector((0.20 * math.cos(2 * pi * k / segs), 0.20 * math.sin(2 * pi * k / segs), 0)) for k in range(segs)]
        tube(mb, rim, 0.012, 5 if q["int_seg"] > 8 else 4, "ivory", closed=True)
        tube(mb, [c - ax * 0.02, c - ax * 0.55], 0.02, 5, "trim_dark", cap_start=False)
        box(mb, (0, -1.09, 0.75), (1.48, 0.42, 0.12), "seat")                 # bench
        box(mb, (0, -0.86, 1.02), (1.48, 0.10, 0.50), "seat", M=Matrix.Rotation(-0.12, 3, "X"))
        mb.part("interior")
    if q["blob"]:
        vs = [mb.v((sx * 1.22, sy * 2.55, 0.012)) for (sx, sy) in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        fc = mb.f(vs, "blob")
        mb.set_uv(fc, vs, [(0, 0), (1, 0), (1, 1), (0, 1)])
    return mb, sockets


def build_bumpers(q):
    """T1 bumpers (bulli.bumper), painted in paint_secondary instead of chrome"""
    mb = MB()
    t1.bumper(mb, q, front=True)
    t1.bumper(mb, q, front=False)
    mb.mats = ["paint_secondary" if m == "chrome" else m for m in mb.mats]
    return mb


def inner_shell(q):
    if not q["interior"]:
        return None
    o = t1.build_inner_shell(q).obj("inner", smooth_angle=50, mat_sharp=False)
    c = box_cutter(-2, 2, Y_CAB - 0.045, 3, -1, 3, "interior", "inner_cut")
    boolean_diff(o, [c])
    bpy.data.objects.remove(c, do_unlink=True)
    me = o.data
    names = [m.name for m in me.materials]
    if "headliner" in names:
        ih, iw = names.index("headliner"), names.index("interior")
        for p in me.polygons:
            if p.material_index == iw and p.center.z > 1.66:
                p.material_index = ih
    return o


def surf(S, q, root):
    """board lying in the load bed on two wooden chocks"""
    mb = MB()
    for y in (-0.30, 1.30):
        box(mb, (0.0, y, Z_BED + 0.045), (0.46, 0.08, 0.05), "wood" if q["surf_n"] > 6 else "trim_dark")
    surfboard_board(mb, q, 0.52, Z_BED + 0.07 + 0.0375, L=2.4, W=0.56, T=0.075)
    return finish_surfboard(mb, root)


def make_q(lod):
    q = dict(t1.Q[lod])
    q.update({0: dict(planks=True, handles=True, louvers=True, wheel_segs=32, tire="hi", merge_wheels=False),
              1: dict(planks=False, handles=False, louvers=False, wheel_segs=16, tire="mid", merge_wheels=False),
              2: dict(planks=False, handles=False, louvers=False, wheel_segs=8, tire="lo", merge_wheels=True)}[lod])
    return q


WHEEL = dict(R=WR, w=0.104, bead=0.178, ww=None, rim="rim_paint", hub_r=0.125, hub_h=0.022)


def build_lod(lod):
    q = make_q(lod)
    parts = {"body": build_body(q), "bumpers": build_bumpers(q)}
    wheels = [("wheel_fl", t1.TRACK_F / 2, t1.AXLE_F, True), ("wheel_fr", -t1.TRACK_F / 2, t1.AXLE_F, True),
              ("wheel_rl", t1.TRACK_R / 2, t1.AXLE_R, False), ("wheel_rr", -t1.TRACK_R / 2, t1.AXLE_R, False)]
    props = dict(model="VW T1 Pritsche (1963)", length_m=LENGTH, width_m=WIDTH, height_m=HEIGHT, wheelbase_m=WB,
                 collision_half_extents=[0.90, 0.96, 2.14])
    return assemble(lod, q, props, parts, arches, details, inner_shell, surf, WHEEL, wheels, nametag_z=2.4)


# the bed cutter leaves faces with the helper material 'cut_wall': recolour them before the atlas
_atlasify = bd_car.atlasify


def _atlasify_fixing(o):
    if o.type == "MESH" and any(m and m.name == "cut_wall" for m in o.data.materials):
        fix_wall(o)
    _atlasify(o)


bd_car.atlasify = _atlasify_fixing
CAR["specs"]["cut_wall"] = dict(col="#FF00FF", rough=1.0)

if __name__ == "__main__":
    main(build_lod, {"length": LENGTH, "width": WIDTH, "height": HEIGHT, "wheelbase": WB, "track_f": t1.TRACK_F,
                     "track_r": t1.TRACK_R, "wheel_radius": WR, "axle_f_y": t1.AXLE_F, "axle_r_y": t1.AXLE_R})
