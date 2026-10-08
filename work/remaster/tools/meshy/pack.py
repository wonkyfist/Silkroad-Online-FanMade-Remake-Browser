"""
Meshy retexture pack (work/remaster/pack/, git-ignored with the rest of work/).

The parts come from scope.json next to this file (one part = one retail texture = one Meshy job; see its "about").
For every part this writes, under work/remaster/pack/<id>/:
  model.glb        static glb (bind pose, no skin/armature/animations), ONE material with the ORIGINAL texture
                   embedded byte-for-byte, POSITION/NORMAL/TEXCOORD_0/indices copied byte-for-byte from the game glb(s)
                   (de-interleaved into tight accessors), metres (the converter already wrote metres). A part whose
                   texture is shared by several game meshes (extraSources, e.g. sword_02 + sword_03 on sword1_2_3) packs
                   them all; layout "spread" places them side by side with node translations (vertex bytes untouched).
                   A packed mesh whose game material draws differently (alpha cutout, double-sided) carries it in its
                   node extras.gameMaterial; the renders honour it, the pack material stays the representative's.
  texture.png      the original texture as the game glb embeds it (same bytes as the image inside model.glb).
  view_front.png, view_back.png, view_left.png, view_right.png
                   1024x1024 renders of the original textured part, orthographic, flat unlit colours, transparent
                   background (Blender EEVEE, emission-only materials, Standard view transform).
and work/remaster/pack/manifest.json (full record) + work/remaster/pack/pack.json (the adapter meshy-retexture.ts
reads with --pack: parts[{id, glb, renders[4], prompt?}], paths relative to the pack folder).

No network, no credentials: this never reads work/secrets and never talks to Meshy.

Run (from anywhere; plain CPython 3.12, stdlib only, Blender is called for the renders):
  python work/remaster/tools/meshy/pack.py            # build + render + verify
  python work/remaster/tools/meshy/pack.py build      # glbs, textures, manifest.json, pack.json only
  python work/remaster/tools/meshy/pack.py render     # renders only (needs build); skips parts whose 4 views are
                                                      # newer than their model.glb unless --force
  python work/remaster/tools/meshy/pack.py verify     # UV/geometry byte checks + sizes against the game glbs
  options: --only a,b (render these part ids)  --force (re-render)
           --jobs N (parallel Blender renders, default 1: several EEVEE instances at once crashed Blender 5.2 here)
Blender entry (called by 'render'):
  blender --background --factory-startup --python pack.py -- render-part <model.glb> <outdir>
"""
import concurrent.futures
import hashlib
import json
import math
import os
import struct
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))
OUT = os.path.join(REPO, 'work', 'out')
PACK = os.path.join(REPO, 'work', 'remaster', 'pack')
BLENDER = os.environ.get('BLENDER_EXE', r'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe')
SIZE_LIMIT = 20 * 1024 * 1024
VIEW_SIZE = 1024
VIEWS = ['front', 'back', 'left', 'right']
VIEW_CONVENTION = (
  'Camera placement relative to the part as worn/held in the pack glb frame (glTF +Y up, the model faces +Z): '
  'front = camera on +Z looking at the face/chest; back = camera on -Z; left = camera on the model\'s own left '
  '(+X) looking at its left flank; right = camera on the model\'s own right (-X). Orthographic, framed to the '
  'part bounds with 6% margin, flat unlit texture colours (no shading), transparent background.'
)
# glTF -90 deg about X: +Z (sword tip) -> +Y, so the sword stands upright blade-up for the renders.
SWORD_UPRIGHT = [-math.sqrt(0.5), 0.0, 0.0, math.sqrt(0.5)]
# 180 deg about Y after SWORD_UPRIGHT: +Z (shield top) -> +Y, +Y (the outer face, away from the forearm) -> +Z (front).
SHIELD_FRONT = [0.0, math.sqrt(0.5), math.sqrt(0.5), 0.0]
ROTATIONS = {'upright': SWORD_UPRIGHT, 'shield-front': SHIELD_FRONT}
# layout "spread": gap between packed meshes, as a share of the largest extent of any of them.
SPREAD_GAP = 0.08

SCOPE_FILE = os.path.join(HERE, 'scope.json')
PROMPTS_FILE = os.path.join(HERE, 'prompts.json')


def load_parts():
  """scope.json parts, each with 'sources' (the representative glb/material/meshes first, then extraSources)."""
  with open(SCOPE_FILE, 'r', encoding='utf-8') as f:
    scope = json.load(f)
  parts, seen = [], set()
  for p in scope['parts']:
    if p['id'] in seen:
      raise ValueError(f'scope.json: duplicate part id {p["id"]}')
    seen.add(p['id'])
    rot = p.get('rotation')
    if isinstance(rot, str):
      if rot not in ROTATIONS:
        raise ValueError(f'{p["id"]}: unknown rotation {rot!r}')
      rot = ROTATIONS[rot]
    sources = [{'glb': p['glb'], 'material': p['material'], 'meshes': p['meshes']}] + list(p.get('extraSources', []))
    parts.append({**p, 'rotation': rot, 'sources': sources, 'layout': p.get('layout'),
                  'sharedWith': p.get('sharedWith', []), 'prompt': None})
  return parts


# ---------------------------------------------------------------------------------------------------------------
# glb read/write (stdlib only)

COMP_SIZE = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
TYPE_COUNT = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def read_glb(path):
  with open(path, 'rb') as f:
    data = f.read()
  magic, version, length = struct.unpack_from('<III', data, 0)
  if magic != 0x46546C67 or version != 2 or length != len(data):
    raise ValueError(f'not a glb v2: {path}')
  jlen, jtype = struct.unpack_from('<II', data, 12)
  if jtype != 0x4E4F534A:
    raise ValueError(f'first chunk is not JSON: {path}')
  gltf = json.loads(data[20:20 + jlen].decode('utf-8'))
  off = 20 + jlen
  binary = b''
  if off < len(data):
    blen, btype = struct.unpack_from('<II', data, off)
    if btype != 0x004E4942:
      raise ValueError(f'second chunk is not BIN: {path}')
    binary = data[off + 8:off + 8 + blen]
  return gltf, binary


def accessor_bytes(gltf, binary, index):
  """The accessor's elements as tightly packed bytes (strided views are de-interleaved, bytes untouched)."""
  acc = gltf['accessors'][index]
  if 'sparse' in acc:
    raise ValueError('sparse accessors are not supported')
  view = gltf['bufferViews'][acc['bufferView']]
  elem = COMP_SIZE[acc['componentType']] * TYPE_COUNT[acc['type']]
  stride = view.get('byteStride') or elem
  start = view.get('byteOffset', 0) + acc.get('byteOffset', 0)
  count = acc['count']
  if stride == elem:
    return binary[start:start + elem * count]
  return b''.join(binary[start + i * stride:start + i * stride + elem] for i in range(count))


def image_bytes(gltf, binary, index):
  img = gltf['images'][index]
  view = gltf['bufferViews'][img['bufferView']]
  start = view.get('byteOffset', 0)
  return binary[start:start + view['byteLength']]


def pad4(b, fill=b'\x00'):
  return b + fill * ((4 - len(b) % 4) % 4)


def vec_minmax(raw, n):
  vals = struct.unpack(f'<{len(raw) // 4}f', raw)
  lo = [min(vals[i::n]) for i in range(n)]
  hi = [max(vals[i::n]) for i in range(n)]
  return lo, hi


class GlbWriter:
  def __init__(self):
    self.bin = bytearray()
    self.views = []
    self.accessors = []

  def view(self, data, target=None):
    while len(self.bin) % 4:
      self.bin.append(0)
    v = {'buffer': 0, 'byteOffset': len(self.bin), 'byteLength': len(data)}
    if target:
      v['target'] = target
    self.bin.extend(data)
    self.views.append(v)
    return len(self.views) - 1

  def accessor(self, data, component, type_, count, target, minmax=False):
    a = {'bufferView': self.view(data, target), 'componentType': component, 'count': count, 'type': type_}
    if minmax:
      a['min'], a['max'] = vec_minmax(data, TYPE_COUNT[type_])
    self.accessors.append(a)
    return len(self.accessors) - 1

  def encode(self, gltf):
    gltf['bufferViews'] = self.views
    gltf['accessors'] = self.accessors
    gltf['buffers'] = [{'byteLength': len(self.bin)}]
    js = pad4(json.dumps(gltf, separators=(',', ':')).encode('utf-8'), b' ')
    bn = pad4(bytes(self.bin))
    total = 12 + 8 + len(js) + 8 + len(bn)
    return (struct.pack('<III', 0x46546C67, 2, total) + struct.pack('<II', len(js), 0x4E4F534A) + js
            + struct.pack('<II', len(bn), 0x004E4942) + bn)


def write_if_changed(path, data):
  """Writes only when the bytes differ, so unchanged parts keep their mtime (render skips them)."""
  if os.path.exists(path):
    with open(path, 'rb') as f:
      if f.read() == data:
        return False
  with open(path, 'wb') as f:
    f.write(data)
  return True


# ---------------------------------------------------------------------------------------------------------------
# build

def rel(p):
  return os.path.relpath(p, REPO).replace('\\', '/')


def sha256(data):
  return hashlib.sha256(data).hexdigest()


def game_mesh_prims(gltf, material_index, names):
  """[(mesh name, primitive, node)] for the requested meshes; each must use exactly the requested material."""
  by_name = {m['name']: m for m in gltf['meshes']}
  nodes = {n['mesh']: n for n in gltf['nodes'] if 'mesh' in n}
  used = sorted(m['name'] for m in gltf['meshes'] if any(p.get('material') == material_index for p in m['primitives']))
  if used != sorted(names):
    raise ValueError(f'material {material_index} is used by {used}, part lists {sorted(names)}')
  out = []
  for name in names:
    mesh = by_name[name]
    if len(mesh['primitives']) != 1:
      raise ValueError(f'{name}: expected one primitive')
    prim = mesh['primitives'][0]
    node = nodes[gltf['meshes'].index(mesh)]
    for key in ('translation', 'rotation', 'scale', 'matrix'):
      if key in node:
        raise ValueError(f'{name}: mesh node has a transform ({key}); bind-pose copy would be wrong')
    if prim.get('mode', 4) != 4:
      raise ValueError(f'{name}: not a triangle list')
    out.append((name, prim, node))
  return out


def load_prompts():
  if not os.path.exists(PROMPTS_FILE):
    return {}
  with open(PROMPTS_FILE, 'r', encoding='utf-8') as f:
    return json.load(f)


def read_sidecar(glb_rel):
  with open(os.path.join(OUT, *glb_rel[:-4].split('/')) + '.json', 'r', encoding='utf-8') as f:
    return json.load(f)


def sidecar_material(sidecar, name):
  """The sidecar material of a glb material (names can differ in case: Heavy_02_aa vs heavy_02_aa)."""
  mats = sidecar.get('materials', [])
  return (next((m for m in mats if m['name'] == name), None)
          or next((m for m in mats if m['name'].lower() == name.lower()), None) or {})


def load_source(src):
  """A packed source: the game glb, its material/texture, and the requested meshes."""
  path = os.path.join(OUT, *src['glb'].split('/'))
  gltf, binary = read_glb(path)
  mat_index = next(i for i, m in enumerate(gltf['materials']) if m['name'] == src['material'])
  mat = gltf['materials'][mat_index]
  tex_index = mat['pbrMetallicRoughness']['baseColorTexture']['index']
  tex = gltf['textures'][tex_index]
  img_index = tex['source']
  png = image_bytes(gltf, binary, img_index)
  if png[:8] != b'\x89PNG\r\n\x1a\n':
    raise ValueError(f'{src["glb"]}: the game glb texture is not a PNG')
  return {'src': src, 'path': path, 'gltf': gltf, 'binary': binary, 'matIndex': mat_index, 'mat': mat,
          'texIndex': tex_index, 'tex': tex, 'imgIndex': img_index, 'img': gltf['images'][img_index], 'png': png,
          'prims': game_mesh_prims(gltf, mat_index, src['meshes'])}


def draw_state(mat):
  return (mat.get('alphaMode', 'OPAQUE'), mat.get('alphaCutoff') if mat.get('alphaMode') == 'MASK' else None,
          bool(mat.get('doubleSided', False)))


def spread_offsets(bounds):
  """Node translations (pre-rotation frame) that place the packed meshes side by side along X and staggered along Y,
  so the front/back views (and, after SWORD_UPRIGHT, the left/right views) show every mesh separately."""
  big = max(max(hi[k] - lo[k] for k in range(3)) for lo, hi in bounds)
  gap = SPREAD_GAP * big
  xs, cursor = [], 0.0
  for lo, hi in bounds:
    xs.append(cursor - lo[0])
    cursor = xs[-1] + hi[0] + gap
  mid = (cursor - gap) / 2
  depth = max(hi[1] - lo[1] for lo, hi in bounds) + gap
  n = len(bounds)
  return [[round(x - mid, 6), round((i - (n - 1) / 2) * depth, 6), 0.0] for i, x in enumerate(xs)]


def material_info(s, sidecar, tex_w, tex_h):
  side_mat = sidecar_material(sidecar, s['mat']['name'])
  return {
    'name': s['mat']['name'],
    'index': s['matIndex'],
    'textureIndex': s['texIndex'],
    'imageIndex': s['imgIndex'],
    'imageName': s['img'].get('name'),
    'sourceTexture': side_mat.get('texture'),
    'sourceFormat': side_mat.get('textureFormat'),
    'textureSize': [tex_w, tex_h],
    'alphaMode': s['mat'].get('alphaMode', 'OPAQUE'),
    'alphaCutoff': s['mat'].get('alphaCutoff'),
    'doubleSided': bool(s['mat'].get('doubleSided', False)),
    'alphaNote': side_mat.get('alphaReason'),
  }


def install_key(glb_rel, image_name):
  """apps/game/src/three/remaster.ts key: <glb path under /out/ without .glb>#<glTF image name>."""
  return glb_rel[:-4] + '#' + image_name


def build_part(part, prompts):
  loaded = [load_source(s) for s in part['sources']]
  rep = loaded[0]
  png = rep['png']
  for s in loaded[1:]:
    if s['png'] != png:
      raise ValueError(f'{part["id"]}: {s["src"]["glb"]}#{s["src"]["material"]} embeds a different texture')
  tex_w, tex_h = struct.unpack('>II', png[16:24])
  src_mat = rep['mat']

  w = GlbWriter()
  meshes, nodes, mesh_info = [], [], []
  items = [(s, name, prim) for s in loaded for name, prim, _node in s['prims']]
  names = [name for _s, name, _p in items]
  if len(set(names)) != len(names):
    raise ValueError(f'{part["id"]}: packed mesh names are not unique: {names}')
  offsets = [None] * len(items)
  if part['layout'] == 'spread' and len(items) > 1:
    bounds = [vec_minmax(accessor_bytes(s['gltf'], s['binary'], prim['attributes']['POSITION']), 3)
              for s, _name, prim in items]
    offsets = spread_offsets(bounds)
  elif part['layout'] not in (None, 'spread'):
    raise ValueError(f'{part["id"]}: unknown layout {part["layout"]!r}')

  for (s, name, prim), offset in zip(items, offsets):
    gltf, binary = s['gltf'], s['binary']
    attrs = prim['attributes']
    pos = accessor_bytes(gltf, binary, attrs['POSITION'])
    nrm = accessor_bytes(gltf, binary, attrs['NORMAL'])
    uv = accessor_bytes(gltf, binary, attrs['TEXCOORD_0'])
    idx_acc = gltf['accessors'][prim['indices']]
    idx = accessor_bytes(gltf, binary, prim['indices'])
    n = gltf['accessors'][attrs['POSITION']]['count']
    for key, acc_i in (('NORMAL', attrs['NORMAL']), ('TEXCOORD_0', attrs['TEXCOORD_0'])):
      acc = gltf['accessors'][acc_i]
      if acc['componentType'] != 5126 or acc['count'] != n or acc.get('normalized'):
        raise ValueError(f'{name}: {key} is not a float accessor of {n} elements')
    new_prim = {
      'attributes': {
        'POSITION': w.accessor(pos, 5126, 'VEC3', n, 34962, minmax=True),
        'NORMAL': w.accessor(nrm, 5126, 'VEC3', n, 34962),
        'TEXCOORD_0': w.accessor(uv, 5126, 'VEC2', n, 34962),
      },
      'indices': w.accessor(idx, idx_acc['componentType'], 'SCALAR', idx_acc['count'], 34963),
      'material': 0,
    }
    meshes.append({'name': name, 'primitives': [new_prim]})
    node = {'name': name, 'mesh': len(meshes) - 1}
    if offset:
      node['translation'] = offset
    if draw_state(s['mat']) != draw_state(src_mat):
      alpha, cutoff, double = draw_state(s['mat'])
      node['extras'] = {'gameMaterial': {'name': s['mat']['name'], 'alphaMode': alpha, 'alphaCutoff': cutoff,
                                         'doubleSided': double}}
    nodes.append(node)
    uv_lo, uv_hi = vec_minmax(uv, 2)
    info = {'name': name, 'vertices': n, 'triangles': idx_acc['count'] // 3,
            'uvSha256': sha256(uv), 'uvMin': uv_lo, 'uvMax': uv_hi}
    if len(loaded) > 1:
      info['source'] = {'file': rel(s['path']), 'material': s['mat']['name']}
    if offset:
      info['translation'] = offset
    mesh_info.append(info)

  children = list(range(len(nodes)))
  root = {'name': part['id'], 'children': children}
  if part['rotation']:
    root['rotation'] = part['rotation']
  nodes.append(root)

  img_view = w.view(png)
  material = {
    'name': src_mat['name'],
    'pbrMetallicRoughness': {'baseColorTexture': {'index': 0}, 'metallicFactor': 0, 'roughnessFactor': 1},
  }
  for key in ('alphaMode', 'alphaCutoff', 'doubleSided'):
    if key in src_mat:
      material[key] = src_mat[key]
  src_tex = rep['tex']
  sampler = rep['gltf']['samplers'][src_tex['sampler']] if 'sampler' in src_tex else {}
  out_gltf = {
    'asset': {'version': '2.0', 'generator': 'silkroad remaster pack (work/remaster/tools/meshy/pack.py)'},
    'scene': 0,
    'scenes': [{'name': part['id'], 'nodes': [len(nodes) - 1]}],
    'nodes': nodes,
    'meshes': meshes,
    'materials': [material],
    'textures': [{'source': 0, 'sampler': 0}],
    'samplers': [sampler],
    'images': [{'name': rep['img'].get('name', part['material']), 'mimeType': 'image/png', 'bufferView': img_view}],
  }
  outdir = os.path.join(PACK, part['id'])
  os.makedirs(outdir, exist_ok=True)
  glb_path = os.path.join(outdir, 'model.glb')
  glb_bytes = w.encode(out_gltf)
  if len(glb_bytes) >= SIZE_LIMIT:
    raise ValueError(f'{part["id"]}: {len(glb_bytes)} bytes >= 20 MB')
  write_if_changed(glb_path, glb_bytes)
  tex_path = os.path.join(outdir, 'texture.png')
  write_if_changed(tex_path, png)

  sidecars = {}
  for s in loaded:
    sidecars.setdefault(s['src']['glb'], read_sidecar(s['src']['glb']))
  sidecar = sidecars[rep['src']['glb']]
  prompt = prompts.get(part['id'])
  if prompt is not None and len(prompt) > 800:
    raise ValueError(f'{part["id"]}: prompt is {len(prompt)} chars (> 800)')

  def game_ref(glb_rel):
    return {'glb': '/out/' + glb_rel, 'glbOpt': '/out-opt/' + glb_rel, 'sidecar': '/out/' + glb_rel[:-4] + '.json',
            'file': rel(os.path.join(OUT, *glb_rel.split('/')))}

  sources = []
  for s in loaded:
    sources.append({**game_ref(s['src']['glb']), 'source': sidecars[s['src']['glb']].get('source'),
                    'material': material_info(s, sidecars[s['src']['glb']], tex_w, tex_h), 'meshes': s['src']['meshes']})
  shared = []
  for sh in part['sharedWith']:
    sg, sb = read_glb(os.path.join(OUT, *sh['glb'].split('/')))
    mi = next(i for i, m in enumerate(sg['materials']) if m['name'] == sh['material'])
    ii = sg['textures'][sg['materials'][mi]['pbrMetallicRoughness']['baseColorTexture']['index']]['source']
    if image_bytes(sg, sb, ii) != png:
      raise ValueError(f'{part["id"]}: sharedWith {sh["glb"]} embeds a different texture')
    for name, prim, _node in game_mesh_prims(sg, mi, sh['meshes']):
      want = next(m for m in mesh_info if m['name'] == name)
      if sha256(accessor_bytes(sg, sb, prim['attributes']['TEXCOORD_0'])) != want['uvSha256']:
        raise ValueError(f'{part["id"]}: sharedWith {sh["glb"]}:{name} has different UVs; pack it as a source instead')
    shared.append({**game_ref(sh['glb']), 'material': sh['material'], 'imageName': sg['images'][ii].get('name'),
                   'meshes': sh['meshes']})
  keys = []
  for s in loaded:
    k = install_key(s['src']['glb'], s['img'].get('name'))
    if k not in keys:
      keys.append(k)
  for sh in shared:
    k = install_key(sh['glb'][len('/out/'):], sh['imageName'])
    if k not in keys:
      keys.append(k)

  return {
    'id': part['id'],
    'label': part['label'],
    'codes': part['codes'],
    'category': part.get('category'),
    'tier': part.get('tier'),
    'priority': part.get('priority'),
    'level': part.get('level'),
    'degrees': part.get('degrees'),
    'game': {**game_ref(rep['src']['glb']), 'source': sidecar.get('source'),
             'material': material_info(rep, sidecar, tex_w, tex_h), 'meshes': part['meshes']},
    'sources': sources,
    'sharedWith': shared,
    'installKeys': keys,
    'glb': rel(glb_path),
    'glbBytes': len(glb_bytes),
    'glbSha256': sha256(glb_bytes),
    'originalTexture': rel(tex_path),
    'originalTextureSha256': sha256(png),
    'packRootRotation': part['rotation'],
    'layout': part['layout'],
    'meshes': mesh_info,
    'views': {v: rel(os.path.join(outdir, f'view_{v}.png')) for v in VIEWS},
    'prompt': prompt,
    'promptChars': len(prompt) if prompt else 0,
  }


def build():
  prompts = load_prompts()
  entries = [build_part(p, prompts) for p in load_parts()]
  manifest = {
    'version': 1,
    'generator': 'work/remaster/tools/meshy/pack.py',
    'purpose': 'Meshy Retexture pack (enable_original_uv: textures must land on the game UVs unchanged)',
    'scope': rel(SCOPE_FILE),
    'units': 'metres, glTF +Y up, model faces +Z (converter frame); bind pose, no skin',
    'uvContract': ('Each pack glb carries TEXCOORD_0 copied byte-for-byte from the game glb(s) under /out/ '
                   '(float32, same vertex order per mesh); the textures Meshy bakes on these UVs apply to the '
                   'game materials in sources[] / sharedWith[] (installKeys) without any UV change. /out-opt/ glbs '
                   'hold the same UVs quantized by glTF-Transform (see verify.optUv).'),
    'viewOrder': VIEWS,
    'viewConvention': VIEW_CONVENTION,
    'viewSize': [VIEW_SIZE, VIEW_SIZE],
    'parts': entries,
  }
  old = os.path.join(PACK, 'manifest.json')
  if os.path.exists(old):
    with open(old, 'r', encoding='utf-8') as f:
      prev = json.load(f)
    if 'verify' in prev:
      ids = {e['id'] for e in entries}
      manifest['verify'] = {k: [r for r in v if r.get('id') in ids] if isinstance(v, list) else v
                            for k, v in prev['verify'].items()}
  write_manifest(manifest)
  write_pack_json(entries)
  for e in entries:
    print(f"built {e['id']}: {e['glb']} {e['glbBytes']} bytes, {len(e['meshes'])} mesh(es), prompt {e['promptChars']} chars")
  return manifest


def write_manifest(manifest):
  os.makedirs(PACK, exist_ok=True)
  with open(os.path.join(PACK, 'manifest.json'), 'w', encoding='utf-8', newline='\n') as f:
    json.dump(manifest, f, indent=2)
    f.write('\n')


def write_pack_json(entries):
  """The adapter packages/convert/src/remaster/meshy.ts loadPack reads (paths relative to the pack folder)."""
  parts = []
  for e in entries:
    p = {'id': e['id'], 'glb': f"{e['id']}/model.glb", 'renders': [f"{e['id']}/view_{v}.png" for v in VIEWS]}
    if e['prompt']:
      p['prompt'] = e['prompt']
    parts.append(p)
  with open(os.path.join(PACK, 'pack.json'), 'w', encoding='utf-8', newline='\n') as f:
    json.dump({'parts': parts}, f, indent=1)


def read_manifest():
  with open(os.path.join(PACK, 'manifest.json'), 'r', encoding='utf-8') as f:
    return json.load(f)


# ---------------------------------------------------------------------------------------------------------------
# verify (pure python): the pack glb against the game glb(s)

def verify():
  manifest = read_manifest()
  results = []
  ok = True
  cache = {}

  def game_glb(file):
    if file not in cache:
      cache[file] = read_glb(os.path.join(REPO, *file.split('/')))
    return cache[file]

  with open(os.path.join(PACK, 'pack.json'), 'r', encoding='utf-8') as f:
    adapter = {p['id']: p for p in json.load(f)['parts']}
  for e in manifest['parts']:
    pack, pbin = read_glb(os.path.join(REPO, *e['glb'].split('/')))
    checks = {'uv': True, 'position': True, 'normal': True, 'indices': True}
    verts = 0
    info = {m['name']: m for m in e['meshes']}
    for m in pack['meshes']:
      file = info[m['name']].get('source', {}).get('file', e['game']['file'])
      game, gbin = game_glb(file)
      gp = {gm['name']: gm['primitives'][0] for gm in game['meshes']}[m['name']]
      pp = m['primitives'][0]
      for key in ('TEXCOORD_0', 'POSITION', 'NORMAL'):
        same = accessor_bytes(pack, pbin, pp['attributes'][key]) == accessor_bytes(game, gbin, gp['attributes'][key])
        checks[{'TEXCOORD_0': 'uv', 'POSITION': 'position', 'NORMAL': 'normal'}[key]] &= same
      checks['indices'] &= accessor_bytes(pack, pbin, pp['indices']) == accessor_bytes(game, gbin, gp['indices'])
      verts += pack['accessors'][pp['attributes']['POSITION']]['count']
    img = image_bytes(pack, pbin, 0)
    tex_same = True
    for s in e.get('sources') or [e['game']]:
      game, gbin = game_glb(s['file'])
      tex_same &= img == image_bytes(game, gbin, s['material']['imageIndex'])
    size = os.path.getsize(os.path.join(REPO, *e['glb'].split('/')))
    a = adapter.get(e['id'], {})
    r = {
      'id': e['id'],
      'uvByteIdentical': checks['uv'],
      'positionByteIdentical': checks['position'],
      'normalByteIdentical': checks['normal'],
      'indicesByteIdentical': checks['indices'],
      'textureByteIdentical': tex_same,
      'meshCount': len(pack['meshes']) == len(e['meshes']),
      'singleMaterial': len(pack['materials']) == 1 and all(
        p.get('material') == 0 for m in pack['meshes'] for p in m['primitives']),
      'noSkin': 'skins' not in pack and 'animations' not in pack,
      'vertices': verts,
      'glbBytes': size,
      'under20MB': size < SIZE_LIMIT,
      'views': all(os.path.exists(os.path.join(REPO, *p.split('/'))) for p in e['views'].values()),
      # The text-prompt variant is retired (multiview only); a prompt is optional but must fit Meshy's 800 chars.
      'promptOk': e['prompt'] is None or len(e['prompt']) <= 800,
      'inPackJson': a.get('glb') == f"{e['id']}/model.glb" and a.get('renders') == [f"{e['id']}/view_{v}.png" for v in VIEWS],
    }
    good = all(v for k, v in r.items() if isinstance(v, bool))
    ok &= good
    results.append(r)
    print(('OK  ' if good else 'FAIL'), json.dumps(r))
  ok &= len(adapter) == len(manifest['parts'])
  manifest['verify'] = {**manifest.get('verify', {}), 'pack': results}
  write_manifest(manifest)
  print(f"verify: {sum(1 for r in results if all(v for v in r.values() if isinstance(v, bool)))}/{len(results)} parts OK")
  return ok


# ---------------------------------------------------------------------------------------------------------------
# render (Blender side)

def flat_material(mat, src_mat):
  """Replace the imported PBR tree with image colour -> Emission (strength 1); alpha cutout only for MASK."""
  if not mat.use_nodes:
    return
  nt = mat.node_tree
  tex = next((n for n in nt.nodes if n.type == 'TEX_IMAGE'), None)
  if tex is None:
    raise RuntimeError(f'{mat.name}: no image texture after import')
  image = tex.image
  interpolation = tex.interpolation
  nt.nodes.clear()
  out = nt.nodes.new('ShaderNodeOutputMaterial')
  tex = nt.nodes.new('ShaderNodeTexImage')
  tex.image = image
  tex.interpolation = interpolation
  emit = nt.nodes.new('ShaderNodeEmission')
  emit.inputs['Strength'].default_value = 1.0
  nt.links.new(tex.outputs['Color'], emit.inputs['Color'])
  mat.use_backface_culling = not src_mat.get('doubleSided', False)  # as the game draws it
  if src_mat.get('alphaMode') == 'MASK':
    cut = nt.nodes.new('ShaderNodeMath')
    cut.operation = 'GREATER_THAN'
    cut.inputs[1].default_value = src_mat.get('alphaCutoff') or 0.5
    nt.links.new(tex.outputs['Alpha'], cut.inputs[0])
    clear = nt.nodes.new('ShaderNodeBsdfTransparent')
    mix = nt.nodes.new('ShaderNodeMixShader')
    nt.links.new(cut.outputs[0], mix.inputs['Fac'])
    nt.links.new(clear.outputs[0], mix.inputs[1])
    nt.links.new(emit.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs['Surface'])
    mat.surface_render_method = 'DITHERED'
  else:
    nt.links.new(emit.outputs[0], out.inputs['Surface'])


def render_part(glb_path, outdir):
  import bpy
  from mathutils import Vector

  bpy.ops.wm.read_factory_settings(use_empty=True)
  bpy.ops.import_scene.gltf(filepath=glb_path)
  gltf, _ = read_glb(glb_path)
  src_mat = gltf['materials'][0]
  scene = bpy.context.scene
  # EEVEE with an emission-only material = flat, unlit texture colours; MASK materials keep their alpha cutout
  # (Workbench ignores texture alpha, which turned the hair cards into a solid helmet).
  scene.render.engine = 'BLENDER_EEVEE'
  scene.eevee.taa_render_samples = 64
  scene.world = bpy.data.worlds.new('none')
  scene.world.color = (0, 0, 0)
  # Packed meshes whose game material draws differently (node extras.gameMaterial) get their own material copy.
  overrides = {n['name']: n['extras']['gameMaterial'] for n in gltf['nodes']
               if isinstance(n.get('extras'), dict) and 'gameMaterial' in n['extras']}
  per_material = {}
  for o in scene.objects:
    if o.type == 'MESH' and o.name in overrides and o.material_slots:
      copy = o.material_slots[0].material.copy()
      o.material_slots[0].material = copy
      per_material[copy.name] = overrides[o.name]
  if len(per_material) != len(overrides):
    raise RuntimeError(f'material overrides: {sorted(overrides)} vs objects {[o.name for o in scene.objects]}')
  for mat in bpy.data.materials:
    flat_material(mat, per_material.get(mat.name, src_mat))
  scene.render.resolution_x = VIEW_SIZE
  scene.render.resolution_y = VIEW_SIZE
  scene.render.resolution_percentage = 100
  scene.render.film_transparent = True
  scene.render.image_settings.file_format = 'PNG'
  scene.render.image_settings.color_mode = 'RGBA'
  scene.render.image_settings.color_depth = '8'
  scene.view_settings.view_transform = 'Standard'
  scene.view_settings.look = 'None'
  scene.view_settings.exposure = 0
  scene.view_settings.gamma = 1

  meshes = [o for o in scene.objects if o.type == 'MESH']
  deps = bpy.context.evaluated_depsgraph_get()
  pts = []
  for o in meshes:
    ev = o.evaluated_get(deps)
    mw = ev.matrix_world
    pts.extend(mw @ v.co for v in ev.data.vertices)
  lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
  hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
  center = (lo + hi) / 2
  ext = hi - lo
  # One orthographic scale for all four views, so the views agree on size (multiview reference images).
  ortho = max(ext) * 1.12
  dist = max(ext) * 4 + 1

  cam_data = bpy.data.cameras.new('cam')
  cam_data.type = 'ORTHO'
  cam_data.clip_start = 0.01
  cam_data.clip_end = dist * 4
  cam = bpy.data.objects.new('cam', cam_data)
  scene.collection.objects.link(cam)
  scene.camera = cam

  # glTF -> Blender: (x, y, z) -> (x, -z, y). The model faces glTF +Z = Blender -Y; its own left is +X.
  views = {
    'front': Vector((0, -1, 0)),
    'back': Vector((0, 1, 0)),
    'left': Vector((1, 0, 0)),
    'right': Vector((-1, 0, 0)),
  }
  cam_data.ortho_scale = ortho
  for name, direction in views.items():
    cam.location = center + direction * dist
    cam.rotation_euler = (-direction).to_track_quat('-Z', 'Y').to_euler()
    scene.render.filepath = os.path.join(outdir, f'view_{name}.png')
    bpy.ops.render.render(write_still=True)
    print('rendered', scene.render.filepath)


def views_current(glb, outdir):
  paths = [os.path.join(outdir, f'view_{v}.png') for v in VIEWS]
  return all(os.path.exists(p) for p in paths) and min(os.path.getmtime(p) for p in paths) >= os.path.getmtime(glb)


RENDER_TRIES = 3


def render_one(e, script):
  """Renders one part; retries, since Blender 5.2 crashed now and then in the AMD OpenGL driver (atio6axx.dll)."""
  glb = os.path.join(REPO, *e['glb'].split('/'))
  outdir = os.path.dirname(glb)
  cmd = [BLENDER, '--background', '--factory-startup', '--python', script, '--', 'render-part', glb, outdir]
  err = None
  for attempt in range(1, RENDER_TRIES + 1):
    res = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace')
    if res.returncode == 0 and views_current(glb, outdir):
      if attempt > 1:
        print(f'{e["id"]}: rendered on try {attempt}', flush=True)
      return e['id'], None
    crash = next((line.strip() for line in (res.stdout + res.stderr).splitlines() if 'EXCEPTION_' in line or 'Module' in line), '')
    print(f'{e["id"]}: blender try {attempt}/{RENDER_TRIES} failed (exit {res.returncode}) {crash}', flush=True)
    err = res.stdout[-3000:] + '\n' + res.stderr[-3000:]
  return e['id'], err


def render(only=None, jobs=1, force=False):
  manifest = read_manifest()
  script = os.path.abspath(__file__)
  todo = []
  for e in manifest['parts']:
    if only and e['id'] not in only:
      continue
    glb = os.path.join(REPO, *e['glb'].split('/'))
    if not force and views_current(glb, os.path.dirname(glb)):
      continue
    todo.append(e)
  print(f'render: {len(todo)} part(s) to render, {jobs} at a time')
  failed = []
  with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, jobs)) as pool:
    for pid, err in pool.map(lambda e: render_one(e, script), todo):
      if err:
        print(err)
        failed.append(pid)
      print(f'rendered {pid}' if not err else f'RENDER FAILED {pid}', flush=True)
  if failed:
    raise RuntimeError(f'blender render failed for {failed}')


def main(argv):
  if '--' in argv:
    args = argv[argv.index('--') + 1:]
    if args and args[0] == 'render-part':
      render_part(args[1], args[2])
      return 0
  args = argv[1:]
  opt = {}
  rest = []
  i = 0
  while i < len(args):
    if args[i] in ('--only', '--jobs'):
      opt[args[i]] = args[i + 1]
      i += 2
    elif args[i] == '--force':
      opt['--force'] = True
      i += 1
    else:
      rest.append(args[i])
      i += 1
  cmd = rest[0] if rest else 'all'
  if cmd not in ('all', 'build', 'render', 'verify'):
    print(__doc__)
    return 2
  only = set(opt['--only'].split(',')) if '--only' in opt else None
  if cmd in ('build', 'all'):
    build()
  if cmd in ('render', 'all'):
    render(only, int(opt.get('--jobs', 1)), bool(opt.get('--force')))
  if cmd in ('verify', 'all'):
    return 0 if verify() else 1
  return 0


if __name__ == '__main__':
  code = main(sys.argv)
  if 'bpy' not in sys.modules:
    sys.exit(code)
