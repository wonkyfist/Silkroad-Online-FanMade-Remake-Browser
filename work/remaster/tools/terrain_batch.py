"""Run sdxl_terrain.process for the three bake-off tiles through gpu_jobs (RAM-aware restart/retry)."""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gpu_jobs, sdxl_terrain as T
for stem, kind in [('c_grass_hmfld_01', 'grass'), ('c_dust_fld_01', 'dirt'), ('c_stone_hmfld_01', 'rock')]:
    if os.path.exists(os.path.join(T.OUT, stem, 'meta.json')):
        print('skip', stem); continue
    print(json.dumps(gpu_jobs.run(T.process, stem, kind)), flush=True)
