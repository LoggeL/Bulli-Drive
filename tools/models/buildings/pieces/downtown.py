# Downtown commercial block (Main Street, 1920s-60s California): 2-3 storeys, shop fronts in
# every bay of the ground floor with sign boards and canvas awnings, brick or tinted stucco
# upper floors with double-hung windows, belt course, cornice and parapet, flat gravel roof with
# air conditioning units. Built in 4 m bays; party walls are plain (the lots form a closed row),
# a corner building (`corner`: true) repeats the upper windows on its +X side.
#
# Params (kit.json): bays (3-6), floors (2-3), depth (m), seed, corner (optional).
from bd_kit import (K, Opening, tile, pal, decal, wall, box, prism, rect, lin, mul, Rng, WHITE, beam,
                    quad3, tri3, cylinder)
from mathutils import Vector

BAY = 4.0
GROUND = 4.4        # ground floor storey height
UPPER = 3.5         # upper storey height
PARAPET = 1.0       # parapet above the roof deck
FOUNDATION = 1.2    # walls reach this far below the ground (sloped lots)
SHOP_W = 3.5        # shop front opening per bay (texture aspect 1.06)
SHOP_H = 3.3
SIGN_H = 0.62
WIN_W, WIN_H, SILL = 1.0, 1.7, 0.9

STUCCO_TINTS = ["#F1E2CA", "#E8CFA8", "#EDC8B0", "#D3DCC6", "#CFD9DD", "#F2EDE3", "#E3BF96", "#DDB9A6"]
SHOPS = [("shop_bakery", "sign_bakery"), ("shop_hardware", "sign_hardware"), ("shop_books", "sign_books")]
AWNINGS = ["awning_red", "awning_green", "awning_blue", "awning_tan"]


def plan(spec):
    """variant choices of one building (deterministic from the seed)"""
    r = Rng(spec["seed"])
    bays = spec["bays"]
    brick = r.chance(0.55)
    tint = lin(r.pick(STUCCO_TINTS))
    # shops: 1 or 2 bays each
    shops = []
    b = 0
    # a street door to the upper floors takes one bay of the wider buildings
    entrance = int(r.next() * bays) if (bays >= 4 and spec["floors"] >= 2 and r.chance(0.6)) else -1
    last = None
    while b < bays:
        if b == entrance:
            shops.append({"bay0": b, "bays": 1, "entrance": True})
            b += 1
            continue
        span = 2 if (bays - b >= 2 and b + 1 != entrance and r.chance(0.45)) else 1
        kind = r.pick([s_ for s_ in SHOPS if s_ != last])      # neighbours differ
        last = kind
        shops.append({"bay0": b, "bays": span, "front": kind[0], "sign": kind[1],
                      "awning": r.pick(AWNINGS) if r.chance(0.7) else None})
        b += span
    return {
        "brick": brick,
        "tint": tint,
        "trim_tint": lin("#E9DFCB") if brick else mul(tint, 1.04),
        "window": r.pick(["win_sash", "win_sash", "win_blind"]),
        "surrounds": (not brick) and r.chance(0.75),
        "pair": r.chance(0.7),
        "cornice": r.pick(["deep", "flat", "deep"]),
        "shops": shops,
        "ac": 1 + int(r.next() * 3),
        "ac_seed": r.next(),
    }


def height(spec):
    return GROUND + UPPER * (spec["floors"] - 1) + PARAPET


def build(spec, lod):
    p = plan(spec)
    k = K()
    W = spec["bays"] * BAY
    D = float(spec["depth"])
    floors = spec["floors"]
    H = height(spec)
    roof_z = H - PARAPET
    x0, x1 = -W / 2, W / 2
    sc = [1.0, 1.0, 2.0][lod]
    wall_mat = (tile("brick", mul(WHITE, 0.97)) if p["brick"] else tile("stucco", p["tint"])).scaled(sc)
    trim = tile("concrete", p["trim_tint"]).scaled(sc) if p["brick"] else tile("stucco", p["trim_tint"]).scaled(sc)
    depth_shop = [0.32, 0.18, 0.0][lod]
    depth_win = [0.16, 0.1, 0.0][lod]

    # --- front wall with shop fronts and windows
    front = []
    for s in p["shops"]:
        if s.get("entrance"):
            u = s["bay0"] * BAY + BAY / 2
            front.append(Opening(u - 0.55, u + 0.55, 0.12, 2.45, decal("door_panel"), depth_shop))
            continue
        for b in range(s["bay0"], s["bay0"] + s["bays"]):
            u = b * BAY + (BAY - SHOP_W) / 2
            front.append(Opening(u, u + SHOP_W, 0.02, SHOP_H, decal(s["front"]), depth_shop))
    win = decal(p["window"])
    upper_windows = []
    for f in range(1, floors):
        z = GROUND + UPPER * (f - 1)
        for b in range(spec["bays"]):
            cx = b * BAY + BAY / 2
            centres = [cx - 0.95, cx + 0.95] if p["pair"] else [cx]
            w_ = WIN_W if p["pair"] else 1.3
            for c in centres:
                upper_windows.append((c - w_ / 2, c + w_ / 2, z + SILL, z + SILL + WIN_H))
    for (u0, u1, v0, v1) in upper_windows:
        front.append(Opening(u0, u1, v0, v1, win, depth_win))
    wall(k, (x0, 0, 0), (1, 0, 0), W, H, wall_mat, front, s0=0.0, v_base=-FOUNDATION)
    # side (party) walls and the rear wall
    side_open = []
    if spec.get("corner") and lod < 2:
        for f in range(1, floors):
            z = GROUND + UPPER * (f - 1)
            for c in [1.2 + i * 2.6 for i in range(int((D - 1.5) // 2.6))]:
                side_open.append(Opening(c, c + WIN_W, z + SILL, z + SILL + WIN_H, win, depth_win))
    wall(k, (x1, 0, 0), (0, 1, 0), D, H, wall_mat, side_open, s0=W, v_base=-FOUNDATION)
    wall(k, (x0, D, 0), (0, -1, 0), D, H, wall_mat, [], s0=2 * W + D, v_base=-FOUNDATION)
    rear = []
    if lod < 2:
        rear.append(Opening(W - 2.4, W - 1.4, 0.0, 2.2, decal("door_steel"), 0.08))
        for f in range(1, floors):
            z = GROUND + UPPER * (f - 1)
            for b in range(spec["bays"]):
                c = b * BAY + BAY / 2
                rear.append(Opening(c - 0.5, c + 0.5, z + SILL + 0.2, z + SILL + 1.5, decal("win_blind"), depth_win * 0.6))
    wall(k, (x1, D, 0), (-1, 0, 0), W, H, wall_mat, rear, s0=W + D, v_base=-FOUNDATION)

    # --- parapet (inner faces + coping) and roof deck
    t = 0.3
    gravel = tile("gravel").scaled(sc)
    rect(k, (x0 + t, t, roof_z), (1, 0, 0), (0, 1, 0), W - 2 * t, D - 2 * t, gravel, x0 + t, t)
    for (o, ax, L) in (((x1 - t, t, roof_z), (-1, 0, 0), W - 2 * t), ((x0 + t, D - t, roof_z), (1, 0, 0), W - 2 * t),
                       ((x0 + t, t, roof_z), (0, 1, 0), D - 2 * t), ((x1 - t, D - t, roof_z), (0, -1, 0), D - 2 * t)):
        # inner parapet faces look into the roof: wall() normal = ax x UP
        wall(k, o, ax, L, PARAPET, wall_mat)
    cap = tile("concrete", lin("#CFC8BA")).scaled(sc)
    ov = 0.05 if lod < 2 else 0.0
    box(k, (x0 - ov, -ov, H), (x1 + ov, t + ov, H + 0.1), cap, "yYZ")
    box(k, (x0 - ov, D - t - ov, H), (x1 + ov, D + ov, H + 0.1), cap, "yYZ")
    box(k, (x0 - ov, t + ov, H), (x0 + t + ov, D - t - ov, H + 0.1), cap, "xXZ")
    box(k, (x1 - t - ov, t + ov, H), (x1 + ov, D - t - ov, H + 0.1), cap, "xXZ")

    # --- shop front details: pilasters, sign boards, awnings
    if lod < 2:
        for b in range(spec["bays"] + 1):
            u = b * BAY
            ua, ub = max(0.0, u - 0.22), min(W, u + 0.22)
            box(k, (x0 + ua, -0.1, -0.2), (x0 + ub, 0.0, GROUND - 0.25), trim, "yxXZ")
        # belt course over the shop fronts
        box(k, (x0 - 0.04, -0.14, GROUND - 0.25), (x1 + 0.04, 0.0, GROUND), trim, "yxXzZ")
    for s in p["shops"]:
        if s.get("entrance"):
            if lod < 2:
                u = x0 + s["bay0"] * BAY + BAY / 2
                box(k, (u - 0.75, -0.12, 2.45), (u + 0.75, 0.0, 2.75), trim, "yxXzZ")            # door head
                box(k, (u - 0.8, -0.3, -0.2), (u + 0.8, 0.0, 0.12), tile("concrete").scaled(sc), "yxXZ")  # step
            continue
        u0 = s["bay0"] * BAY
        u1 = u0 + s["bays"] * BAY
        cx = x0 + (u0 + u1) / 2
        sw = min(3.8, (u1 - u0) - 0.5)
        z0 = SHOP_H + 0.2
        sign = decal(s["sign"])
        # the board hangs in front of the pilasters (they end at the belt course)
        yb = -0.19
        box(k, (cx - sw / 2, yb, z0), (cx + sw / 2, -0.1, z0 + SIGN_H), pal("steel_dark"), "xXzZ")
        rect(k, (cx - sw / 2, yb, z0), (1, 0, 0), (0, 0, 1), sw, SIGN_H, sign)
        if s["awning"] and lod < 2:
            awning(k, x0 + u0 + 0.3, x0 + u1 - 0.3, SHOP_H + 0.12, tile(s["awning"]), lod)

    # --- upper floor window trims
    if lod == 0:
        for (u0, u1, v0, v1) in upper_windows:
            box(k, (x0 + u0 - 0.1, -0.08, v0 - 0.09), (x0 + u1 + 0.1, 0.0, v0), trim, "yxXzZ")        # sill
            box(k, (x0 + u0 - 0.08, -0.04, v1), (x0 + u1 + 0.08, 0.0, v1 + 0.22), trim, "yxXzZ")     # lintel
            if p["surrounds"]:
                # flat moulded surround (jambs) of the stucco fronts
                box(k, (x0 + u0 - 0.1, -0.035, v0), (x0 + u0, 0.0, v1), trim, "yxXZ")
                box(k, (x0 + u1, -0.035, v0), (x0 + u1 + 0.1, 0.0, v1), trim, "yxXZ")
        # cornice
        if p["cornice"] == "deep":
            prof = [(0, 0.6), (-0.42, 0.6), (-0.42, 0.5), (-0.32, 0.46), (-0.3, 0.32), (-0.18, 0.28),
                    (-0.12, 0.14), (-0.06, 0.1), (-0.06, 0.0), (0, 0)]
        else:
            prof = [(0, 0.4), (-0.22, 0.4), (-0.22, 0.28), (-0.1, 0.22), (-0.1, 0.0), (0, 0)]
        zc = H - 0.95
        prism(k, [(x0 - 0.02, 0, zc), (x1 + 0.02, 0, zc)], [(w, h) for (w, h) in prof], trim)
        # frieze band under the cornice
        box(k, (x0, -0.03, zc - 0.35), (x1, 0.0, zc - 0.2), trim, "yzZ")
    elif lod == 1:
        box(k, (x0 - 0.02, -0.3, H - 0.95), (x1 + 0.02, 0.0, H - 0.5), trim, "yxXzZ")

    # --- roof top units
    if lod < 2:
        r = Rng(int(p["ac_seed"] * 1e6))
        for i in range(p["ac"]):
            ax_ = x0 + 2.0 + r.next() * (W - 5.0)
            ay_ = 2.5 + r.next() * (D - 5.5)
            ac_unit(k, ax_, ay_, roof_z, lod)
        if lod == 0:
            box(k, (x1 - 3.2, D - 3.0, roof_z), (x1 - 2.2, D - 2.0, roof_z + 0.6), pal("galvanized"), "xXyYZ")
    return k, {"footprint": [x0, x1, 0.0, D], "height": H + 0.1, "overhang": 1.45, "foundation": FOUNDATION,
               "params": {"brick": p["brick"], "shops": [s.get("front", "entrance") for s in p["shops"]]}}


def awning(k, xa, xb, z_top, fabric, lod):
    """canvas shed awning: slope 1.3 m out and 0.55 m down, 0.25 m valance, closed ends"""
    out, drop, val = 1.3, 0.55, 0.25
    a = Vector((xa, 0.0, z_top))
    b = Vector((xb, 0.0, z_top))
    c = Vector((xb, -out, z_top - drop))
    d = Vector((xa, -out, z_top - drop))
    # top surface (s along the front, t down the slope), underside
    quad3(k, d, c, b, a, fabric)
    quad3(k, a, b, c, d, fabric.with_tint(mul(WHITE, 0.72)))
    # valance front and back
    dv = Vector((0, 0, -val))
    quad3(k, d + dv, c + dv, c, d, fabric)
    quad3(k, c + dv, d + dv, d, c, fabric.with_tint(mul(WHITE, 0.7)))
    if lod == 0:
        # side cheeks (triangles + valance strip) and the steel frame bar under the front edge
        for x, sgn in ((xa, -1), (xb, 1)):
            p0, p1, p2 = Vector((x, 0.0, z_top)), Vector((x, -out, z_top - drop)), Vector((x, 0.0, z_top - drop))
            tri = [p0, p2, p1] if sgn < 0 else [p0, p1, p2]
            tri3(k, tri[0], tri[1], tri[2], fabric)
        beam(k, (xa, -out + 0.03, z_top - drop - 0.02), (xb, -out + 0.03, z_top - drop - 0.02), 0.03, 0.03, pal("iron"))


def ac_unit(k, x, y, z, lod):
    box(k, (x, y, z), (x + 1.3, y + 0.9, z + 0.25), pal("steel_dark"), "xXyYZ")
    box(k, (x + 0.05, y + 0.05, z + 0.25), (x + 1.25, y + 0.85, z + 1.05), pal("galvanized"), "xXyYZ")
    if lod == 0:
        cylinder(k, (x + 0.65, y + 0.45, z + 1.05), (x + 0.65, y + 0.45, z + 1.09), 0.32, 12, pal("rubber"))


def render(objs, R, out_dir, tag):
    """review stills: a Main Street row, a front view, an aerial view and the three LODs"""
    import os
    so, mp, info = R.setup()
    R.street_ground(-80, 90)
    R.aim_sun(so, mp, info, -40, 30)
    x = -52.0
    order = list(objs)
    widths = {}
    for pid in order:
        o = objs[pid][0]
        xs = [v.co.x for v in o.data.vertices]
        widths[pid] = max(xs) - min(xs) - 0.1
    for pid in order:
        W = round(widths[pid] / BAY) * BAY
        R.place(objs[pid][0], pid + "_r", (x + W / 2, 0, 0.15))
        x += W
    R.shoot(os.path.join(out_dir, "downtown_street_%s.png" % tag), (-30, -12.5, 1.7), (2, 0, 5.5), lens=24)
    R.shoot(os.path.join(out_dir, "downtown_front_%s.png" % tag), (4, -30, 5.0), (4, 0, 5.5), lens=32)
    R.shoot(os.path.join(out_dir, "downtown_aerial_%s.png" % tag), (-40, -48, 34), (0, 8, 0), lens=30)
    R.shoot(os.path.join(out_dir, "downtown_close_%s.png" % tag), (-38, -5.5, 1.6), (-44, 0, 3.4), lens=28)
