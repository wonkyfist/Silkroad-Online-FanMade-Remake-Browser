"""Seconds for the second 2x pass (2048 -> 4096, 16 tiles) of the L2 pipeline, on a saved raw 2K SDXL result.
A 4K texture = pass 1 (1024 -> 2048) + this pass. usage: venv python sdxl_4k_timing.py <raw_2k.png> <part>"""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gpu_jobs, sdxl_detail as D
from PIL import Image
src, part = sys.argv[1], sys.argv[2]
img = Image.open(src).convert('RGB')
prompt = D.PARTS[part]['prompt'].replace(D.STYLE, D.STYLE_DETAIL)
def job():
    t = time.time()
    out, dt = D.usdu(img, prompt, 0.6, 2.0, 11, steps=20, cfg=7.0, cn_strength=0.6, tag=f'{part}_4k', sampler='dpmpp_2m_sde')
    return out.size, round(time.time() - t, 1)
size, sec = gpu_jobs.run(job)
res = dict(part=part, input=src, output_size=size, tiles=D.n_tiles(*size), seconds_pass2=sec)
json.dump(res, open(os.path.join(D.OUTROOT, part, 'timing_4k_pass2.json'), 'w'), indent=1)
print(json.dumps(res))
