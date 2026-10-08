"""Write the Blender specs for the three bake-off subjects from variants.json and render them (one Blender process
per subject). Run with ComfyUI stopped (both use the GPU).  usage: python render_all.py [armour body sword]"""
import json
import os
import subprocess
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..'))
BO = os.path.join(ROOT, 'work', 'tmp', 'detail', 'bakeoff')
BLENDER = r'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe'
SCRIPT = os.path.join(ROOT, 'work', 'remaster', 'tools', 'render_bakeoff.py')
V = json.load(open(os.path.join(BO, 'variants.json')))
ORDER = ['A', 'B', 'C0', 'C', 'D']
SUBJECTS = {
    'armour': (['chinaman_adventurer_body', 'chinaman_adventurer_hair', 'ch_m_heavy_01_ba', 'ch_m_heavy_01_la', 'ch_m_heavy_01_fa'],
               ['chest', 'chest_grazing', 'mid']),
    'body': (['chinaman_adventurer_body', 'chinaman_adventurer_hair'], ['face', 'face_grazing', 'torso', 'mid']),
    'sword': (['ch_sword_01'], ['sword', 'hilt', 'sword_grazing']),
}
todo = sys.argv[1:] or list(SUBJECTS)
times = {}
for subj in todo:
    parts, shots = SUBJECTS[subj]
    spec = dict(subject=subj, out_dir=os.path.join(BO, 'renders', subj), parts=parts, shots=shots,
                variants=[dict(name=v, maps={p: {k: x for k, x in V[p][v].items() if x} for p in parts}) for v in ORDER])
    sp = os.path.join(BO, 'renders', f'spec_{subj}.json'); os.makedirs(os.path.dirname(sp), exist_ok=True)
    json.dump(spec, open(sp, 'w'), indent=1)
    t = time.time()
    r = subprocess.run([BLENDER, '--background', '--factory-startup', '--python', SCRIPT, '--', sp],
                       capture_output=True, text=True)
    times[subj] = round(time.time() - t, 1)
    wrote = [l for l in r.stdout.splitlines() if l.startswith('WROTE')]
    errs = [l for l in (r.stdout + r.stderr).splitlines() if 'Error' in l or 'Traceback' in l]
    print(subj, 'rendered', len(wrote), 'images in', times[subj], 's', 'errors:', errs[:5], flush=True)
    open(os.path.join(BO, 'renders', f'log_{subj}.txt'), 'w').write(r.stdout[-20000:] + '\n---\n' + r.stderr[-20000:])
json.dump(times, open(os.path.join(BO, 'renders', 'timing.json'), 'w'), indent=1)
