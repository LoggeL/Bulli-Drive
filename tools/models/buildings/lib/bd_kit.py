# Blender library of the building kit (tools/models/buildings): atlas UV mapping, a small
# mesh accumulator with per-face tint, walls with openings cut at the texture periods,
# convex polygons clipped to the tile cells, boxes, prisms, tubes, gable/hip roofs, per-corner
# ambient occlusion and the export of one kit group (all pieces, all LODs) to a GLB.
#
# Conventions (see tools/models/buildings/README.md):
#   1 unit = 1 m, Blender Z-up; the glTF exporter maps Blender (x, y, z) to three.js (x, z, -y).
#   Buildings: origin on the ground at the middle of the street front, the front faces
#   Blender -Y (three.js +Z), the building extends to Blender +Y (three.js -Z).
#   Linear props (guardrail, pier, barriers): run along +X from x = 0 (or centred), the traffic
#   or visitor side faces Blender -Y (three.js +Z).
#   One material "kit_atlas" for everything; COLOR_0 = tint x baked ambient occlusion.
import bpy, bmesh, math, os, json, time
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(__file__))
KIT_DIR = os.path.dirname(HERE)
ATLAS = json.load(open(os.path.join(KIT_DIR, "atlas.json")))
N = float(ATLAS["size"])
UP = Vector((0, 0, 1))
EPS = 1e-6


def lin(h):
    """#RRGGBB (sRGB) -> linear RGB (vertex colours are linear in glTF)"""
    h = h.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


WHITE = (1.0, 1.0, 1.0)


def mul(t, k):
    return tuple(c * k for c in t)


# --------------------------------------------------------------------------
# atlas regions -> UV
# --------------------------------------------------------------------------
def _content(rect, pad):
    """content box of a region in Blender UV space (v up): (u0, v0, u1, v1)"""
    x, y, w, h = rect
    return ((x + pad) / N, 1.0 - (y + h - pad) / N, (x + w - pad) / N, 1.0 - (y + pad) / N)


class Mat:
    """How a surface samples the atlas.
    kind 'tile': seamless region, `period` metres per repeat (scaled by `scale` for coarse LODs)
    kind 'pal': one flat palette cell; kind 'decal': one element mapped by fractions."""

    def __init__(self, kind, region, tint=WHITE, scale=1.0, rot=False, jitter=0.0):
        self.kind, self.region, self.tint, self.scale, self.rot = kind, region, tint, scale, rot
        self.jitter = jitter      # per period cell brightness variation (weathered panels), tiles only
        if kind == "tile":
            t = ATLAS["tiles"][region]
            self.box = _content(t["rect"], t["pad"])
            p = t["period"]
            self.period = (p, p) if not isinstance(p, list) else tuple(p)
        elif kind == "decal":
            d = ATLAS["decals"][region]
            self.box = _content(d["rect"], d["pad"])
        elif kind == "pal":
            p = ATLAS["palette"]
            names = [c[0] for c in p["colors"]]
            if region not in names:
                raise KeyError("palette colour %s" % region)
            i = names.index(region)
            cols = p["rect"][2] // p["cell"]
            cx = p["rect"][0] + (i % cols) * p["cell"] + p["cell"] / 2
            cy = p["rect"][1] + (i // cols) * p["cell"] + p["cell"] / 2
            self.uv = (cx / N, 1.0 - cy / N)
        else:
            raise ValueError(kind)

    def with_tint(self, tint):
        return Mat(self.kind, self.region, tint, self.scale, self.rot, self.jitter)

    def scaled(self, k):
        return Mat(self.kind, self.region, self.tint, self.scale * k, self.rot, self.jitter)

    def rotated(self):
        return Mat(self.kind, self.region, self.tint, self.scale, not self.rot, self.jitter)

    def jittered(self, amount):
        return Mat(self.kind, self.region, self.tint, self.scale, self.rot, amount)

    def cell_tint(self, i, j):
        """tint of the period cell (i, j): +-jitter/2 from an integer hash of the cell"""
        if not self.jitter:
            return self.tint
        h = ((i * 73856093) ^ (j * 19349663) ^ 0x5bd1e995) & 0xFFFFFFFF
        h = ((h ^ (h >> 13)) * 0x5bd1e995) & 0xFFFFFFFF
        f = 1.0 + self.jitter * (((h ^ (h >> 15)) & 0xFFFF) / 65535.0 - 0.5)
        return tuple(min(1.0, c * f) for c in self.tint)

    def tile_period(self):
        pu, pv = self.period
        if self.rot:
            pu, pv = pv, pu
        return pu * self.scale, pv * self.scale

    def tile_uv(self, fs, ft):
        """fractions inside one period (0..1) -> atlas UV"""
        if self.rot:
            fs, ft = ft, 1.0 - fs
        u0, v0, u1, v1 = self.box
        return (u0 + fs * (u1 - u0), v0 + ft * (v1 - v0))

    def decal_uv(self, fs, ft):
        u0, v0, u1, v1 = self.box
        return (u0 + fs * (u1 - u0), v0 + ft * (v1 - v0))


def tile(region, tint=WHITE, scale=1.0):
    return Mat("tile", region, tint, scale)


def pal(name, tint=WHITE):
    return Mat("pal", name, tint)


def decal(name, tint=WHITE):
    return Mat("decal", name, tint)


# --------------------------------------------------------------------------
# mesh accumulator
# --------------------------------------------------------------------------
class K:
    """Faces with per-corner UVs and a per-face tint; vertices shared by rounded position."""

    def __init__(self):
        self.verts = []
        self.vindex = {}
        self.faces = []          # (vertex indices, uvs, tint, smooth)

    def vid(self, co):
        key = (round(co[0], 4), round(co[1], 4), round(co[2], 4))
        i = self.vindex.get(key)
        if i is None:
            i = len(self.verts)
            self.vindex[key] = i
            self.verts.append(Vector(co))
        return i

    def face(self, pts, uvs, tint=WHITE, smooth=False):
        idx = [self.vid(p) for p in pts]
        # drop repeated corners (degenerate slivers from clipping)
        keep = [k for k in range(len(idx)) if idx[k] != idx[k - 1]]
        if len(keep) < 3:
            return
        idx = [idx[k] for k in keep]
        uvs = [uvs[k] for k in keep]
        if len(set(idx)) < 3:
            return
        a, b, c = (self.verts[i] for i in idx[:3])
        if (b - a).cross(c - a).length < 1e-9 and len(idx) == 3:
            return
        self.faces.append((idx, [tuple(u) for u in uvs], tint, smooth))

    def tris(self):
        return sum(len(f[0]) - 2 for f in self.faces)

    def extend(self, other, M=None, offset=None):
        """copy the faces of another K, optionally transformed"""
        M = M or Matrix.Identity(3)
        o = Vector(offset) if offset is not None else Vector((0, 0, 0))
        for idx, uvs, tint, smooth in other.faces:
            self.face([o + M @ other.verts[i] for i in idx], uvs, tint, smooth)


# --------------------------------------------------------------------------
# planar polygons with atlas mapping
# --------------------------------------------------------------------------
def _clip(poly, axis, value, keep_greater):
    out = []
    n = len(poly)
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        ina = (a[axis] >= value - EPS) if keep_greater else (a[axis] <= value + EPS)
        inb = (b[axis] >= value - EPS) if keep_greater else (b[axis] <= value + EPS)
        if ina:
            out.append(a)
        if ina != inb:
            t = (value - a[axis]) / (b[axis] - a[axis])
            out.append((a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])))
    return out


def _area(poly):
    return 0.5 * sum(poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1]
                     for i in range(len(poly)))


def plane_poly(k, o, ax, ay, poly2, mat, s0=0.0, t0=0.0, smooth=False):
    """Convex polygon in the plane o + s*ax + t*ay (poly2 = [(s, t)], CCW seen from ax x ay).
    Tiles are clipped to their period cells (s + s0, t + t0 in metres of the texture), so every
    face samples inside its atlas region; decals map the polygon's (s, t) with mat.frame."""
    o, ax, ay = Vector(o), Vector(ax), Vector(ay)
    if mat.kind == "pal":
        k.face([o + ax * s + ay * t for s, t in poly2], [mat.uv] * len(poly2), mat.tint, smooth)
        return
    if mat.kind == "decal":
        fs0, ft0, fs1, ft1 = mat.frame
        uvs = [mat.decal_uv((s - fs0) / (fs1 - fs0), (t - ft0) / (ft1 - ft0)) for s, t in poly2]
        k.face([o + ax * s + ay * t for s, t in poly2], uvs, mat.tint, smooth)
        return
    pu, pv = mat.tile_period()
    tp = [(s + s0, t + t0) for s, t in poly2]
    smin, smax = min(p[0] for p in tp), max(p[0] for p in tp)
    tmin, tmax = min(p[1] for p in tp), max(p[1] for p in tp)
    for i in range(int(math.floor(smin / pu + 1e-7)), int(math.ceil(smax / pu - 1e-7))):
        for j in range(int(math.floor(tmin / pv + 1e-7)), int(math.ceil(tmax / pv - 1e-7))):
            c = tp
            c = _clip(c, 0, i * pu, True)
            if len(c) >= 3:
                c = _clip(c, 0, (i + 1) * pu, False)
            if len(c) >= 3:
                c = _clip(c, 1, j * pv, True)
            if len(c) >= 3:
                c = _clip(c, 1, (j + 1) * pv, False)
            if len(c) < 3 or abs(_area(c)) < 1e-7:
                continue
            pts = [o + ax * (s - s0) + ay * (t - t0) for s, t in c]
            uvs = [mat.tile_uv(s / pu - i, t / pv - j) for s, t in c]
            k.face(pts, uvs, mat.cell_tint(i, j), smooth)


def _clip3(poly, axis, value, keep_greater):
    """clip [(s, t, Vector)] against s or t = value, interpolating the 3D point"""
    out = []
    n = len(poly)
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        ina = (a[axis] >= value - EPS) if keep_greater else (a[axis] <= value + EPS)
        inb = (b[axis] >= value - EPS) if keep_greater else (b[axis] <= value + EPS)
        if ina:
            out.append(a)
        if ina != inb:
            t = (value - a[axis]) / (b[axis] - a[axis])
            out.append((a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2].lerp(b[2], t)))
    return out


def project_poly(k, pts, ax, ay, mat, smooth=False, s0=0.0, t0=0.0):
    """Polygon of arbitrary 3D points (convex, CCW seen from outside) mapped by projection onto
    the axes ax, ay (box / tri-planar mapping of rocks); tiles are cut at their period cells."""
    ax, ay = Vector(ax), Vector(ay)
    poly = [(p.dot(ax) + s0, p.dot(ay) + t0, Vector(p)) for p in pts]
    if mat.kind == "pal":
        k.face([q[2] for q in poly], [mat.uv] * len(poly), mat.tint, smooth)
        return
    pu, pv = mat.tile_period()
    smin, smax = min(q[0] for q in poly), max(q[0] for q in poly)
    tmin, tmax = min(q[1] for q in poly), max(q[1] for q in poly)
    for i in range(int(math.floor(smin / pu + 1e-7)), int(math.ceil(smax / pu - 1e-7))):
        for j in range(int(math.floor(tmin / pv + 1e-7)), int(math.ceil(tmax / pv - 1e-7))):
            c = poly
            for axis, value, keep in ((0, i * pu, True), (0, (i + 1) * pu, False), (1, j * pv, True), (1, (j + 1) * pv, False)):
                if len(c) >= 3:
                    c = _clip3(c, axis, value, keep)
            if len(c) < 3 or abs(_area([(q[0], q[1]) for q in c])) < 1e-8:
                continue
            k.face([q[2] for q in c], [mat.tile_uv(q[0] / pu - i, q[1] / pv - j) for q in c], mat.tint, smooth)


def rect(k, o, ax, ay, w, h, mat, s0=0.0, t0=0.0):
    """rectangle o .. o + w*ax + h*ay (normal ax x ay)"""
    if mat.kind == "decal":
        mat = with_frame(mat, (0, 0, w, h))
    plane_poly(k, o, ax, ay, [(0, 0), (w, 0), (w, h), (0, h)], mat, s0, t0)


def with_frame(mat, frame):
    m = Mat(mat.kind, mat.region, mat.tint, mat.scale, mat.rot)
    m.frame = frame
    return m


def quad3(k, a, b, c, d, mat):
    """arbitrary planar quad (a, b, c, d CCW seen from outside), tile mapped in its own frame
    (s along a->b, t perpendicular)"""
    a, b, c, d = Vector(a), Vector(b), Vector(c), Vector(d)
    ax = (b - a)
    if ax.length < EPS:
        ax = c - d
    ax.normalize()
    n = (b - a).cross(d - a)
    if n.length < EPS:
        n = (c - b).cross(d - b)
    n.normalize()
    ay = n.cross(ax).normalized()
    poly = [((p - a).dot(ax), (p - a).dot(ay)) for p in (a, b, c, d)]
    if mat.kind == "decal":
        ss = [p[0] for p in poly]
        tt = [p[1] for p in poly]
        mat = with_frame(mat, (min(ss), min(tt), max(ss), max(tt)))
    plane_poly(k, a, ax, ay, poly, mat)


def tri3(k, a, b, c, mat):
    a, b, c = Vector(a), Vector(b), Vector(c)
    ax = (b - a).normalized()
    n = (b - a).cross(c - a).normalized()
    ay = n.cross(ax).normalized()
    plane_poly(k, a, ax, ay, [((p - a).dot(ax), (p - a).dot(ay)) for p in (a, b, c)], mat)


# --------------------------------------------------------------------------
# walls with openings
# --------------------------------------------------------------------------
class Opening:
    """rectangular (optionally round-arched) hole in a wall, wall-local metres:
    u0..u1 along the wall, v0..v1 up. `fill` = Mat of the pane/door at depth `depth` behind the
    wall face; `reveal` = Mat of the jambs (None: the wall material)."""

    def __init__(self, u0, u1, v0, v1, fill=None, depth=0.15, arch=False, reveal=None, floor=True):
        self.u0, self.u1, self.v0, self.v1 = u0, u1, v0, v1
        self.fill, self.depth, self.arch, self.reveal = fill, depth, arch, reveal
        self.floor = floor      # False: no bottom jamb (a porch floor or a step fills it)

    def arc(self, n=10):
        """arch outline points from the left spring to the right spring (CCW over the top)"""
        r = (self.u1 - self.u0) / 2
        cu, cv = self.u0 + r, self.v1 - r
        return [(cu - r * math.cos(math.pi * i / n), cv + r * math.sin(math.pi * i / n)) for i in range(n + 1)]

    def outline(self, n=10):
        """CCW outline of the hole (u, v)"""
        if not self.arch:
            return [(self.u0, self.v0), (self.u1, self.v0), (self.u1, self.v1), (self.u0, self.v1)]
        return [(self.u0, self.v0), (self.u1, self.v0)] + list(reversed(self.arc(n)))


def wall(k, o, ax, w, h, mat, openings=(), s0=0.0, t0=0.0, v_base=0.0, arch_segs=10):
    """Wall face o + u*ax + v*UP for u in 0..w, v in v_base..h (v_base < 0: foundation below the
    ground). Normal = ax x UP. Openings are cut; their jambs and fills are added."""
    o, ax = Vector(o), Vector(ax).normalized()
    ay = UP.copy()
    vs = {v_base, h}
    for op in openings:
        vs.update((op.v0, op.v1))
    vs = sorted(v for v in vs if v_base - EPS <= v <= h + EPS)
    for va, vb in zip(vs[:-1], vs[1:]):
        if vb - va < 1e-5:
            continue
        vm = (va + vb) / 2
        holes = sorted((op.u0, op.u1) for op in openings if op.v0 < vm < op.v1)
        u = 0.0
        for (h0, h1) in holes + [(w, w)]:
            if h0 - u > 1e-5:
                plane_poly(k, o, ax, ay, [(u, va), (h0, va), (h0, vb), (u, vb)], mat, s0, t0)
            u = max(u, h1)
    n = ax.cross(ay)
    for op in openings:
        if op.arch:
            # spandrels between the bounding rectangle's top corners and the arc
            a = op.arc(arch_segs)
            half = len(a) // 2
            left_corner = (op.u0, op.v1)
            right_corner = (op.u1, op.v1)
            for i in range(half):
                plane_poly(k, o, ax, ay, [left_corner, a[i], a[i + 1]][::-1] if _area([left_corner, a[i], a[i + 1]]) < 0
                           else [left_corner, a[i], a[i + 1]], mat, s0, t0)
            for i in range(half, len(a) - 1):
                tri = [right_corner, a[i], a[i + 1]]
                plane_poly(k, o, ax, ay, tri[::-1] if _area(tri) < 0 else tri, mat, s0, t0)
        _opening_insides(k, o, ax, ay, n, op, mat, s0, t0, arch_segs)


def _opening_insides(k, o, ax, ay, n, op, wall_mat, s0, t0, arch_segs):
    d = op.depth
    rev = op.reveal or wall_mat
    back = -n * d
    outline = op.outline(arch_segs)
    if d > 1e-4:
        m = len(outline)
        for i in range(m):
            (ua, va), (ub, vb) = outline[i], outline[(i + 1) % m]
            if not op.floor and i == 0:
                continue
            pa = o + ax * ua + ay * va
            pb = o + ax * ub + ay * vb
            # jamb faces look into the opening: quad pa -> pa+back -> pb+back -> pb
            quad3(k, pa, pb, pb + back, pa + back, rev)
    if op.fill is not None:
        f = op.fill
        if f.kind == "decal":
            f = with_frame(f, (op.u0, op.v0, op.u1, op.v1))
        plane_poly(k, o + back, ax, ay, outline, f, s0, t0)


def band(k, o, ax, length, z0, z1, proud, mat, gaps=(), s0=0.0):
    """base band / plinth standing `proud` in front of a wall (o, ax as in wall()), from z0 to z1,
    open at the wall-local u ranges in `gaps`; ends extended by `proud` to close the corners"""
    o, ax = Vector(o), Vector(ax).normalized()
    n = ax.cross(UP)
    spans = []
    u = -proud
    for a, b in sorted(gaps):
        spans.append((u, a))
        u = b
    spans.append((u, length + proud))
    for a, b in spans:
        if b - a < 0.05:
            continue
        p0 = o + ax * a + n * proud
        wall(k, p0 + UP * z0, ax, b - a, z1 - z0, mat, s0=s0 + a)
        top_a, top_b = p0 + UP * z1, p0 + ax * (b - a) + UP * z1
        quad3(k, top_a, top_b, top_b - n * proud, top_a - n * proud, mat)
        # end faces at the gaps
        for u_, sgn in ((a, -1), (b, 1)):
            if any(abs(u_ - g) < 1e-6 for gg in gaps for g in gg):
                e = o + ax * u_
                f0, f1 = e + UP * z0, e + UP * z1
                if sgn < 0:
                    quad3(k, f0, f0 + n * proud, f1 + n * proud, f1, mat)
                else:
                    quad3(k, f0 + n * proud, f0, f1, f1 + n * proud, mat)


# --------------------------------------------------------------------------
# solids
# --------------------------------------------------------------------------
def box(k, lo, hi, mat, faces="xXyYzZ", mats=None):
    """axis aligned box lo..hi; faces: subset of x (-X), X (+X), y, Y, z (bottom), Z (top);
    mats: optional {face letter: Mat}. Tiles continue across faces (world metres)."""
    x0, y0, z0 = lo
    x1, y1, z1 = hi
    mats = mats or {}
    X, Y, Z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
    spec = {
        "y": ((x0, y0, z0), X, Z, x1 - x0, z1 - z0, x0, z0),
        "Y": ((x1, y1, z0), -X, Z, x1 - x0, z1 - z0, -x1, z0),
        "x": ((x0, y1, z0), -Y, Z, y1 - y0, z1 - z0, -y1, z0),
        "X": ((x1, y0, z0), Y, Z, y1 - y0, z1 - z0, y0, z0),
        "Z": ((x0, y0, z1), X, Y, x1 - x0, y1 - y0, x0, y0),
        "z": ((x0, y1, z0), X, -Y, x1 - x0, y1 - y0, x0, -y1),
    }
    for f in faces:
        o, a, b, w, h, s0, t0 = spec[f]
        if w < EPS or h < EPS:
            continue
        m = mats.get(f, mat)
        rect(k, o, a, b, w, h, m, s0 if m.kind == "tile" else 0.0, t0 if m.kind == "tile" else 0.0)


def obox(k, center, size, M, mat, faces="xXyYzZ"):
    """oriented box: size (sx, sy, sz) along the columns of the rotation M"""
    tmp = K()
    sx, sy, sz = size
    box(tmp, (-sx / 2, -sy / 2, -sz / 2), (sx / 2, sy / 2, sz / 2), mat, faces)
    k.extend(tmp, M, center)


def beam(k, a, b, w, h, mat, up=None, faces="xXyYzZ"):
    """box of cross-section w x h from point a to point b (the 'x' axis runs along a->b)"""
    a, b = Vector(a), Vector(b)
    d = b - a
    L = d.length
    x = d.normalized()
    upv = Vector(up) if up else (UP if abs(x.dot(UP)) < 0.95 else Vector((0, 1, 0)))
    y = upv.cross(x).normalized()
    z = x.cross(y).normalized()
    M = Matrix((x, y, z)).transposed()
    obox(k, (a + b) / 2, (L, w, h), M, mat, faces)


def prism(k, path, profile, mat, closed_path=False, cap=True, smooth=False, up=None, s_along=True):
    """Extrudes a 2D profile [(w, h)] (w = sideways (left of travel), h = up) along a 3D path.
    Faces point outward for a CCW profile. Tiles run along the path (s) and around the
    profile (t). Caps are fans (convex profiles only)."""
    path = [Vector(p) for p in path]
    n = len(path)
    upv = Vector(up) if up else UP
    frames = []
    for i in range(n):
        if closed_path:
            t = (path[(i + 1) % n] - path[i - 1]).normalized()
        else:
            t = (path[min(i + 1, n - 1)] - path[max(i - 1, 0)]).normalized()
        side = upv.cross(t).normalized() if abs(t.dot(upv)) < 0.99 else Vector((1, 0, 0))
        u = t.cross(side).normalized()
        # mitre: scale sideways offsets at corners
        frames.append((side, u))
    rings = [[path[i] + frames[i][0] * w_ + frames[i][1] * h_ for (w_, h_) in profile] for i in range(n)]
    seg = list(range(n - 1)) + ([n - 1] if closed_path else [])
    m = len(profile)
    for i in seg:
        i2 = (i + 1) % n
        for j in range(m - 1):
            a, b = rings[i][j], rings[i][j + 1]
            c, d = rings[i2][j + 1], rings[i2][j]
            if mat.kind == "pal":
                k.face([a, b, c, d], [mat.uv] * 4, mat.tint, smooth)
            else:
                quad3(k, a, b, c, d, mat)
    if cap and not closed_path:
        # fans from profile point 0: profiles must be star shaped around their first point
        for ring, rev in ((rings[0], True), (rings[-1], False)):
            pts = [ring[0]] + ring[1:][::-1] if rev else ring
            # convex fan
            if mat.kind == "pal":
                k.face(pts, [mat.uv] * len(pts), mat.tint)
            else:
                c0 = pts[0]
                for q in range(1, len(pts) - 1):
                    tri3(k, c0, pts[q], pts[q + 1], mat)
    return rings


def cylinder(k, base, top, r, segs, mat, cap_top=True, cap_bottom=False, r_top=None, smooth=True):
    """round column from base to top (palette material: smooth; tiles: faceted, mapped around)"""
    base, top = Vector(base), Vector(top)
    axis = (top - base).normalized()
    hint = Vector((1, 0, 0)) if abs(axis.x) < 0.9 else Vector((0, 1, 0))
    x = hint.cross(axis).normalized()
    y = axis.cross(x).normalized()
    rt = r if r_top is None else r_top
    ring0 = [base + (x * math.cos(2 * math.pi * s / segs) + y * math.sin(2 * math.pi * s / segs)) * r for s in range(segs)]
    ring1 = [top + (x * math.cos(2 * math.pi * s / segs) + y * math.sin(2 * math.pi * s / segs)) * rt for s in range(segs)]
    circ = 2 * math.pi * r
    for s in range(segs):
        a, b = ring0[s], ring0[(s + 1) % segs]
        c, d = ring1[(s + 1) % segs], ring1[s]
        if mat.kind == "pal":
            k.face([a, b, c, d], [mat.uv] * 4, mat.tint, smooth)
        else:
            # map around (s) and along (t) with the tile period
            pu, pv = mat.tile_period()
            L = (top - base).length
            s0 = circ * s / segs
            s1 = circ * (s + 1) / segs
            _tile_strip(k, [a, b, c, d], (s0, 0), (s1, 0), (s1, L), (s0, L), mat, smooth)
    if cap_top:
        k.face(ring1, [_cap_uv(mat)] * segs, mat.tint)
    if cap_bottom:
        k.face(ring0[::-1], [_cap_uv(mat)] * segs, mat.tint)


def _cap_uv(mat):
    if mat.kind == "pal":
        return mat.uv
    return mat.tile_uv(0.5, 0.5) if mat.kind == "tile" else mat.decal_uv(0.5, 0.5)


def _tile_strip(k, pts, st0, st1, st2, st3, mat, smooth):
    """quad with explicit (s, t) metres per corner, split at the tile periods along t only when
    the s span stays inside one period (thin facets of round things)"""
    pu, pv = mat.tile_period()
    s_lo = min(st0[0], st3[0])
    i = math.floor(s_lo / pu + 1e-7)
    fs = [(st[0] - i * pu) / pu for st in (st0, st1, st2, st3)]
    if max(fs) > 1.0 + 1e-6:
        fs = [min(1.0, f) for f in fs]
    t_lo, t_hi = st0[1], st3[1]
    a, b, c, d = pts
    j0 = math.floor(t_lo / pv + 1e-7)
    j1 = math.ceil(t_hi / pv - 1e-7)
    for j in range(j0, j1):
        ta = max(t_lo, j * pv)
        tb = min(t_hi, (j + 1) * pv)
        fa = (ta - t_lo) / (t_hi - t_lo)
        fb = (tb - t_lo) / (t_hi - t_lo)
        p0 = a.lerp(d, fa)
        p1 = b.lerp(c, fa)
        p2 = b.lerp(c, fb)
        p3 = a.lerp(d, fb)
        k.face([p0, p1, p2, p3], [mat.tile_uv(fs[0], ta / pv - j), mat.tile_uv(fs[1], ta / pv - j),
                                  mat.tile_uv(fs[2], tb / pv - j), mat.tile_uv(fs[3], tb / pv - j)], mat.tint, smooth)


# --------------------------------------------------------------------------
# roofs
# --------------------------------------------------------------------------
def gable_roof(k, x0, x1, y0, y1, z_eave, pitch_deg, overhang, gable_overhang, mat, thickness=0.18,
               edge=None, ridge_axis="x", ridge_cap=None):
    """Gable roof over the rectangle x0..x1, y0..y1 (walls), ridge along x (default) or y.
    Returns the ridge height. Tiles run up the slope (t) and along the eave (s); the eave edge and
    the rakes get a fascia of `edge` (Mat) of `thickness`."""
    edge = edge or mat
    if ridge_axis == "y":
        # build with ridge along x in a rotated frame, then rotate 90 deg about Z around the centre
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        tmp = K()
        h = gable_roof(tmp, cx - (y1 - y0) / 2, cx + (y1 - y0) / 2, cy - (x1 - x0) / 2, cy + (x1 - x0) / 2, z_eave,
                       pitch_deg, overhang, gable_overhang, mat, thickness, edge, "x", ridge_cap)
        R = Matrix.Rotation(math.pi / 2, 3, "Z")
        c = Vector((cx, cy, 0))
        for idx, uvs, tint, smooth in tmp.faces:
            k.face([c + R @ (tmp.verts[i] - c) for i in idx], uvs, tint, smooth)
        return h
    half = (y1 - y0) / 2
    tan = math.tan(math.radians(pitch_deg))
    ym = (y0 + y1) / 2
    zr = z_eave + half * tan
    xa, xb = x0 - gable_overhang, x1 + gable_overhang
    ya, yb = y0 - overhang, y1 + overhang
    za = z_eave - overhang * tan
    # slopes (top surfaces)
    quad3(k, (xa, ya, za), (xb, ya, za), (xb, ym, zr), (xa, ym, zr), mat)
    quad3(k, (xb, yb, za), (xa, yb, za), (xa, ym, zr), (xb, ym, zr), mat)
    # undersides (soffit) with the edge material
    d = Vector((0, 0, -thickness))
    quad3(k, Vector((xa, ya, za)) + d, Vector((xa, ym, zr)) + d, Vector((xb, ym, zr)) + d, Vector((xb, ya, za)) + d, edge)
    quad3(k, Vector((xb, yb, za)) + d, Vector((xb, ym, zr)) + d, Vector((xa, ym, zr)) + d, Vector((xa, yb, za)) + d, edge)
    # eave fascias
    quad3(k, Vector((xa, ya, za)) + d, Vector((xb, ya, za)) + d, (xb, ya, za), (xa, ya, za), edge)
    quad3(k, Vector((xb, yb, za)) + d, Vector((xa, yb, za)) + d, (xa, yb, za), (xb, yb, za), edge)
    # rake fascias (gable ends)
    for x, sgn in ((xa, -1), (xb, 1)):
        pts = [Vector((x, ya, za)), Vector((x, ym, zr)), Vector((x, yb, za))]
        for p, q in ((pts[0], pts[1]), (pts[1], pts[2])):
            if sgn < 0:
                quad3(k, q + d, p + d, p, q, edge)
            else:
                quad3(k, p + d, q + d, q, p, edge)
    if ridge_cap is not None:
        r = 0.13
        cylinder(k, (xa, ym, zr - 0.02), (xb, ym, zr - 0.02), r, 8, ridge_cap, cap_top=True, cap_bottom=True, smooth=True)
    return zr


def gable_end(k, x, y0, y1, z_eave, pitch_deg, mat, facing, s0=0.0, t0=None):
    """triangular gable wall at x (facing -1 = -X, +1 = +X) above z_eave"""
    half = (y1 - y0) / 2
    zr = z_eave + half * math.tan(math.radians(pitch_deg))
    if facing > 0:
        o, ax = Vector((x, y0, 0)), Vector((0, 1, 0))
        poly = [(0, z_eave), (y1 - y0, z_eave), (half, zr)]
    else:
        o, ax = Vector((x, y1, 0)), Vector((0, -1, 0))
        poly = [(0, z_eave), (y1 - y0, z_eave), (half, zr)]
    plane_poly(k, o, ax, UP, poly, mat, s0, 0.0 if t0 is None else t0)
    return zr


def hip_roof(k, x0, x1, y0, y1, z_eave, pitch_deg, overhang, mat, edge, thickness=0.16, ridge_cap=None):
    """Hip roof: four slopes, ridge along the longer side."""
    xa, xb, ya, yb = x0 - overhang, x1 + overhang, y0 - overhang, y1 + overhang
    tan = math.tan(math.radians(pitch_deg))
    w, d = xb - xa, yb - ya
    za = z_eave - overhang * tan
    if w >= d:
        h = d / 2 * tan
        r0 = Vector((xa + d / 2, (ya + yb) / 2, za + h))
        r1 = Vector((xb - d / 2, (ya + yb) / 2, za + h))
        quad3(k, (xa, ya, za), (xb, ya, za), r1, r0, mat)
        quad3(k, (xb, yb, za), (xa, yb, za), r0, r1, mat)
        tri3(k, (xb, ya, za), (xb, yb, za), r1, mat)
        tri3(k, (xa, yb, za), (xa, ya, za), r0, mat)
    else:
        h = w / 2 * tan
        r0 = Vector(((xa + xb) / 2, ya + w / 2, za + h))
        r1 = Vector(((xa + xb) / 2, yb - w / 2, za + h))
        quad3(k, (xb, ya, za), (xb, yb, za), r1, r0, mat)
        quad3(k, (xa, yb, za), (xa, ya, za), r0, r1, mat)
        tri3(k, (xa, ya, za), (xb, ya, za), r0, mat)
        tri3(k, (xb, yb, za), (xa, yb, za), r1, mat)
    d_ = Vector((0, 0, -thickness))
    corners = [Vector((xa, ya, za)), Vector((xb, ya, za)), Vector((xb, yb, za)), Vector((xa, yb, za))]
    for i in range(4):
        a, b = corners[i], corners[(i + 1) % 4]
        quad3(k, a + d_, b + d_, b, a, edge)
    k_ = corners
    quad3(k, k_[0] + d_, k_[3] + d_, k_[2] + d_, k_[1] + d_, edge)
    if ridge_cap is not None and (r1 - r0).length > 0.1:
        cylinder(k, r0 - Vector((0, 0, 0.02)), r1 - Vector((0, 0, 0.02)), 0.12, 8, ridge_cap, cap_top=True, cap_bottom=True)
    return za + h


# --------------------------------------------------------------------------
# ambient occlusion (per face corner), mesh object, export
# --------------------------------------------------------------------------
def to_object(name, k, material, parent=None):
    me = bpy.data.meshes.new(name)
    faces = [f[0] for f in k.faces]
    me.from_pydata([tuple(v) for v in k.verts], [], faces)
    uvl = me.uv_layers.new(name="UVMap")
    col = me.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
    uvs = []
    cols = []
    smooth = []
    for idx, fuv, tint, sm in k.faces:
        for uv in fuv:
            uvs += uv
            cols += (tint[0], tint[1], tint[2], 1.0)
        smooth.append(sm)
    uvl.data.foreach_set("uv", uvs)
    col.data.foreach_set("color", cols)
    me.polygons.foreach_set("use_smooth", smooth)
    me.color_attributes.active_color = col
    try:
        me.color_attributes.render_color_index = me.color_attributes.active_color_index
    except Exception:
        pass
    me.materials.append(material)
    me.update()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    if parent is not None:
        o.parent = parent
    return o


def grime(obj, z0=0.0, z1=2.6, low=0.86):
    """darkens the colour attribute towards the ground (splash dirt): factor low at z0 .. 1 at z1"""
    me = obj.data
    col = me.color_attributes["Col"]
    vals = [0.0] * (len(me.loops) * 4)
    col.data.foreach_get("color", vals)
    for lp in me.loops:
        z = me.vertices[lp.vertex_index].co.z
        t = min(1.0, max(0.0, (z - z0) / (z1 - z0)))
        f = low + (1.0 - low) * t * t * (3 - 2 * t)
        for c in range(3):
            vals[lp.index * 4 + c] *= f
    col.data.foreach_set("color", vals)


def bake_ao(obj, samples=20, dist=2.0, strength=0.55, ground=True, floor=0.35, extra_occluders=()):
    """Multiplies per-corner ambient occlusion (cosine weighted rays against the object itself,
    optional other objects and the ground plane z = 0) into the colour attribute 'Col'."""
    t0 = time.time()
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    for o in extra_occluders:
        tmp = o.data.copy()
        tmp.transform(o.matrix_world)
        bm.from_mesh(tmp)
        bpy.data.meshes.remove(tmp)
    if ground:
        s = 200.0
        vs = [bm.verts.new(p) for p in ((-s, -s, 0), (s, -s, 0), (s, s, 0), (-s, s, 0))]
        bm.faces.new(vs)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bvh = BVHTree.FromBMesh(bm)
    bm.free()
    dirs = []
    for i in range(samples):
        u = (i + 0.5) / samples
        ph = i * 2.399963
        r = math.sqrt(u)
        dirs.append((r * math.cos(ph), r * math.sin(ph), math.sqrt(1 - u)))
    col = me.color_attributes["Col"]
    cache = {}
    vals = [0.0] * (len(me.loops) * 4)
    col.data.foreach_get("color", vals)
    verts = me.vertices
    for p in me.polygons:
        nrm = p.normal
        nk = (round(nrm.x, 2), round(nrm.y, 2), round(nrm.z, 2))
        for li in p.loop_indices:
            vi = me.loops[li].vertex_index
            key = (vi, nk)
            a = cache.get(key)
            if a is None:
                co = verts[vi].co
                # one value per (vertex, normal): coplanar faces that share a vertex (the texture
                # period cuts) get the same AO, so the cuts never show as a grid
                org = co + nrm * 0.02
                tt = Vector((1, 0, 0)) if abs(nrm.x) < 0.9 else Vector((0, 1, 0))
                tt = (tt - nrm * tt.dot(nrm)).normalized()
                bb = nrm.cross(tt)
                occ = 0.0
                for dx, dy, dz in dirs:
                    w = tt * dx + bb * dy + nrm * dz
                    hit = bvh.ray_cast(org, w, dist)
                    if hit[0] is not None and hit[1].dot(w) < 0:
                        occ += 1.0 - 0.7 * hit[3] / dist
                a = max(floor, 1.0 - strength * occ / samples)
                cache[key] = a
            for c in range(3):
                vals[li * 4 + c] *= a
    col.data.foreach_set("color", vals)
    return {"corners": len(me.loops), "rays": len(cache) * samples, "s": round(time.time() - t0, 2)}


def atlas_material(atlas_dir, name="kit_atlas"):
    """Blender material of the atlas (renders; the export writes a placeholder material that
    build-kit.mjs turns into the KTX2 atlas material). The colour attribute 'Col' multiplies the
    base colour like three.js does with COLOR_0."""
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    nt = m.node_tree
    b = nt.nodes.get("Principled BSDF")

    def img(fn, cs):
        p = os.path.join(atlas_dir, fn)
        if not os.path.exists(p):
            return None
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = bpy.data.images.load(p, check_existing=True)
        t.image.colorspace_settings.name = cs
        t.interpolation = "Cubic"
        return t
    m.use_backface_culling = True          # like three.js FrontSide: flipped faces show as holes
    ta = img("kit_atlas_albedo.png", "sRGB")
    if ta is None:
        b.inputs["Base Color"].default_value = (0.7, 0.7, 0.7, 1)
        return m
    ca = nt.nodes.new("ShaderNodeVertexColor")
    ca.layer_name = "Col"
    mix = nt.nodes.new("ShaderNodeMixRGB")
    mix.blend_type = "MULTIPLY"
    mix.inputs["Fac"].default_value = 1.0
    nt.links.new(ta.outputs["Color"], mix.inputs["Color1"])
    nt.links.new(ca.outputs["Color"], mix.inputs["Color2"])
    nt.links.new(mix.outputs["Color"], b.inputs["Base Color"])
    tm = img("kit_atlas_arm.png", "Non-Color")
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(tm.outputs["Color"], sep.inputs["Color"])
    nt.links.new(sep.outputs["Green"], b.inputs["Roughness"])
    nt.links.new(sep.outputs["Blue"], b.inputs["Metallic"])
    tn = img("kit_atlas_normal.png", "Non-Color")
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nt.links.new(tn.outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], b.inputs["Normal"])
    te = img("kit_atlas_emissive.png", "sRGB")
    nt.links.new(te.outputs["Color"], b.inputs["Emission Color"])
    b.inputs["Emission Strength"].default_value = 1.0
    return m


def placeholder_material(name="kit_atlas"):
    m = bpy.data.materials.get(name + "_export") or bpy.data.materials.new(name + "_export")
    return m


def export_group(root, path):
    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    for o in root.children_recursive:
        o.select_set(True)
    kw = dict(filepath=path, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
              export_extras=True, export_texcoords=True, export_normals=True, export_cameras=False,
              export_lights=False, export_materials="EXPORT", export_tangents=False,
              export_vertex_color="ACTIVE", export_all_vertex_colors=False,
              export_active_vertex_color_when_no_material=True)
    bpy.ops.export_scene.gltf(**kw)
    return os.path.getsize(path)


# --------------------------------------------------------------------------
# small helpers for the piece scripts
# --------------------------------------------------------------------------
class Rng:
    """deterministic choices from an integer seed (xorshift32), independent of Python's random"""

    def __init__(self, seed):
        self.s = (int(seed) * 2654435761 + 0x9E3779B9) & 0xFFFFFFFF or 1

    def next(self):
        s = self.s
        s ^= (s << 13) & 0xFFFFFFFF
        s ^= s >> 17
        s ^= (s << 5) & 0xFFFFFFFF
        self.s = s & 0xFFFFFFFF
        return self.s / 4294967296.0

    def pick(self, seq):
        return seq[int(self.next() * len(seq)) % len(seq)]

    def uniform(self, a, b):
        return a + (b - a) * self.next()

    def chance(self, p):
        return self.next() < p
