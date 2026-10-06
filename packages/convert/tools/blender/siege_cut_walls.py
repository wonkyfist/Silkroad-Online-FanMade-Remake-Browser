# Siege of Jangan, layer 0 (docs/SIEGE.md §3.1): cuts Jangan's four retail outer walls into the pieces of the segment
# plan (content/siege/jangan.json): every third of the 33 segments (a, b, c) and the fixed, indestructible pieces (the
# corners and ends, the gatehouse), by vertical planes across the wall. Blender 5.2, headless:
#
#   blender --background --factory-startup --python siege_cut_walls.py -- <job.json>
#
# job.json (written by packages/convert/src/tools/siege-walls.ts, every path absolute):
#   { "sides": [ { "side": "W", "glb": ".../models/bldg/china/jangan_enter/cj_w.glb", "axis": "z",
#                  "pieces": [ { "id": "W-end0", "from": -1e6, "to": -198.0 }, { "id": "W1a", "from": ..., "to": ... },
#                              ... ],
#                  "out": ".../siege/models/cj_w_cut.glb" } ],
#     "report": ".../siege/cut-report.json" }
#   `from` / `to` are along the wall's axis in the model's own glTF frame (metres; x for N and S, z for W and E).
#
# Out, per side: one glb with one empty node per piece (named by its id: W3b, W-gate) holding that piece of every
# retail mesh (named <piece>|<retail mesh>), in the retail model's frame, so the client places it like the retail
# placement and shows or hides pieces by name. UV0 and the lightmap UV1 of every retail face are kept (bisect
# interpolates them on the cut), so a piece reuses the retail textures and lightmaps with no seam; the material extras
# (sroLightmap) go through with export_extras. Where a cut closes a loop of the wall body (wall01 / wall02 meshes) the
# cross-section is capped with the mesh's own material, planar UVs at the wall core's texel density and the lightmap UV
# of the nearest cut vertex, so a missing third shows solid stone, not the inside of a shell.
# The report lists per piece its triangles and glTF bounds (siege-walls.ts checks them against the retail model).
#
# Blender renames duplicate material names (CJ_w_roof.001); siege-walls.ts restores the retail names after the export.
import json
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector

sys.dont_write_bytecode = True

# The wall core's texture repeat along the wall (m per UV unit, cj_wall02), for the caps' planar UVs.
CAP_REPEAT_M = 6.6
CAPPED = ("_wall01", "_wall02")
BIG = 1e6


def blender_axis(axis):
    """glTF x -> Blender +X; glTF z -> Blender -Y (the importer's Y-up to Z-up turn). Returns (index, sign)."""
    return (0, 1.0) if axis == "x" else (1, -1.0)


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def cut_piece(src, lo, hi, axis, piece_id):
    """A copy of mesh object `src` clipped to lo <= glTF axis <= hi; None when nothing is left."""
    idx, sign = blender_axis(axis)
    # glTF [lo, hi] -> Blender [b0, b1] along idx
    b0, b1 = sorted((sign * lo, sign * hi))
    me = src.data.copy()
    bm = bmesh.new()
    bm.from_mesh(me)
    normal = Vector((0.0, 0.0, 0.0))
    normal[idx] = 1.0
    caps = []
    for at, keep_above in ((b0, True), (b1, False)):
        if abs(at) >= BIG * 0.5:
            continue
        co = Vector((0.0, 0.0, 0.0))
        co[idx] = at
        geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
        res = bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-5, plane_co=co, plane_no=normal,
                                     clear_inner=keep_above, clear_outer=not keep_above)
        cut_edges = [e for e in res["geom_cut"] if isinstance(e, bmesh.types.BMEdge) and e.is_valid]
        caps.append((at, cut_edges))
    if not bm.faces:
        bm.free()
        bpy.data.meshes.remove(me)
        return None
    if src.name.lower().endswith(CAPPED):
        for at, edges in caps:
            fill_cap(bm, [e for e in edges if e.is_valid and e.is_boundary], idx)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(f"{piece_id}|{src.name}", me)
    obj.matrix_world = src.matrix_world.copy()
    return obj


def fill_cap(bm, edges, idx):
    """Caps closed loops of boundary edges on a cut plane: planar UV0, UV1 from the nearest original loop."""
    if len(edges) < 3:
        return
    before = set(bm.faces)
    try:
        bmesh.ops.triangle_fill(bm, use_beauty=True, use_dissolve=False, edges=edges)
    except Exception as err:  # an open (non-closed) cut: nothing to cap
        print(f"cap skipped: {err}")
        return
    new = [f for f in bm.faces if f not in before]
    if not new:
        return
    uv_layers = bm.loops.layers.uv
    uv0 = uv_layers[0] if len(uv_layers) > 0 else None
    uv1 = uv_layers[1] if len(uv_layers) > 1 else None
    # the two in-plane axes: across the wall and up (Blender Z)
    across = 1 - idx if idx in (0, 1) else 0
    for f in new:
        f.smooth = False
        f.material_index = 0
        # outward: away from the piece's centre along the cut normal is what the fill guesses; keep its winding
        for loop in f.loops:
            v = loop.vert
            if uv0 is not None:
                loop[uv0].uv = (v.co[across] / CAP_REPEAT_M, -v.co[2] / CAP_REPEAT_M)
            if uv1 is not None:
                src = [l for l in v.link_loops if l.face not in new]
                if src:
                    loop[uv1].uv = src[0][uv1].uv.copy()


def bounds_gltf(obj):
    """World bounds of an object in glTF (x, y, z): Blender (x, y, z) -> glTF (x, z, -y)."""
    pts = [obj.matrix_world @ v.co for v in obj.data.vertices]
    if not pts:
        return None
    g = [(p.x, p.z, -p.y) for p in pts]
    return [[min(p[i] for p in g) for i in range(3)], [max(p[i] for p in g) for i in range(3)]]


def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def cut_side(job_side):
    clear_scene()
    bpy.ops.import_scene.gltf(filepath=job_side["glb"])
    sources = [o for o in bpy.data.objects if o.type == "MESH"]
    roots = [o for o in bpy.data.objects if o.type != "MESH"]
    report = {"side": job_side["side"], "pieces": []}
    made = []
    for piece in job_side["pieces"]:
        lo = max(-BIG, float(piece["from"]))
        hi = min(BIG, float(piece["to"]))
        holder = bpy.data.objects.new(piece["id"], None)
        bpy.context.scene.collection.objects.link(holder)
        tris = 0
        bmin, bmax = None, None
        for src in sources:
            obj = cut_piece(src, lo, hi, job_side["axis"], piece["id"])
            if obj is None:
                continue
            bpy.context.scene.collection.objects.link(obj)
            obj.parent = holder
            tris += tri_count(obj)
            b = bounds_gltf(obj)
            if b:
                bmin = b[0] if bmin is None else [min(bmin[i], b[0][i]) for i in range(3)]
                bmax = b[1] if bmax is None else [max(bmax[i], b[1][i]) for i in range(3)]
            made.append(obj)
        report["pieces"].append({"id": piece["id"], "triangles": tris, "min": bmin, "max": bmax})
    # the retail objects go; the pieces stay
    for o in sources + roots:
        bpy.data.objects.remove(o, do_unlink=True)
    out = Path(job_side["out"])
    out.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=str(out), export_format="GLB", export_extras=True, export_yup=True,
                              export_apply=False, export_animations=False)
    report["out"] = str(out)
    print(f"siege cut {job_side['side']}: {len(report['pieces'])} pieces, {len(made)} meshes -> {out}")
    return report


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(argv) != 1:
        raise SystemExit("usage: blender -b -P siege_cut_walls.py -- <job.json>")
    job = json.loads(Path(argv[0]).read_text(encoding="utf-8"))
    reports = [cut_side(s) for s in job["sides"]]
    Path(job["report"]).write_text(json.dumps({"sides": reports}, indent=1), encoding="utf-8")


main()
