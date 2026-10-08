"""Run a list of sdxl_detail.py jobs through gpu_jobs (RAM-aware, restart/retry). Skips jobs whose meta.json exists.
usage: venv python l2_batch.py <jobs.json>   jobs: [{"part":..., "tag":..., <process() kwargs>}, ...]
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gpu_jobs  # noqa: E402
import sdxl_detail as D  # noqa: E402

jobs = json.load(open(sys.argv[1]))
for j in jobs:
    j = dict(j); part = j.pop('part'); tag = j.pop('tag')
    meta = os.path.join(D.OUTROOT, part, tag, 'meta.json')
    if os.path.exists(meta) and not j.pop('force', False):
        print('skip', part, tag); continue
    j.pop('force', None)
    m = gpu_jobs.run(D.process, part, tag=tag, **j)
    g = m['gates']
    print(json.dumps(dict(part=part, tag=tag, total_s=m['timing']['total_s'], sdxl_s=[p['seconds'] for p in m['timing']['sdxl_passes']],
                          face_s=m['timing'].get('face_s'), pass_=g['pass'], psnr=g['uvsafe']['psnr_processed_vs_src'],
                          shift1=g['uvsafe']['psnr_if_shifted_1_texel'], shift_med=g['shift_texels']['median'],
                          shift_p95=g['shift_texels']['p95'], gutter=g['gutter_changed_px'],
                          face_psnr=(g.get('face') or {}).get('psnr_face_vs_src'))), flush=True)
