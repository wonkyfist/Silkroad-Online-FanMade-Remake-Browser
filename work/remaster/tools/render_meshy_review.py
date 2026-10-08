"""Review sheets for the w9b Meshy "Cloth test + bodies" batch: Blender lit renders with the bake-off's cameras and
lights (render_bakeoff.py), one sheet per part plus an overview, in work/tmp/w9b-meshy/.

Columns:
  cloth: A retail | local (TP-U + TP-P master) | Meshy + local maps (bake-off variant C: L3 maps from Meshy's albedo)
  body:  A retail | local (bake-off SDXL D, else TP-U + TP-P master) | Meshy with the local face (stage_meshy.py CF)
Cloth is worn on the same-gender adventurer body; body, hair and the other parts keep their retail textures there.
A body is shown with its own hair, local hair on the local and Meshy columns. Parts whose Meshy result is not staged
yet get a "pending" tile; re-running renders only what is missing (--force re-renders everything).

usage (repo root, system Python 3.12): python work/remaster/tools/render_meshy_review.py [--force] [--sheets-only] [ids...]
Takes the GPU lock (work/tools/gpu.lock) around the Blender renders.
"""
import json
import os
import subprocess
import sys
import time

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
sys.path.insert(0, HERE)
import stage_meshy as S  # noqa: E402

BLENDER = r'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe'
SCRIPT = os.path.join(HERE, 'render_bakeoff.py')
PACK = os.path.join(ROOT, 'work', 'remaster', 'pack')
OUT = os.path.join(ROOT, 'work', 'tmp', 'w9b-meshy')
RENDERS = os.path.join(OUT, 'renders')
LOCK = os.path.join(ROOT, 'work', 'tools', 'gpu.lock')
MASTER = os.path.join(ROOT, 'work', 'texpipe', 'master', 'prim', 'mtrl')
L3OUT = os.path.join(ROOT, 'work', 'tmp', 'detail', 'bakeoff', 'l3', 'out')
BAKEOFF_V = json.load(open(os.path.join(ROOT, 'work', 'tmp', 'detail', 'bakeoff', 'variants.json')))
COLS = ['A', 'L', 'M']
COL_LABEL = {'A': 'A  retail', 'L': 'local', 'M': 'Meshy + local maps'}

# female cameras: the bake-off's male shots scaled to the female height (1.69 m vs 1.77 m)
SHOT_DEFS = {
    'w_face': dict(cam=[[0.21, -0.91, 1.585], [0.0, 0, 1.528], 85], res=[920, 1100], light=['studio', [0, 0, 1.528], 1.0]),
    'w_chest': dict(cam=[[0.40, -1.55, 1.40], [0.02, 0, 1.27], 85], res=[920, 1100], light=['studio', [0, 0, 1.27], 1.6]),
    'w_chest_grazing': dict(cam=[[0.40, -1.55, 1.40], [0.02, 0, 1.27], 85], res=[920, 1100], light=['grazing', [0, 0, 1.27], 1.0]),
    'w_torso': dict(cam=[[0.33, -2.1, 1.19], [0.0, 0, 1.03], 85], res=[920, 1100], light=['studio', [0, 0, 1.05], 1.6]),
    'w_dress': dict(cam=[[0.5, -2.9, 1.2], [0.0, 0, 1.0], 85], res=[920, 1100], light=['studio', [0, 0, 1.0], 2.0]),
    'legs': dict(cam=[[0.5, -2.6, 0.95], [0.0, 0, 0.74], 85], res=[920, 1100], light=['studio', [0, 0, 0.75], 1.8]),
    'legs_grazing': dict(cam=[[0.5, -2.6, 0.95], [0.0, 0, 0.74], 85], res=[920, 1100], light=['grazing', [0, 0, 0.75], 1.2]),
    'w_hips': dict(cam=[[0.42, -1.75, 1.08], [0.0, 0, 0.94], 85], res=[920, 1100], light=['studio', [0, 0, 0.95], 1.5]),
    'w_hips_grazing': dict(cam=[[0.42, -1.75, 1.08], [0.0, 0, 0.94], 85], res=[920, 1100], light=['grazing', [0, 0, 0.95], 1.0]),
}
# retail body meshes hidden under a female chest piece: in the bind pose the breasts clip through the cloth
HIDE = {'ch_w_clothes_01_ba': ['woman_torso_upper'], 'ch_w_light_01_ba': ['woman_torso_upper']}
CLOTH_SHOTS = {
    'ch_m_clothes_01_ba': ['chest', 'chest_grazing', 'mid'],
    'ch_m_light_01_ba': ['chest', 'chest_grazing', 'mid'],
    'ch_m_clothes_01_la': ['legs', 'legs_grazing', 'mid'],
    'ch_w_clothes_01_ba': ['w_chest', 'w_chest_grazing', 'w_dress', 'mid'],
    'ch_w_light_01_ba': ['w_chest', 'w_chest_grazing', 'mid'],
    'ch_w_light_01_la': ['w_hips', 'w_hips_grazing', 'mid'],
}


def woman(pid):
    return pid.startswith('chinawoman') or pid.startswith('ch_w_')


def master(pid):
    """(albedo, normal, orm) of the TP-U + TP-P master for a pack part, or None."""
    p = json.load(open(os.path.join(PACK, 'manifest.json'), encoding='utf-8'))
    part = next(x for x in p['parts'] if x['id'] == pid)
    rel = part['game']['material']['sourceTexture'].replace('\\', '/')[len('prim/mtrl/'):-len('.ddj')]
    d = os.path.join(MASTER, rel)
    if not os.path.exists(os.path.join(d, 'albedo.png')):
        return None
    return dict(albedo=os.path.join(d, 'albedo.png'), normal=os.path.join(d, 'normal.png'), orm=os.path.join(d, 'ormh.png'))


def local_maps(pid):
    d = BAKEOFF_V.get(pid, {}).get('D')
    if d and os.path.exists(d['albedo']):
        return dict(d), 'SDXL (bake-off D) + L3 maps'
    m = master(pid)
    return (m, 'TP-U + TP-P master') if m else (None, 'none')


def meshy_maps(pid):
    tag = 'CF' if pid in S.BODIES else 'C'
    l3 = os.path.join(L3OUT, f'{pid}__{tag}')
    if pid in S.BODIES:
        alb = os.path.join(ROOT, 'work', 'remaster', 'staging', pid, 'multiview', 'albedo.png')
    else:
        alb = os.path.join(ROOT, 'work', 'remaster', 'meshy', pid, 'multiview', 'base_color.png')
    if not (os.path.exists(alb) and os.path.exists(os.path.join(l3, 'orm.png'))):
        return None
    return dict(albedo=alb, normal=os.path.join(l3, 'normal_gl.png'), orm=os.path.join(l3, 'orm.png'))


def retail(pid):
    return dict(albedo=os.path.join(PACK, pid, 'texture.png'))


def subject(pid):
    """(parts, shots, cutout, {col: maps-per-part or None}, notes)"""
    if pid in S.BODIES:
        hair = pid.replace('_body', '_hair')
        f = woman(pid)
        shots = ['w_face', 'w_torso', 'mid'] if f else ['face', 'torso', 'mid']
        lb, lnote = local_maps(pid); lh, _ = local_maps(hair)
        mm = meshy_maps(pid)
        cols = {'A': {pid: retail(pid), hair: retail(hair)},
                'L': {pid: lb, hair: lh or retail(hair)} if lb else None,
                'M': {pid: mm, hair: lh or retail(hair)} if mm else None}
        return [pid, hair], shots, [pid, hair], cols, dict(L=lnote, M='Meshy multiview 4k, local face pasted back, L3 maps')
    base = 'chinawoman_adventurer' if woman(pid) else 'chinaman_adventurer'
    body, hair = base + '_body', base + '_hair'
    lc, lnote = local_maps(pid)
    mm = meshy_maps(pid)
    fixed = {body: retail(body), hair: retail(hair)}
    cols = {'A': dict(fixed, **{pid: retail(pid)}),
            'L': dict(fixed, **{pid: lc}) if lc else None,
            'M': dict(fixed, **{pid: mm}) if mm else None}
    return [body, hair, pid], CLOTH_SHOTS[pid], [body, hair], cols, dict(L=lnote, M='Meshy multiview 4k albedo + L3 maps')


def lock():
    while True:
        try:
            os.mkdir(LOCK)
            open(os.path.join(LOCK, 'owner'), 'w').write(f'meshy-review-renders {time.strftime("%Y-%m-%dT%H:%M:%S")}\n')
            return
        except FileExistsError:
            print('gpu.lock held; waiting 2 min', flush=True); time.sleep(120)


def unlock():
    try:
        os.remove(os.path.join(LOCK, 'owner')); os.rmdir(LOCK)
    except OSError:
        pass


def render(pid, force):
    parts, shots, cut, cols, _ = subject(pid)
    od = os.path.join(RENDERS, pid)
    todo = [c for c in COLS if cols[c] and (force or not all(os.path.exists(os.path.join(od, f'{c}_{s}.png')) for s in shots))]
    if not todo:
        return 0
    spec = dict(subject=pid, out_dir=od, parts=parts, shots=shots, cutout=cut, shot_defs=SHOT_DEFS, hide=HIDE.get(pid, []),
                variants=[dict(name=c, maps={p: {k: v for k, v in cols[c][p].items() if v} for p in parts}) for c in todo])
    os.makedirs(od, exist_ok=True)
    sp = os.path.join(od, 'spec.json'); json.dump(spec, open(sp, 'w'), indent=1)
    for attempt in range(3):          # Blender 5.2 crashes intermittently in the AMD GL driver (pack.py notes)
        r = subprocess.run([BLENDER, '--background', '--factory-startup', '--python', SCRIPT, '--', sp],
                           capture_output=True, text=True)
        if all(os.path.exists(os.path.join(od, f'{c}_{s}.png')) for c in todo for s in shots):
            return len(todo) * len(shots)
        print(f'  {pid}: Blender attempt {attempt + 1} failed (exit {r.returncode}): {r.stdout[-400:]} {r.stderr[-400:]}', flush=True)
    raise SystemExit(f'{pid}: renders failed')


# ---------------------------------------------------------------- sheets
def font(n):
    for f in ('arialbd.ttf', 'arial.ttf', 'DejaVuSans-Bold.ttf'):
        try:
            return ImageFont.truetype(f, n)
        except OSError:
            pass
    return ImageFont.load_default()


def pending_tile(w, h, text):
    t = Image.new('RGB', (w, h), (46, 46, 52)); d = ImageDraw.Draw(t)
    d.multiline_text((w // 2, h // 2), text, fill=(200, 200, 205), font=font(max(18, w // 18)), anchor='mm', align='center')
    return t


def sheet(pid, tile_w=620):
    parts, shots, _, cols, notes = subject(pid)
    od = os.path.join(RENDERS, pid)
    head = 118; lab = 40
    first = next(os.path.join(od, f'A_{s}.png') for s in shots)
    fw, fh = Image.open(first).size
    rows = []
    for s in shots:
        w0, h0 = Image.open(os.path.join(od, f'A_{s}.png')).size
        rows.append((s, int(tile_w * h0 / w0)))
    H = head + sum(h + lab for _, h in rows)
    img = Image.new('RGB', (tile_w * 3 + 16, H), (18, 18, 22)); d = ImageDraw.Draw(img)
    d.text((10, 8), pid, fill=(250, 250, 250), font=font(34))
    sub = f'L: {notes["L"]}    M: {notes["M"]}'
    d.text((10, 52), sub, fill=(190, 190, 195), font=font(17))
    for i, c in enumerate(COLS):
        d.text((i * (tile_w + 8) + 8, 82), COL_LABEL[c], fill=(255, 214, 120), font=font(26))
    y = head
    for s, h in rows:
        d.text((8, y + 8), s, fill=(170, 170, 175), font=font(22)); y += lab
        for i, c in enumerate(COLS):
            p = os.path.join(od, f'{c}_{s}.png')
            t = Image.open(p).convert('RGB').resize((tile_w, h), Image.LANCZOS) if os.path.exists(p) else \
                pending_tile(tile_w, h, 'Meshy: pending\n(not fired yet)' if c == 'M' else 'no local result')
            img.paste(t, (i * (tile_w + 8), y))
            d.text((i * (tile_w + 8) + 10, y + 8), c, fill=(255, 255, 255), font=font(40))
        y += h
    out = os.path.join(OUT, f'sheet_{pid}.png'); img.save(out)
    return out


def overview(ids, width=2400):
    """one row per part: the first shot of each column, labelled; at most `width` px wide."""
    tw = (width - 260) // 3
    rows = []
    for pid in ids:
        _, shots, _, _, _ = subject(pid)
        od = os.path.join(RENDERS, pid); s = shots[0]
        if not os.path.exists(os.path.join(od, f'A_{s}.png')):
            continue
        a = Image.open(os.path.join(od, f'A_{s}.png'))
        th = int(tw * a.height / a.width * 0.62)          # crop the middle 62% vertically
        tiles = []
        for c in COLS:
            p = os.path.join(od, f'{c}_{s}.png')
            if os.path.exists(p):
                im = Image.open(p).convert('RGB').resize((tw, int(tw * a.height / a.width)), Image.LANCZOS)
                top = (im.height - th) // 2; im = im.crop((0, top, tw, top + th))
            else:
                im = pending_tile(tw, th, 'Meshy: pending' if c == 'M' else 'no local')
            tiles.append(im)
        rows.append((pid, tiles, th))
    H = 70 + sum(th + 6 for _, _, th in rows)
    img = Image.new('RGB', (width, H), (18, 18, 22)); d = ImageDraw.Draw(img)
    for i, c in enumerate(COLS):
        d.text((260 + i * tw + 10, 18), COL_LABEL[c], fill=(255, 214, 120), font=font(30))
    y = 70
    for pid, tiles, th in rows:
        d.text((10, y + th // 2 - 12), pid.replace('_', ' ', 1), fill=(235, 235, 240), font=font(19))
        for i, t in enumerate(tiles):
            img.paste(t, (260 + i * tw, y))
        y += th + 6
    img.save(os.path.join(OUT, 'overview.png'))
    return img.size


def main(argv):
    force = '--force' in argv
    ids = [a for a in argv if not a.startswith('--')] or (list(S.CLOTH) + S.BODIES)
    if '--sheets-only' not in argv:
        lock()
        try:
            for pid in ids:
                t = time.time(); n = render(pid, force)
                print(f'{pid}: {n} render(s) in {time.time() - t:.0f} s', flush=True)
        finally:
            unlock()
    for pid in ids:
        print('sheet', sheet(pid))
    print('overview', overview(list(S.CLOTH) + S.BODIES))


if __name__ == '__main__':
    main(sys.argv[1:])
