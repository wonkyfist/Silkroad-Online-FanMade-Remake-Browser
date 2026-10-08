"""Install finished Meshy retexture results into the game's remaster manifest (work/out/remaster/manifest.json).

usage: python work/remaster/tools/install.py [--size 2048] [--variant multiview|prompt] [part=variant ...]

Reads work/remaster/meshy/ledger.json (SUCCEEDED tasks) and work/remaster/pack/manifest.json (each part's game glb and
image name), converts the maps to WebP at --size, writes them under work/out/remaster/<part>/<variant>/ and one manifest
entry per install key of the part (manifest installKeys: every game glb that uses the texture), keyed
'<glb path under /out/ without .glb>#<image name>' (apps/game/src/three/remaster.ts). Alpha stays
'original': the game cuts out with the retail texture's alpha, which lines up because the UVs are unchanged.
"""
import json
import os
import sys

from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
PACK = os.path.join(ROOT, 'work', 'remaster', 'pack', 'manifest.json')
MESHY = os.path.join(ROOT, 'work', 'remaster', 'meshy')
OUT = os.path.join(ROOT, 'work', 'out', 'remaster')
MAPS = {'base_color': 'albedo', 'normal': 'normal', 'metallic': 'metallic', 'roughness': 'roughness'}


def main(argv):
    size, default_variant, chosen = 2048, 'multiview', {}
    it = iter(argv)
    for a in it:
        if a == '--size':
            size = int(next(it))
        elif a == '--variant':
            default_variant = next(it)
        elif '=' in a:
            k, v = a.split('=', 1)
            chosen[k] = v
    pack = {p['id']: p for p in json.load(open(PACK, encoding='utf-8'))['parts']}
    ledger = json.load(open(os.path.join(MESHY, 'ledger.json'), encoding='utf-8'))
    done = {a['key'] for a in ledger.get('attempts', []) if a.get('status') == 'SUCCEEDED'}
    textures = {}
    for pid, p in pack.items():
        variant = chosen.get(pid, default_variant)
        if f'{pid}/{variant}' not in done:
            others = [k.split('/')[1] for k in done if k.startswith(pid + '/')]
            if not others:
                continue
            variant = others[0]
        src = os.path.join(MESHY, pid, variant)
        dst = os.path.join(OUT, pid, variant)
        os.makedirs(dst, exist_ok=True)
        entry = {}
        for name, role in MAPS.items():
            f = os.path.join(src, name + '.png')
            if not os.path.exists(f):
                continue
            im = Image.open(f)
            im = im.convert('RGB') if role != 'albedo' else im.convert('RGBA')
            if im.size[0] > size:
                im = im.resize((size, size * im.size[1] // im.size[0]), Image.LANCZOS)
            out = os.path.join(dst, role + '.webp')
            im.save(out, 'WEBP', quality=92 if role == 'albedo' else 95, method=6)
            entry[role] = f'{pid}/{variant}/{role}.webp'
        entry['normalGreen'] = 'gl'
        entry['alpha'] = 'original'
        # installKeys (pack.py): every game glb whose material uses this texture on the same UVs (e.g. blade_01/02/03
        # share blade1_5; woman shoulders share the man's clothes_0N_sa). Older manifests: the part's own glb only.
        glb = p['game']['glb']
        keys = p.get('installKeys') or [glb.split('/out/', 1)[1][: -len('.glb')] + '#' + p['game']['material']['imageName']]
        for key in keys:
            textures[key] = entry
        print(f'{pid}: {variant} -> {", ".join(keys)}')
    manifest = {'format': 'sro-remaster', 'version': 1, 'textures': textures}
    os.makedirs(OUT, exist_ok=True)
    json.dump(manifest, open(os.path.join(OUT, 'manifest.json'), 'w', encoding='utf-8'), indent=1)
    print(f'{len(textures)} texture(s) installed in work/out/remaster/manifest.json')


if __name__ == '__main__':
    main(sys.argv[1:])
