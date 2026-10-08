"""Prepare every bake-off variant's maps (CPU only; run with ComfyUI stopped to leave RAM free).
  A  original: the pack texture.png (retail), no maps
  B  GAN x4 + local L3 maps
  C0 Meshy multiview: Meshy's own base_color / normal / metallic / roughness (4096 -> part size at 2K)
  C  Meshy base_color + local L3 maps generated from it
  D  local SDXL L2 albedo + local L3 maps
Writes work/tmp/detail/bakeoff/variants.json (consumed by the render step).
usage: python bakeoff_prep.py [part ...]
"""
import json
import os
import sys
import time

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
sys.path.insert(0, HERE)
import bakeoff_l3 as L3  # noqa: E402

BO = os.path.join(ROOT, 'work', 'tmp', 'detail', 'bakeoff')
PACK = os.path.join(ROOT, 'work', 'remaster', 'pack')
MESHY = os.path.join(ROOT, 'work', 'remaster', 'meshy')
PARTS = ['chinaman_adventurer_body', 'chinaman_adventurer_hair', 'ch_m_heavy_01_ba', 'ch_m_heavy_01_la',
         'ch_m_heavy_01_fa', 'ch_sword_01']
L2_TAG = {'ch_m_heavy_01_ba': 'main_cf05', 'ch_m_heavy_01_la': 'main_cf05', 'ch_m_heavy_01_fa': 'main_cf05',
          'ch_sword_01': 'main_cf05'}   # armour/weapon: d0.6 cn0.6 SDE, colour fix 0.5 texel (gate-passing); body/hair: main


def part_size(part, w=2048):
    src = Image.open(os.path.join(PACK, part, 'texture.png'))
    return w, int(round(w * src.height / src.width))


def meshy2k(part):
    d = os.path.join(BO, 'meshy2k', part); os.makedirs(d, exist_ok=True)
    W, H = part_size(part); out = {}
    for m in ('base_color', 'normal', 'metallic', 'roughness'):
        p = os.path.join(MESHY, part, 'multiview', m + '.png')
        q = os.path.join(d, m + '.png')
        if os.path.exists(p):
            if not os.path.exists(q):
                im = Image.open(p)
                im = im.convert('RGB') if m in ('base_color', 'normal') else im.convert('L')
                im.resize((W, H), Image.LANCZOS).save(q)
            out[m] = q
    return out


def l3_out(part, variant):
    return os.path.join(L3.L3, 'out', f'{part}__{variant}')


def maps_of(d):
    return dict(albedo=os.path.join(d, 'albedo.png'), normal=os.path.join(d, 'normal_gl.png'), orm=os.path.join(d, 'orm.png'))


def prep(part, timing):
    l2 = os.path.join(BO, 'l2', part, L2_TAG.get(part, 'main'))
    m2 = meshy2k(part)
    todo = {'B': os.path.join(l2, 'gan_x4.png'), 'C': m2['base_color'], 'D': os.path.join(l2, f'albedo_{max(part_size(part))}.png')}
    for v, alb in todo.items():
        if not os.path.exists(os.path.join(l3_out(part, v), 'orm.png')):
            t = time.time(); L3.run(part, v, alb); timing[f'{part}/{v}'] = round(time.time() - t, 1)
            print(part, v, timing[f'{part}/{v}'], 's', flush=True)
    return {
        'A': dict(albedo=os.path.join(PACK, part, 'texture.png')),
        'B': maps_of(l3_out(part, 'B')),
        'C0': dict(albedo=m2['base_color'], normal=m2.get('normal'), metallic=m2.get('metallic'), roughness=m2.get('roughness')),
        'C': maps_of(l3_out(part, 'C')),
        'D': maps_of(l3_out(part, 'D')),
    }


if __name__ == '__main__':
    parts = sys.argv[1:] or PARTS
    vj = os.path.join(BO, 'variants.json')
    allv = json.load(open(vj)) if os.path.exists(vj) else {}
    timing = {}
    for p in parts:
        allv[p] = prep(p, timing)
        json.dump(allv, open(vj, 'w'), indent=1)
    json.dump(timing, open(os.path.join(BO, 'l3', 'timing_%s.json' % time.strftime('%H%M%S')), 'w'), indent=1)
