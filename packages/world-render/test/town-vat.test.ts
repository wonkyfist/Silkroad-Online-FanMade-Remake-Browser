/**
 * TL-V's VAT parity (docs/TOWN_LIFE.md §3.2, F11; WAVE_PLAN7 §6.1 lane TL-V, §5.3), on the real exports in work/out
 * (skips without them), in Babylon's NullEngine:
 *  - a VAT row = Babylon's own skin matrices (`Skeleton.getTransformMatrices`) of the variant glb as Babylon loads it,
 *    posed by the source clip (layout and joint order: the texture replaces the skeleton with no other change);
 *  - a VAT frame skins every vertex of the dressed variant to where Babylon skins the SOURCE meshes (the retail body
 *    and each garment glb, each through its own skin) at that clip time: within 1 mm at float32 and 3 mm after the
 *    half-float quantisation, for the retail clips, a gait style from another body, the 15 fps VENDOR01, the layered
 *    STAND3 and TL-A2's town clips;
 *  - one mesh + one material per variant (one draw), its skin in VAT order, no animation, emissive black, within
 *    3,000 triangles and a 1024² atlas; every VAT ≤ 2.5 MB.
 *  - TL-V2's re-bake: once TL-A2's pack is in work/out, all four town clips (SIT_CHAIR, CARRY, TALK, SWEEP) are in
 *    both people VATs at their keyed loop length with a closed seam, carry the pack's seat and socket (VatClip.town),
 *    and a prop placed from the VAT rows rides as keyed (the crate steady on the neck, the broom's end on the ground).
 * The converter units (atlas, half floats, joints remapped by name, the emissive) are convert/test/town-variants.test.ts.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  LoadAssetContainerAsync, Mesh, NullEngine, Scene, TransformNode, Vector3, VertexBuffer, type AnimationGroup,
  type AssetContainer, type PBRMaterial,
} from '@babylonjs/core'
import '@babylonjs/loaders/glTF/2.0/index.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compose, invert, mul, type Mat4 } from '../../convert/src/tools/export-moves.ts'
import { buildTown, checkTownClips, variantGlb, type BuiltVariant, type TownBuild, type TownClipsIndex } from '../../convert/src/town/export-town.ts'
import { encodeHalf, VAT_MAX_BYTES, VAT_TOLERANCE_F16, VAT_TOLERANCE_F32, vatMatrix, type BakedVat } from '../../convert/src/town/vat.ts'

const OUT = join(import.meta.dirname, '../../../work/out')
const ready = existsSync(join(OUT, 'equipment/equipment.json')) && existsSync(join(OUT, 'char/china/chinaman_merchant.glb'))
  && existsSync(join(OUT, 'char/china/chinawoman_merchant.glb'))
/** m03: the man's clothes_03 (a two-sided `_2s` piece, mirrored); m04: hat and wristlets; w03: the woman's clothes_03 (its trousers' UVs run past 1). */
const PEOPLE = ['m03', 'm04', 'w03']
const SKELETONS = ['europeman_skel', 'europewoman_skel']
/** TL-A2's four town clips (TL-V2 re-bake): required once their pack is in work/out (moves/<skel>/town/town_clips.json). */
const TOWN_CLIPS = ['SIT_CHAIR', 'CARRY', 'TALK', 'SWEEP']
const packFile = (skel: string) => join(OUT, 'moves', skel, 'town', 'town_clips.json')
const townPack = (skel: string): TownClipsIndex | null => existsSync(packFile(skel)) ? JSON.parse(readFileSync(packFile(skel), 'utf8')) as TownClipsIndex : null
/** The keyed loop length of a town clip (content/moves/<skel>/town/<clip>.json `lastFrame`, 30 fps). */
const keyedLastFrame = (skel: string, clip: string): number =>
  (JSON.parse(readFileSync(join(import.meta.dirname, '../../../content/moves', skel, 'town', `${clip.toLowerCase()}.json`), 'utf8')) as { lastFrame: number }).lastFrame

let engine: NullEngine
let scene: Scene
let build: TownBuild
const containers = new Map<string, Promise<AssetContainer>>()

beforeAll(async () => {
  if (!ready) return
  engine = new NullEngine()
  scene = new Scene(engine)
  scene.useRightHandedSystem = true
  build = await buildTown({ inDir: OUT, read: null, people: PEOPLE })
}, 180_000)

afterAll(() => {
  scene?.dispose()
  engine?.dispose()
})

function load(bytes: Uint8Array): Promise<AssetContainer> {
  return LoadAssetContainerAsync(bytes, scene, { pluginExtension: '.glb' })
}

/** A source glb of work/out (cached; each load is its own nodes). */
function source(rel: string): Promise<AssetContainer> {
  let c = containers.get(rel)
  if (!c) containers.set(rel, (c = load(new Uint8Array(readFileSync(join(OUT, ...rel.replace(/^\/?out\//, '').split('/')))))))
  return c
}

/** Name → transform node of a container (the glb's joints). */
function nodesOf(c: AssetContainer): Map<string, TransformNode> {
  return new Map(c.transformNodes.map(t => [t.name, t]))
}

interface Rest { node: TransformNode, p: Vector3, q: [number, number, number, number], s: Vector3 }
const rests = new WeakMap<AssetContainer, Rest[]>()
/** Puts every joint node of `c` back to its rest TRS (a clip leaves the joints it does not animate as they were). */
function toRest(c: AssetContainer): void {
  let r = rests.get(c)
  if (!r) {
    r = c.transformNodes.map(n => ({ node: n, p: n.position.clone(), q: n.rotationQuaternion ? n.rotationQuaternion.asArray() as Rest['q'] : [0, 0, 0, 1], s: n.scaling.clone() }))
    rests.set(c, r)
  }
  for (const x of r) {
    x.node.position.copyFrom(x.p)
    x.node.rotationQuaternion?.set(...x.q)
    x.node.scaling.copyFrom(x.s)
  }
}

function group(c: AssetContainer, name: string): AnimationGroup {
  const g = c.animationGroups.find(a => a.name === name)
  if (!g) throw new Error(`no animation group ${name}`)
  return g
}

/** Poses `c` with its clip `anim` at time t (s); `base` first for an overlay clip (the game plays it on the base). */
function pose(c: AssetContainer, anim: string, t: number, base?: string): void {
  toRest(c)
  for (const name of base ? [base, anim] : [anim]) {
    const g = group(c, name)
    const fps = g.targetedAnimations[0]?.animation.framePerSecond ?? 60
    const dur = (g.to - g.from) / fps
    g.start(false, 1, g.from, g.to)
    g.pause()
    g.goToFrame(g.from + Math.min(name === anim ? t : t % dur, dur) * fps)
    g.stop()
  }
}

/** Copies the posed joints of `from` onto the same-named nodes of `to` (the retarget the dresser does by name). */
function copyPose(from: AssetContainer, to: AssetContainer): void {
  const src = nodesOf(from)
  for (const n of to.transformNodes) {
    const s = src.get(n.name)
    if (!s) continue
    n.position.copyFrom(s.position)
    if (s.rotationQuaternion) (n.rotationQuaternion ??= s.rotationQuaternion.clone()).copyFrom(s.rotationQuaternion)
    n.scaling.copyFrom(s.scaling)
  }
}

/** World positions of a skinned mesh, skinned on the CPU by Babylon (its own skin and skeleton). */
function skinnedWorld(mesh: Mesh): Float32Array {
  for (const r of mesh.getScene().rootNodes) (r as TransformNode).computeWorldMatrix?.(true)
  mesh.computeWorldMatrix(true)
  mesh.skeleton!.prepare(true)
  const local = mesh.getPositionData(true, false)!
  const w = mesh.getWorldMatrix()
  const out = new Float32Array(local.length)
  const v = new Vector3()
  for (let i = 0; i < local.length; i += 3) {
    Vector3.TransformCoordinatesFromFloatsToRef(local[i]!, local[i + 1]!, local[i + 2]!, w, v)
    out[i] = v.x
    out[i + 1] = v.y
    out[i + 2] = v.z
  }
  return out
}

interface LoadedVariant {
  built: BuiltVariant
  container: AssetContainer
  mesh: Mesh
  pos: Float32Array
  idx: Float32Array
  wgt: Float32Array
}

const variants = new Map<string, Promise<LoadedVariant>>()
function variant(id: string): Promise<LoadedVariant> {
  let p = variants.get(id)
  if (!p) {
    p = (async () => {
      const built = build.variants.find(v => v.info.id === id)!
      const container = await load(await variantGlb(built))
      const mesh = container.meshes.find((m): m is Mesh => m instanceof Mesh && m.getTotalVertices() > 0)!
      return {
        built, container, mesh,
        pos: new Float32Array(mesh.getVerticesData(VertexBuffer.PositionKind)!),
        idx: new Float32Array(mesh.getVerticesData(VertexBuffer.MatricesIndicesKind)!),
        wgt: new Float32Array(mesh.getVerticesData(VertexBuffer.MatricesWeightsKind)!),
      }
    })()
    variants.set(id, p)
  }
  return p
}

/** Vertex i of the variant skinned with VAT row `row` (float32 or half texels), to world space. */
function vatSkinned(v: LoadedVariant, vat: BakedVat, texels: Float32Array | Uint16Array, row: number, i: number, out: Vector3): Vector3 {
  const p = [v.pos[i * 3]!, v.pos[i * 3 + 1]!, v.pos[i * 3 + 2]!]
  const acc = [0, 0, 0]
  for (let k = 0; k < 4; k++) {
    const w = v.wgt[i * 4 + k]!
    if (!w) continue
    const m = vatMatrix(texels, vat.width, row, v.idx[i * 4 + k]!)
    for (let r = 0; r < 3; r++) acc[r] = acc[r]! + w * (m[r]! * p[0]! + m[4 + r]! * p[1]! + m[8 + r]! * p[2]! + m[12 + r]!)
  }
  v.mesh.computeWorldMatrix(true)
  return Vector3.TransformCoordinatesFromFloatsToRef(acc[0]!, acc[1]!, acc[2]!, v.mesh.getWorldMatrix(), out)
}

/** Where the clip's pose comes from: its glb (the VatClip's source) and animation. */
function clipSource(vat: BakedVat, clip: string): { rel: string, anim: string } {
  const [rel, anim] = vat.clips[clip]!.source.split('#') as [string, string]
  return { rel, anim }
}

interface Errors { f32: number, f16: number, rows: number, vertices: number }

/**
 * For each sampled row of `clip`: poses the source clip, skins the variant's source meshes with Babylon (the body and
 * each garment, by name from the part labels) and compares with the variant skinned by the VAT row.
 */
async function measure(id: string, clip: string, rows: number[]): Promise<Errors> {
  const v = await variant(id)
  const vat = build.vats.get(v.built.info.skeleton)!
  const half = encodeHalf(vat.data)
  const c = vat.clips[clip]!
  const { rel, anim } = clipSource(vat, clip)
  const animSrc = await source(rel)
  const body = await source(`char/china/${v.built.info.source.body}.glb`)
  const items = await Promise.all((v.built.info.source.items ?? []).map(async code => ({ code, c: await itemContainer(code) })))
  const err: Errors = { f32: 0, f16: 0, rows: 0, vertices: 0 }
  const got = new Vector3()
  for (const k of rows) {
    const row = c.start + k
    const t = (c.durationS * k) / (c.frames - 1)
    pose(animSrc, anim, t, baseOf(clip))
    for (const target of [body, ...items.map(x => x.c)]) {
      toRest(target)
      copyPose(animSrc, target)
    }
    for (const part of v.built.dressed.parts) {
      const owner = part.label === v.built.info.source.body ? body : items.find(x => x.code === part.label)?.c
      expect(owner, part.label).toBeDefined()
      const mesh = owner!.meshes.find((m): m is Mesh => m instanceof Mesh && m.name.toLowerCase() === part.mesh.toLowerCase())
      expect(mesh, `${part.label}/${part.mesh}`).toBeDefined()
      const ref = skinnedWorld(mesh!)
      expect(ref.length / 3).toBe(part.sourceCount)
      for (let i = 0; i < part.sourceCount; i++) {
        const j = part.start + i
        vatSkinned(v, vat, vat.data, row, j, got)
        err.f32 = Math.max(err.f32, Math.hypot(got.x - ref[i * 3]!, got.y - ref[i * 3 + 1]!, got.z - ref[i * 3 + 2]!))
        vatSkinned(v, vat, half, row, j, got)
        err.f16 = Math.max(err.f16, Math.hypot(got.x - ref[i * 3]!, got.y - ref[i * 3 + 1]!, got.z - ref[i * 3 + 2]!))
        err.vertices++
      }
    }
    err.rows++
  }
  return err
}

/** The layered clips (variants.ts peopleClips `base`). */
function baseOf(clip: string): string | undefined {
  return clip === 'STAND3' ? 'STAND1' : undefined
}

const manifest = () => JSON.parse(readFileSync(join(OUT, 'equipment/equipment.json'), 'utf8')) as { items: Array<{ code: string, model?: { glb: string } }> }
function itemContainer(code: string): Promise<AssetContainer> {
  const glb = manifest().items.find(i => i.code === code)?.model?.glb
  if (!glb) throw new Error(`no glb for ${code}`)
  return source(glb)
}

describe.skipIf(!ready)('town VATs on the retail clips (TL-V, NullEngine)', () => {
  it('builds the test variants and both people VATs without a failure, within the budgets', () => {
    expect(build.failures).toEqual([])
    expect(build.variants.map(v => v.info.id).sort()).toEqual([...PEOPLE].sort())
    for (const key of ['europeman_skel', 'europewoman_skel']) {
      const v = build.vats.get(key)!
      expect(v, key).toBeDefined()
      expect(v.width * v.height * 4 * 2).toBeLessThanOrEqual(VAT_MAX_BYTES)
      for (const c of ['STAND1', 'STAND3', 'WALK', 'RUN', 'SIT', 'VENDOR01', 'EMOTION01', 'CART_WALK', 'HAMMER', 'STAND1@fighter', 'WALK@fighter']) expect(v.clips[c], `${key} ${c}`).toBeDefined()
      expect(v.clips.WALK!.loopM).toBeCloseTo(1.7, 6)
      expect(v.clips.VENDOR01!.sampleFps).toBeCloseTo(15, 2)
    }
  })

  it('one mesh, one material, one skin in VAT order per variant; emissive black; 3,000 triangles and 1024² at most', async () => {
    for (const id of PEOPLE) {
      const v = await variant(id)
      const geo = v.container.meshes.filter(m => m instanceof Mesh && m.getTotalVertices() > 0)
      expect(geo).toHaveLength(1)
      expect(v.mesh.subMeshes).toHaveLength(1)
      expect(v.container.materials).toHaveLength(1)
      expect(v.container.skeletons).toHaveLength(1)
      expect(v.container.animationGroups).toHaveLength(0)
      const mat = v.mesh.material as PBRMaterial
      expect([mat.emissiveColor.r, mat.emissiveColor.g, mat.emissiveColor.b]).toEqual([0, 0, 0])
      expect(mat.backFaceCulling).toBe(true)
      expect(v.built.info.triangles).toBeLessThanOrEqual(3000)
      expect(Math.max(...v.built.info.atlas)).toBeLessThanOrEqual(1024)
      const vat = build.vats.get(v.built.info.skeleton)!
      const bones = [...v.mesh.skeleton!.bones].sort((a, b) => a.getIndex() - b.getIndex())
      expect(v.mesh.skeleton!.bones.map(b => b.name).sort()).toEqual([...vat.joints].sort())
      // Babylon's bone _index = the skin's joint index = the VAT's joint slot
      for (const b of v.mesh.skeleton!.bones) expect(vat.joints[(b as unknown as { _index: number })._index]).toBe(b.name)
      expect(bones.length).toBe(vat.joints.length)
    }
  })

  it('a VAT row equals Babylon\'s skin matrices of the posed variant (layout, joint order)', async () => {
    const v = await variant('m03')
    const vat = build.vats.get('europeman_skel')!
    for (const clip of ['WALK', 'EMOTION07', 'STAND1@fighter']) {
      const c = vat.clips[clip]!
      const { rel, anim } = clipSource(vat, clip)
      const src = await source(rel)
      for (const k of [0, Math.floor(c.frames / 3), c.frames - 1]) {
        pose(src, anim, (c.durationS * k) / (c.frames - 1))
        toRest(v.container)
        copyPose(src, v.container)
        v.mesh.skeleton!.prepare(true)
        const babylon = v.mesh.skeleton!.getTransformMatrices(v.mesh)
        expect(babylon.length).toBe(vat.width * 4)
        let d = 0
        const row = (c.start + k) * vat.width * 4
        for (let i = 0; i < babylon.length; i++) d = Math.max(d, Math.abs(babylon[i]! - vat.data[row + i]!))
        expect(d, `${clip} row ${k}`).toBeLessThan(1e-4)
      }
    }
  })

  it('a VAT frame skins the dressed man within 1 mm (float32) / 3 mm (half) of the retail body and garments', async () => {
    let worst: Errors = { f32: 0, f16: 0, rows: 0, vertices: 0 }
    const vat = build.vats.get('europeman_skel')!
    for (const id of ['m03', 'm04']) {
      for (const clip of ['STAND1', 'WALK', 'RUN', 'SIT', 'EMOTION02', 'VENDOR01', 'HAMMER', 'CART_WALK', 'STAND3', 'WALK@tattoo', ...(townPack('europeman_skel') ? TOWN_CLIPS : [])]) {
        const c = vat.clips[clip]!
        const e = await measure(id, clip, [0, Math.floor(c.frames / 2), c.frames - 1])
        expect(e.f32, `${id} ${clip} float32`).toBeLessThan(VAT_TOLERANCE_F32)
        expect(e.f16, `${id} ${clip} half`).toBeLessThan(VAT_TOLERANCE_F16)
        worst = { f32: Math.max(worst.f32, e.f32), f16: Math.max(worst.f16, e.f16), rows: worst.rows + e.rows, vertices: worst.vertices + e.vertices }
      }
    }
    expect(worst.vertices).toBeGreaterThan(10_000)
    console.log(`[town-vat] man: ${worst.rows} rows, ${worst.vertices} vertices; max ${(worst.f32 * 1000).toFixed(3)} mm float32, ${(worst.f16 * 1000).toFixed(3)} mm half`)
  }, 120_000)

  it('a VAT frame skins the dressed woman within 1 mm (float32) / 3 mm (half), the wrapped trousers included', async () => {
    let worst: Errors = { f32: 0, f16: 0, rows: 0, vertices: 0 }
    const vat = build.vats.get('europewoman_skel')!
    for (const clip of ['STAND1', 'WALK', 'SIT_DOWN', 'EMOTION04', 'VENDOR01', 'STAND3', 'WALK@fighter', ...(townPack('europewoman_skel') ? TOWN_CLIPS : [])]) {
      const c = vat.clips[clip]!
      const e = await measure('w03', clip, [0, Math.floor(c.frames / 3), Math.floor((2 * c.frames) / 3), c.frames - 1])
      expect(e.f32, `w03 ${clip} float32`).toBeLessThan(VAT_TOLERANCE_F32)
      expect(e.f16, `w03 ${clip} half`).toBeLessThan(VAT_TOLERANCE_F16)
      worst = { f32: Math.max(worst.f32, e.f32), f16: Math.max(worst.f16, e.f16), rows: worst.rows + e.rows, vertices: worst.vertices + e.vertices }
    }
    console.log(`[town-vat] woman: ${worst.rows} rows, ${worst.vertices} vertices; max ${(worst.f32 * 1000).toFixed(3)} mm float32, ${(worst.f16 * 1000).toFixed(3)} mm half`)
  }, 120_000)
  it.skipIf(!SKELETONS.every(townPack))("TL-A2's town clips are re-baked into both people VATs with their pack's metadata (TL-V2)", () => {
    for (const key of SKELETONS) {
      const vat = build.vats.get(key)!
      const pack = townPack(key)!
      expect(checkTownClips(vat, pack), key).toEqual([])
      for (const name of TOWN_CLIPS) {
        const c = vat.clips[name]!
        const k = pack.clips[name]!
        expect(c, `${key} ${name}`).toBeDefined()
        expect(c.source).toBe(`moves/${key}/town/town_clips.glb#${k.anim}`)
        // the loop the keys say: lastFrame + 1 rows at 30 fps, the last row = the first
        expect(c.frames, `${key} ${name} rows`).toBe(keyedLastFrame(key, name) + 1)
        expect(c.sampleFps).toBeCloseTo(30, 3)
        expect(c.durationS).toBeCloseTo(k.durationMs! / 1000, 2)
        expect(c.loop).toBe(true)
        let seam = 0
        for (let j = 0; j < vat.joints.length; j++) {
          const a = vatMatrix(vat.data, vat.width, c.start, j)
          const b = vatMatrix(vat.data, vat.width, c.end, j)
          for (let n = 0; n < 16; n++) seam = Math.max(seam, Math.abs(a[n]! - b[n]!))
        }
        expect(seam, `${key} ${name} loop seam`).toBeLessThan(2e-3)
        expect(c.town?.base).toBe(k.base)
        // in place, except CARRY: a layer on WALK, so it travels as the WALK does
        expect(c.rootTravelM, `${key} ${name} root travel`).toBeLessThan(0.1)
        expect(c.loopM).toBeCloseTo(name === 'CARRY' ? vat.clips.WALK!.loopM : 0, 6)
      }
      expect(vat.clips.SIT_CHAIR!.town!.seat!.hipZ).toBeGreaterThan(0.4)
      expect(vat.clips.CARRY!.town!.socket).toMatchObject({ bone: 'Bip01 R Hand', prop: 'crate' })
      expect(vat.clips.SWEEP!.town!.socket).toMatchObject({ bone: 'Bip01 R Hand', prop: 'broom' })
      expect(vat.width * vat.height * 4 * 2).toBeLessThanOrEqual(VAT_MAX_BYTES)
    }
  })

  it.skipIf(!SKELETONS.every(townPack))('a socket prop placed from the VAT rows rides as keyed: the crate steady on the neck, the broom to the floor (TL-V2)', () => {
    for (const key of SKELETONS) {
      const vat = build.vats.get(key)!
      const ibm = build.skeletons.get(key)!.ibm
      /** Joint world at row r = skin matrix × the inverse of its inverse bind matrix (VatTownMeta.socket). */
      const world = (row: number, joint: string): Mat4 => {
        const j = vat.joints.indexOf(joint)
        expect(j, joint).toBeGreaterThanOrEqual(0)
        const b = new Float64Array(16) as Mat4
        for (let n = 0; n < 16; n++) b[n] = ibm[j * 16 + n]!
        return mul(vatMatrix(vat.data, vat.width, row, j) as Mat4, invert(b))
      }
      const propAt = (clip: string, k: number): Mat4 => {
        const c = vat.clips[clip]!
        const s = c.town!.socket!
        return mul(world(c.start + k, s.bone), compose(s.offset, s.rotation))
      }
      // CARRY: the crate keeps its place against the neck (the keys' `steady`) over the whole cycle
      const carry = vat.clips.CARRY!
      const rel0 = mul(invert(world(carry.start, 'Bip01 Neck')), propAt('CARRY', 0))
      let drift = 0
      for (let k = 0; k < carry.frames; k++) {
        const rel = mul(invert(world(carry.start + k, 'Bip01 Neck')), propAt('CARRY', k))
        drift = Math.max(drift, Math.hypot(rel[12]! - rel0[12]!, rel[13]! - rel0[13]!, rel[14]! - rel0[14]!))
      }
      // the keyer solves the wrist per frame by coordinate descent (key_town.py), so the crate wanders a little: ≤ 4 cm
      console.log(`[town-vat] ${key}: crate drift on the neck ${(drift * 1000).toFixed(1)} mm`)
      expect(drift, `${key} crate drift`).toBeLessThan(0.04)
      // the crate rides above the shoulder: higher than the neck's own joint minus a hand
      expect(propAt('CARRY', 0)[13]!, `${key} crate height`).toBeGreaterThan(world(carry.start, 'Bip01 Neck')[13]! - 0.15)
      // SWEEP: the broom's floor end (floorM down its −Y) reaches the ground within a few cm over the stroke
      const sweep = vat.clips.SWEEP!
      const floorM = sweep.town!.socket!.floorM!
      let low = Infinity
      for (let k = 0; k < sweep.frames; k++) {
        const m = propAt('SWEEP', k)
        low = Math.min(low, m[13]! - floorM * m[5]!)
      }
      let feet = Infinity
      for (const foot of ['Bip01 L Toe0', 'Bip01 R Toe0']) if (vat.joints.includes(foot)) feet = Math.min(feet, world(sweep.start, foot)[13]!)
      console.log(`[town-vat] ${key}: broom floor end lowest ${(low * 1000).toFixed(1)} mm, toes ${(feet * 1000).toFixed(1)} mm`)
      // the ground is y = 0 in the VAT's space (the toes stand on it); the broom's end touches it, never sinks
      expect(Math.abs(feet), `${key} toes on the ground`).toBeLessThan(0.02)
      expect(Math.abs(low), `${key} broom floor end`).toBeLessThan(0.02)
    }
  })
})
