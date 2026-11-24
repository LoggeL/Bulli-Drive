# Bulli Drive -- 12 Bespoke Easter-Egg & Billboard Prop GLBs (Blender 5.2 procedural build)
#
# Usage:
#   blender -b --factory-startup --python tools/models/props/easter_eggs.py -- \
#       --out=<raw_dir> --meta=<meta.json> [--only=id1,id2] [--preview=<png_dir>] [--no-ao]
import os, sys, math, json
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))
from bd_props import *  # noqa: E402,F403


# --------------------------------------------------------------------------
# 13. prop_fi_toaster_shrine — Breaker box wired to retro toaster + invisible baking trays
# --------------------------------------------------------------------------
def build_prop_fi_toaster_shrine(root):
    mb = MB()
    # Timber shrine pedestal altar with brass dedication plaque + stone foundation skirt (-1.5m)
    bevel_box(mb, (0, 0, 0.14), (3.4, 2.2, 0.28), "stone_dark", bev=0.05)
    foundation_skirt_box(mb, 0, 0, 3.4, 2.2, 1.5, mat="stone_dark", bev=0.05)
    bevel_box(mb, (0, 0, 0.72), (3.0, 1.85, 0.88), "timber_warm", bev=0.06)
    bevel_box(mb, (0, 0, 1.22), (3.2, 2.05, 0.14), "timber_dark", bev=0.04)
    bevel_box(mb, (0, -0.95, 0.72), (1.15, 0.08, 0.42), "brass", bev=0.02)

    # Left side: Wall-mounted industrial FI (RCD) electrical breaker box on steel stanchion
    cyl(mb, (-1.05, 0.35, 1.25), (-1.05, 0.35, 2.95), 0.09, 0.09, 8, "steel_dark")
    bevel_box(mb, (-1.05, 0.18, 2.45), (0.95, 0.48, 1.28), "steel_galv", bev=0.05)
    # Recessed breaker panel interior with tripped red FI toggle switch + fault LED
    box(mb, (-1.05, -0.07, 2.45), (0.72, 0.08, 0.98), "forge_coal")
    for kx in (-0.22, 0.0, 0.22):
        box(mb, (-1.05 + kx, -0.14, 2.38), (0.14, 0.14, 0.34), "ivory")
    # Tripped red FI master switch pitched downward + glowing red trip LED
    box(mb, (-1.05, -0.22, 2.30), (0.28, 0.18, 0.12), "lmf_red", M=rot_x(32))
    sphere(mb, (-1.05, -0.14, 2.78), 0.08, "led_red", segs=8, rings=4)
    # Hazard yellow lightning badge on top of breaker box
    bevel_box(mb, (-1.05, -0.08, 3.00), (0.34, 0.08, 0.28), "hazard_yellow", bev=0.02)

    # Thick snaking black rubber power cable from breaker box to retro toaster
    tube(mb, [(-1.05, 0.12, 1.82), (-1.05, -0.18, 1.38), (-0.42, -0.26, 1.33),
              (0.15, 0.10, 1.33), (0.55, 0.05, 1.45)], 0.048, 6, "rubber_black")

    # Right side: Oversized gleaming chrome retro 2-slice toaster with glowing coils & golden toast
    tx, ty, tz = 0.85, 0.05, 1.30
    bevel_box(mb, (tx, ty, tz + 0.05), (1.16, 0.78, 0.12), "rubber_black", bev=0.04)
    bevel_box(mb, (tx, ty, tz + 0.44), (1.08, 0.70, 0.72), "chrome", bev=0.14)
    # Side push lever & temperature dial
    box(mb, (tx + 0.59, ty, tz + 0.42), (0.16, 0.14, 0.08), "rubber_black")
    cyl(mb, (tx + 0.54, ty - 0.18, tz + 0.22), (tx + 0.62, ty - 0.18, tz + 0.22), 0.09, 0.08, 8, "lmf_red")
    # Two glowing toast slots + popping golden toast slices
    for dy in (-0.15, 0.15):
        box(mb, (tx, ty + dy, tz + 0.80), (0.76, 0.14, 0.06), "ember_glow")
        bevel_box(mb, (tx, ty + dy, tz + 1.02), (0.64, 0.09, 0.52), "toast_golden", bev=0.03)
        box(mb, (tx, ty + dy, tz + 1.29), (0.66, 0.10, 0.07), "toast_crust")

    # Two floating translucent cyan wireframe "invisible" baking trays levitating above/beside!
    for idx, (bx, by, bz, M_t) in enumerate((
        (0.15, 0.05, 2.75, rot_x(16) @ rot_y(-18)),
        (1.45, -0.15, 3.05, rot_x(-12) @ rot_y(24)),
    )):
        # Translucent sheet + crisp wireframe rim tubes
        box(mb, (bx, by, bz), (1.05, 0.75, 0.04), "glass_cyan", M=M_t)
        c = Vector((bx, by, bz))
        pts = [c + M_t @ Vector((sx * 0.54, sy * 0.39, 0.03))
               for (sx, sy) in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        tube(mb, pts, 0.025, 4, "led_cyan", closed=True)

    return {"body": mb, "children": {}}


# --------------------------------------------------------------------------
# 14. prop_kniffel_die — Beveled 5m ivory/wood die with recessed pips (opp sum=7)
# --------------------------------------------------------------------------
def build_prop_kniffel_die(root):
    mb = MB()
    S = 5.0
    h = S / 2.0
    # Chunky chamfered ivory die sitting on z = 0 with embedded dark-stone foundation plinth (-1.5m)
    bevel_box(mb, (0, 0, h), (S, S, S), "ivory", bev=0.48)
    foundation_skirt_box(mb, 0, 0, S, S, 1.5, mat="stone_dark", bev=0.48)

    # Opposite faces strictly sum to 7:
    #   Front (-Y) = 1 (iconic LMF crimson red ace!), Back (+Y) = 6
    #   Top (+Z) = 5, Bottom (-Z) = 2
    #   Right (+X) = 3, Left (-X) = 4
    d = 1.22
    pip_layouts = {
        1: [(0, 0)],
        2: [(-d, -d), (d, d)],
        3: [(-d, -d), (0, 0), (d, d)],
        4: [(-d, -d), (d, -d), (-d, d), (d, d)],
        5: [(-d, -d), (d, -d), (0, 0), (-d, d), (d, d)],
        6: [(-d, -d), (d, -d), (-d, 0), (d, 0), (-d, d), (d, d)],
    }

    faces = [
        # (pip_count, normal, u_axis, v_axis, mat)
        (1, Vector((0, -1, 0)), Vector((1, 0, 0)), Vector((0, 0, 1)), "lmf_red"),
        (6, Vector((0,  1, 0)), Vector((-1, 0, 0)), Vector((0, 0, 1)), "forge_coal"),
        (5, Vector((0,  0, 1)), Vector((1, 0, 0)), Vector((0, 1, 0)), "forge_coal"),
        (2, Vector((0,  0, -1)), Vector((1, 0, 0)), Vector((0, -1, 0)), "forge_coal"),
        (3, Vector((1,  0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1)), "forge_coal"),
        (4, Vector((-1, 0, 0)), Vector((0, -1, 0)), Vector((0, 0, 1)), "forge_coal"),
    ]
    ctr = Vector((0, 0, h))
    for count, n, u, v, pmat in faces:
        r_pip = 0.62 if count == 1 else 0.42
        M_f = frame_from_axis(n)
        for (pu, pv) in pip_layouts[count]:
            # Keep bottom face pips inset so min_z stays cleanly >= 0
            inset = 0.055 if n.z < -0.5 else 0.01
            pos = ctr + n * (h - inset) + u * pu + v * pv
            # Crisp recessed-style dish bezel + dark glossy pip disc
            lathe(mb, [(r_pip * 1.12, 0.0), (r_pip * 0.96, 0.055), (r_pip * 0.84, 0.03), (0.0, 0.01)],
                  12, M_f, pos, ["ivory", pmat, pmat])

    return {"body": mb, "children": {}}


# --------------------------------------------------------------------------
# 15. prop_sudsblaster — Oversized retro-sci-fi bubble cannon statue
# --------------------------------------------------------------------------
def build_prop_sudsblaster(root):
    mb = MB()
    # Stepped retro-voxel pedestal (z = 0..1.35) + underground stone foundation skirt (-1.5m)
    bevel_box(mb, (0, 0, 0.30), (3.6, 3.6, 0.60), "suds_teal", bev=0.08)
    foundation_skirt_box(mb, 0, 0, 3.6, 3.6, 1.5, mat="stone_dark", bev=0.08)
    bevel_box(mb, (0, 0, 0.85), (2.7, 2.7, 0.50), "ivory", bev=0.06)
    bevel_box(mb, (0, 0, 1.25), (1.8, 2.2, 0.30), "suds_purple", bev=0.05)

    # Tilted retro-sci-fi bubble cannon aimed forward-up (-Y, +Z)
    M_gun = rot_x(24)
    gc = Vector((0.0, 0.15, 2.95))
    # Support pylon / grip connecting pedestal to cannon receiver
    bevel_box(mb, (0, 0.65, 2.05), (0.58, 0.72, 1.55), "suds_teal", bev=0.07, M=rot_x(-16))
    # Main sculpted raygun receiver barrel (lathe along local -Y -> frame_from_axis)
    M_bar = M_gun @ frame_from_axis(Vector((0, -1, 0)))
    lathe(mb, [(0.0, -1.65), (0.58, -1.55), (0.76, -1.10), (0.72, 0.10),
               (0.56, 0.45), (0.48, 1.35), (0.86, 1.95), (0.92, 2.12), (0.72, 2.12), (0.42, 1.65), (0.0, 1.65)],
          14, M_bar, gc,
          ["chrome", "suds_purple", "suds_purple", "suds_teal", "suds_purple",
           "chrome", "brass", "suds_teal", "forge_coal", "led_cyan"])

    # 3 polished chrome raygun cooling fins along barrel
    for d_fin, r_fin in ((0.65, 0.72), (0.98, 0.68), (1.30, 0.64)):
        p_f = gc + M_gun @ Vector((0, -d_fin, 0))
        torus(mb, p_f, r_fin, 0.065, 14, 5, "chrome", axis=M_gun @ Vector((0, -1, 0)))

    # Top glowing translucent soap-suds pressure tank
    p_t0 = gc + M_gun @ Vector((0, 0.65, 0.92))
    p_t1 = gc + M_gun @ Vector((0, -0.55, 0.92))
    cyl(mb, p_t0, p_t1, 0.36, 0.36, 12, "glass_cyan")
    cyl(mb, gc + M_gun @ Vector((0, 0.65, 0.92)), gc + M_gun @ Vector((0, 0.78, 0.92)), 0.40, 0.38, 12, "brass")
    cyl(mb, gc + M_gun @ Vector((0, -0.55, 0.92)), gc + M_gun @ Vector((0, -0.68, 0.92)), 0.40, 0.38, 12, "brass")

    # Spray of buoyant glossy soap bubbles floating out of the bell muzzle!
    bubbles = [
        ( 0.00, -2.35, 4.10, 0.44),
        (-0.55, -2.95, 4.65, 0.36),
        ( 0.62, -3.20, 4.45, 0.30),
        (-0.18, -3.75, 5.15, 0.52),
        ( 0.48, -4.15, 5.45, 0.28),
        (-0.75, -3.55, 5.05, 0.24),
        ( 0.12, -2.70, 4.85, 0.22),
    ]
    for bx, by, bz, br in bubbles:
        sphere(mb, (bx, by, bz), br, "bubble_glass", segs=10, rings=6)

    return {"body": mb, "children": {}}


# --------------------------------------------------------------------------
# 16. prop_nether_portal — Obsidian block frame + animatable portal_plane
# --------------------------------------------------------------------------
def build_prop_nether_portal(root):
    mb = MB()
    # Chunky beveled obsidian block arch (10.0m W x 8.5m H, clear 6.2m W x 5.8m H opening)
    # Bottom threshold flush at z = 0..0.45 (drivable speed-bump sill!) + obsidian foundation skirt (-1.5m)
    for ix in range(5):
        bx = -3.8 + ix * 1.9
        bevel_box(mb, (bx, 0, 0.22), (1.84, 1.85, 0.44), "obsidian", bev=0.09)
    foundation_skirt_box(mb, 0, 0, 9.44, 1.85, 1.5, mat="obsidian", bev=0.09)
    # Left and right stacked obsidian pillar blocks (x = +-4.05, z = 0.45 .. 6.75)
    for sx in (-1, 1):
        for iz in range(4):
            bz = 1.25 + iz * 1.60
            mat = "obsidian_vein" if (iz == 2 and sx > 0) or (iz == 1 and sx < 0) else "obsidian"
            bevel_box(mb, (sx * 4.05, 0, bz), (1.84, 1.84, 1.54), mat, bev=0.10)
    # Top lintel blocks (z = 6.85 .. 8.45)
    for ix in range(5):
        bx = -3.8 + ix * 1.9
        mat = "obsidian_vein" if ix == 2 else "obsidian"
        bevel_box(mb, (bx, 0, 7.65), (1.84, 1.84, 1.54), mat, bev=0.10)

    # Animatable child: translucent swirling glowing purple inner portal membrane
    pp = MB()
    nx, nz = 6, 6
    x0, x1 = -3.15, 3.15
    z0, z1 = 0.44, 6.90
    grid = []
    for iz in range(nz + 1):
        v = iz / nz
        z = z0 + (z1 - z0) * v
        row = []
        for ix in range(nx + 1):
            u = ix / nx
            x = x0 + (x1 - x0) * u
            # Subtle dimensional ripple wave in Y
            y = 0.14 * math.sin(u * pi * 2) * math.sin(v * pi * 2)
            row.append(pp.v((x, y, z)))
        grid.append(row)
    for iz in range(nz):
        for ix in range(nx):
            a, b, c, d = grid[iz][ix], grid[iz][ix + 1], grid[iz + 1][ix + 1], grid[iz + 1][ix]
            pp.f([a, b, c, d], "portal_swirl")
            pp.f([d, c, b, a], "portal_swirl")

    return {"body": mb, "children": {"portal_plane": (pp, (0.0, 0.0, 3.67), True)}}


# --------------------------------------------------------------------------
# 17. prop_stadtpin_marker — 14m glossy red 3D map pin on compass medallion
# --------------------------------------------------------------------------
def build_prop_stadtpin_marker(root):
    mb = MB()
    M_id = Matrix.Identity(3)
    # Brushed-gold & stone compass-rose ground medallion (r = 3.25m, z = -1.5..0.42m incl. foundation skirt)
    lathe(mb, [(0.0, -1.5), (3.25, -1.5), (3.25, 0.0), (3.15, 0.28), (2.75, 0.34), (2.75, 0.42), (0.0, 0.42)],
          24, M_id, Vector((0, 0, 0)), ["stone_dark", "stone_dark", "stone_light", "brass", "stone_light", "stone_light"])
    # 4 raised cardinal compass points (N/S/E/W)
    for k in range(4):
        a = k * 90
        bevel_box(mb, (math.cos(math.radians(a)) * 1.95, math.sin(math.radians(a)) * 1.95, 0.45),
                  (1.85, 0.36, 0.10), "brass", bev=0.02, M=rot_z(a))
    # Glowing pinpoint center ring under the pin tip
    torus(mb, (0, 0, 0.46), 0.72, 0.06, 20, 5, "ember_glow")

    # Iconic glossy crimson-red 3D teardrop map pin (tip grounded near z = 0.48, head top z = 13.6m)
    # Seamless tangent transition: tapered pin cone merges smoothly inside rounded torus-head!
    cyl(mb, (0, 0, 0.48), (0, 0, 8.75), 0.14, 2.28, 22, "lmf_red", cap0=True, cap1=True)
    # Smoothly blended rounded glossy pin head ring (creating the classic map-pin cutout hole)
    torus(mb, (0, 0, 10.35), 2.15, 1.12, 26, 14, "lmf_red", axis=(0, 1, 0))
    # Flattened inner shoulder filler blending cone top into lower torus belly
    sphere(mb, (0, 0, 8.60), 2.38, "lmf_red", segs=22, rings=8, sx=1.0, sy=0.48, sz=0.55)
    # Crisp glossy ivory inner ring rim inside the cutout
    torus(mb, (0, 0, 10.35), 1.18, 0.16, 20, 8, "ivory", axis=(0, 1, 0))

    return {"body": mb, "children": {}}


# --------------------------------------------------------------------------
# 18. prop_embedding_cube — Wireframe AI vector cube + animatable embedding_core
# --------------------------------------------------------------------------
def build_prop_embedding_cube(root):
    mb = MB()
    # Sleek chamfered dark-steel exhibition pedestal (z = 0..1.35) + underground stone skirt (-1.5m)
    bevel_box(mb, (0, 0, 0.25), (4.2, 4.2, 0.50), "forge_coal", bev=0.08)
    foundation_skirt_box(mb, 0, 0, 4.2, 4.2, 1.5, mat="stone_dark", bev=0.08)
    bevel_box(mb, (0, 0, 0.90), (2.8, 2.8, 0.80), "forge_steel", bev=0.08)
    bevel_box(mb, (0, 0, 1.36), (2.2, 2.2, 0.12), "alloy_blau", bev=0.03)
    # Angled chrome mounting stem holding the cube corner
    cyl(mb, (0, 0, 1.38), (0, 0, 2.35), 0.16, 0.12, 8, "chrome")

    # Tilted 3.8m glowing electric-blue wireframe vector space cube centered at (0, 0, 4.8)
    ctr = Vector((0.0, 0.0, 4.85))
    Mc = rot_z(35) @ rot_x(26) @ rot_y(18)
    h = 1.95
    verts = [ctr + Mc @ Vector((sx * h, sy * h, sz * h))
             for sz in (-1, 1) for sy in (-1, 1) for sx in (-1, 1)]
    edges = [(0, 1), (2, 3), (4, 5), (6, 7),
             (0, 2), (1, 3), (4, 6), (5, 7),
             (0, 4), (1, 5), (2, 6), (3, 7)]
    for i, j in edges:
        tube(mb, [verts[i], verts[j]], 0.065, 6, "alloy_blau", cap_start=False, cap_end=False)
    for v in verts:
        sphere(mb, v, 0.16, "chrome", segs=8, rings=5)

    # Animatable child: 3D constellation of glowing semantic token spheres + vector links
    core = MB()
    nodes = [
        (Vector(( 0.00,  0.00,  0.00)), 0.34, "ember_core"),
        (Vector(( 1.05,  0.45,  0.65)), 0.24, "alloy_gold"),
        (Vector((-0.95,  0.70,  0.40)), 0.26, "alloy_purpur"),
        (Vector(( 0.45, -1.05,  0.55)), 0.22, "led_cyan"),
        (Vector((-0.55, -0.75, -0.85)), 0.25, "alloy_rotglut"),
        (Vector(( 0.85,  0.65, -0.75)), 0.22, "alloy_blau"),
        (Vector((-1.10, -0.15,  0.80)), 0.20, "alloy_gold"),
        (Vector(( 0.20,  1.15, -0.30)), 0.22, "alloy_purpur"),
        (Vector((-0.25,  0.20, -1.15)), 0.24, "led_cyan"),
    ]
    for off, rad, nmat in nodes:
        sphere(core, ctr + off, rad, nmat, segs=8, rings=5)
    # Semantic similarity edges linking cluster nodes
    links = [(0, 1), (0, 2), (0, 3), (0, 4), (0, 5), (1, 5), (1, 7), (2, 6), (2, 7), (3, 4), (4, 8), (5, 8)]
    for i, j in links:
        tube(core, [ctr + nodes[i][0], ctr + nodes[j][0]], 0.032, 4, "led_white", cap_start=False, cap_end=False)

    return {"body": mb, "children": {"embedding_core": (core, tuple(ctr), True)}}


# --------------------------------------------------------------------------
# 19. prop_oilbert_icons — Golden wrench, winged badge & cartoon bomb on platform
# --------------------------------------------------------------------------
def build_prop_oilbert_icons(root):
    mb = MB()
    # Stepped retro-platformer showcase plinth (lush green grass deck + soil skirt to z = -1.5m)
    bevel_box(mb, (0, 0, 0.36), (7.6, 3.0, 0.72), "oilbert_soil", bev=0.07)
    foundation_skirt_box(mb, 0, 0, 7.6, 3.0, 1.5, mat="oilbert_soil", bev=0.07)
    bevel_box(mb, (0, 0, 0.86), (7.8, 3.2, 0.30), "oilbert_green", bev=0.08)
    # Flanking orange cracked-block platform step on right
    bevel_box(mb, (2.25, 0, 1.24), (2.25, 2.25, 0.48), "oilbert_orange", bev=0.07)

    # 1. Left (x = -2.25): Giant tilted gleaming golden mechanic's WRENCH on brass stand
    cyl(mb, (-2.25, 0, 1.0), (-2.25, 0, 1.65), 0.22, 0.16, 8, "brass")
    wc = Vector((-2.25, 0.0, 3.15))
    Mw = rot_y(-14)
    bevel_box(mb, wc, (0.44, 0.24, 2.30), "gold", bev=0.05, M=Mw)
    # Open-end crescent jaws at top and bottom of wrench
    for sz in (-1, 1):
        jc = wc + Mw @ Vector((0, 0, sz * 1.32))
        torus(mb, jc, 0.54, 0.16, 12, 6, "gold", axis=(0, 1, 0))
        box(mb, jc + Mw @ Vector((0, 0, sz * 0.46)), (0.42, 0.36, 0.46), "forge_coal", M=Mw)

    # 2. Center (x = 0.0): Iconic stylized Oilbert WHITE & GOLD WINGS BADGE
    cyl(mb, (0, 0, 1.0), (0, 0, 2.45), 0.20, 0.16, 8, "brass")
    # Central golden badge medallion
    cyl(mb, (0, -0.22, 2.95), (0, 0.22, 2.95), 0.66, 0.66, 14, "gold")
    cyl(mb, (0, -0.26, 2.95), (0, 0.26, 2.95), 0.45, 0.45, 12, "lmf_red")
    # Bold sculpted layered angel/speed wings extending left and right
    for sx in (-1, 1):
        for fk, (fw, fh, fz, ang) in enumerate(((1.65, 0.48, 0.42, 18), (1.42, 0.44, 0.02, 8), (1.12, 0.38, -0.34, -4))):
            bevel_box(mb, (sx * (0.52 + fw * 0.45), 0.0, 2.95 + fz),
                      (fw, 0.26, fh), "wing_white", bev=0.06, M=rot_y(sx * -ang))
            bevel_box(mb, (sx * (0.52 + fw * 0.45), 0.0, 2.95 + fz + fh * 0.45),
                      (fw * 0.94, 0.28, 0.09), "gold", bev=0.02, M=rot_y(sx * -ang))

    # 3. Right (x = +2.25): Glossy black CARTOON BOMB with glowing fuse spark
    bomb_c = Vector((2.25, 0.0, 2.48))
    sphere(mb, bomb_c, 1.02, "bomb_black", segs=16, rings=10)
    # Brass fuse cap collar
    cyl(mb, bomb_c + Vector((0, 0, 0.92)), bomb_c + Vector((0.12, 0, 1.24)), 0.30, 0.26, 10, "brass")
    # Curved rope fuse
    tube(mb, [bomb_c + Vector((0.12, 0, 1.22)), bomb_c + Vector((0.45, 0, 1.62)),
              bomb_c + Vector((0.92, -0.15, 1.72))], 0.065, 6, "ivory")
    # Fizzing glowing orange/yellow spark starburst at fuse tip
    sp = bomb_c + Vector((0.96, -0.15, 1.73))
    sphere(mb, sp, 0.24, "ember_core", segs=8, rings=5)
    for ang in (0, 60, 120):
        box(mb, sp, (0.78, 0.10, 0.10), "ember_glow", M=rot_z(ang) @ rot_y(ang * 0.5))

    return {"body": mb, "children": {}}


# --------------------------------------------------------------------------
# 20. prop_jp_whirlpool_tent — Hot-pink #ff2d87 party pavilion w/ whirlpool & green lasers
# --------------------------------------------------------------------------
def build_prop_jp_whirlpool_tent(root):
    mb = MB()
    # Ground party platform deck (9.6m W x 7.6m D x 0.26m H) + underground terrace skirt (-1.5m)
    bevel_box(mb, (0, 0, 0.13), (9.6, 7.6, 0.26), "timber_dark", bev=0.05)
    foundation_skirt_box(mb, 0, 0, 9.6, 7.6, 1.5, mat="stone_dark", bev=0.05)

    # 4 chrome corner tent poles + side valance beams
    for sx in (-1, 1):
        for sy in (-1, 1):
            cyl(mb, (sx * 4.5, sy * 3.5, 0.25), (sx * 4.5, sy * 3.5, 3.15), 0.10, 0.10, 8, "chrome")
    # Hot-pink perimeter valance fringe around top eaves
    for sy in (-1, 1):
        bevel_box(mb, (0, sy * 3.55, 3.05), (9.4, 0.14, 0.48), "jp_pink", bev=0.03)
    for sx in (-1, 1):
        bevel_box(mb, (sx * 4.55, 0, 3.05), (0.14, 7.2, 0.48), "jp_pink", bev=0.03)

    # Peaked pyramidal party pavilion canopy (z = 3.2 .. 5.2m) in striped hot pink!
    n0 = mb.nfaces()
    peak = mb.v((0.0, 0.0, 5.25))
    eave_pts = [
        (-4.85, -3.85), (0.0, -3.85), (4.85, -3.85), (4.85, 0.0),
        (4.85, 3.85), (0.0, 3.85), (-4.85, 3.85), (-4.85, 0.0),
    ]
    evs = [mb.v((px, py, 3.22)) for (px, py) in eave_pts]
    for i in range(len(evs)):
        mat = "jp_pink" if i % 2 == 0 else "jp_pink_light"
        a, b = evs[i], evs[(i + 1) % len(evs)]
        mb.f([a, b, peak], mat)
        mb.f([b, a, peak], mat)
    mb.recalc(n0, soft=False)
    sphere(mb, (0, 0, 5.32), 0.22, "chrome", segs=8, rings=5)

    # Octagonal bubbling turquoise WHIRLPOOL hot tub on left-center of deck
    wc = Vector((-1.45, 0.15, 0.26))
    lathe(mb, [(0.0, 0.0), (2.25, 0.0), (2.25, 0.92), (1.88, 0.92), (1.88, 0.72), (0.0, 0.72)],
          8, Matrix.Identity(3), wc, ["timber_warm", "ivory", "ivory", "water_glow", "water_glow"])
    # Frothy white bubbling spa foam clusters
    for k in range(7):
        a = 2 * pi * k / 7
        r = 0.65 + 0.55 * (k % 2)
        sphere(mb, wc + Vector((math.cos(a) * r, math.sin(a) * r, 0.78)), 0.22 + 0.06 * (k % 3),
               "ivory", segs=8, rings=4, sz=0.55)

    # Compact hot-pink cocktail bar counter + 2 barstools on right wing
    bevel_box(mb, (2.75, 0.45, 0.85), (1.15, 3.2, 1.15), "forge_coal", bev=0.05)
    bevel_box(mb, (2.75, 0.45, 1.48), (1.35, 3.4, 0.14), "jp_pink", bev=0.03)
    for by in (-0.35, 1.15):
        cyl(mb, (1.75, by, 0.26), (1.75, by, 0.92), 0.06, 0.06, 6, "chrome")
        cyl(mb, (1.75, by, 0.92), (1.75, by, 1.04), 0.26, 0.26, 8, "jp_pink")

    # Overhead steel mini-truss + 4 glowing diagonal neon GREEN (#00ff66) laser beams!
    tube(mb, [(-3.9, 0.0, 3.10), (3.9, 0.0, 3.10)], 0.07, 6, "steel_dark")
    for lx, tx, ty in ((-2.4, -3.8, -2.9), (-0.8, 1.2, -3.1), (0.8, -0.9, 2.8), (2.4, 3.9, 2.9)):
        box(mb, (lx, 0.0, 3.00), (0.28, 0.24, 0.22), "forge_coal")
        cyl(mb, (lx, 0.0, 2.92), (tx, ty, 0.30), 0.045, 0.095, 6, "laser_green", cap0=False, cap1=False)

    return {"body": mb, "children": {}}


# --------------------------------------------------------------------------
# 21. prop_win98_frame — 18m x 11.5m Windows 98 window frame + billboard_face
# --------------------------------------------------------------------------
def build_prop_win98_frame(root):
    mb = MB()
    # Twin dark steel industrial H-frame support legs (z = 0..1.55) + concrete foundation skirts (-1.5m)
    for sx in (-1, 1):
        bevel_box(mb, (sx * 6.8, 0, 0.20), (2.6, 3.4, 0.40), "concrete", bev=0.05)
        foundation_skirt_box(mb, sx * 6.8, 0, 2.6, 3.4, 1.5, mat="concrete", bev=0.05)
        bevel_box(mb, (sx * 6.8, 0, 1.10), (0.85, 0.85, 1.60), "steel_dark", bev=0.05)
        # Rear angled steel brace struts
        cyl(mb, (sx * 6.8, 1.45, 0.35), (sx * 6.8, 0.45, 5.2), 0.14, 0.14, 6, "steel_dark")

    # Chunky 3D beveled Windows 98 window casing (18.0m W x 9.95m H, z = 1.55 .. 11.50)
    bevel_box(mb, (0, 0.12, 6.52), (18.0, 0.92, 9.95), "win98_grey", bev=0.08)
    # Raised top/left highlight bevel + sunken bottom/right shadow bevel
    box(mb, (0, -0.36, 11.44), (17.85, 0.08, 0.14), "win98_light")
    box(mb, (-8.94, -0.36, 6.52), (0.14, 0.08, 9.85), "win98_light")
    box(mb, (0, -0.36, 1.62), (17.85, 0.08, 0.14), "win98_dark")
    box(mb, (8.94, -0.36, 6.52), (0.14, 0.08, 9.85), "win98_dark")

    # Iconic #000080 Navy Blue Win98 Title Bar across top (z = 10.45 .. 11.20)
    box(mb, (0, -0.38, 10.82), (17.1, 0.10, 0.78), "win98_navy")
    # Tiny window icon square on left of title bar
    box(mb, (-8.05, -0.44, 10.82), (0.45, 0.08, 0.45), "win98_teal")
    # Iconic 3D raised [ _ ] [ □ ] [ X ] window control buttons on right!
    for k, bx in enumerate((6.65, 7.35, 8.10)):
        box(mb, (bx, -0.44, 10.82), (0.56, 0.10, 0.54), "win98_grey")
        if k == 0:    # minimize _
            box(mb, (bx, -0.50, 10.66), (0.30, 0.04, 0.07), "forge_coal")
        elif k == 1:  # maximize square
            box(mb, (bx, -0.50, 10.95), (0.32, 0.04, 0.08), "forge_coal")
            box(mb, (bx, -0.50, 10.69), (0.32, 0.04, 0.05), "forge_coal")
            for sx in (-0.14, 0.14):
                box(mb, (bx + sx, -0.50, 10.82), (0.05, 0.04, 0.28), "forge_coal")
        else:         # close X
            box(mb, (bx, -0.50, 10.82), (0.36, 0.04, 0.07), "forge_coal", M=rot_y(45))
            box(mb, (bx, -0.50, 10.82), (0.36, 0.04, 0.07), "forge_coal", M=rot_y(-45))

    # Classic bottom Win98 Taskbar + dark top divider + raised Start button & 4-color tiny flag
    box(mb, (0, -0.38, 2.12), (17.1, 0.12, 0.78), "win98_grey")
    box(mb, (0, -0.44, 2.52), (17.1, 0.08, 0.08), "win98_dark")
    box(mb, (-7.45, -0.45, 2.12), (2.05, 0.12, 0.56), "win98_light")
    box(mb, (-7.45, -0.44, 1.82), (2.05, 0.10, 0.06), "win98_dark")
    for dx, dz, fmat in ((-0.12, 0.10, "lmf_red"), (0.12, 0.10, "oilbert_green"),
                         (-0.12, -0.10, "alloy_blau"), (0.12, -0.10, "alloy_gold")):
        box(mb, (-8.12 + dx, -0.52, 2.12 + dz), (0.18, 0.05, 0.18), fmat)

    # Rear teal backing plate so back side also looks authentic
    box(mb, (0, 0.60, 6.50), (16.4, 0.08, 7.5), "win98_teal")

    # Separate named billboard_face mesh with exact flipY=true UVs (16.2m x 7.45m)
    bf = MB()
    billboard_quad(bf, (0.0, -0.42, 6.50), 16.2, 7.45, mat="billboard_face")

    return {"body": mb, "children": {"billboard_face": (bf, (0.0, 0.0, 0.0), False)}}


# --------------------------------------------------------------------------
# 22. prop_vertical_frame_916 — Giant 8°-tilted 9:16 smartphone ramp arch
# --------------------------------------------------------------------------
def build_prop_vertical_frame_916(root):
    mb = MB()
    # Grounded dark steel anchor shoes on both legs + concrete footing skirts to z = -1.5m
    for sx in (-1, 1):
        bevel_box(mb, (sx * 3.10, 0, 0.22), (1.35, 2.4, 0.44), "steel_dark", bev=0.05)
        foundation_skirt_box(mb, sx * 3.10, 0, 1.35, 2.4, 1.5, mat="concrete", bev=0.05)

    # Entire giant smartphone frame tilted 8° backward so cars jump dramatically through it
    Mt = rot_x(-8)
    piv = Vector((0.0, 0.0, 0.35))

    def tbox(pos, size, mat, bev=0.05):
        bevel_box(mb, piv + Mt @ Vector(pos), size, mat, bev=bev, M=Mt)

    # Sleek obsidian + brushed aluminum 9:16 portrait smartphone bezel
    tbox((-3.10, 0, 5.45), (0.68, 0.72, 10.9), "phone_obsidian", bev=0.10)  # left bezel
    tbox(( 3.10, 0, 5.45), (0.68, 0.72, 10.9), "phone_obsidian", bev=0.10)  # right bezel
    tbox(( 0.00, 0, 10.75), (6.88, 0.72, 0.92), "phone_obsidian", bev=0.10) # top bezel
    # Chrome perimeter metallic band
    tbox((-3.46, 0, 5.45), (0.08, 0.52, 10.6), "steel_light", bev=0.02)
    tbox(( 3.46, 0, 5.45), (0.08, 0.52, 10.6), "steel_light", bev=0.02)
    tbox(( 0.00, 0, 11.22), (6.82, 0.52, 0.08), "steel_light", bev=0.02)
    # Side power & volume rocker buttons
    tbox((3.54, 0, 7.6), (0.12, 0.24, 1.15), "steel_light", bev=0.02)
    tbox((-3.54, 0, 8.2), (0.12, 0.24, 0.80), "steel_light", bev=0.02)
    tbox((-3.54, 0, 7.0), (0.12, 0.24, 0.80), "steel_light", bev=0.02)
    # Top Dynamic Island / camera pill notch
    tbox((0.0, -0.36, 10.72), (1.65, 0.14, 0.34), "rubber_black", bev=0.06)
    sphere(mb, piv + Mt @ Vector((0.52, -0.44, 10.72)), 0.12, "glass_cyan", segs=8, rings=4)

    # Glowing crimson REC indicator dot + bar in top-left viewfinder corner (both faces!)
    for sy in (-1, 1):
        yf = sy * 0.38
        sphere(mb, piv + Mt @ Vector((-2.35, yf, 9.82)), 0.20, "led_red", segs=10, rings=5)
        box(mb, piv + Mt @ Vector((-1.65, yf, 9.82)), (0.85, 0.08, 0.22), "led_white", M=Mt)
        # 4 glowing white L-shaped camera viewfinder corner reticles cleanly inside the bezel
        for cx, cz in ((-2.45, 9.85), (2.45, 9.85), (-2.45, 1.55), (2.45, 1.55)):
            sx = -1 if cx < 0 else 1
            sz = -1 if cz < 5 else 1
            box(mb, piv + Mt @ Vector((cx - sx * 0.32, yf, cz)), (0.72, 0.08, 0.11), "led_white", M=Mt)
            box(mb, piv + Mt @ Vector((cx, yf, cz - sz * 0.32)), (0.11, 0.08, 0.72), "led_white", M=Mt)

    return {"body": mb, "children": {}}


# --------------------------------------------------------------------------
# 23. prop_billboard_gantry — 16m overhead highway steel gantry + billboard_face
# --------------------------------------------------------------------------
def build_prop_billboard_gantry(root):
    mb = MB()
    # Twin concrete highway footings (with -1.2m foundation skirts) + galvanized steel box-truss legs
    for sx in (-1, 1):
        bevel_box(mb, (sx * 7.2, 0, 0.45), (1.6, 2.0, 0.90), "concrete", bev=0.08)
        foundation_skirt_box(mb, sx * 7.2, 0, 1.6, 2.0, 1.2, mat="concrete", bev=0.08)
        truss_beam(mb, (sx * 7.2, 0, 0.90), (sx * 7.2, 0, 9.35), 0.78, 0.78, 5, 0.075, 0.038, "steel_galv")

    # Overhead horizontal highway box-truss span (z = 6.9 .. 8.3)
    truss_beam(mb, (-7.2, 0, 7.65), (7.2, 0, 7.65), 1.05, 1.05, 8, 0.075, 0.040, "steel_galv")

    # Dark steel billboard sign cabinet mounted centered on the front of the gantry
    bevel_box(mb, (0, -0.52, 7.65), (10.35, 0.44, 5.35), "forge_steel", bev=0.06)
    # Lower maintenance service catwalk + railing across front
    box(mb, (0, -1.18, 4.92), (10.6, 0.78, 0.10), "steel_galv")
    tube(mb, [(-5.3, -1.55, 5.75), (5.3, -1.55, 5.75)], 0.035, 4, "steel_galv")
    for kx in (-5.2, -2.6, 0.0, 2.6, 5.2):
        tube(mb, [(kx, -1.55, 4.92), (kx, -1.55, 5.75)], 0.032, 4, "steel_galv")

    # 4 overhead gooseneck floodlight arms illuminating the billboard face
    for lx in (-3.6, -1.2, 1.2, 3.6):
        tube(mb, [(lx, -0.55, 10.25), (lx, -1.45, 10.55), (lx, -1.85, 10.15)], 0.045, 5, "steel_dark")
        bevel_box(mb, (lx, -1.92, 10.05), (0.48, 0.28, 0.22), "forge_coal", bev=0.03, M=rot_x(32))
        box(mb, (lx, -1.86, 9.95), (0.38, 0.16, 0.06), "led_white", M=rot_x(32))

    # Separate named billboard_face mesh (10.0m x 5.0m, 2:1 aspect, flipY=true UVs)
    bf = MB()
    billboard_quad(bf, (0.0, -0.76, 7.65), 10.0, 5.0, mat="billboard_face")

    return {"body": mb, "children": {"billboard_face": (bf, (0.0, 0.0, 0.0), False)}}


# --------------------------------------------------------------------------
# 24. prop_roadside_billboard — Double-post roadside billboard + billboard_face
# --------------------------------------------------------------------------
def build_prop_roadside_billboard(root):
    mb = MB()
    # Twin concrete footings (to z = -1.0m) + galvanized-steel support posts + anchored rear diagonal braces
    for sx in (-1, 1):
        bevel_box(mb, (sx * 2.65, 0, 0.30), (1.15, 1.45, 0.60), "concrete", bev=0.06)
        foundation_skirt_box(mb, sx * 2.65, 0, 1.15, 1.45, 1.0, mat="concrete", bev=0.06)
        cyl(mb, (sx * 2.65, 0, -1.0), (sx * 2.65, 0, 5.85), 0.19, 0.17, 10, "steel_galv")
        # Rear diagonal brace seated cleanly in its own concrete anchor footing (z = -1.0..0.36m)
        bevel_box(mb, (sx * 2.65, 1.45, 0.18), (0.72, 0.82, 0.36), "concrete", bev=0.05)
        foundation_skirt_box(mb, sx * 2.65, 1.45, 0.72, 0.82, 1.0, mat="concrete", bev=0.05)
        cyl(mb, (sx * 2.65, 1.45, -1.0), (sx * 2.65, 1.45, 0.18), 0.10, 0.10, 6, "steel_galv")
        cyl(mb, (sx * 2.65, 1.45, 0.0), (sx * 2.65, 0.15, 4.45), 0.10, 0.10, 6, "steel_galv")
    # Horizontal cross brace between posts
    cyl(mb, (-2.65, 0, 2.0), (2.65, 0, 2.0), 0.09, 0.09, 6, "steel_galv")

    # Beveled dark-steel billboard cabinet frame (8.8m W x 4.55m H, z = 2.9 .. 7.45)
    bevel_box(mb, (0, -0.10, 5.15), (8.85, 0.42, 4.58), "forge_steel", bev=0.06)
    # Service catwalk & safety rail below billboard
    box(mb, (0, -0.78, 2.75), (8.9, 0.72, 0.09), "steel_galv")
    tube(mb, [(-4.4, -1.12, 3.45), (4.4, -1.12, 3.45)], 0.032, 4, "steel_galv")
    for kx in (-4.3, -2.15, 0.0, 2.15, 4.3):
        tube(mb, [(kx, -1.12, 2.75), (kx, -1.12, 3.45)], 0.030, 4, "steel_galv")

    # 3 curved gooseneck floodlights across the top edge
    for lx in (-2.8, 0.0, 2.8):
        tube(mb, [(lx, -0.15, 7.38), (lx, -0.95, 7.72), (lx, -1.35, 7.35)], 0.042, 5, "steel_dark")
        bevel_box(mb, (lx, -1.42, 7.25), (0.44, 0.26, 0.20), "forge_coal", bev=0.03, M=rot_x(34))
        box(mb, (lx, -1.36, 7.16), (0.34, 0.14, 0.06), "led_white", M=rot_x(34))

    # Separate named billboard_face mesh (8.4m x 4.2m, 2:1 aspect, flipY=true UVs)
    bf = MB()
    billboard_quad(bf, (0.0, -0.33, 5.15), 8.4, 4.2, mat="billboard_face")

    return {"body": mb, "children": {"billboard_face": (bf, (0.0, 0.0, 0.0), False)}}


# --------------------------------------------------------------------------
# Registry & CLI driver
# --------------------------------------------------------------------------
EASTER_EGGS = [
    ("prop_fi_toaster_shrine",  build_prop_fi_toaster_shrine),
    ("prop_kniffel_die",        build_prop_kniffel_die),
    ("prop_sudsblaster",        build_prop_sudsblaster),
    ("prop_nether_portal",      build_prop_nether_portal),
    ("prop_stadtpin_marker",    build_prop_stadtpin_marker),
    ("prop_embedding_cube",     build_prop_embedding_cube),
    ("prop_oilbert_icons",      build_prop_oilbert_icons),
    ("prop_jp_whirlpool_tent",  build_prop_jp_whirlpool_tent),
    ("prop_win98_frame",        build_prop_win98_frame),
    ("prop_vertical_frame_916", build_prop_vertical_frame_916),
    ("prop_billboard_gantry",   build_prop_billboard_gantry),
    ("prop_roadside_billboard", build_prop_roadside_billboard),
]


if __name__ == "__main__":
    opt = bd_common.parse_args()
    out_dir = opt.get("out", "/tmp/bulli-props-raw")
    meta_path = opt.get("meta")
    preview_dir = opt.get("preview")
    only = set(opt["only"].split(",")) if "only" in opt else None
    ao_samples = 0 if opt.get("no-ao") else 18

    results = []
    for prop_id, fn in EASTER_EGGS:
        if only and prop_id not in only:
            continue
        results.append(build_and_export_prop(prop_id, "prop", fn, out_dir,
                                             preview_dir=preview_dir, ao_samples=ao_samples))
    if meta_path:
        os.makedirs(os.path.dirname(os.path.abspath(meta_path)), exist_ok=True)
        with open(meta_path, "w") as f:
            json.dump(results, f, indent=2)
