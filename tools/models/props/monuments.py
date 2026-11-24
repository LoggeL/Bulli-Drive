# Bulli Drive -- 12 Bespoke Hero Monument GLBs (Blender 5.2 procedural build)
#
# Usage:
#   blender -b --factory-startup --python tools/models/props/monuments.py -- \
#       --out=<raw_dir> --meta=<meta.json> [--only=id1,id2] [--preview=<png_dir>] [--no-ao]
import os, sys, math, json
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))
from bd_props import *  # noqa: E402,F403


# --------------------------------------------------------------------------
# 1. lmf_forge_arch — Grand steel anvil arch with glowing ember forge
# --------------------------------------------------------------------------
def build_lmf_forge_arch(root):
    mb = MB()
    # Twin stepped stone & forged-steel piers with clear 11.6m W x 7.6m H drive-through
    for sx in (-1, 1):
        cx = sx * 7.2
        bevel_box(mb, (cx, 0, 0.55), (3.8, 4.4, 1.1), "stone_dark", bev=0.14)
        foundation_skirt_box(mb, cx, 0, 3.8, 4.4, 2.8, mat="stone_dark", bev=0.14)
        bevel_box(mb, (cx, 0, 1.45), (3.2, 3.8, 0.7), "forge_coal", bev=0.10)
        # Tapered forged-steel buttress column
        bevel_box(mb, (cx, 0, 4.9), (2.5, 3.0, 6.2), "forge_steel", bev=0.12)
        # Outer angled buttress fin
        bevel_box(mb, (cx + sx * 1.45, 0, 3.8), (0.8, 2.0, 4.6), "forge_coal", bev=0.08,
                  M=rot_y(-sx * 10))
        # 4 glowing LMF alloy forge energy bands wrapping each pier base
        for k, amat in enumerate(("alloy_gold", "alloy_purpur", "alloy_blau", "alloy_rotglut")):
            bevel_box(mb, (cx, 0, 2.25 + k * 0.62), (2.68, 3.18, 0.20), amat, bev=0.04)
        # Riveted steel capital plates
        bevel_box(mb, (cx, 0, 8.15), (3.0, 3.4, 0.45), "steel_dark", bev=0.07)
        for sy in (-1, 1):
            for rx in (-0.9, 0.0, 0.9):
                sphere(mb, (cx + rx, sy * 1.54, 6.8), 0.09, "brass", segs=8, rings=4)
                sphere(mb, (cx + rx, sy * 1.54, 8.15), 0.09, "brass", segs=8, rings=4)

    # Heavy forged-steel segmented arch span (clear underside ~7.6m at crown)
    arch_vault(mb, 0.0, 5.2, 5.95, 2.55, 2.8, 0.95, 16, "forge_steel", keystone_mat="brass")
    # Glowing ember inner trim rib lining the soffit
    arch_vault(mb, 0.0, 5.2, 5.88, 2.48, 0.45, 0.18, 16, "ember_glow")

    # Iconic massive Anvil Crown beam across top (z = 8.4 .. 10.6)
    bevel_box(mb, (0, 0, 8.85), (17.2, 3.2, 0.9), "forge_coal", bev=0.12)
    bevel_box(mb, (0, 0, 9.85), (15.6, 2.7, 1.1), "forge_steel", bev=0.14)
    bevel_box(mb, (0, 0, 10.65), (18.4, 3.1, 0.55), "steel_light", bev=0.10)
    # Tapered forged anvil horns projecting left and right
    for sx in (-1, 1):
        cyl(mb, (sx * 8.6, 0, 10.35), (sx * 10.9, 0, 10.55), 0.72, 0.16, 10, "forge_steel")

    # Glowing Ember Forge Crucible nestled at the crown center
    bevel_box(mb, (0, 0, 11.45), (4.6, 2.4, 1.05), "forge_coal", bev=0.10)
    bevel_box(mb, (0, 0, 11.95), (3.8, 1.7, 0.45), "ember_glow", bev=0.06)
    # Glowing molten coal mounds
    for cx, cy, r in ((-1.1, 0, 0.52), (0.0, 0.1, 0.68), (1.1, -0.05, 0.50), (-0.5, -0.2, 0.46), (0.6, 0.15, 0.48)):
        sphere(mb, (cx, cy, 12.15), r, "ember_core", segs=10, rings=6, sz=0.65)

    # Raised 3D LMF monogram badge on front (-Y) and rear (+Y) anvil faces
    for sy in (-1, 1):
        y = sy * 1.48
        # Diamond shield backing
        bevel_box(mb, (0, y, 9.85), (3.4, 0.24, 1.75), "forge_coal", bev=0.06)
        bevel_box(mb, (0, y + sy * 0.08, 9.85), (3.1, 0.14, 1.48), "brass", bev=0.04)
        # Stylized 3D glowing L - M - F strokes (flipped X on rear so it reads cleanly both ways)
        fy = y + sy * 0.18
        fx = -sy  # front (sy=-1) -> +1 (left=-X, right=+X); rear (sy=+1) -> -1
        # L
        box(mb, (fx * -1.05, fy, 9.85), (0.16, 0.12, 0.92), "lmf_red_glow")
        box(mb, (fx * -0.82, fy, 9.47), (0.58, 0.12, 0.16), "lmf_red_glow")
        # M
        box(mb, (fx * -0.35, fy, 9.85), (0.15, 0.12, 0.92), "ember_core")
        box(mb, (fx * 0.35, fy, 9.85), (0.15, 0.12, 0.92), "ember_core")
        box(mb, (fx * -0.17, fy, 10.02), (0.14, 0.12, 0.58), "ember_core", M=rot_y(fx * 28))
        box(mb, (fx * 0.17, fy, 10.02), (0.14, 0.12, 0.58), "ember_core", M=rot_y(-fx * 28))
        # F
        box(mb, (fx * 0.72, fy, 9.85), (0.16, 0.12, 0.92), "lmf_red_glow")
        box(mb, (fx * 0.98, fy, 10.23), (0.62, 0.12, 0.16), "lmf_red_glow")
        box(mb, (fx * 0.92, fy, 9.88), (0.48, 0.12, 0.15), "lmf_red_glow")

    return {"body": mb, "children": {}}


# --------------------------------------------------------------------------
# 2. lmf_red_knopf — Industrial pedestal + animatable knopf_cap
# --------------------------------------------------------------------------
def build_lmf_red_knopf(root):
    mb = MB()
    M_id = Matrix.Identity(3)
    # Heavy octagonal steel pedestal base (r = 3.30m -> 2.75m, z = -1.5..2.42m incl. foundation skirt)
    lathe(mb, [(0.0, -1.5), (3.30, -1.5), (3.30, 0.0), (3.30, 0.45), (3.05, 0.65),
               (2.88, 1.85), (3.08, 2.02), (3.08, 2.42), (2.45, 2.42), (2.45, 2.15), (0.0, 2.15)],
          8, M_id, Vector((0, 0, 0)),
          ["concrete", "concrete", "forge_coal", "forge_steel", "forge_coal", "steel_dark",
           "forge_steel", "steel_light", "forge_coal", "forge_coal"])

    # Alternating hazard yellow warning chevron blocks around the mid skirt
    for k in range(8):
        a = 2 * pi * (k + 0.5) / 8
        c = Vector((math.cos(a) * 2.86, math.sin(a) * 2.86, 1.25))
        mat = "hazard_yellow" if k % 2 == 0 else "forge_coal"
        bevel_box(mb, c, (0.28, 1.65, 0.62), mat, bev=0.03, M=rot_z(math.degrees(a)))

    # 8 brass anchor bolts on the top collar + glowing ember activation ring
    for k in range(8):
        a = 2 * pi * k / 8
        cyl(mb, (math.cos(a) * 2.78, math.sin(a) * 2.78, 2.40),
            (math.cos(a) * 2.78, math.sin(a) * 2.78, 2.56), 0.14, 0.12, 6, "brass")
    torus(mb, (0, 0, 2.43), 2.48, 0.09, 24, 6, "ember_glow")

    # Twin industrial steel power conduits descending left & right sides
    for sx in (-1, 1):
        tube(mb, [(sx * 2.85, 0, 2.05), (sx * 3.35, 0, 1.85), (sx * 3.35, 0, 0.30), (sx * 3.15, 0, 0.18)],
             0.13, 8, "steel_galv")

    # Animatable child: glossy oversized red button dome (pivot at base z=2.35)
    cap = MB()
    lathe(cap, [(0.0, 2.10), (2.22, 2.10), (2.34, 2.38), (2.36, 2.85),
                (2.26, 3.18), (1.96, 3.54), (1.42, 3.82), (0.72, 3.98), (0.0, 4.04)],
          24, M_id, Vector((0, 0, 0)),
          ["chrome", "chrome", "lmf_red", "lmf_red", "lmf_red", "lmf_red", "lmf_red", "lmf_red"])
    torus(cap, (0, 0, 3.68), 1.38, 0.075, 24, 6, "lmf_red_glow")

    return {"body": mb, "children": {"knopf_cap": (cap, (0.0, 0.0, 2.35), True)}}


# --------------------------------------------------------------------------
# 3. lmf_jet_loop_reactor — 26m glass chemical reactor + reactor_bubbles
# --------------------------------------------------------------------------
def build_lmf_jet_loop_reactor(root):
    mb = MB()
    M_id = Matrix.Identity(3)

    # Reinforced octagonal concrete plinth + steel ring foundation (skirt to z = -2.8m)
    lathe(mb, [(0.0, -2.8), (4.1, -2.8), (4.1, 0.0), (4.1, 0.6), (3.7, 0.9), (3.5, 1.35), (0.0, 1.35)],
          8, M_id, Vector((0, 0, 0)), ["concrete", "concrete", "concrete", "concrete", "steel_dark", "steel_dark"])

    # 6 angled heavy steel support legs cradling the lower reactor flange
    for k in range(6):
        a = 2 * pi * k / 6
        p0 = (math.cos(a) * 3.05, math.sin(a) * 3.05, 1.25)
        p1 = (math.cos(a) * 1.95, math.sin(a) * 1.95, 4.10)
        cyl(mb, p0, p1, 0.22, 0.20, 8, "forge_steel")

    # Lower steel cone sump & nozzle chamber (z = 1.8 .. 4.0)
    lathe(mb, [(0.0, 1.8), (0.65, 1.9), (1.35, 2.5), (1.82, 3.65), (2.10, 3.72), (2.10, 4.02), (1.76, 4.02)],
          18, M_id, Vector((0, 0, 0)),
          ["steel_dark", "forge_steel", "steel_light", "steel_light", "steel_galv", "steel_light"])

    # Main 18m tall translucent glass outer reaction column (z = 4.0 .. 22.0)
    lathe(mb, [(1.76, 4.02), (1.76, 22.0)], 20, M_id, Vector((0, 0, 0)), ["glass_clear"])

    # Inner coaxial stainless-steel draft tube visible through glass (z = 5.4 .. 20.6)
    lathe(mb, [(0.86, 5.4), (0.94, 5.4), (0.94, 20.6), (0.86, 20.6)], 14, M_id, Vector((0, 0, 0)),
          ["steel_light", "steel_galv", "steel_light"])
    # Internal radial spider support struts holding the draft tube
    for z_sp in (6.5, 13.0, 19.5):
        for k in range(3):
            a = 2 * pi * k / 3 + z_sp * 0.2
            cyl(mb, (math.cos(a) * 0.94, math.sin(a) * 0.94, z_sp),
                (math.cos(a) * 1.72, math.sin(a) * 1.72, z_sp), 0.06, 0.06, 5, "steel_dark")

    # Machined bolted steel flange collars along the glass column
    for zf in (8.5, 13.0, 17.5, 22.0):
        lathe(mb, [(1.74, zf - 0.16), (2.12, zf - 0.16), (2.12, zf + 0.16), (1.74, zf + 0.16)],
              18, M_id, Vector((0, 0, 0)), ["steel_light", "steel_galv", "steel_light"])

    # Upper steel separator dome + pressure stack + red warning beacon to z = 26.0m
    lathe(mb, [(1.82, 22.15), (1.75, 23.0), (1.35, 23.85), (0.72, 24.35),
               (0.42, 24.45), (0.42, 25.55), (0.58, 25.60), (0.58, 25.72), (0.0, 25.72)],
          18, M_id, Vector((0, 0, 0)),
          ["steel_light", "steel_light", "forge_steel", "steel_light",
           "steel_dark", "steel_light", "steel_light", "steel_dark"])
    sphere(mb, (0, 0, 25.92), 0.24, "led_red", segs=10, rings=6)

    # Iconic external Jet-Loop recirculation return pipe (+X side) + pump + red valve wheel
    loop_path = [
        (0.95, 0, 23.4), (2.35, 0, 23.2), (3.25, 0, 22.2),
        (3.35, 0, 13.0), (3.35, 0, 3.2), (2.85, 0, 2.1),
        (1.65, 0, 1.95), (0.0, 0, 1.95),
    ]
    tube(mb, loop_path, 0.26, 10, "copper")
    # Pump housing & red handwheel valve on return leg
    bevel_box(mb, (3.35, 0, 2.7), (0.95, 0.95, 1.05), "forge_steel", bev=0.08)
    torus(mb, (3.35, -0.68, 4.6), 0.42, 0.055, 14, 5, "lmf_red", axis=(0, 1, 0))
    cyl(mb, (3.35, -0.22, 4.6), (3.35, -0.68, 4.6), 0.06, 0.06, 6, "chrome")

    # Twin cantilevered inspection catwalk platforms + safety railings + vertical ladder (-X side)
    for zc in (8.6, 17.6):
        lathe(mb, [(1.95, zc - 0.14), (3.15, zc - 0.14), (3.15, zc), (1.95, zc)],
              14, M_id, Vector((0, 0, 0)), ["steel_dark", "steel_galv", "steel_dark"])
        torus(mb, (0, 0, zc + 1.05), 3.08, 0.045, 16, 4, "hazard_yellow")
        for k in range(8):
            a = 2 * pi * k / 8
            cyl(mb, (math.cos(a) * 3.08, math.sin(a) * 3.08, zc),
                (math.cos(a) * 3.08, math.sin(a) * 3.08, zc + 1.05), 0.04, 0.04, 5, "hazard_yellow")
    # Ladder on -X side
    for dy in (-0.28, 0.28):
        cyl(mb, (-3.25, dy, 0.6), (-3.25, dy, 18.7), 0.045, 0.045, 5, "steel_galv")
    for k in range(28):
        zr = 1.2 + k * 0.62
        cyl(mb, (-3.25, -0.28, zr), (-3.25, 0.28, zr), 0.025, 0.025, 4, "steel_galv")

    # Animatable child: rising helical stream of glowing bubbles inside the glass column
    bub = MB()
    for i in range(24):
        t = i / 23.0
        a = i * 1.15
        r = 1.24 + 0.22 * math.sin(i * 1.7)
        z = 4.9 + t * 16.0
        rad = 0.16 + 0.12 * ((i * 7) % 5) / 4.0
        sphere(bub, (math.cos(a) * r, math.sin(a) * r, z), rad,
               "led_cyan" if i % 3 == 0 else "bubble_glass", segs=8, rings=5)

    return {"body": mb, "children": {"reactor_bubbles": (bub, (0.0, 0.0, 13.0), True)}}


# --------------------------------------------------------------------------
# 4. lmf_arcanum_tower — 22m wizard spire + glowing rune ring + arcanum_key
# --------------------------------------------------------------------------
def build_lmf_arcanum_tower(root):
    mb = MB()
    M_id = Matrix.Identity(3)

    # Octagonal battered medieval stone base + underground plinth skirt to z = -3.0m
    lathe(mb, [(0.0, -3.0), (4.15, -3.0), (4.15, 0.0), (3.85, 2.2), (3.25, 3.0),
               (3.05, 11.2), (3.45, 11.75), (3.45, 15.1), (3.75, 15.35), (0.0, 15.35)],
          8, M_id, Vector((0, 0, 0)),
          ["stone_dark", "stone_dark", "stone_dark", "stone_warm", "stone_warm",
           "stone_light", "stone_warm", "stone_light", "stone_dark"])

    # 8 stepped vertical corner stone buttresses
    for k in range(8):
        a = 2 * pi * k / 8
        c = Vector((math.cos(a) * 3.35, math.sin(a) * 3.35, 5.2))
        bevel_box(mb, c, (0.75, 0.65, 10.4), "stone_dark", bev=0.06, M=rot_z(math.degrees(a)))

    # Front (-Y) Gothic pointed wizard doorway with glowing arcane interior + foundation skirt
    bevel_box(mb, (0, -3.55, 1.9), (2.7, 0.9, 3.8), "stone_light", bev=0.08)
    foundation_skirt_box(mb, 0, -3.55, 2.7, 0.9, 3.0, mat="stone_dark", bev=0.08)
    arch_vault(mb, -3.85, 2.2, 0.95, 1.35, 0.65, 0.32, 10, "stone_dark", pointed=True)
    box(mb, (0, -3.72, 1.65), (1.72, 0.25, 3.15), "rune_violet")

    # 8 glowing lancet observatory windows around the upper drum (z = 12.2 .. 14.5)
    for k in range(8):
        a = 2 * pi * (k + 0.5) / 8
        R_w = 3.22
        c = Vector((math.cos(a) * R_w, math.sin(a) * R_w, 13.4))
        M = rot_z(math.degrees(a))
        box(mb, c, (0.25, 0.82, 2.1), "stone_dark", M=M)
        box(mb, c + Vector((math.cos(a) * 0.08, math.sin(a) * 0.08, 0)), (0.14, 0.58, 1.82), "warm_window", M=M)

    # Steep octagonal dark-slate witch-hat spire roof (z = 15.2 .. 21.4) + gold finial to 22.3m
    lathe(mb, [(4.15, 15.15), (3.95, 15.55), (2.35, 18.2), (1.05, 20.1), (0.14, 21.45), (0.0, 21.55)],
          8, M_id, Vector((0, 0, 0)),
          ["timber_dark", "slate_roof", "slate_roof", "slate_roof", "slate_roof"])
    cyl(mb, (0, 0, 21.4), (0, 0, 22.35), 0.12, 0.03, 8, "gold")
    sphere(mb, (0, 0, 21.85), 0.24, "gold", segs=10, rings=6)

    # Tilted floating Arcane Rune Ring encircling the upper tower
    M_ring = rot_x(11) @ rot_y(-9)
    ctr_r = Vector((0, 0, 12.4))
    pts_r = [ctr_r + M_ring @ Vector((4.45 * math.cos(2 * pi * k / 24), 4.45 * math.sin(2 * pi * k / 24), 0))
             for k in range(24)]
    tube(mb, pts_r, 0.12, 6, "brass", closed=True)
    # 12 glowing rune crystals orbiting on the ring
    for k in range(12):
        a = 2 * pi * k / 12
        p = ctr_r + M_ring @ Vector((4.45 * math.cos(a), 4.45 * math.sin(a), 0))
        bevel_box(mb, p, (0.28, 0.28, 0.62), "rune_violet", bev=0.05, M=M_ring @ rot_z(math.degrees(a)))

    # Animatable child: giant hovering brass/gold wizard skeleton key in front of tower
    key = MB()
    kp = Vector((0.0, -4.6, 8.8))
    # Ornate trefoil key bow (top ring)
    torus(key, kp + Vector((0, 0, 0.95)), 0.56, 0.11, 14, 6, "gold", axis=(0, 1, 0))
    for sx in (-0.42, 0.42):
        torus(key, kp + Vector((sx, 0, 1.32)), 0.26, 0.08, 10, 5, "gold", axis=(0, 1, 0))
    sphere(key, kp + Vector((0, 0, 0.95)), 0.22, "rune_violet", segs=8, rings=5)
    # Turned vertical key shaft + collars
    cyl(key, kp + Vector((0, 0, 0.42)), kp + Vector((0, 0, -1.25)), 0.12, 0.10, 10, "brass")
    for zc in (0.35, -0.25, -1.25):
        sphere(key, kp + Vector((0, 0, zc)), 0.17, "gold", segs=8, rings=4, sz=0.6)
    # Notched ornate key bit teeth
    bevel_box(key, kp + Vector((0.42, 0, -0.82)), (0.72, 0.14, 0.52), "gold", bev=0.03)
    box(key, kp + Vector((0.28, 0, -1.10)), (0.18, 0.14, 0.22), "brass")
    box(key, kp + Vector((0.64, 0, -1.10)), (0.18, 0.14, 0.28), "brass")

    return {"body": mb, "children": {"arcanum_key": (key, tuple(kp), True)}}


# --------------------------------------------------------------------------
# 5. lmf_selantis_arch — Weathered castle gatehouse ruins + Harras plinth
# --------------------------------------------------------------------------
def build_lmf_selantis_arch(root):
    mb = MB()
    # Twin battered flanking castle towers (clear 10.0m W x 6.8m H drive-through)
    tower_heights = (-1, 12.2), (1, 13.4)
    for sx, th in tower_heights:
        cx = sx * 6.8
        bevel_box(mb, (cx, 0, 0.9), (4.2, 4.6, 1.8), "stone_dark", bev=0.14)
        foundation_skirt_box(mb, cx, 0, 4.2, 4.6, 3.0, mat="stone_dark", bev=0.14)
        bevel_box(mb, (cx, 0, 1.8 + (th - 1.8) / 2), (3.6, 4.0, th - 1.8), "stone_warm", bev=0.12)
        # Projecting upper parapet ring
        bevel_box(mb, (cx, 0, th - 0.3), (3.9, 4.3, 0.65), "stone_light", bev=0.08)
        # Crumbling asymmetric crenellations (merlons)
        merlons = [(-1.35, -1.55, 1.15), (0.0, -1.55, 0.75), (1.35, -1.55, 1.25),
                   (-1.35, 1.55, 1.20), (1.35, 1.55, 0.85), (sx * 1.5, 0.0, 1.05)]
        for mx, my, mh in merlons:
            bevel_box(mb, (cx + mx, my, th + mh / 2), (0.85, 0.75, mh), "stone_warm", bev=0.06)
        # Arrow-slit embrasures on front & back
        for sy in (-1, 1):
            for zs in (4.8, 8.6):
                box(mb, (cx, sy * 2.02, zs), (0.32, 0.12, 1.65), "forge_coal")
        # Hanging moss / ivy accents on weathered stone
        for mx, my, mz, mw, mh in ((sx * 1.75, -1.2, th - 1.6, 0.45, 2.2),
                                   (sx * -1.4, -2.02, 7.8, 1.1, 1.8),
                                   (sx * 0.8, 2.02, 5.2, 1.3, 2.4)):
            bevel_box(mb, (cx + mx, my, mz), (mw, 0.35, mh), "moss", bev=0.08)

    # Vaulted limestone gateway arch (clear opening 10.0m W x 6.9m H)
    arch_vault(mb, 0.0, 4.6, 5.0, 2.45, 3.6, 1.15, 14, "stone_warm", keystone_mat="stone_light")
    # Ruined bridge parapet spanning between towers
    bevel_box(mb, (0, 0, 8.35), (10.4, 3.5, 1.15), "stone_warm", bev=0.10)
    # Raised iron portcullis teeth visible beneath arch crown
    box(mb, (0, -0.35, 6.72), (8.2, 0.22, 0.22), "steel_dark")
    for k in range(-4, 5):
        cyl(mb, (k * 0.88, -0.35, 6.72), (k * 0.88, -0.35, 5.95), 0.09, 0.02, 6, "steel_dark")

    # Central Harras Memorial Plinth & Heraldic Crest atop the gatehouse
    bevel_box(mb, (0, 0, 9.65), (3.4, 2.2, 1.45), "stone_light", bev=0.10)
    bevel_box(mb, (0, 0, 10.75), (2.4, 1.6, 0.85), "stone_warm", bev=0.08)
    for sy in (-1, 1):
        # Brass heraldic shield & emblem
        bevel_box(mb, (0, sy * 1.15, 9.65), (1.35, 0.18, 1.55), "brass", bev=0.06)
        bevel_box(mb, (0, sy * 1.24, 9.65), (0.85, 0.10, 1.05), "lmf_red", bev=0.04)

    # Twin glowing iron gatehouse fire braziers on front piers
    for sx in (-1, 1):
        bx, by, bz = sx * 4.85, -2.25, 4.55
        tube(mb, [(sx * 5.05, -2.0, 3.95), (bx, by, bz - 0.1)], 0.09, 6, "steel_dark")
        lathe(mb, [(0.0, 0.0), (0.32, 0.05), (0.54, 0.45), (0.45, 0.48), (0.0, 0.32)],
              10, Matrix.Identity(3), Vector((bx, by, bz)), ["steel_dark", "steel_dark", "steel_dark", "ember_glow"])
        sphere(mb, (bx, by, bz + 0.56), 0.34, "ember_core", segs=8, rings=5, sz=1.35)

    return {"body": mb, "children": {}}


# --------------------------------------------------------------------------
# 6. lmf_theater_facade — Kolpingtheater Ramsen red-curtain marquee facade
# --------------------------------------------------------------------------
def build_lmf_theater_facade(root):
    mb = MB()
    # 3-step grand stone entrance plinth (20m W x 5.4m D) + deep foundation skirt to z = -2.8m
    for k in range(3):
        bevel_box(mb, (0, -0.35 * (2 - k), 0.10 + k * 0.20), (20.0 - k * 0.4, 5.4 - k * 0.35, 0.20),
                  "stone_light", bev=0.03)
    foundation_skirt_box(mb, 0, -0.70, 20.0, 5.4, 2.8, mat="stone_dark", bev=0.03)
    # Rear stone foundation supporting the rear hall wall overhang (y in [1.94, 2.38], z in [-2.8, 0.68])
    box(mb, (0, 2.16, -1.06), (19.04, 0.44, 3.48), "stone_dark")

    # Main Neo-classical hall facade blocks flanking the grand proscenium stage opening
    bevel_box(mb, (0, 1.35, 5.1), (19.2, 2.1, 9.0), "plaster_cream", bev=0.08)
    for sx in (-1, 1):
        bevel_box(mb, (sx * 7.1, -0.55, 5.1), (5.0, 2.6, 9.0), "plaster_cream", bev=0.08)
        # Fluted classical pilasters
        for px in (-1.85, 1.85):
            bevel_box(mb, (sx * 7.1 + px, -1.92, 5.0), (0.65, 0.38, 8.4), "plaster_ochre", bev=0.04)
            bevel_box(mb, (sx * 7.1 + px, -1.94, 9.3), (0.85, 0.48, 0.35), "stone_light", bev=0.04)
        # Illuminated brass poster display box on each wing
        bevel_box(mb, (sx * 7.1, -1.92, 3.7), (2.25, 0.26, 3.15), "brass", bev=0.04)
        box(mb, (sx * 7.1, -2.04, 3.7), (1.92, 0.08, 2.82), "warm_window")

    # Upper classical entablature + triangular pediment gable (z = 9.5 .. 12.1)
    bevel_box(mb, (0, -0.2, 9.85), (20.2, 4.4, 0.85), "plaster_ochre", bev=0.06)
    gable_roof(mb, 0.0, 0.1, 10.25, 20.4, 4.6, 2.05, 0.32, "slate_roof", mat_gable="plaster_cream")
    # Central gold theater crest medallion inside the pediment
    cyl(mb, (0, -2.02, 11.15), (0, -2.24, 11.15), 0.72, 0.68, 14, "gold")
    cyl(mb, (0, -2.24, 11.15), (0, -2.30, 11.15), 0.48, 0.48, 12, "lmf_red")

    # Recessed proscenium stage interior + warm glowing footlight backdrop
    box(mb, (0, 0.25, 4.3), (9.2, 0.25, 7.4), "forge_coal")
    box(mb, (0, 0.08, 4.3), (7.6, 0.10, 6.2), "warm_window")
    # Sculpted pleated crimson velvet theater curtains (swagged valance + gathered side drapes)
    for k in range(11):
        x = -4.2 + k * 0.84
        cyl(mb, (x, -1.55, 7.65), (x, -1.55, 6.75 - 0.22 * math.cos(k * 0.9)), 0.46, 0.40, 8, "velvet_red")
    for sx in (-1, 1):
        for j in range(5):
            x = sx * (3.15 + j * 0.36)
            # Sweeping tied-back curtain folds
            tube(mb, [(x, -1.52, 7.4), (x - sx * 0.12, -1.48, 5.0),
                      (x + sx * 0.35, -1.42, 3.4), (x + sx * 0.15, -1.48, 0.7)],
                 0.28, 7, "velvet_red")
        # Gold curtain tie-back cord & tassel
        torus(mb, (sx * 4.05, -1.35, 3.4), 0.55, 0.09, 12, 5, "gold", axis=(0.25 * sx, 0, 1))
        sphere(mb, (sx * 3.55, -1.55, 2.95), 0.20, "gold", segs=8, rings=5, sz=1.5)

    # Classic projecting Theater Marquee Canopy studded with warm glowing bulbs
    bevel_box(mb, (0, -2.85, 8.35), (11.6, 2.35, 1.05), "lmf_red", bev=0.06)
    bevel_box(mb, (0, -2.85, 8.95), (11.9, 2.55, 0.22), "gold", bev=0.03)
    bevel_box(mb, (0, -2.85, 7.75), (11.9, 2.55, 0.22), "gold", bev=0.03)
    # Row of glowing marquee light bulbs across front & sides
    for k in range(13):
        bx = -5.4 + k * 0.90
        sphere(mb, (bx, -4.08, 8.35), 0.13, "marquee_bulb", segs=8, rings=5)
    for sx in (-1, 1):
        for k in range(3):
            sphere(mb, (sx * 5.88, -2.1 - k * 0.85, 8.35), 0.13, "marquee_bulb", segs=8, rings=5)

    return {"body": mb, "children": {}}


# --------------------------------------------------------------------------
# 7. lmf_melodai_arch — Giant dual-fader audio mixer arch + fader_gesang
# --------------------------------------------------------------------------
def build_lmf_melodai_arch(root):
    mb = MB()
    # Twin console piers (clear 10.4m W x 7.4m H drive-through)
    for sx in (-1, 1):
        cx = sx * 6.6
        bevel_box(mb, (cx, 0, 0.45), (3.3, 4.0, 0.9), "steel_dark", bev=0.08)
        foundation_skirt_box(mb, cx, 0, 3.3, 4.0, 2.8, mat="stone_dark", bev=0.08)
        bevel_box(mb, (cx, 0, 6.45), (2.8, 3.5, 11.2), "forge_coal", bev=0.10)
        # Brushed aluminum side cheek trim
        bevel_box(mb, (cx + sx * 1.44, 0, 6.45), (0.18, 3.3, 10.9), "steel_light", bev=0.04)

        # Front (-Y) and Back (+Y) recessed fader slots & glowing LED VU meters
        for sy in (-1, 1):
            yf = sy * 1.78
            # Dark recessed vertical fader slot track
            box(mb, (cx - sx * 0.35, yf, 5.6), (0.34, 0.14, 7.4), "rubber_black")
            # Horizontal white dB tick marks beside fader slot
            for tk in range(11):
                zt = 2.2 + tk * 0.68
                box(mb, (cx - sx * 0.35, yf + sy * 0.03, zt), (0.92, 0.04, 0.06), "steel_light")
            # Vertical 10-segment glowing LED VU meter column
            for vk in range(10):
                zv = 2.4 + vk * 0.68
                vmat = "led_green" if vk < 6 else ("led_amber" if vk < 8 else "led_red")
                box(mb, (cx + sx * 0.62, yf + sy * 0.04, zv), (0.48, 0.10, 0.44), vmat)

    # Fixed right-side INSTRUMENTAL fader cap parked at 75% (front face)
    bevel_box(mb, (6.25, -2.02, 7.2), (1.15, 0.56, 0.72), "steel_light", bev=0.06)
    box(mb, (6.25, -2.31, 7.2), (1.05, 0.06, 0.10), "alloy_blau")

    # Overhead angled Studio Meter Bridge spanning the drive-through (z = 7.6 .. 12.8)
    bevel_box(mb, (0, 0, 10.1), (16.4, 3.6, 5.0), "forge_coal", bev=0.14)
    bevel_box(mb, (0, 0, 7.68), (11.2, 3.4, 0.30), "steel_light", bev=0.04)
    # Glowing waveform display strip across front & back of bridge
    for sy in (-1, 1):
        yf = sy * 1.84
        box(mb, (0, yf, 9.25), (9.8, 0.12, 1.55), "rubber_black")
        for bk in range(17):
            bx = -4.2 + bk * 0.525
            bh = 0.35 + 0.95 * (0.5 + 0.5 * math.sin(bk * 0.75 + 0.4))
            bmat = "alloy_purpur" if bk % 2 == 0 else "alloy_blau"
            box(mb, (bx, yf + sy * 0.06, 9.25), (0.28, 0.08, bh), bmat)
        # 6 brushed-metal rotary EQ gain knobs along top bridge
        for kk in range(6):
            kx = -3.75 + kk * 1.50
            cyl(mb, (kx, yf, 11.25), (kx, yf + sy * 0.48, 11.25), 0.38, 0.32, 12, "steel_light")
            cyl(mb, (kx, yf + sy * 0.48, 11.25), (kx, yf + sy * 0.54, 11.25), 0.24, 0.24, 10, "forge_coal")
            box(mb, (kx, yf + sy * 0.54, 11.42), (0.07, 0.05, 0.18), "led_cyan")

    # Animatable child: oversized GESANG channel fader on left pier front face (pivot at center)
    fg = MB()
    fp = Vector((-6.25, -2.02, 5.6))
    cyl(fg, fp + Vector((0, 0.28, 0)), fp + Vector((0, -0.05, 0)), 0.10, 0.10, 8, "chrome")
    bevel_box(fg, fp, (1.28, 0.62, 0.82), "ivory", bev=0.08)
    box(fg, fp + Vector((0, -0.32, 0)), (1.16, 0.08, 0.12), "lmf_red_glow")

    return {"body": mb, "children": {"fader_gesang": (fg, tuple(fp), True)}}


# --------------------------------------------------------------------------
# 8. lmf_codex_monolith — 4x1 quota tower with red bar bursting past 100%!
# --------------------------------------------------------------------------
def build_lmf_codex_monolith(root):
    mb = MB()
    # Heavy stepped dark plinth + deep underground foundation skirt to z = -3.0m
    bevel_box(mb, (0, 0, 0.55), (6.6, 3.8, 1.1), "forge_coal", bev=0.10)
    foundation_skirt_box(mb, 0, 0, 6.6, 3.8, 3.0, mat="stone_dark", bev=0.10)
    bevel_box(mb, (0, 0, 1.20), (5.8, 3.0, 0.22), "alloy_blau", bev=0.04)

    # Tall sleek 4x1 dark-steel & glass quota widget tower (x in [-2.6, +2.6], z in [1.3, 14.3])
    bevel_box(mb, (-2.38, 0, 7.8), (0.55, 2.4, 13.0), "forge_steel", bev=0.07)   # left frame pillar
    bevel_box(mb, (2.38, 0, 5.05), (0.55, 2.4, 7.5), "forge_steel", bev=0.07)    # right lower pillar
    bevel_box(mb, (2.38, 0, 13.1), (0.55, 2.4, 2.4), "forge_steel", bev=0.07)    # right upper pillar (gap at 8.8..11.9!)
    bevel_box(mb, (0, 0, 14.15), (5.35, 2.55, 0.65), "forge_coal", bev=0.08)     # top cap
    bevel_box(mb, (0, 0, 1.55), (5.35, 2.55, 0.55), "forge_coal", bev=0.08)      # bottom sill
    # Dark interior backing slab & translucent front/back glass panels
    box(mb, (0, 0.35, 7.8), (4.4, 0.45, 12.2), "forge_coal")
    box(mb, (0, -0.95, 5.0), (4.35, 0.10, 6.8), "glass_dark")
    box(mb, (0, -0.95, 13.0), (4.35, 0.10, 2.0), "glass_dark")

    # Top glowing cyan header status strip (CodexBar header)
    bevel_box(mb, (0, -1.05, 13.25), (3.9, 0.25, 0.52), "led_cyan", bev=0.04)

    # Vertical 25/50/75/100% scale ruler ticks inside the glass frame
    for tk, fx in enumerate((-1.95, -0.95, 0.05, 1.05, 2.05)):
        tmat = "hazard_yellow" if tk == 4 else "steel_light"
        box(mb, (fx, -0.82, 7.6), (0.07, 0.08, 10.6), tmat)

    # Lower normal-range progress bars (65% blue, 92% amber)
    bevel_box(mb, (-0.75, -0.45, 3.6), (2.75, 0.95, 1.35), "alloy_blau", bev=0.08)
    bevel_box(mb, (-0.15, -0.45, 6.4), (3.95, 0.95, 1.35), "alloy_gold", bev=0.08)

    # THE ICONIC GAG: Oversized 175% crimson-red quota bar literally smashing 4.5m out the right wall!
    bevel_box(mb, (2.55, -0.25, 10.35), (9.3, 1.55, 2.05), "lmf_red_glow", bev=0.10)
    bevel_box(mb, (6.85, -0.25, 10.35), (0.95, 1.65, 2.15), "ember_core", bev=0.08)
    # Jagged blowout steel frame rim around the breach at x = +2.45
    for ang_deg in range(0, 360, 45):
        a = math.radians(ang_deg)
        p = Vector((2.55 + 0.18 * math.cos(a), -0.25 + math.sin(a) * 0.95, 10.35 + math.cos(a) * 1.18))
        bevel_box(mb, p, (0.48, 0.26, 0.26), "forge_steel", bev=0.03, M=rot_z(ang_deg) @ rot_y(25))
    # Floating shattered translucent glass shards frozen mid-explosion around the breach!
    shards = [
        (3.4, -1.45, 11.75, 0.65, 0.55, (25, 40, -18)),
        (4.3, -1.65, 9.15,  0.55, 0.45, (-35, 22, 42)),
        (5.2,  1.25, 11.55, 0.70, 0.50, (18, -32, 15)),
        (3.8,  1.35, 8.85,  0.58, 0.42, (48, 12, -35)),
        (6.0, -1.35, 10.95, 0.48, 0.38, (-20, 55, 28)),
        (4.8, -1.55, 12.15, 0.44, 0.34, (32, -45, 12)),
        (3.1, -1.52, 8.70,  0.60, 0.48, (-15, 28, -40)),
        (6.6,  1.15, 9.55,  0.42, 0.35, (40, -18, 30)),
    ]
    for sx, sy, sz, sw, sh, (rx, ry, rz) in shards:
        box(mb, (sx, sy, sz), (sw, 0.08, sh), "glass_shard", M=rot_x(rx) @ rot_y(ry) @ rot_z(rz))

    return {"body": mb, "children": {}}


# --------------------------------------------------------------------------
# 9. lmf_festival_stage — 22m amphitheater truss stage w/ rig & vinyl monument
# --------------------------------------------------------------------------
def build_lmf_festival_stage(root):
    mb = MB()
    # Raised concert stage deck (20m W x 10m D x 1.5m H) + front stairs + deep foundation skirt (-2.8m)
    bevel_box(mb, (0, 0, 0.70), (20.2, 10.2, 1.40), "forge_coal", bev=0.06)
    foundation_skirt_box(mb, 0, 0, 20.2, 10.2, 2.8, mat="stone_dark", bev=0.06)
    box(mb, (0, 0, 1.45), (19.8, 9.8, 0.14), "timber_dark")
    for k in range(3):
        sy = -5.25 - k * 0.35
        sz = 1.20 - k * 0.42
        box(mb, (0, sy, sz), (4.6, 0.38, 0.22), "steel_dark")
        h_sub = (sz - 0.10) - (-2.80)
        box(mb, (0, sy, -2.80 + h_sub / 2), (4.52, 0.36, h_sub), "stone_dark")

    # 4 corner aluminum box-truss towers (x = +-8.2, y = +-4.2, z = 1.5 .. 10.8)
    for sx in (-1, 1):
        for sy in (-1, 1):
            truss_beam(mb, (sx * 8.2, sy * 4.2, 1.5), (sx * 8.2, sy * 4.2, 10.8),
                       0.68, 0.68, 7, 0.065, 0.035, "steel_galv")
    # Perimeter overhead box-truss spans
    truss_beam(mb, (-8.2, -4.2, 10.6), (8.2, -4.2, 10.6), 0.68, 0.68, 10, 0.065, 0.035, "steel_galv")
    truss_beam(mb, (-8.2,  4.2, 10.6), (8.2,  4.2, 10.6), 0.68, 0.68, 10, 0.065, 0.035, "steel_galv")
    for sx in (-1, 1):
        truss_beam(mb, (sx * 8.2, -4.2, 10.6), (sx * 8.2, 4.2, 10.6), 0.68, 0.68, 6, 0.065, 0.035, "steel_galv")

    # Curved festival canopy roof tarp + LMF crimson front header banner
    gable_roof(mb, 0.0, 0.0, 11.0, 18.0, 9.6, 1.85, 0.18, "canopy_dark")
    bevel_box(mb, (0, -4.58, 11.25), (15.6, 0.25, 1.05), "lmf_red", bev=0.04)
    box(mb, (0, -4.72, 11.25), (14.2, 0.06, 0.22), "alloy_gold")

    # Overhead concert floodlight cans (8 colorful stage washes along front truss)
    light_mats = ("alloy_gold", "jp_pink", "led_cyan", "alloy_purpur")
    for k in range(8):
        lx = -6.3 + k * 1.8
        cyl(mb, (lx, -4.1, 10.25), (lx, -3.7, 9.85), 0.22, 0.26, 8, "forge_coal")
        sphere(mb, (lx, -3.65, 9.82), 0.21, light_mats[k % 4], segs=8, rings=4)

    # Twin stacked PA line-array speaker wings (x = +-9.5m)
    for sx in (-1, 1):
        bevel_box(mb, (sx * 9.5, -3.2, 3.2), (1.75, 1.85, 3.4), "forge_coal", bev=0.06)
        for sk in range(4):
            zs = 5.45 + sk * 1.10
            bevel_box(mb, (sx * 9.5, -3.3 + sk * 0.06, zs), (1.65, 1.25, 0.92), "rubber_black",
                      bev=0.04, M=rot_x(6 * sk))
            box(mb, (sx * 9.5, -3.95 + sk * 0.06, zs), (1.42, 0.08, 0.72), "steel_dark")

    # Stage backdrop screen & central DJ/live console riser
    box(mb, (0, 3.85, 5.4), (14.4, 0.35, 7.6), "forge_coal")
    box(mb, (0, 3.65, 5.4), (13.2, 0.08, 6.4), "obsidian_vein")
    bevel_box(mb, (0, -0.8, 2.35), (4.2, 1.6, 1.7), "forge_steel", bev=0.06)
    box(mb, (0, -1.62, 2.55), (3.6, 0.08, 0.42), "led_cyan")

    # Giant leaning glossy black Vinyl Record sculpture on right stage wing
    vc = Vector((5.4, 0.4, 4.15))
    Mv = rot_x(82) @ rot_z(-18)
    lathe(mb, [(0.0, -0.14), (2.45, -0.14), (2.45, 0.14), (0.88, 0.15), (0.85, 0.16), (0.14, 0.16), (0.0, 0.16)],
          24, Mv, vc, ["vinyl_black", "vinyl_black", "vinyl_black", "lmf_red", "lmf_red", "gold"])

    return {"body": mb, "children": {}}


# --------------------------------------------------------------------------
# 10. lmf_sailboat_ijsselmeer — 13.5m sleek blue-hulled sailing yacht
# --------------------------------------------------------------------------
def build_lmf_sailboat_ijsselmeer(root):
    mb = MB()
    # Sleek sailing yacht hull lofted along Y (bow at -Y = -6.75, stern at +Y = +6.75, ground at z = 0)
    # Half-sections (y, [(x, z), ...]) from keel bottom -> bilge -> sheer -> deck center
    stations = [
        (-6.75, [(0.0, 1.55), (0.04, 1.58), (0.06, 1.78), (0.0, 1.82)]),
        (-5.60, [(0.0, 0.48), (0.38, 0.78), (0.72, 1.72), (0.0, 1.80)]),
        (-3.60, [(0.0, 0.18), (0.95, 0.48), (1.52, 1.62), (0.0, 1.72)]),
        (-1.00, [(0.0, 0.12), (1.35, 0.44), (1.88, 1.54), (0.0, 1.66)]),
        ( 2.00, [(0.0, 0.15), (1.32, 0.48), (1.82, 1.52), (0.0, 1.62)]),
        ( 4.60, [(0.0, 0.34), (1.02, 0.64), (1.48, 1.54), (0.0, 1.62)]),
        ( 6.65, [(0.0, 0.68), (0.72, 0.88), (1.16, 1.58), (0.0, 1.64)]),
    ]
    n0 = mb.nfaces()
    rings = []
    for y, prof in stations:
        # Full cross-section: port (-x) -> keel -> starboard (+x) -> deck center
        pts = [(0.0, y, prof[0][1]),
               (prof[1][0], y, prof[1][1]),
               (prof[2][0], y, prof[2][1]),
               (0.0, y, prof[3][1]),
               (-prof[2][0], y, prof[2][1]),
               (-prof[1][0], y, prof[1][1])]
        rings.append([mb.v(p) for p in pts])
    for i in range(len(rings) - 1):
        for j in range(6):
            jn = (j + 1) % 6
            # Deck faces are j=2 (stbd sheer->deck) and j=3 (deck->port sheer)
            mat = "teak_deck" if j in (2, 3) else "hull_blue"
            mb.f([rings[i][j], rings[i][jn], rings[i + 1][jn], rings[i + 1][j]], mat)
    # Transom cap at stern
    mb.f(rings[-1], "hull_white")
    mb.recalc(n0, soft=True)

    # Grounded keel fin stub (sits squarely on z = 0) & rudder blade
    bevel_box(mb, (0, -0.35, 0.16), (0.34, 2.8, 0.32), "forge_steel", bev=0.05)
    bevel_box(mb, (0, 5.45, 0.45), (0.14, 0.85, 0.85), "hull_blue", bev=0.03)

    # White cabin coachroof + tinted wrap saloon windows + aft cockpit helm wheel
    bevel_box(mb, (0, -0.65, 1.98), (2.25, 4.9, 0.72), "hull_white", bev=0.14)
    for sx in (-1, 1):
        box(mb, (sx * 1.13, -0.75, 2.02), (0.06, 3.4, 0.32), "glass_dark")
        tube(mb, [(sx * 0.85, -2.5, 2.40), (sx * 0.85, 1.4, 2.40)], 0.04, 5, "teak_deck")
    # Cockpit coaming & spoked chrome steering helm wheel
    bevel_box(mb, (0, 3.65, 1.82), (2.5, 2.6, 0.44), "hull_white", bev=0.08)
    cyl(mb, (0, 4.45, 1.65), (0, 4.45, 2.52), 0.14, 0.12, 8, "hull_white")
    torus(mb, (0, 4.62, 2.42), 0.52, 0.035, 16, 5, "chrome", axis=(0, 1, 0))
    for k in range(6):
        a = 2 * pi * k / 6
        cyl(mb, (0, 4.62, 2.42), (0.52 * math.cos(a), 4.62, 2.42 + 0.52 * math.sin(a)), 0.02, 0.02, 4, "chrome")
    # Bow chrome pulpit railing
    tube(mb, [(-1.05, -4.6, 1.72), (-0.85, -4.9, 2.38), (0.0, -6.55, 2.48),
              (0.85, -4.9, 2.38), (1.05, -4.6, 1.72)], 0.038, 5, "chrome")

    # Tall 15.8m anodized aluminum mast + twin spreaders + boom + standing rigging
    my = -1.35
    cyl(mb, (0, my, 1.95), (0, my, 16.0), 0.14, 0.08, 10, "steel_light")
    for zs, span in ((7.2, 1.85), (11.6, 1.25)):
        cyl(mb, (-span, my, zs), (span, my, zs), 0.045, 0.045, 6, "steel_light")
    # Boom extending aft over cockpit
    cyl(mb, (0, my, 3.05), (0.65, 4.55, 3.15), 0.095, 0.075, 8, "steel_light")
    # Forestay, backstay, and shrouds
    tube(mb, [(0, -6.55, 1.85), (0, my, 15.6)], 0.024, 4, "steel_galv")
    tube(mb, [(0, 6.55, 1.65), (0, my, 15.85)], 0.024, 4, "steel_galv")
    for sx in (-1, 1):
        tube(mb, [(sx * 1.78, my + 0.25, 1.56), (sx * 1.85, my, 7.2),
                  (sx * 1.25, my, 11.6), (0, my, 15.6)], 0.022, 4, "steel_galv")

    # Gracefully billowing curved Mainsail (with LMF red & gold horizontal racing stripes)
    n0 = mb.nfaces()
    ns_v, ns_u = 10, 6
    mgrid = []
    for iv in range(ns_v + 1):
        v = iv / ns_v
        z = 3.18 + v * 12.25
        y_luff = my + 0.16
        y_leech = (4.45 * (1 - v) + (my + 0.45) * v) + 0.55 * math.sin(pi * v)
        x_boom = 0.62 * (1 - v)
        row = []
        for iu in range(ns_u + 1):
            u = iu / ns_u
            y = y_luff + (y_leech - y_luff) * u
            belly = 0.78 * math.sin(pi * u) * (1.0 - 0.55 * v)
            x = x_boom * u + belly
            row.append(mb.v((x, y, z)))
        mgrid.append(row)
    for iv in range(ns_v):
        smat = "lmf_red" if iv == 2 else ("alloy_gold" if iv == 3 else "sail_white")
        for iu in range(ns_u):
            a, b, c, d = mgrid[iv][iu], mgrid[iv][iu + 1], mgrid[iv + 1][iu + 1], mgrid[iv + 1][iu]
            mb.f([a, b, c, d], smat)
            mb.f([d, c, b, a], smat)

    # Billowing triangular Jib foresail
    jgrid = []
    for iv in range(8 + 1):
        v = iv / 8.0
        z = 2.05 + v * 13.2
        y_f = -6.35 * (1 - v) + (my - 0.10) * v
        y_a = (my - 0.25) * (1 - v) + (my - 0.10) * v
        row = []
        for iu in range(5):
            u = iu / 4.0
            y = y_f + (y_a - y_f) * u
            belly = 0.58 * math.sin(pi * u) * (1.0 - 0.65 * v)
            row.append(mb.v((belly + 0.15 * u * (1 - v), y, z)))
        jgrid.append(row)
    for iv in range(8):
        for iu in range(4):
            a, b, c, d = jgrid[iv][iu], jgrid[iv][iu + 1], jgrid[iv + 1][iu + 1], jgrid[iv + 1][iu]
            mb.f([a, b, c, d], "sail_white")
            mb.f([d, c, b, a], "sail_white")

    return {"body": mb, "children": {}}


# --------------------------------------------------------------------------
# 11. lmf_alpine_chalet — Timber Alpine ski lodge w/ snow eaves & skis
# --------------------------------------------------------------------------
def build_lmf_alpine_chalet(root):
    mb = MB()
    # Ground-floor Alpine stone masonry foundation (10.6m W x 9.2m D x 2.85m H) + deep skirt to z = -3.0m
    bevel_box(mb, (0, 0, 1.425), (10.6, 9.2, 2.85), "stone_warm", bev=0.10)
    foundation_skirt_box(mb, 0, 0, 10.6, 9.2, 3.0, mat="stone_dark", bev=0.10)
    # Corner stone quoins
    for sx in (-1, 1):
        for sy in (-1, 1):
            for kz in range(4):
                bevel_box(mb, (sx * 5.26, sy * 4.56, 0.4 + kz * 0.68), (0.42, 0.42, 0.48), "stone_dark", bev=0.04)

    # Warm notched timber upper story (z = 2.85 .. 5.65)
    bevel_box(mb, (0, 0, 4.25), (10.4, 9.0, 2.80), "timber_warm", bev=0.06)
    # Protruding notched log ends at all 4 corners
    for sx in (-1, 1):
        for sy in (-1, 1):
            for lz in range(6):
                z = 3.05 + lz * 0.44
                cyl(mb, (sx * 5.0, sy * 4.55, z), (sx * 5.55, sy * 4.55, z), 0.14, 0.14, 6, "timber_dark")
                cyl(mb, (sx * 5.25, sy * 4.3, z), (sx * 5.25, sy * 4.85, z), 0.14, 0.14, 6, "timber_dark")

    # Recessed front timber doorway & warm porch lantern
    bevel_box(mb, (0, -4.62, 1.25), (1.75, 0.25, 2.45), "timber_dark", bev=0.04)
    box(mb, (0, -4.74, 1.20), (1.35, 0.08, 2.25), "timber_warm")
    sphere(mb, (1.15, -4.85, 2.15), 0.16, "marquee_bulb", segs=8, rings=5)

    # Glowing mullioned Alpine windows with timber shutters (front & sides)
    for wx, wz in ((-3.0, 1.55), (3.0, 1.55), (-2.6, 4.15), (0.0, 4.15), (2.6, 4.15)):
        box(mb, (wx, -4.62, wz), (1.45, 0.16, 1.35), "timber_dark")
        box(mb, (wx, -4.68, wz), (1.22, 0.08, 1.12), "warm_window")
        box(mb, (wx, -4.72, wz), (1.24, 0.05, 0.08), "timber_dark")
        box(mb, (wx, -4.72, wz), (0.08, 0.05, 1.14), "timber_dark")
        for sx in (-1, 1):
            box(mb, (wx + sx * 0.92, -4.66, wz), (0.40, 0.08, 1.28), "lmf_red")
    for sx in (-1, 1):
        for wy in (-2.0, 2.0):
            for wz in (1.55, 4.15):
                box(mb, (sx * 5.32, wy, wz), (0.16, 1.4, 1.28), "timber_dark")
                box(mb, (sx * 5.38, wy, wz), (0.08, 1.16, 1.06), "warm_window")

    # Cantilevered wrap-around front timber balcony + wooden balustrade + flower boxes
    bevel_box(mb, (0, -5.35, 2.82), (11.2, 1.85, 0.24), "timber_dark", bev=0.04)
    for bx in (-4.4, -2.2, 0.0, 2.2, 4.4):
        box(mb, (bx, -5.35, 2.55), (0.22, 1.75, 0.30), "timber_dark")
    # Front balcony rail & posts
    box(mb, (0, -6.18, 3.85), (11.1, 0.16, 0.14), "timber_dark")
    for k in range(13):
        px = -5.4 + k * 0.90
        box(mb, (px, -6.18, 3.38), (0.14, 0.12, 0.95), "timber_warm")
    for sx in (-1, 1):
        box(mb, (sx * 5.52, -5.35, 3.85), (0.16, 1.8, 0.14), "timber_dark")
    for fx in (-3.2, 0.0, 3.2):
        bevel_box(mb, (fx, -6.34, 3.78), (1.45, 0.28, 0.28), "timber_dark", bev=0.03)
        bevel_box(mb, (fx, -6.34, 3.96), (1.32, 0.26, 0.16), "lmf_red", bev=0.04)

    # Wide overhanging Alpine pitched gable roof + thick sculpted pillowy SNOW blanket!
    gable_roof(mb, 0.0, -0.35, 5.40, 14.0, 12.2, 3.65, 0.34, "timber_dark", mat_gable="timber_warm")
    gable_roof(mb, 0.0, -0.35, 5.76, 14.4, 12.5, 3.70, 0.42, "snow")
    # Sculpted overhanging snow-drift pillows along both eaves
    for sx in (-1, 1):
        for k in range(7):
            sy = -5.6 + k * 1.75
            sphere(mb, (sx * 7.1, sy, 5.88), 0.44, "snow", segs=8, rings=5, sx=0.75, sy=1.7, sz=0.65)

    # Stone Alpine chimney + snow cap
    bevel_box(mb, (3.4, 1.6, 7.6), (1.25, 1.25, 3.8), "stone_dark", bev=0.08)
    bevel_box(mb, (3.4, 1.6, 9.6), (1.48, 1.48, 0.28), "snow", bev=0.06)

    # Pair of crossed red & blue Alpine skis leaning against the stone porch!
    bevel_box(mb, (-1.65, -4.92, 1.05), (0.14, 0.05, 2.05), "lmf_red", bev=0.02, M=rot_y(11) @ rot_x(-12))
    bevel_box(mb, (-1.45, -4.92, 1.05), (0.14, 0.05, 2.05), "ski_blue", bev=0.02, M=rot_y(-11) @ rot_x(-12))

    return {"body": mb, "children": {}}


# --------------------------------------------------------------------------
# 12. lmf_ski_gondola_pylon — 18m ski-lift steel tower + hanging gondola_cabin
# --------------------------------------------------------------------------
def build_lmf_ski_gondola_pylon(root):
    mb = MB()
    # Tapered concrete Alpine tower base with deep underground foundation pier to z = -3.0m
    lathe(mb, [(0.0, -3.0), (2.25, -3.0), (2.25, 0.0), (1.85, 2.2), (0.0, 2.2)], 8, Matrix.Identity(3), Vector((0, 0, 0)),
          ["concrete", "concrete", "concrete", "concrete"])
    # Galvanized steel tapered lattice pylon mast (4 tapered chords + cross bracing to z = 16.4m)
    legs0 = [(-1.05, -1.05), (1.05, -1.05), (1.05, 1.05), (-1.05, 1.05)]
    legs1 = [(-0.52, -0.52), (0.52, -0.52), (0.52, 0.52), (-0.52, 0.52)]
    for (x0, y0), (x1, y1) in zip(legs0, legs1):
        cyl(mb, (x0, y0, 2.1), (x1, y1, 16.4), 0.13, 0.10, 6, "steel_galv")
    bays = 7
    for i in range(bays):
        t0, t1 = i / bays, (i + 1) / bays
        z0, z1 = 2.2 + t0 * 14.0, 2.2 + t1 * 14.0
        r0 = [Vector((legs0[k][0] + (legs1[k][0] - legs0[k][0]) * t0,
                      legs0[k][1] + (legs1[k][1] - legs0[k][1]) * t0, z0)) for k in range(4)]
        r1 = [Vector((legs0[k][0] + (legs1[k][0] - legs0[k][0]) * t1,
                      legs0[k][1] + (legs1[k][1] - legs0[k][1]) * t1, z1)) for k in range(4)]
        for k in range(4):
            kn = (k + 1) % 4
            tube(mb, [r1[k], r1[kn]], 0.045, 4, "steel_galv", cap_start=False, cap_end=False)
            tube(mb, [r0[k], r1[kn]], 0.040, 4, "steel_galv", cap_start=False, cap_end=False)

    # Top maintenance catwalk platform + hazard yellow handrail
    bevel_box(mb, (0, 0, 16.35), (8.6, 1.35, 0.24), "steel_galv", bev=0.04)
    bevel_box(mb, (0, 0, 15.85), (7.8, 0.65, 0.52), "forge_steel", bev=0.05)
    for sx in (-1, 1):
        # Diagonal knee brace supporting the wide T-crossarm
        cyl(mb, (sx * 0.55, 0, 13.6), (sx * 3.1, 0, 15.85), 0.10, 0.09, 6, "steel_galv")
        # Multi-wheel sheave / roller battery + haul cable stub at x = +-3.8m
        bevel_box(mb, (sx * 3.85, 0, 15.72), (0.35, 2.8, 0.28), "steel_dark", bev=0.03)
        for wy in (-1.05, -0.35, 0.35, 1.05):
            cyl(mb, (sx * 3.65, wy, 15.65), (sx * 4.05, wy, 15.65), 0.24, 0.24, 10, "rubber_black")
            cyl(mb, (sx * 3.62, wy, 15.65), (sx * 4.08, wy, 15.65), 0.10, 0.10, 8, "steel_light")
        # Haul cable stub running along Y
        tube(mb, [(sx * 3.85, -5.8, 15.42), (sx * 3.85, 0.0, 15.90), (sx * 3.85, 5.8, 15.42)],
             0.045, 6, "steel_dark")
    # Safety handrail along top crossarm
    for sy in (-0.62, 0.62):
        tube(mb, [(-4.2, sy, 17.35), (4.2, sy, 17.35)], 0.038, 4, "hazard_yellow")
        for kx in (-4.2, -2.1, 0.0, 2.1, 4.2):
            tube(mb, [(kx, sy, 16.45), (kx, sy, 17.35)], 0.035, 4, "hazard_yellow")
    # Climb ladder along rear face
    for dx in (-0.22, 0.22):
        cyl(mb, (dx, 0.85, 2.2), (dx, 0.58, 16.3), 0.035, 0.035, 4, "steel_galv")

    # Animatable child: hanging retro crimson-red ski gondola cabin (pivot at cable grip (-3.85, 0, 15.85))
    gon = MB()
    piv = Vector((-3.85, 0.0, 15.85))
    # Grip clamp + sweeping curved steel hanger arm descending to cabin roof
    bevel_box(gon, piv, (0.32, 0.52, 0.28), "steel_dark", bev=0.03)
    tube(gon, [piv, piv + Vector((-0.65, 0, -0.75)), piv + Vector((-0.65, 0, -2.35)),
               piv + Vector((0.0, 0, -3.05)), piv + Vector((0.0, 0, -3.55))],
         0.085, 8, "steel_dark")
    # Retro rounded crimson-and-white gondola cabin (bottom at z ≈ 10.1m, ample clearance below)
    cc = piv + Vector((0.0, 0.0, -4.65))
    bevel_box(gon, cc + Vector((0, 0, -0.52)), (2.25, 2.45, 1.12), "lmf_red", bev=0.22)
    bevel_box(gon, cc + Vector((0, 0,  0.52)), (2.18, 2.38, 0.96), "hull_white", bev=0.20)
    # Panoramic wrap-around tinted cabin windows
    bevel_box(gon, cc + Vector((0, 0,  0.42)), (2.22, 2.42, 0.72), "glass_dark", bev=0.12)
    # Roof cap & ventilation dome
    bevel_box(gon, cc + Vector((0, 0,  1.06)), (1.95, 2.15, 0.18), "lmf_red", bev=0.06)
    # External ski-rack baskets holding bright skis on sides
    for sy in (-1, 1):
        bevel_box(gon, cc + Vector((0, sy * 1.32, -0.58)), (1.15, 0.24, 0.55), "steel_dark", bev=0.03)
        box(gon, cc + Vector((-0.25, sy * 1.32, 0.05)), (0.12, 0.06, 1.65), "ski_blue")
        box(gon, cc + Vector(( 0.25, sy * 1.32, 0.05)), (0.12, 0.06, 1.65), "alloy_gold")

    return {"body": mb, "children": {"gondola_cabin": (gon, tuple(piv), True)}}


# --------------------------------------------------------------------------
# Registry & CLI driver
# --------------------------------------------------------------------------
MONUMENTS = [
    ("lmf_forge_arch",          build_lmf_forge_arch),
    ("lmf_red_knopf",           build_lmf_red_knopf),
    ("lmf_jet_loop_reactor",    build_lmf_jet_loop_reactor),
    ("lmf_arcanum_tower",       build_lmf_arcanum_tower),
    ("lmf_selantis_arch",       build_lmf_selantis_arch),
    ("lmf_theater_facade",      build_lmf_theater_facade),
    ("lmf_melodai_arch",        build_lmf_melodai_arch),
    ("lmf_codex_monolith",      build_lmf_codex_monolith),
    ("lmf_festival_stage",      build_lmf_festival_stage),
    ("lmf_sailboat_ijsselmeer", build_lmf_sailboat_ijsselmeer),
    ("lmf_alpine_chalet",       build_lmf_alpine_chalet),
    ("lmf_ski_gondola_pylon",   build_lmf_ski_gondola_pylon),
]


if __name__ == "__main__":
    opt = bd_common.parse_args()
    out_dir = opt.get("out", "/tmp/bulli-props-raw")
    meta_path = opt.get("meta")
    preview_dir = opt.get("preview")
    only = set(opt["only"].split(",")) if "only" in opt else None
    ao_samples = 0 if opt.get("no-ao") else 18

    results = []
    for prop_id, fn in MONUMENTS:
        if only and prop_id not in only:
            continue
        results.append(build_and_export_prop(prop_id, "monument", fn, out_dir,
                                             preview_dir=preview_dir, ao_samples=ao_samples))
    if meta_path:
        os.makedirs(os.path.dirname(os.path.abspath(meta_path)), exist_ok=True)
        with open(meta_path, "w") as f:
            json.dump(results, f, indent=2)
