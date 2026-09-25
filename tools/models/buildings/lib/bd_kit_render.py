# Eevee look-dev renders of the building kit (review only, not shipped).
#
# Same light as the car look-dev (tools/models/lib/bd_lookdev.py): the Victoria Sunset HDRI with
# its sun clamped out (tools/models/lib/make_env.py) plus a sun lamp, here higher (28 deg) and
# warmer so facades read like the game's afternoon. Grounds are the game's Poly Haven textures
# (asphalt, sidewalk, sand, grass) from tools/textures/.cache.
import bpy, math, os, json, time
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
KIT_DIR = os.path.dirname(HERE)
MODELS = os.path.dirname(KIT_DIR)
TOOLS = os.path.dirname(MODELS)
ENV = os.path.join(MODELS, ".cache", "env", "env_info.json")
PH = os.path.join(TOOLS, "textures", ".cache", "polyhaven")


def _principled(m):
    try:
        m.use_nodes = True
    except Exception:
        pass
    return m.node_tree.nodes.get("Principled BSDF")


def setup(resolution=(1600, 900), samples=64):
    scene = bpy.context.scene
    r = scene.render
    r.engine = "BLENDER_EEVEE"
    r.resolution_x, r.resolution_y = resolution
    r.film_transparent = False
    ee = scene.eevee
    for attr, val in (("taa_render_samples", samples), ("use_raytracing", True), ("use_shadows", True),
                      ("shadow_ray_count", 2), ("shadow_step_count", 8), ("use_fast_gi", True),
                      ("fast_gi_method", "GLOBAL_ILLUMINATION"), ("ray_tracing_method", "SCREEN")):
        if hasattr(ee, attr):
            try:
                setattr(ee, attr, val)
            except Exception:
                pass
    vs = scene.view_settings
    avail = [i.identifier for i in vs.bl_rna.properties["view_transform"].enum_items]
    if "AgX" in avail:
        vs.view_transform = "AgX"
    try:
        vs.look = "AgX - Base Contrast"
    except Exception:
        pass
    vs.exposure = -0.2
    info = json.load(open(ENV))["victoria_sunset_2k"] if os.path.exists(ENV) else None
    w = bpy.data.worlds.new("sky")
    scene.world = w
    try:
        w.use_nodes = True
    except Exception:
        pass
    nt = w.node_tree
    nt.nodes.clear()
    bg = nt.nodes.new("ShaderNodeBackground")
    out = nt.nodes.new("ShaderNodeOutputWorld")
    nt.links.new(bg.outputs[0], out.inputs["Surface"])
    mp = None
    if info:
        tc = nt.nodes.new("ShaderNodeTexCoord")
        mp = nt.nodes.new("ShaderNodeMapping")
        nt.links.new(tc.outputs["Generated"], mp.inputs["Vector"])
        env = nt.nodes.new("ShaderNodeTexEnvironment")
        env.image = bpy.data.images.load(info["nosun"])
        nt.links.new(mp.outputs["Vector"], env.inputs["Vector"])
        nt.links.new(env.outputs["Color"], bg.inputs["Color"])
        bg.inputs["Strength"].default_value = 1.2
    else:
        bg.inputs["Color"].default_value = (0.55, 0.65, 0.8, 1)
    sd = bpy.data.lights.new("sun", "SUN")
    sd.color = (1.0, 0.9, 0.78)
    sd.energy = 4.2
    sd.angle = math.radians(1.0)
    so = bpy.data.objects.new("sun", sd)
    scene.collection.objects.link(so)
    return so, mp, info


def aim_sun(so, mp, info, azimuth_deg, elevation_deg=28.0):
    """azimuth: direction the light comes FROM, 0 = from -Y (street side), 90 = from +X"""
    az = math.radians(azimuth_deg)
    el = math.radians(elevation_deg)
    d = Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el)))
    so.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
    if mp is not None and info:
        az0 = math.atan2(info["sun_dir_blender"][1], info["sun_dir_blender"][0])
        mp.inputs["Rotation"].default_value = (0, 0, az0 - math.atan2(d.y, d.x))


_GROUND_MATS = {}


def ground_mat(role, tile_m, tint=(1, 1, 1)):
    key = (role, tile_m, tint)
    if key in _GROUND_MATS:
        return _GROUND_MATS[key]
    m = bpy.data.materials.new("ground_" + role)
    b = _principled(m)
    nt = m.node_tree
    tc = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (1 / tile_m, 1 / tile_m, 1)
    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])

    def img(map_, cs):
        p = os.path.join(PH, role, "%s_%s_1k.jpg" % (role, map_))
        if not os.path.exists(p):
            return None
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = bpy.data.images.load(p, check_existing=True)
        t.image.colorspace_settings.name = cs
        t.projection = "BOX"
        t.projection_blend = 0.1
        nt.links.new(mp.outputs["Vector"], t.inputs["Vector"])
        return t
    ta = img("albedo", "sRGB")
    if ta:
        mix = nt.nodes.new("ShaderNodeMixRGB")
        mix.blend_type = "MULTIPLY"
        mix.inputs["Fac"].default_value = 1.0
        mix.inputs["Color2"].default_value = (*tint, 1)
        nt.links.new(ta.outputs["Color"], mix.inputs["Color1"])
        nt.links.new(mix.outputs["Color"], b.inputs["Base Color"])
    tr = img("arm", "Non-Color")
    if tr:
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(tr.outputs["Color"], sep.inputs["Color"])
        nt.links.new(sep.outputs["Green"], b.inputs["Roughness"])
    tn = img("normal", "Non-Color")
    if tn:
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(tn.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], b.inputs["Normal"])
    _GROUND_MATS[key] = m
    return m


def slab(name, x0, x1, y0, y1, z, mat):
    me = bpy.data.meshes.new(name)
    me.from_pydata([(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)], [], [(0, 1, 2, 3)])
    me.materials.append(mat)
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def curb(name, x0, x1, y, mat, h=0.15):
    me = bpy.data.meshes.new(name)
    me.from_pydata([(x0, y, 0), (x1, y, 0), (x1, y, h), (x0, y, h)], [], [(0, 1, 2, 3)])
    me.materials.append(mat)
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def street_ground(x0, x1, sidewalk_y0=-3.2, road_y0=-14.0, back=60.0, back_role="sidewalk", back_tint=(1, 1, 1)):
    """asphalt road, curb, sidewalk up to the building fronts (y = 0) and ground behind"""
    asphalt = ground_mat("asphalt", 3.0)
    walk = ground_mat("sidewalk", 2.5)
    slab("road", x0, x1, road_y0 - 40, sidewalk_y0, 0.0, asphalt)
    slab("walk", x0, x1, sidewalk_y0, 0.0, 0.15, walk)
    curb("curb", x0, x1, sidewalk_y0, walk)
    slab("behind", x0, x1, 0.0, back, 0.15 if back_role == "sidewalk" else 0.02, ground_mat(back_role, 2.5, back_tint))


def place(src, name, loc, rot_z=0.0):
    """linked duplicate of an exported LOD object for the render scene"""
    o = src.copy()
    o.name = name
    o.parent = None
    o.location = loc
    o.rotation_euler = (0, 0, rot_z)
    o.hide_render = False
    bpy.context.scene.collection.objects.link(o)
    return o


def shoot(path, cam_loc, cam_tgt, lens=35, res=None):
    scene = bpy.context.scene
    if res:
        scene.render.resolution_x, scene.render.resolution_y = res
    cd = bpy.data.cameras.new("cam")
    cd.lens = lens
    cd.clip_end = 2000
    co = bpy.data.objects.new("cam", cd)
    scene.collection.objects.link(co)
    co.location = cam_loc
    co.rotation_euler = (Vector(cam_tgt) - Vector(cam_loc)).to_track_quat("-Z", "Y").to_euler()
    scene.camera = co
    scene.render.filepath = path
    t = time.time()
    bpy.ops.render.render(write_still=True)
    print("RENDER", path, round(time.time() - t, 1), "s")
    return path
