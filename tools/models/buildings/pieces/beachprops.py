# Beach props: the lifeguard tower (Los Angeles County style: a small painted wooden cabin with
# windows all round on a braced timber platform, front deck with railing, access ramp) and a
# surfboard rack (timber A-frame with six longboards).
#
# Params (kit.json): kind ("tower" | "rack"), seed.
import math
from bd_kit import (K, tile, pal, box, rect, lin, Rng, UP, beam, cylinder, quad3, wall, Opening, hip_roof)
from mathutils import Vector

TOWER_PAINT = ["#9CC3DA", "#F2D98B", "#F3B7A8", "#B9DCC4", "#E9E4DA"]
BOARDS = ["board_cream", "board_teal", "board_orange", "board_yellow", "trim_white", "seat_blue"]


def build(spec, lod):
    if spec.get("kind") == "rack":
        return rack(spec, lod)
    return tower(spec, lod)


def tower(spec, lod):
    r = Rng(spec.get("seed", 1))
    k = K()
    paint = lin(spec["paint"]) if "paint" in spec else lin(r.pick(TOWER_PAINT))
    siding = tile("siding", paint).scaled([1.0, 1.0, 2.0][lod])
    trim = pal("trim_white")
    wood = pal("wood_grey", lin("#D7D0C4"))
    fz = 2.1                                   # platform height
    cw, cd, ch = 2.6, 2.4, 2.2                 # cabin
    x0, x1, y0, y1 = -cw / 2, cw / 2, 0.9, 0.9 + cd
    # platform posts and bracing
    for px in (-1.4, 1.4):
        for py in (0.2, y1 - 0.1):
            box(k, (px - 0.1, py - 0.1, -0.6), (px + 0.1, py + 0.1, fz), wood, "xXyY")
    if lod == 0:
        for py in (0.2, y1 - 0.1):
            beam(k, (-1.4, py, 0.3), (1.4, py, fz - 0.25), 0.05, 0.15, wood, up=(0, 1, 0))
            beam(k, (1.4, py, 0.3), (-1.4, py, fz - 0.25), 0.05, 0.15, wood, up=(0, 1, 0))
        for px in (-1.4, 1.4):
            beam(k, (px, 0.2, 0.3), (px, y1 - 0.1, fz - 0.25), 0.05, 0.15, wood, up=(1, 0, 0))
    # platform deck (front deck 0.9 m in front of the cabin)
    box(k, (-1.55, 0.0, fz - 0.18), (1.55, y1 + 0.05, fz), wood, "xXyYz")
    rect(k, (-1.55, 0.0, fz), (1, 0, 0), (0, 1, 0), 3.1, y1 + 0.05, tile("deck", lin("#EFE9DF")))
    # cabin walls with windows all round
    win_h0, win_h1 = 1.0, 1.9
    glass = pal("glass")
    def cabin_wall(o, ax, length, n):
        ops = []
        if lod < 2:
            for i in range(n):
                a = 0.15 + i * (length - 0.3) / n
                ops.append(Opening(a + 0.06, a + (length - 0.3) / n - 0.06, win_h0, win_h1, glass, 0.05))
        else:
            ops.append(Opening(0.2, length - 0.2, win_h0, win_h1, glass, 0.0))
        wall(k, Vector(o) + UP * fz, ax, length, ch, siding, ops)
    cabin_wall((x0, y0, 0), (1, 0, 0), cw, 3)
    cabin_wall((x1, y0, 0), (0, 1, 0), cd, 2)
    cabin_wall((x1, y1, 0), (-1, 0, 0), cw, 3)
    cabin_wall((x0, y1, 0), (0, -1, 0), cd, 2)
    # corner trims and roof
    if lod < 2:
        for (cx, cy) in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):
            box(k, (cx - 0.06, cy - 0.06, fz), (cx + 0.06, cy + 0.06, fz + ch), trim, "xXyY")
    hip_roof(k, x0, x1, y0, y1, fz + ch, 18, 0.45, pal("trim_white"), trim, 0.12)
    # front deck railing
    if lod < 2:
        h = 1.0
        for (a, b) in (((-1.5, 0.05), (1.5, 0.05)), ((-1.5, 0.05), (-1.5, y0)), ((1.5, 0.05), (1.5, y0))):
            beam(k, (a[0], a[1], fz + h), (b[0], b[1], fz + h), 0.07, 0.07, trim)
            beam(k, (a[0], a[1], fz + 0.5), (b[0], b[1], fz + 0.5), 0.05, 0.05, trim)
        for (x, y) in ((-1.5, 0.05), (1.5, 0.05), (0.0, 0.05)):
            box(k, (x - 0.05, y - 0.05, fz), (x + 0.05, y + 0.05, fz + h), trim, "xXyY")
    # ramp from the right side of the platform down to the sand
    rw = 1.0
    xa = 1.55
    xb = xa + 5.0
    ya, yb = y1 - rw - 0.1, y1 - 0.1
    quad3(k, (xa, ya, fz), (xa, yb, fz), (xb, yb, 0.0), (xb, ya, 0.0), tile("deck", lin("#E3DCD0")).rotated())
    quad3(k, (xb, ya, -0.12), (xb, yb, -0.12), (xa, yb, fz - 0.15), (xa, ya, fz - 0.15), wood)
    quad3(k, (xa, ya, fz - 0.15), (xb, ya, -0.12), (xb, ya, 0.0), (xa, ya, fz), wood)
    quad3(k, (xb, yb, -0.12), (xa, yb, fz - 0.15), (xa, yb, fz), (xb, yb, 0.0), wood)
    if lod < 2:
        for yy in (ya, yb):
            beam(k, (xa, yy, fz + 0.95), (xb, yy, 0.95), 0.06, 0.06, trim)
            for t in (0.0, 0.5, 1.0):
                x = xa + (xb - xa) * t
                z = fz * (1 - t)
                box(k, (x - 0.05, yy - 0.05, z - 0.3), (x + 0.05, yy + 0.05, z + 0.95), trim, "xXyY")
        box(k, (xa + 2.4, ya + 0.1, -0.5), (xa + 2.6, yb - 0.1, fz * 0.5 - 0.15), wood, "xXyY")
    # rescue board and flag pole
    if lod == 0:
        box(k, (x1 + 0.02, y0 + 0.4, fz + 0.2), (x1 + 0.06, y0 + 0.9, fz + 2.0), pal("signal_red"), "xXyYzZ")
        cylinder(k, (x0 - 0.2, y0 + 0.2, fz), (x0 - 0.2, y0 + 0.2, fz + ch + 2.2), 0.03, 6, trim)
        box(k, (x0 - 0.2, y0 + 0.2, fz + ch + 1.5), (x0 - 0.18, y0 + 0.9, fz + ch + 2.1), pal("safety_yellow"), "xX")
    return k, {"footprint": [-1.6, xb, 0.0, y1 + 0.1], "height": fz + ch + 1.0, "overhang": 0.5, "foundation": 0.6,
               "ao_dist": 1.2, "grime": False}


def surfboard(k, base, direction, up, length, width, color, lod):
    """longboard: outline from a round nose to a squash tail, thickness 7 cm, slight rocker"""
    base, d, u = Vector(base), Vector(direction).normalized(), Vector(up).normalized()
    s = d.cross(u).normalized()
    u = s.cross(d).normalized()
    n = [14, 6, 3][lod]
    thick = 0.07
    top, bot = [], []
    for i in range(n + 1):
        t = i / n
        # outline: squash tail (t = 0) widening to the widest point at 42 %, round nose (t = 1)
        e = (t - 0.42) / (0.58 if t > 0.42 else 0.42)
        w = width / 2 * math.sqrt(max(0.0, 1.0 - e * e)) if t > 0.42 else width / 2 * (0.66 + 0.34 * math.sqrt(max(0.0, 1.0 - e * e)))
        w = max(0.015, w)
        rocker = 0.06 * (2 * t - 1) ** 4
        c = base + d * (length * t) + u * rocker
        top.append((c + s * w + u * thick / 2, c - s * w + u * thick / 2))
        bot.append((c + s * w - u * thick / 2, c - s * w - u * thick / 2))
    m = pal(color)
    for i in range(n):
        (a0, b0), (a1, b1) = top[i], top[i + 1]
        k.face([a0, a1, b1, b0], [m.uv] * 4, m.tint, False)
        (c0, e0), (c1, e1) = bot[i], bot[i + 1]
        k.face([c0, e0, e1, c1], [m.uv] * 4, m.tint, False)
        k.face([c0, c1, a1, a0], [m.uv] * 4, m.tint, True)
        k.face([e1, e0, b0, b1], [m.uv] * 4, m.tint, True)
    k.face([top[0][0], top[0][1], bot[0][1], bot[0][0]], [m.uv] * 4, m.tint)
    k.face([top[-1][1], top[-1][0], bot[-1][0], bot[-1][1]], [m.uv] * 4, m.tint)


def rack(spec, lod):
    r = Rng(spec.get("seed", 1))
    k = K()
    wood = pal("wood_brown", lin("#B79C80"))
    L = 2.6
    # two A-frame ends and the rails the boards lean on
    for x in (0.0, L):
        beam(k, (x, -0.55, 0.0), (x, 0.0, 1.5), 0.08, 0.08, wood, up=(1, 0, 0))
        beam(k, (x, 0.55, 0.0), (x, 0.0, 1.5), 0.08, 0.08, wood, up=(1, 0, 0))
        box(k, (x - 0.04, -0.4, 0.45), (x + 0.04, 0.4, 0.53), wood, "xXyYZ")
    for (y, z) in ((-0.2, 1.0), (0.2, 1.0), (0.0, 1.5)):
        box(k, (-0.1, y - 0.04, z - 0.04), (L + 0.1, y + 0.04, z + 0.04), wood, "yYzZ")
    for y, z in ((-0.36, 0.49), (0.36, 0.49)):
        box(k, (-0.05, y - 0.04, z - 0.04), (L + 0.05, y + 0.04, z + 0.04), wood, "yYzZ")
    # six boards, three per side, leaning on the upper rail
    nb = 3 if lod < 2 else 2
    for side in (-1, 1):
        for i in range(nb):
            x = 0.35 + i * (L - 0.7) / max(1, nb - 1)
            base = Vector((x, side * 0.75, 0.02))
            topp = Vector((x + 0.05, side * 0.08, 2.6))
            surfboard(k, base, topp - base, (0, -side, 0.2), 2.75, 0.56, r.pick(BOARDS), lod)
    return k, {"footprint": [-0.3, L + 0.3, -0.9, 0.9], "height": 2.7, "overhang": 0.0, "foundation": 0.0,
               "ao_dist": 0.6, "grime": False}


def render(objs, R, out_dir, tag):
    import os
    so, mp, info = R.setup()
    R.slab("sand", -60, 60, -60, 60, 0.0, R.ground_mat("sand", 6.0))
    R.aim_sun(so, mp, info, -40, 28)
    R.place(objs["lifeguard_tower"][0], "tower", (0, 0, 0))
    R.place(objs["surfboard_rack"][0], "rack", (-6, -2, 0), 0.4)
    R.shoot(os.path.join(out_dir, "beachprops_tower_%s.png" % tag), (-9, -12, 2.2), (0, 1.5, 2.6), lens=30)
    R.shoot(os.path.join(out_dir, "beachprops_rack_%s.png" % tag), (-9.5, -6.5, 1.5), (-5, -1.2, 1.0), lens=35)
