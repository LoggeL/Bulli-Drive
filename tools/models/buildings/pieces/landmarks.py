# Landmarks of the California coast (design 11.1): a lighthouse on the headland (white tapered
# masonry tower, gallery, lantern with a red roof, like Pigeon Point or Point Pinos), a steel water
# tower on four braced legs, a Streamline Moderne roadside diner ("BULLI'S DINER" on a roof sign)
# and a 1950s gas station (canopy with the "SEASIDE SERVICE" fascia, pump island, office with a
# service bay, pylon sign). Every piece stands on its own lot: origin on the ground at the middle
# of the street side, which faces three.js +Z (Blender -Y); the lot extends to Blender +Y.
#
# Params (kit.json): kind ("lighthouse" | "water_tower" | "diner" | "gas_station"), seed.
import math
from bd_kit import (K, Opening, tile, pal, decal, wall, box, rect, lin, mul, Rng, WHITE, UP, beam, cylinder,
                    prism)
from mathutils import Vector

DINER_TINTS = ["#F3EEE2", "#EAF1EC", "#F6E9E1"]
TOWER_PAINT = ["white", "trim_cream", "lifeguard_blue"]


def build(spec, lod):
    kind = spec["kind"]
    k, meta = {"lighthouse": lighthouse, "water_tower": water_tower, "diner": diner,
               "gas_station": gas_station}[kind](spec, lod)
    x0, x1, y0, y1 = meta["footprint"]
    if y0 != 0.0:
        # round pieces are built around their axis: move the lot's street side to the origin
        out = K()
        out.extend(k, None, (0.0, -y0, 0.0))
        meta["footprint"] = [x0, x1, 0.0, y1 - y0]
        k = out
    return k, meta


def railing_ring(k, cx, cy, z, r, posts, mat):
    """round railing: posts and a top rail (a closed square tube)"""
    for i in range(posts):
        a = 2 * math.pi * i / posts
        x, y = cx + r * math.cos(a), cy + r * math.sin(a)
        box(k, (x - 0.03, y - 0.03, z), (x + 0.03, y + 0.03, z + 1.0), mat, "xXyY")
    path = [(cx + r * math.cos(2 * math.pi * i / posts), cy + r * math.sin(2 * math.pi * i / posts), z + 1.0)
            for i in range(posts)]
    prism(k, path, [(-0.035, -0.035), (0.035, -0.035), (0.035, 0.035), (-0.035, 0.035)], mat, closed_path=True)


# --------------------------------------------------------------------------
def lighthouse(spec, lod):
    k = K()
    segs = [16, 12, 8][lod]
    white = tile("stucco", lin("#F5F2EA"))
    base_r, top_r, top_z = 2.6, 1.8, 18.0
    # plinth and tapered tower
    box(k, (-3.4, -3.4, -0.6), (3.4, 3.4, 0.5), tile("concrete", lin("#C9C2B5")), "xXyYZ")
    cylinder(k, (0, 0, 0.5), (0, 0, top_z), base_r, segs, white, cap_top=False, r_top=top_r)
    radius_at = lambda z: base_r + (top_r - base_r) * (z - 0.5) / (top_z - 0.5)
    # entrance vestibule with the door on the street side
    box(k, (-0.9, -3.25, 0.5), (0.9, -2.0, 3.2), white, "xXyZ")
    rect(k, (-0.55, -3.26, 0.55), (1, 0, 0), (0, 0, 1), 1.1, 2.3, decal("door_panel"))
    if lod < 2:
        box(k, (-1.05, -3.4, 3.2), (1.05, -1.9, 3.38), pal("signal_red"), "xXyYzZ")
        # small windows up the tower
        for z in (6.5, 11.0, 15.0):
            r = radius_at(z + 0.5) + 0.02
            rect(k, (-0.32, -r, z), (1, 0, 0), (0, 0, 1), 0.64, 1.05, decal("win_casement"))
    # gallery deck, lantern, roof
    cylinder(k, (0, 0, top_z), (0, 0, top_z + 0.35), 2.75, segs, pal("steel_dark"), cap_top=True, cap_bottom=True)
    lz0, lz1 = top_z + 0.35, top_z + 2.4
    cylinder(k, (0, 0, lz0), (0, 0, lz0 + 0.5), 1.35, segs, pal("steel_dark"), cap_top=False)
    cylinder(k, (0, 0, lz0 + 0.5), (0, 0, lz1), 1.35, segs, pal("glass"), cap_top=False)
    cylinder(k, (0, 0, lz1), (0, 0, lz1 + 1.3), 1.6, segs, pal("signal_red"), cap_top=True, cap_bottom=True, r_top=0.14)
    if lod == 0:
        railing_ring(k, 0, 0, top_z + 0.35, 2.65, 16, pal("iron"))
        for i in range(8):
            a = 2 * math.pi * (i + 0.5) / 8
            p = Vector((1.37 * math.cos(a), 1.37 * math.sin(a), 0))
            beam(k, p + UP * (lz0 + 0.5), p + UP * lz1, 0.06, 0.06, pal("iron"))
        cylinder(k, (0, 0, lz1 + 1.25), (0, 0, lz1 + 1.6), 0.22, 8, pal("iron"), cap_top=True)
        beam(k, (0, 0, lz1 + 1.6), (0, 0, lz1 + 2.5), 0.03, 0.03, pal("iron"))
    return k, {"footprint": [-3.4, 3.4, -3.4, 3.4], "overhang": 0.0, "foundation": 0.6, "ao_dist": 3.0}


# --------------------------------------------------------------------------
def water_tower(spec, lod):
    r = Rng(spec.get("seed", 1))
    k = K()
    segs = [20, 12, 8][lod]
    paint_name = spec.get("paint") or r.pick(TOWER_PAINT)
    paint = pal(paint_name)
    steel = pal("steel_dark")
    z0, h, R = 15.0, 5.0, 4.0
    cylinder(k, (0, 0, z0), (0, 0, z0 + h), R, segs, paint, cap_top=False)
    cylinder(k, (0, 0, z0 + h), (0, 0, z0 + h + 1.7), R + 0.2, segs, paint, cap_top=True, cap_bottom=True, r_top=0.3)
    cylinder(k, (0, 0, z0 - 1.5), (0, 0, z0), 1.0, segs, paint, cap_top=False, cap_bottom=True, r_top=R)
    # riser pipe and legs
    cylinder(k, (0, 0, 0.0), (0, 0, z0 - 1.5), 0.45, [10, 8, 6][lod], pal("galvanized"), cap_top=False)
    legs = []
    for i in range(4):
        a = math.pi / 4 + i * math.pi / 2
        foot = Vector((5.0 * math.cos(a), 5.0 * math.sin(a), -0.3))
        top = Vector((3.95 * math.cos(a), 3.95 * math.sin(a), z0 + 1.0))
        legs.append((foot, top))
        beam(k, foot, top, 0.36, 0.36, steel)
        box(k, (foot.x - 0.45, foot.y - 0.45, -0.4), (foot.x + 0.45, foot.y + 0.45, 0.3), tile("concrete"), "xXyYZ")
    at = lambda leg, z: leg[0].lerp(leg[1], (z - leg[0].z) / (leg[1].z - leg[0].z))
    if lod < 2:
        for z in (5.0, 10.0):
            for i in range(4):
                beam(k, at(legs[i], z), at(legs[(i + 1) % 4], z), 0.22, 0.22, steel)
        # balcony at the tank's base
        cylinder(k, (0, 0, z0 - 0.15), (0, 0, z0), R + 0.8, segs, pal("steel_dark"), cap_top=True, cap_bottom=True)
    if lod == 0:
        for (za, zb) in ((0.3, 5.0), (5.0, 10.0), (10.0, 14.8)):
            for i in range(4):
                a, b = legs[i], legs[(i + 1) % 4]
                beam(k, at(a, za), at(b, zb), 0.07, 0.07, steel)
                beam(k, at(b, za), at(a, zb), 0.07, 0.07, steel)
        railing_ring(k, 0, 0, z0, R + 0.7, 24, pal("iron"))
    return k, {"footprint": [-4.6, 4.6, -4.6, 4.6], "overhang": 0.25, "foundation": 0.4, "ao_dist": 3.0,
               "params": {"paint": paint_name}}


# --------------------------------------------------------------------------
def diner(spec, lod):
    r = Rng(spec.get("seed", 1))
    k = K()
    W, D, H = 15.0, 8.0, 4.7            # H includes the 0.5 m parapet
    x0, x1 = -W / 2, W / 2
    roof_z = H - 0.5
    wall_mat = tile("stucco", lin(r.pick(DINER_TINTS)))
    depth = [0.25, 0.14, 0.0][lod]
    front = [Opening(u, u + 3.5, 0.3, 3.4, decal("shop_bakery"), depth) for u in (1.0, 5.75, 10.5)]
    wall(k, (x0, 0, 0), (1, 0, 0), W, H, wall_mat, front, v_base=-0.6)
    side = [Opening(2.5, 4.3, 1.1, 2.9, decal("win_blind"), depth)] if lod < 2 else []
    wall(k, (x1, 0, 0), (0, 1, 0), D, H, wall_mat, side, s0=W, v_base=-0.6)
    wall(k, (x1, D, 0), (-1, 0, 0), W, H, wall_mat,
         [Opening(W - 3.0, W - 2.0, 0.0, 2.2, decal("door_steel"), 0.06)] if lod < 2 else [], s0=W + D, v_base=-0.6)
    wall(k, (x0, D, 0), (0, -1, 0), D, H, wall_mat, side, s0=2 * W + D, v_base=-0.6)
    # roof deck behind the parapet, coping (far: a flat lid)
    t = 0.3
    alu = pal("aluminium")
    if lod == 2:
        rect(k, (x0, 0.0, H), (1, 0, 0), (0, 1, 0), W, D, pal("concrete"))
    else:
        roof_deck(k, x0, x1, D, H, roof_z, t, wall_mat, alu)
    diner_front(k, x0, x1, D, H, lod, alu)
    return k, {"footprint": [x0, x1, 0.0, D], "overhang": 1.65, "foundation": 0.6}


def roof_deck(k, x0, x1, D, H, roof_z, t, wall_mat, alu):
    W = x1 - x0
    rect(k, (x0 + t, t, roof_z), (1, 0, 0), (0, 1, 0), W - 2 * t, D - 2 * t, tile("gravel"), x0 + t, t)
    for (o, ax, L) in (((x1 - t, t, roof_z), (-1, 0, 0), W - 2 * t), ((x0 + t, D - t, roof_z), (1, 0, 0), W - 2 * t),
                       ((x0 + t, t, roof_z), (0, 1, 0), D - 2 * t), ((x1 - t, D - t, roof_z), (0, -1, 0), D - 2 * t)):
        wall(k, o, ax, L, 0.5, wall_mat)
    for lo, hi, faces in (((x0, 0.0), (x1, t), "yYZ"), ((x0, D - t), (x1, D), "yYZ"),
                          ((x0, t), (x0 + t, D - t), "xXZ"), ((x1 - t, t), (x1, D - t), "xXZ")):
        box(k, (lo[0], lo[1], H), (hi[0], hi[1], H + 0.08), alu, faces)


def diner_front(k, x0, x1, D, H, lod, alu):
    # stainless band and red speed lines round the front and the sides
    box(k, (x0 - 0.05, -0.05, 3.55), (x1 + 0.05, D + 0.05, 3.95), alu, "xXyYzZ")
    if lod < 2:
        for i in range(3):
            z = 0.45 + 0.16 * i
            box(k, (x0 - 0.03, -0.03, z), (x1 + 0.03, D + 0.03, z + 0.07), pal("signal_red"), "xXyYZ")
    # entrance canopy over the middle bay
    box(k, (-2.3, -1.6, 3.4), (2.3, 0.0, 3.55), alu, "xXyzZ")
    # roof sign on two posts
    sw, sh, sz = 6.6, 1.1, H + 0.5
    for x in (-2.2, 2.2):
        box(k, (x - 0.08, 1.12, H), (x + 0.08, 1.28, sz + sh * 0.5), pal("steel_dark"), "xXyYZ" if lod < 2 else "xXY")
    box(k, (-sw / 2 - 0.1, 1.0, sz - 0.1), (sw / 2 + 0.1, 1.12, sz + sh + 0.1), pal("steel_dark"), "xXYzZ")
    rect(k, (-sw / 2, 0.99, sz), (1, 0, 0), (0, 0, 1), sw, sh, decal("sign_diner"))
    if lod == 0:
        # sign lamps and a roof vent
        for x in (-2.0, 0.0, 2.0):
            beam(k, (x, 1.0, sz - 0.1), (x, 0.55, sz - 0.25), 0.04, 0.04, pal("iron"))
            box(k, (x - 0.12, 0.45, sz - 0.33), (x + 0.12, 0.62, sz - 0.2), pal("lamp_warm"), "xXyYzZ")
        box(k, (x1 - 3.0, D - 2.8, H - 0.5), (x1 - 1.8, D - 1.6, H + 0.4), pal("galvanized"), "xXyYZ")


# --------------------------------------------------------------------------
def gas_station(spec, lod):
    k = K()
    white = pal("white")
    red = pal("signal_red")
    concrete = tile("concrete", lin("#C9C2B5"))
    # canopy on two columns over the pump island
    cx0, cx1, cy0, cy1, cz = -6.0, 6.0, 1.5, 9.5, 4.6
    box(k, (cx0, cy0, cz), (cx1, cy1, cz + 0.7), white, "xXyYzZ")
    box(k, (cx0 - 0.03, cy0 - 0.03, cz + 0.12), (cx1 + 0.03, cy1 + 0.03, cz + 0.58), red, "xXyY")
    rect(k, (-2.6, cy0 - 0.04, cz + 0.08), (1, 0, 0), (0, 0, 1), 5.2, 0.54, decal("sign_service"))
    box(k, (-4.6, 5.0, 0.0), (4.6, 6.0, 0.2), concrete, "xXyYZ")
    for x in (-3.9, 3.9):
        box(k, (x - 0.25, 5.25, 0.2), (x + 0.25, 5.75, cz), white, "xXyY")
    for x in (-1.6, 1.6):
        box(k, (x - 0.4, 5.25, 0.2), (x + 0.4, 5.75, 1.75), red, "xXyYZ")
        box(k, (x - 0.42, 5.23, 1.75), (x + 0.42, 5.77, 2.0), pal("plastic_white"), "xXyYZ")
        if lod < 2:
            cylinder(k, (x, 5.5, 2.0), (x, 5.5, 2.4), 0.2, 8, pal("lamp_warm"), cap_top=True)
            rect(k, (x - 0.25, 5.24, 1.2), (1, 0, 0), (0, 0, 1), 0.5, 0.35, pal("glass"))
            rect(k, (x + 0.25, 5.76, 1.2), (-1, 0, 0), (0, 0, 1), 0.5, 0.35, pal("glass"))
    if lod < 2:
        for x in (-3.5, 3.5):
            for y in (3.2, 7.8):
                rect(k, (x - 1.0, y + 0.3, cz - 0.01), (1, 0, 0), (0, -1, 0), 2.0, 0.6, pal("lamp_cool"))
    # office with a service bay behind the canopy
    ox0, ox1, oy0, oy1, oh = -5.0, 5.0, 11.0, 16.0, 3.8
    wmat = tile("stucco", lin("#F2EFE7"))
    d = [0.2, 0.12, 0.0][lod]
    ops = [Opening(0.6, 4.1, 0.1, 3.2, decal("shop_hardware"), d),
           Opening(5.4, 8.9, 0.0, 3.3, tile("shutter", lin("#D8D4CC")), d)]
    wall(k, (ox0, oy0, 0), (1, 0, 0), ox1 - ox0, oh, wmat, ops, v_base=-0.4)
    wall(k, (ox1, oy0, 0), (0, 1, 0), oy1 - oy0, oh, wmat, [], s0=ox1 - ox0, v_base=-0.4)
    wall(k, (ox1, oy1, 0), (-1, 0, 0), ox1 - ox0, oh, wmat, [], s0=ox1 - ox0 + oy1 - oy0, v_base=-0.4)
    wall(k, (ox0, oy1, 0), (0, -1, 0), oy1 - oy0, oh, wmat, [], s0=2 * (ox1 - ox0) + oy1 - oy0, v_base=-0.4)
    box(k, (ox0 - 0.3, oy0 - 0.9, oh), (ox1 + 0.3, oy1 + 0.3, oh + 0.35), white, "xXyYzZ")
    box(k, (ox0 - 0.33, oy0 - 0.93, oh + 0.08), (ox1 + 0.33, oy0 - 0.9, oh + 0.27), red, "y")
    # pylon sign at the street
    px, py = -4.0, 0.6
    box(k, (px - 0.12, py - 0.12, 0.0), (px + 0.12, py + 0.12, 6.0), pal("steel_dark"), "xXyY")
    box(k, (px - 1.9, py - 0.1, 6.0), (px + 1.9, py + 0.1, 6.75), pal("steel_dark"), "xXzZ")
    rect(k, (px - 1.85, py - 0.11, 6.03), (1, 0, 0), (0, 0, 1), 3.7, 0.69, decal("sign_service"))
    rect(k, (px + 1.85, py + 0.11, 6.03), (-1, 0, 0), (0, 0, 1), 3.7, 0.69, decal("sign_service"))
    return k, {"footprint": [-6.0, 6.0, 0.0, 16.0], "overhang": 1.35, "foundation": 0.4}


def render(objs, R, out_dir, tag):
    """review stills: the four landmarks in a row, and a close view of the diner and the station"""
    import os
    so, mp, info = R.setup()
    R.street_ground(-60, 60, back_role="grass", back_tint=(0.9, 0.85, 0.7))
    R.aim_sun(so, mp, info, -40, 30)
    x = {"lighthouse": -38.0, "water_tower": -24.0, "diner": -4.0, "gas_station": 18.0}
    for pid, lods in objs.items():
        kind = pid.replace("landmark_", "")
        R.place(lods[0], pid + "_r", (x.get(kind, 0.0), 0.0 if kind != "lighthouse" and kind != "water_tower" else 6.0, 0.15))
    R.shoot(os.path.join(out_dir, "landmarks_row_%s.png" % tag), (-6, -42, 6.0), (-8, 4, 6.0), lens=26)
    R.shoot(os.path.join(out_dir, "landmarks_diner_%s.png" % tag), (-12, -13, 1.7), (-3, 2, 3.4), lens=28)
    R.shoot(os.path.join(out_dir, "landmarks_station_%s.png" % tag), (8, -14, 1.7), (18, 6, 3.2), lens=28)
    R.shoot(os.path.join(out_dir, "landmarks_towers_%s.png" % tag), (-24, -22, 3.0), (-31, 6, 12.0), lens=28)
