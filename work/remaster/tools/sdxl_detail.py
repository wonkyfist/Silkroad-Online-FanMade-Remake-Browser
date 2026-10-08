"""L2 local detail pass (DETAIL.md §2 L2): original texture -> GAN 4x (L1) -> SDXL + ControlNet-Tile through
UltimateSDUpscale (ComfyUI HTTP API, 127.0.0.1:8188) -> UV-safe composite -> gates.

UV safety (the user's main concern):
  * the SDXL result is used ONLY inside the UV islands of every glb that uses the texture (union; shared atlases
    such as sword1_2_3 keep other models' islands), dilated by ~1 source texel;
  * everywhere else the output is the L1 (GAN) upscale of the ORIGINAL pixels, i.e. the original gutter/bleed
    content, bit-identical to what variant B uses;
  * colour fix: low frequencies (sigma = 2 source texels) come from a Lanczos upscale of the original, only the
    finer detail comes from SDXL, so nothing can drift by a texel or change colour;
  * gates, recorded in meta.json: uvsafe.py (PSNR inside islands vs the source and vs a 1-texel-shift reference),
    a block phase-correlation shift/warp check, an unchanged-gutter check and, for faces, a face-region PSNR.
Faces: a second pass over the face crop at a much lower denoise, feathered in over the face islands.
Cut-out alpha (body, hair): the original alpha, upscaled (and re-thresholded when it is binary).
Spec-mask alpha (armour, weapons): the original alpha, upscaled; it is a metal mask, never cut out.

usage (repo root):
  work/tools/comfyui/venv/Scripts/python.exe work/remaster/tools/sdxl_detail.py <part> [--target 2048] [--denoise D]
      [--face-denoise D] [--seed N] [--steps N] [--gan realesrgan-x4plus|realesrgan-x4plus-anime|pbrify] [--tag T]
  parts: see PARTS below (the 6 pack parts). Output: work/tmp/detail/bakeoff/l2/<part>/<tag>/
The ComfyUI server must be running (work/tools/comfyui/start_comfyui.sh, flags in SETUP.md).
"""
import argparse
import json
import os
import subprocess
import sys
import time

import numpy as np
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, 'work', 'tmp', 'detail', 'stack'))
import comfy_api as C  # noqa: E402
import uvsafe as U  # noqa: E402

PACK = os.path.join(ROOT, 'work', 'remaster', 'pack')
OUT_GAME = os.path.join(ROOT, 'work', 'out')
ESR = os.path.join(ROOT, 'work', 'tools', 'realesrgan')
OUTROOT = os.path.join(ROOT, 'work', 'tmp', 'detail', 'bakeoff', 'l2')
SYS_PY = r'C:\Users\Pixi\AppData\Local\Programs\Python\Python312\python.exe'

STYLE = 'hand-painted fantasy MMORPG texture, highly detailed, sharp, flat even lighting, no shadows'
STYLE_DETAIL = ('highly detailed game texture, intricate fine detail, sharp focus, crisp micro detail, realistic '
                'material surface, 4k, flat even lighting, no shadows')
NEG = ('blurry, soft, lowres, jpeg artifacts, noise, text, letters, watermark, logo, signature, photo background, '
       'harsh shadows, specular highlights, glare, deformed, extra objects')
PARTS = {
    'chinaman_adventurer_body': dict(
        mat='chinaman_adventurer_body', alpha='cutout',
        prompt='skin with subtle pores and natural muscle definition, dark olive loincloth with fine gold thread '
               'embroidery, yellow paper talismans with red brush marks, ' + STYLE,
        denoise=0.30, face=dict(mesh='chinaman_Adventurer_face', u_min=0.45, denoise=0.12)),
    'chinaman_adventurer_hair': dict(
        mat='chinaman_adventurer_hair', alpha='cutout',
        prompt='dark reddish brown hair, fine individual hair strands flowing downward, soft strand highlights, ' + STYLE,
        denoise=0.35),
    'ch_m_heavy_01_ba': dict(
        mat='heavy_01_ba', alpha='specmask',
        prompt='lamellar armour of riveted brown leather plates with stitching and worn edges, hammered iron band with '
               'dome rivets, red lacquered leather straps, ornate gold clasps, quilted cream linen with fine weave, '
               'teal cloth cuffs, subtle scratches, ' + STYLE,
        denoise=0.35),
    'ch_m_heavy_01_la': dict(
        mat='heavy_01_la', alpha='specmask',
        prompt='armoured skirt of riveted brown leather plates with stitching and worn edges, green silk sash with '
               'folds, red and gold trim, cream linen with fine weave, subtle scratches, ' + STYLE,
        denoise=0.35),
    'ch_m_heavy_01_fa': dict(
        mat='heavy_01_fa', alpha='specmask',
        prompt='armoured boots of riveted brown leather plates with stitching, wrapped cream linen bindings with fine '
               'weave, dark green cloth panel with gold border, worn edges, ' + STYLE,
        denoise=0.35),
    'ch_sword_01': dict(
        mat='sword1_2_3', alpha='specmask',
        union=['equipment/china/weapon/sword_02.glb', 'equipment/china/weapon/sword_03.glb'],
        prompt='ornate chinese sword parts, polished steel blade with fine engraving, bronze and gold fittings with '
               'relief ornament, jade inlay, leather-wrapped wooden grip, subtle scratches, ' + STYLE,
        denoise=0.35),
}


# ---------------------------------------------------------------- image helpers
def gblur(a, sigma):
    """Gaussian blur (FFT, reflect-padded), float32, HxW or HxWxC."""
    if sigma <= 0:
        return a.astype(np.float32)
    a = a.astype(np.float32)
    if a.ndim == 3:
        return np.dstack([gblur(a[..., c], sigma) for c in range(a.shape[2])])
    p = int(3 * sigma) + 2
    ap = np.pad(a, p, mode='reflect')
    fy = np.fft.fftfreq(ap.shape[0])[:, None]; fx = np.fft.rfftfreq(ap.shape[1])[None, :]
    g = np.exp(-2 * np.pi ** 2 * sigma ** 2 * (fy ** 2 + fx ** 2)).astype(np.float32)
    return np.fft.irfft2(np.fft.rfft2(ap) * g, s=ap.shape)[p:-p, p:-p].astype(np.float32)


def lanczos(img, size):
    return img.resize(size, Image.LANCZOS)


def to_arr(img):
    return np.asarray(img, np.float32)


def to_img(a, mode=None):
    return Image.fromarray(np.clip(np.round(a), 0, 255).astype(np.uint8), mode)


def lum(a):
    return a[..., 0] * 0.299 + a[..., 1] * 0.587 + a[..., 2] * 0.114


# ---------------------------------------------------------------- UV islands
def mesh_tris(glb, mat_or_image, mesh_name=None):
    """UV triangles of the primitives that use the texture (optionally only one mesh), as (N,3,2)."""
    j, blob = U.read_glb(glb)
    want = set()
    for mi, m in enumerate(j.get('materials', [])):
        names = [m.get('name', '').lower()]
        bct = m.get('pbrMetallicRoughness', {}).get('baseColorTexture')
        if bct is not None:
            names.append(j['images'][j['textures'][bct['index']]['source']].get('name', '').lower())
        if mat_or_image.lower() in names:
            want.add(mi)
    tris = []
    for mesh in j['meshes']:
        if mesh_name and mesh.get('name') != mesh_name:
            continue
        for p in mesh['primitives']:
            if want and p.get('material') not in want:
                continue
            uv = U.accessor(j, blob, p['attributes']['TEXCOORD_0'])[:, :2]
            idx = U.accessor(j, blob, p['indices'])[:, 0] if 'indices' in p else np.arange(len(uv))
            tris.append(uv[idx.reshape(-1, 3)])
    return np.concatenate(tris)


def raster(tris, W, H):
    return np.asarray(U.island_mask(tris, W, H)) > 0


def dilate(mask, r):
    if r <= 0:
        return mask
    return np.asarray(Image.fromarray(mask.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(2 * r + 1))) > 0


# ---------------------------------------------------------------- L1 (GAN)
def alpha_bleed(rgb, alpha):
    """Colour under cut-out texels (alpha < 50%) is refilled from the opaque ones (push-pull), so neither the GAN
    nor the diffusion pass sharpens matte colour into the strand/edge borders."""
    m = alpha >= 128
    if m.all():
        return rgb
    fill = U.push_pull(rgb.astype(np.float32), m)
    out = rgb.astype(np.float32).copy(); out[~m] = fill[~m]
    return out


def gan_x4(rgb_img, model, work):
    t = time.time()
    if model == 'pbrify':
        name = C.upload(rgb_img, 'l1_' + os.path.basename(work) + '.png')
        wf = {'1': {'class_type': 'LoadImage', 'inputs': {'image': name}},
              '2': {'class_type': 'UpscaleModelLoader', 'inputs': {'model_name': 'pbrify\\4x-PBRify-UpscalerV4.safetensors'}},
              '3': {'class_type': 'ImageUpscaleWithModel', 'inputs': {'upscale_model': ['2', 0], 'image': ['1', 0]}},
              '4': {'class_type': 'SaveImage', 'inputs': {'images': ['3', 0], 'filename_prefix': 'l1/pbrify'}}}
        imgs, _ = C.run(wf, '4')
        out = imgs[0].convert('RGB')
    else:
        i = os.path.join(work, '_gan_in.png'); o = os.path.join(work, '_gan_out.png')
        rgb_img.save(i)
        subprocess.run([os.path.join(ESR, 'realesrgan-ncnn-vulkan.exe'), '-i', i, '-o', o, '-n', model, '-s', '4',
                        '-m', os.path.join(ESR, 'models'), '-f', 'png'], check=True, capture_output=True, cwd=ESR)
        out = Image.open(o).convert('RGB'); out.load()
        os.remove(i); os.remove(o)
    return out, time.time() - t


# ---------------------------------------------------------------- SDXL via ComfyUI
def usdu(img, prompt, denoise, upscale_by, seed, steps=16, cfg=5.0, cn_strength=0.8, cn_end=0.85, tile=1024, pad=64,
         seam_fix='None', tag='l2', tiled_decode=True, sampler='dpmpp_2m'):
    name = C.upload(img, f'{tag}_in.png')
    wf = {
        '1': {'class_type': 'CheckpointLoaderSimple', 'inputs': {'ckpt_name': 'sd_xl_base_1.0.safetensors'}},
        '2': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'sdxl_vae_fp16_fix.safetensors'}},
        '3': {'class_type': 'CLIPTextEncode', 'inputs': {'clip': ['1', 1], 'text': prompt}},
        '4': {'class_type': 'CLIPTextEncode', 'inputs': {'clip': ['1', 1], 'text': NEG}},
        '5': {'class_type': 'ControlNetLoader', 'inputs': {'control_net_name': 'controlnet-tile-sdxl-1.0.safetensors'}},
        '6': {'class_type': 'LoadImage', 'inputs': {'image': name}},
        '7': {'class_type': 'ControlNetApplyAdvanced', 'inputs': {
            'positive': ['3', 0], 'negative': ['4', 0], 'control_net': ['5', 0], 'image': ['6', 0],
            'strength': cn_strength, 'start_percent': 0.0, 'end_percent': cn_end, 'vae': ['2', 0]}},
        '8': {'class_type': 'UltimateSDUpscaleCustomSample', 'inputs': {
            'image': ['6', 0], 'model': ['1', 0], 'positive': ['7', 0], 'negative': ['7', 1], 'vae': ['2', 0],
            'upscale_by': float(upscale_by), 'seed': int(seed), 'steps': int(steps), 'cfg': float(cfg),
            'sampler_name': sampler, 'scheduler': 'karras', 'denoise': float(denoise), 'mode_type': 'Linear',
            'tile_width': tile, 'tile_height': tile, 'mask_blur': 16, 'tile_padding': pad,
            'seam_fix_mode': seam_fix, 'seam_fix_denoise': max(0.1, denoise * 0.7), 'seam_fix_width': 64,
            'seam_fix_mask_blur': 16, 'seam_fix_padding': 32, 'force_uniform_tiles': True, 'tiled_decode': bool(tiled_decode),
            'batch_size': 1}},
        '9': {'class_type': 'SaveImage', 'inputs': {'images': ['8', 0], 'filename_prefix': f'l2/{tag}'}},
    }
    imgs, dt = C.run(wf, '9')
    return imgs[0].convert('RGB'), dt


def n_tiles(W, H, tile=1024):
    return int(np.ceil(W / tile) * np.ceil(H / tile))


# ---------------------------------------------------------------- gates
def block_shift(a, b, mask, bs=32):
    """Per-block sub-pixel translation between a and b (phase correlation), only on textured blocks that lie
    inside the islands. Returns an (N,2) array of (dy, dx) in pixels of a/b."""
    win = np.outer(np.hanning(bs), np.hanning(bs)).astype(np.float32)
    out = []
    H, W = a.shape
    for y in range(0, H - bs + 1, bs // 2):
        for x in range(0, W - bs + 1, bs // 2):
            if mask[y:y + bs, x:x + bs].mean() < 0.95:
                continue
            A = a[y:y + bs, x:x + bs]; B = b[y:y + bs, x:x + bs]
            if A.std() < 4 or B.std() < 4:
                continue
            FA = np.fft.fft2((A - A.mean()) * win); FB = np.fft.fft2((B - B.mean()) * win)
            R = FA * np.conj(FB); R /= np.abs(R) + 1e-6
            r = np.real(np.fft.ifft2(R))
            py, px = np.unravel_index(np.argmax(r), r.shape)

            def sub(c, m1, p1):
                d = m1 - 2 * c + p1
                return 0.0 if abs(d) < 1e-9 else 0.5 * (m1 - p1) / d
            dy = py + sub(r[py, px], r[(py - 1) % bs, px], r[(py + 1) % bs, px])
            dx = px + sub(r[py, px], r[py, (px - 1) % bs], r[py, (px + 1) % bs])
            dy = (dy + bs / 2) % bs - bs / 2; dx = (dx + bs / 2) % bs - bs / 2
            out.append((dy, dx))
    return np.array(out) if out else np.zeros((0, 2))


def run_uvsafe(src_p, out_p, glbs, mat, work, overlay_p):
    r = subprocess.run([SYS_PY, os.path.join(ROOT, 'work', 'tmp', 'detail', 'stack', 'uvsafe.py'), src_p, out_p,
                        ','.join(glbs), mat, os.path.join(work, '_uvsafe_tmp.png'), overlay_p],
                       capture_output=True, text=True, check=True)
    os.remove(os.path.join(work, '_uvsafe_tmp.png'))
    return json.loads(r.stdout.strip().splitlines()[-1])


# ---------------------------------------------------------------- main
def process(part, target=2048, denoise=None, face_denoise=None, seed=7, steps=16, gan='realesrgan-x4plus',
            tag='main', seam_fix='None', cn_strength=0.8, cfg=5.0, cfix=2.0, style='paint', sampler='dpmpp_2m'):
    cfg_p = dict(PARTS[part])
    if style == 'detail':
        cfg_p['prompt'] = cfg_p['prompt'].replace(STYLE, STYLE_DETAIL)
    work = os.path.join(OUTROOT, part, tag); os.makedirs(work, exist_ok=True)
    denoise = cfg_p['denoise'] if denoise is None else denoise
    T0 = time.time(); timing = {}
    src_p = os.path.join(PACK, part, 'texture.png'); glb = os.path.join(PACK, part, 'model.glb')
    glbs = [glb] + [os.path.join(OUT_GAME, g) for g in cfg_p.get('union', [])]
    src = Image.open(src_p).convert('RGBA'); w0, h0 = src.size
    s = target / max(w0, h0); W, H = int(round(w0 * s)), int(round(h0 * s))
    S = np.asarray(src, np.float32); alpha0 = S[..., 3]

    # --- L1: GAN 4x of the (alpha-bled) original RGB -----------------------------------------
    rgb0 = S[..., :3] if cfg_p['alpha'] != 'cutout' else alpha_bleed(S[..., :3], alpha0)
    gan_img, timing['gan_s'] = gan_x4(to_img(rgb0, 'RGB'), gan, work)
    gan_img.save(os.path.join(work, 'gan_x4.png'))
    L1 = lanczos(gan_img, (W, H)) if gan_img.size != (W, H) else gan_img

    # --- L2: SDXL + ControlNet-Tile, 2x per pass until the target size --------------------------
    cur = lanczos(gan_img, (min(W, gan_img.width), min(H, gan_img.height)))
    passes = []
    while True:
        up = min(2.0, W / cur.width)
        t = time.time()
        res, dt = usdu(cur, cfg_p['prompt'], denoise, up, seed + len(passes), steps=steps, cfg=cfg,
                       cn_strength=cn_strength, tag=f'{part}_{tag}_p{len(passes)}', seam_fix=seam_fix, sampler=sampler)
        passes.append(dict(size_in=cur.size, size_out=res.size, upscale_by=up, denoise=denoise,
                           tiles=n_tiles(*res.size), seconds=round(time.time() - t, 1)))
        pass_in = cur if up == 1.0 else lanczos(cur, res.size)
        cur = res
        if cur.width >= W:
            break
    if cur.size != (W, H):
        cur = lanczos(cur, (W, H))
    sd = to_arr(cur)
    timing['sdxl_passes'] = passes

    # --- face: a separate low-denoise pass over the face crop, feathered in over the face islands -----
    face_info = None
    if cfg_p.get('face'):
        f = cfg_p['face']; fd = f['denoise'] if face_denoise is None else face_denoise
        ft = mesh_tris(glb, cfg_p['mat'], f['mesh'])
        ft = ft[ft[:, :, 0].mean(1) >= f['u_min']]
        fm = raster(ft, W, H)
        ys, xs = np.nonzero(dilate(fm, 32))
        x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
        cw, ch = max(1024, (x1 - x0 + 7) // 8 * 8), max(1024, (y1 - y0 + 7) // 8 * 8)
        cw, ch = min(cw, W), min(ch, H)
        cx0 = int(np.clip((x0 + x1) // 2 - cw // 2, 0, W - cw)); cy0 = int(np.clip((y0 + y1) // 2 - ch // 2, 0, H - ch))
        box = (cx0, cy0, cx0 + cw, cy0 + ch)
        t = time.time()
        fres, _ = usdu(pass_in.crop(box), cfg_p['prompt'], fd, 1.0, seed + 100, steps=steps, cfg=cfg,
                       cn_strength=cn_strength, tag=f'{part}_{tag}_face', sampler=sampler)
        wf = np.zeros((H, W), np.float32)
        wf[box[1]:box[3], box[0]:box[2]] = 1
        feather = gblur(dilate(fm, 12).astype(np.float32), 8) * wf
        full = sd.copy(); full[box[1]:box[3], box[0]:box[2]] = to_arr(fres)
        sd = sd * (1 - feather[..., None]) + full * feather[..., None]
        face_info = dict(denoise=fd, box=[int(v) for v in box], seconds=round(time.time() - t, 1))
        timing['face_s'] = face_info['seconds']

    # --- UV-safe composite ----------------------------------------------------------------------
    tris = np.concatenate([mesh_tris(g, cfg_p['mat']) for g in glbs])
    isl = raster(tris, W, H)
    pad = max(2, int(round(s)))                         # ~1 source texel of processed data past the island edge
    isl_d = dilate(isl, pad)
    Lz = to_arr(lanczos(Image.fromarray(S[..., :3].astype(np.uint8)), (W, H)))   # RGB alone: no premultiply
    r = cfix * s                                          # colour-fix radius in source texels
    fixed = np.clip(sd - gblur(sd, r) + gblur(Lz, r), 0, 255)
    w = gblur(isl_d.astype(np.float32), pad / 2)
    w = np.maximum(w, isl.astype(np.float32)); w[w < 0.004] = 0
    L1a = to_arr(L1)
    rgb = fixed * w[..., None] + L1a * (1 - w[..., None])
    a = to_arr(lanczos(Image.fromarray(alpha0.astype(np.uint8)), (W, H)))
    binary = np.mean((alpha0 == 0) | (alpha0 == 255)) > 0.98
    if binary:
        a = np.where(a >= 128, 255, 0)
    out = np.dstack([rgb, a])
    out_p = os.path.join(work, f'albedo_{max(W, H)}.png')
    to_img(out, 'RGBA').save(out_p)
    timing['total_s'] = round(time.time() - T0, 1)

    # --- gates ----------------------------------------------------------------------------------
    gates = {}
    gates['uvsafe'] = run_uvsafe(src_p, out_p, glbs, cfg_p['mat'], work, os.path.join(work, 'uv_overlay.png'))
    u = gates['uvsafe']
    gates['uvsafe_pass'] = bool(u['psnr_processed_vs_src'] >= 28.0 and
                                u['psnr_processed_vs_src'] >= u['psnr_if_shifted_1_texel'] + 3.0)
    # alignment / warp: result vs the Lanczos reference at 2x source resolution, per 32 px block
    k = 2
    ref = lum(to_arr(lanczos(Image.fromarray(S[..., :3].astype(np.uint8)), (w0 * k, h0 * k))))
    got = lum(to_arr(lanczos(to_img(rgb, 'RGB'), (w0 * k, h0 * k))))
    m2 = np.asarray(Image.fromarray(isl.astype(np.uint8) * 255).resize((w0 * k, h0 * k), Image.NEAREST)) > 0
    sh = block_shift(gblur(ref, 2.0), gblur(got, 2.0), m2, bs=64) / k   # 32-texel blocks (calibrated: GAN 0.02, 1-texel shift 1.07)
    mag = np.hypot(sh[:, 0], sh[:, 1]) if len(sh) else np.zeros(1)
    gates['shift_texels'] = dict(blocks=int(len(sh)), median=round(float(np.median(mag)), 3),
                                 p95=round(float(np.percentile(mag, 95)), 3), max=round(float(mag.max()), 3),
                                 mean_dx=round(float(sh[:, 1].mean()), 3) if len(sh) else 0,
                                 mean_dy=round(float(sh[:, 0].mean()), 3) if len(sh) else 0)
    gates['shift_pass'] = bool(gates['shift_texels']['median'] <= 0.1 and gates['shift_texels']['p95'] <= 0.25
                               and abs(gates['shift_texels']['mean_dx']) < 0.05 and abs(gates['shift_texels']['mean_dy']) < 0.05)
    outside = ~dilate(isl_d, int(3 * pad) + 2)
    diff = np.abs(np.round(rgb) - np.round(L1a)).max(-1)
    gates['gutter_changed_px'] = int((diff[outside] > 0.5).sum())
    gates['gutter_px'] = int(outside.sum())
    gates['gutter_pass'] = gates['gutter_changed_px'] == 0
    if face_info:
        fm_src = raster(ft, w0, h0) & (np.asarray(Image.fromarray(alpha0.astype(np.uint8))) > 0)
        fm_src = np.asarray(Image.fromarray(fm_src.astype(np.uint8) * 255).filter(ImageFilter.MinFilter(3))) > 0
        down = to_arr(to_img(rgb, 'RGB').resize((w0, h0), Image.BOX))
        e = ((down - S[..., :3]) ** 2)[fm_src].mean()
        face_info['psnr_face_vs_src'] = round(float(10 * np.log10(255 ** 2 / max(e, 1e-9))), 2)
        gates['face'] = face_info
    gates['pass'] = bool(gates['uvsafe_pass'] and gates['shift_pass'] and gates['gutter_pass'])
    meta = dict(part=part, tag=tag, src=os.path.relpath(src_p, ROOT), glbs=[os.path.relpath(g, ROOT) for g in glbs],
                size=[W, H], scale=s, gan=gan, denoise=denoise, seed=seed, steps=steps, cfg=cfg, cn_strength=cn_strength,
                cn_end=0.85, tile=1024, tile_padding=64, tiled_decode=True, colour_fix_texels=cfix, style=style, sampler=sampler, seam_fix=seam_fix, prompt=cfg_p['prompt'], negative=NEG,
                alpha=cfg_p['alpha'], alpha_binary=bool(binary), timing=timing, gates=gates)
    json.dump(meta, open(os.path.join(work, 'meta.json'), 'w'), indent=1)
    return meta


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('part', choices=sorted(PARTS))
    ap.add_argument('--target', type=int, default=2048)
    ap.add_argument('--denoise', type=float)
    ap.add_argument('--face-denoise', type=float)
    ap.add_argument('--seed', type=int, default=7)
    ap.add_argument('--steps', type=int, default=16)
    ap.add_argument('--cfg', type=float, default=5.0)
    ap.add_argument('--cn', type=float, default=0.8)
    ap.add_argument('--gan', default='realesrgan-x4plus')
    ap.add_argument('--seam-fix', default='None')
    ap.add_argument('--tag', default='main')
    ap.add_argument('--cfix', type=float, default=2.0, help='colour-fix radius in source texels')
    ap.add_argument('--style', default='paint', choices=['paint', 'detail'])
    a = ap.parse_args()
    C.wait_alive()
    m = process(a.part, a.target, a.denoise, a.face_denoise, a.seed, a.steps, a.gan, a.tag, a.seam_fix, a.cn, a.cfg, a.cfix, a.style)
    g = m['gates']
    print(json.dumps(dict(part=m['part'], tag=m['tag'], size=m['size'], timing=m['timing'], pass_=g['pass'],
                          uvsafe=g['uvsafe'], shift=g['shift_texels'], gutter_changed=g['gutter_changed_px'],
                          face=g.get('face'))))
