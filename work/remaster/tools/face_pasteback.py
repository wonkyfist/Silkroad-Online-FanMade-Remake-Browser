"""Face paste-back for Meshy body albedos (the user's decision 2026-09-29: Meshy bodies keep the LOCAL face).

Meshy multiview repaints faces (a different eye, eye-band pattern, an ear painted into the face; bake-off REPORT §4),
so the face island(s) of the Meshy base colour are replaced with the local result, on the game UVs:
  * face region = the triangles of the body glb's `*_face` mesh whose UV centroid has u >= 0.45 (the bake-off's
    sdxl_detail.py rule: face, scalp, ear and the head extras; the small neck islands at u < 0.45 stay Meshy's so the
    neck meets the torso without a colour step);
  * the local albedo is the bake-off's SDXL (variant D) where one exists, else the TP-U/TP-P master albedo
    (work/texpipe/master/.../<part>/albedo.png);
  * the seam is feathered INSIDE the face island: weight = blur(erode(mask, r), r/2) * mask, so every texel outside the
    face islands (and the island's outermost ring) is Meshy's, bit for bit.
Gates, recorded in meta.json:
  * face PSNR against the retail texture, the bake-off's method (face mask at retail size, alpha > 0, eroded 1 texel;
    result box-downsampled to retail size); also reported for the raw Meshy and the local albedo;
  * outside the feathered face: changed pixels vs Meshy (must be 0);
  * detail kept: mean |Laplacian| of the body islands (face excluded) for Meshy, local and the result.

usage (repo root, system Python 3.12, numpy + PIL):
  python work/remaster/tools/face_pasteback.py <part> [--meshy base_color.png] [--local albedo.png] [--out dir]
      [--feather 1.5]   (feather radius in retail texels)
Default output: work/remaster/staging/<part>/multiview/{albedo.png,face_weight.png,preview.png,meta.json}
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'work', 'tmp', 'detail', 'stack'))
import uvsafe as U  # noqa: E402

PACK = os.path.join(ROOT, 'work', 'remaster', 'pack')
MESHY = os.path.join(ROOT, 'work', 'remaster', 'meshy')
STAGING = os.path.join(ROOT, 'work', 'remaster', 'staging')
VARIANTS = os.path.join(ROOT, 'work', 'tmp', 'detail', 'bakeoff', 'variants.json')
MASTER = os.path.join(ROOT, 'work', 'texpipe', 'master', 'prim', 'mtrl', 'char', 'china')
U_MIN = 0.45


# ---------------------------------------------------------------- helpers
def gblur(a, sigma):
    if sigma <= 0:
        return a.astype(np.float32)
    p = int(3 * sigma) + 2
    ap = np.pad(a.astype(np.float32), p, mode='reflect')
    fy = np.fft.fftfreq(ap.shape[0])[:, None]; fx = np.fft.rfftfreq(ap.shape[1])[None, :]
    g = np.exp(-2 * np.pi ** 2 * sigma ** 2 * (fy ** 2 + fx ** 2)).astype(np.float32)
    return np.fft.irfft2(np.fft.rfft2(ap) * g, s=ap.shape)[p:-p, p:-p].astype(np.float32)


def morph(mask, r, grow):
    if r <= 0:
        return mask
    f = ImageFilter.MaxFilter if grow else ImageFilter.MinFilter
    img = Image.fromarray(mask.astype(np.uint8) * 255)
    while r > 0:                      # PIL caps the kernel size; chain small ones
        k = min(r, 12); img = img.filter(f(2 * k + 1)); r -= k
    return np.asarray(img) > 0


def raster(tris, W, H):
    m = Image.new('L', (W, H), 0); d = ImageDraw.Draw(m)
    for t in tris:
        d.polygon([(float(u) * W, float(v) * H) for u, v in t], fill=255)   # glTF UV: v = 0 at the top
    return np.asarray(m) > 0


def body_tris(glb):
    """(face triangles with centroid u >= U_MIN, all other triangles) of the pack glb, as (N,3,2) UV arrays."""
    j, blob = U.read_glb(glb)
    face, rest = [], []
    for mesh in j['meshes']:
        is_face = mesh.get('name', '').lower().endswith('_face')
        for p in mesh['primitives']:
            uv = U.accessor(j, blob, p['attributes']['TEXCOORD_0'])[:, :2]
            idx = U.accessor(j, blob, p['indices'])[:, 0] if 'indices' in p else np.arange(len(uv))
            tris = uv[idx.reshape(-1, 3)]
            if is_face:
                sel = tris[:, :, 0].mean(1) >= U_MIN
                face.append(tris[sel]); rest.append(tris[~sel])
            else:
                rest.append(tris)
    if not face:
        raise SystemExit(f'{glb}: no *_face mesh')
    return np.concatenate(face), np.concatenate(rest)


def lap_energy(a, m):
    g = a.mean(-1)
    l = np.abs(4 * g[1:-1, 1:-1] - g[:-2, 1:-1] - g[2:, 1:-1] - g[1:-1, :-2] - g[1:-1, 2:])
    return float(l[m[1:-1, 1:-1]].mean())


def psnr(a, b, m):
    e = float(((a - b) ** 2)[m].mean())
    return round(10 * np.log10(255 ** 2 / max(e, 1e-9)), 2)


def default_local(part):
    """The bake-off's SDXL (D) albedo when there is one, else the TP-U/TP-P master albedo."""
    if os.path.exists(VARIANTS):
        v = json.load(open(VARIANTS)).get(part, {}).get('D', {}).get('albedo')
        if v and os.path.exists(v):
            return v, 'sdxl-D'
    sex = 'woman' if part.startswith('chinawoman') else 'man'
    p = os.path.join(MASTER, sex, part, 'albedo.png')
    if os.path.exists(p):
        return p, 'tp-master'
    raise SystemExit(f'{part}: no local albedo (bake-off D or {p})')


# ---------------------------------------------------------------- main
def pasteback(part, meshy_p=None, local_p=None, out_dir=None, feather=1.5):
    meshy_p = meshy_p or os.path.join(MESHY, part, 'multiview', 'base_color.png')
    local_src = 'given'
    if not local_p:
        local_p, local_src = default_local(part)
    out_dir = out_dir or os.path.join(STAGING, part, 'multiview')
    os.makedirs(out_dir, exist_ok=True)

    retail = Image.open(os.path.join(PACK, part, 'texture.png')).convert('RGBA')
    w0, h0 = retail.size
    R = np.asarray(retail, np.float32)
    meshy = Image.open(meshy_p).convert('RGB'); W, H = meshy.size
    M = np.asarray(meshy, np.float32)
    local = Image.open(local_p).convert('RGB')
    Lc = np.asarray(local.resize((W, H), Image.LANCZOS) if local.size != (W, H) else local, np.float32)

    face_t, rest_t = body_tris(os.path.join(PACK, part, 'model.glb'))
    fm = raster(face_t, W, H)
    tex = W / w0                                          # output px per retail texel (u axis)
    r = max(1, int(round(feather * tex)))
    w = gblur(morph(fm, r, grow=False).astype(np.float32), r / 2) * fm
    w = np.clip(w, 0, 1); w[w < 1 / 512] = 0
    out = np.clip(np.round(M * (1 - w[..., None]) + Lc * w[..., None]), 0, 255).astype(np.uint8)
    Image.fromarray(out, 'RGB').save(os.path.join(out_dir, 'albedo.png'))
    Image.fromarray((w * 255).astype(np.uint8), 'L').save(os.path.join(out_dir, 'face_weight.png'))

    # ---- gates -----------------------------------------------------------------------------------------------
    # face PSNR vs retail, the bake-off's method (sdxl_detail.py)
    fm_src = raster(face_t, w0, h0) & (R[..., 3] > 0)
    fm_src = morph(fm_src, 1, grow=False)

    def face_psnr(img):
        d = np.asarray(Image.fromarray(img.astype(np.uint8)).resize((w0, h0), Image.BOX), np.float32)
        return psnr(d, R[..., :3], fm_src)
    outside = w == 0
    changed = int((np.abs(out.astype(np.int16) - M.astype(np.int16)).max(-1)[outside] > 0).sum())
    body = raster(rest_t, W, H) & ~morph(fm, 2, grow=True)
    body = morph(body, 2, grow=False)                     # island interiors only (no gutter texels)
    ring = fm & (w > 0) & (w < 1)
    ring_de = float(np.abs(M[ring] - Lc[ring]).mean()) if ring.any() else 0.0
    gates = dict(
        face_psnr_vs_retail=dict(result=face_psnr(out.astype(np.float32)), local=face_psnr(Lc), meshy=face_psnr(M)),
        outside_face_changed_px=changed, outside_face_px=int(outside.sum()),
        body_detail_lap=dict(meshy=round(lap_energy(M, body), 3), local=round(lap_energy(Lc, body), 3),
                             result=round(lap_energy(out.astype(np.float32), body), 3)),
        body_psnr_result_vs_meshy=psnr(out.astype(np.float32), M, body) if body.any() else None,
        seam_ring_mean_abs_rgb_meshy_vs_local=round(ring_de, 2),
        face_px=int(fm.sum()), full_weight_px=int((w >= 0.999).sum()), feather_px=r)
    g = gates['face_psnr_vs_retail']
    gates['pass'] = bool(changed == 0 and g['result'] >= g['meshy'] + 3 and g['result'] >= 28.0)

    # ---- preview: face crop  meshy | local | result | weight ----------------------------------------------------
    ys, xs = np.nonzero(fm)
    box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    tiles = [Image.fromarray(M.astype(np.uint8)), Image.fromarray(Lc.astype(np.uint8)), Image.fromarray(out),
             Image.fromarray((w * 255).astype(np.uint8)).convert('RGB')]
    cw = 600; chh = int(cw * (box[3] - box[1]) / (box[2] - box[0]))
    prev = Image.new('RGB', (cw * 4, chh + 28), (24, 24, 28)); d = ImageDraw.Draw(prev)
    for i, (t, lab) in enumerate(zip(tiles, ['Meshy', f'local ({local_src})', 'result', 'face weight'])):
        prev.paste(t.crop(box).resize((cw, chh), Image.LANCZOS), (i * cw, 28))
        d.text((i * cw + 8, 8), lab, fill=(240, 240, 240))
    prev.save(os.path.join(out_dir, 'preview.png'))

    meta = dict(part=part, meshy=os.path.relpath(meshy_p, ROOT), local=os.path.relpath(local_p, ROOT), local_source=local_src,
                size=[W, H], retail_size=[w0, h0], u_min=U_MIN, feather_texels=feather, gates=gates)
    json.dump(meta, open(os.path.join(out_dir, 'meta.json'), 'w'), indent=1)
    return meta


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('part')
    ap.add_argument('--meshy'); ap.add_argument('--local'); ap.add_argument('--out')
    ap.add_argument('--feather', type=float, default=1.5)
    a = ap.parse_args()
    m = pasteback(a.part, a.meshy, a.local, a.out, a.feather)
    print(json.dumps(dict(part=m['part'], local=m['local_source'], gates=m['gates'])))
