# Look-dev renders for the car builds (Blender Eevee), shared by tools/models/vehicles/*.py.
#
# Only used after the GLBs are exported: it adds a sun, the Victoria Sunset HDRI (sun clamped
# out, see make_env.py) and an asphalt ground plane, then renders fixed camera views. The
# orthographic workbench renders (render_ortho) are for blueprint overlays.
#
# Inputs (not in git, fetched/prepared by the tools):
#   tools/textures/.cache/hdri/victoria_sunset_2k.hdr          (npm --prefix tools run textures:fetch)
#   tools/models/.cache/env/env_info.json + *_nosun.hdr          (python3 tools/models/lib/make_env.py)
#   tools/textures/.cache/polyhaven/asphalt_clean/*.jpg          (textures:fetch)
import bpy, math, os, json, time
from mathutils import Vector
from bd_common import principled, lin, aim, get_mat, MATS

MODELS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.dirname(MODELS)
ENV_DIR = os.path.join(MODELS, ".cache", "env")
ASPHALT_DIR = os.path.join(TOOLS, "textures", ".cache", "polyhaven", "asphalt_clean")


def load_env(name):
    p = os.path.join(ENV_DIR, "env_info.json")
    if not os.path.exists(p):
        raise SystemExit("look-dev renders need %s: run npm --prefix tools run textures:fetch and "
                         "python3 tools/models/lib/make_env.py (or pass --no-render)" % p)
    return json.load(open(p))[name]


SUN_ELEV = 11.0


def setup_render_scene(info):
    scene = bpy.context.scene
    col = scene.collection
    r = scene.render
    r.engine = "BLENDER_EEVEE"
    r.resolution_x, r.resolution_y = 1600, 900
    r.film_transparent = False
    ee = scene.eevee
    for attr, val in (("taa_render_samples", 96), ("use_raytracing", True), ("use_shadows", True),
                      ("shadow_ray_count", 2), ("shadow_step_count", 10), ("use_fast_gi", True),
                      ("fast_gi_method", "GLOBAL_ILLUMINATION"), ("ray_tracing_method", "SCREEN")):
        if hasattr(ee, attr):
            try:
                setattr(ee, attr, val)
            except Exception:
                pass
    try:
        ee.ray_tracing_options.resolution_scale = "1"
    except Exception:
        pass
    vs = scene.view_settings
    avail = [i.identifier for i in vs.bl_rna.properties["view_transform"].enum_items]
    for vt in ("AgX", "Filmic"):
        if vt in avail:
            vs.view_transform = vt
            break
    for look in ("AgX - Base Contrast", "AgX - Medium High Contrast", "None"):
        try:
            vs.look = look
            break
        except Exception:
            pass
    vs.exposure = -0.35
    # world: sun-clamped HDRI for lighting, original HDRI for camera rays (visible sun)
    w = bpy.data.worlds.new("victoria_sunset")
    scene.world = w
    try:
        w.use_nodes = True
    except Exception:
        pass
    nt = w.node_tree
    nt.nodes.clear()
    tc = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    nt.links.new(tc.outputs["Generated"], mp.inputs["Vector"])
    env_l = nt.nodes.new("ShaderNodeTexEnvironment")
    env_l.image = bpy.data.images.load(info["nosun"])
    env_c = nt.nodes.new("ShaderNodeTexEnvironment")
    env_c.image = bpy.data.images.load(info["src"])
    for e in (env_l, env_c):
        nt.links.new(mp.outputs["Vector"], e.inputs["Vector"])
    lp = nt.nodes.new("ShaderNodeLightPath")
    mix = nt.nodes.new("ShaderNodeMixRGB")
    nt.links.new(lp.outputs["Is Camera Ray"], mix.inputs["Fac"])
    nt.links.new(env_l.outputs["Color"], mix.inputs["Color1"])
    nt.links.new(env_c.outputs["Color"], mix.inputs["Color2"])
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Strength"].default_value = 1.0
    nt.links.new(mix.outputs["Color"], bg.inputs["Color"])
    out = nt.nodes.new("ShaderNodeOutputWorld")
    nt.links.new(bg.outputs[0], out.inputs["Surface"])
    for attr, val in (("sun_threshold", 1e6), ("use_sun_shadow", False)):
        if hasattr(w, attr):
            try:
                setattr(w, attr, val)
            except Exception:
                pass
    # sun lamp
    sd = bpy.data.lights.new("sun", "SUN")
    sd.color = (1.0, 0.86, 0.72)
    sd.energy = 4.0
    sd.angle = math.radians(1.2)
    so = bpy.data.objects.new("sun", sd)
    col.objects.link(so)
    # ground: asphalt (Poly Haven clean_asphalt, 2.1 m tile) with a dashed yellow centre line
    tex = ASPHALT_DIR
    me = bpy.data.meshes.new("ground")
    Sg = 120
    me.from_pydata([(-Sg, -Sg, 0), (Sg, -Sg, 0), (Sg, Sg, 0), (-Sg, Sg, 0)], [], [(0, 1, 2, 3)])
    me.uv_layers.new(name="UVMap")
    k = Sg * 2 / 2.1
    for li, uv in zip(range(4), [(0, 0), (k, 0), (k, k), (0, k)]):
        me.uv_layers[0].data[li].uv = uv
    gm = bpy.data.materials.new("scene_asphalt")
    b = principled(gm)
    gnt = gm.node_tree

    def timg(fn, cs):
        t = gnt.nodes.new("ShaderNodeTexImage")
        t.image = bpy.data.images.load(os.path.join(tex, fn))
        t.image.colorspace_settings.name = cs
        return t
    ta = timg("asphalt_clean_albedo_1k.jpg", "sRGB")
    dark = gnt.nodes.new("ShaderNodeMixRGB")
    dark.blend_type = "MULTIPLY"
    dark.inputs["Fac"].default_value = 1.0
    dark.inputs["Color2"].default_value = (0.55, 0.52, 0.50, 1)
    tr = timg("asphalt_clean_roughness_1k.jpg", "Non-Color")
    tn = timg("asphalt_clean_normal_1k.jpg", "Non-Color")
    nm = gnt.nodes.new("ShaderNodeNormalMap")
    gnt.links.new(ta.outputs["Color"], dark.inputs["Color1"])
    gnt.links.new(dark.outputs["Color"], b.inputs["Base Color"])
    gnt.links.new(tr.outputs["Color"], b.inputs["Roughness"])
    gnt.links.new(tn.outputs["Color"], nm.inputs["Color"])
    gnt.links.new(nm.outputs["Normal"], b.inputs["Normal"])
    me.materials.append(gm)
    g = bpy.data.objects.new("ground", me)
    col.objects.link(g)
    lm = bpy.data.materials.new("scene_line")
    lb = principled(lm)
    lb.inputs["Base Color"].default_value = (*lin("#D9A23A"), 1)
    lb.inputs["Roughness"].default_value = 0.7
    for i in range(-10, 11):
        lme = bpy.data.meshes.new("line")
        y0 = i * 6.0
        lme.from_pydata([(-2.2, y0, 0.002), (-2.08, y0, 0.002), (-2.08, y0 + 3.0, 0.002), (-2.2, y0 + 3.0, 0.002)], [], [(0, 1, 2, 3)])
        lme.materials.append(lm)
        lo = bpy.data.objects.new("line", lme)
        col.objects.link(lo)
    return so, mp, info


# view: camera loc, target, lens, sun azimuth relative to the car (deg, 0 = sun ahead of the car (-Y),
# 90 = sun on the car's left (+X))
CAMS = {
    "front34": dict(loc=(3.7, -5.6, 1.0), tgt=(0.1, -0.4, 0.95), lens=50, sun_rel=115, dof=5.6),
    "side": dict(loc=(9.0, -0.3, 1.25), tgt=(0, 0.0, 0.98), lens=50, sun_rel=40, dof=None),
    "rear34": dict(loc=(-4.3, 6.4, 1.45), tgt=(0.0, 0.3, 0.95), lens=45, sun_rel=-35, dof=5.6, surf=True),
    "chase": dict(loc=(0.0, 9.6, 3.0), tgt=(0.0, -6.0, 0.6), lens=30, sun_rel=0, dof=None),
}


def wire_ao_for_render(names):
    """Eevee look-dev only (after export): multiply the baked AO colour attribute into the base colour
    of the paints and the atlas (three.js does this automatically via COLOR_0)."""
    for name in names:
        m = MATS.get(name)
        if not m:
            continue
        nt = m.node_tree
        b = nt.nodes.get("Principled BSDF")
        ca = nt.nodes.new("ShaderNodeVertexColor")
        ca.layer_name = "Col"
        mix = nt.nodes.new("ShaderNodeMixRGB")
        mix.blend_type = "MULTIPLY"
        mix.inputs["Fac"].default_value = 1.0
        sock = b.inputs["Base Color"]
        if sock.is_linked:
            src = sock.links[0].from_socket
            nt.links.new(src, mix.inputs["Color1"])
        else:
            mix.inputs["Color1"].default_value = sock.default_value
        nt.links.new(ca.outputs["Color"], mix.inputs["Color2"])
        nt.links.new(mix.outputs["Color"], sock)


def render_views(car_root, info, out_dir, suffix="", views=None, cams=None, ao_materials=()):
    """Eevee stills of car_root for the named views (CAMS keys) -> <out_dir>/<view><suffix>.png"""
    scene = bpy.context.scene
    col = scene.collection
    cams = cams or CAMS
    views = views or list(cams)
    wire_ao_for_render(ao_materials)
    so, mp, info = setup_render_scene(info)
    res = {}
    az0 = math.atan2(info["sun_dir_blender"][1], info["sun_dir_blender"][0])
    for name, c in cams.items():
        if name not in views:
            continue
        # sun direction relative to the car: 0 = ahead (-Y), 90 = left (+X)
        rel = math.radians(c["sun_rel"])
        d = Vector((math.sin(rel), -math.cos(rel), 0.0))
        az_des = math.atan2(d.y, d.x)
        el = math.radians(SUN_ELEV)
        sdir = Vector((math.cos(az_des) * math.cos(el), math.sin(az_des) * math.cos(el), math.sin(el)))
        so.rotation_euler = (-sdir).to_track_quat("-Z", "Y").to_euler()
        # rotate the HDRI so its (visible) sun sits at the same azimuth
        mp.inputs["Rotation"].default_value = (0, 0, az0 - az_des)
        cd = bpy.data.cameras.new(name)
        cd.lens = c["lens"]
        cd.clip_end = 500
        co = bpy.data.objects.new("cam_" + name, cd)
        col.objects.link(co)
        aim(co, c["loc"], c["tgt"])
        if c["dof"]:
            cd.dof.use_dof = True
            cd.dof.focus_distance = (Vector(c["tgt"]) - Vector(c["loc"])).length
            cd.dof.aperture_fstop = c["dof"]
        scene.camera = co
        board = [o for o in car_root.children_recursive if o.name == "accessory_surfboard"]
        for o in board:
            o.hide_render = not c.get("surf", False)
        p = os.path.join(out_dir, name + suffix + ".png")
        scene.render.filepath = p
        t = time.time()
        bpy.ops.render.render(write_still=True)
        res[name] = {"file": p, "s": round(time.time() - t, 1)}
        print("RENDER", name, res[name])
    return res


def render_ortho(out_dir):
    """flat workbench renders at 250 px/m for the blueprint overlay (compare_blueprint.py)."""
    scene = bpy.context.scene
    col = scene.collection
    r = scene.render
    r.engine = "BLENDER_WORKBENCH"
    r.resolution_x, r.resolution_y = 1200, 600
    r.film_transparent = True
    sh = scene.display.shading
    sh.light = "STUDIO"
    sh.color_type = "MATERIAL"
    sh.show_cavity = False
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.exposure = 0
    res = {}
    for name, loc, tgt in (("side", (10, 0, 0.97), (0, 0, 0.97)), ("front", (0, -10, 0.97), (0, 0, 0.97)),
                           ("rear", (0, 10, 0.97), (0, 0, 0.97)), ("top", (0, 0, 10), (0, 0, 0))):
        cd = bpy.data.cameras.new("o_" + name)
        cd.type = "ORTHO"
        cd.ortho_scale = 4.8
        co = bpy.data.objects.new("o_" + name, cd)
        col.objects.link(co)
        co.location = loc
        if name == "top":
            co.rotation_euler = (0, 0, math.radians(90))   # image right = +Y (rear), like the blueprint
        else:
            co.rotation_euler = (Vector(tgt) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        scene.camera = co
        p = os.path.join(out_dir, "ortho_%s.png" % name)
        r.filepath = p
        bpy.ops.render.render(write_still=True)
        res[name] = p
    r.film_transparent = False
    return res




def render_icon(car_root, info, path, size=(480, 300)):
    """Car-select icon of the start screen: the car alone on a transparent background, seen from the
    front left like a product shot, lit by the sun-clamped HDRI and a warm key light. build-all.mjs
    trims it and writes public/icons/car-<id>.webp."""
    scene = bpy.context.scene
    col = scene.collection
    so, mp, info = setup_render_scene(info)
    for o in list(col.objects):
        if o.name.startswith(("ground", "line")):
            o.hide_render = True
    r = scene.render
    r.resolution_x, r.resolution_y = size
    r.film_transparent = True
    r.image_settings.file_format = "PNG"
    r.image_settings.color_mode = "RGBA"
    scene.view_settings.exposure = -0.1
    # key light from the front left, a little above the car
    rel = math.radians(70)
    el = math.radians(28)
    sdir = Vector((math.sin(rel) * math.cos(el), -math.cos(rel) * math.cos(el), math.sin(el)))
    so.rotation_euler = (-sdir).to_track_quat("-Z", "Y").to_euler()
    for o in car_root.children_recursive:
        if o.name == "accessory_surfboard":
            o.hide_render = True
    cd = bpy.data.cameras.new("icon")
    cd.lens = 85
    co = bpy.data.objects.new("cam_icon", cd)
    col.objects.link(co)
    aim(co, (7.6, -9.8, 2.4), (0.0, 0.05, 0.92))
    scene.camera = co
    r.filepath = path
    bpy.ops.render.render(write_still=True)
    r.film_transparent = False
    print("ICON", path)
    return path
