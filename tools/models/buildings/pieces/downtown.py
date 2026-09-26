# Downtown commercial block (Main Street of a 1920s-60s California beach town): 1-3 storeys,
# shop fronts in every bay of the ground floor with sign boards and canvas awnings, a flat gravel
# roof with air conditioning units behind a parapet. Four styles (`style`):
#   brick    brick upper floors, double-hung windows, cornice (the few older blocks),
#   stucco   tinted stucco, moulded window surrounds, cornice,
#   mission  Mission / Spanish Colonial Revival: lime-white stucco, arched upper windows and
#            door, a clay tile pent roof (visor) along the parapet, a curved central parapet,
#   deco     Art Deco / Streamline Moderne: pastel stucco, pilaster fins at the bay lines that
#            rise above a stepped central parapet, three speed lines under the coping.
# Built in 4 m bays; party walls are plain (the lots form a closed row), a corner building
# (`corner`: true) turns its front round both corners: a shop window at the front of each side
# and the upper windows along both sides (the map puts it at either end of a row).
#
# Params (kit.json): bays (2-6), floors (1-3), depth (m), seed, style, corner (optional).
import math
from bd_kit import (K, Opening, tile, pal, decal, wall, box, prism, rect, lin, mul, Rng, WHITE, beam,
                    quad3, tri3, cylinder, plane_poly, UP)
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

STYLES = ("brick", "stucco", "mission", "deco")
STUCCO_TINTS = ["#F1E2CA", "#E8CFA8", "#EDC8B0", "#D3DCC6", "#CFD9DD", "#F2EDE3", "#E3BF96", "#DDB9A6"]
MISSION_TINTS = ["#F3ECDF", "#EFE4CF", "#F2E2CB", "#EAE0CF"]           # lime-washed whites, creams
DECO_TINTS = ["#F2E7DA", "#EDD5CC", "#D8E6DC", "#EADFC6", "#DAE4EA"]   # pastels
DECO_ACCENTS = ["#7FA8A2", "#C98A72", "#93AABD", "#BFA77E"]
# (shop front, sign): the four fronts of kit_storefronts carry 13 trades (fronts without lettering)
SHOPS = [("shop_bakery", "sign_bakery"), ("shop_hardware", "sign_hardware"), ("shop_books", "sign_books"),
         ("shop_bakery", "sign_coffee"), ("shop_bakery", "sign_taqueria"), ("shop_bakery", "sign_icecream"),
         ("shop_hardware", "sign_cycles"), ("shop_books", "sign_realty"), ("shop_surf", "sign_tackle"),
         ("shop_surf", "sign_surf"), ("shop_bakery", "sign_diner")]
AWNINGS = ["awning_red", "awning_green", "awning_blue", "awning_tan"]


def plan(spec):
    """variant choices of one building (deterministic from the seed)"""
    r = Rng(spec["seed"])
    bays = spec["bays"]
    style = spec.get("style", "brick")
    if style not in STYLES:
        raise ValueError("downtown style %s" % style)
    brick = style == "brick"
    tint = lin(r.pick({"mission": MISSION_TINTS, "deco": DECO_TINTS}.get(style, STUCCO_TINTS)))
    # shops: 1 or 2 bays each
    shops = []
    b = 0
    # a street door to the upper floors takes one bay of the wider buildings
    entrance = int(r.next() * bays) if (bays >= 4 and spec["floors"] >= 2 and r.chance(0.6)) else -1
    last = None
    last_front = None
    while b < bays:
        if b == entrance:
            shops.append({"bay0": b, "bays": 1, "entrance": True})
            b += 1
            continue
        span = 2 if (bays - b >= 2 and b + 1 != entrance and r.chance(0.45)) else 1
        # neighbours differ in front and sign
        kind = r.pick([s_ for s_ in SHOPS if s_[0] != last_front and s_[1] != last])
        last_front, last = kind
        shops.append({"bay0": b, "bays": span, "front": kind[0], "sign": kind[1],
                      "awning": r.pick(AWNINGS) if r.chance(0.7) else None})
        b += span
    return {
        "style": style,
        "brick": brick,
        "tint": tint,
        "trim_tint": lin("#E9DFCB") if brick else mul(tint, 0.96 if style == "mission" else 1.04),
        "accent": lin(r.pick(DECO_ACCENTS)),
        "window": {"mission": "win_arched", "deco": r.pick(["win_blind", "win_casement"])}.get(
            style, r.pick(["win_sash", "win_sash", "win_blind"])),
        "surrounds": style == "stucco" and r.chance(0.75),
        "pair": r.chance(0.7),
        "cornice": r.pick(["deep", "flat", "deep"]) if style in ("brick", "stucco") else None,
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
    sc = 1.0    # one texel density on every LOD: coarse LODs lose cuts, not texels
    wall_mat = (tile("brick", mul(WHITE, 0.97)) if p["brick"] else tile("stucco", p["tint"])).scaled(sc)
    trim = tile("concrete", p["trim_tint"]).scaled(sc) if p["brick"] else tile("stucco", p["trim_tint"]).scaled(sc)
    depth_shop = [0.32, 0.18, 0.0][lod]
    depth_win = [0.16, 0.1, 0.0][lod]
    style = p["style"]
    arched = style == "mission"
    segs = [10, 6, 4][lod]            # arch segments

    # --- front wall with shop fronts and windows
    front = []
    for s in p["shops"]:
        if s.get("entrance"):
            u = s["bay0"] * BAY + BAY / 2
            if arched:
                front.append(Opening(u - 0.6, u + 0.6, 0.12, 2.6, decal("door_arched"), depth_shop, arch=True))
            else:
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
            h_ = WIN_H + (0.2 if arched else 0.0)
            for c in centres:
                upper_windows.append((c - w_ / 2, c + w_ / 2, z + SILL, z + SILL + h_))
    for (u0, u1, v0, v1) in upper_windows:
        front.append(Opening(u0, u1, v0, v1, win, depth_win, arch=arched))
    wall(k, (x0, 0, 0), (1, 0, 0), W, H, wall_mat, front, s0=0.0, v_base=-FOUNDATION, arch_segs=segs)
    # side (party) walls and the rear wall; a corner building's sides get a shop window at the
    # front (the front of the shop next to that corner) and the upper windows, measured from the
    # front on both sides. Only LOD0 (the desktop up close): LOD1 is what the phones draw near, and
    # the corners at every row's end would put a Main Street view over the phone tier's triangle
    # budget (docs/phase-3-design.md 10).
    def side_openings(shop, east):
        out = []
        if not (spec.get("corner") and lod == 0):
            return out
        if lod == 0:
            front_of = shop.get("front") or next(s_["front"] for s_ in p["shops"] if s_.get("front"))
            out.append((0.45, 0.45 + SHOP_W, 0.02, SHOP_H, decal(front_of), depth_shop, False))
        for f in range(1, floors):
            z = GROUND + UPPER * (f - 1)
            for c in [1.2 + i * 2.6 for i in range(int((D - 1.5) // 2.6))]:
                out.append((c, c + WIN_W, z + SILL, z + SILL + WIN_H, win, depth_win, arched))
        return out
    # +X side: runs from the front (u from the front); -X side: from the back (u = D - ...)
    east = [Opening(a, b, v0, v1, d, dp, arch=ar) for (a, b, v0, v1, d, dp, ar) in side_openings(p["shops"][-1], True)]
    west = [Opening(D - b, D - a, v0, v1, d, dp, arch=ar) for (a, b, v0, v1, d, dp, ar) in side_openings(p["shops"][0], False)]
    wall(k, (x1, 0, 0), (0, 1, 0), D, H, wall_mat, east, s0=W, v_base=-FOUNDATION, arch_segs=segs)
    wall(k, (x0, D, 0), (0, -1, 0), D, H, wall_mat, west, s0=2 * W + D, v_base=-FOUNDATION, arch_segs=segs)
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
                if not arched:
                    box(k, (u - 0.75, -0.12, 2.45), (u + 0.75, 0.0, 2.75), trim, "yxXzZ")        # door head
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
            if style in ("brick", "stucco"):
                box(k, (x0 + u0 - 0.08, -0.04, v1), (x0 + u1 + 0.08, 0.0, v1 + 0.22), trim, "yxXzZ")  # lintel
            if p["surrounds"]:
                # flat moulded surround (jambs) of the stucco fronts
                box(k, (x0 + u0 - 0.1, -0.035, v0), (x0 + u0, 0.0, v1), trim, "yxXZ")
                box(k, (x0 + u1, -0.035, v0), (x0 + u1 + 0.1, 0.0, v1), trim, "yxXZ")
    if lod == 0 and p["cornice"]:
        if p["cornice"] == "deep":
            prof = [(0, 0.6), (-0.42, 0.6), (-0.42, 0.5), (-0.32, 0.46), (-0.3, 0.32), (-0.18, 0.28),
                    (-0.12, 0.14), (-0.06, 0.1), (-0.06, 0.0), (0, 0)]
        else:
            prof = [(0, 0.4), (-0.22, 0.4), (-0.22, 0.28), (-0.1, 0.22), (-0.1, 0.0), (0, 0)]
        zc = H - 0.95
        prism(k, [(x0 - 0.02, 0, zc), (x1 + 0.02, 0, zc)], [(w, h) for (w, h) in prof], trim)
        # frieze band under the cornice
        box(k, (x0, -0.03, zc - 0.35), (x1, 0.0, zc - 0.2), trim, "yzZ")
    elif lod == 1 and p["cornice"]:
        box(k, (x0 - 0.02, -0.3, H - 0.95), (x1 + 0.02, 0.0, H - 0.5), trim, "yxXzZ")
    if style == "mission":
        mission_top(k, x0, x1, H, W, wall_mat, trim, lod)
    elif style == "deco":
        deco_top(k, x0, x1, H, W, spec["bays"], wall_mat, tile("stucco", p["accent"]), lod)

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
               "params": {"style": style, "shops": [s.get("sign", "entrance") for s in p["shops"]]}}


PANEL_T = 0.3       # parapet thickness (the roof deck starts behind it)
VISOR_OUT, VISOR_PITCH = 0.75, 24.0


def mission_top(k, x0, x1, H, W, wall_mat, trim, lod):
    """Mission Revival parapet: a clay tile pent roof (visor) along the whole front just under the
    coping, and a curved panel (circular arc on short shoulders) over the middle of the front."""
    roof = tile("roof_tiles", mul(WHITE, 0.95))
    zt = H - 0.12
    drop = VISOR_OUT * math.tan(math.radians(VISOR_PITCH))
    xa, xb = x0 + 0.02, x1 - 0.02
    tl, tr = Vector((xa, 0.0, zt)), Vector((xb, 0.0, zt))
    el, er = Vector((xa, -VISOR_OUT, zt - drop)), Vector((xb, -VISOR_OUT, zt - drop))
    th = Vector((0, 0, -0.1))
    quad3(k, el, er, tr, tl, roof)                               # tiles, s along the eave, t up
    quad3(k, el + th, er + th, er, el, trim)                     # fascia
    if lod < 2:
        quad3(k, el + th, tl + th, tr + th, er + th, trim)       # soffit
        quad3(k, tl, tl + th, el + th, el, trim)                 # end cheeks
        quad3(k, tr, er, er + th, tr + th, trim)
    # curved centre panel standing on the parapet
    cx = (x0 + x1) / 2
    half = min(W / 2 - 0.8, max(1.6, 0.23 * W))
    sh, crown = 0.35, (0.9 if W < 10 else 1.3)
    sag = crown - sh
    R = (half * half + sag * sag) / (2 * sag)
    zc = H + crown - R
    n = [12, 8, 4][lod]
    a0 = math.asin(half / R)
    arc = [(cx + R * math.sin(a0 - 2 * a0 * i / n), zc + R * math.cos(a0 - 2 * a0 * i / n)) for i in range(n + 1)]
    outline = [(cx - half, H), (cx + half, H)] + arc             # CCW seen from the street
    plane_poly(k, (x0, 0, 0), (1, 0, 0), UP, [(x - x0, z) for x, z in outline], wall_mat)
    plane_poly(k, (x0, PANEL_T, 0), (-1, 0, 0), UP, [(x0 - x, z) for x, z in reversed(outline)], wall_mat)
    T = Vector((0, PANEL_T, 0))
    for i in range(1, len(outline)):
        p_ = Vector((outline[i][0], 0.0, outline[i][1]))
        q_ = Vector((outline[(i + 1) % len(outline)][0], 0.0, outline[(i + 1) % len(outline)][1]))
        if i == len(outline) - 1:
            q_ = Vector((outline[0][0], 0.0, outline[0][1]))
        quad3(k, p_, p_ + T, q_ + T, q_, wall_mat)
    if lod < 2:
        # coping along the arc
        for i in range(len(arc) - 1):
            a_ = Vector((arc[i][0], PANEL_T / 2, arc[i][1] + 0.04))
            b_ = Vector((arc[i + 1][0], PANEL_T / 2, arc[i + 1][1] + 0.04))
            beam(k, a_, b_, PANEL_T + 0.1, 0.08, trim, faces="yYzZ")


def deco_top(k, x0, x1, H, W, bays, wall_mat, accent, lod):
    """Art Deco / Streamline front: a stepped central parapet, pilaster fins at the bay lines that
    rise above it, three speed lines under the coping."""
    cx = (x0 + x1) / 2
    cap = tile("concrete", lin("#CFC8BA"))
    steps = [(min(W / 2 - 0.8, 3.0), 0.6)]
    if W >= 10:
        steps.append((min(steps[0][0] - 0.8, 1.6), 1.2))
    for half, rise in steps:
        box(k, (cx - half, 0.0, H), (cx + half, PANEL_T, H + rise), wall_mat, "yYxXZ")
        box(k, (cx - half - 0.05, -0.05, H + rise), (cx + half + 0.05, PANEL_T + 0.05, H + rise + 0.08), cap,
            "yYxXZ")
    for b in range(bays + 1):
        u = x0 + b * BAY
        ua, ub = max(x0, u - 0.15), min(x1, u + 0.15)
        top = H + 0.45
        for half, rise in steps:
            if cx - half - 0.01 <= u <= cx + half + 0.01:
                top = H + rise + 0.45
        # below the coping the fin stands on the wall; above it, it reaches back over the parapet
        if lod < 2:
            box(k, (ua, -0.25, GROUND), (ub, 0.0, H), accent, "yxXz")
            box(k, (ua, -0.25, H), (ub, PANEL_T, top), accent, "yYxXZ")
        else:
            box(k, (ua, -0.25, H - 0.6), (ub, PANEL_T, top), accent, "yxXzZ")     # far: the silhouette
    if lod < 2:
        for i in range(3):
            z = H - 0.34 - 0.16 * i
            box(k, (x0, -0.04, z), (x1, 0.0, z + 0.06), accent, "yzZ")


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
    name = "revival" if next(iter(objs)).startswith("revival") else "downtown"
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
    R.shoot(os.path.join(out_dir, "%s_street_%s.png" % (name, tag)), (-30, -12.5, 1.7), (2, 0, 5.5), lens=24)
    R.shoot(os.path.join(out_dir, "%s_front_%s.png" % (name, tag)), (4, -30, 5.0), (4, 0, 5.5), lens=32)
    R.shoot(os.path.join(out_dir, "%s_aerial_%s.png" % (name, tag)), (-40, -48, 34), (0, 8, 0), lens=30)
    R.shoot(os.path.join(out_dir, "%s_close_%s.png" % (name, tag)), (-38, -5.5, 1.6), (-44, 0, 3.4), lens=28)
