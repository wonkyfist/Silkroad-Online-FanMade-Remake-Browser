"""Blender headless: render the original pack parts vs the Meshy PBR results under the same studio lighting.

blender --background --factory-startup --python work/remaster/tools/lit_compare.py
Writes work/remaster/meshy/lit_original.png, lit_meshy.png and lit_compare.png (side by side, if PIL is available).
"""
import os
import bpy
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
PACK = os.path.join(ROOT, 'work', 'remaster', 'pack')
MESHY = os.path.join(ROOT, 'work', 'remaster', 'meshy')
PARTS = ['chinaman_adventurer_body', 'chinaman_adventurer_hair', 'ch_m_heavy_01_ba', 'ch_m_heavy_01_la', 'ch_m_heavy_01_fa']


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_EEVEE_NEXT' if 'BLENDER_EEVEE_NEXT' in [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items] else 'BLENDER_EEVEE'
    scene.render.resolution_x = 900
    scene.render.resolution_y = 1200
    scene.view_settings.view_transform = 'AgX'
    world = bpy.data.worlds.new('w')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs[0].default_value = (0.45, 0.47, 0.5, 1)
    world.node_tree.nodes['Background'].inputs[1].default_value = 0.6
    scene.world = world
    return scene


def lights(center):
    def area(name, loc, energy, size, color=(1, 1, 1)):
        d = bpy.data.lights.new(name, 'AREA')
        d.energy, d.size, d.color = energy, size, color
        o = bpy.data.objects.new(name, d)
        o.location = center + Vector(loc)
        o.rotation_mode = 'QUATERNION'
        o.rotation_quaternion = (center - o.location).to_track_quat('-Z', 'Y')
        bpy.context.collection.objects.link(o)
    area('key', (1.2, 1.6, 0.8), 180, 1.2, (1.0, 0.95, 0.88))
    area('fill', (-1.4, 1.0, 0.2), 60, 1.5, (0.85, 0.9, 1.0))
    area('rim', (0.0, -1.6, 1.0), 140, 0.8)


def load(paths):
    objs = []
    for p in paths:
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=p)
        objs += [o for o in bpy.data.objects if o not in before and o.type == 'MESH']
    return objs


def pbr(objs, maps, cutout=False):
    """Swap each object's Principled BSDF to the Meshy maps (base colour keeps the original alpha for cutouts)."""
    for o in objs:
        for slot in o.material_slots:
            mat = slot.material
            if not mat or not mat.use_nodes:
                continue
            nt = mat.node_tree
            bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
            orig = next((n for n in nt.nodes if n.type == 'TEX_IMAGE'), None)

            def tex(path, colour):
                n = nt.nodes.new('ShaderNodeTexImage')
                n.image = bpy.data.images.load(path)
                n.image.colorspace_settings.name = 'sRGB' if colour else 'Non-Color'
                return n
            base = tex(maps['base_color'], True)
            nt.links.new(base.outputs['Color'], bsdf.inputs['Base Color'])
            if orig is not None and cutout:
                nt.links.new(orig.outputs['Alpha'], bsdf.inputs['Alpha'])
            if 'metallic' in maps:
                nt.links.new(tex(maps['metallic'], False).outputs['Color'], bsdf.inputs['Metallic'])
            if 'roughness' in maps:
                nt.links.new(tex(maps['roughness'], False).outputs['Color'], bsdf.inputs['Roughness'])
            if 'normal' in maps:
                nm = nt.nodes.new('ShaderNodeNormalMap')
                nt.links.new(tex(maps['normal'], False).outputs['Color'], nm.inputs['Color'])
                nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])


def render(paths, out, remaster=False):
    scene = reset()
    objs = []
    for p in paths:
        part_objs = load([p])
        objs += part_objs
        if remaster:
            part = os.path.basename(os.path.dirname(p))
            d = os.path.join(MESHY, part, 'multiview')
            pbr(part_objs, cutout=part in ('chinaman_adventurer_body', 'chinaman_adventurer_hair'), maps={k: os.path.join(d, k + '.png') for k in ('base_color', 'metallic', 'roughness', 'normal') if os.path.exists(os.path.join(d, k + '.png'))})
    lo = Vector((min(v[i] for o in objs for v in [o.matrix_world @ c.co for c in o.data.vertices]) for i in range(3)))
    hi = Vector((max(v[i] for o in objs for v in [o.matrix_world @ c.co for c in o.data.vertices]) for i in range(3)))
    center = (lo + hi) / 2
    # frame the upper body (armour chest) more tightly than the whole figure
    target = Vector((center.x, center.y, lo.z + (hi.z - lo.z) * 0.62))
    cam_data = bpy.data.cameras.new('cam')
    cam_data.lens = 70
    cam = bpy.data.objects.new('cam', cam_data)
    # glTF +Z forward becomes Blender -Y; the model faces the camera placed on -Y
    cam.location = target + Vector((0.35, -3.2, 0.15))
    cam.rotation_mode = 'QUATERNION'
    cam.rotation_quaternion = (target - cam.location).to_track_quat('-Z', 'Y')
    bpy.context.collection.objects.link(cam)
    scene.camera = cam
    lights(target)
    scene.render.filepath = out
    bpy.ops.render.render(write_still=True)


render([os.path.join(PACK, p, 'model.glb') for p in PARTS], os.path.join(MESHY, 'lit_original.png'))
render([os.path.join(PACK, p, 'model.glb') for p in PARTS], os.path.join(MESHY, 'lit_meshy.png'), remaster=True)
