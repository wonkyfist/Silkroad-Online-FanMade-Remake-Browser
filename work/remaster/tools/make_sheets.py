"""Labelled comparison sheets for the bake-off (<= 2400 px wide, a big label on every tile).
usage: python make_sheets.py   (reads work/tmp/detail/bakeoff/renders/<subject>/<variant>_<shot>.png)
"""
import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..'))
BO = os.path.join(ROOT, 'work', 'tmp', 'detail', 'bakeoff')
RD = os.path.join(BO, 'renders')
VARS = [('A', 'A  original'), ('B', 'B  GAN + local maps'), ('C0', 'C0  Meshy, own maps'),
        ('C', 'C  Meshy + local maps'), ('D', 'D  local SDXL + local maps')]
BG = (24, 24, 26); GAP = 6


def font(sz, bold=True):
    for f in (('arialbd.ttf' if bold else 'arial.ttf'), 'arial.ttf'):
        try:
            return ImageFont.truetype(f, sz)
        except OSError:
            pass
    return ImageFont.load_default()


def label(im, text, sz=30, sub=None):
    im = im.convert('RGB'); d = ImageDraw.Draw(im); f = font(sz)
    w = int(d.textlength(text, font=f)) + 20; h = sz + 16
    if sub:
        fs = font(int(sz * 0.62), False); w = max(w, int(d.textlength(sub, font=fs)) + 20); h += int(sz * 0.62) + 6
    d.rectangle([0, 0, w, h], fill=(0, 0, 0))
    d.text((10, 6), text, fill=(255, 235, 120), font=f)
    if sub:
        d.text((10, sz + 12), sub, fill=(220, 220, 220), font=fs)
    return im


def fit(im, w=None, h=None):
    if w and h:
        s = min(w / im.width, h / im.height)
    elif w:
        s = w / im.width
    else:
        s = h / im.height
    return im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS)


def header(width, title, lines, sz=40):
    f = font(sz); fs = font(22, False)
    h = sz + 24 + 30 * len(lines)
    im = Image.new('RGB', (width, h), BG); d = ImageDraw.Draw(im)
    d.text((14, 10), title, fill=(255, 255, 255), font=f)
    for i, l in enumerate(lines):
        d.text((16, sz + 20 + 30 * i), l, fill=(200, 200, 200), font=fs)
    return im


def stack(rows, width):
    H = sum(r.height for r in rows) + GAP * (len(rows) - 1)
    out = Image.new('RGB', (width, H), BG); y = 0
    for r in rows:
        out.paste(r, (0, y)); y += r.height + GAP
    return out


def grid(subject, shots, variants, col_w, row_names):
    rows = []
    for shot in shots:
        tiles = []
        for v, name in variants:
            p = os.path.join(RD, subject, f'{v}_{shot}.png')
            im = fit(Image.open(p).convert('RGB'), w=col_w) if os.path.exists(p) else Image.new('RGB', (col_w, col_w), (60, 0, 0))
            tiles.append(label(im, name, 26, row_names.get(shot)))
        h = max(t.height for t in tiles)
        row = Image.new('RGB', (len(tiles) * col_w + GAP * (len(tiles) - 1), h), BG)
        for i, t in enumerate(tiles):
            row.paste(t, (i * (col_w + GAP), 0))
        rows.append(row)
    return rows


LEGEND = ['A retail texture · B Real-ESRGAN x4 + local L3 maps (masks, normal, ORM) · C0 Meshy multiview 4K with Meshy\'s own maps',
          'C Meshy albedo + local L3 maps · D local SDXL + ControlNet-Tile (UV-safe) + local L3 maps.  Same mesh, UVs, camera and lights in every column.']


def sheet_armour():
    W = 5 * 468 + 4 * GAP
    rows = grid('armour', ['chest', 'chest_grazing', 'mid'], VARS, 468,
                {'chest': 'chest close-up, studio light', 'chest_grazing': 'grazing light (relief)',
                 'mid': 'full figure, game-camera distance'})
    s = stack([header(W, 'Bake-off: heavy_01 armour (BA chest, LA legs, FA boots) on the adventurer body', LEGEND)] + rows, W)
    s.save(os.path.join(BO, 'sheet_armour.png')); return s.size


def sheet_bodies():
    W = 5 * 468 + 4 * GAP
    rows = grid('body', ['face', 'face_grazing', 'torso', 'mid'], VARS, 468,
                {'face': 'face and hair, studio light', 'face_grazing': 'face, grazing light', 'torso': 'skin, talismans, shorts',
                 'mid': 'full body, game-camera distance'})
    s = stack([header(W, 'Bake-off: male adventurer body (skin, face) and hair', LEGEND)] + rows, W)
    s.save(os.path.join(BO, 'sheet_bodies.png')); return s.size


def sheet_sword():
    cols = [('sword', 1000, 'whole sword, studio light'), ('hilt', 640, 'guard and grip'), ('sword_grazing', 700, 'grazing light')]
    W = sum(c[1] for c in cols) + GAP * (len(cols) - 1)
    rows = []
    for v, name in VARS:
        tiles = []
        for shot, w, sub in cols:
            p = os.path.join(RD, 'sword', f'{v}_{shot}.png')
            im = fit(Image.open(p).convert('RGB'), w=w) if os.path.exists(p) else Image.new('RGB', (w, 300), (60, 0, 0))
            tiles.append(label(im, name, 26, sub))
        h = max(t.height for t in tiles)
        row = Image.new('RGB', (W, h), BG); x = 0
        for t, (_, w, _) in zip(tiles, cols):
            row.paste(t, (x, (h - t.height) // 2)); x += w + GAP
        rows.append(row)
    s = stack([header(W, 'Bake-off: starter sword (sword_01 on the shared sword1_2_3 atlas)', LEGEND)] + rows, W)
    s.save(os.path.join(BO, 'sheet_sword.png')); return s.size


def overview():
    four = [('A', 'A  original'), ('B', 'B  GAN + local maps'), ('C', 'C  Meshy + local maps'), ('D', 'D  local SDXL + local maps')]
    cw = 1150; tiles = []
    for v, name in four:
        chest = Image.open(os.path.join(RD, 'armour', f'{v}_chest.png')).convert('RGB')
        mid = Image.open(os.path.join(RD, 'armour', f'{v}_mid.png')).convert('RGB')
        c = fit(chest, h=720); m = fit(mid, h=720)
        t = Image.new('RGB', (cw, 720), BG); t.paste(c, (0, 0)); t.paste(m, (c.width + GAP, 0))
        tiles.append(label(t, name, 36))
    W = 2 * cw + GAP
    g = Image.new('RGB', (W, 2 * 720 + GAP), BG)
    for i, t in enumerate(tiles):
        g.paste(t, ((i % 2) * (cw + GAP), (i // 2) * (720 + GAP)))
    s = stack([header(W, 'Bake-off overview: chest close-up + full figure', [LEGEND[0].replace('C0 Meshy multiview 4K with Meshy\'s own maps', 'C Meshy albedo + local maps'), 'D local SDXL + ControlNet-Tile (UV-safe) + local L3 maps.'])] + [g], W)
    s.save(os.path.join(BO, 'overview.png')); return s.size


if __name__ == '__main__':
    for f in (sheet_armour, sheet_bodies, sheet_sword, overview):
        try:
            print(f.__name__, f())
        except Exception as e:
            print(f.__name__, 'FAILED', e)
