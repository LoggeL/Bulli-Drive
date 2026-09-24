# Nachbearbeitung der Codex-imagegen-Rohbilder (gen/raw) zu spielfertigen Texturen.
import sys, numpy as np
from PIL import Image, ImageFilter
import os as _os
# Work tree with the layout of the graphics prototype: assets/ (gen/raw, facade, decals) and
# world/ (gen/raw, tex). Set BD_GEN_ROOT to it; see tools/textures/README.md.
ROOT = _os.environ.get('BD_GEN_ROOT') or _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), '..', '..', '.cache', 'gen-work')
A=_os.path.join(ROOT, 'assets')
R=A+'/gen/raw'
def rgb(p): return Image.open(p).convert('RGB')

def wrap_x(img, k):
    """Macht ein Bild horizontal nahtlos: die rechten k Spalten werden über die linken k geblendet."""
    a=np.asarray(img).astype(np.float32); W=a.shape[1]
    t=np.linspace(0,1,k,dtype=np.float32)[None,:,None]
    out=a[:, :W-k].copy()
    out[:, :k]=a[:, W-k:]*(1-t)+a[:, :k]*t
    return Image.fromarray(np.clip(out,0,255).astype(np.uint8))

def normal_from_luma(img, strength=2.0, blur=1.2):
    """Grobe OpenGL-Normalmap (+Y oben) aus der Helligkeit, x-Richtung periodisch."""
    L=np.asarray(img.convert('L').filter(ImageFilter.GaussianBlur(blur))).astype(np.float32)/255
    dx=(np.roll(L,-1,1)-np.roll(L,1,1))*0.5; dy=(np.roll(L,-1,0)-np.roll(L,1,0))*0.5
    nx=-dx*strength*10; ny=dy*strength*10; nz=np.ones_like(L)
    n=np.stack([nx,ny,nz],-1); n/=np.linalg.norm(n,axis=-1,keepdims=True)
    return Image.fromarray(((n*0.5+0.5)*255).astype(np.uint8))

def facade():
    im=rgb(R+'/facade_atlas.png')
    bands=[(0,313),(317,625),(628,931),(935,1254)]  # Trennlinien bei y=314/626/932 entfernt
    atlas=Image.new('RGB',(1024,1024))
    for i,(y0,y1) in enumerate(bands):
        b=wrap_x(im.crop((0,y0,im.width,y1)),96)
        atlas.paste(b.resize((1024,256),Image.LANCZOS),(0,i*256))
    atlas.save(A+'/facade/facade_atlas_albedo_1k.png', optimize=True)
    atlas.save(A+'/facade/facade_atlas_albedo_1k.jpg', quality=92)
    normal_from_luma(atlas).save(A+'/facade/facade_atlas_normal_gl_1k.png', optimize=True)
    # Kacheltest 3x nebeneinander
    t=Image.new('RGB',(3072,1024)); [t.paste(atlas,(x,0)) for x in (0,1024,2048)]
    t.resize((1536,512)).save(A+'/_preview/facade_tiling_test.jpg',quality=85)

def plate():
    im=rgb(R+'/license_plate.png').crop((27,62,1746,819))
    im=im.resize((1024,512),Image.LANCZOS)   # echtes Seitenverhältnis 12x6 Zoll = 2:1
    a=np.asarray(im).astype(np.float32)
    # graue Hintergrund-Ecken (abgerundete Plattenecken) transparent machen, nur im Randbereich
    d=np.abs(a-np.array([137,136,136],np.float32)).sum(-1); sat=a.max(-1)-a.min(-1)
    bgm=(d<30)&(sat<8); edge=np.zeros_like(bgm); edge[:40]=edge[-40:]=True; edge[:,:40]=edge[:,-40:]=True
    alpha=np.where(bgm&edge,0,255).astype(np.uint8)
    rgba=Image.fromarray(np.dstack([a.astype(np.uint8),alpha]),'RGBA')
    rgba.save(A+'/decals/license_plate_bulli_1k.png', optimize=True)
    rgba.resize((512,256),Image.LANCZOS).save(A+'/decals/license_plate_bulli_512.png', optimize=True)

def storefront(name, src):
    im=rgb(R+f'/{src}.png')
    im.save(A+f'/decals/{name}_full.png', optimize=True)
    im.resize((1024, round(1024*im.height/im.width)),Image.LANCZOS).save(A+f'/decals/{name}_1k.jpg',quality=90)

def bleed(rgb, alpha):
    """Farbe in transparente Bereiche ausdehnen (gegen Farbsäume beim Mipmapping)."""
    col=rgb.astype(np.float32).copy(); w=(alpha>0.5).astype(np.float32)
    for rad in (2,4,8,16,32,64,128):
        ws=np.asarray(Image.fromarray((w*255).astype(np.uint8)).filter(ImageFilter.BoxBlur(rad))).astype(np.float32)/255
        cs=np.stack([np.asarray(Image.fromarray(np.clip(col[...,i]*w,0,255).astype(np.uint8)).filter(ImageFilter.BoxBlur(rad))).astype(np.float32) for i in range(3)],-1)
        fill=(w<0.5)&(ws>0.01)
        col[fill]=cs[fill]/ws[fill][:,None]; w=np.where(fill,1.0,w)
    return col

def signs():
    """Magenta-Chroma-Key -> RGBA, dann jedes Schild einzeln ausschneiden."""
    im=np.asarray(rgb(R+'/street_signs.png')).astype(np.float32)
    r,g,b=im[...,0],im[...,1],im[...,2]
    # Magenta: r und b hoch, g niedrig. Distanz zur Hintergrundfarbe (aus den Ecken geschätzt)
    bg=np.median(np.concatenate([im[:8,:8].reshape(-1,3),im[-8:,-8:].reshape(-1,3)]),0)
    d=np.sqrt(((im-bg)**2).sum(-1))
    alpha=np.clip((d-70)/60,0,1)
    # Despill: im Randband (bis ~4 px an Transparenz) Magenta-Stich entfernen (r,b gleichmäßig über g)
    band=np.asarray(Image.fromarray((alpha*255).astype(np.uint8)).filter(ImageFilter.MinFilter(9))).astype(np.float32)/255<0.99
    m=np.clip(np.minimum(r-g,b-g),0,None)
    im2=im.copy(); im2[...,0]=np.where(band,r-m,r); im2[...,2]=np.where(band,b-m,b)
    col=bleed(im2,alpha)
    im2=np.where((alpha>0.5)[...,None],im2,col)
    rgba=np.dstack([im2,alpha*255]).astype(np.uint8)
    out=Image.fromarray(rgba,'RGBA'); out.save(A+'/decals/street_signs_sheet.png',optimize=True)
    # Einzelne Schilder über zusammenhängende Alpha-Bereiche
    from collections import deque
    mask=alpha>0.5; H,W=mask.shape; lab=np.zeros((H,W),np.int32); boxes=[]
    # grobe Komponenten-Suche auf 1/4 Auflösung
    s=4; ms=mask[::s,::s]; h,w=ms.shape; seen=np.zeros_like(ms)
    for y in range(h):
        for x in range(w):
            if ms[y,x] and not seen[y,x]:
                q=deque([(y,x)]); seen[y,x]=1; y0=y1=y; x0=x1=x; n=0
                while q:
                    cy,cx=q.popleft(); n+=1; y0=min(y0,cy);y1=max(y1,cy);x0=min(x0,cx);x1=max(x1,cx)
                    for ny,nx in ((cy+1,cx),(cy-1,cx),(cy,cx+1),(cy,cx-1)):
                        if 0<=ny<h and 0<=nx<w and ms[ny,nx] and not seen[ny,nx]: seen[ny,nx]=1; q.append((ny,nx))
                if n>400: boxes.append((x0*s,y0*s,(x1+1)*s,(y1+1)*s,n))
    boxes.sort(key=lambda b:((b[1]+b[3])/2>H/2,b[0]))  # Zeile oben/unten, dann links->rechts
    print('signs found:',len(boxes),[b[:4] for b in boxes])
    names=['sign_stop','sign_speed_limit_35','sign_curve_right','sign_one_way_right',
           'sign_street_ocean_ave','sign_street_pacific_coast_hwy','sign_chevron_right','sign_route_ca1']
    import os, json
    os.makedirs(A+'/decals/signs',exist_ok=True)
    if len(boxes)!=len(names): print('WARN: Anzahl passt nicht, keine Einzelsprites'); return
    # Atlas 1024x1024, Zeilen-Packing, 4 px Rand gegen Mip-Bluten
    sprites=[]
    for n,(x0,y0,x1,y1,_) in zip(names,boxes):
        c=out.crop((max(0,x0-6),max(0,y0-6),min(out.width,x1+6),min(out.height,y1+6)))
        bb=c.getchannel('A').point(lambda v:255 if v>8 else 0).getbbox(); c=c.crop(bb)
        c.save(A+f'/decals/signs/{n}.png',optimize=True); sprites.append((n,c))
    AT=1024
    def pack(scale):
        x=y=4; rowh=0; pos=[]
        for n,c in sprites:
            w,h=round(c.width*scale),round(c.height*scale)
            if x+w+4>AT: x=4; y+=rowh+8; rowh=0
            pos.append((n,x,y,w,h)); x+=w+8; rowh=max(rowh,h)
        return pos, y+rowh+4<=AT
    scale=1.0
    while not pack(scale)[1]: scale-=0.02
    pos,_=pack(scale); print('atlas scale',round(scale,2))
    atlas=Image.new('RGBA',(AT,AT),(0,0,0,0)); meta={'_note':'uv = [u0,v0,u1,v1], three.js-Konvention (flipY=true, v=0 unten); x/y/w/h in Pixeln von oben links','_scale_from_sheet':round(scale,3)}
    for (n,c),(_,x,y,w,h) in zip(sprites,pos):
        atlas.paste(c.resize((w,h),Image.LANCZOS),(x,y))
        meta[n]={'x':x,'y':y,'w':w,'h':h,'uv':[round(x/AT,5),round(1-(y+h)/AT,5),round((x+w)/AT,5),round(1-y/AT,5)]}
    aa=np.asarray(atlas).astype(np.float32); al=aa[...,3]/255
    c=bleed(aa[...,:3],al); c=np.where((al>0.5)[...,None],aa[...,:3],c)
    atlas=Image.fromarray(np.dstack([c,aa[...,3]]).astype(np.uint8),'RGBA')
    atlas.save(A+'/decals/street_signs_atlas_1k.png',optimize=True)
    json.dump(meta,open(A+'/decals/street_signs_atlas_1k.json','w'),indent=1)

def diner_emissive():
    """Emissive-Map für die Neonröhren im Schild und die Lampen im Innenraum (Farbe = Albedo x Maske)."""
    im=rgb(R+'/diner_front.png'); a=np.asarray(im).astype(np.float32)/255; H,W,_=a.shape
    mx=a.max(-1); mn=a.min(-1); sat=(mx-mn)/(mx+1e-4)
    yy=np.arange(H)[:,None]/H
    xx=np.arange(W)[None,:]/W
    panel=(yy>0.035)&(yy<0.225)&(xx>0.018)&(xx<0.982)
    neon=panel&(sat>0.45)&(mx>0.45)&(((a[...,0]>a[...,1]+0.25))|((a[...,2]>a[...,0]+0.2)&(a[...,1]>a[...,0]+0.15)))
    # nur echte Röhren: die kleinen Deko-Streifen links/rechts sind auch türkis -> leuchten mit, gewollt
    lamps=(yy>0.415)&(yy<0.52)&(mx>0.78)&(sat<0.5)&(a[...,0]-a[...,2]>0.08)
    m=(neon|lamps).astype(np.uint8)*255
    m=np.asarray(Image.fromarray(m).filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(1.5))).astype(np.float32)/255
    e=(a*m[...,None]*255).astype(np.uint8)
    Image.fromarray(e).resize((1024,512),Image.LANCZOS).save(A+'/decals/storefront_diner_emissive_1k.jpg',quality=90)

if __name__=='__main__':
    what=sys.argv[1:]
    if 'facade' in what: facade()
    if 'plate' in what: plate()
    if 'diner' in what: storefront('storefront_diner','diner_front')
    if 'surf' in what: storefront('storefront_surfshop','surfshop_front_v2')
    if 'gas' in what: storefront('storefront_gas_station','gas_station_front_v2')
    if 'signs' in what: signs()
    if 'diner_e' in what: diner_emissive()
