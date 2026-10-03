/**
 * BT-C (docs/BATCHING.md §3.5, docs/WAVE_PLAN6.md §6.1): the converter's static variants of the skinned foliage models.
 * - the bake: on a fixture whose frame 0 is not the bind pose, the posed positions / normals equal the skinned mesh at
 *   frame 0 of the DEFAULT clip (worked out by hand), with no JOINTS / WEIGHTS, skin, joint node or animation left;
 *   materials, UVs and indices kept;
 * - the pass: one variant per skinned foliage model a placement uses (not for a lamp, an unused model or a static
 *   tree), written next to the skinned glb, valid glTF, applied by runWorldPasses (models[i].staticVariant), and the
 *   renderer's foliage / tuft rules still see the variant while the retail scatter's by-name lookup does not;
 * - on the jangan-fields export (skipped without it): one variant per skinned foliage model (18 trees + the flowers,
 *   water plants, weeds and reeds), each equal to an independent skinning of the retail glb at frame 0, bounds inside
 *   the skinned model's.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Document, type Node } from '@gltf-transform/core'
import { afterAll, describe, expect, it } from 'vitest'
import { isFoliageModel as rendererIsFoliage } from '../../world-render/src/pbr/classes.ts'
import { isRetailTuftModel, modelStem } from '../../world-render/src/grass/types.ts'
import { retailModelFor } from '../../world-render/src/scatter-assets.ts'
import { REPO_ROOT } from '../src/node-io.ts'
import { gltfIO } from '../src/optimize/io.ts'
import { validateGlb } from '../src/gltf/validate.ts'
import type { Sidecar } from '../src/gltf/convert.ts'
import { validateWorldManifest, type WorldManifest, type WorldModel, type WorldPlacement } from '../src/world/manifest.ts'
import { runWorldPasses } from '../src/world/passes.ts'
import {
  bakeStaticPose, FOLIAGE_MODEL, isFoliageModel, STATIC_SOURCE_SUFFIX, staticPath, staticVariantPass, variantCandidates,
} from '../src/world/static-variants.ts'

const tmps: string[] = []
afterAll(() => {
  for (const t of tmps) rmSync(t, { recursive: true, force: true })
})
const tmp = () => {
  const t = mkdtempSync(join(tmpdir(), 'sro-static-variant-'))
  tmps.push(t)
  return t
}

const S = Math.SQRT1_2

/**
 * Two joints: J0 at the origin, J1 at (0, 2, 0) under it. Three vertices: (0, 1, 0) on J0, (0, 3, 0) on J1,
 * (1, 2, 0) half and half. Clip 'OTHER' comes first (so a "first clip" fallback would be caught); the default clip
 * 'STAND1' at t = 0 moves J0 by (0, 0, 1) and turns J1 90 degrees about +Z; at t = 1 both are back at rest.
 */
function skinnedFixture(): Document {
  const doc = new Document()
  const buf = doc.createBuffer()
  const acc = (type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT4', array: Float32Array | Uint16Array | Uint32Array) =>
    doc.createAccessor().setType(type).setArray(array).setBuffer(buf)
  const scene = doc.createScene('Scene')
  const j0 = doc.createNode('Bone01')
  const j1 = doc.createNode('Bone02').setTranslation([0, 2, 0])
  j0.addChild(j1)
  scene.addChild(j0)
  const skin = doc.createSkin('skel').setSkeleton(j0).addJoint(j0).addJoint(j1)
    .setInverseBindMatrices(acc('MAT4', new Float32Array([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -2, 0, 1,
    ])))
  const material = doc.createMaterial('leaf').setAlphaMode('MASK').setDoubleSided(true)
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', new Float32Array([0, 1, 0, 0, 3, 0, 1, 2, 0])))
    .setAttribute('NORMAL', acc('VEC3', new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0])))
    .setAttribute('TEXCOORD_0', acc('VEC2', new Float32Array([0, 0, 1, 0, 0, 1])))
    .setAttribute('TEXCOORD_1', acc('VEC2', new Float32Array([0.5, 0.5, 0.25, 0.5, 0.5, 0.25])))
    .setAttribute('JOINTS_0', acc('VEC4', new Uint16Array([0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0])))
    .setAttribute('WEIGHTS_0', acc('VEC4', new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 0.5, 0.5, 0, 0])))
    .setIndices(acc('SCALAR', new Uint16Array([0, 1, 2])))
    .setMaterial(material)
  const meshNode = doc.createNode('tre_fixture_leaf').setMesh(doc.createMesh('tre_fixture_leaf').addPrimitive(prim)).setSkin(skin)
  scene.addChild(meshNode)
  const clip = (name: string, j0t: number[], j1r: number[]) => {
    const input = acc('SCALAR', new Float32Array([0, 1]))
    const anim = doc.createAnimation(name)
    const tr = doc.createAnimationSampler().setInput(input).setOutput(acc('VEC3', new Float32Array([...j0t, 0, 0, 0]))).setInterpolation('LINEAR')
    const rot = doc.createAnimationSampler().setInput(input).setOutput(acc('VEC4', new Float32Array([...j1r, 0, 0, 0, 1]))).setInterpolation('LINEAR')
    anim.addSampler(tr).addSampler(rot)
      .addChannel(doc.createAnimationChannel().setTargetNode(j0).setTargetPath('translation').setSampler(tr))
      .addChannel(doc.createAnimationChannel().setTargetNode(j1).setTargetPath('rotation').setSampler(rot))
  }
  clip('OTHER', [5, 5, 5], [S, 0, 0, S])
  clip('STAND1', [0, 0, 1], [0, 0, S, S])
  return doc
}

const close = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-5) => {
  expect(a.length).toBe(b.length)
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i]! - b[i]!), `element ${i}: ${a[i]} vs ${b[i]}`).toBeLessThan(eps)
}

function expectNoSkin(doc: Document) {
  const root = doc.getRoot()
  expect(root.listSkins()).toHaveLength(0)
  expect(root.listAnimations()).toHaveLength(0)
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
    expect(p.listSemantics().filter(s => /^(JOINTS|WEIGHTS)_/.test(s))).toEqual([])
  }
  for (const n of root.listNodes()) expect(n.getSkin()).toBeNull()
}

describe('bakeStaticPose', () => {
  it('poses the mesh at frame 0 of the default clip and removes the skin', () => {
    const doc = skinnedFixture()
    const r = bakeStaticPose(doc, 'STAND1', 'tre_fixture')
    expect(r).toMatchObject({ clip: 'STAND1', skinnedPrimitives: 1, unweighted: 0, warnings: [] })
    const prim = doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!
    // J0: T(0, 0, 1). J1: T(0, 0, 1) T(0, 2, 0) Rz(90) T(0, -2, 0) on bind positions.
    close(prim.getAttribute('POSITION')!.getArray()!, [0, 1, 1, -1, 2, 1, 0.5, 2.5, 1])
    close(prim.getAttribute('NORMAL')!.getArray()!, [1, 0, 0, 0, 1, 0, S, S, 0])
    close(prim.getAttribute('TEXCOORD_1')!.getArray()!, [0.5, 0.5, 0.25, 0.5, 0.5, 0.25])
    expect([...prim.getIndices()!.getArray()!]).toEqual([0, 1, 2])
    expect(prim.getMaterial()!.getName()).toBe('leaf')
    close(r.boundsMin, [-1, 1, 1])
    close(r.boundsMax, [0.5, 2.5, 1])
    expectNoSkin(doc)
    // one static root with the identity transform, holding the mesh node; the joint nodes are gone
    const root = doc.getRoot()
    const top = root.getDefaultScene()!.listChildren()
    expect(top.map(n => n.getName())).toEqual(['tre_fixture'])
    expect(top[0]!.listChildren().map(n => n.getName())).toEqual(['tre_fixture_leaf'])
    expect(root.listNodes().map(n => n.getName()).sort()).toEqual(['tre_fixture', 'tre_fixture_leaf'])
    for (const n of root.listNodes()) close(n.getWorldMatrix(), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    // the joints, weights, clip and inverse-bind accessors are gone too
    expect(root.listAccessors()).toHaveLength(5)
  })

  it('falls back to the first clip (with a warning) and to the rest pose without one', () => {
    const a = skinnedFixture()
    const ra = bakeStaticPose(a, 'MISSING')
    expect(ra.clip).toBe('OTHER')
    expect(ra.warnings.join()).toContain('MISSING')
    const b = skinnedFixture()
    for (const anim of b.getRoot().listAnimations()) anim.dispose()
    const rb = bakeStaticPose(b, 'STAND1')
    expect(rb.clip).toBeNull()
    close(b.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute('POSITION')!.getArray()!, [0, 1, 0, 0, 3, 0, 1, 2, 0])
  })
})

describe('the foliage rule and the variant source', () => {
  const sources = [
    'res\\nature\\common\\tree\\tre_maple01.bsr', 'res\\nature\\china\\dunhuang\\reed\\fw_cd_reeds_l.bsr', 'res/nature/common/tree2/x.bsr',
    'res\\nature\\common\\flower\\flw_s01_y_ani.bsr', 'res\\nature\\common\\grass\\grs_weed02.bsr', 'res\\nature\\common\\rock\\r.bsr',
    'res\\bldg\\china\\jangan02\\cj_pub01_light01.bsr', 'res\\npc\\animal\\cj_chicken.bsr',
  ]

  it('is the renderer\'s (pbr/classes.ts)', () => {
    const classes = readFileSync(join(REPO_ROOT, 'packages/world-render/src/pbr/classes.ts'), 'utf8')
    expect(classes).toContain(`const FOLIAGE_MODEL = ${FOLIAGE_MODEL.toString()}`)
    for (const s of sources) {
      expect(isFoliageModel(s), s).toBe(rendererIsFoliage(s))
      expect(isFoliageModel(s + STATIC_SOURCE_SUFFIX), s).toBe(rendererIsFoliage(s))
    }
  })

  it('keeps the tuft stem, and the retail scatter never takes a variant', () => {
    const src = 'res\\nature\\common\\grass\\grs_weed02.bsr'
    expect(modelStem(src + STATIC_SOURCE_SUFFIX)).toBe('grs_weed02')
    expect(isRetailTuftModel({ source: src + STATIC_SOURCE_SUFFIX })).toBe(true)
    const variant = { ...model(1, 'static', src + STATIC_SOURCE_SUFFIX), glb: 'models/x.static.glb' }
    expect(retailModelFor({ retail: ['grs_weed02.bsr'] } as unknown as Parameters<typeof retailModelFor>[0], [variant])).toBeNull()
  })

  it('writes next to the skinned files', () => {
    expect(staticPath('models/nature/common/tree/tre_maple01.glb')).toBe('models/nature/common/tree/tre_maple01.static.glb')
    expect(staticPath('models/nature/common/tree/tre_maple01.json')).toBe('models/nature/common/tree/tre_maple01.static.json')
  })
})

function model(index: number, kind: WorldModel['kind'], source: string, stem = `m${index}`): WorldModel {
  return {
    index, source, glb: `models/${stem}.glb`, sidecar: `models/${stem}.json`, kind,
    animations: kind === 'skinned' ? ['OTHER', 'STAND1'] : [], defaultClip: kind === 'skinned' ? 'STAND1' : null,
    lightmappedMeshes: 1, boundsMin: [0, 1, 0], boundsMax: [1, 3, 0], bytes: 1, validatorErrors: 0,
  }
}

function placement(uid: number, models: number[]): WorldPlacement {
  return {
    objId: uid, source: `res\\o${uid}.bsr`, models, compound: false, position: [uid, 0, 0], rotation: [0, 0, 0, 1], yaw: 0,
    flags: { static: true, big: false, struct: false }, staticFlag: 0xffff, uid, region: 1, group: 2, inConvertedRegion: true,
  }
}

async function writeFixtureModel(outDir: string, m: WorldModel) {
  const io = await gltfIO()
  const glb = await io.writeBinary(skinnedFixture())
  mkdirSync(join(outDir, 'models'), { recursive: true })
  writeFileSync(join(outDir, m.glb!), glb)
  const sidecar = {
    source: m.source, version: 'JMXVRES 0109', generator: 'test', name: 'tre_fixture', type: 'x', units: {},
    skeleton: { bsk: 'x.bsk', joints: ['Bone01', 'Bone02'], bindCheck: { maxIdentityError: 0, maxHierarchyError: 0, staleToLocal: [] } },
    attachBone: null, attachable: null, materials: [],
    meshes: [{ name: 'tre_fixture_leaf', bms: 'x.bms', material: 'leaf', vertices: 3, triangles: 1, skinned: true, bones: ['Bone01', 'Bone02'] }],
    animations: [{ name: 'OTHER' }, { name: 'STAND1' }],
    stats: { vertices: 3, triangles: 1, joints: 2, meshes: 1, animations: 2, textures: 0, heightM: 2, boundsMin: [0, 1, 0], boundsMax: [1, 3, 0] },
    warnings: [],
  }
  writeFileSync(join(outDir, m.sidecar!), JSON.stringify(sidecar))
}

describe('staticVariantPass', () => {
  it('bakes each skinned foliage model a placement uses, and runWorldPasses links it', async () => {
    const outDir = tmp()
    const models = [
      model(0, 'skinned', 'res\\nature\\common\\tree\\tre_fixture.bsr', 'tree'),
      model(1, 'skinned', 'res\\bldg\\china\\jangan02\\cj_pub01_light01.bsr', 'lamp'), // skinned, not foliage
      model(2, 'skinned', 'res\\nature\\common\\flower\\flw_unused.bsr', 'unused'), // foliage, no placement
      model(3, 'static', 'res\\nature\\common\\tree\\tre_static.bsr', 'static'), // already static
      model(4, 'skinned', 'res\\nature\\common\\flower\\flw_fixture_ani.bsr', 'flower'),
      { ...model(5, 'failed', 'res\\nature\\common\\tree\\tre_failed.bsr'), glb: null, sidecar: null },
    ]
    for (const m of models) if (m.glb && m.kind !== 'failed') await writeFixtureModel(outDir, m)
    const placements = [placement(1, [0]), placement(2, [1]), placement(3, [3]), placement(4, [4, 0]), placement(5, [5])]
    expect(variantCandidates(models, placements).map(m => m.index)).toEqual([0, 4])

    const warnings: string[] = []
    const lines: string[] = []
    const result = await runWorldPasses({ outDir, origin: { x: 0, z: 0 }, regions: [], tiles: [], models, placements, warnings, log: l => lines.push(l) },
      { staticVariants: staticVariantPass })
    expect(warnings).toEqual([])
    expect(lines.join('\n')).toContain('static variants: 2')
    expect(result.models.map(m => m.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(result.models[0]!.staticVariant).toBe(6)
    expect(result.models[4]!.staticVariant).toBe(7)
    for (const i of [1, 2, 3, 5]) expect(result.models[i]!.staticVariant).toBeUndefined()
    const v = result.models[6]!
    expect(v).toMatchObject({
      index: 6, kind: 'static', source: 'res\\nature\\common\\tree\\tre_fixture.bsr#static', glb: 'models/tree.static.glb',
      sidecar: 'models/tree.static.json', animations: [], defaultClip: null, lightmappedMeshes: 1, validatorErrors: 0,
    })
    close(v.boundsMin, [-1, 1, 1])
    close(v.boundsMax, [0.5, 2.5, 1])

    // the written glb: static, posed, valid
    const bytes = new Uint8Array(readFileSync(join(outDir, v.glb!)))
    expect(v.bytes).toBe(bytes.byteLength)
    expect((await validateGlb(bytes)).errors).toBe(0)
    const doc = await (await gltfIO()).readBinary(bytes)
    expectNoSkin(doc)
    close(doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute('POSITION')!.getArray()!, [0, 1, 1, -1, 2, 1, 0.5, 2.5, 1])
    const sidecar = JSON.parse(readFileSync(join(outDir, v.sidecar!), 'utf8')) as Sidecar
    expect(sidecar.skeleton).toBeNull()
    expect(sidecar.animations).toEqual([])
    expect(sidecar.meshes.every(m => !m.skinned && m.bones.length === 0)).toBe(true)
    expect(sidecar.stats).toMatchObject({ joints: 0, animations: 0, heightM: 1.5, boundsMin: v.boundsMin, boundsMax: v.boundsMax })
    expect(sidecar.generator).toContain('frame 0 of STAND1')
    // nothing else was written
    expect(existsSync(join(outDir, 'models/lamp.static.glb'))).toBe(false)
    expect(existsSync(join(outDir, 'models/unused.static.glb'))).toBe(false)
  })

  it('a model it cannot read is a warning, not an abort', async () => {
    const outDir = tmp()
    const models = [model(0, 'skinned', 'res\\nature\\common\\tree\\tre_gone.bsr')]
    const warnings: string[] = []
    const out = await staticVariantPass({ outDir, origin: { x: 0, z: 0 }, regions: [], tiles: [], models, placements: [placement(1, [0])], warnings, log: () => {} })
    expect(out).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('tre_gone')
  })
})

// ---- the jangan-fields export --------------------------------------------------------------------------------------

const EXPORT = join(REPO_ROOT, 'work/out/world/jangan-fields')
const hasExport = existsSync(join(EXPORT, 'manifest.json'))

type V3 = [number, number, number]
type Q = [number, number, number, number]
/** An independent reference: TRS -> row-free affine (R 3x3 row-major + t), composed by hand, no gltf-transform math. */
interface Affine { r: number[]; t: V3 }
const qToR = ([x, y, z, w]: Q): number[] => [
  1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
  2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
  2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
]
const apply = (a: Affine, p: V3): V3 => [
  a.r[0]! * p[0] + a.r[1]! * p[1] + a.r[2]! * p[2] + a.t[0],
  a.r[3]! * p[0] + a.r[4]! * p[1] + a.r[5]! * p[2] + a.t[1],
  a.r[6]! * p[0] + a.r[7]! * p[1] + a.r[8]! * p[2] + a.t[2],
]
const compose = (a: Affine, b: Affine): Affine => {
  const r = new Array<number>(9)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a.r[i * 3]! * b.r[j]! + a.r[i * 3 + 1]! * b.r[3 + j]! + a.r[i * 3 + 2]! * b.r[6 + j]!
  return { r, t: apply(a, b.t) }
}

/** Skins the retail glb's first primitive set at frame 0 of `clip` (translation + rotation keys; the rigs are rigid). */
function referencePose(doc: Document, clip: string): Float32Array[] {
  const local = new Map<Node, { t: V3; q: Q }>()
  for (const n of doc.getRoot().listNodes()) local.set(n, { t: n.getTranslation() as V3, q: n.getRotation() as Q })
  const anim = doc.getRoot().listAnimations().find(a => a.getName() === clip)!
  for (const ch of anim.listChannels()) {
    const v = ch.getSampler()!.getOutput()!.getElement(0, [])
    const l = local.get(ch.getTargetNode()!)!
    if (ch.getTargetPath() === 'translation') l.t = v as unknown as V3
    if (ch.getTargetPath() === 'rotation') l.q = v as unknown as Q
  }
  const world = (n: Node): Affine => {
    const l = local.get(n)!
    const me: Affine = { r: qToR(l.q), t: l.t }
    const p = n.getParentNode()
    return p ? compose(world(p), me) : me
  }
  const out: Float32Array[] = []
  for (const node of doc.getRoot().listNodes()) {
    const skin = node.getSkin()
    if (!node.getMesh() || !skin) continue
    const ibm = skin.getInverseBindMatrices()!
    const mats = skin.listJoints().map((j, i) => {
      const m = ibm.getElement(i, [])
      return compose(world(j), { r: [m[0]!, m[4]!, m[8]!, m[1]!, m[5]!, m[9]!, m[2]!, m[6]!, m[10]!], t: [m[12]!, m[13]!, m[14]!] })
    })
    for (const prim of node.getMesh()!.listPrimitives()) {
      const pos = prim.getAttribute('POSITION')!, jo = prim.getAttribute('JOINTS_0')!, we = prim.getAttribute('WEIGHTS_0')!
      const res = new Float32Array(pos.getCount() * 3)
      for (let v = 0; v < pos.getCount(); v++) {
        const p = pos.getElement(v, [] as number[]) as unknown as V3, j = jo.getElement(v, []), w = we.getElement(v, [])
        const acc: V3 = [0, 0, 0]
        let sum = 0
        for (let k = 0; k < 4; k++) {
          if (!(w[k]! > 0)) continue
          const q = apply(mats[j[k]!]!, p)
          for (let c = 0; c < 3; c++) acc[c]! += w[k]! * q[c]!
          sum += w[k]!
        }
        for (let c = 0; c < 3; c++) res[v * 3 + c] = acc[c]! / sum
      }
      out.push(res)
    }
  }
  return out
}

describe.skipIf(!hasExport)('the jangan-fields export', () => {
  it('one variant per skinned foliage model, equal to the retail mesh at frame 0, bounds inside', async () => {
    const m = JSON.parse(readFileSync(join(EXPORT, 'manifest.json'), 'utf8')) as WorldManifest
    // the input: the converter's models (a re-converted export already carries variants and the tree swap's species
    // models after them; start from the skinned ones)
    const models = m.models
      .filter(x => !x.source.endsWith(STATIC_SOURCE_SUFFIX) && !x.source.endsWith('#species'))
      .map(({ staticVariant: _v, treeSwap: _t, ...x }) => x)
    const cands = variantCandidates(models, m.placements)
    const trees = cands.filter(c => /[\\/]tree\d*[\\/]/i.test(c.source))
    expect(trees).toHaveLength(18)
    expect(cands.filter(c => /[\\/]flower[\\/]/i.test(c.source)).length).toBeGreaterThanOrEqual(2)
    // every skinned foliage model a placement uses is a candidate; nothing else is
    const used = new Set(m.placements.flatMap(p => p.models))
    expect(cands.map(c => c.index)).toEqual(models.filter(x => x.kind === 'skinned' && used.has(x.index) && rendererIsFoliage(x.source)).map(x => x.index))

    const outDir = tmp()
    for (const c of cands) for (const rel of [c.glb!, c.sidecar!]) {
      mkdirSync(join(outDir, rel, '..'), { recursive: true })
      cpSync(join(EXPORT, rel), join(outDir, rel))
    }
    const warnings: string[] = []
    const result = await runWorldPasses({ outDir, origin: m.space.originRegion, regions: m.regions, tiles: m.tiles, models, placements: m.placements, warnings },
      { staticVariants: staticVariantPass })
    expect(warnings).toEqual([])
    const withVariant = result.models.filter(x => x.staticVariant !== undefined)
    expect(withVariant.map(x => x.index)).toEqual(cands.map(c => c.index))
    expect(validateWorldManifest({ ...m, models: result.models })).toEqual([])

    const io = await gltfIO()
    for (const src of withVariant) {
      const v = result.models[src.staticVariant!]!
      expect(v.kind).toBe('static')
      expect(v.validatorErrors).toBe(0)
      for (let c = 0; c < 3; c++) {
        expect(v.boundsMin[c]!).toBeGreaterThanOrEqual(src.boundsMin[c]! - 1e-3)
        expect(v.boundsMax[c]!).toBeLessThanOrEqual(src.boundsMax[c]! + 1e-3)
      }
      const skinned = await io.readBinary(new Uint8Array(readFileSync(join(EXPORT, src.glb!))))
      const baked = await io.readBinary(new Uint8Array(readFileSync(join(outDir, v.glb!))))
      expectNoSkin(baked)
      const want = referencePose(skinned, src.defaultClip!)
      const got = baked.getRoot().listNodes().filter(n => n.getMesh()).flatMap(n => n.getMesh()!.listPrimitives().map(p => p.getAttribute('POSITION')!.getArray()!))
      expect(got.length, src.source).toBe(want.length)
      want.forEach((w, i) => close(got[i]!, w, 1e-4))
    }
  }, 120_000)
})
