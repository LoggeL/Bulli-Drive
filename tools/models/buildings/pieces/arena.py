# Party arena "Cannery Lot" elements: concrete K-rail barrier (F-shape, 3.81 m), plastic water
# filled barrier (2 m, red or white), aluminium grandstand (6 rows, 10 m) on a steel frame with
# guard rails, a 16 m floodlight mast with six lamps, and ISO shipping containers (20 ft, 40 ft)
# with corrugated sides, cargo doors, locking bars and corner castings.
#
# Params (kit.json): kind ("jersey" | "water" | "grandstand" | "floodlight" | "container"), length,
# rows, seed.
import math
from bd_kit import (K, tile, pal, box, rect, lin, mul, Rng, beam, cylinder, prism)
from mathutils import Vector

CONTAINER = ["#B5412F", "#2F5F8A", "#3E7A55", "#C8752E", "#8C8F91", "#6E3B2E", "#D9C9A0"]


def build(spec, lod):
    kind = spec["kind"]
    return {"jersey": jersey, "water": water, "grandstand": grandstand, "floodlight": floodlight,
            "container": container}[kind](spec, lod)


def jersey(spec, lod):
    k = K()
    L = float(spec.get("length", 3.81))
    prof = [(-0.305, 0.0), (0.305, 0.0), (0.305, 0.075), (0.23, 0.33), (0.12, 0.81), (-0.12, 0.81), (-0.23, 0.33),
            (-0.305, 0.075)]
    conc = tile("concrete", lin("#D2CCC0"))
    # closed profile: repeat the first point so every side gets a face
    prism(k, [(0.0, 0, 0), (L, 0, 0)], prof + [prof[0]], conc)
    if lod == 0:
        # pin and loop connectors and two drainage slots
        for x in (0.05, L - 0.05):
            box(k, (x - 0.05, -0.06, 0.55), (x + 0.05, 0.06, 0.7), pal("steel_dark"), "xXyYZz")
        for x in (L * 0.3, L * 0.7):
            box(k, (x - 0.3, -0.306, 0.0), (x + 0.3, -0.3, 0.09), pal("tar"), "y")
            box(k, (x - 0.3, 0.3, 0.0), (x + 0.3, 0.306, 0.09), pal("tar"), "Y")
    return k, {"footprint": [0.0, L, -0.31, 0.31], "height": 0.81, "overhang": 0.0, "foundation": 0.0,
               "ao_dist": 0.5, "grime": True, "grime_low": 0.8}


def water(spec, lod):
    k = K()
    L = 2.0
    col = pal("plastic_" + spec.get("color", "red"))
    prof = [(-0.26, 0.0), (0.26, 0.0), (0.26, 0.12), (0.2, 0.55), (0.14, 0.92), (0.08, 1.0), (-0.08, 1.0),
            (-0.14, 0.92), (-0.2, 0.55), (-0.26, 0.12)]
    if lod > 0:
        prof = [(-0.26, 0.0), (0.26, 0.0), (0.26, 0.12), (0.14, 0.92), (0.08, 1.0), (-0.08, 1.0), (-0.14, 0.92), (-0.26, 0.12)]
    prism(k, [(0.05, 0, 0), (L - 0.05, 0, 0)], prof + [prof[0]], col)
    if lod == 0:
        # interlocking knuckles at the ends and the fill cap
        for x in (0.0, L - 0.1):
            box(k, (x, -0.1, 0.1), (x + 0.1, 0.1, 0.9), col, "xXyYZ")
        cylinder(k, (L / 2, 0, 1.0), (L / 2, 0, 1.03), 0.07, 10, pal("plastic_white"))
    return k, {"footprint": [0.0, L, -0.26, 0.26], "height": 1.03, "overhang": 0.0, "foundation": 0.0,
               "ao_dist": 0.5, "grime": True, "grime_low": 0.85}


def grandstand(spec, lod):
    k = K()
    L = float(spec.get("length", 10.0))
    rows = int(spec.get("rows", 6))
    rise, run = 0.4, 0.75
    alu = pal("aluminium")
    steel = pal("galvanized")
    seat_z0 = 0.45
    ytot = rows * run
    # seats (plank) and foot boards per row; rows go back (+Y) and up
    for i in range(rows):
        y = i * run
        z = seat_z0 + i * rise
        box(k, (0.0, y + 0.35, z - 0.05), (L, y + 0.7, z), alu, "yYZz")               # seat plank
        box(k, (0.0, y + 0.02, z - rise * 0.5 - 0.04), (L, y + 0.32, z - rise * 0.5), alu, "yYZz")  # foot board
        if lod < 2:
            box(k, (0.0, y + 0.66, z - 0.05 - rise * 0.5), (L, y + 0.7, z - 0.05), alu, "y")          # riser
    # steel frame: stringers every 2.5 m with legs
    nf = int(L / 2.5)
    for j in range(nf + 1):
        x = L * j / nf
        x = min(max(x, 0.1), L - 0.1)
        beam(k, (x, 0.2, 0.0), (x, ytot, seat_z0 + (rows - 1) * rise - 0.08), 0.1, 0.16, steel, up=(0, -0.5, 1))
        for i in range(0, rows, 2 if lod < 2 else rows):
            y = i * run + 0.5
            z = seat_z0 + i * rise - 0.08
            box(k, (x - 0.05, y - 0.05, 0.0), (x + 0.05, y + 0.05, z), steel, "xXyY")
        box(k, (x - 0.05, ytot - 0.1, 0.0), (x + 0.05, ytot, seat_z0 + (rows - 1) * rise), steel, "xXyY")
        if lod == 0 and j < nf:
            x2 = min(max(L * (j + 1) / nf, 0.1), L - 0.1)
            beam(k, (x, ytot - 0.05, 0.3), (x2, ytot - 0.05, seat_z0 + (rows - 1) * rise - 0.3), 0.06, 0.06, steel)
    # guard rails: back and ends
    zt = seat_z0 + (rows - 1) * rise
    rail_h = 1.05
    if lod < 2:
        beam(k, (0, ytot, zt + rail_h), (L, ytot, zt + rail_h), 0.05, 0.05, alu)
        beam(k, (0, ytot, zt + rail_h * 0.5), (L, ytot, zt + rail_h * 0.5), 0.04, 0.04, alu)
        for x in [L * j / (2 * nf) for j in range(2 * nf + 1)]:
            box(k, (x - 0.025, ytot - 0.025, zt), (x + 0.025, ytot + 0.025, zt + rail_h), alu, "xXyY")
        for x in (0.0, L):
            beam(k, (x, 0.2, seat_z0 + rail_h), (x, ytot, zt + rail_h), 0.05, 0.05, alu)
    else:
        box(k, (0, ytot - 0.02, zt), (L, ytot + 0.02, zt + rail_h), alu, "yY")
    return k, {"footprint": [0.0, L, 0.0, ytot], "height": zt + rail_h, "overhang": 0.0, "foundation": 0.1,
               "ao_dist": 1.0, "grime": False}


def floodlight(spec, lod):
    k = K()
    H = float(spec.get("height", 16.0))
    steel = pal("galvanized")
    # footing, base plate, tapered pole
    box(k, (-0.5, -0.5, -0.8), (0.5, 0.5, 0.25), tile("concrete"), "xXyYZ")
    box(k, (-0.3, -0.3, 0.25), (0.3, 0.3, 0.3), steel, "xXyYZ")
    segs = [10, 8, 6][lod]
    cylinder(k, (0, 0, 0.3), (0, 0, H), 0.2, segs, steel, cap_top=True, r_top=0.11)
    # head frame: two bars with three lamps each, tilted towards -Y (the arena)
    bw = 2.6
    for z in (H + 0.1, H + 0.9):
        box(k, (-bw / 2, -0.08, z - 0.05), (bw / 2, 0.08, z + 0.05), steel, "xXyYzZ")
    if lod < 2:
        for x in (-bw / 2 + 0.05, bw / 2 - 0.05):
            box(k, (x - 0.04, -0.06, H + 0.05), (x + 0.04, 0.06, H + 0.95), steel, "xXyY")
    tilt = math.radians(25)
    Rx = mat_rot_x(tilt)
    for z in (H + 0.1, H + 0.9):
        for x in (-0.85, 0.0, 0.85):
            c = Vector((x, -0.3, z + 0.02))
            lamp(k, c, Rx, lod)
    if lod == 0:
        # climbing rungs on the pole and the cabinet
        for i in range(int((H - 3) / 0.35)):
            z = 2.5 + i * 0.35
            box(k, (-0.2, 0.18, z - 0.015), (0.2, 0.22, z + 0.015), steel, "yYzZ")
        box(k, (-0.22, -0.34, 1.0), (0.22, -0.18, 1.6), pal("steel_dark"), "xXyYZ")
    return k, {"footprint": [-0.5, 0.5, -0.5, 0.5], "height": H + 1.3, "overhang": 1.4, "foundation": 0.8,
               "ao_dist": 0.6, "grime": False}


def mat_rot_x(a):
    from mathutils import Matrix
    return Matrix.Rotation(a, 3, "X")


def lamp(k, c, R, lod):
    """flood lamp housing (0.6 x 0.3 x 0.5) facing -Y rotated by R, emissive glass front"""
    from bd_kit import obox
    obox(k, c + R @ Vector((0, 0.1, 0)), (0.62, 0.3, 0.5), R, pal("aluminium"), "xXYzZ")
    # emissive front glass (the -Y face)
    hw, hh = 0.27, 0.21
    y = -0.06
    pts = [c + R @ Vector(p) for p in ((-hw, y, -hh), (hw, y, -hh), (hw, y, hh), (-hw, y, hh))]
    m = pal("lamp_cool")
    k.face(pts, [m.uv] * 4, m.tint)


def container(spec, lod):
    r = Rng(spec.get("seed", 1))
    k = K()
    L = float(spec.get("length", 6.06))
    Wc, Hc = 2.44, 2.59
    tint = lin(r.pick(CONTAINER))
    side = tile("container", tint)
    frame = pal("steel_dark", mul(tint, 1.0))
    x0, x1, y0, y1 = 0.0, L, -Wc / 2, Wc / 2
    t = 0.12        # frame rails
    # corrugated panels between the frame rails (sides, roof, the closed end), doors at x1
    rect(k, (x0 + t, y0, t), (1, 0, 0), (0, 0, 1), L - 2 * t, Hc - 2 * t, side, 0.0, 0.0)
    rect(k, (x1 - t, y1, t), (-1, 0, 0), (0, 0, 1), L - 2 * t, Hc - 2 * t, side, 0.0, 0.0)
    rect(k, (x0, y1 - t, t), (0, -1, 0), (0, 0, 1), Wc - 2 * t, Hc - 2 * t, side, 0.0, 0.0)
    rect(k, (x0 + t, y0 + t, Hc), (1, 0, 0), (0, 1, 0), L - 2 * t, Wc - 2 * t, side.with_tint(mul(tint, 0.9)), 0.0, 0.0)
    # doors: two leaves with vertical ribs, locking bars
    door = tile("container", mul(tint, 0.95))
    rect(k, (x1, y0 + t, t), (0, 1, 0), (0, 0, 1), Wc - 2 * t, Hc - 2 * t, door, 0.0, 0.0)
    # frame: corner posts, top and bottom rails
    for (cx, cy) in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):
        box(k, (cx - (0 if cx == x0 else t), cy - (0 if cy == y0 else t), 0.0),
            (cx + (t if cx == x0 else 0), cy + (t if cy == y0 else 0), Hc), frame)
    for z0_, z1_ in ((0.0, t), (Hc - t, Hc)):
        box(k, (x0 + t, y0, z0_), (x1 - t, y0 + 0.02, z1_), frame, "yZz")
        box(k, (x0 + t, y1 - 0.02, z0_), (x1 - t, y1, z1_), frame, "YZz")
        box(k, (x0, y0 + t, z0_), (x0 + 0.02, y1 - t, z1_), frame, "xZz")
        box(k, (x1 - 0.02, y0 + t, z0_), (x1, y1 - t, z1_), frame, "XZz")
    if lod < 2:
        # locking bars and handles on the doors, the door gap
        for y in (y0 + 0.45, y0 + 0.85, y1 - 0.85, y1 - 0.45):
            cylinder(k, (x1 + 0.04, y, 0.15), (x1 + 0.04, y, Hc - 0.15), 0.022, 6, pal("galvanized"), cap_top=True)
        box(k, (x1, -0.01, t), (x1 + 0.01, 0.01, Hc - t), pal("rubber"), "X")
    if lod == 0:
        # corner castings
        for cx in (x0, x1 - 0.18):
            for cy in (y0, y1 - 0.18):
                for cz in (0.0, Hc - 0.12):
                    box(k, (cx - 0.005, cy - 0.005, cz - 0.005), (cx + 0.185, cy + 0.185, cz + 0.125), pal("steel_dark"))
    return k, {"footprint": [x0, x1, y0, y1], "height": Hc, "overhang": 0.0, "foundation": 0.0,
               "ao_dist": 1.0, "grime": True, "grime_low": 0.8, "params": {"tint": list(round(c, 4) for c in tint)}}


def render(objs, R, out_dir, tag):
    import os
    so, mp, info = R.setup()
    R.slab("lot", -80, 80, -80, 80, 0.0, R.ground_mat("asphalt", 3.0, (0.85, 0.85, 0.85)))
    R.aim_sun(so, mp, info, -45, 28)
    x = -12.0
    for i in range(5):
        R.place(objs["arena_jersey"][0], "j%d" % i, (x + i * 3.83, -6, 0))
    for i in range(4):
        R.place(objs["arena_water_red" if i % 2 == 0 else "arena_water_white"][0], "w%d" % i, (x + 20 + i * 2.0, -6, 0))
    R.place(objs["arena_grandstand"][0], "gs", (-6, 6, 0))
    R.place(objs["arena_floodlight"][0], "fl", (8, 8, 0), math.radians(180))
    R.place(objs["arena_container_20"][0], "c20", (10, -1, 0), 0.3)
    R.place(objs["arena_container_40"][0], "c40", (-22, 0, 0), -0.15)
    R.place(objs["arena_container_20b"][0], "c20b", (10.5, -1.2, 2.6), 0.25)
    R.shoot(os.path.join(out_dir, "arena_overview_%s.png" % tag), (-2, -26, 6.0), (0, 4, 3.0), lens=26)
    R.shoot(os.path.join(out_dir, "arena_close_%s.png" % tag), (-9, -10.5, 1.5), (-5, -6, 0.5), lens=30)
    R.shoot(os.path.join(out_dir, "arena_stand_%s.png" % tag), (-7, -3.5, 2.2), (0, 7, 2.2), lens=28)
    R.shoot(os.path.join(out_dir, "arena_light_%s.png" % tag), (2, -6, 2.0), (8, 8, 12.0), lens=24)
