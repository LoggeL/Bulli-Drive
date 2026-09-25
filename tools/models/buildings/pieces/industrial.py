# Industrial / harbour hall (Harbor, Cannery Row): steel portal frame clad in painted corrugated
# sheet on a concrete plinth, low front-gabled corrugated roof with ridge vent and gutters,
# roll-up doors in steel frames, personnel doors with canopies, a band of steel factory windows
# in every 6 m bay, downpipes, corner flashings, a painted sign board in the gable and an
# optional loading dock along the front.
#
# Params (kit.json): bays (4-8, 6 m each, along the street), depth (m), eave (m), seed,
# dock (optional bool).
import math
from bd_kit import (K, Opening, tile, pal, decal, wall, box, rect, lin, Rng, UP, cylinder, gable_roof, plane_poly,
                    quad3, band)
from mathutils import Vector

BAY = 6.0
PITCH = 9.0
PLINTH = 1.2
FOUNDATION = 1.0
DOCK = 3.0
CLAD = ["#9DA3A3", "#8E6B5A", "#7F97A5", "#8FA394", "#D8D6CF", "#B7ABA0"]
ROOF = ["#A7ABA8", "#8F5F4E", "#9EA7A4"]


def plan(spec):
    r = Rng(spec["seed"])
    return {
        "clad": lin(r.pick(CLAD)),
        "roof": lin(r.pick(ROOF)),
        "sign": r.pick(["sign_cannery", "sign_fish"]),
        "doors": 2 if spec["bays"] >= 6 else 1,
        "side_door": r.chance(0.6),
        "dock": spec.get("dock", r.chance(0.4)),
    }


def build(spec, lod):
    p = plan(spec)
    k = K()
    W = spec["bays"] * BAY
    D = float(spec["depth"])
    H = float(spec["eave"])
    x0, x1 = -W / 2, W / 2
    dock = p["dock"]
    yb = DOCK if dock else 0.0
    y1 = yb + D
    sc = 1.0    # one texel density on every LOD: coarse LODs lose cuts, not texels
    clad = tile("corrugated", p["clad"]).scaled(sc).jittered(0.08 if lod < 2 else 0.0)
    conc = tile("concrete", lin("#C9C3B8")).scaled(sc)
    roof_m = tile("corrugated", p["roof"]).scaled(sc).jittered(0.06 if lod < 2 else 0.0)
    shutter = tile("shutter", lin("#C9CCC8")).scaled(sc)
    flash = pal("galvanized")
    dz = 1.2 if dock else 0.0          # door sill height (dock-high doors)

    # --- front gable end (street side): roll-up doors, personnel door, windows, sign
    fo = []
    dw, dh = 4.8, 5.0
    ndoor = p["doors"]
    door_x = [W * (i + 1) / (ndoor + 1) for i in range(ndoor)]
    for c in door_x:
        fo.append(Opening(c - dw / 2, c + dw / 2, dz, dz + dh, shutter, [0.25, 0.15, 0.0][lod]))
    pd_u = 1.4 if door_x[0] - dw / 2 > 3.0 else W - 2.4
    fo.append(Opening(pd_u, pd_u + 1.0, dz, dz + 2.2, decal("door_steel"), 0.08))
    if lod < 2:
        for c in [W * (i + 0.5) / spec["bays"] for i in range(spec["bays"])]:
            if any(abs(c - d) < dw / 2 + 1.2 for d in door_x) or abs(c - (pd_u + 0.5)) < 1.6:
                continue
            fo.append(Opening(c - 1.2, c + 1.2, 2.6, 4.4, decal("win_factory"), 0.1))
    front_wall(k, x0, yb, W, H, fo, clad, conc, p, lod)
    top = H + (W / 2) * math.tan(math.radians(PITCH))

    # --- long sides: clerestory windows per bay, downpipes, an optional side door
    side_ops = []
    nb = int(D / BAY)
    for i in range(nb):
        c = (i + 0.5) * D / nb
        side_ops.append(Opening(c - 1.3, c + 1.3, H - 2.6, H - 0.8, decal("win_factory"), [0.1, 0.06, 0.0][lod]))
    right = list(side_ops)
    if p["side_door"]:
        c = D * 0.35
        right = [o for o in right if abs((o.u0 + o.u1) / 2 - c) > 3.0 or o.v0 > 5.5]
        right.append(Opening(c - 2.0, c + 2.0, 0.0, 4.2, shutter, [0.2, 0.12, 0.0][lod]))
    side_wall(k, (x1, yb, 0), (0, 1, 0), D, H, right, clad, conc, lod)
    side_wall(k, (x0, y1, 0), (0, -1, 0), D, H, side_ops, clad, conc, lod)
    # rear gable end
    back = [Opening(W / 2 - 0.5, W / 2 + 0.5, 0.0, 2.2, decal("door_steel"), 0.08)] if lod < 2 else []
    front_wall(k, x1, y1, W, H, back, clad, conc, None, lod, rear=True)

    # --- roof: ridge along y (gables front and back), ridge vent, gutters, downpipes
    gable_roof(k, x0, x1, yb, y1, H, PITCH, 0.35, 0.3, roof_m, 0.12, flash, ridge_axis="y")
    if lod < 2:
        zr = top
        box(k, (-0.45, yb + 1.0, zr - 0.05), (0.45, y1 - 1.0, zr + 0.45), flash, "xXyYZ")        # ridge vent
        box(k, (-0.6, yb + 1.0, zr + 0.45), (0.6, y1 - 1.0, zr + 0.55), flash, "xXyYzZ")
        # translucent roof light strips (fibreglass sheets) in every other bay, both slopes
        tan = math.tan(math.radians(PITCH))
        sky = tile("corrugated", lin("#E8E6DC"))
        for i in range(nb):
            if i % 2:
                continue
            ya_, yb_ = yb + D * (i + 0.3) / nb, yb + D * (i + 0.7) / nb
            for sgn in (-1, 1):
                xa_, xb_ = sgn * W * 0.12, sgn * W * 0.32
                za_, zb_ = zr - abs(xa_) * tan + 0.03, zr - abs(xb_) * tan + 0.03
                if sgn > 0:
                    quad3(k, (xb_, ya_, zb_), (xb_, yb_, zb_), (xa_, yb_, za_), (xa_, ya_, za_), sky)
                else:
                    quad3(k, (xb_, yb_, zb_), (xb_, ya_, zb_), (xa_, ya_, za_), (xa_, yb_, za_), sky)
        for x, sgn in ((x0 - 0.35, -1), (x1 + 0.35, 1)):
            zg = H - 0.35 * math.tan(math.radians(PITCH))
            box(k, (x - 0.14 if sgn < 0 else x, yb - 0.3, zg - 0.18), (x if sgn < 0 else x + 0.14, y1 + 0.3, zg - 0.02),
                flash, "xXyYz")                                                                      # gutter
            if lod == 0:
                for i in range(nb + 1):
                    y = yb + D * i / nb
                    y = min(max(y, yb + 0.3), y1 - 0.3)
                    xp = x - 0.07 if sgn < 0 else x + 0.07
                    cylinder(k, (xp, y, 0.0), (xp, y, zg - 0.1), 0.06, 8, flash, cap_top=False)   # downpipe
    # wall lights over the doors, bollards beside the ground-level doors
    if lod < 2:
        for c in door_x:
            lx = x0 + c
            box(k, (lx - 0.18, yb - 0.22, dz + dh + 0.75), (lx + 0.18, yb, dz + dh + 1.0), pal("steel_dark"), "yxXzZ")
            box(k, (lx - 0.14, yb - 0.2, dz + dh + 0.74), (lx + 0.14, yb - 0.02, dz + dh + 0.75), pal("lamp_warm"), "z")
            if not dock and lod == 0:
                for s_ in (-1, 1):
                    bx = lx + s_ * (dw / 2 + 0.5)
                    cylinder(k, (bx, yb - 0.5, 0.0), (bx, yb - 0.5, 1.1), 0.1, 10, pal("safety_yellow"))
    # corner flashings
    if lod < 2:
        for (cx, cy) in ((x0, yb), (x1, yb), (x1, y1), (x0, y1)):
            box(k, (cx - 0.08, cy - 0.08, PLINTH), (cx + 0.08, cy + 0.08, H), flash, "xXyY")

    # --- loading dock along the front
    if dock:
        box(k, (x0, 0.0, -0.5), (x1, yb, dz), conc, "yxXZ")
        if lod < 2:
            for c in door_x:
                for s_ in (-1, 1):
                    bx = x0 + c + s_ * (dw / 2 - 0.3)
                    box(k, (bx - 0.15, -0.14, dz - 0.55), (bx + 0.15, 0.0, dz - 0.05), pal("rubber"), "yxXzZ")   # bumpers
            # steps at one end
            for i in range(4):
                z = dz * (i + 1) / 4
                box(k, (x1 - 1.4, -0.3 * (4 - i), -0.2), (x1 - 0.2, 0.0, z), conc, "yxXZ")
    return k, {"footprint": [x0, x1, 0.0, y1], "height": top + 0.6, "overhang": 1.05, "foundation": FOUNDATION,
               "ao_dist": 3.0, "params": {"dock": bool(dock), "sign": p["sign"]}}


def front_wall(k, xs, y, W, H, ops, clad, conc, p, lod, rear=False):
    """gable end wall: cladding on a concrete plinth band, gable triangle, door frames, canopies, sign"""
    axv = Vector((-1, 0, 0) if rear else (1, 0, 0))
    o = Vector((xs, y, 0))
    n = axv.cross(UP)
    wall(k, o, axv, W, H, clad, ops, s0=xs, v_base=-FOUNDATION)
    band(k, o, axv, W, -FOUNDATION, PLINTH, 0.06, conc, [(q.u0, q.u1) for q in ops if q.v0 < PLINTH], s0=xs)
    half = W / 2
    zr = H + half * math.tan(math.radians(PITCH))
    plane_poly(k, o, axv, UP, [(0, H), (W, H), (half, zr)], clad, xs, 0.0)
    if lod < 2:
        # steel frames around the big doors, canopies over the personnel doors
        for q in ops:
            if q.fill is None:
                continue
            if q.fill.region == "shutter":
                for (u_a, u_b) in ((q.u0 - 0.2, q.u0), (q.u1, q.u1 + 0.2)):
                    box_along(k, o + axv * u_a, axv, u_b - u_a, n, 0.12, q.v0, q.v1 + 0.2, pal("steel_dark"))
                box_along(k, o + axv * (q.u0 - 0.2), axv, q.u1 - q.u0 + 0.4, n, 0.12, q.v1, q.v1 + 0.5, pal("steel_dark"))
            elif q.fill.region == "door_steel":
                box_along(k, o + axv * (q.u0 - 0.3), axv, q.u1 - q.u0 + 0.6, n, 1.0, q.v1 + 0.15, q.v1 + 0.3, pal("galvanized"))
    if p is not None:
        # sign board centred in the gable
        sw = min(8.0, W * 0.45)
        sh = sw / 6.0
        zc = H + 0.25
        box_along(k, o + axv * (half - sw / 2), axv, sw, n, 0.12, zc, zc + sh, pal("steel_dark"))
        rect(k, o + axv * (half - sw / 2) + n * 0.121 + UP * zc, axv, UP, sw, sh, decal(p["sign"]))


def box_along(k, a, ax, length, n, depth, z0, z1, mat):
    """box on a wall: from point a along ax for `length`, `depth` out along n, z0..z1"""
    a = Vector(a)
    p0 = a + UP * z0
    q = p0 + ax * length + n * depth
    lo = [min(p0[i], q[i]) for i in range(3)]
    hi = [max(p0[i], q[i]) for i in range(3)]
    lo[2], hi[2] = z0, z1
    # no face against the wall (hidden, and it would look into the building)
    if abs(n.y) > 0.5:
        against = "y" if n.y > 0 else "Y"
    else:
        against = "x" if n.x > 0 else "X"
    box(k, lo, hi, mat, "xXyYzZ".replace(against, ""))


def side_wall(k, o, ax, L, H, ops, clad, conc, lod):
    o, axv = Vector(o), Vector(ax)
    wall(k, o, axv, L, H, clad, ops, s0=0.0, v_base=-FOUNDATION)
    band(k, o, axv, L, -FOUNDATION, PLINTH, 0.06, conc, [(q.u0, q.u1) for q in ops if q.v0 < PLINTH])


def render(objs, R, out_dir, tag):
    import os
    so, mp, info = R.setup()
    R.slab("yard", -120, 120, -60, 80, 0.0, R.ground_mat("asphalt", 3.0, (0.9, 0.9, 0.9)))
    R.aim_sun(so, mp, info, -40, 30)
    x = -70.0
    for pid in objs:
        o = objs[pid][0]
        xs = [v.co.x for v in o.data.vertices]
        W = max(xs) - min(xs)
        R.place(o, pid + "_r", (x + W / 2, 0.0, 0.0))
        x += W + 10.0
    R.shoot(os.path.join(out_dir, "industrial_street_%s.png" % tag), (-75, -30, 1.7), (-30, 10, 5.0), lens=24)
    R.shoot(os.path.join(out_dir, "industrial_front_%s.png" % tag), (-50, -38, 5.0), (-50, 10, 5.0), lens=30)
    R.shoot(os.path.join(out_dir, "industrial_aerial_%s.png" % tag), (-60, -80, 55), (10, 20, 0), lens=30)
