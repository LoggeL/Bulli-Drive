# Licence plates of the cars after the T1 (tools/models/src/license_plate_<id>_512.png).
# The raw images come from tools/textures/generated/gen.sh with prompts/license_plate.txt, the
# registration "BULLI" replaced by the text below (KAEFER, PICKUP, 356 B, THING). Unlike the Bulli
# plate (fixed crop in postprocess_gen.py) the plate is found automatically: the largest area that
# is not the flat grey background, cropped, resized to 512 x 256 (12 x 6 in = 2:1) and the grey
# rounded corners made transparent.
#   python3 tools/textures/generated/prep/plates.py <raw dir with license_plate_<id>.png>
import os, sys
import numpy as np
from PIL import Image

PLATES = {"beetle": "KAEFER", "pickup": "PICKUP", "sport": "356 B", "jeep": "THING"}
OUT = os.path.join(os.path.dirname(__file__), "..", "..", "..", "models", "src")


def prepare(src, dst):
    im = Image.open(src).convert("RGB")
    a = np.asarray(im).astype(np.float32)
    bg = np.median(np.concatenate([a[:8].reshape(-1, 3), a[-8:].reshape(-1, 3)]), axis=0)
    diff = np.abs(a - bg).sum(-1) > 45
    rows = np.where(diff.mean(1) > 0.3)[0]
    cols = np.where(diff.mean(0) > 0.3)[0]
    box = (int(cols.min()), int(rows.min()), int(cols.max()) + 1, int(rows.max()) + 1)
    im = im.crop(box).resize((512, 256), Image.LANCZOS)
    a = np.asarray(im).astype(np.float32)
    d = np.abs(a - bg).sum(-1)
    sat = a.max(-1) - a.min(-1)
    edge = np.zeros(d.shape, bool)
    edge[:14] = edge[-14:] = True
    edge[:, :14] = edge[:, -14:] = True
    alpha = np.where((d < 40) & (sat < 10) & edge, 0, 255).astype(np.uint8)
    Image.fromarray(np.dstack([a.astype(np.uint8), alpha]), "RGBA").save(dst, optimize=True)
    print(dst, box)


raw = sys.argv[1] if len(sys.argv) > 1 else "."
for cid in PLATES:
    prepare(os.path.join(raw, "license_plate_%s.png" % cid), os.path.join(OUT, "license_plate_%s_512.png" % cid))
