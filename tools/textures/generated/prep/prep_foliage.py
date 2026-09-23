# Freistellen der Codex-Bilder: Palmwedel (Magenta-Key) und Büsche (Blau-Key) -> RGBA mit Color-Bleed; Stammrinde kachelbar.
import sys, numpy as np
from PIL import Image, ImageFilter
sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))
from postprocess_gen import bleed, wrap_x
import os as _os
# Work tree with the layout of the graphics prototype: assets/ (gen/raw, facade, decals) and
# world/ (gen/raw, tex). Set BD_GEN_ROOT to it; see tools/textures/README.md.
ROOT = _os.environ.get('BD_GEN_ROOT') or _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), '..', '..', '.cache', 'gen-work')
G=_os.path.join(ROOT, 'world', 'gen', 'raw'); W=_os.path.join(ROOT, 'world', 'tex')

def key(img, keycol):
    a=np.asarray(img.convert('RGB')).astype(np.float32)
    r,g,b=a[...,0],a[...,1],a[...,2]
    if keycol=='magenta':
        m=np.minimum(r,b)-g            # wie stark magenta
        alpha=1-np.clip((m-25)/70,0,1)
        # Despill: Magenta-Anteil aus R und B nehmen
        spill=np.clip(np.minimum(r,b)-g,0,None)*(1-alpha*0.2)
        a[...,0]=r-spill*0.85; a[...,2]=b-spill*0.95
    else:  # blau
        m=b-np.maximum(r,g)
        alpha=1-np.clip((m-30)/80,0,1)
        spill=np.clip(b-np.maximum(r,g),0,None)
        a[...,2]=b-spill*0.95
    alpha=np.asarray(Image.fromarray((alpha*255).astype(np.uint8)).filter(ImageFilter.MinFilter(3))).astype(np.float32)/255
    a=np.clip(a,0,255)
    return a, alpha

def fronds():
    im=Image.open(G+'/palm_fronds.png').convert('RGB').resize((1024,1024),Image.LANCZOS)
    a,al=key(im,'magenta')
    # Fläche leicht aufhellen/entsättigen Richtung Olivgrün-Gold (KI-Bild ist recht grell)
    col=bleed(a,al)
    out=np.dstack([np.clip(col,0,255).astype(np.uint8),(al*255).astype(np.uint8)])
    Image.fromarray(out,'RGBA').save(W+'/palm_fronds.png',optimize=True)
    print('fronds alpha coverage', al.mean())

def shrubs():
    im=Image.open(G+'/shrub_card.png').convert('RGB')
    # zwei Pflanzen: links / rechts, je quadratisch zuschneiden auf 512x512 -> Atlas 1024x512
    W0,H0=im.size
    boxes=[(0,250,640,980),(620,250,1254,980)]
    at=Image.new('RGB',(1024,512)); am=Image.new('L',(1024,512))
    for i,bx in enumerate(boxes):
        c=im.crop(bx).resize((512,512),Image.LANCZOS)
        a,al=key(c,'blue'); col=bleed(a,al)
        at.paste(Image.fromarray(np.clip(col,0,255).astype(np.uint8)),(i*512,0))
        am.paste(Image.fromarray((al*255).astype(np.uint8)),(i*512,0))
    at.putalpha(am); at.save(W+'/shrubs.png',optimize=True)

def trunk(src='palm_trunk'):
    im=Image.open(G+f'/{src}.png').convert('RGB')
    if src=='palm_trunk': im=im.crop((200,150,1060,1050))
    im=im.resize((512,512),Image.LANCZOS)
    im=wrap_x(im,64)                       # horizontal nahtlos
    im=wrap_x(im.transpose(Image.Transpose.ROTATE_90),64).transpose(Image.Transpose.ROTATE_270)  # vertikal nahtlos
    im=im.resize((512,512),Image.LANCZOS)
    im.save(W+'/palm_trunk.jpg',quality=90)
    from postprocess_gen import normal_from_luma
    normal_from_luma(im,strength=3.0,blur=1.0).save(W+'/palm_trunk_normal.jpg',quality=90)

if __name__=='__main__':
    what=sys.argv[1:] or ['fronds','shrubs','trunk:palm_trunk_v2']
    for w in what:
        if w.startswith('trunk'): trunk(*(w.split(':')[1:]))
        else: globals()[w]()
    print('ok')
