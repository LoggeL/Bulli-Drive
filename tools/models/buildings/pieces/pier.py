# Pier segments (Bulli Bay pier, deck at y = 5 m in the map): timber deck of weathered grey
# planks laid across the pier on stringers and bent caps, bents of round creosoted piles every
# 5 m with X bracing and a dark marine-growth band at the water line, a curb and a timber
# railing on both sides. Variants: plain, with lamp posts and a bench, and the end segment with
# the railing across the end. Segments run along +X from x = 0 to `length`, centred on the
# pier axis; the deck top is the origin height (piles reach `pile_depth` below it).
#
# Params (kit.json): length (m), width (m), pile_depth (m), kind ("plain" | "lamp" | "end"), seed.
from bd_kit import (K, tile, pal, box, rect, lin, mul, WHITE, beam, cylinder)

DECK_T = 0.12
WATER = -5.0            # sea level below the deck (map: deck y = 5, sea y = 0)


def build(spec, lod):
    k = K()
    L = float(spec["length"])
    Wd = float(spec["width"])
    depth = float(spec.get("pile_depth", 14.0))
    kind = spec.get("kind", "plain")
    sc = 1.0    # one texel density on every LOD: coarse LODs lose cuts, not texels
    hw = Wd / 2
    deck = tile("deck", lin("#E4DDD2")).scaled(sc)
    timber = pal("wood_grey", mul(WHITE, 0.95))
    pile_m = pal("wood_brown", lin("#8A7F74"))
    growth = pal("wood_brown", lin("#3E4A3A"))
    rail_m = pal("wood_grey", lin("#EDE7DC"))

    # --- deck planks (boards across the pier: texture v along y)
    rect(k, (0, -hw, 0), (1, 0, 0), (0, 1, 0), L, Wd, deck, 0.0, 0.0)
    # deck edge fascia and underside
    box(k, (0, -hw, -DECK_T), (L, hw, 0.0), timber, "yYz")
    # --- stringers and bent caps
    if lod < 2:
        for y in [(-hw + 0.4) + i * (Wd - 0.8) / 5 for i in range(6)]:
            box(k, (0, y - 0.1, -DECK_T - 0.4), (L, y + 0.1, -DECK_T), timber, "yYz")
    bents = [L * 0.25, L * 0.75]
    piles_y = [-hw + 0.55, -hw * 0.32, hw * 0.32, hw - 0.55]
    cap_z = -DECK_T - (0.4 if lod < 2 else 0.0)
    for bx in bents:
        box(k, (bx - 0.18, -hw - 0.1, cap_z - 0.36), (bx + 0.18, hw + 0.1, cap_z), timber, "xXyYz")
        for py in piles_y:
            segs = [10, 6, 4][lod]
            r = 0.2
            top = cap_z - 0.36
            if lod < 2:
                cylinder(k, (bx, py, WATER + 1.2), (bx, py, top), r, segs, pile_m, cap_top=False)
                cylinder(k, (bx, py, WATER - 2.5), (bx, py, WATER + 1.2), r + 0.025, segs, growth, cap_top=False)
                cylinder(k, (bx, py, -depth), (bx, py, WATER - 2.5), r, segs, pile_m, cap_top=False)
            else:
                cylinder(k, (bx, py, -depth), (bx, py, top), r, segs, pile_m, cap_top=False)
        if lod == 0:
            # X bracing between neighbouring piles, both faces of the bent
            for a, b in zip(piles_y[:-1], piles_y[1:]):
                for side in (-0.24, 0.24):
                    beam(k, (bx + side, a, cap_z - 0.6), (bx + side, b, WATER + 0.2), 0.22, 0.06, timber, up=(1, 0, 0))
                    beam(k, (bx + side, b, cap_z - 0.6), (bx + side, a, WATER + 0.2), 0.22, 0.06, timber, up=(1, 0, 0))
            # longitudinal struts to the next segment (half length each side)
            for py in (piles_y[0], piles_y[-1]):
                beam(k, (bx - L * 0.25, py, WATER + 0.6), (bx + L * 0.25, py, WATER + 0.6), 0.1, 0.25, timber)

    # --- curbs and railing
    for sgn in (-1, 1):
        y_edge = sgn * hw
        yi = y_edge - sgn * 0.15
        box(k, (0, min(yi, y_edge), 0.0), (L, max(yi, y_edge), 0.18), timber, "yYZ")
        if lod == 2:
            box(k, (0, min(yi, y_edge) + 0.04, 0.18), (L, max(yi, y_edge) - 0.04, 1.15), rail_m, "yY")
            continue
        n = int(round(L / 2.5))
        posts = [L * i / n for i in range(n)]            # the post at x = L belongs to the next segment
        if kind == "end":
            posts.append(L - 0.08)
        ylo, yhi = (y_edge - 0.16, y_edge) if sgn > 0 else (y_edge, y_edge + 0.16)
        for x in posts:
            box(k, (x, ylo, 0.18), (x + 0.16, yhi, 1.2), rail_m, "xXyYZ")
        ym = y_edge - sgn * 0.08
        beam(k, (0, ym, 1.14), (L, ym, 1.14), 0.14, 0.1, rail_m)
        if lod == 0:
            beam(k, (0, ym, 0.68), (L, ym, 0.68), 0.06, 0.14, rail_m)
            beam(k, (0, ym, 0.38), (L, ym, 0.38), 0.06, 0.14, rail_m)
    if kind == "end":
        # railing across the end of the pier
        box(k, (L - 0.15, -hw, 0.0), (L, hw, 0.18), timber, "xXZ")
        if lod < 2:
            for i in range(5):
                y = -hw + Wd * (i + 0.5) / 5
                box(k, (L - 0.16, y - 0.08, 0.18), (L, y + 0.08, 1.2), rail_m, "xXyYZ")
            beam(k, (L - 0.08, -hw, 1.14), (L - 0.08, hw, 1.14), 0.14, 0.1, rail_m)
            if lod == 0:
                beam(k, (L - 0.08, -hw, 0.68), (L - 0.08, hw, 0.68), 0.06, 0.14, rail_m)
                beam(k, (L - 0.08, -hw, 0.38), (L - 0.08, hw, 0.38), 0.06, 0.14, rail_m)
        else:
            box(k, (L - 0.12, -hw, 0.18), (L - 0.04, hw, 1.15), rail_m, "xX")
    if kind in ("lamp", "end") and lod < 2:
        for sgn in (-1, 1):
            lamp_post(k, L * 0.5, sgn * (hw - 0.45), lod)
        bench(k, L * 0.5 - 1.0, hw - 1.1, lod, facing=-1)
        if kind == "end":
            bench(k, L * 0.5 - 1.0, -hw + 1.1, lod, facing=1)
    return k, {"footprint": [0.0, L, -hw, hw], "height": 4.6 if kind in ("lamp", "end") else 1.2,
               "overhang": 0.0, "foundation": depth, "ao_dist": 1.5, "grime": False}


def lamp_post(k, x, y, lod):
    """cast-iron lamp post (4.2 m) with a round globe"""
    iron = pal("iron")
    cylinder(k, (x, y, 0.0), (x, y, 0.5), 0.14, 10, iron, cap_top=True)
    cylinder(k, (x, y, 0.5), (x, y, 3.8), 0.06, [10, 6][lod], iron, cap_top=True, r_top=0.045)
    cylinder(k, (x, y, 3.8), (x, y, 3.95), 0.1, 10, iron, cap_top=True)
    # globe as a stacked lathe (octagonal)
    g = pal("lamp_warm")
    rs = [0.1, 0.2, 0.24, 0.2, 0.08]
    zs = [3.95, 4.05, 4.22, 4.4, 4.5]
    for i in range(4):
        cylinder(k, (x, y, zs[i]), (x, y, zs[i + 1]), rs[i], 10, g, cap_top=(i == 3), r_top=rs[i + 1])


def bench(k, x, y, lod, facing=-1):
    """timber bench with iron legs, 2 m long; facing -1: seat faces -Y"""
    wood = pal("wood_brown", lin("#C9B8A4"))
    iron = pal("iron")
    for dx in (0.15, 1.85):
        box(k, (x + dx - 0.03, y - 0.25, 0.0), (x + dx + 0.03, y + 0.25, 0.44), iron, "xXyY")
    for i in range(3):
        yy = y - 0.22 + i * 0.16
        box(k, (x, yy, 0.42), (x + 2.0, yy + 0.12, 0.46), wood, "xXyYZ")
    yb = y + 0.28 * (-facing)
    for i in range(2):
        box(k, (x, yb - 0.03, 0.6 + i * 0.18), (x + 2.0, yb + 0.03, 0.72 + i * 0.18), wood, "xXyYZ")


def render(objs, R, out_dir, tag):
    import os
    so, mp, info = R.setup()
    # sea (dark, glossy) and a sandy beach under the first segment
    import bpy
    sea = bpy.data.materials.new("sea")
    b = R._principled(sea)
    b.inputs["Base Color"].default_value = (0.02, 0.07, 0.09, 1)
    b.inputs["Roughness"].default_value = 0.08
    R.slab("sea", -60, 200, -120, 120, 0.0, sea)
    R.slab("floor", -60, 200, -120, 120, -8.0, R.ground_mat("sand", 6.0))
    R.aim_sun(so, mp, info, -60, 25)
    ids = list(objs)
    seq = []
    for pid in ids:
        if "end" not in pid:
            seq += [pid, pid]
    seq += [p for p in ids if "end" in p]
    x = 0.0
    for i, pid in enumerate(seq):
        o = objs[pid][0]
        R.place(o, "%s_%d" % (pid, i), (x, 0, 5.0))
        x += 10.0
    R.shoot(os.path.join(out_dir, "pier_side_%s.png" % tag), (25, -32, 3.0), (35, 0, 3.0), lens=26)
    R.shoot(os.path.join(out_dir, "pier_deck_%s.png" % tag), (6, -1.5, 6.7), (40, 1.0, 5.8), lens=24)
    R.shoot(os.path.join(out_dir, "pier_under_%s.png" % tag), (18, -9, 1.2), (30, 2, 2.0), lens=24)
