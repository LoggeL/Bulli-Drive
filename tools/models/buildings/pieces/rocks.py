# Cliff and rock building blocks: boulders in three sizes, a flat slab and a layered cliff block
# (sandstone of the G1 cliffs). Shapes come from a subdivided sphere or box displaced by
# mathutils fractal noise with horizontal strata (ledges); the bottom is flattened and sinks
# `foundation` metres into the ground. Tri-planar mapping into the rock tile of the atlas, cut at
# the texture period. LODs share the displacement field, so their silhouettes agree.
#
# Params (kit.json): size [x, y, z] (m), shape ("boulder" | "slab" | "cliff"), strata (m), seed.
import math
import bmesh
from bd_kit import K, tile, lin, mul, Rng, project_poly
from mathutils import Vector, noise

AXES = {0: (Vector((0, 1, 0)), Vector((0, 0, 1))), 1: (Vector((1, 0, 0)), Vector((0, 0, 1))), 2: (Vector((1, 0, 0)), Vector((0, 1, 0)))}


def base_mesh(shape, lod, big=True):
    bm = bmesh.new()
    if shape == "boulder" or shape == "slab":
        bmesh.ops.create_icosphere(bm, subdivisions=([4, 3, 2] if big else [3, 2, 1])[lod], radius=1.0)
    else:
        bmesh.ops.create_cube(bm, size=2.0)
        cuts = [9, 4, 2][lod]
        bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=cuts, use_grid_fill=True)
        # round the box a little so the displacement has something to hold on to
        for v in bm.verts:
            c = v.co
            n = Vector((c.x, c.y, c.z)).normalized()
            v.co = c.lerp(n * 1.2, 0.25)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    return bm


def displace(p, size, shape, strata, seed):
    """unit shape point -> displaced point in metres"""
    off = Vector((seed * 7.31, seed * 3.17, seed * 5.53))
    sx, sy, sz = size
    q = Vector((p.x * sx / 2, p.y * sy / 2, p.z * sz / 2))
    n = p.normalized() if p.length > 1e-6 else Vector((0, 0, 1))
    f = 0.45 / max(1.0, max(size) / 3.0)
    amp = min(size) * (0.16 if shape != "cliff" else 0.22)
    d = noise.fractal(q * f + off, 0.6, 2.0, 4) * amp
    # strata: ledges that step the surface in and out with height
    if strata > 0:
        z = q.z + sz / 2
        layer = z / strata
        frac = layer - math.floor(layer)
        d += (0.5 - frac) * min(size) * (0.06 if shape != "cliff" else 0.07) + \
            noise.noise(Vector((q.x * 0.3, q.y * 0.3, math.floor(layer) * 1.7)) + off) * (0.08 if shape != "cliff" else 0.14) * min(size)
    out = q + Vector((n.x * sx / 2, n.y * sy / 2, n.z * sz / 2)).normalized() * d
    if shape == "cliff":
        # near-vertical faces: pull the flanks straight, keep the top rough and flat-ish
        out.z = max(out.z, -sz / 2)
    return out


def shaped(shape, lod, size, strata, seed, sink):
    bm = base_mesh(shape, lod, big=max(size) >= 2.5)
    for v in bm.verts:
        v.co = displace(v.co.copy(), size, shape, strata, seed)
    # sit on the ground: lowest point at -sink
    zmin = min(v.co.z for v in bm.verts)
    for v in bm.verts:
        v.co.z -= zmin + sink
    return bm


def _bounds(bm):
    lo = [min(v.co[a] for v in bm.verts) for a in range(3)]
    hi = [max(v.co[a] for v in bm.verts) for a in range(3)]
    return lo, hi


def build(spec, lod):
    size = tuple(float(v) for v in spec["size"])
    shape = spec.get("shape", "boulder")
    strata = float(spec.get("strata", 0.0))
    seed = int(spec.get("seed", 1))
    sink = float(spec.get("sink", 0.25 * size[2]))
    r = Rng(seed)
    tint = mul(lin("#FFFFFF"), r.uniform(0.9, 1.0))
    bm = shaped(shape, lod, size, strata, seed, sink)
    if lod > 0:
        # coarse LODs sample the noise more sparsely: stretch them to the LOD0 bounds, so every
        # LOD fills the same footprint (collider) and the silhouette does not shrink with distance
        ref = shaped(shape, 0, size, strata, seed, sink)
        lo0, hi0 = _bounds(ref)
        ref.free()
        lo, hi = _bounds(bm)
        for v in bm.verts:
            for a in range(3):
                v.co[a] = lo0[a] + (v.co[a] - lo[a]) * (hi0[a] - lo0[a]) / max(1e-6, hi[a] - lo[a])
    bm.normal_update()
    k = K()
    mat = tile("rock", tint).scaled([1.0, 1.0, 1.5][lod] * (1.0 if max(size) < 6 else 1.6))
    for f in bm.faces:
        nrm = f.normal
        axis = max(range(3), key=lambda i: abs(nrm[i]))
        ax, ay = AXES[axis]
        # keep the projection frame right-handed relative to the face (mirror-free texture)
        if axis == 0 and nrm.x < 0:
            ax = -ax
        if axis == 1 and nrm.y > 0:
            ax = -ax
        if axis == 2 and nrm.z < 0:
            ay = -ay
        project_poly(k, [v.co.copy() for v in f.verts], ax, ay, mat, smooth=True)
    zs = [v.z for v in k.verts]
    xs = [v.x for v in k.verts]
    ys = [v.y for v in k.verts]
    bm.free()
    return k, {"footprint": [min(xs), max(xs), min(ys), max(ys)], "height": max(zs), "overhang": 0.0,
               "foundation": -min(zs), "ao_dist": max(0.6, min(size) * 0.5), "ao_strength": 0.5, "grime": False}


def render(objs, R, out_dir, tag):
    import os
    so, mp, info = R.setup()
    R.slab("ground", -60, 60, -60, 60, 0.0, R.ground_mat("grass_dry", 2.0))
    R.aim_sun(so, mp, info, -50, 30)
    layout = {"rock_boulder_s": (-6, -2, 0.3), "rock_boulder_m": (-2, 1, 1.2), "rock_boulder_l": (5, 3, 0.2),
              "rock_slab": (-9, 4, 0.8), "cliff_block": (4, 16, 0.0), "cliff_block_b": (-10, 17, 0.4)}
    for pid, (x, y, rz) in layout.items():
        if pid in objs:
            R.place(objs[pid][0], pid + "_r", (x, y, 0.0), rz)
    R.shoot(os.path.join(out_dir, "rocks_group_%s.png" % tag), (-4, -22, 4.0), (-1, 6, 3.0), lens=30)
    R.shoot(os.path.join(out_dir, "rocks_close_%s.png" % tag), (-3, -6.5, 1.4), (-2, 1, 1.0), lens=30)
