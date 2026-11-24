# Shared procedural Blender library for Bulli Drive Hero Monuments & Easter-Egg Props.
#
# Conventions:
#   - 1 Blender unit = 1 meter, Blender Z-up -> glTF Y-up: (x, y, z)_bl -> (x, z, -y)_three
#   - Front faces Three.js +Z (build front facing Blender -Y)
#   - Origin at ground center (0, 0, 0), design ground plane at z = 0 (underground foundation skirts extend to z < 0)
#   - billboard_face UVs follow Three.js PlaneGeometry / flipY=true KTX2 convention:
#       bottom-left (-X, z0) -> glTF (0, 0) [Blender (0, 1)]
#       top-right   (+X, z1) -> glTF (1, 1) [Blender (1, 0)]
import bpy, bmesh, math, os, sys, json, time
from mathutils import Vector, Matrix

PROPS_LIB = os.path.dirname(os.path.abspath(__file__))
MODELS_LIB = os.path.normpath(os.path.join(PROPS_LIB, "..", "..", "lib"))
if MODELS_LIB not in sys.path:
    sys.path.insert(0, MODELS_LIB)

import bd_common
from bd_common import (  # noqa: F401
    MB, box, tube, lathe, frame_from_axis, empty, bake_ao,
    export_glb, delete_hierarchy, lin, srgb, set_material_factory,
    get_mat, pi, smoothstep, tri_count, aim, principled,
)
import bd_lookdev

# Curated PBR Material Palette (LMF brand palette + architectural + Easter-egg materials)
PROP_SPECS = {
    # LMF Brand & Forge Metals
    "forge_coal":     dict(col="#141110", rough=0.68, metal=0.25),
    "forge_steel":    dict(col="#383c42", rough=0.38, metal=0.86),
    "steel_light":    dict(col="#8a929a", rough=0.32, metal=0.88),
    "steel_galv":     dict(col="#9ca4ac", rough=0.40, metal=0.82),
    "steel_dark":     dict(col="#22252a", rough=0.46, metal=0.80),
    "chrome":         dict(col="#e2e6ea", rough=0.08, metal=0.98),
    "brass":          dict(col="#cfa044", rough=0.26, metal=0.92),
    "gold":           dict(col="#f0be4a", rough=0.20, metal=0.94),
    "copper":         dict(col="#b8653b", rough=0.32, metal=0.88),

    # LMF Brand Red & Emissives / Forge Alloys
    "lmf_red":        dict(col="#b80d29", rough=0.22, metal=0.12, coat=0.8),
    "lmf_red_glow":   dict(col="#c40822", rough=0.18, metal=0.05, emit="#e60a28", estr=1.25),
    "ember_glow":     dict(col="#f2600c", rough=0.35, metal=0.0,  emit="#ff6a14", estr=3.5),
    "ember_core":     dict(col="#ffb347", rough=0.25, metal=0.0,  emit="#ffbd59", estr=4.5),
    "alloy_gold":     dict(col="#e9c46a", rough=0.25, metal=0.65, emit="#e9c46a", estr=1.4),
    "alloy_purpur":   dict(col="#d59bf0", rough=0.25, metal=0.55, emit="#c97ef0", estr=1.8),
    "alloy_blau":     dict(col="#86aeff", rough=0.25, metal=0.55, emit="#6fa0ff", estr=1.8),
    "alloy_rotglut":  dict(col="#ff7d5c", rough=0.25, metal=0.55, emit="#ff6b45", estr=1.8),

    # Glowing UI / Stage / Neon Lights
    "led_green":      dict(col="#22ee66", rough=0.20, metal=0.0,  emit="#1ee860", estr=2.6),
    "led_amber":      dict(col="#ffaa22", rough=0.20, metal=0.0,  emit="#ffa61a", estr=2.6),
    "led_red":        dict(col="#ff2233", rough=0.20, metal=0.0,  emit="#ff1e30", estr=3.2),
    "led_cyan":       dict(col="#38e8ff", rough=0.20, metal=0.0,  emit="#33e6ff", estr=2.6),
    "led_white":      dict(col="#fff5e0", rough=0.18, metal=0.0,  emit="#fff2d6", estr=3.0),
    "warm_window":    dict(col="#ffd48a", rough=0.25, metal=0.0,  emit="#ffbe5c", estr=2.2),
    "marquee_bulb":   dict(col="#ffe8a8", rough=0.15, metal=0.0,  emit="#ffdc7a", estr=4.2),
    "rune_violet":    dict(col="#b46eff", rough=0.20, metal=0.0,  emit="#a855ff", estr=3.4),

    # Glass & Translucent Materials
    "glass_clear":    dict(col="#b8dce8", rough=0.08, metal=0.08, alpha=0.34, blend=True),
    "glass_dark":     dict(col="#1b2630", rough=0.10, metal=0.15, alpha=0.65, blend=True),
    "glass_cyan":     dict(col="#5ae0ff", rough=0.12, metal=0.10, alpha=0.45, emit="#2bc4e8", estr=0.6, blend=True),
    "glass_shard":    dict(col="#d8eef8", rough=0.06, metal=0.12, alpha=0.55, blend=True),
    "portal_swirl":   dict(col="#8a2be2", rough=0.15, metal=0.0,  alpha=0.72, emit="#9d3bff", estr=3.2, blend=True),
    "bubble_glass":   dict(col="#c4f2ff", rough=0.05, metal=0.10, alpha=0.58, emit="#a0e8ff", estr=0.7, blend=True),
    "laser_green":    dict(col="#00ff66", rough=0.10, metal=0.0,  alpha=0.58, emit="#00ff66", estr=4.2, blend=True),
    "water_glow":     dict(col="#28d8e6", rough=0.10, metal=0.05, emit="#1ab8cc", estr=1.2),

    # Architectural Stone, Plaster, Timber, Snow, Fabric
    "stone_dark":     dict(col="#4b4a48", rough=0.90, metal=0.0),
    "stone_warm":     dict(col="#8f8678", rough=0.88, metal=0.0),
    "stone_light":    dict(col="#b2aa9c", rough=0.86, metal=0.0),
    "concrete":       dict(col="#8a8b88", rough=0.90, metal=0.0),
    "obsidian":       dict(col="#181024", rough=0.32, metal=0.22),
    "obsidian_vein":  dict(col="#3b1d5e", rough=0.28, metal=0.15, emit="#5b2896", estr=0.9),
    "moss":           dict(col="#3f5d30", rough=0.92, metal=0.0),
    "slate_roof":     dict(col="#2f3542", rough=0.76, metal=0.05),
    "plaster_cream":  dict(col="#dfd2be", rough=0.82, metal=0.0),
    "plaster_ochre":  dict(col="#c9a878", rough=0.80, metal=0.0),
    "timber_dark":    dict(col="#4a301e", rough=0.84, metal=0.0),
    "timber_warm":    dict(col="#8c5a32", rough=0.78, metal=0.0),
    "teak_deck":      dict(col="#a67244", rough=0.70, metal=0.0),
    "snow":           dict(col="#eef4fa", rough=0.68, metal=0.0),
    "velvet_red":     dict(col="#7e0e1e", rough=0.90, metal=0.0),
    "sail_white":     dict(col="#f4f2eb", rough=0.64, metal=0.0),
    "hull_blue":      dict(col="#14437a", rough=0.24, metal=0.10, coat=0.7),
    "hull_white":     dict(col="#eaece8", rough=0.28, metal=0.05, coat=0.5),
    "canopy_dark":    dict(col="#1e2126", rough=0.86, metal=0.0),
    "vinyl_black":    dict(col="#141416", rough=0.22, metal=0.18),

    # Easter-Egg & Brand Accents
    "hazard_yellow":  dict(col="#e8b818", rough=0.45, metal=0.05),
    "rubber_black":   dict(col="#1a1a1c", rough=0.88, metal=0.0),
    "ivory":          dict(col="#f2ead9", rough=0.32, metal=0.0, coat=0.4),
    "toast_golden":   dict(col="#c87d32", rough=0.86, metal=0.0),
    "toast_crust":    dict(col="#6e3c16", rough=0.90, metal=0.0),
    "suds_purple":    dict(col="#7a32b8", rough=0.28, metal=0.35, coat=0.5),
    "suds_teal":      dict(col="#1ca8a8", rough=0.28, metal=0.30, coat=0.5),
    "jp_pink":        dict(col="#ff2d87", rough=0.42, metal=0.05, emit="#c41460", estr=0.25),
    "jp_pink_light":  dict(col="#ff74b0", rough=0.55, metal=0.0),
    "oilbert_green":  dict(col="#3ea63e", rough=0.72, metal=0.0),
    "oilbert_orange": dict(col="#e86820", rough=0.68, metal=0.0),
    "oilbert_soil":   dict(col="#5c3a22", rough=0.88, metal=0.0),
    "wing_white":     dict(col="#f6f7fa", rough=0.35, metal=0.08),
    "bomb_black":     dict(col="#16181c", rough=0.18, metal=0.45),
    "win98_grey":     dict(col="#c0c0c0", rough=0.58, metal=0.04),
    "win98_dark":     dict(col="#808080", rough=0.65, metal=0.06),
    "win98_light":    dict(col="#dfdfdf", rough=0.50, metal=0.02),
    "win98_navy":     dict(col="#000080", rough=0.42, metal=0.05),
    "win98_teal":     dict(col="#008080", rough=0.55, metal=0.0),
    "phone_obsidian": dict(col="#16181e", rough=0.20, metal=0.78),
    "ski_blue":       dict(col="#1d65b8", rough=0.26, metal=0.15),

    # Pure white neutral material for externally textured billboard quads
    "billboard_face": dict(col="#ffffff", rough=0.42, metal=0.0),
}

NO_AO_MATS = {
    name for name, s in PROP_SPECS.items()
    if s.get("emit") or s.get("blend") or name == "billboard_face"
}


def make_prop_material(name):
    s = PROP_SPECS[name]
    m = bpy.data.materials.new(name)
    b = principled(m)
    b.inputs["Base Color"].default_value = (*lin(s["col"]), 1.0)
    b.inputs["Roughness"].default_value = s["rough"]
    b.inputs["Metallic"].default_value = s.get("metal", 0.0)
    if s.get("coat"):
        if "Coat Weight" in b.inputs:
            b.inputs["Coat Weight"].default_value = s["coat"]
        if "Coat Roughness" in b.inputs:
            b.inputs["Coat Roughness"].default_value = 0.08
    if s.get("emit"):
        b.inputs["Emission Color"].default_value = (*lin(s["emit"]), 1.0)
        b.inputs["Emission Strength"].default_value = s.get("estr", 1.5)
    if s.get("alpha", 1.0) < 0.999:
        b.inputs["Alpha"].default_value = s["alpha"]
    if s.get("blend"):
        for attr, val in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
            try:
                setattr(m, attr, val)
            except Exception:
                pass
        m.use_backface_culling = False
    else:
        m.use_backface_culling = (name != "billboard_face")
    return m


# --------------------------------------------------------------------------
# High-craft geometric primitives
# --------------------------------------------------------------------------
def rot_z(deg):
    return Matrix.Rotation(math.radians(deg), 3, "Z")


def rot_x(deg):
    return Matrix.Rotation(math.radians(deg), 3, "X")


def rot_y(deg):
    return Matrix.Rotation(math.radians(deg), 3, "Y")


def bevel_box(mb, center, size, mat, bev=0.06, M=None):
    """Chamfered box with crisp highlight bevels along all 12 edges."""
    n0 = mb.nfaces()
    M = M or Matrix.Identity(3)
    c = Vector(center)
    hx, hy, hz = [s / 2 for s in size]
    b = min(bev, hx * 0.35, hy * 0.35, hz * 0.35)
    if b <= 1e-4:
        box(mb, center, size, mat, M=M)
        return
    # Build via 4-slice Z extrusion (bottom inset, lower, upper, top inset)
    levels = [
        (-hz,     hx - b, hy - b),
        (-hz + b, hx,     hy),
        ( hz - b, hx,     hy),
        ( hz,     hx - b, hy - b),
    ]
    rings = []
    for z, rx, ry in levels:
        # 8-vertex octagon ring with corner chamfers
        bx = max(0.0, rx - b)
        by = max(0.0, ry - b)
        pts = [
            (-bx, -ry), ( bx, -ry),
            ( rx, -by), ( rx,  by),
            ( bx,  ry), (-bx,  ry),
            (-rx,  by), (-rx, -by),
        ]
        rings.append([mb.v(c + M @ Vector((px, py, z))) for (px, py) in pts])
    mb.grid(rings, lambda i, j: mat, closed=True)
    # Bottom and top caps
    mb.f(rings[0][::-1], mat)
    mb.f(rings[-1], mat)
    mb.recalc(n0, soft=False)


def foundation_skirt_box(mb, cx, cy, wx, wy, depth, mat="stone_dark", bev=0.0):
    """Underground masonry/concrete plinth skirt extending from z = +top_lap down to z = -depth.
    Matches the bottom footprint of bevel_box((cx, cy, ...), (wx, wy, ...), bev=bev) at z = 0
    so it stays hidden on flat ground (zero lip, zero X/Y bounds growth) and solid on slopes."""
    if depth <= 0.0:
        return
    n0 = mb.nfaces()
    hx, hy = wx / 2.0, wy / 2.0
    b = min(bev, hx * 0.35, hy * 0.35) if bev > 0.0 else 0.0
    if b > 1e-4:
        rx, ry = hx - b, hy - b
        bx, by = max(0.0, rx - b), max(0.0, ry - b)
        pts = [
            (-bx, -ry), ( bx, -ry),
            ( rx, -by), ( rx,  by),
            ( bx,  ry), (-bx,  ry),
            (-rx,  by), (-rx, -by),
        ]
        z_top = min(0.04, b * 0.5)
    else:
        pts = [(-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)]
        z_top = 0.02
    r_bot = [mb.v((cx + px, cy + py, -depth)) for (px, py) in pts]
    r_top = [mb.v((cx + px, cy + py, z_top)) for (px, py) in pts]
    mb.grid([r_bot, r_top], lambda i, j: mat, closed=True)
    mb.f(r_bot[::-1], mat)
    mb.f(r_top, mat)
    mb.recalc(n0, soft=False)


def cyl(mb, p0, p1, r0, r1=None, segs=12, mat="forge_steel", cap0=True, cap1=True):
    """Cylinder or tapered frustum from p0 to p1."""
    if r1 is None:
        r1 = r0
    v0, v1 = Vector(p0), Vector(p1)
    d = v1 - v0
    L = d.length
    if L < 1e-6:
        return
    M = frame_from_axis(d)
    prof = []
    mats = []
    if cap0:
        prof.append((0.0, 0.0))
    prof.append((r0, 0.0))
    prof.append((r1, L))
    if cap1:
        prof.append((0.0, L))
    mats = [mat] * (len(prof) - 1)
    lathe(mb, prof, segs, M, v0, mats)


def sphere(mb, center, radius, mat, segs=12, rings=8, sx=1.0, sy=1.0, sz=1.0, M=None):
    """UV ellipsoid/sphere via lathe."""
    M = M or Matrix.Identity(3)
    prof = []
    for i in range(rings + 1):
        a = -pi / 2 + pi * i / rings
        r = max(0.0, radius * math.cos(a))
        z = radius * math.sin(a) * sz
        if i == 0 or i == rings:
            r = 0.0
        prof.append((r, z))
    lathe(mb, prof, segs, M, Vector(center), [mat] * rings, sx=sx, sy=sy)


def torus(mb, center, major_r, minor_r, segs_maj=20, segs_min=8, mat="brass", axis=(0, 0, 1)):
    """Closed torus ring around axis."""
    M = frame_from_axis(Vector(axis))
    c = Vector(center)
    pts = [c + M @ Vector((major_r * math.cos(2 * pi * k / segs_maj),
                           major_r * math.sin(2 * pi * k / segs_maj), 0.0))
           for k in range(segs_maj)]
    tube(mb, pts, minor_r, segs_min, mat, closed=True)


def arch_vault(mb, y_center, z_spring, half_w, arch_h, depth, thick, segs, mat, pointed=False,
               x_center=0.0, keystone_mat=None):
    """Extruded semicircular or Gothic pointed arch spanning x in [x_center-half_w, x_center+half_w]."""
    n0 = mb.nfaces()
    hy = depth / 2
    inner = []
    outer = []
    for i in range(segs + 1):
        t = i / segs
        if not pointed:
            ang = pi * (1.0 - t)
            xi = half_w * math.cos(ang)
            zi = arch_h * math.sin(ang)
            nx, nz = math.cos(ang), math.sin(ang)
        else:
            # Pointed Gothic arch from two intersecting arcs
            if t <= 0.5:
                u = t * 2.0
                ang = pi - u * (pi / 2.65)
                cx = half_w * 0.38
                R = half_w + cx
                xi = cx + R * math.cos(ang)
                zi = arch_h * (R * math.sin(ang)) / max(R * math.sin(pi / 2.65), 1e-4)
                nx, nz = math.cos(ang), math.sin(ang)
            else:
                u = (t - 0.5) * 2.0
                ang = (pi / 2.65) * (1.0 - u)
                cx = -half_w * 0.38
                R = half_w - cx
                xi = cx + R * math.cos(ang)
                zi = arch_h * (R * math.sin(ang)) / max(R * math.sin(pi / 2.65), 1e-4)
                nx, nz = math.cos(ang), math.sin(ang)
        v_n = Vector((nx, nz)).normalized()
        inner.append((x_center + xi, z_spring + zi))
        outer.append((x_center + xi + v_n.x * thick, z_spring + zi + v_n.y * thick))
    # Build 4 loops: front-inner, front-outer, back-outer, back-inner
    rings = []
    for i in range(segs + 1):
        ix, iz = inner[i]
        ox, oz = outer[i]
        rings.append([
            mb.v((ix, y_center - hy, iz)),
            mb.v((ox, y_center - hy, oz)),
            mb.v((ox, y_center + hy, oz)),
            mb.v((ix, y_center + hy, iz)),
        ])
    mid = segs // 2
    for i in range(segs):
        m = keystone_mat if (keystone_mat and abs(i - mid) <= 0) else mat
        for j in range(4):
            jn = (j + 1) % 4
            mb.f([rings[i][j], rings[i][jn], rings[i + 1][jn], rings[i + 1][j]], m)
    # Cap both spring ends
    mb.f(rings[0][::-1], mat)
    mb.f(rings[-1], mat)
    mb.recalc(n0, soft=False)


def truss_beam(mb, p0, p1, w, h, bays, r_chord, r_brace, mat="steel_galv", sides=4):
    """4-chord box truss with alternating diagonal web bracing along p0 -> p1."""
    v0, v1 = Vector(p0), Vector(p1)
    d = v1 - v0
    L = d.length
    if L < 1e-4:
        return
    M = frame_from_axis(d)
    hw, hh = w / 2, h / 2
    corners = [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)]
    # 4 longitudinal chords
    for cx, cy in corners:
        off = M @ Vector((cx, cy, 0))
        tube(mb, [v0 + off, v1 + off], r_chord, sides, mat)
    # Cross frames & diagonals
    for i in range(bays + 1):
        t = i / bays
        base = v0 + d * t
        pts = [base + M @ Vector((cx, cy, 0)) for (cx, cy) in corners]
        for j in range(4):
            tube(mb, [pts[j], pts[(j + 1) % 4]], r_brace, 4, mat, cap_start=False, cap_end=False)
        if i < bays:
            base2 = v0 + d * ((i + 1) / bays)
            pts2 = [base2 + M @ Vector((cx, cy, 0)) for (cx, cy) in corners]
            for j in range(4):
                jn = (j + 1) % 4
                a, b = (pts[j], pts2[jn]) if (i + j) % 2 == 0 else (pts[jn], pts2[j])
                tube(mb, [a, b], r_brace * 0.85, 4, mat, cap_start=False, cap_end=False)


def gable_roof(mb, cx, cy, z_eave, wx, ly, ridge_h, thick, mat_roof, mat_gable=None):
    """Pitched gable roof with thickness along X slope and ridge running along Y."""
    n0 = mb.nfaces()
    hx, hy = wx / 2, ly / 2
    # Two pitched roof slabs (left -X and right +X)
    for sx in (-1, 1):
        # Cross section in XZ: eave outer, ridge top, ridge bottom, eave inner
        slope = Vector((-sx * hx, 0, ridge_h)).normalized()
        nrm = Vector((sx * ridge_h, 0, hx)).normalized()
        e_bot = Vector((cx + sx * hx, 0, z_eave))
        r_bot = Vector((cx, 0, z_eave + ridge_h))
        e_top = e_bot + nrm * thick
        r_top = Vector((cx, 0, z_eave + ridge_h + thick / max(nrm.z, 0.3)))
        ring_f = [mb.v((p.x, cy - hy, p.z)) for p in (e_bot, r_bot, r_top, e_top)]
        ring_b = [mb.v((p.x, cy + hy, p.z)) for p in (e_bot, r_bot, r_top, e_top)]
        for j in range(4):
            jn = (j + 1) % 4
            mb.f([ring_f[j], ring_f[jn], ring_b[jn], ring_b[j]], mat_roof)
        mb.f(ring_f[::-1], mat_roof)
        mb.f(ring_b, mat_roof)
    # Optional triangular gable wall infills at front and back
    if mat_gable:
        for sy in (-1, 1):
            y = cy + sy * (hy - 0.18)
            p_l = mb.v((cx - hx + 0.35, y, z_eave + 0.05))
            p_r = mb.v((cx + hx - 0.35, y, z_eave + 0.05))
            p_t = mb.v((cx, y, z_eave + ridge_h))
            mb.f([p_l, p_r, p_t] if sy < 0 else [p_r, p_l, p_t], mat_gable)
    mb.recalc(n0, soft=False)


def billboard_quad(mb, center, width, height, mat="billboard_face", yaw_rad=0.0):
    """Single UV-mapped quad facing Blender -Y (Three.js +Z) matching Three.js PlaneGeometry
    with flipY=true KTX2 billboard textures (glTF v=0 bottom, v=1 top)."""
    M = Matrix.Rotation(yaw_rad, 3, "Z")
    c = Vector(center)
    hw, hh = width / 2, height / 2
    pts = [
        c + M @ Vector((-hw, 0.0, -hh)),  # bottom-left  -> glTF (0, 0)
        c + M @ Vector(( hw, 0.0, -hh)),  # bottom-right -> glTF (1, 0)
        c + M @ Vector(( hw, 0.0,  hh)),  # top-right    -> glTF (1, 1)
        c + M @ Vector((-hw, 0.0,  hh)),  # top-left     -> glTF (0, 1)
    ]
    vs = [mb.v(p) for p in pts]
    fc = mb.f(vs, mat)
    # Blender glTF exporter sets v_gl = 1 - v_bl -> pass (u, 1 - v_gl)
    mb.set_uv(fc, vs, [(0.0, 1.0), (1.0, 1.0), (1.0, 0.0), (0.0, 0.0)])
    return fc


# --------------------------------------------------------------------------
# Scene reset, assembly, AO baking, bounds & preview rendering
# --------------------------------------------------------------------------
def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bd_common.MATS.clear()
    set_material_factory(make_prop_material)


def compute_threejs_bounds(root):
    """Exact AABB across all child meshes mapped to Three.js Y-up (x, z, -y)."""
    mins = [1e9, 1e9, 1e9]
    maxs = [-1e9, -1e9, -1e9]
    bpy.context.view_layer.update()
    for o in root.children_recursive:
        if o.type != "MESH":
            continue
        M = o.matrix_world
        for v in o.data.vertices:
            w = M @ v.co
            tx, ty, tz = w.x, w.z, -w.y
            mins[0] = min(mins[0], tx)
            mins[1] = min(mins[1], ty)
            mins[2] = min(mins[2], tz)
            maxs[0] = max(maxs[0], tx)
            maxs[1] = max(maxs[1], ty)
            maxs[2] = max(maxs[2], tz)
    return {
        "min": [round(x, 3) for x in mins],
        "max": [round(x, 3) for x in maxs],
    }


def render_preview(root, out_png, size=480):
    """Quick 3/4 Eevee preview render of a single prop for visual QA."""
    bounds = compute_threejs_bounds(root)
    # Convert Three.js bounds back to Blender coords: bl = (tx, -tz, ty); frame above-ground portion
    bmin = Vector((bounds["min"][0], -bounds["max"][2], max(0.0, bounds["min"][1])))
    bmax = Vector((bounds["max"][0], -bounds["min"][2], bounds["max"][1]))
    ctr = (bmin + bmax) * 0.5
    ext = (bmax - bmin)
    diag = max(ext.length, 2.0)

    info = bd_lookdev.load_env("victoria_sunset_1k")
    bd_lookdev.setup_render_scene(info, need_ground=False)
    scene = bpy.context.scene
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    if hasattr(scene.eevee, "taa_render_samples"):
        scene.eevee.taa_render_samples = 16
    # Ground plane for visual grounding check
    g = MB()
    r = max(diag * 2.5, 16.0)
    g.f([g.v((-r, -r, -0.01)), g.v((r, -r, -0.01)), g.v((r, r, -0.01)), g.v((-r, r, -0.01))], "concrete")
    ground = g.obj("_preview_ground")

    cam_data = bpy.data.cameras.new("PreviewCam")
    cam_data.lens = 42
    cam_data.clip_end = 500.0
    cam = bpy.data.objects.new("PreviewCam", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam

    # Camera on front-right 3/4 (-Y is front in Blender = +Z in Three.js)
    dist = diag * 1.18
    eye = ctr + Vector((dist * 0.56, -dist * 0.78, dist * 0.34))
    aim(cam, eye, ctr + Vector((0, 0, -ext.z * 0.04)))

    scene = bpy.context.scene
    scene.render.film_transparent = False
    scene.render.filepath = out_png
    bpy.ops.render.render(write_still=True)

    bpy.data.objects.remove(ground, do_unlink=True)
    bpy.data.objects.remove(cam, do_unlink=True)


def build_and_export_prop(prop_id, kind, builder_fn, out_dir, preview_dir=None, ao_samples=20):
    """Builds a single prop, bakes gentle AO, exports raw GLB, optionally renders preview."""
    t0 = time.time()
    reset_scene()
    root = empty(prop_id, (0, 0, 0), prop_id=prop_id, kind=kind)
    res = builder_fn(root)
    # res is dict: { "body": MB, "children": { name: (MB, pivot_bl, is_anim) } }
    meshes = []
    body_obj = res["body"].obj("body", smooth_angle=36.0, parent=root)
    meshes.append(body_obj)

    anim_nodes = []
    has_billboard = False
    for cname, spec in res.get("children", {}).items():
        cmb, pivot, is_anim = spec
        cobj = cmb.obj(cname, smooth_angle=36.0, parent=root, mat_sharp=(cname != "billboard_face"))
        if pivot and Vector(pivot).length > 1e-6:
            # Shift vertices into local space around pivot so rotation/translation works cleanly!
            pv = Vector(pivot)
            for v in cobj.data.vertices:
                v.co -= pv
            cobj.data.update()
            cobj.location = pv
        meshes.append(cobj)
        if is_anim:
            anim_nodes.append(cname)
        if cname == "billboard_face":
            has_billboard = True

    bpy.context.view_layer.update()

    # Bake gentle per-vertex AO on static body (skips emissives, glass, billboard_face)
    if ao_samples > 0:
        bounds_pre = compute_threejs_bounds(root)
        ext_max = max(bounds_pre["max"][i] - bounds_pre["min"][i] for i in range(3))
        ao_dist = min(1.8, max(0.35, ext_max * 0.12))
        bake_ao(body_obj, [body_obj], samples=ao_samples, dist=ao_dist, strength=0.48, skip=NO_AO_MATS)

    total_tris = sum(tri_count(m) for m in meshes)
    bounds = compute_threejs_bounds(root)
    foundation = round(max(0.0, -bounds["min"][1]), 3)
    root["foundation"] = foundation

    os.makedirs(out_dir, exist_ok=True)
    raw_path = os.path.join(out_dir, f"{prop_id}_raw.glb")
    export_glb(root, raw_path)

    if preview_dir:
        os.makedirs(preview_dir, exist_ok=True)
        render_preview(root, os.path.join(preview_dir, f"{prop_id}.png"))

    info = {
        "id": prop_id,
        "kind": kind,
        "raw": raw_path,
        "triangles": total_tris,
        "foundation": foundation,
        "bounds": bounds,
        "animNodes": anim_nodes,
        "hasBillboard": has_billboard,
        "s": round(time.time() - t0, 2),
    }
    print(f"[prop] {prop_id}: {total_tris} tris, foundation={foundation}m, bounds={bounds['min']}..{bounds['max']}, "
          f"anim={anim_nodes}, {info['s']}s", flush=True)
    return info
