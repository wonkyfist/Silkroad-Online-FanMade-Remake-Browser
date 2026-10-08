/**
 * P1a crowd tier (docs/CHARACTERS.md §3.5):
 * - crowd-vat.ts (pure): the rows of a clip, the instance settings against Babylon's own shader formula (a GPU loop
 *   shows the clip's nearest row at every time, across the clock's rebase; a one-shot holds its end; a slow clip goes
 *   to the CPU), the weapon codes, the half floats;
 * - char-lod.ts closeSet: the nearest CLOSE_COUNT within CLOSE_RANGE_M stay as they are, with the hysteresis;
 * - crowd-budget.ts planCrowd: who is a crowd candidate; crowdJoined: what changes for one the tier took;
 * - CrowdTier + CharacterActor.setCrowd (NullEngine): a member's parts hidden and drawn by one batch mesh with thin
 *   instances, the VAT rows equal to the skeleton's skin matrices × the parts' transform, a weapon bound to its socket
 *   bone so it lands where the socket puts it, the item codes in the instance buffer, the batch shared by the same
 *   outfit, the parts back on leaving, and the actors the tier must not take.
 */
import {
  Animation,
  AnimationGroup,
  ArcRotateCamera,
  AssetContainer,
  Bone,
  Matrix,
  MeshBuilder,
  NullEngine,
  PBRMaterial,
  RawTexture,
  Scene,
  Skeleton,
  TransformNode,
  Vector3,
  VertexBuffer,
  type Mesh,
} from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLOCK_BASE_S,
  CROWD_ROWS_PER_S,
  decodeItemCode,
  fromHalf,
  gpuAdvances,
  itemCode,
  rowsFor,
  shaderRow,
  toHalf,
  vatSettings,
  wantedRow,
  type ClipClock,
} from '../src/three/crowd-vat.ts'
import { CROWD_ITEM_KIND, crowdItemCode, type CrowdTier } from '../src/three/crowd-tier.ts'
import { CharacterActor, ModelLibrary } from '../src/three/models.ts'
import { CLOSE_COUNT, CLOSE_KEEP_RANK, CLOSE_LEAVE_M, CLOSE_RANGE_M, CROWD_STEP_HZ, closeSet } from '../src/world/char-lod.ts'
import { ANIM_FROM, FULL, NEAR_M, crowdJoined, planCrowd, type CrowdEntry } from '../src/world/crowd-budget.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

/** Rows equal up to a loop's seam (its last row is the pose of its first). */
const sameRow = (a: number, b: number, start: number, frames: number) => {
  const end = start + frames - 1
  const n = (r: number) => (r === end ? start : r)
  return n(a) === n(b)
}

describe('crowd-vat: rows and settings', () => {
  it('a clip takes duration × rows per second + 1 rows, at least 2', () => {
    expect(rowsFor(1)).toBe(CROWD_ROWS_PER_S + 1)
    expect(rowsFor(0)).toBe(2)
    expect(rowsFor(0.01)).toBe(2)
  })

  it('a GPU loop shows the nearest row of its clip time at every clock time, without a write', () => {
    const rows = { start: 100, frames: rowsFor(1.3), durationS: 1.3, loop: true }
    for (const speed of [1, 0.6, 1.7]) {
      const c: ClipClock = { rows, clipS: 0.42, atS: CLOCK_BASE_S + 12.3, speed }
      expect(gpuAdvances(c)).toBe(true)
      const s = vatSettings(c, c.atS)
      for (let t = c.atS; t < c.atS + 5; t += 0.0137) {
        // the settings do not change with the time: only the shader's clock moves
        expect(vatSettings(c, t)).toEqual(s)
        expect(sameRow(shaderRow(s, t), wantedRow(c, t), rows.start, rows.frames)).toBe(true)
      }
    }
  })

  it('a one-shot holds its last row; a slow or stopped clip is stepped by the CPU', () => {
    const rows = { start: 10, frames: rowsFor(0.5), durationS: 0.5, loop: false }
    const c: ClipClock = { rows, clipS: 0, atS: CLOCK_BASE_S, speed: 1 }
    expect(gpuAdvances(c)).toBe(false)
    for (const t of [0, 0.1, 0.25, 0.49, 0.6, 3]) {
      const s = vatSettings(c, CLOCK_BASE_S + t)
      expect(s[3]).toBe(0)
      expect(shaderRow(s, CLOCK_BASE_S + t)).toBe(wantedRow(c, CLOCK_BASE_S + t))
    }
    expect(shaderRow(vatSettings(c, CLOCK_BASE_S + 3), CLOCK_BASE_S + 3)).toBe(rows.start + rows.frames - 1)
    expect(gpuAdvances({ ...c, rows: { ...rows, loop: true }, speed: 0 })).toBe(false)
  })

  it('the far weapon code round-trips (+ level 0..7, seal tier × 8)', () => {
    expect(itemCode(0, null)).toBe(0)
    expect(itemCode(5, null)).toBe(5)
    expect(itemCode(12, 'sun')).toBe(7 + 24)
    expect(decodeItemCode(itemCode(3, 'moon'))).toEqual({ plus: 3, rare: 2 })
    expect(itemCode(undefined, 'star')).toBe(8)
  })

  it('half floats round to nearest and keep a bone translation within 1 mm', () => {
    for (const v of [0, 1, -2.5, 0.1, 1.234567, 65504, 1e-5]) expect(Math.abs(fromHalf(toHalf(v)) - v)).toBeLessThanOrEqual(Math.max(1e-3 * Math.abs(v), 6e-8))
    expect(fromHalf(toHalf(1e6))).toBe(Infinity)
  })

  it('the shader code reads the same uniforms in both languages and adds no varying', () => {
    for (const lang of ['glsl', 'wgsl'] as const) {
      const c = crowdItemCode(lang)
      expect(Object.keys(c.vertex)).toEqual(['CUSTOM_VERTEX_DEFINITIONS', 'CUSTOM_VERTEX_MAIN_END'])
      expect(Object.keys(c.fragment)).toEqual(['CUSTOM_FRAGMENT_UPDATE_ALPHA', 'CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION'])
      expect(Object.values(c.vertex).join('')).not.toMatch(/varying/)
      for (const u of ['sroCrowdG7', 'sroCrowdH1', 'sroCrowdR3', 'sroCrowdT3', 'sroCrowdA3', 'sroCrowdK']) expect(Object.values(c.fragment).join('')).toContain(u)
    }
  })
})

describe('closeSet and the crowd plan', () => {
  const others = (ds: readonly number[]): CrowdEntry[] => ds.map(d => ({ d, keep: false, wasCasting: false }))

  it('the CLOSE_COUNT nearest within CLOSE_RANGE_M are close; the kept ones always', () => {
    const ds = Array.from({ length: 20 }, (_, i) => 2 + i * 0.5)
    const c = closeSet(others(ds))
    expect(c.filter(Boolean)).toHaveLength(CLOSE_COUNT)
    expect(c.slice(0, CLOSE_COUNT).every(Boolean)).toBe(true)
    expect(closeSet(others([CLOSE_RANGE_M + 0.1])).some(Boolean)).toBe(false)
    expect(closeSet([{ d: 40, keep: true }])[0]).toBe(true)
  })

  it('a close one stays close to CLOSE_LEAVE_M and rank CLOSE_KEEP_RANK', () => {
    const ds = Array.from({ length: CLOSE_KEEP_RANK + 4 }, (_, i) => 1 + i * 0.3)
    const e = others(ds)
    e[CLOSE_COUNT]!.wasClose = true
    expect(closeSet(e)[CLOSE_COUNT]).toBe(true)
    e[CLOSE_KEEP_RANK + 1]!.wasClose = true
    expect(closeSet(e)[CLOSE_KEEP_RANK + 1]).toBe(false)
    expect(closeSet([{ d: CLOSE_LEAVE_M - 0.5, keep: false, wasClose: true }])[0]).toBe(true)
    expect(closeSet([{ d: CLOSE_LEAVE_M + 0.5, keep: false, wasClose: true }])[0]).toBe(false)
  })

  it('in a crowd, everyone outside the close set is a crowd candidate; not without the switch, the LOD or a crowd', () => {
    const ds = Array.from({ length: 30 }, (_, i) => 3 + i)
    const out = planCrowd(others(ds), null, true, [], true, true)
    expect(out.filter(o => o.close)).toHaveLength(CLOSE_COUNT)
    expect(out.every(o => o.close !== o.crowd)).toBe(true)
    expect(planCrowd(others(ds), null, true, [], true, false).some(o => o.crowd)).toBe(false)
    expect(planCrowd(others(ds), null, false, [], true, true).some(o => o.crowd)).toBe(false)
    expect(planCrowd(others(ds.slice(0, ANIM_FROM - 1)), null, true, [], true, true).some(o => o.crowd)).toBe(false)
    const kept = planCrowd([...others(ds), { d: 40, keep: true, wasCasting: false }], null, true, [], true, true)
    expect(kept.at(-1)!.crowd).toBe(false)
  })

  it('a member steps its clips at CROWD_STEP_HZ, casts nothing and gets a blob within NEAR_M where there are sun shadows', () => {
    const o = { ...FULL }
    crowdJoined(o, 20, true)
    expect(o.animMs).toBe(1000 / CROWD_STEP_HZ)
    expect(o.cascades).toBe(0)
    expect(o.blob).toBe(true)
    expect(o.offscreen).toBe('slow')
    const far = { ...FULL }
    crowdJoined(far, NEAR_M + 1, true)
    expect(far.blob).toBe(false)
    expect(far.offscreen).toBe('freeze')
    const low = { ...FULL }
    crowdJoined(low, 20, false)
    expect(low.blob).toBe(false)
  })
})

// ---- the runtime (NullEngine) ----

function setup() {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  new ArcRotateCamera('cam', -Math.PI / 2, Math.PI / 2, 10, Vector3.Zero(), scene)
  const library = new ModelLibrary(scene)
  cleanups.push(() => {
    library.dispose()
    scene.dispose()
    engine.dispose()
  })
  const tex = (n: number) => {
    const t = RawTexture.CreateRGBATexture(new Uint8Array(n * n * 4).fill(255), n, n, scene)
    t.getInternalTexture()!.isReady = true
    return t
  }
  const pbr = (name: string, t: RawTexture) => {
    const m = new PBRMaterial(name, scene)
    m.albedoTexture = t
    return m
  }
  /** Two joints (hips at 1 m, a hand 0.5 m above), a body box on the hips, a cloak box on the hand, a STAND1 that lifts the hand. */
  const container = () => {
    const root = new TransformNode('__root__', scene)
    const hips = new TransformNode('Hips', scene)
    hips.parent = root
    hips.position.set(0, 1, 0)
    const hand = new TransformNode('Hand', scene)
    hand.parent = hips
    hand.position.set(0, 0.5, 0)
    const skeleton = new Skeleton('skel', 'skel', scene)
    const bHips = new Bone('Hips', skeleton, null, Matrix.Translation(0, 1, 0))
    const bHand = new Bone('Hand', skeleton, bHips, Matrix.Translation(0, 0.5, 0))
    bHips.linkTransformNode(hips)
    bHand.linkTransformNode(hand)
    const part = (pn: string, mat: PBRMaterial, bone: number, y: number) => {
      const m = MeshBuilder.CreateBox(pn, { size: 0.2 }, scene)
      m.bakeTransformIntoVertices(Matrix.Translation(0, y, 0))
      const n = m.getTotalVertices()
      m.setVerticesData(VertexBuffer.MatricesIndicesKind, Array.from({ length: n * 4 }, (_, i) => (i % 4 === 0 ? bone : 0)), false, 4)
      m.setVerticesData(VertexBuffer.MatricesWeightsKind, Array.from({ length: n * 4 }, (_, i) => (i % 4 === 0 ? 1 : 0)), false, 4)
      m.material = mat
      m.skeleton = skeleton
      m.parent = root
      return m
    }
    const meshes = [part('body', pbr('A', tex(8)), 0, 1), part('cloak', pbr('B', tex(4)), 1, 1.5)]
    const anim = new Animation('lift', 'position', 30, Animation.ANIMATIONTYPE_VECTOR3, Animation.ANIMATIONLOOPMODE_CYCLE)
    anim.setKeys([
      { frame: 0, value: new Vector3(0, 0.5, 0) },
      { frame: 30, value: new Vector3(0, 0.9, 0) },
    ])
    const g = new AnimationGroup('STAND1', scene)
    g.addTargetedAnimation(anim, hand)
    const c = new AssetContainer(scene)
    c.transformNodes.push(root, hips, hand)
    c.meshes.push(...meshes)
    c.skeletons.push(skeleton)
    c.materials.push(...meshes.map(m => m.material!))
    c.animationGroups.push(g)
    c.removeAllFromScene()
    return c
  }
  let shared: AssetContainer | null = null
  /** An actor of the shared container (actors of one glb share its geometry and materials, as in the game). */
  const actor = (code = 'CHAR_TEST') => {
    const c = (shared ??= container())
    const a = new CharacterActor(scene, { code, glb: '/out/t.glb' }, { container: c, sidecar: null, packs: null })
    a.crowdSource = () => library.crowdTier
    a.outfitSource = () => library.outfitAtlases
    a.play('STAND1')
    scene.render()
    return a
  }
  return { scene, library, actor }
}

/** The OutfitAtlases' GPU copy cannot run on a NullEngine: a stand-in with one rect per texture. */
function fakeAtlases(tier: CrowdTier, scene: Scene): void {
  const atl = {
    acquire(parts: readonly { texture: { uniqueId: number } }[]) {
      const slot = new Map<number, number>()
      for (const p of parts) if (!slot.has(p.texture.uniqueId)) slot.set(p.texture.uniqueId, slot.size)
      const rects = [...slot.keys()].map((_, i) => ({ x: 4 + i * 24, y: 4, w: 16, h: 16 }))
      return { key: 'k', plan: { size: 256, scale: 1, rects }, slot, material: new PBRMaterial('atlas', scene), users: 1 }
    },
    release() {},
    ready: () => true,
    copyInto() {},
  }
  ;(tier as unknown as { atlases: () => unknown }).atlases = () => atl
}

describe('CrowdTier and CharacterActor.setCrowd (NullEngine)', () => {
  it('a member is one thin instance of its outfit batch; its parts hidden; back on leaving', () => {
    const { scene, library, actor } = setup()
    fakeAtlases(library.crowdTier, scene)
    const a = actor()
    expect(a.setCrowd(true)).toBe(true)
    expect(a.inCrowd).toBe(true)
    for (const n of ['body', 'cloak']) expect(a.meshes.find(m => m.name === n)!.isEnabled()).toBe(false)
    scene.render()
    const st = library.crowdTier.stats()
    expect(st.members).toBe(1)
    expect(st.batches).toBe(1)
    expect(st.drawn).toBe(1)
    const batch = a.crowdInfo!.batch
    const mesh = batch.meshes[0]!.mesh as Mesh
    expect(mesh.thinInstanceCount).toBe(1)
    expect(mesh.bakedVertexAnimationManager).toBe(batch.kind.manager)
    expect(mesh.getTotalVertices()).toBe(2 * a.meshes.find(m => m.name === 'body')!.getTotalVertices())
    // the instance matrix is the root's
    expect([...batch.mats.subarray(0, 16)]).toEqual([...a.root.getWorldMatrix().m].map(v => Math.fround(v)))
    // a second actor in the same outfit shares the batch: one draw for both
    const b = actor()
    expect(b.setCrowd(true)).toBe(true)
    expect(b.crowdInfo!.batch).toBe(batch)
    scene.render()
    expect(mesh.thinInstanceCount).toBe(2)
    expect(library.crowdTier.stats().batches).toBe(1)
    // leaving: the parts come back, the instance goes
    a.setCrowd(false)
    expect(a.inCrowd).toBe(false)
    for (const n of ['body', 'cloak']) expect(a.meshes.find(m => m.name === n)!.isEnabled()).toBe(true)
    scene.render()
    expect(mesh.thinInstanceCount).toBe(1)
    b.dispose()
    scene.render()
    expect(library.crowdTier.stats().members).toBe(0)
  })

  it('the VAT rows are the skeleton skin matrices × the parts transform at the clip time of each row', () => {
    const { scene, library, actor } = setup()
    fakeAtlases(library.crowdTier, scene)
    const a = actor()
    a.setCrowd(true)
    const m = a.crowdInfo!
    const kind = m.batch.kind
    const rows = m.clock!.rows
    expect(rows.frames).toBe(rowsFor(1))
    // row j of the clip: the hand at 0.5 + 0.4 j / (frames − 1) above the hips; the skin matrix of the hand moves it by that − 0.5
    for (const j of [0, 10, rows.frames - 1]) {
      const mat = kind.matrixAt(rows.start + j, 1, new Matrix())
      const p = Vector3.TransformCoordinates(new Vector3(0, 1.5, 0), mat)
      expect(p.y).toBeCloseTo(1.5 + (0.4 * j) / (rows.frames - 1), 4)
    }
    // the hips (bone 0) do not move
    const h = Vector3.TransformCoordinates(new Vector3(0, 1, 0), kind.matrixAt(rows.start + 7, 0, new Matrix()))
    expect(h.y).toBeCloseTo(1, 4)
    // the half-float copy the GPU gets holds the same values
    const i = ((rows.start + 10) * kind.width + 4) * 4 + 13
    expect(fromHalf(kind.half[i]!)).toBeCloseTo(kind.data[i]!, 2)
  })

  it('a weapon on a socket bone is bound to that bone where the socket holds it, and its code reaches the instance', () => {
    const { scene, library, actor } = setup()
    fakeAtlases(library.crowdTier, scene)
    const a = actor()
    // a sword hung on the hand: 0.3 m out along x from the hand joint
    const sword = MeshBuilder.CreateBox('sword', { size: 0.1 }, scene)
    sword.material = (() => {
      const mat = new PBRMaterial('S', scene)
      const t = RawTexture.CreateRGBATexture(new Uint8Array(16 * 4).fill(200), 4, 4, scene)
      t.getInternalTexture()!.isReady = true
      mat.albedoTexture = t
      return mat
    })()
    const hand = a.joint('Hand')!
    const itemRoot = new TransformNode('swordRoot', scene)
    itemRoot.parent = hand
    sword.parent = itemRoot
    sword.position.set(0.3, 0, 0)
    ;(a as unknown as { worn: unknown[] }).worn.push({ code: 'SWORD', slot: 'weapon', nodes: [itemRoot], meshes: [sword], skeletons: [], dummies: new Map(), socket: a.skeleton!.bones[1] })
    ;(a as unknown as { plusBySlot: Record<string, number> }).plusBySlot = { weapon: 5 }
    a.glow = {} as never
    expect(a.setCrowd(true)).toBe(true)
    const mem = a.crowdInfo!
    expect(sword.isEnabled()).toBe(false)
    const mesh = mem.batch.meshes[0]!.mesh as Mesh
    // the sword's vertices: bound to the hand alone, u moved by 2 × ITEM_WEAPON
    const n = mesh.getTotalVertices()
    const idx = mesh.getVerticesData(VertexBuffer.MatricesIndicesKind)!
    const uv = mesh.getVerticesData(VertexBuffer.UVKind)!
    const pos = mesh.getVerticesData(VertexBuffer.PositionKind)!
    const s0 = n - sword.getTotalVertices()
    expect(idx[s0 * 4]).toBe(1)
    expect(uv[s0 * 2]!).toBeGreaterThanOrEqual(2)
    expect(uv[s0 * 2]!).toBeLessThan(3)
    // at the row of the clip time now, the sword's first vertex lands where the socket puts it (root space)
    const kind = mem.batch.kind
    const row = mem.clock!.rows.start + Math.round((mem.clock!.clipS * (mem.clock!.rows.frames - 1)) / mem.clock!.rows.durationS)
    const v = Vector3.TransformCoordinates(new Vector3(pos[s0 * 3]!, pos[s0 * 3 + 1]!, pos[s0 * 3 + 2]!), kind.matrixAt(row, 1, new Matrix()))
    hand.computeWorldMatrix(true)
    const local = sword.getVerticesData(VertexBuffer.PositionKind)!
    const want = Vector3.TransformCoordinates(new Vector3(local[0]!, local[1]!, local[2]!), sword.computeWorldMatrix(true).multiply(Matrix.Invert(a.root.computeWorldMatrix(true))))
    expect(Vector3.Distance(v, want)).toBeLessThan(2e-3)
    scene.render()
    const items = mesh.getVertexBuffer(CROWD_ITEM_KIND)
    expect(items).toBeTruthy()
    expect(mem.batch.items[0]).toBe(itemCode(5, null))
  })

  it('the tier does not take a faded, highlighted, held, riding or carrying actor; a hold drops a member', () => {
    const { scene, library, actor } = setup()
    fakeAtlases(library.crowdTier, scene)
    const a = actor()
    a.setOpacity(0.5)
    expect(a.setCrowd(true)).toBe(false)
    a.setOpacity(1)
    a.setHighlight(true)
    expect(a.setCrowd(true)).toBe(false)
    a.setHighlight(false)
    a.carrying = true
    expect(a.setCrowd(true)).toBe(false)
    a.carrying = false
    const saddle = new TransformNode('saddle', scene)
    a.attachTo(saddle)
    expect(a.setCrowd(true)).toBe(false)
    a.attachTo(null)
    expect(a.setCrowd(true)).toBe(true)
    a.holdCrowd('berserk', true)
    expect(a.inCrowd).toBe(false)
    expect(a.setCrowd(true)).toBe(false)
    a.holdCrowd('berserk', false)
    expect(a.setCrowd(true)).toBe(true)
    // a re-dress drops it at once (the next plan takes the new parts)
    a.applyDress({ comp: null, items: [], fallback: null, family: null, gender: 'female', volume: undefined, plus: {}, rarity: {} })
    expect(a.inCrowd).toBe(false)
  })
})
