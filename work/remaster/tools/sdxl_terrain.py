"""Seamless local SDXL detail pass for a tileable terrain texture (bake-off step 4).

1. GAN x4 (realesrgan-x4plus) with 32 px wrap padding -> 2048 px, seamless (G).
2. SDXL + ControlNet-Tile through UltimateSDUpscale over G (R1). Its outer edges are no longer seamless.
3. Colour lock: low frequencies (sigma = 2 source texels, wrap-aware) come from G, only finer detail from SDXL,
   so the tile keeps its colour family and the terrain splat blend still works.
4. Half-offset seam inpaint: roll by half a tile so the old edges form a cross in the middle; pre-fill a band
   around the cross from G (seamless, no detail); then masked SDXL sampling (SetLatentNoiseMask + ControlNet-Tile)
   regenerates detail inside the band only, in 1024 px crops along the cross; roll back.
5. Colour lock again; seam metric (TEXPIPE §3.4: mean |gradient| across the wrap edge / across interior lines).
usage: venv python sdxl_terrain.py <tile stem> [--denoise 0.5] [--seam-denoise 0.55] [--seed 3]
Output: work/tmp/detail/bakeoff/terrain/<stem>/{gan_x4.png, sdxl_raw.png, albedo_2048.png, meta.json}
"""
import argparse
import json
import os
import subprocess
import sys
import time

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
sys.path.insert(0, HERE)
import comfy_api as C  # noqa: E402
import sdxl_detail as D  # noqa: E402

TILES = os.path.join(ROOT, 'work', 'out', 'world', 'jangan-fields', 'tiles')
OUT = os.path.join(ROOT, 'work', 'tmp', 'detail', 'bakeoff', 'terrain')
ESR = os.path.join(ROOT, 'work', 'tools', 'realesrgan')
FLAT = 'top-down orthographic seamless ground texture, highly detailed, sharp focus, flat even lighting, no shadows'
PROMPTS = {
    'grass': 'lush meadow grass, dense fine grass blades, small clover leaves, tiny wild flowers, ' + FLAT,
    'dirt': 'packed earth dirt road, fine dry soil, small pebbles and grit, faint cart tracks, ' + FLAT,
    'rock': 'weathered grey stone ground, cracked rock surface, fine mineral grain, lichen patches, ' + FLAT,
}
NEG = D.NEG + ', seam, border, frame, perspective, horizon, sky, objects, plants in 3d'


def gblur_wrap(a, s):
    if s <= 0:
        return a.astype(np.float32)
    if a.ndim == 3:
        return np.dstack([gblur_wrap(a[..., c], s) for c in range(a.shape[2])])
    fy = np.fft.fftfreq(a.shape[0])[:, None]; fx = np.fft.rfftfreq(a.shape[1])[None, :]
    g = np.exp(-2 * np.pi ** 2 * s ** 2 * (fy ** 2 + fx ** 2))
    return np.fft.irfft2(np.fft.rfft2(a.astype(np.float32)) * g, s=a.shape).astype(np.float32)


def seam_ratio(a):
    """TEXPIPE §3.4: mean |difference| across the wrap edge / mean |difference| across interior lines (1 = invisible)."""
    L = D.lum(a.astype(np.float32))
    du = np.abs(L[:, 0] - L[:, -1]).mean() / (np.abs(np.diff(L, axis=1)).mean() + 1e-6)
    dv = np.abs(L[0, :] - L[-1, :]).mean() / (np.abs(np.diff(L, axis=0)).mean() + 1e-6)
    return round(float(du), 3), round(float(dv), 3)


def gan_wrap(img, work, pad=32):
    a = np.asarray(img.convert('RGB'))
    p = np.pad(a, ((pad, pad), (pad, pad), (0, 0)), mode='wrap')
    i = os.path.join(work, '_g_in.png'); o = os.path.join(work, '_g_out.png')
    Image.fromarray(p).save(i)
    subprocess.run([os.path.join(ESR, 'realesrgan-ncnn-vulkan.exe'), '-i', i, '-o', o, '-n', 'realesrgan-x4plus', '-s', '4',
                    '-m', os.path.join(ESR, 'models'), '-f', 'png'], check=True, capture_output=True, cwd=ESR)
    g = np.asarray(Image.open(o).convert('RGB'))[4 * pad:-4 * pad, 4 * pad:-4 * pad]
    os.remove(i); os.remove(o)
    return g


def colour_lock(x, ref, r):
    return np.clip(x - gblur_wrap(x, r) + gblur_wrap(ref, r), 0, 255)


def lanczos_wrap(img, W, pad=16):
    """Wrap-aware Lanczos upscale of the source: the colour reference (Real-ESRGAN x4plus darkens dark, noisy tiles
    a lot: c_grass_hmfld_01 mean 48.6 -> 27.3, so the GAN output must not be the colour reference)."""
    a = np.asarray(img.convert('RGB')); w0 = a.shape[1]; k = W // w0
    p = np.pad(a, ((pad, pad), (pad, pad), (0, 0)), mode='wrap')
    up = np.asarray(Image.fromarray(p).resize((p.shape[1] * k, p.shape[0] * k), Image.LANCZOS), np.float32)
    return up[pad * k:-pad * k, pad * k:-pad * k]


def inpaint_crop(crop, mask, prompt, denoise, seed, steps=16, cfg=6.0, cn=0.8, tag='seam'):
    n_img = C.upload(Image.fromarray(crop.astype(np.uint8)), f'{tag}_img.png')
    n_msk = C.upload(Image.fromarray((mask * 255).astype(np.uint8)), f'{tag}_mask.png')
    wf = {
        '1': {'class_type': 'CheckpointLoaderSimple', 'inputs': {'ckpt_name': 'sd_xl_base_1.0.safetensors'}},
        '2': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'sdxl_vae_fp16_fix.safetensors'}},
        '3': {'class_type': 'CLIPTextEncode', 'inputs': {'clip': ['1', 1], 'text': prompt}},
        '4': {'class_type': 'CLIPTextEncode', 'inputs': {'clip': ['1', 1], 'text': NEG}},
        '5': {'class_type': 'ControlNetLoader', 'inputs': {'control_net_name': 'controlnet-tile-sdxl-1.0.safetensors'}},
        '6': {'class_type': 'LoadImage', 'inputs': {'image': n_img}},
        '10': {'class_type': 'LoadImageMask', 'inputs': {'image': n_msk, 'channel': 'red'}},
        '7': {'class_type': 'ControlNetApplyAdvanced', 'inputs': {'positive': ['3', 0], 'negative': ['4', 0], 'control_net': ['5', 0],
                                                                   'image': ['6', 0], 'strength': cn, 'start_percent': 0.0, 'end_percent': 0.85}},
        '11': {'class_type': 'VAEEncode', 'inputs': {'pixels': ['6', 0], 'vae': ['2', 0]}},   # falls back to tiled on OOM
        '12': {'class_type': 'SetLatentNoiseMask', 'inputs': {'samples': ['11', 0], 'mask': ['10', 0]}},
        '13': {'class_type': 'KSampler', 'inputs': {'model': ['1', 0], 'seed': seed, 'steps': steps, 'cfg': cfg,
                                                    'sampler_name': 'dpmpp_2m', 'scheduler': 'karras', 'positive': ['7', 0],
                                                    'negative': ['7', 1], 'latent_image': ['12', 0], 'denoise': denoise}},
        # --gpu-only cannot evict models, so decode in small tiles (peak ~0.5 GB) to stay under the VRAM cap
        '14': {'class_type': 'VAEDecodeTiled', 'inputs': {'samples': ['13', 0], 'vae': ['2', 0], 'tile_size': 256, 'overlap': 32,
                                                          'temporal_size': 64, 'temporal_overlap': 8}},
        '9': {'class_type': 'SaveImage', 'inputs': {'images': ['14', 0], 'filename_prefix': f'terrain/{tag}'}},
    }
    imgs, dt = C.run(wf, '9')
    return np.asarray(imgs[0].convert('RGB'), np.float32), dt


def process(stem, kind, denoise=0.5, seam_denoise=0.55, seed=3, band=96, feather=32):
    work = os.path.join(OUT, stem); os.makedirs(work, exist_ok=True)
    T0 = time.time(); timing = {}
    src = Image.open(os.path.join(TILES, stem + '.png')).convert('RGB'); w0 = src.width
    raw = os.path.join(work, 'gan_raw_x4.png')        # precomputed while ComfyUI is down (both use the GPU)
    t = time.time()
    if not os.path.exists(raw):
        Image.fromarray(gan_wrap(src, work)).save(raw)
    G0 = np.asarray(Image.open(raw).convert('RGB'), np.float32); timing['gan_s'] = round(time.time() - t, 1)
    W = G0.shape[1]; s = W / w0; r = 2.0 * s
    Lz = lanczos_wrap(src, W)
    G = colour_lock(G0, Lz, r)                                 # GAN detail on the source's colours (seamless)
    Image.fromarray(G.astype(np.uint8)).save(os.path.join(work, 'gan_x4.png'))
    # 2. SDXL pass (reused if sdxl_raw.png exists)
    t = time.time(); rawp = os.path.join(work, 'sdxl_raw.png')
    if os.path.exists(rawp):
        R1 = np.asarray(Image.open(rawp).convert('RGB'), np.float32); timing['sdxl_s'] = json.load(open(os.path.join(work, 'sdxl_time.json')))['s'] if os.path.exists(os.path.join(work, 'sdxl_time.json')) else None
    else:
        R1, _ = D.usdu(Image.fromarray(G.astype(np.uint8)), PROMPTS[kind], denoise, 1.0, seed, steps=16, cfg=6.0,
                       cn_strength=0.8, tag=f'terrain_{stem}')
        R1 = np.asarray(R1, np.float32); timing['sdxl_s'] = round(time.time() - t, 1)
        Image.fromarray(R1.astype(np.uint8)).save(rawp); json.dump({'s': timing['sdxl_s']}, open(os.path.join(work, 'sdxl_time.json'), 'w'))
    # 3. colour lock
    X = colour_lock(R1, Lz, r)
    seam_before = seam_ratio(X)
    # 4. half-offset seam inpaint. Rolled by half a tile, the old edges form a cross at x = h and y = h. The band around
    #    the cross is pre-filled from G (seamless, no detail), then regenerated by SDXL (USDU, one tile) in wrapped 1024 px
    #    crops, and only the feathered band is pasted back.
    #    No crop border may cut through the masked band (that makes a new seam), so each crop's mask fades out 64-96 px
    #    before its borders, the crops along a band overlap, and the horizontal-band crops keep the finished vertical
    #    band as context (mask 0 there).
    h = W // 2
    Xr = np.roll(X, (h, h), (0, 1)); Gr = np.roll(G, (h, h), (0, 1))
    yy, xx = np.mgrid[0:W, 0:W]
    dv = np.abs(xx - h).astype(np.float32); dh = np.abs(yy - h).astype(np.float32)
    vband = np.clip((band + feather - dv) / feather, 0, 1); hband = np.clip((band + feather - dh) / feather, 0, 1)
    band_m = np.maximum(vband, hband)
    pre = Xr * (1 - band_m[..., None]) + Gr * band_m[..., None]
    t1 = np.arange(1024); inner = np.clip((np.minimum(t1, 1023 - t1) - 64) / 32.0, 0, 1)
    win = np.outer(inner, inner)
    vdone = np.clip((band + feather + 48 - dv) / 48, 0, 1)            # vertical band incl. margin: context for hband
    crops = [('v', h, cy) for cy in (h, h + 683, h + 1366)] + [('h', cx, h) for cx in (h + 512, h + 1024, h + 1536)]
    t = time.time()
    for i, (kindc, cx, cy) in enumerate(crops):
        iy = (cy - 512 + t1) % W; ix = (cx - 512 + t1) % W
        sub = pre[np.ix_(iy, ix)]
        m = (vband if kindc == 'v' else hband * (1 - vdone))[np.ix_(iy, ix)] * win
        # the crop is regenerated as ONE tile by the same USDU workflow as step 2 (content continuous across the old
        # seam line); only the feathered band, well inside the crop, is pasted back
        out, _ = D.usdu(Image.fromarray(np.clip(sub, 0, 255).astype(np.uint8)), PROMPTS[kind], seam_denoise, 1.0, seed + 10 + i,
                        steps=16, cfg=6.0, cn_strength=0.8, tag=f'seam_{stem}_{i}')
        out = np.asarray(out.convert('RGB').resize((1024, 1024), Image.LANCZOS) if out.size != (1024, 1024) else out.convert('RGB'), np.float32)
        pre[np.ix_(iy, ix)] = out * m[..., None] + sub * (1 - m[..., None])
    timing['seam_inpaint_s'] = round(time.time() - t, 1)
    Y = np.roll(pre, (-h, -h), (0, 1))
    Y = colour_lock(Y, Lz, r)
    Image.fromarray(np.clip(np.round(Y), 0, 255).astype(np.uint8)).save(os.path.join(work, 'albedo_2048.png'))
    timing['total_s'] = round(time.time() - T0, 1)
    S = np.asarray(src, np.float32)
    lab = lambda a: D.lum(a).mean()
    meta = dict(stem=stem, kind=kind, prompt=PROMPTS[kind], denoise=denoise, seam_denoise=seam_denoise, seed=seed,
                band_px=band, size=[W, W], timing=timing,
                seam_ratio_uv=dict(source=seam_ratio(S), gan=seam_ratio(G), sdxl_before_fix=seam_before, final=seam_ratio(Y)),
                gan_raw_mean_rgb=[round(float(v), 1) for v in G0.reshape(-1, 3).mean(0)],
                mean_rgb=dict(source=[round(float(v), 1) for v in S.reshape(-1, 3).mean(0)],
                              final=[round(float(v), 1) for v in Y.reshape(-1, 3).mean(0)]),
                luma_std=dict(source=round(float(D.lum(S).std()), 2), final=round(float(D.lum(Y).std()), 2)))
    json.dump(meta, open(os.path.join(work, 'meta.json'), 'w'), indent=1)
    return meta


def precompute_gan(stem):
    work = os.path.join(OUT, stem); os.makedirs(work, exist_ok=True)
    raw = os.path.join(work, 'gan_raw_x4.png'); t = time.time()
    if not os.path.exists(raw):
        Image.fromarray(gan_wrap(Image.open(os.path.join(TILES, stem + '.png')).convert('RGB'), work)).save(raw)
    return round(time.time() - t, 1)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('stem'); ap.add_argument('kind', choices=sorted(PROMPTS))
    ap.add_argument('--denoise', type=float, default=0.5); ap.add_argument('--seam-denoise', type=float, default=0.55)
    ap.add_argument('--seed', type=int, default=3)
    a = ap.parse_args()
    C.wait_alive()
    print(json.dumps(process(a.stem, a.kind, a.denoise, a.seam_denoise, a.seed)))
