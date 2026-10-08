"""Blender headless renders for the bake-off: the same geometry (pack glbs, game UVs), cameras and lights for every
variant; only the material maps change.

blender --background --factory-startup --python render_bakeoff.py -- <spec.json>
spec = {"subject": "armour"|"body"|"sword", "out_dir": ..., "shots": [...],
        "parts": ["chinaman_adventurer_body", ...],
        "variants": [{"name": "A", "maps": {"<part>": {"albedo": p, "normal": p|null, "orm": p|null,
                                                       "metallic": p|null, "roughness": p|null}}}, ...]}
Cut-out parts (body, hair) always take their alpha from the retail texture (same silhouette for every variant);
the armour/weapon alpha is a spec mask and is ignored (opaque), as in lit_compare.py.
Maps: normal = OpenGL/glTF tangent space; orm = R AO (multiplied into base colour), G roughness, B metallic.
"""
import json
import math
import os
import sys

import bpy
from mathutils import Vector

spec = json.load(open(sys.argv[sys.argv.index('--') + 1]))
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
PACK = os.path.join(ROOT, 'work', 'remaster', 'pack')
CUTOUT = set(spec.get('cutout') or ['chinaman_adventurer_body', 'chinaman_adventurer_hair'])   # w9b: per-spec list
out_dir = spec['out_dir']; os.makedirs(out_dir, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.engine = 'BLENDER_EEVEE'
try:
    sc.eevee.taa_render_samples = 48
    sc.eevee.use_shadows = True
    sc.eevee.use_raytracing = True
except Exception:
    pass
sc.view_settings.view_transform = 'AgX'
sc.render.image_settings.file_format = 'PNG'
sc.render.film_transparent = False
world = bpy.data.worlds.new('W'); sc.world = world; world.use_nodes = True
bg = world.node_tree.nodes['Background']
bg.inputs[0].default_value = (0.20, 0.21, 0.23, 1)

# ------------------------------------------------------------------ geometry
objs = {}
for part in spec['parts']:
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(PACK, part, 'model.glb'), merge_vertices=False)
    objs[part] = [o for o in bpy.data.objects if o not in before]
meshes = {p: [o for o in v if o.type == 'MESH'] for p, v in objs.items()}
for o in bpy.data.objects:          # w9b review: body meshes an equipment piece replaces in game (bind-pose clipping)
    if o.type == 'MESH' and any(h.lower() in o.name.lower() for h in spec.get('hide', [])):
        o.hide_render = True

if spec['subject'] == 'sword':
    root = bpy.data.objects.new('ROOT', None); sc.collection.objects.link(root)
    for o in objs['ch_sword_01']:
        if o.parent is None:
            o.parent = root
    root.rotation_euler = (0, math.radians(90), 0)          # blade along world X, tip to +X
    bpy.context.view_layer.update()


def bounds(obs):
    pts = [o.matrix_world @ Vector(c) for o in obs for c in o.bound_box]
    lo = Vector([min(p[i] for p in pts) for i in range(3)]); hi = Vector([max(p[i] for p in pts) for i in range(3)])
    return lo, hi


# ------------------------------------------------------------------ materials
def load_img(path, colour):
    img = bpy.data.images.load(path, check_existing=True)
    img.colorspace_settings.name = 'sRGB' if colour else 'Non-Color'
    img.alpha_mode = 'CHANNEL_PACKED'          # never premultiply: armour alpha is a spec mask
    return img


def make_material(part, m):
    mat = bpy.data.materials.new(f'{part}_{m.get("tag", "v")}'); mat.use_nodes = True
    nt = mat.node_tree; bs = nt.nodes['Principled BSDF']
    bs.inputs['Roughness'].default_value = 0.7; bs.inputs['Metallic'].default_value = 0.0
    alb = nt.nodes.new('ShaderNodeTexImage'); alb.image = load_img(m['albedo'], True); alb.interpolation = 'Linear'
    base_out = alb.outputs['Color']
    if m.get('orm'):
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = load_img(m['orm'], False)
        sp = nt.nodes.new('ShaderNodeSeparateColor'); nt.links.new(t.outputs['Color'], sp.inputs['Color'])
        nt.links.new(sp.outputs['Green'], bs.inputs['Roughness']); nt.links.new(sp.outputs['Blue'], bs.inputs['Metallic'])
        mix = nt.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'; mix.blend_type = 'MULTIPLY'
        mix.inputs['Factor'].default_value = 1.0
        nt.links.new(base_out, mix.inputs[6]); nt.links.new(sp.outputs['Red'], mix.inputs[7]); base_out = mix.outputs[2]
    if m.get('metallic'):
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = load_img(m['metallic'], False)
        nt.links.new(t.outputs['Color'], bs.inputs['Metallic'])
    if m.get('roughness'):
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = load_img(m['roughness'], False)
        nt.links.new(t.outputs['Color'], bs.inputs['Roughness'])
    if m.get('normal'):
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = load_img(m['normal'], False)
        nm = nt.nodes.new('ShaderNodeNormalMap'); nm.inputs['Strength'].default_value = 1.0
        nt.links.new(t.outputs['Color'], nm.inputs['Color']); nt.links.new(nm.outputs['Normal'], bs.inputs['Normal'])
    nt.links.new(base_out, bs.inputs['Base Color'])
    if part in CUTOUT:
        a = nt.nodes.new('ShaderNodeTexImage'); a.image = load_img(os.path.join(PACK, part, 'texture.png'), True)
        a.interpolation = 'Linear'
        gt = nt.nodes.new('ShaderNodeMath'); gt.operation = 'GREATER_THAN'; gt.inputs[1].default_value = 0.5
        nt.links.new(a.outputs['Alpha'], gt.inputs[0]); nt.links.new(gt.outputs[0], bs.inputs['Alpha'])
        try:
            mat.surface_render_method = 'DITHERED'
        except Exception:
            pass
    mat.use_backface_culling = False
    return mat


# ------------------------------------------------------------------ lights and cameras
lights = []


def area(name, loc, target, energy, size, color=(1, 1, 1)):
    l = bpy.data.lights.new(name, 'AREA'); l.energy = energy; l.size = size; l.color = color
    o = bpy.data.objects.new(name, l); sc.collection.objects.link(o); o.location = loc
    o.rotation_euler = (target - o.location).to_track_quat('-Z', 'Y').to_euler()
    lights.append(o)
    return o


def clear_lights():
    for o in lights:
        bpy.data.objects.remove(o)
    lights.clear()


cam_d = bpy.data.cameras.new('cam'); cam = bpy.data.objects.new('cam', cam_d); sc.collection.objects.link(cam)
sc.camera = cam


def aim(pos, target, lens=85, ortho=None):
    cam.location = pos; cam.rotation_euler = (target - pos).to_track_quat('-Z', 'Y').to_euler()
    if ortho:
        cam_d.type = 'ORTHO'; cam_d.ortho_scale = ortho
    else:
        cam_d.type = 'PERSP'; cam_d.lens = lens


def studio(c, s):
    """key / fill / rim around point c, scale s (metres)."""
    area('key', c + Vector((1.0, -1.5, 0.9)) * s, c, 260 * s * s, 0.7 * s, (1.0, 0.96, 0.9))
    area('fill', c + Vector((-1.5, -1.0, 0.3)) * s, c, 70 * s * s, 1.2 * s, (0.88, 0.93, 1.0))
    area('rim', c + Vector((-0.3, 1.6, 1.0)) * s, c, 200 * s * s, 0.6 * s)
    bg.inputs[1].default_value = 0.55


def grazing(c, s, side=1):
    """low, raking key light almost parallel to the front surface: shows relief."""
    area('graze', c + Vector((1.9 * side, -0.35, 0.12)) * s, c + Vector((0, -0.05, 0)) * s, 420 * s * s, 0.25 * s, (1.0, 0.95, 0.88))
    area('fill', c + Vector((-1.4, -1.2, 0.4)) * s, c, 14 * s * s, 1.2 * s, (0.85, 0.9, 1.0))
    bg.inputs[1].default_value = 0.18


SHOTS = {
    # armoured figure / bare body (bind pose, faces -Y in Blender)
    'chest': dict(cam=((0.42, -1.62, 1.47), (0.02, 0, 1.33), 85), res=(920, 1100), light=('studio', (0, 0, 1.33), 1.6)),
    'chest_grazing': dict(cam=((0.42, -1.62, 1.47), (0.02, 0, 1.33), 85), res=(920, 1100), light=('grazing', (0, 0, 1.33), 1.0)),
    'mid': dict(cam=((2.1, -4.7, 2.55), (0, 0, 0.92), 85), res=(460, 620), light=('studio', (0, 0, 0.95), 2.4)),
    'face': dict(cam=((0.22, -0.95, 1.66), (0.0, 0, 1.6), 85), res=(920, 1100), light=('studio', (0, 0, 1.6), 1.0)),
    'torso': dict(cam=((0.35, -2.2, 1.25), (0.0, 0, 1.08), 85), res=(920, 1100), light=('studio', (0, 0, 1.1), 1.6)),
    'face_grazing': dict(cam=((0.22, -0.95, 1.66), (0.0, 0, 1.6), 85), res=(920, 1100), light=('grazing', (0, 0, 1.6), 0.6)),
    # sword laid along +X
    'sword': dict(ortho='full', res=(1400, 520), light=('studio', None, 1.0)),
    'hilt': dict(ortho='hilt', res=(1100, 700), light=('studio', None, 0.6)),
    'sword_grazing': dict(ortho='full', res=(1400, 520), light=('grazing', None, 0.8)),
}


for _k, _v in (spec.get('shot_defs') or {}).items():   # w9b review: extra shots in the same format
    SHOTS[_k] = dict(cam=(tuple(_v['cam'][0]), tuple(_v['cam'][1]), _v['cam'][2]), res=tuple(_v['res']),
                     light=(_v['light'][0], tuple(_v['light'][1]), _v['light'][2]))


def setup_shot(name):
    s = SHOTS[name]; clear_lights()
    sc.render.resolution_x, sc.render.resolution_y = s['res']
    if 'ortho' in s:
        lo, hi = bounds(meshes['ch_sword_01']); c = (lo + hi) / 2; L = (hi - lo).x
        if s['ortho'] == 'full':
            aim(c + Vector((0.0, -1.2, 0.35)), c, ortho=L * 1.04); cc = c
        else:                                   # guard + grip end (the -X end after the rotation)
            cc = Vector((lo.x + 0.23 * L, c.y, c.z)); aim(cc + Vector((0.0, -0.8, 0.25)), cc, ortho=L * 0.42)
        kind, _, sz = s['light']
        (studio if kind == 'studio' else grazing)(cc, sz)
        return
    pos, tgt, lens = s['cam']; aim(Vector(pos), Vector(tgt), lens)
    kind, c, sz = s['light']
    (studio if kind == 'studio' else grazing)(Vector(c), sz)


# ------------------------------------------------------------------ render loop
for v in spec['variants']:
    mats = {}
    for part, m in v['maps'].items():
        mm = dict(m, tag=v['name']); mats[part] = make_material(part, mm)
    for part, obs in meshes.items():
        for o in obs:
            for slot in o.material_slots:
                slot.link = 'OBJECT'; slot.material = mats[part]
    for shot in spec['shots']:
        setup_shot(shot)
        sc.render.filepath = os.path.join(out_dir, f'{v["name"]}_{shot}.png')
        bpy.ops.render.render(write_still=True)
        print('WROTE', sc.render.filepath, flush=True)
    for part in list(mats):          # free the variant's images before the next one
        mat = mats.pop(part)
        for n in mat.node_tree.nodes:
            if n.type == 'TEX_IMAGE' and n.image and n.image.users <= 1:
                bpy.data.images.remove(n.image)
        bpy.data.materials.remove(mat)
