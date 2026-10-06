/**
 * Siege of Jangan, layer 2: the walls' dressing on a NullEngine scene (docs/SIEGE.md §9.2, §14 "Client"): a snapshot
 * places the piles as they lie, a live breach falls and ends exactly in the pile that stays (no leftover chunks), chips
 * fly and vanish, the scaffold follows the looks, a broken end gets its own vertices back when the gap closes, the pools
 * are reused (no growth over many cycles, nothing created per frame) and dispose leaves nothing behind.
 */
import { CreateBox, Mesh, NullEngine, Scene, StandardMaterial, VertexBuffer } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { WallDressing, type WallSideSource } from '../src/world/walls/dressing.ts'
import { WALL_TIERS, wallLook, type WallLook, type WallTier } from '../src/world/walls/look.ts'
import { SIDE, flatGround, walls } from './walls-fixture.ts'

const W = walls()

function setup(tier: WallTier = 'medium') {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  const brick = new StandardMaterial('CJ_w_wall01', scene)
  const core = new StandardMaterial('CJ_w_wall02', scene)
  const pieces = new Map<string, Mesh>()
  for (const seg of W.segments) {
    for (const t of seg.thirds) {
      const m = CreateBox(`${t.id}|CJ_s_wall01`, { width: t.to - t.from, height: 20, depth: 20 }, scene)
      m.position.set((t.from + t.to) / 2, 10, 20)
      m.material = brick
      pieces.set(t.id, m)
    }
  }
  const src: WallSideSource = {
    info: SIDE, brick, core, lm: { brick: [0.5, 0.5], core: [0.5, 0.5] },
    faces: (id) => (pieces.has(id) ? [pieces.get(id)!] : []),
    meshes: (id) => (pieces.has(id) ? [pieces.get(id)!] : []),
  }
  const falls: number[] = []
  const d = new WallDressing(scene, W, [src], { tier: () => tier, ground: flatGround, onFall: (_x, _y, _z, n) => falls.push(n) })
  // (Babylon makes the scene's own 'default material' once, lazily: not ours)
  const counts = () => ({ meshes: scene.meshes.length, materials: scene.materials.filter((m) => m !== scene.defaultMaterial).length, textures: scene.textures.length, particles: scene.particleSystems.length })
  return { engine, scene, d, pieces, falls, counts }
}

/** The live instance buffer of a pool mesh (thinInstanceGetWorldMatrices caches its first answer). */
const matrices = (m: Mesh): number[] => Array.from((m as unknown as { _thinInstanceDataStorage: { matrixData: Float32Array } })._thinInstanceDataStorage.matrixData.subarray(0, m.thinInstanceCount * 16))

const looksOf = (entries: [string, WallLook][]) => new Map(entries)
const breached = (o: { scaffold?: boolean; repairing?: boolean } = {}) => wallLook({ stage: 'breached', pct: -10, ...o })
const rubble = () => wallLook({ stage: 'rubble', pct: -50 })
const intact = () => wallLook({ stage: 'intact', pct: 100 })

let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  cleanup = null
})

describe('WallDressing', () => {
  it('a snapshot lays the pile, the teeth, the mound and the broken ends at once, without a fall', () => {
    const { d, falls, engine } = setup()
    cleanup = () => engine.dispose()
    d.apply(looksOf([['S2', breached()]]), false)
    const s = d.stats
    expect(s.falling).toBe(0)
    expect(falls).toEqual([])
    expect(s.chunks).toBe(WALL_TIERS.medium.pileChunks + 2 * WALL_TIERS.medium.teeth)
    expect(s.mounds).toBe(1)
    expect(s.edges).toBe(2)
    // the standing ends beside the gap are deep-cracked
    expect(s.decals).toBe(2)
  })

  it('a live breach falls and settles into the pile that stays (no leftover chunks)', () => {
    const { d, falls, engine, scene } = setup()
    cleanup = () => engine.dispose()
    d.apply(looksOf([['S2', breached()]]), true)
    expect(falls).toEqual([1])
    expect(d.animating).toBe(true)
    const pool = scene.getMeshByName('siegeStone:S:brick0') as Mesh
    const mid = matrices(pool)
    for (let t = 0; t < 6; t += 0.1) d.update(0.1)
    expect(d.animating).toBe(false)
    expect(d.stats.falling).toBe(0)
    const after = matrices(pool)
    // the same instances, moved (they fell), and a snapshot of the same look builds exactly these matrices
    expect(after.length).toBe(mid.length)
    expect(after).not.toEqual(mid)
    const { d: d2, scene: scene2, engine: e2 } = setup()
    d2.apply(looksOf([['S2', breached()]]), false)
    const ref = matrices(scene2.getMeshByName('siegeStone:S:brick0') as Mesh)
    expect(after.slice(0, ref.length).map((v) => +v.toFixed(4))).toEqual(ref.map((v) => +v.toFixed(4)))
    e2.dispose()
  })

  it('a collapse from breached drops the other two thirds; a chip throws bits that vanish', () => {
    const { d, falls, engine } = setup()
    cleanup = () => engine.dispose()
    d.apply(looksOf([['S2', breached()]]), false)
    d.apply(looksOf([['S2', rubble()]]), true)
    expect(falls).toEqual([2])
    expect(d.stats.mounds).toBe(3)
    for (let t = 0; t < 6; t += 0.1) d.update(0.1)
    d.moment('chip', 'S1', 20, 18, 30)
    d.update(0.05)
    expect(d.stats.bits).toBe(WALL_TIERS.medium.chipChunks)
    for (let t = 0; t < 5; t += 0.1) d.update(0.1)
    expect(d.stats.bits).toBe(0)
  })

  it('scaffold over a and c of a segment climbing out of rubble, and gone when it closes', () => {
    const { d, engine } = setup()
    cleanup = () => engine.dispose()
    d.apply(looksOf([['S1', breached({ scaffold: true })]]), false)
    const beams = d.stats.scaffoldBeams
    expect(beams).toBeGreaterThan(80)
    d.apply(looksOf([['S1', wallLook({ stage: 'cracked', pct: 10, repairing: true })]]), true)
    // repairing a closed segment: all three thirds
    expect(d.stats.scaffoldBeams).toBeGreaterThan(beams)
    d.apply(looksOf([['S1', intact()]]), true)
    expect(d.stats.scaffoldBeams).toBe(0)
  })

  it('a broken end gets its own vertices back when the gap closes', () => {
    const { d, engine, pieces } = setup()
    cleanup = () => engine.dispose()
    const a = pieces.get('S2a')!
    const orig = Array.from(a.getVerticesData(VertexBuffer.PositionKind)!)
    d.apply(looksOf([['S2', breached()]]), false)
    const notched = Array.from(a.getVerticesData(VertexBuffer.PositionKind)!)
    expect(notched).not.toEqual(orig)
    d.apply(looksOf([['S2', intact()]]), true)
    expect(Array.from(a.getVerticesData(VertexBuffer.PositionKind)!)).toEqual(orig)
  })

  it('reuses its pools: many cycles do not grow the scene, frames create nothing, dispose leaves nothing', () => {
    const { d, engine, counts } = setup()
    cleanup = () => engine.dispose()
    const base = counts()
    const cycle = () => {
      d.apply(looksOf([['S1', breached()], ['S2', wallLook({ stage: 'cracked', pct: 20 })]]), true)
      for (let t = 0; t < 4; t += 0.1) d.update(0.1)
      d.apply(looksOf([['S1', rubble()], ['S3', breached()]]), true)
      d.moment('chip', 'S2', 70, 18, 30)
      d.moment('crack', 'S2', 70, 18, 30)
      for (let t = 0; t < 6; t += 0.1) d.update(0.1)
      d.apply(looksOf([['S1', intact()], ['S2', intact()], ['S3', intact()]]), true)
      for (let t = 0; t < 1; t += 0.1) d.update(0.1)
    }
    cycle()
    const once = counts()
    for (let i = 0; i < 4; i++) cycle()
    expect(counts()).toEqual(once)
    // a frame never creates a scene object
    d.apply(looksOf([['S2', breached()]]), true)
    const during = counts()
    for (let t = 0; t < 3; t += 0.05) {
      d.update(0.05)
      expect(counts()).toEqual(during)
    }
    d.dispose()
    expect(counts()).toEqual(base)
    // and is idempotent
    d.dispose()
    d.update(0.1)
    d.apply(looksOf([['S2', rubble()]]), true)
    expect(counts()).toEqual(base)
  })

  it('Low draws less', () => {
    const lo = setup('low')
    const hi = setup('high')
    lo.d.apply(looksOf([['S2', rubble()]]), false)
    hi.d.apply(looksOf([['S2', rubble()]]), false)
    expect(lo.d.stats.chunks).toBeLessThan(hi.d.stats.chunks)
    lo.engine.dispose()
    hi.engine.dispose()
  })
})
