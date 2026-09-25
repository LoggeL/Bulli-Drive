# Builds one group of the building kit in Blender and exports it as a raw GLB.
#
#   blender -b --factory-startup --python tools/models/buildings/kit.py -- --group=downtown
#       [--out=tools/models/.out/kit] [--render=<dir>] [--tag=v1] [--only=<piece>,...]
#
# Usually run through tools/models/buildings/build-kit.mjs (all groups, then pack + KTX2).
# Output: <out>/<group>.glb (+ <group>.report.json): root node kit_<group>, one empty per piece
# with the piece's extras (kit.json params, footprint, height, LOD distances) and one mesh child
# per LOD (<piece>_lod0..2), a single placeholder material "kit_atlas", COLOR_0 = tint x AO.
import sys, os, json, time, importlib, math

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))
sys.path.insert(0, os.path.join(HERE, "pieces"))
import bpy
import bd_kit

MODELS = os.path.dirname(HERE)


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    opt = {}
    for a in argv:
        if a.startswith("--"):
            k, _, v = a[2:].partition("=")
            opt[k] = v if v else True
    return opt


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def main():
    opt = parse_args()
    reg = json.load(open(os.path.join(HERE, "kit.json")))
    group = opt["group"]
    spec = reg["groups"][group]
    out = opt.get("out", os.path.join(MODELS, ".out", "kit"))
    os.makedirs(out, exist_ok=True)
    only = set(opt["only"].split(",")) if opt.get("only") else None
    reset()
    mod = importlib.import_module(spec["module"])
    atlas_dir = os.path.join(MODELS, ".out", "kit", "atlas")
    # export: a plain material named kit_atlas (build-kit.mjs attaches the KTX2 atlas maps by name);
    # renders: the textured material with the atlas PNGs
    mat = bpy.data.materials.new("kit_atlas")
    root = bpy.data.objects.new("kit_" + group, None)
    bpy.context.scene.collection.objects.link(root)
    root["kit_group"] = group
    report = {"group": group, "pieces": {}}
    objs = {}
    t0 = time.time()
    dist = reg["lodDistances"]
    for piece in spec["pieces"]:
        pid = piece["id"]
        if only and pid not in only:
            continue
        category = piece.get("category", spec["category"])
        lods = piece.get("lods", [0, 1, 2])
        e = bpy.data.objects.new(pid, None)
        bpy.context.scene.collection.objects.link(e)
        e.parent = root
        rep = {"lods": {}}
        objs[pid] = {}
        meta = None
        top = 0.0
        for lod in lods:
            k, m = mod.build(piece, lod)
            if lod == lods[0]:
                meta = m
            o = bd_kit.to_object("%s_lod%d" % (pid, lod), k, mat, parent=e)
            ao = bd_kit.bake_ao(o, samples=[24, 14, 8][lod], dist=m.get("ao_dist", 2.2), strength=m.get("ao_strength", 0.55))
            if m.get("grime", True):
                bd_kit.grime(o, low=m.get("grime_low", 0.86))
            rep["lods"][lod] = {"triangles": k.tris(), "ao": ao}
            top = max(top, max(v.z for v in k.verts))
            objs[pid][lod] = o
        # footprint in three.js axes: x = Blender x, z = -Blender y
        fx0, fx1, fy0, fy1 = meta["footprint"]
        extras = {
            "kit_piece": pid,
            "group": group,
            "category": category,
            "footprint": {"minX": round(fx0, 3) + 0.0, "maxX": round(fx1, 3) + 0.0,
                          "minZ": round(-fy1, 3) + 0.0, "maxZ": round(-fy0, 3) + 0.0},
            # collider top: the highest vertex of all LODs (chimneys, flag poles, lamp heads included)
            "height": math.ceil(top * 100) / 100,
            "overhang": round(meta.get("overhang", 0.0), 3),
            "foundation": round(meta.get("foundation", 0.0), 3),
            "lods": lods,
            "lod_distances": dist[category][:len(lods) - 1],
            "params": {k_: v for k_, v in piece.items() if k_ not in ("id", "lods", "category")},
        }
        for k_, v in meta.get("params", {}).items():
            extras["params"][k_] = v
        for k_, v in extras.items():
            e[k_] = v
        rep["extras"] = extras
        report["pieces"][pid] = rep
        print("PIECE", pid, " ".join("lod%d=%d" % (l, rep["lods"][l]["triangles"]) for l in lods))
    path = os.path.join(out, group + ".glb")
    bd_kit.export_group(root, path)
    report["glb"] = path
    report["seconds"] = round(time.time() - t0, 1)
    json.dump(report, open(os.path.join(out, group + ".report.json"), "w"), indent=1)
    print("DONE", group, path, os.path.getsize(path), "bytes", report["seconds"], "s")
    if opt.get("render"):
        import bd_kit_render as R
        for pid, lods in objs.items():
            for o in lods.values():
                o.hide_render = True
        root.hide_render = True
        rmat = bd_kit.atlas_material(atlas_dir, "kit_atlas_render")
        for pid, lods in objs.items():
            for o in lods.values():
                o.data.materials[0] = rmat
        mod.render(objs, R, opt["render"], opt.get("tag", "v1"))


main()
