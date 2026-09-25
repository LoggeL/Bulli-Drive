# Beach house / surf shop (Promenade, beach front): wooden lap siding painted in faded pastels,
# white corner boards and window casings, raised floor on a board skirt, corrugated metal gable
# roof (ridge along the street or gable to the street), a front porch deck with posts, railing,
# steps and a shed roof. The shop variant puts the surf shop front and a sign board on it.
#
# Params (kit.json): width (m), depth (m), floors (1-2), shop (bool), seed.
import math
from bd_kit import (K, Opening, tile, pal, decal, wall, box, rect, lin, mul, Rng, WHITE, UP, beam,
                    gable_roof, gable_end, plane_poly, quad3)
from mathutils import Vector

STOREY = 2.8
FOUNDATION = 0.9
PORCH = 2.4
PITCH = 26.0
SIDING = ["#CFE3D8", "#F0E3AE", "#C6DAE6", "#F1ECE1", "#EDC3B0", "#D9E6C9", "#B9D2D3"]
ROOFS = ["#A4614B", "#A7ABA8", "#76A3A0", "#B8B1A2"]


def plan(spec):
    r = Rng(spec["seed"])
    return {
        "siding": lin(r.pick(SIDING)),
        "roof": lin(r.pick(ROOFS)),
        "front_gable": r.chance(0.55),
        "window": r.pick(["win_sash", "win_blind"]),
        "steps_left": r.chance(0.5),
        "sign": r.pick(["sign_surf", "sign_fish"]) if spec.get("shop") else None,
    }


def build(spec, lod):
    p = plan(spec)
    k = K()
    W, D = float(spec["width"]), float(spec["depth"])
    floors = spec["floors"]
    shop = bool(spec.get("shop"))
    floor = 0.35 if shop else 0.6
    x0, x1 = -W / 2, W / 2
    yb = PORCH                 # house front behind the porch
    y1 = yb + D
    g = 3.5 if shop else STOREY          # ground storey (the shop front needs 3.3 m)
    ze = floor + g + STOREY * (floors - 1)
    sc = 1.0    # one texel density on every LOD: coarse LODs lose cuts, not texels
    siding = tile("siding", p["siding"]).scaled(sc)
    trim = pal("trim_white")
    roof_m = tile("corrugated", p["roof"]).scaled(sc)   # ribs (texture v) run down the slope
    skirt = tile("deck", lin("#B9AE9F")).scaled(sc)
    deckm = tile("deck", lin("#F2EDE4")).scaled(sc)
    win = decal(p["window"])
    dw = [0.1, 0.06, 0.0][lod]

    # --- walls (siding from the floor up, board skirt below)
    fo = []
    door_u = W * (0.72 if not shop else 0.5)
    if shop:
        fo.append(Opening(W / 2 - 1.75, W / 2 + 1.75, floor, floor + 3.3, decal("shop_surf"), [0.12, 0.08, 0.0][lod]))
    else:
        fo.append(Opening(door_u - 0.48, door_u + 0.48, floor, floor + 2.1, decal("door_panel"), dw))
        for c in (W * 0.22, W * 0.45) if W >= 9 else (W * 0.3,):
            fo.append(Opening(c - 0.5, c + 0.5, floor + 0.85, floor + 2.35, win, dw))
    if floors >= 2:
        n = max(2, int(W / 3.2))
        for i in range(n):
            c = (i + 0.5) * W / n
            fo.append(Opening(c - 0.5, c + 0.5, floor + g + 0.8, floor + g + 2.3, win, dw))
    # walls start at the floor: shift the wall origin up by `floor`
    def siding_wall(o, ax, length, openings, s0):
        ops = [Opening(q.u0, q.u1, q.v0 - floor, q.v1 - floor, q.fill, q.depth, q.arch, q.reveal, q.floor) for q in openings]
        wall(k, Vector(o) + UP * floor, ax, length, ze - floor, siding, ops, s0=s0)
        wall(k, Vector(o) + UP * (-FOUNDATION), ax, length, floor + FOUNDATION, skirt, [], s0=s0)
    siding_wall((x0, yb, 0), (1, 0, 0), W, fo, x0)
    so = []
    if lod < 2:
        for c in [D * 0.3, D * 0.7]:
            so.append(Opening(c - 0.5, c + 0.5, floor + 0.85, floor + 2.35, win, dw))
            if floors >= 2:
                so.append(Opening(c - 0.5, c + 0.5, floor + g + 0.8, floor + g + 2.3, win, dw))
    siding_wall((x1, yb, 0), (0, 1, 0), D, so, 0.0)
    siding_wall((x0, y1, 0), (0, -1, 0), D, so, 0.0)
    bo = []
    if lod < 2:
        bo.append(Opening(W * 0.3 - 0.45, W * 0.3 + 0.45, floor, floor + 2.05, decal("door_panel"), dw))
        bo.append(Opening(W * 0.7 - 0.5, W * 0.7 + 0.5, floor + 0.9, floor + 2.2, win, dw))
    siding_wall((x1, y1, 0), (-1, 0, 0), W, bo, 0.0)

    # --- roof
    fg = p["front_gable"]
    if fg:
        top = gable_roof(k, x0, x1, yb, y1, ze, PITCH, 0.45, 0.4, roof_m, 0.14, trim, ridge_axis="y")
        half = W / 2
        zr = ze + half * math.tan(math.radians(PITCH))
        plane_poly(k, (x0, yb, 0), (1, 0, 0), UP, [(0, ze), (W, ze), (half, zr)], siding, x0, 0.0)
        plane_poly(k, (x1, y1, 0), (-1, 0, 0), UP, [(0, ze), (W, ze), (half, zr)], siding, 0.0, 0.0)
        if lod < 2:
            # small gable window
            box(k, (-0.45, yb - 0.02, ze + 0.35), (0.45, yb, ze + 1.15), pal("glass"), "y")
            box(k, (-0.55, yb - 0.06, ze + 0.25), (0.55, yb, ze + 0.35), trim, "yxXZ")
    else:
        top = gable_roof(k, x0, x1, yb, y1, ze, PITCH, 0.45, 0.4, roof_m, 0.14, trim)
        gable_end(k, x1, yb, y1, ze, PITCH, siding, +1)
        gable_end(k, x0, yb, y1, ze, PITCH, siding, -1)

    # --- gutters and downspouts on the eaves (half-round galvanized)
    if lod < 2:
        tan = math.tan(math.radians(PITCH))
        galv = pal("galvanized", mul(WHITE, 0.95))
        if fg:
            zg = ze - 0.45 * tan - 0.1
            for x, sgn in ((x0 - 0.45, -1), (x1 + 0.45, 1)):
                box(k, (x - 0.07 if sgn > 0 else x - 0.05, yb - 0.4, zg - 0.12), (x + 0.05 if sgn > 0 else x + 0.07, y1 + 0.4, zg), galv, "xXyYz")
                if lod == 0:
                    for y in (y1 - 0.2,):
                        box(k, (x - 0.04 - sgn * 0.3, y - 0.04, floor), (x + 0.04 - sgn * 0.3, y + 0.04, zg - 0.1), galv, "xXyY")
        else:
            zg = ze - 0.45 * tan - 0.1
            for y, sgn in ((yb - 0.45, -1), (y1 + 0.45, 1)):
                box(k, (x0 - 0.4, y - 0.07 if sgn > 0 else y - 0.05, zg - 0.12), (x1 + 0.4, y + 0.05 if sgn > 0 else y + 0.07, zg), galv, "xXyYz")
            if lod == 0:
                box(k, (x1 - 0.2, y1 + 0.05, floor), (x1 - 0.12, y1 + 0.13, zg - 0.1), galv, "xXyY")

    # --- corner boards and window casings
    if lod < 2:
        cb = 0.14
        for (cx, cy) in ((x0, yb), (x1, yb), (x1, y1), (x0, y1)):
            box(k, (cx - cb / 2 - 0.01, cy - cb / 2 - 0.01, floor), (cx + cb / 2 + 0.01, cy + cb / 2 + 0.01, ze), trim, "xXyY")
        # band board at the floor line
        box(k, (x0 - 0.04, yb - 0.04, floor - 0.12), (x1 + 0.04, yb, floor + 0.04), trim, "yZ")
    if lod == 0:
        for q in fo:
            if q.fill is not None and q.fill.region in ("win_sash", "win_blind", "door_panel"):
                casing(k, x0 + q.u0, x0 + q.u1, yb, q.v0, q.v1, trim, sill=q.fill.region != "door_panel")

    # --- porch: deck, posts, shed roof, railing, steps
    porch(k, x0, x1, yb, floor, ze, p, lod, shop, deckm, trim, roof_m)
    return k, {"footprint": [x0, x1, 0.0, y1], "height": top + 0.1, "overhang": 1.0, "foundation": FOUNDATION,
               "params": {"front_gable": fg}}


def casing(k, xa, xb, y, v0, v1, trim, sill=True):
    w = 0.09
    box(k, (xa - w, y - 0.03, v0), (xa, y, v1), trim, "yxXZ")
    box(k, (xb, y - 0.03, v0), (xb + w, y, v1), trim, "yxXZ")
    box(k, (xa - w - 0.03, y - 0.04, v1), (xb + w + 0.03, y, v1 + 0.12), trim, "yxXzZ")
    if sill:
        box(k, (xa - w - 0.02, y - 0.07, v0 - 0.05), (xb + w + 0.02, y, v0), trim, "yxXzZ")


def porch(k, x0, x1, yb, floor, ze, p, lod, shop, deckm, trim, roof_m):
    y0 = 0.0
    post = 0.13
    # deck boards on a rim joist
    rect(k, (x0, y0, floor), (1, 0, 0), (0, 1, 0), x1 - x0, yb - y0, deckm, x0, y0)
    box(k, (x0, y0, floor - 0.25), (x1, yb, floor), pal("wood_grey"), "yxXz")
    # piers under the deck
    if lod < 2:
        for x in (x0 + 0.2, (x0 + x1) / 2, x1 - 0.2):
            box(k, (x - 0.12, y0 + 0.1, -0.6), (x + 0.12, y0 + 0.34, floor - 0.25), pal("wood_grey"), "yxXY")
    # shed roof on posts
    zr_wall = min(ze - 0.25, floor + 2.9)
    zr_edge = zr_wall - 0.45
    xs = [x0 + 0.1]
    n = max(2, int((x1 - x0) / 2.6))
    xs = [x0 + 0.1 + (x1 - x0 - 0.2) * i / n for i in range(n + 1)]
    if lod < 2:
        for x in xs:
            box(k, (x - post / 2, y0 + 0.1, floor), (x + post / 2, y0 + 0.1 + post, zr_edge), trim, "yxXY")
        box(k, (x0 - 0.05, y0 + 0.02, zr_edge - 0.22), (x1 + 0.05, y0 + 0.28, zr_edge), trim, "yxXzZ")   # beam
    ov = 0.3
    a = Vector((x0 - ov, y0 - ov, zr_edge + 0.05))
    b = Vector((x1 + ov, y0 - ov, zr_edge + 0.05))
    c = Vector((x1 + ov, yb, zr_wall + 0.05))
    d = Vector((x0 - ov, yb, zr_wall + 0.05))
    quad3(k, a, b, c, d, roof_m)
    quad3(k, d - UP * 0.08, c - UP * 0.08, b - UP * 0.08, a - UP * 0.08, pal("wood_grey"))
    quad3(k, a - UP * 0.08, b - UP * 0.08, b, a, trim)
    for (e0, e1) in ((d, a), (b, c)):
        quad3(k, e0 - UP * 0.08, e1 - UP * 0.08, e1, e0, trim)
    # sign board of the shop on the porch roof edge
    if p["sign"]:
        sw, sh = 3.6, 0.6
        cx = (x0 + x1) / 2
        box(k, (cx - sw / 2, y0 - 0.1, zr_edge + 0.1), (cx + sw / 2, y0 - 0.02, zr_edge + 0.1 + sh), pal("wood_grey"), "xXYZ")
        rect(k, (cx - sw / 2, y0 - 0.1, zr_edge + 0.1), (1, 0, 0), (0, 0, 1), sw, sh, decal(p["sign"]))
        if lod < 2:
            for dx in (-sw / 3, sw / 3):
                box(k, (cx + dx - 0.04, y0 - 0.02, zr_edge), (cx + dx + 0.04, y0 + 0.06, zr_edge + 0.1 + sh), pal("wood_grey"), "xXyY")
    # steps and railing
    sw_ = 1.4
    sx = (x0 + 0.5) if p["steps_left"] else (x1 - 0.5 - sw_)
    if shop:
        sx = (x0 + x1) / 2 - 1.2
        sw_ = 2.4
    nsteps = max(1, int(round(floor / 0.19)))
    for i in range(nsteps):
        z = floor - (i + 1) * floor / nsteps
        box(k, (sx, y0 - (i + 1) * 0.3, -0.2), (sx + sw_, y0 - i * 0.3, z + floor / nsteps), deckm, "yxXZ")
    if lod == 2:
        return
    h = 0.95
    rails = [((x0 + 0.1, y0 + 0.16), (sx, y0 + 0.16)), ((sx + sw_, y0 + 0.16), (x1 - 0.1, y0 + 0.16)),
             ((x0 + 0.1, y0 + 0.16), (x0 + 0.1, yb)), ((x1 - 0.1, y0 + 0.16), (x1 - 0.1, yb))]
    for (a2, b2) in rails:
        L = math.hypot(b2[0] - a2[0], b2[1] - a2[1])
        if L < 0.3:
            continue
        beam(k, (a2[0], a2[1], floor + h), (b2[0], b2[1], floor + h), 0.09, 0.05, trim)
        beam(k, (a2[0], a2[1], floor + 0.12), (b2[0], b2[1], floor + 0.12), 0.06, 0.05, trim)
        if lod == 0:
            n = int(L / 0.16)
            for i in range(1, n):
                t = i / n
                px, py = a2[0] + (b2[0] - a2[0]) * t, a2[1] + (b2[1] - a2[1]) * t
                box(k, (px - 0.02, py - 0.02, floor + 0.14), (px + 0.02, py + 0.02, floor + h - 0.03), trim, "xXyY")


def render(objs, R, out_dir, tag):
    import os
    so, mp, info = R.setup()
    R.slab("road", -80, 80, -60, -6.0, 0.0, R.ground_mat("asphalt", 3.0))
    R.slab("walk", -80, 80, -6.0, -3.0, 0.12, R.ground_mat("sidewalk", 2.5))
    R.slab("sand", -80, 80, -3.0, 80, 0.05, R.ground_mat("sand", 6.0))
    R.aim_sun(so, mp, info, -30, 30)
    x = -34.0
    for pid in objs:
        o = objs[pid][0]
        xs = [v.co.x for v in o.data.vertices]
        W = max(xs) - min(xs)
        R.place(o, pid + "_r", (x + W / 2, 0.0, 0.05))
        x += W + 4.0
    R.shoot(os.path.join(out_dir, "beach_street_%s.png" % tag), (-36, -15, 1.7), (-10, 4, 3.0), lens=26)
    R.shoot(os.path.join(out_dir, "beach_front_%s.png" % tag), (-12, -24, 3.5), (-12, 4, 3.0), lens=35)
    R.shoot(os.path.join(out_dir, "beach_close_%s.png" % tag), (-24, -5, 1.7), (-29, 3, 2.5), lens=28)
    R.shoot(os.path.join(out_dir, "beach_aerial_%s.png" % tag), (-30, -34, 22), (0, 8, 0), lens=30)
