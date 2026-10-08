"""Stage the w9b Meshy "Cloth test + bodies (120)" results for review (NOT the live runtime manifest).

For each selected part with a finished Meshy multiview result (ledger SUCCEEDED + downloaded):
  * bodies: the face island(s) are pasted back from the local result (face_pasteback.py), variant tag CF;
  * cloth:  Meshy's base colour as is, variant tag C;
  * local L3 maps (normal / ORM) are derived from that albedo (bakeoff_l3.py: masks from the retail texture), as the
    bake-off's variant C: never Meshy's own nearly flat maps (REPORT §1);
  * WebP maps go to work/out/remaster/staging/<part>/multiview/ and one entry per install key goes to
    work/out/remaster/staging.json (same sro-remaster format as manifest.json; map paths relative to it).
Parts without a result yet are listed as pending. Also writes work/tmp/w9b-meshy/plan.json (selection + reasons).

usage (repo root, system Python 3.12): python work/remaster/tools/stage_meshy.py [--size 2048]
"""
import json
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
sys.path.insert(0, HERE)
import bakeoff_l3  # noqa: E402
import face_pasteback as FP  # noqa: E402

PACK_MANIFEST = os.path.join(ROOT, 'work', 'remaster', 'pack', 'manifest.json')
MESHY = os.path.join(ROOT, 'work', 'remaster', 'meshy')
OUT = os.path.join(ROOT, 'work', 'out', 'remaster')
STAGE_OUT = os.path.join(OUT, 'staging')
L3OUT = os.path.join(ROOT, 'work', 'tmp', 'detail', 'bakeoff', 'l3', 'out')
REVIEW = os.path.join(ROOT, 'work', 'tmp', 'w9b-meshy')

CAP_CREDITS = 120        # the user's "Cloth test + bodies (120)": 12 parts x 10 credits, the reused body included
CLOTH = {
    'ch_m_clothes_01_ba': 'male starter garment chest: all-over fish-scale (seigaiha) brocade, green piping and frog '
                          'buttons; the creation screen default outfit',
    'ch_w_clothes_01_ba': 'female starter garment dress: same scale brocade over a long panel, blue lattice trim at '
                          'hem and collar; the largest patterned area of any degree-1 female part',
    'ch_m_light_01_ba': 'male protector chest: highest detail score of the degree-1 chest/legs set (mean |Laplacian| '
                        '52.1): quilted leather, blue sash with stitching, riveted band, bronze rim',
    'ch_w_light_01_ba': 'female protector chest: gold-trimmed leather wrap with blue embroidered bands (saturation '
                        '57.6, the highest of degree-1 chest/legs)',
    'ch_m_clothes_01_la': 'male starter garment trousers: scale brocade on the widest texture island, green piping '
                          'and drawstring; pairs with ch_m_clothes_01_ba for a full male outfit',
    'ch_w_light_01_la': 'female protector tasset: gold scalloped trim, teal panel, rivet rows (saturation 50.8); the '
                        'female legs counterpart',
}
BODIES = ['chinaman_adventurer_body', 'chinaman_bogy_body', 'chinaman_fighter_body', 'chinawoman_adventurer_body',
          'chinawoman_assassin_body', 'chinawoman_bogy_body']
NOT_CHOSEN = {
    '*_01_fa / *_01_ha / *_01_aa / *_01_sa': 'small parts (128 px sources; gloves fill ~10% of a view); feet and hats '
                                             'show little pattern at game distance',
    'heavy_01 (female)': 'metal armour: the bake-off tied C and D there, so no cloth test value',
    '*_02_* / *_03_*': 'degree 2/3 (levels 8-20): outside the starter/degree-1 test, judged after this batch',
    '*_hair': 'skipped by the user decision (Meshy smears hair; local wins)',
}


def ledger_done():
    led = json.load(open(os.path.join(MESHY, 'ledger.json'), encoding='utf-8'))
    return {a['part']: a for a in led['attempts'] if a['variant'] == 'multiview' and a['status'] == 'SUCCEEDED'
            and a.get('downloaded')}


def webp(img, path, size, colour):
    img = img.convert('RGB')
    if img.width > size:
        img = img.resize((size, max(1, size * img.height // img.width)), Image.LANCZOS)
    img.save(path, 'WEBP', quality=92 if colour else 95, method=6)


def write_plan():
    os.makedirs(REVIEW, exist_ok=True)
    ids = list(CLOTH) + BODIES
    plan = dict(
        decision='work/tmp/w9-user-decisions.md, bake-off decisions 2026-09-29: Meshy "Cloth test + bodies (120)"',
        cloth=[dict(id=k, why=v) for k, v in CLOTH.items()], bodies=BODIES,
        reused={'chinaman_adventurer_body': 'already in the ledger (first test batch): no new credits'},
        not_chosen=NOT_CHOSEN, new_jobs=len(ids) - 1, new_credits=(len(ids) - 1) * 10,
        cap_note='--cap is over the whole ledger (70 already booked) and checks ledger + 15 (worst case) before each '
                 'POST, so 11 new jobs at 10 credits need --cap 185 (70 + 110 + 5); --cap 120 would stop after 3',
        command=('pnpm tsx packages/convert/src/tools/meshy-retexture.ts run --variant multiview --resolution 4k '
                 f'--cap 185 --only {",".join(ids)}'))
    json.dump(plan, open(os.path.join(REVIEW, 'plan.json'), 'w', encoding='utf-8'), indent=1)
    return ids


def main(argv):
    size = int(argv[argv.index('--size') + 1]) if '--size' in argv else 2048
    ids = write_plan()
    pack = {p['id']: p for p in json.load(open(PACK_MANIFEST, encoding='utf-8'))['parts']}
    done = ledger_done()
    textures, report = {}, {}
    for pid in ids:
        if pid not in done:
            report[pid] = dict(status='pending', note='no finished Meshy multiview result in the ledger')
            print(f'{pid}: pending')
            continue
        uv = (done[pid].get('uvCheck') or {}).get('verdict')
        body = pid in BODIES
        if body:
            meta = FP.pasteback(pid)
            albedo_p = os.path.join(FP.STAGING, pid, 'multiview', 'albedo.png'); tag = 'CF'
        else:
            meta = None
            albedo_p = os.path.join(MESHY, pid, 'multiview', 'base_color.png'); tag = 'C'
        bakeoff_l3.run(pid, tag, albedo_p)
        l3 = os.path.join(L3OUT, f'{pid}__{tag}')
        dst = os.path.join(STAGE_OUT, pid, 'multiview'); os.makedirs(dst, exist_ok=True)
        webp(Image.open(albedo_p), os.path.join(dst, 'albedo.webp'), size, True)
        webp(Image.open(os.path.join(l3, 'normal_gl.png')), os.path.join(dst, 'normal.webp'), size, False)
        orm = np.asarray(Image.open(os.path.join(l3, 'orm.png')).convert('RGB'))
        webp(Image.fromarray(orm[..., 2]).convert('RGB'), os.path.join(dst, 'metallic.webp'), size, False)
        webp(Image.fromarray(orm[..., 1]).convert('RGB'), os.path.join(dst, 'roughness.webp'), size, False)
        rel = f'staging/{pid}/multiview'
        entry = dict(albedo=f'{rel}/albedo.webp', normal=f'{rel}/normal.webp', metallic=f'{rel}/metallic.webp',
                     roughness=f'{rel}/roughness.webp', normalGreen='gl', alpha='original')
        p = pack[pid]
        keys = p.get('installKeys') or [p['game']['glb'].split('/out/', 1)[1][:-len('.glb')] + '#' + p['game']['material']['imageName']]
        for k in keys:
            textures[k] = entry
        report[pid] = dict(status='staged', uv_check=uv, variant=tag, keys=keys, l3=os.path.relpath(l3, ROOT),
                           face=meta['gates'] if meta else None)
        print(f'{pid}: staged ({tag}, uv {uv}) -> {", ".join(keys)}')
    manifest = {'format': 'sro-remaster', 'version': 1,
                '$note': 'REVIEW STAGING, not loaded by the game. Meshy multiview albedo (bodies: local face pasted '
                         'back) + local L3 maps. Promote entries into manifest.json only after review.',
                'textures': textures}
    json.dump(manifest, open(os.path.join(OUT, 'staging.json'), 'w', encoding='utf-8'), indent=1)
    json.dump(report, open(os.path.join(REVIEW, 'staging_report.json'), 'w', encoding='utf-8'), indent=1)
    print(f'{len(textures)} staged entr(ies) in work/out/remaster/staging.json; '
          f'{sum(r["status"] == "pending" for r in report.values())} part(s) pending')


if __name__ == '__main__':
    main(sys.argv[1:])
