"""L3 maps for a tileable terrain albedo, wrap-aware (TEXPIPE §3.6-3.7 formulas, numpy only):
height = multi-scale band sum of sqrt(luminance); normal = two-scale gradient of height (OpenGL +Y);
AO from height cavities; roughness = class base + variation. All filters wrap, so the maps tile like the albedo.
usage: python terrain_l3.py <albedo.png> <kind grass|dirt|rock> <out_dir>
"""
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'work', 'tmp', 'detail', 'detailmaps', 'scripts'))
from dlib import gblur_wrap, srgb2lin, enc_normal  # noqa: E402

CLASS = {  # normal strength (TEXPIPE: ground 2, rock 4), base roughness, variation, AO strength
    'grass': dict(k=2.0, rough=0.85, var=0.10, ao=1.0),
    'dirt': dict(k=2.0, rough=0.88, var=0.08, ao=1.0),
    'rock': dict(k=4.0, rough=0.75, var=0.12, ao=1.2),
}


def maps(albedo, kind):
    c = CLASS[kind]
    a = albedo.astype(np.float64) / 255.0
    W = a.shape[1]; s = W / 512
    L = srgb2lin(a) @ np.array([0.2126, 0.7152, 0.0722])
    Ld = np.sqrt(L)
    b = [gblur_wrap(Ld, r * s) for r in (1, 4, 12, 48)]
    H = 0.25 * (b[0] - b[3]) + 0.35 * (b[1] - b[3]) + 0.4 * (b[2] - b[3])
    lo, hi = np.percentile(H, 2), np.percentile(H, 98)
    H = np.clip((H - lo) / (hi - lo + 1e-9), 0, 1)

    def grad(h):
        return (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5, (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5
    gx1, gy1 = grad(H); gx2, gy2 = grad(gblur_wrap(H, 2 * s))
    k = c['k'] * 4 * 512 / W
    nx = -(0.5 * gx1 + 1.5 * gx2) * k * s; ny = (0.5 * gy1 + 1.5 * gy2) * k * s   # image y down -> GL +Y up
    n = np.dstack([nx, ny, np.ones_like(H)]); n /= np.linalg.norm(n, axis=-1, keepdims=True)
    cav = np.maximum(0, gblur_wrap(H, 6 * s) - H) + 0.5 * np.maximum(0, gblur_wrap(H, 24 * s) - H)
    ao = np.clip(1 - 2.2 * c['ao'] * cav, 0.3, 1)
    luma = a @ np.array([0.2126, 0.7152, 0.0722])
    rough = np.clip(c['rough'] + c['var'] * (6 * cav - (luma - 0.5)), 0.05, 1)
    return H, n, ao, rough


def run(albedo_path, kind, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    alb = np.asarray(Image.open(albedo_path).convert('RGB'))
    H, n, ao, rough = maps(alb, kind)
    Image.fromarray(enc_normal(n)).save(os.path.join(out_dir, 'normal_gl.png'))
    orm = np.dstack([ao, rough, np.zeros_like(ao)])
    Image.fromarray((orm * 255 + 0.5).astype(np.uint8)).save(os.path.join(out_dir, 'orm.png'))
    Image.fromarray((H * 255 + 0.5).astype(np.uint8)).save(os.path.join(out_dir, 'height.png'))
    return n, ao, rough


if __name__ == '__main__':
    run(sys.argv[1], sys.argv[2], sys.argv[3])
