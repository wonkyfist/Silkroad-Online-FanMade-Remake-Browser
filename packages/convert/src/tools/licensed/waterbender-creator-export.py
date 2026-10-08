# Licensed character pipeline, the creator's parts (docs/CHARACTERS.md §16.10): the River Spirit Waterbender pack's
# underwear body and its separable pieces -> plain glTF for the converter (licensed-creator.ts). The pack is NEVER in
# git: this script reads it from --src and writes under --out (default work/licensed/waterbender/export, git-ignored).
#   blender -b --factory-startup --python packages/convert/src/tools/licensed/waterbender-creator-export.py -- \
#     --src "<pack dir>" [--out work/licensed/waterbender/export] [--only f,m]
# Writes per body (f, m):
#   waterbender_<g>_base.glb   the body in the pack's lingerie (head, eyes, lashes, teeth, full body, lingerie; no hair)
#   waterbender_<g>_parts.glb  the hairstyles (HAIR_01, its bangs, HAIR_02, HAIR_03, each with __LOD1 / __LOD2 copies)
#                              and the accessories (girl: EARRINGS, HAIR_FLOWER, NAILS)
# The lingerie FBX and the separated pieces carry their own, smaller armatures (144 / 61 bones). Every mesh is bound
# here to the outfit's full armature (SK_RIVERSPIRIT_<G>_01.fbx: 230 / 187 joints) by vertex-group name, so all glbs of a
# body share one joint list (the game binds the parts to the outfit body's skeleton by index; the converter checks it).
# The artist's weights and geometry are untouched; only the FBX object transform is applied (as waterbender-export.py).
import bpy, os, re, sys
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
def arg(k, d=None):
    return argv[argv.index(k) + 1] if k in argv else d
SRC = arg('--src') or os.environ.get('SRO_WATERBENDER_SRC')
OUT = arg('--out', os.path.join(os.getcwd(), 'work', 'licensed', 'waterbender', 'export'))
ONLY = set((arg('--only') or 'f,m').split(',')) - {''}
if not SRC or not os.path.isdir(SRC):
    raise SystemExit('waterbender-creator-export: --src <pack dir> (or SRO_WATERBENDER_SRC) is required')
os.makedirs(OUT, exist_ok=True)

G = {
    'f': {
        'dir': 'Girl', 'full': 'SK_RIVERSPIRIT_F_01.fbx', 'lingerie': 'SK_RIVERSPIRIT_F_Lingerie.fbx',
        'parts': ['HAIR_01', 'HAIR_01_Bangs', 'HAIR_02', 'HAIR_03', 'EARRINGS', 'HAIR_FLOWER', 'NAILS'],
    },
    'm': {
        'dir': 'Boy', 'full': 'SK_RIVERSPIRIT_M_01.fbx', 'lingerie': 'SK_RIVERSPIRIT_M_Lingerie.fbx',
        'parts': ['HAIR_01', 'HAIR_01_BANGS', 'HAIR_02', 'HAIR_03'],
    },
}
# hair LODs (as waterbender-export.py's HAIR rule): LOD1 0.4, LOD2 0.12 of the triangles
HAIR_LODS = {1: 0.4, 2: 0.12}


def tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


def import_fbx(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=path, use_anim=False)
    new = [o for o in bpy.data.objects if o not in before]
    keep = [o for o in new if o.type != 'EMPTY']
    for o in [o for o in new if o.type == 'EMPTY']:
        bpy.data.objects.remove(o)
    return keep


def bake(objs):
    """Applies the FBX object transform (cm, Z-up) to meshes and armatures: identity objects in metres."""
    meshes = [o for o in objs if o.type == 'MESH']
    for o in meshes:
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = mw
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = next(o for o in objs if o.type == 'ARMATURE')
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def rebind(meshes, own_arm, full):
    """Binds `meshes` to the full armature (vertex groups are bone names) and checks the rest poses agree."""
    worst = 0.0
    used = {vg.name for o in meshes for vg in o.vertex_groups}
    for b in own_arm.data.bones:
        fb = full.data.bones.get(b.name)
        if fb and b.name in used:
            worst = max(worst, (Vector(b.head_local) - Vector(fb.head_local)).length)
    missing = set()
    for o in meshes:
        for vg in o.vertex_groups:
            if vg.name not in full.data.bones:
                missing.add(vg.name)
        o.parent = full
        o.matrix_parent_inverse.identity()
        mods = [m for m in o.modifiers if m.type == 'ARMATURE'] or [o.modifiers.new('Armature', 'ARMATURE')]
        mods[0].object = full
        o.data.shape_keys and o.shape_key_clear()
    bpy.data.objects.remove(own_arm)
    return worst, missing


def hair_lods(o):
    out = []
    for lod, ratio in HAIR_LODS.items():
        c = o.copy()
        c.data = o.data.copy()
        c.name = f'{o.name}__LOD{lod}'
        bpy.context.scene.collection.objects.link(c)
        dec = c.modifiers.new('lod', 'DECIMATE')
        dec.decimate_type = 'COLLAPSE'
        dec.ratio = ratio
        dec.use_collapse_triangulate = True
        bpy.ops.object.select_all(action='DESELECT')
        bpy.context.view_layer.objects.active = c
        c.select_set(True)
        bpy.ops.object.modifier_move_to_index(modifier='lod', index=0)
        bpy.ops.object.modifier_apply(modifier='lod')
        for p in c.data.polygons:
            p.use_smooth = True
        out.append(c)
    return out


def plain_materials():
    for m in bpy.data.materials:
        m.use_nodes = True
        nt = m.node_tree
        nt.nodes.clear()
        bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        nt.links.new(bsdf.outputs[0], out.inputs[0])
    for im in list(bpy.data.images):
        bpy.data.images.remove(im)


def export(path, keep):
    bpy.ops.object.select_all(action='DESELECT')
    for o in keep:
        o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', export_animations=False, export_skins=True, use_selection=True,
                              export_morph=False, export_yup=True, export_apply=False, export_materials='EXPORT')


for g, spec in G.items():
    if g not in ONLY:
        continue
    base = os.path.join(SRC, 'FBX', spec['dir'])
    for what in ('base', 'parts'):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        full_objs = import_fbx(os.path.join(base, spec['full']))
        bake(full_objs)
        full = next(o for o in full_objs if o.type == 'ARMATURE')
        for o in [o for o in full_objs if o.type == 'MESH']:
            bpy.data.objects.remove(o)
        full.name = 'waterbender_armature'
        keep = []
        if what == 'base':
            objs = import_fbx(os.path.join(base, spec['lingerie']))
            bake(objs)
            arm = next(o for o in objs if o.type == 'ARMATURE')
            meshes = [o for o in objs if o.type == 'MESH']
            # the creator's body is bare-headed: the hair comes from the parts (the chosen style)
            for o in [o for o in meshes if re.search(r'HAIR', o.name)]:
                bpy.data.objects.remove(o)
                meshes.remove(o)
            worst, missing = rebind(meshes, arm, full)
            keep = meshes
            print(f'waterbender-creator-export: {g} base: {len(meshes)} meshes, rest off by {worst * 100:.3f} cm, groups not in the full armature: {sorted(missing)}')
        else:
            for p in spec['parts']:
                path = os.path.join(base, 'SeparatedMesh', f'SK_RIVERSPIRIT_{g.upper()}_{p}.fbx')
                objs = import_fbx(path)
                bake(objs)
                arm = next(o for o in objs if o.type == 'ARMATURE')
                meshes = [o for o in objs if o.type == 'MESH']
                worst, missing = rebind(meshes, arm, full)
                for o in meshes:
                    keep.append(o)
                    if 'HAIR' in p.upper() and 'FLOWER' not in p.upper():
                        keep.extend(hair_lods(o))
                print(f'waterbender-creator-export: {g} part {p}: {[o.name for o in meshes]} {sum(tris(o) for o in meshes)} tris, rest off by {worst * 100:.3f} cm, missing groups {sorted(missing)}')
        plain_materials()
        out = os.path.join(OUT, f'waterbender_{g}_{what}.glb')
        export(out, keep + [full])
        print(f'waterbender-creator-export: {g} {what} -> {out} ({len(keep)} meshes, {len(full.data.bones)} bones)')
