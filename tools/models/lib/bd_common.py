# Shared Blender helpers for the Bulli Drive car builds (tools/models/vehicles/*.py).
#
# Everything here is vehicle independent: argument parsing, colour helpers, a material
# registry, the bmesh mesh builder (MB) with lathe / tube / box / strip primitives, 2D
# outline helpers, object utilities (empties, joins, booleans), per-vertex AO baking,
# the glTF export and a generic per-LOD report. A vehicle script does
#
#     sys.path.insert(0, <tools/models/lib>)
#     from bd_common import *
#     set_material_factory(my_factory)      # name -> bpy material, called once per name
#
# Conventions (see tools/models/README.md): 1 Blender unit = 1 m, Blender Z-up, the glTF
# exporter maps Blender (x, y, z) to three.js (x, z, -y), cars face three +Z (Blender -Y).
import bpy, bmesh, math, os, sys, json, time, hashlib
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

pi = math.pi


# --------------------------------------------------------------------------
# command line, paths, hashes
# --------------------------------------------------------------------------
def parse_args():
    """blender -b --python x.py -- --key=value --flag  ->  {"key": "value", "flag": True}"""
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    opt = {}
    for a in argv:
        if a.startswith("--"):
            k, _, v = a[2:].partition("=")
            opt[k] = v if v else True
    return opt


def files_hash(paths, n=12):
    """short sha1 over several source files (vehicle script + shared libs) for the GLB extras"""
    h = hashlib.sha1()
    for p in paths:
        h.update(open(p, "rb").read())
    return h.hexdigest()[:n]


def _col():
    return bpy.context.scene.collection


def smoothstep(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


# --------------------------------------------------------------------------
# colours and materials
# --------------------------------------------------------------------------
def lin(h):
    """#RRGGBB (sRGB) -> linear RGB tuple (Blender colour sockets)"""
    h = h.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def srgb(h):
    """#RRGGBB -> sRGB floats 0..1 (texture pixels are written in sRGB)"""
    h = h.lstrip("#")
    return [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]


MATS = {}
_MAT_FACTORY = [None]


def set_material_factory(fn):
    """fn(name) -> bpy material; get_mat caches the result per name"""
    _MAT_FACTORY[0] = fn


def get_mat(name):
    if name in MATS:
        return MATS[name]
    if _MAT_FACTORY[0] is None:
        raise RuntimeError("set_material_factory() was not called")
    m = _MAT_FACTORY[0](name)
    MATS[name] = m
    return m


def principled(m):
    try:
        m.use_nodes = True
    except Exception:
        pass
    return m.node_tree.nodes.get("Principled BSDF")


def image_material(name, imgs, interpolation="Linear", alpha=False, emission=True, blend=False):
    """Principled material fed by images: imgs = {"base", "mr" (G = roughness, B = metallic),
    optional "emissive", "normal"}; all on the UV map "UVMap" (glTF TEXCOORD_0)."""
    m = bpy.data.materials.new(name)
    b = principled(m)
    nt = m.node_tree
    uvn = nt.nodes.new("ShaderNodeUVMap")
    uvn.uv_map = "UVMap"

    def tex(im):
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = im
        t.interpolation = interpolation
        nt.links.new(uvn.outputs["UV"], t.inputs["Vector"])
        return t
    tb = tex(imgs["base"])
    tm = tex(imgs["mr"])
    nt.links.new(tb.outputs["Color"], b.inputs["Base Color"])
    if alpha:
        nt.links.new(tb.outputs["Alpha"], b.inputs["Alpha"])
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(tm.outputs["Color"], sep.inputs["Color"])
    nt.links.new(sep.outputs["Green"], b.inputs["Roughness"])
    nt.links.new(sep.outputs["Blue"], b.inputs["Metallic"])
    if emission and "emissive" in imgs:
        te = tex(imgs["emissive"])
        nt.links.new(te.outputs["Color"], b.inputs["Emission Color"])
        b.inputs["Emission Strength"].default_value = 1.0
    if "normal" in imgs:
        tn = tex(imgs["normal"])
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(tn.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], b.inputs["Normal"])
    if blend:
        for attr, val in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
            try:
                setattr(m, attr, val)
            except Exception:
                pass
    m.use_backface_culling = True
    return m


def save_image(name, arr, path, colorspace, fmt="PNG", quality=92, alpha=False):
    """numpy float array (rows bottom-up, RGBA) -> image file + bpy image in the given colour space"""
    h, w = arr.shape[0], arr.shape[1]
    im = bpy.data.images.new(name, w, h, alpha=alpha)
    im.pixels.foreach_set(arr.ravel())
    im.filepath_raw = path
    im.file_format = fmt
    if alpha:
        im.alpha_mode = "STRAIGHT"
    bpy.context.scene.render.image_settings.quality = quality
    im.save()
    if fmt == "JPEG":
        # reload so Blender (and the exporter) use the compressed pixels
        bpy.data.images.remove(im)
        im = bpy.data.images.load(path)
    im.colorspace_settings.name = colorspace
    return im


# --------------------------------------------------------------------------
# mesh builder (bmesh, no bpy.ops)
# --------------------------------------------------------------------------
def _ck(co):
    return (round(co.x, 5), round(co.y, 5), round(co.z, 5))


class MB:
    def __init__(self):
        self.bm = bmesh.new()
        self.mats = []
        self.soft = set()
        self.face_uv = {}
        self.parts = {}
        self._mark = 0

    def mi(self, name):
        if name not in self.mats:
            self.mats.append(name)
        return self.mats.index(name)

    def tris(self):
        return sum(len(f.verts) - 2 for f in self.bm.faces)

    def part(self, name):
        t = self.tris()
        self.parts[name] = self.parts.get(name, 0) + t - self._mark
        self._mark = t

    def v(self, co):
        return self.bm.verts.new(Vector(co))

    def f(self, vs, mat):
        if len({id(x) for x in vs}) < len(vs):
            vs = [x for k, x in enumerate(vs) if x not in vs[:k]]
            if len(vs) < 3:
                return None
        try:
            fc = self.bm.faces.new(vs)
        except ValueError:
            return None
        fc.material_index = self.mi(mat)
        return fc

    def set_uv(self, fc, verts, uvs):
        if fc is not None:
            self.face_uv[fc] = {_ck(v.co): uv for v, uv in zip(verts, uvs)}

    def nfaces(self):
        return len(self.bm.faces)

    def faces_since(self, n0):
        self.bm.faces.ensure_lookup_table()
        return [self.bm.faces[k] for k in range(n0, len(self.bm.faces))]

    def recalc(self, n0, soft=True):
        fs = self.faces_since(n0)
        bmesh.ops.recalc_face_normals(self.bm, faces=fs)
        if soft:
            self.soft.update(fs)

    def grid(self, rings, mat_fn, closed=True):
        n = len(rings[0])
        m = n if closed else n - 1
        for i in range(len(rings) - 1):
            for j in range(m):
                a, b = rings[i][j], rings[i][(j + 1) % n]
                c, d = rings[i + 1][(j + 1) % n], rings[i + 1][j]
                self.f([a, b, c, d], mat_fn(i, j))

    def fan(self, ring, center_co, mat, flip=False):
        c = self.v(center_co)
        n = len(ring)
        for j in range(n):
            q = [ring[j], ring[(j + 1) % n], c]
            self.f(q[::-1] if flip else q, mat)
        return c

    def obj(self, name, smooth_angle=35.0, parent=None, mat_sharp=True):
        bm = self.bm
        # face UVs are stored per face as {rounded vertex position: uv} -> immune to the loop
        # reordering of recalc_face_normals and to remove_doubles
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
        bm.faces.ensure_lookup_table()
        if self.face_uv:
            uvl = bm.loops.layers.uv.new("UVMap")
            for fc, uvs in self.face_uv.items():
                if fc.is_valid:
                    for lp in fc.loops:
                        k = _ck(lp.vert.co)
                        if k in uvs:
                            lp[uvl].uv = uvs[k]
        for fc in bm.faces:
            fc.smooth = True
        thr = math.radians(smooth_angle)
        soft_thr = math.radians(75)
        for e in bm.edges:
            if len(e.link_faces) == 2:
                lim = soft_thr if all(f in self.soft for f in e.link_faces) else thr
                if mat_sharp and e.link_faces[0].material_index != e.link_faces[1].material_index:
                    e.smooth = False
                    continue
                try:
                    if e.calc_face_angle() > lim:
                        e.smooth = False
                except ValueError:
                    e.smooth = False
            elif len(e.link_faces) > 2:
                e.smooth = False
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        for n in self.mats:
            me.materials.append(get_mat(n))
        o = bpy.data.objects.new(name, me)
        _col().objects.link(o)
        if parent:
            o.parent = parent
        return o


def frame_from_axis(axis, up_hint=Vector((0, 0, 1))):
    z = Vector(axis).normalized()
    if abs(z.dot(up_hint)) > 0.95:
        up_hint = Vector((0, 1, 0))
    x = up_hint.cross(z).normalized()
    y = z.cross(x).normalized()
    return Matrix((x, y, z)).transposed()


def lathe(mb, profile, segs, M, origin, mats, sx=1.0, sy=1.0, mat_fn=None, uv_bands=None, uv_planar=None):
    """profile [(r, h)] revolved around local Z; points with r == 0 become fan poles.
    mats[i] = material of the band between profile[i] and profile[i+1].
    uv_bands {i: (v0, v1)}: band i gets UVs u = around (0..1), v = v0..v1 (tyre tread)."""
    n0 = mb.nfaces()
    rings = []
    for (r, h) in profile:
        if r <= 1e-6:
            rings.append(None)
            continue
        ring = []
        for j in range(segs):
            t = 2 * pi * j / segs
            ring.append(mb.v(origin + M @ Vector((r * math.cos(t) * sx, r * math.sin(t) * sy, h))))
        rings.append(ring)
    for i in range(len(profile) - 1):
        A, B = rings[i], rings[i + 1]
        mat = mats[i]
        if A is not None and B is not None:
            for j in range(segs):
                m_ = mat_fn(i, j, segs) if mat_fn else mat
                q = [A[j], A[(j + 1) % segs], B[(j + 1) % segs], B[j]]
                fc = mb.f(q, m_)
                if uv_bands and i in uv_bands:
                    v0, v1 = uv_bands[i]
                    u0, u1 = j / segs, (j + 1) / segs
                    mb.set_uv(fc, q, [(u0, v0), (u1, v0), (u1, v1), (u0, v1)])
                if uv_planar and mats[i] in uv_planar:
                    mb.set_uv(fc, q, [_puv(profile[ii][0], jj, segs, uv_planar[mats[i]])
                                      for ii, jj in ((i, j), (i, j + 1), (i + 1, j + 1), (i + 1, j))])
        elif A is None and B is not None:
            c = mb.v(origin + M @ Vector((0, 0, profile[i][1])))
            for j in range(segs):
                mb.f([c, B[(j + 1) % segs], B[j]], mat_fn(i, j, segs) if mat_fn else mat)
        elif A is not None and B is None:
            c = mb.v(origin + M @ Vector((0, 0, profile[i + 1][1])))
            for j in range(segs):
                q = [A[j], A[(j + 1) % segs], c]
                fc = mb.f(q, mat_fn(i, j, segs) if mat_fn else mat)
                if uv_planar and mats[i] in uv_planar:
                    R_ = uv_planar[mats[i]]
                    mb.set_uv(fc, q, [_puv(profile[i][0], j, segs, R_), _puv(profile[i][0], j + 1, segs, R_), (0.5, 0.5)])
    mb.recalc(n0)
    return rings


def _puv(r, j, segs, R):
    t = 2 * pi * j / segs
    return (0.5 + 0.5 * r * math.cos(t) / R, 0.5 + 0.5 * r * math.sin(t) / R)


def tube(mb, path, radius, sides, mat, cap_start=True, cap_end=True, closed=False, radii=None, up=None):
    n0 = mb.nfaces()
    path = [Vector(p) for p in path]
    n = len(path)
    tans = []
    for i in range(n):
        if closed:
            t = path[(i + 1) % n] - path[i - 1]
        else:
            t = path[min(i + 1, n - 1)] - path[max(i - 1, 0)]
        tans.append(t.normalized())
    nrm = Vector(up) if up else Vector((0, 0, 1))
    if abs(nrm.dot(tans[0])) > 0.9:
        nrm = Vector((1, 0, 0)) if abs(tans[0].x) < 0.9 else Vector((0, 1, 0))
    nrm = (nrm - tans[0] * nrm.dot(tans[0])).normalized()
    rings = []
    for i in range(n):
        if i:
            nrm = (nrm - tans[i] * nrm.dot(tans[i])).normalized()
        b = tans[i].cross(nrm)
        rr = radii[i] if radii else radius
        rings.append([mb.v(path[i] + rr * (math.cos(2 * pi * k / sides) * nrm + math.sin(2 * pi * k / sides) * b))
                      for k in range(sides)])
    if closed:
        rings.append(rings[0])
    mb.grid(rings, lambda i, j: mat, closed=True)
    if not closed:
        r0 = radii[0] if radii else radius
        r1 = radii[-1] if radii else radius
        if cap_start:
            mb.fan(rings[0], path[0] - tans[0] * r0 * 0.4, mat, flip=True)
        if cap_end:
            mb.fan(rings[-1], path[-1] + tans[-1] * r1 * 0.4, mat)
    mb.recalc(n0)


def box(mb, center, size, mat, M=None):
    n0 = mb.nfaces()
    M = M or Matrix.Identity(3)
    c = Vector(center)
    hx, hy, hz = [s / 2 for s in size]
    vs = [mb.v(c + M @ Vector((sx * hx, sy * hy, sz * hz))) for sz in (-1, 1) for sy in (-1, 1) for sx in (-1, 1)]
    for q in [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)]:
        mb.f([vs[i] for i in q], mat)
    mb.recalc(n0, soft=False)


def strip(mb, pts, nrms, profile, mat, closed=False, offset=0.0, mat_fn=None):
    """surface-hugging strip: profile [(w, h)] across the path (w in the surface, h along
    the surface normal), open profile, faces point along +normal."""
    n = len(pts)
    rings = []
    for i in range(n):
        if closed:
            t = pts[(i + 1) % n] - pts[i - 1]
        else:
            t = pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]
        t.normalize()
        nn = (nrms[i] - t * nrms[i].dot(t)).normalized()
        w = nn.cross(t).normalized()
        rings.append([mb.v(pts[i] + w * a + nn * (b + offset)) for (a, b) in profile])
    if closed:
        rings.append(rings[0])
    for i in range(len(rings) - 1):
        for j in range(len(profile) - 1):
            a, b = rings[i][j], rings[i][j + 1]
            c, d = rings[i + 1][j + 1], rings[i + 1][j]
            mb.f([a, d, c, b], mat_fn(i, j) if mat_fn else mat)
    return rings


# --------------------------------------------------------------------------
# 2D helpers (window outlines etc.)
# --------------------------------------------------------------------------
def rounded_poly(corners, radii, nc, maxseg):
    """convex polygon (list of (u,v)), per-corner fillet radius -> CCW outline."""
    P = [Vector(c) for c in corners]
    if not isinstance(radii, (list, tuple)):
        radii = [radii] * len(P)
    radii = list(radii)
    area = sum(P[i].x * P[(i + 1) % len(P)].y - P[(i + 1) % len(P)].x * P[i].y for i in range(len(P)))
    if area < 0:
        P = P[::-1]
        radii = radii[::-1]
    n = len(P)
    arcs = []
    for i in range(n):
        A, B, C = P[i - 1], P[i], P[(i + 1) % n]
        d1, d2 = (A - B).normalized(), (C - B).normalized()
        ang = math.acos(max(-1, min(1, d1.dot(d2))))
        r = radii[i] if isinstance(radii, (list, tuple)) else radii
        t = r / math.tan(ang / 2)
        t = min(t, (A - B).length * 0.49, (C - B).length * 0.49)
        r = t * math.tan(ang / 2)
        T1, T2 = B + d1 * t, B + d2 * t
        cdir = (d1 + d2).normalized()
        Cc = B + cdir * (r / math.sin(ang / 2))
        a1 = math.atan2((T1 - Cc).y, (T1 - Cc).x)
        a2 = math.atan2((T2 - Cc).y, (T2 - Cc).x)
        da = a2 - a1
        while da > pi:
            da -= 2 * pi
        while da < -pi:
            da += 2 * pi
        arcs.append([Cc + r * Vector((math.cos(a1 + da * k / nc), math.sin(a1 + da * k / nc))) for k in range(nc + 1)])
    out = []
    for i in range(n):
        out += arcs[i]
        a, b = arcs[i][-1], arcs[(i + 1) % n][0]
        m = max(1, int(math.ceil((b - a).length / maxseg)))
        for k in range(1, m):
            out.append(a.lerp(b, k / m))
    return out


def inset(pts, d):
    n = len(pts)
    out = []
    for i in range(n):
        a, b, c = pts[i - 1], pts[i], pts[(i + 1) % n]
        t = (c - a).normalized()
        nrm = Vector((-t.y, t.x))  # CCW -> left normal points inward
        out.append(b + nrm * d)
    return out


def bez(p0, p1, p2, p3, t):
    u = 1 - t
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3


def bez_d(p0, p1, p2, p3, t):
    u = 1 - t
    return 3 * u * u * (p1 - p0) + 6 * u * t * (p2 - p1) + 3 * t * t * (p3 - p2)


# --------------------------------------------------------------------------
# objects, booleans, AO, export
# --------------------------------------------------------------------------
def empty(name, loc, parent=None, **props):
    e = bpy.data.objects.new(name, None)
    e.empty_display_size = 0.2
    e.location = loc
    _col().objects.link(e)
    if parent:
        e.parent = parent
    for k, v in props.items():
        e[k] = v
    return e


def apply_all_modifiers(o):
    bpy.context.view_layer.objects.active = o
    for m in list(o.modifiers):
        with bpy.context.temp_override(object=o, active_object=o):
            bpy.ops.object.modifier_apply(modifier=m.name)


def join(objs, target):
    with bpy.context.temp_override(object=target, active_object=target, selected_objects=objs,
                                   selected_editable_objects=objs):
        bpy.ops.object.join()


def tri_count(o):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = o.evaluated_get(dg)
    me = ev.to_mesh()
    me.calc_loop_triangles()
    n = len(me.loop_triangles)
    ev.to_mesh_clear()
    return n


def boolean_cut(target, cutter):
    mod = target.modifiers.new("win", "BOOLEAN")
    mod.operation = "DIFFERENCE"
    mod.solver = "EXACT"
    mod.object = cutter
    if hasattr(mod, "material_mode"):
        mod.material_mode = "TRANSFER"
    apply_all_modifiers(target)


def delete_faces_with(o, matnames):
    me = o.data
    idx = {i for i, m in enumerate(me.materials) if m and m.name in matnames}
    bm = bmesh.new()
    bm.from_mesh(me)
    dead = [f for f in bm.faces if f.material_index in idx]
    n = len(dead)
    bmesh.ops.delete(bm, geom=dead, context="FACES")
    bm.to_mesh(me)
    bm.free()
    return n


def bake_ao(target, occluders, samples, dist=0.30, strength=0.85, interior_dist=0.6, interior_strength=0.45, skip=("glass", "blob"),
            interior_mats=()):
    """per-vertex ambient occlusion (cosine-weighted, stratified rays against all occluders) ->
    FLOAT_COLOR point attribute 'Col', exported as COLOR_0 (three.js multiplies it into the base colour).
    skip: materials that neither occlude nor receive AO (glass); interior_mats get longer rays and a
    softer strength (cabin)."""
    t = time.time()
    tmp = bmesh.new()
    for o in occluders:
        me = o.data
        b = bmesh.new()
        b.from_mesh(me)
        gi = {i for i, m in enumerate(me.materials) if m and m.name in skip}
        dead = [f for f in b.faces if f.material_index in gi]
        if dead:
            bmesh.ops.delete(b, geom=dead, context="FACES")
        b.transform(o.matrix_world)
        m2 = bpy.data.meshes.new("_occ")
        b.to_mesh(m2)
        b.free()
        tmp.from_mesh(m2)
        bpy.data.meshes.remove(m2)
    bmesh.ops.triangulate(tmp, faces=tmp.faces)
    bvh = BVHTree.FromBMesh(tmp)
    tmp.free()
    dirs = []
    for k in range(samples):
        u1 = (k + 0.5) / samples
        ph = k * 2.399963
        r = math.sqrt(u1)
        dirs.append((r * math.cos(ph), r * math.sin(ph), math.sqrt(1 - u1)))
    me = target.data
    names = [m.name for m in me.materials]
    nv = len(me.vertices)
    vskip = [True] * nv
    vdist = [dist] * nv
    vstr = [strength] * nv
    for p in me.polygons:
        n = names[p.material_index]
        for vi in p.vertices:
            if n not in skip:
                vskip[vi] = False
            if n in interior_mats:
                vdist[vi] = interior_dist
                vstr[vi] = interior_strength
    M = target.matrix_world
    Mn = M.to_3x3()
    vals = []
    for v in me.vertices:
        if vskip[v.index]:
            vals.append(1.0)
            continue
        p = M @ v.co
        nn = (Mn @ v.normal).normalized()
        tt = Vector((1, 0, 0)) if abs(nn.x) < 0.9 else Vector((0, 1, 0))
        tt = (tt - nn * tt.dot(nn)).normalized()
        bb = nn.cross(tt)
        o = p + nn * 0.004
        dmax = vdist[v.index]
        occ = 0.0
        for (dx, dy, dz) in dirs:
            w = tt * dx + bb * dy + nn * dz
            hit = bvh.ray_cast(o, w, dmax)
            # back-face hits = the ray started under a thin overlay (seal, trim, V bead) -> ignore
            if hit[0] is not None and hit[1].dot(w) < 0:
                occ += 1.0 - 0.6 * hit[3] / dmax
        vals.append(max(0.18, 1.0 - vstr[v.index] * occ / samples))
    ca = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
    flat = []
    for a in vals:
        flat += [a, a, a, 1.0]
    ca.data.foreach_set("color", flat)
    me.color_attributes.active_color = ca
    try:
        me.color_attributes.render_color_index = me.color_attributes.active_color_index
    except Exception:
        pass
    return {"verts": nv, "rays": nv * samples, "mean": round(sum(vals) / max(1, nv), 3), "s": round(time.time() - t, 2)}


def resmooth_by_material(o, angle_deg=38.0, soft_prefix="paint_"):
    """after booleans + join: smooth by angle, hard edges between different materials except
    between two soft_prefix materials (paint_primary <-> paint_secondary: colour split on one
    continuous surface)"""
    me = o.data
    names = [m.name for m in me.materials]
    paint = {i for i, n in enumerate(names) if n.startswith(soft_prefix)}
    bm = bmesh.new()
    bm.from_mesh(me)
    thr = math.radians(angle_deg)
    for f in bm.faces:
        f.smooth = True
    for e in bm.edges:
        lf = e.link_faces
        if len(lf) != 2:
            e.smooth = False
            continue
        a, b = lf[0].material_index, lf[1].material_index
        try:
            ang = e.calc_face_angle()
        except ValueError:
            e.smooth = False
            continue
        if a != b and not (a in paint and b in paint):
            e.smooth = False
        else:
            e.smooth = ang <= thr
    bm.to_mesh(me)
    bm.free()


def export_glb(root, path):
    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    for o in root.children_recursive:
        o.select_set(True)
    t = time.time()
    kw = dict(filepath=path, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
              export_extras=True, export_texcoords=True, export_normals=True, export_cameras=False,
              export_lights=False, export_materials="EXPORT", export_tangents=False)
    bpy.ops.export_scene.gltf(**kw, export_vertex_color="ACTIVE", export_all_vertex_colors=False,
                              export_active_vertex_color_when_no_material=True)
    return {"file": path, "bytes": os.path.getsize(path), "s": round(time.time() - t, 2)}


def delete_hierarchy(root):
    objs = [root] + list(root.children_recursive)
    meshes = {o.data for o in objs if o.type == "MESH"}
    for o in objs:
        bpy.data.objects.remove(o, do_unlink=True)
    for me in meshes:
        if me.users == 0:
            bpy.data.meshes.remove(me)


def aim(obj, loc, tgt):
    obj.location = loc
    obj.rotation_euler = (Vector(tgt) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()


def summarize_lod(root, rep, budget, required, accessory="accessory_surfboard", ground_blob_mat="glass"):
    """generic LOD report: triangles per mesh object, estimated draw calls (one per material in
    use per mesh), bounding size (ground blob excluded), materials, node names, budget check."""
    total = 0
    prims = 0
    acc_prims = 0
    for o in root.children_recursive:
        if o.type == "MESH":
            n = tri_count(o)
            rep["objects"][o.name] = n
            total += n
            k = len({p.material_index for p in o.data.polygons})
            prims += k
            if o.name == accessory:
                acc_prims = k
    rep["triangles_total"] = total
    rep["triangles_without_surfboard"] = total - rep["objects"].get(accessory, 0)
    rep["draw_calls_est"] = prims
    rep["draw_calls_est_without_surfboard"] = prims - acc_prims
    mins, maxs = Vector((1e9,) * 3), Vector((-1e9,) * 3)
    for o in root.children_recursive:
        if o.type == "MESH" and o.name != accessory:
            me = o.data
            gl = {i for i, m in enumerate(me.materials) if m.name == ground_blob_mat}
            for p in me.polygons:
                if p.material_index in gl and p.center.z < 0.05:
                    continue          # the ground blob does not count for the size
                for vi in p.vertices:
                    w = o.matrix_world @ me.vertices[vi].co
                    mins = Vector(map(min, mins, w))
                    maxs = Vector(map(max, maxs, w))
    rep["size_m"] = {"width_x": round(maxs.x - mins.x, 3), "length_y": round(maxs.y - mins.y, 3), "height_z": round(maxs.z - mins.z, 3)}
    rep["materials"] = sorted({m.name for o in root.children_recursive if o.type == "MESH" for m in o.data.materials})
    rep["nodes"] = sorted(o.name for o in root.children_recursive)
    rep["required_nodes_ok"] = all(n in rep["nodes"] for n in required)
    rep["budget"] = budget
    rep["budget_ok"] = total <= budget
    return rep
