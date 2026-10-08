"""uvsafe.py fidelity gate for every bake-off albedo route (B GAN, C Meshy, D SDXL) on the 6 parts.
Pass rule (DETAIL.md §2): PSNR inside the islands >= 28 dB and >= 3 dB above the 1-texel-shift reference."""
import json, os, subprocess, sys
from PIL import Image
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..'))
BO = os.path.join(ROOT, 'work', 'tmp', 'detail', 'bakeoff'); PACK = os.path.join(ROOT, 'work', 'remaster', 'pack')
PY = r'C:\Users\Pixi\AppData\Local\Programs\Python\Python312\python.exe'
V = json.load(open(os.path.join(BO, 'variants.json')))
L2 = {'ch_m_heavy_01_ba': 'main_cf05', 'ch_m_heavy_01_la': 'main_cf05', 'ch_m_heavy_01_fa': 'main_cf05', 'ch_sword_01': 'main_cf05'}
MAT = {'chinaman_adventurer_body': 'chinaman_adventurer_body', 'chinaman_adventurer_hair': 'chinaman_adventurer_hair',
       'ch_m_heavy_01_ba': 'heavy_01_ba', 'ch_m_heavy_01_la': 'heavy_01_la', 'ch_m_heavy_01_fa': 'heavy_01_fa', 'ch_sword_01': 'sword1_2_3'}
tmp = os.path.join(BO, '_work', 'gate'); os.makedirs(tmp, exist_ok=True)
res = {}
for part, mat in MAT.items():
    src = os.path.join(PACK, part, 'texture.png'); s = Image.open(src); W = 2048; H = int(round(W * s.height / s.width))
    glb = os.path.join(PACK, part, 'model.glb')
    globs = {'own islands': [glb]}
    if part == 'ch_sword_01':
        globs['union sword_01/02/03'] = [glb] + [os.path.join(ROOT, 'work', 'out', 'equipment', 'china', 'weapon', f'sword_0{i}.glb') for i in (2, 3)]
    l2 = os.path.join(BO, 'l2', part, L2.get(part, 'main'))
    routes = {'B GAN x4': os.path.join(l2, 'gan_x4.png'), 'C Meshy': V[part]['C0']['albedo'], 'D SDXL': os.path.join(l2, 'albedo_2048.png')}
    for rname, p in routes.items():
        q = os.path.join(tmp, f'{part}_{rname[0]}.png')
        Image.open(p).convert('RGB').resize((W, H), Image.LANCZOS).save(q)
        for gname, gl in globs.items():
            r = subprocess.run([PY, os.path.join(ROOT, 'work', 'tmp', 'detail', 'stack', 'uvsafe.py'), src, q, ','.join(gl), mat,
                                os.path.join(tmp, '_o.png')], capture_output=True, text=True, check=True)
            u = json.loads(r.stdout.strip().splitlines()[-1])
            ok = u['psnr_processed_vs_src'] >= 28 and u['psnr_processed_vs_src'] >= u['psnr_if_shifted_1_texel'] + 3
            res[f'{part} | {rname} | {gname}'] = dict(psnr=u['psnr_processed_vs_src'], shift1=u['psnr_if_shifted_1_texel'],
                                                     lanczos=u['psnr_lanczos_vs_src'], coverage=u['island_coverage_%'], pass_=ok)
            print(f'{part:26s} {rname:9s} {gname:22s} PSNR {u["psnr_processed_vs_src"]:5.2f}  shift-1 {u["psnr_if_shifted_1_texel"]:5.2f}  {"PASS" if ok else "fail"}', flush=True)
json.dump(res, open(os.path.join(BO, 'uvsafe_all_routes.json'), 'w'), indent=1)
