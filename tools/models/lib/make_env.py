# Prepares the look-dev HDRIs for the car renders (bd_lookdev.py) and the three.js viewer.
#
# The Victoria Sunset HDRI has a very hot sun (peak ~1.2e5) only 4.4 deg above the horizon.
# For look-dev we want the sun as a separate directional light (shadows, 10-12 deg elevation),
# so this script writes a copy with the sun clamped away ("nosun"). It also stores the sun
# position in both the Blender and the three.js equirect conventions in env_info.json.
#
#   python3 tools/models/lib/make_env.py [<src.hdr> ...]      -> tools/models/.cache/env/
#
# Without arguments it uses the HDRIs that tools/textures/fetch.mjs downloaded
# (tools/textures/.cache/hdri/victoria_sunset_{1k,2k}.hdr). Needs numpy.
import sys, os, json, math
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.dirname(HERE)
OUT = os.path.join(MODELS, ".cache", "env")
os.makedirs(OUT, exist_ok=True)
HDRI_CACHE = os.path.join(os.path.dirname(MODELS), "textures", ".cache", "hdri")


def read_hdr(p):
    f = open(p, "rb")
    while True:
        l = f.readline().strip()
        if l == b"":
            break
    dims = f.readline().split()
    H, W = int(dims[1]), int(dims[3])
    data = f.read()
    img = np.zeros((H, W, 4), np.uint8)
    pos = 0
    for y in range(H):
        if data[pos] == 2 and data[pos + 1] == 2:
            pos += 4
            for c in range(4):
                x = 0
                while x < W:
                    n = data[pos]
                    pos += 1
                    if n > 128:
                        n -= 128
                        img[y, x:x + n, c] = data[pos]
                        pos += 1
                    else:
                        img[y, x:x + n, c] = np.frombuffer(data[pos:pos + n], np.uint8)
                        pos += n
                    x += n
        else:
            img[y] = np.frombuffer(data[pos:pos + W * 4], np.uint8).reshape(W, 4)
            pos += W * 4
    e = img[..., 3].astype(np.int32)
    rgb = img[..., :3].astype(np.float32)
    s = np.where(e > 0, np.ldexp(1.0, e - 136), 0).astype(np.float32)
    return rgb * s[..., None]


def write_hdr(p, a):
    """flat (non-RLE) Radiance RGBE; three's RGBELoader and Blender read it."""
    H, W, _ = a.shape
    m = a.max(axis=2)
    e = np.zeros((H, W), np.int32)
    mant, ex = np.frexp(m)
    ok = m > 1e-32
    e[ok] = ex[ok]
    scale = np.where(ok, np.ldexp(1.0, 8 - e), 0.0).astype(np.float64)  # value * 256 / 2^e
    rgbe = np.zeros((H, W, 4), np.uint8)
    rgbe[..., :3] = np.clip(np.floor(a * scale[..., None]), 0, 255).astype(np.uint8)
    rgbe[..., 3] = np.where(ok, e + 128, 0).astype(np.uint8)
    with open(p, "wb") as f:
        f.write(b"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n")
        f.write(("-Y %d +X %d\n" % (H, W)).encode())
        f.write(rgbe.tobytes())


info = {}
sources = sys.argv[1:] or [os.path.join(HDRI_CACHE, "victoria_sunset_%s.hdr" % r) for r in ("1k", "2k")]
for src in sources:
    if not os.path.exists(src):
        raise SystemExit("missing %s - run: npm --prefix tools run textures:fetch" % src)
    a = read_hdr(src)
    H, W, _ = a.shape
    L = a @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    m = L > L.max() * 0.5
    ys, xs = np.nonzero(m)
    yc, xc = ys.mean(), xs.mean()
    u = (xc + 0.5) / W
    v_top = (yc + 0.5) / H          # 0 = top row
    elev = 90 - v_top * 180
    lon = (u - 0.5) * 2 * math.pi
    ce = math.cos(math.radians(elev))
    # Blender Environment Texture (Cycles/Eevee equirect): u = 0.5 - atan2(d.y, d.x)/2pi
    # (identical to three.js after the glTF axis swap: blender (x, y, z) = three (x, -z, y))
    d_bl = (math.cos(lon) * ce, -math.sin(lon) * ce, math.sin(math.radians(elev)))
    # three.js equirectUv: u = atan2(d.z, d.x)/2pi + 0.5
    d_3 = (math.cos(lon) * ce, math.sin(math.radians(elev)), math.sin(lon) * ce)
    # clamp everything that is brighter than the brightest sky (disc + corona)
    thr = float(os.environ.get("CLAMP", "3.5"))   # sky stays, disc + hot corona are removed
    k = np.minimum(1.0, thr / np.maximum(L, 1e-6))
    b = a * k[..., None]
    # energy that was removed = sun irradiance estimate (solid-angle weighted)
    lat = (0.5 - (np.arange(H) + 0.5) / H) * math.pi
    dw = (2 * math.pi / W) * (math.pi / H) * np.cos(lat)
    removed = ((a - b) * dw[:, None, None]).sum(axis=(0, 1))
    name = os.path.basename(src).replace(".hdr", "")
    dst = os.path.join(OUT, name + "_nosun.hdr")
    write_hdr(dst, b)
    info[name] = {
        "src": src, "nosun": dst, "size": [W, H], "sun_u": round(u, 4), "sun_elev_deg": round(elev, 2),
        "sun_dir_blender": [round(x, 4) for x in d_bl], "sun_dir_three": [round(x, 4) for x in d_3],
        "sun_az_blender_deg": round(math.degrees(math.atan2(d_bl[1], d_bl[0])), 2),
        "clamp_threshold": round(thr, 2), "sun_rgb_removed": [round(float(x), 3) for x in removed],
        "sky_mean_after": round(float((b @ np.array([0.2126, 0.7152, 0.0722])).mean()), 4),
    }
    print(name, json.dumps(info[name]))
p = os.path.join(OUT, "env_info.json")
old = json.load(open(p)) if os.path.exists(p) else {}
old.update(info)
json.dump(old, open(p, "w"), indent=1)
