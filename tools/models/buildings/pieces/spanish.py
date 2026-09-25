# Spanish Revival house (Seaview Heights, 1920s-60s California): tinted stucco walls on a darker
# plinth, low clay barrel-tile roof (gable or hip) with exposed rafter tails, a recessed arched
# entry porch with a plank door, a big arched picture window, casement windows with wrought-iron
# grilles and tile sills, clay vent pipes in the gables, a stucco chimney and an optional garage.
# The L plan adds a front-gabled wing that projects 3.5 m towards the street.
#
# Params (kit.json): width (m), depth (m), floors (1-2), plan ("rect" | "L"), seed,
# garage (optional bool).
import math
from bd_kit import (K, Opening, tile, pal, decal, wall, box, lin, mul, Rng, WHITE, UP, beam, cylinder,
                    gable_roof, gable_end, hip_roof, plane_poly, quad3)
from mathutils import Vector

STOREY = 3.0
PLINTH = 0.35          # floor level above the ground
FOUNDATION = 1.0
WING = 3.5             # projection of the L wing
PITCH = 21.0
TINTS = ["#F4EEE2", "#F1E4CC", "#EFD8BC", "#F2DCC8", "#E7CFAE", "#EFD2C2", "#E3D9C2", "#F3E6C4"]


def plan(spec):
    r = Rng(spec["seed"])
    W = float(spec["width"])
    return {
        "tint": lin(r.pick(TINTS)),
        "roof": "hip" if (spec.get("plan", "rect") == "rect" and r.chance(0.4)) else "gable",
        "wing_left": r.chance(0.5),
        "garage": spec.get("garage", W >= 13 and r.chance(0.6)),
        "garage_left": r.chance(0.5),
        "grilles": r.chance(0.7),
        "balcony": spec["floors"] >= 2 and r.chance(0.7),
        "roof_tint": mul(WHITE, r.uniform(0.9, 1.02)),
    }


def eave_z(spec):
    return PLINTH + STOREY * spec["floors"]


def build(spec, lod):
    p = plan(spec)
    k = K()
    W, D = float(spec["width"]), float(spec["depth"])
    floors = spec["floors"]
    L = spec.get("plan", "rect") == "L"
    x0, x1 = -W / 2, W / 2
    yb = WING if L else 0.0              # front of the main block
    y1 = yb + D
    ze = eave_z(spec)
    sc = [1.0, 1.0, 2.0][lod]
    stucco = tile("stucco", p["tint"]).scaled(sc)
    plinth = tile("stucco", mul(p["tint"], 0.78)).scaled(sc)
    roof = tile("roof_tiles", p["roof_tint"]).scaled(sc)
    eave = pal("wood_brown")
    dwin = [0.14, 0.09, 0.0][lod]
    win = decal("win_casement")

    # wing geometry (x range)
    ww = min(5.2, W * 0.42)
    if L:
        wx0, wx1 = (x0, x0 + ww) if p["wing_left"] else (x1 - ww, x1)
    else:
        wx0 = wx1 = None

    # --- front openings of the main block
    def row_windows(u_from, u_to, z_sill, h, avoid=()):
        """evenly spaced casements between u_from and u_to, skipping ranges in `avoid`"""
        out = []
        n = max(1, int((u_to - u_from) / 2.8))
        for i in range(n):
            c = u_from + (i + 0.5) * (u_to - u_from) / n
            if any(a - 0.8 < c < b + 0.8 for a, b in avoid):
                continue
            out.append((c - 0.55, c + 0.55, z_sill, z_sill + h))
        return out

    front_segments = []   # (origin x, length) of main front wall pieces facing the street
    if L:
        if p["wing_left"]:
            front_segments.append((wx1, x1 - wx1))
        else:
            front_segments.append((x0, wx0 - x0))
    else:
        front_segments.append((x0, W))

    # entry porch and garage placement on the (first) main front segment
    fx, fl = front_segments[0]
    entry_u = fl * (0.3 if (L and not p["wing_left"]) else 0.7) if not p["garage"] else None
    garage_u = None
    if p["garage"]:
        garage_u = 0.6 if p["garage_left"] else fl - 3.4
        entry_u = fl - 2.2 if p["garage_left"] else 2.2
        if L:
            entry_u = fl / 2 if fl < 7 else entry_u
    openings = []
    details = []          # (kind, u0, u1, v0, v1) on the front
    porch = None
    if entry_u is not None:
        porch = (entry_u - 0.95, entry_u + 0.95)
        openings.append(Opening(porch[0], porch[1], PLINTH, PLINTH + 2.75, None if lod < 2 else decal("door_arched"),
                                [1.1, 0.6, 0.0][lod], arch=True, floor=False))
    if garage_u is not None:
        openings.append(Opening(garage_u, garage_u + 2.8, 0.0, 2.3, tile("deck", lin("#B98B5E")).scaled(sc), [0.12, 0.08, 0.0][lod]))
    avoid = [porch] if porch else []
    if garage_u is not None:
        avoid.append((garage_u, garage_u + 2.8))
    if not L:
        # the big arched picture window on the plain front
        au = fl * 0.25 if (entry_u or 0) > fl / 2 else fl * 0.72
        if garage_u is None or not (garage_u - 1.2 < au < garage_u + 4.0):
            openings.append(Opening(au - 0.9, au + 0.9, PLINTH + 0.5, PLINTH + 2.9, decal("win_arched"), dwin, arch=True))
            avoid.append((au - 0.9, au + 0.9))
    for (u0, u1, v0, v1) in row_windows(0.6, fl - 0.6, PLINTH + 0.95, 1.35, avoid):
        openings.append(Opening(u0, u1, v0, v1, win, dwin))
        details.append(("win", u0, u1, v0, v1))
    up_windows = []
    if floors >= 2:
        for (u0, u1, v0, v1) in row_windows(0.6, fl - 0.6, PLINTH + STOREY + 0.8, 1.45):
            openings.append(Opening(u0, u1, v0, v1, win, dwin))
            up_windows.append((u0, u1, v0, v1))
    wall(k, (fx, yb, 0), (1, 0, 0), fl, ze, stucco, openings, s0=fx, v_base=-FOUNDATION)
    fronts = [(fx, yb, fl, openings, details, up_windows)]

    # --- porch back wall with the arched door, porch floor
    if porch and lod < 2:
        pd = [1.1, 0.6][lod]
        wall(k, (fx + porch[0], yb + pd, 0), (1, 0, 0), porch[1] - porch[0], PLINTH + 2.8, stucco,
             [Opening(0.35, 1.55, PLINTH, PLINTH + 2.3, decal("door_arched"), 0.05, arch=True)], s0=fx + porch[0])
        box(k, (fx + porch[0], yb, -0.1), (fx + porch[1], yb + pd + 0.01, PLINTH), pal("terracotta"), "Z")
    if porch and lod == 0:
        # wrought-iron wall lantern beside the porch arch
        lx = fx + porch[1] + 0.35
        box(k, (lx - 0.04, yb - 0.12, PLINTH + 1.9), (lx + 0.04, yb, PLINTH + 1.98), pal("iron"), "yxXzZ")
        box(k, (lx - 0.1, yb - 0.3, PLINTH + 1.6), (lx + 0.1, yb - 0.1, PLINTH + 1.95), pal("iron"), "yxXYzZ")
        box(k, (lx - 0.08, yb - 0.31, PLINTH + 1.64), (lx + 0.08, yb - 0.29, PLINTH + 1.9), pal("lamp_warm"), "y")
    if porch:
        # steps in front of the porch
        box(k, (fx + porch[0] - 0.1, yb - 0.35, -0.2), (fx + porch[1] + 0.1, yb, PLINTH * 0.5), pal("terracotta"), "yxXZ")

    # --- the L wing: gable front with the picture window
    if L:
        wo = []
        au = ww / 2
        wo.append(Opening(au - 0.9, au + 0.9, PLINTH + 0.5, PLINTH + 2.9, decal("win_arched"), dwin, arch=True))
        if floors >= 2:
            wo.append(Opening(au - 0.55, au + 0.55, PLINTH + STOREY + 0.8, PLINTH + STOREY + 2.25, win, dwin))
        wall(k, (wx0, 0, 0), (1, 0, 0), ww, ze, stucco, wo, s0=wx0, v_base=-FOUNDATION)
        # wing gable triangle (ridge along y)
        half = ww / 2
        zr = ze + half * math.tan(math.radians(PITCH))
        plane_poly(k, (wx0, 0, 0), (1, 0, 0), UP, [(0, ze), (ww, ze), (half, zr)], stucco, wx0, 0.0)
        # inner side wall of the wing (faces the rest of the front)
        if p["wing_left"]:
            wall(k, (wx1, 0, 0), (0, 1, 0), WING, ze, stucco,
                 [Opening(1.2, 2.3, PLINTH + 0.95, PLINTH + 2.3, win, dwin)] if lod < 2 else [], s0=wx1, v_base=-FOUNDATION)
        else:
            wall(k, (wx0, WING, 0), (0, -1, 0), WING, ze, stucco,
                 [Opening(1.2, 2.3, PLINTH + 0.95, PLINTH + 2.3, win, dwin)] if lod < 2 else [], s0=wx0, v_base=-FOUNDATION)
        gable_roof(k, wx0, wx1, 0.0, yb + D * 0.45, ze, PITCH, 0.28, 0.25, roof, [0.16, 0.16, 0.12][lod],
                   eave, ridge_axis="y", ridge_cap=pal("terracotta") if lod < 2 else None)
        fronts.append((wx0, 0.0, ww, wo, [], []))
        if lod == 0:
            gable_vents(k, wx0 + half, -0.02, ze + 0.55, (1, 0, 0))

    # --- side and back walls
    left_len = y1 - (0.0 if (L and p["wing_left"]) else yb)
    right_len = y1 - (0.0 if (L and not p["wing_left"]) else yb)
    ly0 = y1 - left_len
    ry0 = y1 - right_len
    def side_openings(length, y_from):
        out = []
        if lod == 2:
            return out
        n = max(1, int(length / 4.0))
        for i in range(n):
            c = (i + 0.5) * length / n
            out.append(Opening(c - 0.5, c + 0.5, PLINTH + 1.0, PLINTH + 2.3, win, dwin))
            if floors >= 2:
                out.append(Opening(c - 0.5, c + 0.5, PLINTH + STOREY + 0.9, PLINTH + STOREY + 2.2, win, dwin))
        return out
    wall(k, (x1, ry0, 0), (0, 1, 0), right_len, ze, stucco, side_openings(right_len, ry0), s0=x1, v_base=-FOUNDATION)
    wall(k, (x0, y1, 0), (0, -1, 0), left_len, ze, stucco, side_openings(left_len, ly0), s0=x0, v_base=-FOUNDATION)
    back = []
    if lod < 2:
        back.append(Opening(W * 0.3 - 0.5, W * 0.3 + 0.5, PLINTH, PLINTH + 2.15, decal("door_panel"), 0.08))
        for c in (W * 0.6, W * 0.82):
            back.append(Opening(c - 0.55, c + 0.55, PLINTH + 1.0, PLINTH + 2.3, win, dwin))
        if floors >= 2:
            for c in (W * 0.25, W * 0.55, W * 0.8):
                back.append(Opening(c - 0.55, c + 0.55, PLINTH + STOREY + 0.9, PLINTH + STOREY + 2.2, win, dwin))
    wall(k, (x1, y1, 0), (-1, 0, 0), W, ze, stucco, back, s0=x1, v_base=-FOUNDATION)

    # --- main roof
    if p["roof"] == "hip":
        hip_roof(k, x0, x1, yb, y1, ze, PITCH, 0.35, roof, eave, [0.16, 0.16, 0.12][lod],
                 ridge_cap=pal("terracotta") if lod < 2 else None)
        top = ze + (min(W, D) / 2 + 0.35) * math.tan(math.radians(PITCH))
    else:
        top = gable_roof(k, x0, x1, yb, y1, ze, PITCH, 0.35, 0.25, roof, [0.16, 0.16, 0.12][lod], eave,
                         ridge_cap=pal("terracotta") if lod < 2 else None)
        gable_end(k, x1, yb, y1, ze, PITCH, stucco, +1, s0=0.0)
        gable_end(k, x0, yb, y1, ze, PITCH, stucco, -1, s0=0.0)
        if lod == 0:
            gable_vents(k, x1 + 0.02, (yb + y1) / 2, ze + 0.6, (0, 1, 0))
            gable_vents(k, x0 - 0.02, (yb + y1) / 2, ze + 0.6, (0, -1, 0))

    # --- plinth band (darker stucco, slightly proud)
    if lod < 2:
        pb = 0.03
        for (o, ax, L_) in _perimeter(x0, x1, yb, y1, L, wx0, wx1, p["wing_left"]):
            gaps = []
            if abs(o[1] - yb) < 1e-6 and ax == (1, 0, 0) and abs(o[0] - fx) < 1e-6:
                gaps = [g for g in (porch, (garage_u, garage_u + 2.8) if garage_u is not None else None) if g]
            _plinth(k, o, ax, L_, pb, plinth, gaps)

    # --- raised stucco surround of the arched picture window(s)
    if lod == 0:
        for (fx_, fy_, fl_, ops, det, upw) in fronts:
            for op in ops:
                if op.arch and op.fill is not None and op.fill.region == "win_arched":
                    arch_surround(k, Vector((fx_, fy_, 0)), op, mul(p["tint"], 1.03))

    # --- details: tile sills, grilles, rafter tails, chimney, balcony
    if lod < 2:
        for (fx_, fy_, fl_, ops, det, upw) in fronts:
            for op in ops:
                if op.fill is not None and op.fill.region == "win_casement":
                    box(k, (fx_ + op.u0 - 0.08, fy_ - 0.07, op.v0 - 0.06), (fx_ + op.u1 + 0.08, fy_, op.v0), pal("terracotta"), "yxXZ")
                    if lod == 0 and p["grilles"] and op.v0 < PLINTH + STOREY:
                        grille(k, fx_ + op.u0, fx_ + op.u1, fy_ - 0.09, op.v0, op.v1)
    if lod == 0:
        rafter_tails(k, x0, x1, yb - 0.02, ze, -1, skip=(wx0, wx1) if L else None)
        rafter_tails(k, x0, x1, y1 + 0.02, ze, +1)
    ch_x = x1 - 0.2 if p["garage_left"] else x0 - 0.7
    chimney(k, ch_x, yb + D * 0.62, top + 0.9, stucco, lod)
    if p["balcony"] and lod < 2 and up_windows:
        u0, u1, v0, v1 = up_windows[len(up_windows) // 2]
        balcony(k, fx + u0 - 0.3, fx + u1 + 0.3, yb, v0 - 0.05, lod)
    return k, {"footprint": [x0, x1, 0.0, y1], "height": top + 0.9, "overhang": 0.45, "foundation": FOUNDATION,
               "params": {"roof": p["roof"], "garage": bool(p["garage"])}}


def _perimeter(x0, x1, yb, y1, L, wx0, wx1, wing_left):
    """outer walls as (origin, axis, length), CCW seen from above"""
    out = []
    if L:
        if wing_left:
            out += [((wx0, 0.0, 0), (1, 0, 0), wx1 - wx0), ((wx1, 0.0, 0), (0, 1, 0), yb), ((wx1, yb, 0), (1, 0, 0), x1 - wx1),
                    ((x1, yb, 0), (0, 1, 0), y1 - yb), ((x1, y1, 0), (-1, 0, 0), x1 - x0), ((x0, y1, 0), (0, -1, 0), y1)]
        else:
            out += [((x0, yb, 0), (1, 0, 0), wx0 - x0), ((wx0, yb, 0), (0, -1, 0), yb), ((wx0, 0.0, 0), (1, 0, 0), wx1 - wx0),
                    ((x1, 0.0, 0), (0, 1, 0), y1), ((x1, y1, 0), (-1, 0, 0), x1 - x0), ((x0, y1, 0), (0, -1, 0), y1 - yb)]
    else:
        out += [((x0, yb, 0), (1, 0, 0), x1 - x0), ((x1, yb, 0), (0, 1, 0), y1 - yb), ((x1, y1, 0), (-1, 0, 0), x1 - x0),
                ((x0, y1, 0), (0, -1, 0), y1 - yb)]
    return out


def _plinth(k, o, ax, length, proud, mat, gaps):
    """darker base band up to the floor level, standing `proud` in front of the wall, open at the
    porch and the garage (gaps in wall-local u)"""
    o, ax = Vector(o), Vector(ax)
    n = ax.cross(UP)
    top = PLINTH
    spans = []
    u = -proud
    for a, b in sorted(gaps):
        spans.append((u, a))
        u = b
    spans.append((u, length + proud))
    for s0, s1 in spans:
        if s1 - s0 < 0.05:
            continue
        p0 = o + ax * s0 + n * proud
        wall(k, p0, ax, s1 - s0, top, mat, v_base=-0.2)
        # top ledge
        a, b = p0 + UP * top, p0 + ax * (s1 - s0) + UP * top
        quad3(k, a, b, b - n * proud, a - n * proud, mat)


def arch_surround(k, o, op, tint, w=0.14, proud=0.04):
    """moulded band around an arched opening (jambs and arch), standing proud of the wall"""
    m = tile("stucco", tint)
    n = Vector((0, -1, 0))
    outer = Opening(op.u0 - w, op.u1 + w, op.v0, op.v1 + w, arch=True)
    a_in = [(op.u0, op.v0)] + op.arc(10) + [(op.u1, op.v0)]
    a_out = [(outer.u0, op.v0)] + outer.arc(10) + [(outer.u1, op.v0)]
    X = Vector((1, 0, 0))
    for i in range(len(a_in) - 1):
        pi0, pi1 = a_in[i], a_in[i + 1]
        po0, po1 = a_out[i], a_out[i + 1]
        P = lambda uv, d=0.0: o + X * uv[0] + UP * uv[1] + n * d
        # front face of the band (between the outer and the inner outline) and its outer edge
        quad3(k, P(po0, proud), P(pi0, proud), P(pi1, proud), P(po1, proud), m)
        quad3(k, P(po0, 0.0), P(po0, proud), P(po1, proud), P(po1, 0.0), m)
    # sill below the arched window
    box(k, (o.x + op.u0 - w - 0.05, o.y - 0.08, op.v0 - 0.08), (o.x + op.u1 + w + 0.05, o.y, op.v0), pal("terracotta"), "yxXZz")


def grille(k, u0, u1, y, v0, v1):
    """wrought-iron window grille: vertical bars and two rails"""
    iron = pal("iron")
    n = max(3, int((u1 - u0) / 0.14))
    for i in range(1, n):
        x = u0 + (u1 - u0) * i / n
        box(k, (x - 0.012, y - 0.012, v0 + 0.02), (x + 0.012, y + 0.012, v1 - 0.02), iron, "yxXY")
    for z in (v0 + 0.25, v1 - 0.25):
        box(k, (u0 - 0.03, y - 0.015, z - 0.015), (u1 + 0.03, y + 0.015, z + 0.015), iron, "yYzZ")


def rafter_tails(k, x0, x1, y, ze, side, skip=None):
    """exposed rafter tails under the eave every 0.6 m (side -1: front, +1: back)"""
    wood = pal("wood_brown")
    n = int((x1 - x0) / 0.6)
    for i in range(n + 1):
        x = x0 + (x1 - x0) * i / n
        if skip and skip[0] - 0.1 < x < skip[1] + 0.1:
            continue
        a = Vector((x, y, ze - 0.02))
        b = Vector((x, y + side * 0.3, ze - 0.02 - 0.3 * math.tan(math.radians(PITCH))))
        beam(k, a, b, 0.07, 0.12, wood, faces="yYzZX")


def gable_vents(k, x, y, z, along):
    """three clay pipe vents in a gable (triangle pattern)"""
    ax = Vector(along)
    n = ax.cross(UP)
    t = pal("terracotta")
    for du, dz in ((-0.18, 0.0), (0.18, 0.0), (0.0, 0.2)):
        c = Vector((x, y, z)) + ax * du + UP * dz
        cylinder(k, c - n * 0.06, c, 0.065, 8, t, cap_top=True)


def chimney(k, x, y, z_top, mat, lod):
    """stucco chimney against the side wall with a small tiled cap"""
    w, d = 0.9, 0.7
    box(k, (x, y, -0.3), (x + w, y + d, z_top), mat, "xXyYZ")
    if lod < 2:
        box(k, (x - 0.05, y - 0.05, z_top), (x + w + 0.05, y + d + 0.05, z_top + 0.08), mat, "xXyYzZ")
        from bd_kit import hip_roof as _hip
        _hip(k, x + 0.08, x + w - 0.08, y + 0.08, y + d - 0.08, z_top + 0.3, 25, 0.12, pal("terracotta"), pal("terracotta"), 0.05)
        for dx in (0.12, w - 0.24):
            box(k, (x + dx, y + 0.2, z_top + 0.08), (x + dx + 0.12, y + d - 0.2, z_top + 0.3), mat, "xXyY")


def balcony(k, xa, xb, y, z, lod):
    """small cantilevered balcony (0.7 m) with an iron railing"""
    dpt = 0.7
    box(k, (xa, y - dpt, z - 0.15), (xb, y, z), pal("terracotta"), "yxXzZ")
    if lod == 0:
        iron = pal("iron")
        h = 0.95
        for (a, b) in (((xa, y - dpt), (xb, y - dpt)), ((xa, y - dpt), (xa, y)), ((xb, y - dpt), (xb, y))):
            beam(k, (a[0], a[1], z + h), (b[0], b[1], z + h), 0.04, 0.04, iron)
            L = math.hypot(b[0] - a[0], b[1] - a[1])
            n = max(2, int(L / 0.12))
            for i in range(n + 1):
                t = i / n
                px, py = a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
                box(k, (px - 0.01, py - 0.01, z), (px + 0.01, py + 0.01, z + h), iron, "xXyY")
    else:
        box(k, (xa, y - dpt - 0.02, z), (xb, y - dpt + 0.02, z + 0.95), pal("iron"), "yY")


def render(objs, R, out_dir, tag):
    import os
    so, mp, info = R.setup()
    grass = R.ground_mat("grass", 2.0)
    walk = R.ground_mat("sidewalk", 2.5)
    R.slab("road", -80, 80, -60, -4.5, 0.0, R.ground_mat("asphalt", 3.0))
    R.slab("walk", -80, 80, -4.5, -2.5, 0.12, walk)
    R.slab("lawn", -80, 80, -2.5, 60, 0.1, grass)
    R.aim_sun(so, mp, info, -35, 32)
    x = -40.0
    for pid in objs:
        o = objs[pid][0]
        xs = [v.co.x for v in o.data.vertices]
        W = max(xs) - min(xs)
        R.place(o, pid + "_r", (x + W / 2, 4.0, 0.1))
        x += W + 5.0
    R.shoot(os.path.join(out_dir, "spanish_street_%s.png" % tag), (-40, -16, 1.7), (-10, 8, 3.5), lens=26)
    R.shoot(os.path.join(out_dir, "spanish_front_%s.png" % tag), (-18, -26, 4.0), (-18, 6, 3.5), lens=35)
    R.shoot(os.path.join(out_dir, "spanish_aerial_%s.png" % tag), (-30, -40, 28), (0, 10, 0), lens=30)
    R.shoot(os.path.join(out_dir, "spanish_close_%s.png" % tag), (-30, -6, 1.7), (-34, 6, 2.6), lens=28)
