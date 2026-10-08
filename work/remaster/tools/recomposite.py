"""Re-run only the UV-safe composite + gates of sdxl_detail.py on a saved raw SDXL output with another colour-fix
radius (no GPU). Used when a result fails the absolute 28 dB fidelity floor although it is aligned: a smaller radius
takes everything at the source-texel scale from the retail texture and keeps only sub-texel detail from SDXL.
usage: python recomposite.py <part> <from_tag> <raw_sdxl.png> <new_tag> <cfix_texels>   (no face pass: armour/weapons)
"""
import json
import os
import shutil
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sdxl_detail as D  # noqa: E402

part, from_tag, raw, tag, cfix = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], float(sys.argv[5])
cfg_p = D.PARTS[part]
src_dir = os.path.join(D.OUTROOT, part, from_tag); work = os.path.join(D.OUTROOT, part, tag); os.makedirs(work, exist_ok=True)
old = json.load(open(os.path.join(src_dir, 'meta.json')))
shutil.copy(os.path.join(src_dir, 'gan_x4.png'), os.path.join(work, 'gan_x4.png'))
src_p = os.path.join(D.PACK, part, 'texture.png'); glb = os.path.join(D.PACK, part, 'model.glb')
glbs = [glb] + [os.path.join(D.OUT_GAME, g) for g in cfg_p.get('union', [])]
S = np.asarray(Image.open(src_p).convert('RGBA'), np.float32); h0, w0 = S.shape[:2]; alpha0 = S[..., 3]
W, H = old['size']; s = W / max(w0, h0) if w0 >= h0 else H / h0
gan = Image.open(os.path.join(work, 'gan_x4.png')).convert('RGB')
L1a = D.to_arr(D.lanczos(gan, (W, H)) if gan.size != (W, H) else gan)
sd = D.to_arr(D.lanczos(Image.open(raw).convert('RGB'), (W, H)))
tris = np.concatenate([D.mesh_tris(g, cfg_p['mat']) for g in glbs])
isl = D.raster(tris, W, H); pad = max(2, int(round(s))); isl_d = D.dilate(isl, pad)
Lz = D.to_arr(D.lanczos(Image.fromarray(S[..., :3].astype(np.uint8)), (W, H)))
r = cfix * s
fixed = np.clip(sd - D.gblur(sd, r) + D.gblur(Lz, r), 0, 255)
w = D.gblur(isl_d.astype(np.float32), pad / 2); w = np.maximum(w, isl.astype(np.float32)); w[w < 0.004] = 0
rgb = fixed * w[..., None] + L1a * (1 - w[..., None])
a = D.to_arr(D.lanczos(Image.fromarray(alpha0.astype(np.uint8)), (W, H)))
out_p = os.path.join(work, f'albedo_{max(W, H)}.png')
D.to_img(np.dstack([rgb, a]), 'RGBA').save(out_p)
gates = {}
u = gates['uvsafe'] = D.run_uvsafe(src_p, out_p, glbs, cfg_p['mat'], work, os.path.join(work, 'uv_overlay.png'))
gates['uvsafe_pass'] = bool(u['psnr_processed_vs_src'] >= 28.0 and u['psnr_processed_vs_src'] >= u['psnr_if_shifted_1_texel'] + 3.0)
k = 2
ref = D.lum(D.to_arr(D.lanczos(Image.fromarray(S[..., :3].astype(np.uint8)), (w0 * k, h0 * k))))
got = D.lum(D.to_arr(D.lanczos(D.to_img(rgb, 'RGB'), (w0 * k, h0 * k))))
m2 = np.asarray(Image.fromarray(isl.astype(np.uint8) * 255).resize((w0 * k, h0 * k), Image.NEAREST)) > 0
sh = D.block_shift(D.gblur(ref, 2.0), D.gblur(got, 2.0), m2, bs=64) / k
mag = np.hypot(sh[:, 0], sh[:, 1])
gates['shift_texels'] = dict(blocks=int(len(sh)), median=round(float(np.median(mag)), 3), p95=round(float(np.percentile(mag, 95)), 3),
                             max=round(float(mag.max()), 3), mean_dx=round(float(sh[:, 1].mean()), 3), mean_dy=round(float(sh[:, 0].mean()), 3))
gates['shift_pass'] = bool(gates['shift_texels']['median'] <= 0.1 and gates['shift_texels']['p95'] <= 0.25
                           and abs(gates['shift_texels']['mean_dx']) < 0.05 and abs(gates['shift_texels']['mean_dy']) < 0.05)
outside = ~D.dilate(isl_d, int(3 * pad) + 2)
gates['gutter_changed_px'] = int((np.abs(np.round(rgb) - np.round(L1a)).max(-1)[outside] > 0.5).sum()); gates['gutter_px'] = int(outside.sum())
gates['gutter_pass'] = gates['gutter_changed_px'] == 0
gates['pass'] = bool(gates['uvsafe_pass'] and gates['shift_pass'] and gates['gutter_pass'])
meta = dict(old, tag=tag, colour_fix_texels=cfix, recomposited_from=dict(tag=from_tag, raw=os.path.relpath(raw, D.ROOT)), gates=gates)
json.dump(meta, open(os.path.join(work, 'meta.json'), 'w'), indent=1)
print(json.dumps(dict(part=part, tag=tag, cfix=cfix, pass_=gates['pass'], psnr=u['psnr_processed_vs_src'], shift1=u['psnr_if_shifted_1_texel'],
                      shift=gates['shift_texels']['median'], gutter=gates['gutter_changed_px'])))
