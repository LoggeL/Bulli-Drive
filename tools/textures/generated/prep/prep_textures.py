# Bereitet Welt-Texturen vor: Fassaden-ARM + Tönungsmaske, Ladenfront-Atlas, Grunge-Rauschen.
import numpy as np
from PIL import Image, ImageFilter
import os as _os
# Work tree with the layout of the graphics prototype: assets/ (gen/raw, facade, decals) and
# world/ (gen/raw, tex). Set BD_GEN_ROOT to it; see tools/textures/README.md.
ROOT = _os.environ.get('BD_GEN_ROOT') or _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), '..', '..', '.cache', 'gen-work')
A=_os.path.join(ROOT, 'assets')
W=_os.path.join(ROOT, 'world', 'tex')
import os; os.makedirs(W,exist_ok=True)

def facade():
    im=Image.open(A+'/facade/facade_atlas_albedo_1k.png').convert('RGB')
    a=np.asarray(im).astype(np.float32)/255
    lum=a@np.array([0.2126,0.7152,0.0722],np.float32)
    sat=a.max(-1)-a.min(-1)
    # Stuck = hell & ungesättigt -> tönbar (weich)
    stucco=np.clip((lum-0.55)/0.15,0,1)*np.clip((0.16-sat)/0.08,0,1)
    m=Image.fromarray((stucco*255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2))
    rgba=np.dstack([np.asarray(im),np.asarray(m)])
    Image.fromarray(rgba,'RGBA').save(W+'/facade_albedo_tint_1k.png',optimize=True)
    # Glas = dunkel & ungesättigt -> glatt; Stuck rau
    glass=np.clip((0.32-lum)/0.12,0,1)*np.clip((0.12-sat)/0.06,0,1)
    rough=0.92-0.78*glass
    ao=np.clip(0.55+lum*0.9,0,1)  # grobe Kavitäts-AO aus Helligkeit
    metal=glass*0.0
    arm=np.dstack([ao,rough,metal])
    Image.fromarray((arm*255).astype(np.uint8)).save(W+'/facade_arm_1k.jpg',quality=92)
    # Emissive: warmes Innenlicht in Glasflächen (nur leicht)
    em=(glass[...,None]*np.array([1.0,0.62,0.3])*np.clip(lum*3.0,0,1)[...,None])
    Image.fromarray((np.clip(em,0,1)*255).astype(np.uint8)).resize((512,512),Image.LANCZOS).save(W+'/facade_emissive_512.jpg',quality=88)

def storefronts():
    # 2048x1024 Atlas, 2x2 Slots à 1024x512: diner | surf / gas | diner-variante (gespiegelt nicht nötig -> surf nochmal)
    names=['storefront_diner_full','storefront_surfshop_full','storefront_gas_station_full']
    at=Image.new('RGB',(2048,1024)); em=Image.new('RGB',(2048,1024))
    slots=[(0,0),(1024,0),(0,512),(1024,512)]
    for i,n in enumerate(names+[names[1]]):
        im=Image.open(A+'/decals/'+n+'.png').convert('RGB').resize((1024,512),Image.LANCZOS)
        at.paste(im,slots[i])
    d=Image.open(A+'/decals/storefront_diner_emissive_1k.jpg').convert('RGB').resize((1024,512),Image.LANCZOS)
    em.paste(d,slots[0])
    at.save(W+'/storefront_atlas_2k.jpg',quality=90)
    em.resize((1024,512),Image.LANCZOS).save(W+'/storefront_emissive_1k.jpg',quality=88)

def tile_noise(n, scales, seed):
    rng=np.random.default_rng(seed); out=np.zeros((n,n),np.float32); amp=1.0; tot=0
    for s in scales:
        g=rng.random((s,s)).astype(np.float32)
        im=Image.fromarray((g*255).astype(np.uint8))
        # periodisch hochskalieren: 3x3 kacheln, bikubisch, Mitte ausschneiden
        big=Image.new('L',(s*3,s*3)); [big.paste(im,(x*s,y*s)) for x in range(3) for y in range(3)]
        big=big.resize((n*3,n*3),Image.BICUBIC).crop((n,n,2*n,2*n))
        out+=amp*np.asarray(big).astype(np.float32)/255; tot+=amp; amp*=0.55
    out/=tot
    out=(out-out.min())/(out.max()-out.min())
    return out

def noise():
    # R: Makro (grob), G: mittel, B: fein, A: Flecken -> gemeinsame Welt-Rauschtextur
    r=tile_noise(256,[4,8],1); g=tile_noise(256,[16,32],2); b=tile_noise(256,[64,128],3)
    spots=tile_noise(256,[12,24,48],4); spots=np.clip((spots-0.55)/0.15,0,1)
    rgba=np.dstack([r,g,b,spots])
    Image.fromarray((rgba*255).astype(np.uint8),'RGBA').save(W+'/world_noise_256.png')

facade(); storefronts(); noise()
print('ok')
