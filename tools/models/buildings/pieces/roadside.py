# Road side: W-beam guardrail (Caltrans / MASH Midwest Guardrail System look) and its
# turned-down end terminal. A segment is one 3.81 m rail panel with its post at x = 0 (the next
# segment brings the next post), the rail on wood blockouts on the traffic side (Blender -Y,
# three.js +Z); rail top 0.79 m, posts reach 1.1 m into the ground. The end piece ramps the
# rail down into the ground over 7.6 m with a slight flare away from the traffic.
#
# Params (kit.json): kind ("segment" | "end"), length (m), dir (-1: the end extends to -X, +1: to +X).
from bd_kit import (K, pal, box, lin, mul, WHITE, prism)
from mathutils import Vector

RAIL_TOP = 0.787
RAIL_H = 0.311
POST_Y = 0.0
BLOCK = 0.2
EMBED = 1.1


def w_profile(lod):
    """cross-section of the W-beam (w = +Y left of travel +X, h up); thin closed shape,
    traffic side at negative w"""
    d = 0.083
    front = [(0.0, RAIL_H), (-d, RAIL_H - 0.05), (-d, RAIL_H - 0.115), (-0.03, RAIL_H / 2),
             (-d, 0.115), (-d, 0.05), (0.0, 0.0)] if lod == 0 else [(0.0, RAIL_H), (-d, RAIL_H - 0.06), (-d, 0.06), (0.0, 0.0)]
    t = 0.006
    back = [(w + t, h) for (w, h) in reversed(front)]
    return front + back


def rail_path(k, pts, lod):
    """W-beam along a path of 3D points (bottom edge of the beam, traffic face at -w)"""
    prof = w_profile(lod)
    prism(k, pts, prof, pal("galvanized"), cap=True)


def post(k, x, lod, z_top=RAIL_TOP - 0.05, rail_top=RAIL_TOP, y_shift=0.0):
    """steel W6x9 post (I section) with a wood blockout towards the traffic"""
    steel = pal("galvanized", mul(WHITE, 0.85))
    y_rail = -(0.075 + BLOCK)
    if lod == 0:
        # flanges and web
        box(k, (x - 0.076, -0.075, -EMBED), (x + 0.076, -0.066, z_top), steel)
        box(k, (x - 0.076, 0.066, -EMBED), (x + 0.076, 0.075, z_top), steel)
        box(k, (x - 0.005, -0.066, -EMBED), (x + 0.005, 0.066, z_top), steel, "xXZ")
    else:
        box(k, (x - 0.076, -0.075, -EMBED), (x + 0.076, 0.075, z_top), steel, "xXyYZ")
    yr = y_rail + y_shift
    if yr < -0.076:
        box(k, (x - 0.075, yr, rail_top - 0.3), (x + 0.075, -0.075, rail_top - 0.02), pal("wood_brown", lin("#8C7A66")), "xXyZz")
    if lod == 0:
        box(k, (x - 0.04, yr - 0.1, rail_top - 0.14), (x + 0.04, yr - 0.085, rail_top - 0.06), pal("reflector"), "y")


def build(spec, lod):
    k = K()
    kind = spec.get("kind", "segment")
    y_rail = -(0.075 + BLOCK)
    if kind == "segment":
        L = float(spec.get("length", 3.81))
        post(k, 0.0, lod)
        # rail panel, overlapping the next panel by the splice (0.3 m)
        rail_path(k, [(-0.15, y_rail, RAIL_TOP - RAIL_H), (L + 0.15, y_rail, RAIL_TOP - RAIL_H)], lod)
        if lod == 0:
            for dx in (-0.1, 0.0, 0.1):
                box(k, (dx - 0.015, y_rail - 0.09, RAIL_TOP - 0.2), (dx + 0.015, y_rail - 0.083, RAIL_TOP - 0.11), pal("steel_dark"), "y")
        # traffic side (rail) at Blender -y
        return k, {"footprint": [-0.15, L + 0.15, -0.37, 0.08], "height": RAIL_TOP, "overhang": 0.0,
                   "foundation": EMBED, "ao_dist": 0.8, "ao_strength": 0.4, "grime": False}
    # end terminal: rail descends to the ground over 2 panels and flares 0.6 m away from traffic
    sgn = int(spec.get("dir", -1))
    L = 7.62
    n = 12 if lod == 0 else 6
    pts = []
    for i in range(n + 1):
        t = i / n
        x = sgn * L * t
        z = (RAIL_TOP - RAIL_H) * (1 - t) + (-0.35) * t
        s = t * t * (3 - 2 * t)
        y = y_rail + 0.6 * s * s
        pts.append((x, y, z))
    if sgn > 0:
        rail_path(k, [Vector(p) for p in pts], lod)
    else:
        rail_path(k, [Vector(p) for p in reversed(pts)], lod)
    for i, xp in enumerate((0.0, 1.905, 3.81, 5.715)):
        x = sgn * xp
        t = xp / L
        z_rail = (RAIL_TOP - RAIL_H) * (1 - t) + (-0.35) * t + RAIL_H     # rail top above this post
        s = t * t * (3 - 2 * t)
        if z_rail > 0.35:
            post(k, x, lod, z_top=z_rail - 0.05, rail_top=z_rail, y_shift=0.6 * s * s)
    # yellow and black end marker at the buried end
    xm = sgn * (L - 0.3)
    box(k, (xm - 0.04, 0.35, 0.0), (xm + 0.04, 0.43, 1.1), pal("safety_yellow"), "xXyYZ")
    fx = sorted((0.0, sgn * L))
    return k, {"footprint": [fx[0], fx[1], -0.37, 0.45], "height": RAIL_TOP, "overhang": 0.0, "foundation": EMBED,
               "ao_dist": 0.8, "ao_strength": 0.4, "grime": False}


def render(objs, R, out_dir, tag):
    import os
    so, mp, info = R.setup()
    R.slab("road", -40, 60, -40, 0.4, 0.0, R.ground_mat("asphalt", 3.0))
    R.slab("verge", -40, 60, 0.4, 40, 0.0, R.ground_mat("grass_dry", 2.0))
    R.aim_sun(so, mp, info, -50, 28)
    seg = next(p for p in objs if "segment" in p)
    x = 0.0
    R.place(objs["guardrail_end_start"][0], "end_a", (0.0, 1.2, 0.0))
    for i in range(8):
        R.place(objs[seg][0], "seg_%d" % i, (x, 1.2, 0.0))
        x += 3.81
    R.place(objs["guardrail_end_finish"][0], "end_b", (x, 1.2, 0.0))
    R.shoot(os.path.join(out_dir, "guardrail_road_%s.png" % tag), (-10, -4, 1.3), (12, 1.2, 0.5), lens=30)
    R.shoot(os.path.join(out_dir, "guardrail_close_%s.png" % tag), (8, -2.0, 1.0), (10.5, 1.0, 0.55), lens=30)
    R.shoot(os.path.join(out_dir, "guardrail_back_%s.png" % tag), (20, 6, 1.6), (8, 1.2, 0.5), lens=30)
