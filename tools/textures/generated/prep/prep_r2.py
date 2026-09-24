# Runde 2: Fächerwedel-Atlas (2x2), Baumkarten-Atlas (Eiche + Zypresse), Diner-Interieur. Magenta-Key wie prep_foliage.
import sys, numpy as np, json
from PIL import Image
sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))
from prep_foliage import key, bleed, G, W

def rgba(col, al):
    return Image.fromarray(np.dstack([np.clip(col,0,255).astype(np.uint8),(al*255).astype(np.uint8)]),'RGBA')

def fan():
    im=Image.open(G+'/fan_fronds.png').convert('RGB').resize((1024,1024),Image.LANCZOS)
    a,al=key(im,'magenta'); col=bleed(a,al)
    rgba(col,al).save(W+'/fan_fronds.png',optimize=True)
    # Blattmittelpunkte (Stielansatz) je Zelle für die Kartengeometrie
    print('fan coverage', al.mean().round(3))

def trees():
    im=Image.open(G+'/tree_cards.png').convert('RGB')
    at=Image.new('RGBA',(1024,1024),(0,0,0,0))
    rects={}
    for name,box,dst in [('oak',(20,55,862,1252),(0,12,700,1012)),('cypress',(922,12,1205,1252),(752,12,1004,1012))]:
        c=im.crop(box).resize((dst[2]-dst[0],dst[3]-dst[1]),Image.LANCZOS)
        a,al=key(c,'magenta'); col=bleed(a,al)
        # Rest-Magenta in halbtransparenten Löchern: Farbe Richtung Olivgrün ziehen
        at.paste(rgba(col,al),(dst[0],dst[1]))
        rects[name]=[dst[0]/1024,1-dst[3]/1024,dst[2]/1024,1-dst[1]/1024]
    at.save(W+'/tree_cards.png',optimize=True)
    json.dump(rects,open(W+'/tree_cards.json','w'))
    print(rects)

def interior():
    im=Image.open(G+'/diner_interior.png').convert('RGB').resize((1024,512),Image.LANCZOS)
    im.save(W+'/diner_interior.jpg',quality=88)


def rock():
    import numpy as np
    from postprocess_gen import wrap_x, normal_from_luma
    im=Image.open(G+'/rock_cliff.png').convert('RGB').resize((1024,1024),Image.LANCZOS)
    im=wrap_x(im,96); im=wrap_x(im.transpose(Image.Transpose.ROTATE_90),96).transpose(Image.Transpose.ROTATE_270)
    im=im.resize((1024,1024),Image.LANCZOS)
    a=np.asarray(im).astype(np.float32); l=a.mean(-1,keepdims=True); a=l+(a-l)*0.72   # etwas grauer
    im=Image.fromarray(np.clip(a,0,255).astype(np.uint8))
    im.save(W+'/rock_albedo_1k.jpg',quality=88)
    normal_from_luma(im,strength=4.0,blur=1.2).save(W+'/rock_normal_1k.jpg',quality=90)

if __name__=='__main__':
    for w in (sys.argv[1:] or ['fan','trees','interior','rock']): globals()[w]()
