/**
 * The static-variant pass (docs/BATCHING.md §3.5; lane BT-C owns this file): for each skinned foliage model a remaining
 * placement uses, a static glb posed at frame 0 of its default clip with the skin removed. ./passes.ts appends each
 * returned variant to `models` and sets `models[of].staticVariant`. The variant is a plain file next to the skinned
 * one (`models/<stem>.static.glb` + `.static.json`), so `optimize-out` gives it the same meshopt + quantization pass as
 * every model.
 *
 * Runs after the coast's C9 edits (./passes.ts), so it only sees the placements that remain.
 *
 * The bake (bakeStaticPose), per skinned primitive:
 * - every channel of the clip that targets a node's translation / rotation / scale is set to its first key (frame 0;
 *   a CUBICSPLINE output's value, not its tangent); joints the clip does not animate keep their rest pose;
 * - jointMatrix_j = world(joint_j) x inverseBind_j; each vertex is moved by the weight-blended joint matrix, exactly as
 *   the GPU skins it (glTF §3.7.3.3: the skinned node's own transform is ignored), normals and tangents by its 3 x 3
 *   and re-normalized;
 * - JOINTS_n / WEIGHTS_n, the skins, the joint nodes and every animation are removed; the mesh nodes go under one root
 *   node with the identity transform (the layout of a static convert: gltf/convert.ts `staticRoot`).
 * Materials, textures, UVs (TEXCOORD_1 lightmaps included), indices and node / mesh names are kept, so the game's
 * material rules (foliage, lamp, tuft stems) see the same model. Quantized input (KHR_mesh_quantization, meshopt) is
 * dequantized first, so the pass also works on an optimized export.
 *
 * The variant's `source` is the skinned model's plus `#static`: isFoliageModel and the tuft stem (grass/types.ts
 * modelStem) still match it, and the retail scatter's by-file-name lookup (scatter-assets.ts retailModelFor) does not
 * pick it up, so the Low path is unchanged.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type Accessor, type Document, type Node, type Primitive, type Property } from '@gltf-transform/core'
import { dequantize } from '@gltf-transform/functions'
import type { Sidecar } from '../gltf/convert.ts'
import type { Vec3 } from '../gltf/space.ts'
import { validateGlb } from '../gltf/validate.ts'
import { gltfIO } from '../optimize/io.ts'
import type { WorldModel } from './manifest.ts'
import type { StaticVariant, StaticVariantPass, WorldPassContext } from './passes.ts'

/**
 * The foliage rule, the same as packages/world-render/src/pbr/classes.ts FOLIAGE_MODEL (static-variant.test.ts keeps
 * the two equal; the converter does not import the renderer): trees, grass, flowers and reeds under res\nature.
 */
export const FOLIAGE_MODEL = /[\\/]nature[\\/](common|china[\\/][^\\/]+)[\\/](tree\d*|grass|flower|reed)[\\/]/i

export function isFoliageModel(source: string): boolean {
  return FOLIAGE_MODEL.test(source)
}

/** The suffix on a variant's `source` (see the header). */
export const STATIC_SOURCE_SUFFIX = '#static'

/** 'models/a/b.glb' -> 'models/a/b.static.glb' (also for the sidecar's .json). */
export function staticPath(rel: string): string {
  return rel.replace(/(\.[^./]*)$/, '.static$1')
}

export interface BakeResult {
  /** The clip whose frame 0 was used, or null (no clip: the rest pose). */
  clip: string | null
  /** Primitives moved by a skin. */
  skinnedPrimitives: number
  /** Vertices with no weight (left where they are). */
  unweighted: number
  /** Posed bounds of every mesh (m). */
  boundsMin: Vec3
  boundsMax: Vec3
  warnings: string[]
}

type Mat4 = number[]

/** Column-major 4 x 4 product a * b. */
function mul(a: readonly number[], b: readonly number[]): Mat4 {
  const out = new Array<number>(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!
    }
  }
  return out
}

const IDENTITY: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** The value of a sampler at its first key (frame 0): element 0, or the CUBICSPLINE value (element 1). */
function firstKey(output: Accessor, cubic: boolean): number[] {
  return output.getElement(cubic ? 1 : 0, [])
}

/** Sets every node the clip animates to the clip's first key. Returns the clip used. */
function poseAtFrame0(doc: Document, clipName: string | null, warnings: string[]): string | null {
  const anims = doc.getRoot().listAnimations()
  if (!anims.length) {
    warnings.push('no animation: baked at the rest pose')
    return null
  }
  let anim = clipName !== null ? anims.find(a => a.getName() === clipName) : undefined
  if (!anim) {
    if (clipName !== null) warnings.push(`default clip ${clipName} not found; used ${anims[0]!.getName()}`)
    anim = anims[0]!
  }
  for (const ch of anim.listChannels()) {
    const node = ch.getTargetNode()
    const sampler = ch.getSampler()
    const output = sampler?.getOutput()
    if (!node || !sampler || !output || !sampler.getInput()?.getCount()) continue
    const v = firstKey(output, sampler.getInterpolation() === 'CUBICSPLINE')
    const path = ch.getTargetPath()
    if (path === 'translation') node.setTranslation([v[0]!, v[1]!, v[2]!])
    else if (path === 'scale') node.setScale([v[0]!, v[1]!, v[2]!])
    else if (path === 'rotation') {
      const n = Math.hypot(v[0]!, v[1]!, v[2]!, v[3]!) || 1
      node.setRotation([v[0]! / n, v[1]! / n, v[2]! / n, v[3]! / n])
    }
  }
  return anim.getName()
}

/** The primitive's JOINTS_n / WEIGHTS_n pairs. */
function skinSets(prim: Primitive): Array<{ joints: Accessor; weights: Accessor }> {
  const sets: Array<{ joints: Accessor; weights: Accessor }> = []
  for (let n = 0; ; n++) {
    const joints = prim.getAttribute(`JOINTS_${n}`)
    const weights = prim.getAttribute(`WEIGHTS_${n}`)
    if (!joints || !weights) break
    sets.push({ joints, weights })
  }
  return sets
}

function newAccessor(doc: Document, like: Accessor, array: Float32Array): Accessor {
  return doc.createAccessor(like.getName()).setType(like.getType()).setArray(array).setBuffer(like.getBuffer() ?? doc.getRoot().listBuffers()[0] ?? null)
}

/**
 * Bakes a skinned document in place into its static pose at frame 0 of `clipName` (see the header). The document
 * must hold float geometry (see dequantize).
 */
export function bakeStaticPose(doc: Document, clipName: string | null, rootName = 'root'): BakeResult {
  const warnings: string[] = []
  const root = doc.getRoot()
  const clip = poseAtFrame0(doc, clipName, warnings)

  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  const grow = (x: number, y: number, z: number) => {
    if (x < min[0]) min[0] = x
    if (y < min[1]) min[1] = y
    if (z < min[2]) min[2] = z
    if (x > max[0]) max[0] = x
    if (y > max[1]) max[1] = y
    if (z > max[2]) max[2] = z
  }
  let skinnedPrimitives = 0
  let unweighted = 0

  // World matrices of the posed hierarchy, read before anything moves.
  const meshNodes = root.listNodes().filter(n => n.getMesh())
  const nodeWorld = new Map<Node, Mat4>(meshNodes.map(n => [n, n.getWorldMatrix() as number[]]))
  const skinMats = new Map<object, Mat4[]>()
  for (const skin of root.listSkins()) {
    const ibm = skin.getInverseBindMatrices()
    skinMats.set(skin, skin.listJoints().map((j, i) => mul(j.getWorldMatrix() as number[], ibm ? ibm.getElement(i, []) : IDENTITY)))
  }

  const baked = new Set<Primitive>()
  for (const node of meshNodes) {
    const skin = node.getSkin()
    const mats = skin ? skinMats.get(skin)! : null
    const world = nodeWorld.get(node)!
    for (const prim of node.getMesh()!.listPrimitives()) {
      if (baked.has(prim)) {
        warnings.push(`${node.getName()}: primitive shared by several nodes; baked once`)
        continue
      }
      baked.add(prim)
      const pos = prim.getAttribute('POSITION')
      if (!pos) continue
      const sets = mats ? skinSets(prim) : []
      const count = pos.getCount()
      const nrm = prim.getAttribute('NORMAL')
      const tan = prim.getAttribute('TANGENT')
      const outP = new Float32Array(count * 3)
      const outN = nrm ? new Float32Array(count * 3) : null
      const outT = tan ? new Float32Array(count * 4) : null
      const m = new Array<number>(16)
      const p: number[] = [], n: number[] = [], t: number[] = [], jj: number[] = [], ww: number[] = []
      for (let v = 0; v < count; v++) {
        // The vertex's matrix: the weight-blended joint matrices (skinned), else the node's world matrix.
        let total = 0
        if (mats && sets.length) {
          m.fill(0)
          for (const s of sets) {
            s.joints.getElement(v, jj)
            s.weights.getElement(v, ww)
            for (let k = 0; k < 4; k++) {
              const w = ww[k]!
              if (!(w > 0)) continue
              const jm = mats[jj[k]!]
              if (!jm) continue
              total += w
              for (let e = 0; e < 16; e++) m[e]! += w * jm[e]!
            }
          }
        }
        let M: readonly number[]
        if (total > 0) {
          if (Math.abs(total - 1) > 1e-6) for (let e = 0; e < 16; e++) m[e] = m[e]! / total
          M = m
        } else {
          if (mats && sets.length) unweighted++
          M = world
        }
        pos.getElement(v, p)
        const x = M[0]! * p[0]! + M[4]! * p[1]! + M[8]! * p[2]! + M[12]!
        const y = M[1]! * p[0]! + M[5]! * p[1]! + M[9]! * p[2]! + M[13]!
        const z = M[2]! * p[0]! + M[6]! * p[1]! + M[10]! * p[2]! + M[14]!
        outP[v * 3] = x
        outP[v * 3 + 1] = y
        outP[v * 3 + 2] = z
        grow(outP[v * 3]!, outP[v * 3 + 1]!, outP[v * 3 + 2]!)
        if (nrm && outN) {
          nrm.getElement(v, n)
          const a = M[0]! * n[0]! + M[4]! * n[1]! + M[8]! * n[2]!
          const b = M[1]! * n[0]! + M[5]! * n[1]! + M[9]! * n[2]!
          const c = M[2]! * n[0]! + M[6]! * n[1]! + M[10]! * n[2]!
          const l = Math.hypot(a, b, c) || 1
          outN[v * 3] = a / l
          outN[v * 3 + 1] = b / l
          outN[v * 3 + 2] = c / l
        }
        if (tan && outT) {
          tan.getElement(v, t)
          const a = M[0]! * t[0]! + M[4]! * t[1]! + M[8]! * t[2]!
          const b = M[1]! * t[0]! + M[5]! * t[1]! + M[9]! * t[2]!
          const c = M[2]! * t[0]! + M[6]! * t[1]! + M[10]! * t[2]!
          const l = Math.hypot(a, b, c) || 1
          outT.set([a / l, b / l, c / l, t[3] ?? 1], v * 4)
        }
      }
      prim.setAttribute('POSITION', newAccessor(doc, pos, outP))
      if (nrm && outN) prim.setAttribute('NORMAL', newAccessor(doc, nrm, outN))
      if (tan && outT) prim.setAttribute('TANGENT', newAccessor(doc, tan, outT))
      for (let k = 0; ; k++) {
        if (!prim.getAttribute(`JOINTS_${k}`) && !prim.getAttribute(`WEIGHTS_${k}`)) break
        prim.setAttribute(`JOINTS_${k}`, null)
        prim.setAttribute(`WEIGHTS_${k}`, null)
      }
      if (mats && sets.length) skinnedPrimitives++
    }
  }
  if (unweighted) warnings.push(`${unweighted} skinned vertex(es) with no weight: left at the node's pose`)

  // One static root with the mesh nodes (identity transforms: their geometry is in model space now).
  const staticRoot = doc.createNode(rootName)
  for (const node of meshNodes) {
    node.setSkin(null).setTranslation([0, 0, 0]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1])
    for (const c of node.listChildren()) node.removeChild(c)
    staticRoot.addChild(node)
  }
  for (const anim of root.listAnimations()) {
    for (const s of anim.listSamplers()) s.dispose()
    for (const c of anim.listChannels()) c.dispose()
    anim.dispose()
  }
  for (const skin of root.listSkins()) skin.dispose()
  const keep = new Set<Node>([staticRoot, ...meshNodes])
  for (const node of root.listNodes()) if (!keep.has(node)) node.dispose()
  const scenes = root.listScenes()
  const scene = scenes[0] ?? doc.createScene('Scene')
  for (const s of scenes) for (const c of s.listChildren()) s.removeChild(c)
  scene.addChild(staticRoot)
  root.setDefaultScene(scene)
  // Accessors nothing references any more (the old positions, the joints and weights, the clips, the inverse binds).
  for (const acc of root.listAccessors()) {
    if (!acc.listParents().some((p: Property) => p.propertyType !== 'Root')) acc.dispose()
  }

  const empty = !Number.isFinite(min[0])
  return {
    clip, skinnedPrimitives, unweighted,
    boundsMin: empty ? [0, 0, 0] : min,
    boundsMax: empty ? [0, 0, 0] : max,
    warnings,
  }
}

/** Removes quantization / meshopt so the geometry is float (a variant of an already optimized export). */
async function toFloatGeometry(doc: Document): Promise<void> {
  const used = doc.getRoot().listExtensionsUsed().map(e => e.extensionName)
  if (used.includes('KHR_mesh_quantization') || used.includes('EXT_meshopt_compression')) {
    await doc.transform(dequantize())
    for (const ext of doc.getRoot().listExtensionsUsed()) {
      if (ext.extensionName === 'KHR_mesh_quantization' || ext.extensionName === 'EXT_meshopt_compression') ext.dispose()
    }
  }
}

/** The skinned foliage models a remaining placement uses, in model order. */
export function variantCandidates(models: readonly WorldModel[], placements: ReadonlyArray<{ models: readonly number[] }>): WorldModel[] {
  const used = new Set<number>()
  for (const p of placements) for (const m of p.models) used.add(m)
  return models.filter(m => m.kind === 'skinned' && m.glb && m.sidecar && used.has(m.index) && isFoliageModel(m.source))
}

const r5 = (v: number) => Math.round(v * 1e5) / 1e5

/** Writes the static variant of one skinned model; returns it, or null with a warning. */
export async function writeStaticVariant(model: WorldModel, outDir: string, warnings: string[], validate = true): Promise<StaticVariant | null> {
  const glbRel = staticPath(model.glb!)
  const sidecarRel = staticPath(model.sidecar!)
  try {
    const io = await gltfIO()
    const doc = await io.readBinary(new Uint8Array(readFileSync(join(outDir, ...model.glb!.split('/')))))
    await toFloatGeometry(doc)
    const sidecar = JSON.parse(readFileSync(join(outDir, ...model.sidecar!.split('/')), 'utf8')) as Sidecar
    const bake = bakeStaticPose(doc, model.defaultClip, sidecar.name || model.glb!.split('/').pop()!.replace(/\.glb$/, ''))
    for (const w of bake.warnings) warnings.push(`static variant of ${model.source}: ${w}`)
    if (!bake.skinnedPrimitives) {
      warnings.push(`static variant of ${model.source}: no skinned primitive`)
      return null
    }
    const glb = await io.writeBinary(doc)
    let validatorErrors: number | null = null
    let validation: Sidecar['validation']
    if (validate) {
      const v = await validateGlb(glb, glbRel.split('/').pop())
      validatorErrors = v.errors
      validation = { errors: v.errors, warnings: v.warnings, infos: v.infos, issues: [] }
    }
    const boundsMin = bake.boundsMin.map(r5) as Vec3
    const boundsMax = bake.boundsMax.map(r5) as Vec3
    const out: Sidecar = {
      ...sidecar,
      generator: `${sidecar.generator}; static variant: frame 0 of ${bake.clip ?? 'the rest pose'} (BATCHING §3.5)`,
      skeleton: null,
      meshes: sidecar.meshes.map(m => ({ ...m, skinned: false, bones: [] })),
      animations: [],
      stats: { ...sidecar.stats, joints: 0, animations: 0, heightM: r5(boundsMax[1] - boundsMin[1]), boundsMin, boundsMax },
      ...(validation ? { validation } : {}),
    }
    const glbFile = join(outDir, ...glbRel.split('/'))
    mkdirSync(dirname(glbFile), { recursive: true })
    writeFileSync(glbFile, glb)
    writeFileSync(join(outDir, ...sidecarRel.split('/')), JSON.stringify(out, null, 2) + '\n')
    return {
      of: model.index,
      model: {
        source: model.source + STATIC_SOURCE_SUFFIX,
        glb: glbRel,
        sidecar: sidecarRel,
        kind: 'static',
        animations: [],
        defaultClip: null,
        lightmappedMeshes: model.lightmappedMeshes,
        boundsMin,
        boundsMax,
        bytes: glb.byteLength,
        validatorErrors,
      },
    }
  } catch (e) {
    warnings.push(`static variant of ${model.source}: ${(e as Error).message}`)
    return null
  }
}

export const staticVariantPass: StaticVariantPass = async (ctx: WorldPassContext): Promise<StaticVariant[]> => {
  const out: StaticVariant[] = []
  const candidates = variantCandidates(ctx.models, ctx.placements)
  for (const model of candidates) {
    const v = await writeStaticVariant(model, ctx.outDir, ctx.warnings)
    if (v) out.push(v)
  }
  if (candidates.length) ctx.log(`static variants: ${out.length} of ${candidates.length} skinned foliage model(s) baked at frame 0`)
  return out
}
