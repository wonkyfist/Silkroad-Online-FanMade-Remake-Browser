# Licensed character pipeline, step 1 (docs/CHARACTERS.md §16): the River Spirit Waterbender (IdaFaber, Fab Standard
# License) FBX outfits -> plain glTF for the converter (licensed-char.ts). The pack itself is NEVER in git: this script
# reads it from --src and writes under --out (default work/licensed/waterbender/export, git-ignored).
#   blender -b --factory-startup --python packages/convert/src/tools/licensed/waterbender-export.py -- \
#     --src "<pack dir>" [--out work/licensed/waterbender/export] [--only f_01,m_01] [--no-lods]
# Keeps the artist's skeleton (Epic UE5 + hair/cloth bones) and skin weights untouched; only the FBX object transform
# (Maya cm, Z-up rotation) is applied so the armature object is identity in metres, facing -Y (glTF +Z). Materials are
# exported by name only: the converter assigns the (downscaled) textures.
#
# Lower LODs (CHARACTERS §16.8; --no-lods to skip): every mesh also as <name>__LOD1 / <name>__LOD2, simplified copies
# for distance (Decimate, collapse; the bought LOD0 geometry itself is never changed). Face and hands are protected (the
# collapse runs on everything else first: a vertex group of 1 - 0.9 x the head / hand / finger bones' weight); UVs and skin
# weights are interpolated by the collapse, normals smooth. Small inner parts (teeth, caruncles, lashes, helper shapes)
# are left out of the lower LODs. Same armature, same materials: the converter and the game treat them as parts.
import bpy, os, re, sys

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
def arg(k, d=None):
    return argv[argv.index(k) + 1] if k in argv else d
SRC = arg('--src') or os.environ.get('SRO_WATERBENDER_SRC')
OUT = arg('--out', os.path.join(os.getcwd(), 'work', 'licensed', 'waterbender', 'export'))
ONLY = set((arg('--only') or '').split(',')) - {''}
LODS = '--no-lods' not in argv
# Outfits from gear (CHARACTERS §16.9; --no-wardrobe for the old single-outfit files): every variant also carries every
# separated piece of its gender (clothes, the body slices under them, lingerie), each its own mesh at every LOD (the
# game shows the pieces the worn gear names and hides the body slices they cover), plus <name>.pieces.json: the pieces,
# which pieces cover each body slice (per vertex, as masks) and which clothes piece owns each texel of the shared
# clothes UV atlas (256², the crowd's per-outfit colour bake).
WARDROBE = '--no-wardrobe' not in argv
WARDROBE_SKIP = re.compile(r'HAIR|HEAD|BODY_FULL|NAILS', re.I)
OWN_SIZE = 256
RAY_M = float(arg("--ray", "0.15"))
# per LOD: the ratio of triangles kept by part (first match of the object name), None = left out
LOD_RULES = {
    1: [(r'CARUNCLE|TEETH|LASHES|Icosphere', None), (r'HEAD', 0.4), (r'EYES?', 0.3), (r'HAIR', 0.4), (r'BODY', 0.22), (r'.', 0.2)],
    2: [(r'CARUNCLE|TEETH|LASHES|Icosphere|EARRING|ROPE|EYES?', None), (r'HEAD', 0.1), (r'HAIR', 0.12), (r'BODY', 0.05), (r'.', 0.045)],
}
PROTECT = re.compile(r'^(head|neck_0[12]|hand_[lr]|(thumb|index|middle|ring|pinky)_\d\d_[lr]|.*(eye|jaw|lip|brow|cheek|nose|ear|teeth|tongue).*)$', re.I)
if not SRC or not os.path.isdir(SRC):
    raise SystemExit('waterbender-export: --src <pack dir> (or SRO_WATERBENDER_SRC) is required')
VARIANTS = [('f', n, os.path.join('FBX', 'Girl', f'SK_RIVERSPIRIT_F_{n}.fbx')) for n in ('01', '02', '03', '04')] + \
           [('m', n, os.path.join('FBX', 'Boy', f'SK_RIVERSPIRIT_M_{n}.fbx')) for n in ('01', '02', '03')]
os.makedirs(OUT, exist_ok=True)


def tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


TOGGLED = re.compile(r'_(TOP|SLEEVES|LAYERING|FRONT_CLOTH|SKIRT|TAILS|PANTS|CHAPS|GLOVES|SHOES|BELT(_cut)?|ROPE|FLOWERS|BODY_PART_\d\d|BRA|LINGERIE_[FM](_PANTS)?|LINGERIE_M)(__LOD\d)?$', re.I)


def is_toggled(name):
    return bool(TOGGLED.search(name))


def import_wardrobe(g, arm):
    """The separated pieces the variant lacks, bound to the variant's armature (same skeleton, same FBX transform)."""
    d = os.path.join(SRC, 'FBX', 'Girl' if g == 'f' else 'Boy', 'SeparatedMesh')
    have = {o.name for o in bpy.context.scene.objects}
    added = []
    for f in sorted(os.listdir(d)):
        name = os.path.splitext(f)[0]
        if not f.lower().endswith('.fbx') or WARDROBE_SKIP.search(name) or name in have:
            continue
        before = set(bpy.context.scene.objects)
        bpy.ops.import_scene.fbx(filepath=os.path.join(d, f), use_anim=False)
        new = [o for o in bpy.context.scene.objects if o not in before]
        for o in new:
            if o.type == 'MESH':
                mw = o.matrix_world.copy()
                o.parent = None
                o.matrix_world = mw
                for m in o.modifiers:
                    if m.type == 'ARMATURE':
                        m.object = arm
                added.append(o)
        for o in new:
            if o.type != 'MESH':
                bpy.data.objects.remove(o)
    # duplicated materials back to the variant's names (MAT_BODY.003 -> MAT_BODY); both lingeries -> MAT_LINGERIE
    for o in added:
        for i, m in enumerate(o.data.materials):
            if not m:
                continue
            base = re.sub(r'\.\d{3}$', '', m.name)
            if 'LINGERIE' in base:
                base = 'MAT_LINGERIE'
            want = bpy.data.materials.get(base) or bpy.data.materials.new(base)
            o.data.materials[i] = want
    print(f'waterbender-export: wardrobe +{len(added)} pieces: {", ".join(sorted(o.name for o in added))}')
    return added


def piece_key(name):
    base = re.sub(r'__LOD\d$', '', name)
    if 'LINGERIE' in base:
        return 'LINGERIE_TOP' if base.endswith('_BRA') else 'LINGERIE_BOTTOM'
    m = TOGGLED.search(base)
    return m.group(1).upper() if m else None


def coverage(meshes):
    """Per body slice: which clothes pieces cover each of its vertices (a ray out along the normal hits the piece within
    5 cm, or the piece is within 6 mm), as {mask: count}; and the clothes UV atlas owner of each texel (256²)."""
    from mathutils.bvhtree import BVHTree
    import numpy as np
    dg = bpy.context.evaluated_depsgraph_get()
    pieces = sorted([o for o in meshes if is_toggled(o.name) and '__LOD' not in o.name and 'BODY_PART' not in o.name], key=lambda o: o.name)
    keys = [piece_key(o.name) for o in pieces]
    trees = []
    for o in pieces:
        bm_verts = [o.matrix_world @ v.co for v in o.data.vertices]
        polys = [tuple(p.vertices) for p in o.data.polygons]
        trees.append(BVHTree.FromPolygons(bm_verts, polys))
    slices = {}
    for o in meshes:
        if 'BODY_PART' not in o.name or '__LOD' in o.name:
            continue
        counts = {}
        nm = o.matrix_world.to_3x3()
        for v in o.data.vertices:
            p = o.matrix_world @ v.co
            n = (nm @ v.normal).normalized()
            mask = 0
            for i, t in enumerate(trees):
                hit = t.ray_cast(p + n * 0.001, n, RAY_M)
                if hit[0] is not None:
                    mask |= 1 << i
                    continue
                near = t.find_nearest(p, 0.006)
                if near[0] is not None:
                    mask |= 1 << i
            counts[mask] = counts.get(mask, 0) + 1
        slices[piece_key(o.name)] = [[k, c] for k, c in sorted(counts.items(), key=lambda kv: -kv[1])]
    # texel owner: each clothes piece's UV triangles rasterised (piece index + 1; 0 = no piece)
    S = OWN_SIZE
    own = np.zeros((S, S), dtype=np.uint8)
    clash = 0
    for i, o in enumerate(pieces):
        if not any(m and m.name.startswith('MAT_CLOTHES') for m in o.data.materials):
            continue
        uv = o.data.uv_layers.active.data
        mine = np.zeros((S, S), dtype=bool)
        for poly in o.data.polygons:
            pts = [uv[li].uv for li in poly.loop_indices]
            for k in range(1, len(pts) - 1):
                tri = [(pts[0].x * S, (1 - pts[0].y) * S), (pts[k].x * S, (1 - pts[k].y) * S), (pts[k + 1].x * S, (1 - pts[k + 1].y) * S)]
                x0 = max(0, int(min(q[0] for q in tri))); x1 = min(S - 1, int(max(q[0] for q in tri)) + 1)
                y0 = max(0, int(min(q[1] for q in tri))); y1 = min(S - 1, int(max(q[1] for q in tri)) + 1)
                if x1 < x0 or y1 < y0:
                    continue
                xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
                (ax, ay), (bx, by), (cx, cy) = tri
                d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
                if abs(d) < 1e-12:
                    continue
                l1 = ((by - cy) * (xs - cx) + (cx - bx) * (ys - cy)) / d
                l2 = ((cy - ay) * (xs - cx) + (ax - cx) * (ys - cy)) / d
                inside = (l1 >= -0.02) & (l2 >= -0.02) & (1 - l1 - l2 >= -0.02)
                mine[y0:y1 + 1, x0:x1 + 1] |= inside
        clash += int(np.count_nonzero(mine & (own > 0)))
        own[mine & (own == 0)] = i + 1
    print(f'waterbender-export: texel owners {np.count_nonzero(own)} / {S * S}, shared {clash}')
    import base64
    return {'pieces': keys, 'slices': slices, 'ownerSize': S, 'owner': base64.b64encode(own.tobytes()).decode('ascii')}


def make_lods(meshes, arm):
    made = []
    for lod, rules in LOD_RULES.items():
        for o in meshes:
            ratio = next(r for pat, r in rules if re.search(pat, o.name, re.I))
            if ratio is None or tris(o) == 0:
                continue
            c = o.copy()
            c.data = o.data.copy()
            c.name = f'{o.name}__LOD{lod}'
            bpy.context.scene.collection.objects.link(c)
            # protect: the collapse takes edges with high weights first, so weight = 1 - (head / hand bones' weight)
            idx = {g.index: g.name for g in c.vertex_groups}
            vg = c.vertex_groups.new(name='lod_collapse')
            for v in c.data.vertices:
                prot = sum(e.weight for e in v.groups if e.group in idx and PROTECT.match(idx[e.group]))
                vg.add([v.index], 1.0 - 0.9 * min(1.0, prot), 'REPLACE')
            dec = c.modifiers.new('lod', 'DECIMATE')
            dec.decimate_type = 'COLLAPSE'
            dec.ratio = ratio
            dec.use_collapse_triangulate = True
            dec.vertex_group = 'lod_collapse'
            dec.vertex_group_factor = 4.0
            bpy.ops.object.select_all(action='DESELECT')
            bpy.context.view_layer.objects.active = c
            c.select_set(True)
            bpy.ops.object.modifier_move_to_index(modifier='lod', index=0)
            bpy.ops.object.modifier_apply(modifier='lod')
            c.vertex_groups.remove(c.vertex_groups['lod_collapse'])
            for p in c.data.polygons:
                p.use_smooth = True
            made.append((lod, c.name, tris(o), tris(c)))
    # one object per LOD: glTF splits it into a primitive per material, so the game draws a LOD in one mesh per
    # material (clothes, cloth, body, head, hair) instead of one per part (a lower LOD may be simplified; LOD0 stays)
    # with the wardrobe (§16.9) only the parts no gear toggles are joined (head, eyes, hair, earrings): the pieces and the
    # body slices stay their own objects so the game can show any combination (it merges what is shown per material)
    for lod in LOD_RULES:
        parts = [bpy.data.objects[n] for l, n, _, _ in made if l == lod and not (WARDROBE and is_toggled(n))]
        if not parts:
            continue
        bpy.ops.object.select_all(action='DESELECT')
        for o in parts:
            o.select_set(True)
        bpy.context.view_layer.objects.active = parts[0]
        bpy.ops.object.join()
        parts[0].name = f'SK_WATERBENDER__LOD{lod}'
        print(f'waterbender-export: LOD{lod} {tris(parts[0])} tris in one object, {len(parts[0].data.materials)} materials (LOD0 {sum(tris(o) for o in meshes)})')
    return made


for g, n, rel in VARIANTS:
    key = f'{g}_{n}'
    if ONLY and key not in ONLY:
        continue
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=os.path.join(SRC, rel), use_anim=False)
    scene = bpy.context.scene
    arm = next(o for o in scene.objects if o.type == 'ARMATURE')
    if WARDROBE:
        import_wardrobe(g, arm)
    meshes = [o for o in scene.objects if o.type == 'MESH']
    for o in [o for o in scene.objects if o.type == 'EMPTY']:
        bpy.data.objects.remove(o)
    # meshes: unparent keeping world, bake transforms into the vertices
    for o in meshes:
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = mw
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes + [arm]:
        o.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    arm.name = 'waterbender_armature'
    for o in meshes:
        o.parent = arm
        o.matrix_parent_inverse.identity()
        mods = [m for m in o.modifiers if m.type == 'ARMATURE']
        if not mods:
            mods = [o.modifiers.new('Armature', 'ARMATURE')]
        mods[0].object = arm
        o.data.shape_keys and o.shape_key_clear()
    pieces = coverage(meshes) if WARDROBE else None
    if LODS:
        make_lods(meshes, arm)
    # materials by name only (textures come from the converter)
    for m in bpy.data.materials:
        m.use_nodes = True
        nt = m.node_tree
        nt.nodes.clear()
        bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        nt.links.new(bsdf.outputs[0], out.inputs[0])
    for im in list(bpy.data.images):
        bpy.data.images.remove(im)
    path = os.path.join(OUT, f'waterbender_{key}.glb')
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', export_animations=False, export_skins=True,
                              export_morph=False, export_yup=True, export_apply=False, export_materials='EXPORT')
    if pieces:
        import json
        with open(os.path.join(OUT, f'waterbender_{key}.pieces.json'), 'w') as fh:
            json.dump(pieces, fh)
    print(f'waterbender-export: {key} -> {path} ({len(meshes)} meshes, {len(arm.data.bones)} bones)')
