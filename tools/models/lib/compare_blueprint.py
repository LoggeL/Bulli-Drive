# Overlays the orthographic Workbench renders (250 px/m, written by
# tools/models/vehicles/bulli.py --ortho) with the matching views of
# tools/models/ref/t1_blueprint.jpg, rescaled to the real dimensions.
#   blender -b --factory-startup --python tools/models/vehicles/bulli.py -- --no-render --ortho --lods=0
#   python3 tools/models/lib/compare_blueprint.py [<work dir>]   (default tools/models/.out/bulli/work)
# Output: <work dir>/overlay_<view>.png. The pixel mapping (VIEWS) is specific to the T1 sheet.
# (left: blueprint, middle: render, right: 50/50 blend with blueprint edges in green).
import os
import numpy as np
from PIL import Image, ImageFilter, ImageDraw

import sys
MODELS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BP = Image.open(os.path.join(MODELS, "ref", "t1_blueprint.jpg")).convert("RGB")
PPM = 250.0                    # render px per metre
W, H = 1200, 600               # render size, camera centre at world (0, 0.97) (top: (0, 0))

# blueprint view -> world mapping: world = (bx - bx0) / sx (+ offset), z = (by0 - by) / sz
# horizontal render axis: side = y (front left), front = x (car left on the right),
# rear = -x, top = y (vertical axis = -x)
VIEWS = {
    #        crop box            bx0     sx     by0   sz     wx0 (world at bx0)   vertical centre
    "side":  ((540, 30, 1500, 480), 552.5, 216.0, 465.0, 209.3, -2.14, 0.97),
    "front": ((60, 30, 480, 480), 268.0, 211.0, 465.0, 211.0, 0.0, 0.97),
    "rear":  ((60, 510, 480, 950), 268.0, 209.0, 935.0, 209.0, 0.0, 0.97),
    "top":   ((555, 535, 1480, 905), 563.0, 211.0, 719.0, 183.0, -2.14, 0.0),
}


def warp(view):
    box, bx0, sx, by0, sz, wx0, zc = VIEWS[view]
    # output pixel (c, r) -> world (u, v): u = (c - W/2)/PPM, v = zc + (H/2 - r)/PPM
    # blueprint pixel: bx = bx0 + (u - wx0) * sx, by = by0 - v * sz   (top view: v = -x lateral)
    # PIL affine: input = a*c + b*r + c0, d*c + e*r + f0
    a = sx / PPM
    c0 = bx0 + (-W / 2 / PPM - wx0) * sx
    e = sz / PPM
    if view == "top":
        # render vertical axis: up = -X; blueprint top view: up = one side; centre row by0
        f0 = by0 - (H / 2 / PPM) * sz
    else:
        f0 = by0 - (zc + H / 2 / PPM) * sz
    return BP.transform((W, H), Image.AFFINE, (a, 0, c0, 0, e, f0), resample=Image.BICUBIC)


out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(MODELS, ".out", "bulli", "work")
for v in VIEWS:
    rp = os.path.join(out_dir, "ortho_%s.png" % v)
    if not os.path.exists(rp):
        continue
    bp = warp(v)
    rn = Image.open(rp).convert("RGBA")
    bg = Image.new("RGBA", rn.size, (235, 235, 235, 255))
    rn = Image.alpha_composite(bg, rn).convert("RGB")
    blend = Image.blend(bp, rn, 0.5)
    edges = bp.convert("L").filter(ImageFilter.FIND_EDGES).point(lambda x: 255 if x > 60 else 0)
    ea = np.array(blend)
    em = np.array(edges) > 0
    ea[em] = [0, 170, 0]
    blend = Image.fromarray(ea)
    # grid every 0.5 m
    d = ImageDraw.Draw(blend)
    for k in range(-10, 11):
        x = W / 2 + k * 0.5 * PPM
        d.line([(x, 0), (x, 6)], fill=(0, 0, 255))
    sheet = Image.new("RGB", (W, H * 3), "white")
    sheet.paste(bp, (0, 0))
    sheet.paste(rn, (0, H))
    sheet.paste(blend, (0, 2 * H))
    sheet.save(os.path.join(out_dir, "overlay_%s.png" % v))
    blend.save(os.path.join(out_dir, "overlay_%s_blend.png" % v))
    print("wrote", v)
