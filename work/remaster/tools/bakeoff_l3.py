"""L3 maps (material masks -> normal / ORM / height, DETAIL.md §2 L3) for the bake-off variants, by reusing the
research code in work/tmp/detail/detailmaps/scripts/build.py unchanged. Masks always come from the retail texture;
only the albedo input differs per variant:
  B = GAN x4 (realesrgan-x4plus) of the retail texture          (what the research built)
  C = Meshy multiview base_color (4096 square -> part size)      (Meshy albedo + local maps)
  D = local SDXL L2 albedo (sdxl_detail.py output)
Outputs: work/tmp/detail/bakeoff/l3/out/<part>__<variant>/{albedo,normal_gl,orm,height,mask_classes}.png
usage: python bakeoff_l3.py <part> <variant> <albedo.png>     (system Python; numpy + PIL only)
"""
import json
import os
import shutil
import sys
import time

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
DM = os.path.join(ROOT, 'work', 'tmp', 'detail', 'detailmaps')
sys.path.insert(0, os.path.join(DM, 'scripts'))
import build as B  # noqa: E402

L3 = os.path.join(ROOT, 'work', 'tmp', 'detail', 'bakeoff', 'l3')
PACK = os.path.join(ROOT, 'work', 'remaster', 'pack')
DEF_T = {'cloth': 8, 'leather': 6, 'metal': 5, 'gold': 5, 'skin': 6, 'hair': 5}   # make_report.py defaults
ARMOUR = dict(allowed=['cloth', 'leather', 'gold', 'metal'], tiling=dict(DEF_T, leather=6))
CFG = {   # from make_report.py CFGS where the research had one; the sword gets DETAIL.md's "cut ~50%" fix
    # human mask fix (DETAIL.md: "the talisman is marked gold"): k-means cluster 7 = the paper talismans -> cloth
    'chinaman_adventurer_body': dict(allowed=['skin', 'hair', 'cloth', 'gold', 'leather'], olive='cloth',
                                     tiling=dict(DEF_T, skin=28, cloth=12, hair=6), overrides={7: 'cloth'}),
    'chinaman_adventurer_hair': dict(allowed=['hair'], overrides={j: 'hair' for j in range(10)}, tiling=dict(DEF_T)),
    'ch_m_heavy_01_ba': ARMOUR, 'ch_m_heavy_01_la': ARMOUR, 'ch_m_heavy_01_fa': ARMOUR,
    'ch_sword_01': dict(allowed=['metal', 'gold', 'leather', 'cloth'], tiling=dict(DEF_T, metal=4, gold=5),
                        amp={'metal': 0.5, 'gold': 0.5}),
}
# w9b Meshy "Cloth test + bodies" (stage_meshy.py): the other five bodies take the adventurer's settings without its
# talisman cluster override (cluster ids differ per texture); the six cloth parts take the armour settings.
HUMAN = dict(allowed=['skin', 'hair', 'cloth', 'gold', 'leather'], olive='cloth', tiling=dict(DEF_T, skin=28, cloth=12, hair=6))
for _p in ('chinaman_bogy_body', 'chinaman_fighter_body', 'chinawoman_adventurer_body', 'chinawoman_assassin_body',
           'chinawoman_bogy_body'):
    CFG[_p] = HUMAN
for _p in ('ch_m_clothes_01_ba', 'ch_w_clothes_01_ba', 'ch_m_light_01_ba', 'ch_w_light_01_ba', 'ch_m_clothes_01_la',
           'ch_w_light_01_la'):
    CFG[_p] = ARMOUR


def setup():
    """build.py reads ROOT/src, ROOT/up and ROOT/detail; point it at a bake-off folder (detail tiles copied)."""
    for d in ('src', 'up', 'detail', 'out'):
        os.makedirs(os.path.join(L3, d), exist_ok=True)
    for f in os.listdir(os.path.join(DM, 'detail')):
        if f.endswith('.npz') and not os.path.exists(os.path.join(L3, 'detail', f)):
            shutil.copy(os.path.join(DM, 'detail', f), os.path.join(L3, 'detail', f))
    B.ROOT = L3
    B.shade = lambda *a, **k: None          # the flat-plane previews are not needed here (saves time and RAM)


def run(part, variant, albedo_path, work_w=2048):
    setup()
    name = f'{part}__{variant}'
    shutil.copy(os.path.join(PACK, part, 'texture.png'), os.path.join(L3, 'src', name + '.png'))
    src = Image.open(os.path.join(PACK, part, 'texture.png'))
    W = work_w; H = int(round(W * src.height / src.width))
    Image.open(albedo_path).convert('RGB').resize((W, H), Image.LANCZOS).save(os.path.join(L3, 'up', name + '_x4.png'))
    cfg = dict(CFG[part], name=name, src=name + '.png', work_w=W)
    t = time.time()
    R = B.run(cfg)
    meta = dict(part=part, variant=variant, albedo_in=os.path.relpath(albedo_path, ROOT), size=[W, H],
                seconds=round(time.time() - t, 1), clusters=R['names'])
    json.dump(meta, open(os.path.join(R['od'], 'bakeoff.json'), 'w'), indent=1)
    return meta


if __name__ == '__main__':
    print(json.dumps(run(sys.argv[1], sys.argv[2], sys.argv[3])))
