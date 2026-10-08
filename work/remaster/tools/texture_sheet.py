"""sheet_texture_crops.png: 1:1 crops of each part's 2K albedo in texture space (before the L3 maps), so the albedo
routes can be compared directly: A retail (bicubic 8x/4x), B GAN x4, C Meshy multiview base colour, D local SDXL."""
import json
import os
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from make_sheets import label, header, font, BG, GAP  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
BO = os.path.join(ROOT, 'work', 'tmp', 'detail', 'bakeoff')
PACK = os.path.join(ROOT, 'work', 'remaster', 'pack')
V = json.load(open(os.path.join(BO, 'variants.json')))
L2 = {'ch_m_heavy_01_ba': 'main_cf05', 'ch_m_heavy_01_la': 'main_cf05', 'ch_m_heavy_01_fa': 'main_cf05', 'ch_sword_01': 'main_cf05'}
ROWS = [('chinaman_adventurer_body', (1150, 40, 1650, 440), 'body: face (face pass at denoise 0.18)'),
        ('chinaman_adventurer_body', (40, 780, 540, 1020), 'body: loincloth embroidery'),
        ('chinaman_adventurer_hair', (500, 100, 1000, 500), 'hair'),
        ('ch_m_heavy_01_ba', (1150, 350, 1650, 750), 'heavy_01_ba: iron band, clasp, leather'),
        ('ch_m_heavy_01_la', (500, 700, 1000, 1100), 'heavy_01_la: riveted leather plates'),
        ('ch_sword_01', (1200, 1250, 1700, 1650), 'sword1_2_3 atlas: guard (sword_03 island; Meshy only baked sword_01)')]
CW = 560


def crops(part, box):
    W = 2048; src = Image.open(os.path.join(PACK, part, 'texture.png')).convert('RGB')
    H = int(round(W * src.height / src.width))
    a = src.resize((W, H), Image.BICUBIC)
    b = Image.open(os.path.join(BO, 'l2', part, L2.get(part, 'main'), 'gan_x4.png')).convert('RGB').resize((W, H), Image.LANCZOS)
    c = Image.open(V[part]['C0']['albedo']).convert('RGB').resize((W, H), Image.LANCZOS)
    d = Image.open(os.path.join(BO, 'l2', part, L2.get(part, 'main'), 'albedo_2048.png')).convert('RGB')
    h = int(CW * (box[3] - box[1]) / (box[2] - box[0]))
    return [im.crop(box).resize((CW, h), Image.LANCZOS) for im in (a, b, c, d)]


names = ['A  retail (bicubic)', 'B  GAN x4', 'C  Meshy base colour', 'D  local SDXL (UV-safe)']
W = 4 * CW + 3 * GAP
rows = []
for part, box, title in ROWS:
    cs = crops(part, box)
    r = Image.new('RGB', (W, cs[0].height + 34), BG); d = ImageDraw.Draw(r)
    d.text((8, 4), title, fill=(255, 255, 255), font=font(24))
    for i, (im, n) in enumerate(zip(cs, names)):
        r.paste(label(im, n, 22), (i * (CW + GAP), 34))
    rows.append(r)
H = header(W, 'Bake-off: albedo in texture space, 1:1 crops of the 2K maps (no lighting, no L3 maps)',
           ['Same UV region in every column. A = what the game has now, upscaled; D passed the uvsafe gate (see REPORT.md).'])
out = Image.new('RGB', (W, H.height + sum(r.height + GAP for r in rows)), BG); out.paste(H, (0, 0)); y = H.height + GAP
for r in rows:
    out.paste(r, (0, y)); y += r.height + GAP
out.save(os.path.join(BO, 'sheet_texture_crops.png')); print(out.size)
