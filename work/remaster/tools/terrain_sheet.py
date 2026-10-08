"""sheet_terrain.png: each bake-off terrain tile as a 3x3 repeat, original vs new, lit with the normal map
(the research's flat-plane GGX preview, work/tmp/detail/detailmaps/scripts/shade.py; same light for every panel).
Columns: original (retail, flat) | GAN x4 seamless + local maps | local SDXL seamless + local maps | zoom (1/4 tile).
usage: python terrain_sheet.py   (after sdxl_terrain.py; computes the L3 maps with terrain_l3.py if missing)
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, 'work', 'tmp', 'detail', 'detailmaps', 'scripts'))
import terrain_l3 as TL  # noqa: E402
from shade import shade  # noqa: E402
from make_sheets import label, header, font, BG, GAP  # noqa: E402

BO = os.path.join(ROOT, 'work', 'tmp', 'detail', 'bakeoff')
TILES = os.path.join(ROOT, 'work', 'out', 'world', 'jangan-fields', 'tiles')
ROWS = [('c_grass_hmfld_01', 'grass', 'c_grass_hmfld_01 (grass, 18% of the fields)'),
        ('c_dust_fld_01', 'dirt', 'c_dust_fld_01 (dirt road, 6% of Jangan town)'),
        ('c_stone_hmfld_01', 'rock', 'c_stone_hmfld_01 (field rock, 4% of the fields)')]
P = 590            # panel size
LIGHT = dict(key_az=135, key_el=28)


def load(p, size, mode='RGB'):
    return np.asarray(Image.open(p).convert(mode).resize((size, size), Image.LANCZOS), np.float64) / 255.0


def lit(alb, nrm=None, orm=None, rep=3, cell=None):
    """alb/nrm/orm as arrays at `cell` px per tile; returns the rep x rep repeat, shaded."""
    A = np.tile(alb, (rep, rep, 1))
    N = None if nrm is None else np.tile(nrm, (rep, rep, 1))
    if orm is None:
        R = np.full(A.shape[:2], 0.85); AO = None
    else:
        O = np.tile(orm, (rep, rep, 1)); AO = O[..., 0]; R = O[..., 1]
    img = shade(A, N, R, np.zeros(A.shape[:2]), AO, **LIGHT)
    return Image.fromarray((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8))


def dec_n(p, size):
    n = load(p, size) * 2 - 1
    return n / np.linalg.norm(n, axis=-1, keepdims=True)


def row(stem, kind, title):
    d = os.path.join(BO, 'terrain', stem)
    for name in ('gan_x4', 'albedo_2048'):
        md = os.path.join(d, 'maps_' + name)
        if not os.path.exists(os.path.join(md, 'orm.png')):
            TL.run(os.path.join(d, name + '.png'), kind, md)
    cell = P // 3
    src = load(os.path.join(TILES, stem + '.png'), cell)
    panels = [label(lit(src, cell=cell), 'original', 26, 'retail 512 px, 3x3, flat')]
    for name, lab, sub in (('gan_x4', 'GAN x4 + maps', 'seamless wrap, local L3 maps'),
                           ('albedo_2048', 'local SDXL + maps', 'seamless (half-offset inpaint), L3 maps')):
        md = os.path.join(d, 'maps_' + name)
        panels.append(label(lit(load(os.path.join(d, name + '.png'), cell), dec_n(os.path.join(md, 'normal_gl.png'), cell),
                                load(os.path.join(md, 'orm.png'), cell)), lab, 26, sub))
    # zoom: a quarter of the tile at full resolution, original (bicubic) vs SDXL + maps
    z = 1024
    zs = np.asarray(Image.open(os.path.join(TILES, stem + '.png')).convert('RGB').crop((0, 0, 256, 256)).resize((z, z), Image.BICUBIC), np.float64) / 255
    za = np.asarray(Image.open(os.path.join(d, 'albedo_2048.png')).convert('RGB').crop((0, 0, z, z)), np.float64) / 255
    md = os.path.join(d, 'maps_albedo_2048')
    zn = np.asarray(Image.open(os.path.join(md, 'normal_gl.png')).convert('RGB').crop((0, 0, z, z)), np.float64) / 255 * 2 - 1
    zo = np.asarray(Image.open(os.path.join(md, 'orm.png')).convert('RGB').crop((0, 0, z, z)), np.float64) / 255
    zo_img = Image.fromarray((np.clip(shade(zs, None, np.full((z, z), 0.85), None, None, **LIGHT), 0, 1) * 255).astype(np.uint8))
    zn_img = Image.fromarray((np.clip(shade(za, zn / np.linalg.norm(zn, axis=-1, keepdims=True), zo[..., 1], None, zo[..., 0], **LIGHT), 0, 1) * 255).astype(np.uint8))
    zh = (P - GAP) // 2
    zp = Image.new('RGB', (P, P), BG)
    zp.paste(label(zo_img.resize((P, zh), Image.LANCZOS) if False else zo_img.crop((0, 0, z, int(z * zh / P))).resize((P, zh), Image.LANCZOS), 'zoom: original', 22), (0, 0))
    zp.paste(label(zn_img.crop((0, 0, z, int(z * zh / P))).resize((P, zh), Image.LANCZOS), 'zoom: local SDXL + maps', 22), (0, zh + GAP))
    panels.append(zp)
    W = 4 * P + 3 * GAP
    r = Image.new('RGB', (W, P + 40), BG); dr = ImageDraw.Draw(r)
    dr.text((8, 6), title, fill=(255, 255, 255), font=font(26))
    for i, p in enumerate(panels):
        r.paste(p, (i * (P + GAP), 40))
    m = json.load(open(os.path.join(d, 'meta.json')))
    return r, m


if __name__ == '__main__':
    rows, metas = [], []
    for stem, kind, title in ROWS:
        r, m = row(stem, kind, title); rows.append(r); metas.append(m)
    W = rows[0].width
    lines = ['Same flat-plane GGX preview and light for every panel (research shade.py). New tiles: GAN x4 with wrap padding, colour-locked to the',
             'source; SDXL + ControlNet-Tile; half-offset seam repair (SDXL re-generates 1024 px crops along the rolled seam cross, only the band is kept);',
             'colour lock again. Seam ratio = edge vs interior gradient, 1 = invisible:']
    lines.append('   ' + '   '.join(f"{m['stem']}: source {m['seam_ratio_uv']['source']}  new {m['seam_ratio_uv']['final']}" for m in metas))
    H = header(W, 'Bake-off: Jangan terrain tiles, 3x3 repeats', lines)
    out = Image.new('RGB', (W, H.height + sum(r.height + GAP for r in rows)), BG)
    out.paste(H, (0, 0)); y = H.height + GAP
    for r in rows:
        out.paste(r, (0, y)); y += r.height + GAP
    out.save(os.path.join(BO, 'sheet_terrain.png')); print(out.size)
