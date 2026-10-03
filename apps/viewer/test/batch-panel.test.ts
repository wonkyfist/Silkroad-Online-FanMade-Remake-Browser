// The viewer's batching lab (BT-L, docs/BATCHING.md §4.4, §5; docs/WAVE_PLAN6.md §6.1): the bench spots, the A/B's
// image difference and ambient-shift verdict, and the toggle: World.setBatching off → on (the Options → Advanced →
// World batching row's call) rebuilds without leftovers, cycle after cycle. The GPU parts run in the browser.
import { MeshBuilder, PBRMaterial, type Scene } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldModel } from '../../../packages/convert/src/world/manifest.ts'
import type { BatchFactory, BatchSlot } from '@sro/world-render'
import { FakeBatch, w10World, type W10Setup } from '../../../packages/world-render/test/w10-fixture.ts'
import {
  BENCH_SPOTS,
  ambientShift,
  countGrowth,
  findLeftovers,
  formatCounters,
  imageDiff,
  leftoverProblems,
  sceneCounts,
  spotByName,
  tableBytes,
  worldIdle,
} from '../src/world/batch-panel.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

describe('bench spots', () => {
  it('cover BATCHING §5\'s scenes: plaza noon, gate in a storm, fields at night, plus the grove', () => {
    expect(new Set(BENCH_SPOTS.map(s => s.name)).size).toBe(BENCH_SPOTS.length)
    expect(spotByName('plaza')).toMatchObject({ x: 101, z: -70, time: 0.5, weather: 'clear' })
    expect(spotByName('gate')?.weather).toBe('storm')
    const night = spotByName('fields')!.time
    expect(night < 0.25 || night > 0.8).toBe(true)
    expect(spotByName('grove')).toBeDefined()
    expect(spotByName('nowhere')).toBeUndefined()
  })
})

/** A w×h RGBA image filled with `rgb`, `lower` added to the rows of the lower `frac` of it. */
function image(w: number, h: number, rgb: number, lower = 0, frac = 0.6): Uint8ClampedArray {
  const a = new Uint8ClampedArray(w * h * 4)
  const start = Math.floor(h * (1 - frac))
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const v = rgb + (y >= start ? lower : 0)
      a[i] = a[i + 1] = a[i + 2] = v
      a[i + 3] = 255
    }
  }
  return a
}

describe('the A/B image difference (F14)', () => {
  it('is zero for the same image; a uniform lower-frame brightening shows as a signed offset there', () => {
    const a = image(20, 10, 100)
    expect(imageDiff(a, a, 20, 10)).toMatchObject({ mean: 0, over16: 0, signed: 0, lowerMean: 0, lowerSigned: 0 })
    const d = imageDiff(a, image(20, 10, 100, 3), 20, 10)
    expect(d.lowerSigned).toBe(3)
    expect(d.lowerMean).toBe(3)
    expect(d.signed).toBeCloseTo(1.8, 5)
    expect(d.over16).toBe(0)
  })

  it('counts pixels over 16/255 by their largest channel; images of different sizes throw', () => {
    const a = image(10, 10, 50)
    const b = image(10, 10, 50)
    for (let p = 0; p < 10; p++) b[p * 4 + 1] = 70 // ten pixels, green +20
    expect(imageDiff(a, b, 10, 10).over16).toBe(0.1)
    expect(() => imageDiff(a, image(10, 9, 50), 10, 10)).toThrow(/size/)
  })

  it('calls an ambient shift only above the noise floor and over 1/255', () => {
    const base = image(20, 10, 100)
    const noise = imageDiff(base, base, 20, 10)
    expect(ambientShift(imageDiff(base, image(20, 10, 100, 2), 20, 10), noise)).toBe(true)
    expect(ambientShift(imageDiff(base, image(20, 10, 100, 1), 20, 10), noise)).toBe(false)
    // The same offset inside a noisy floor is not a shift.
    const noisy = { ...noise, lowerSigned: 1.5, lowerMean: 4 }
    expect(ambientShift(imageDiff(base, image(20, 10, 100, 2), 20, 10), noisy)).toBe(false)
    // A drift in time (the third capture moved on the same way) is not the batch's: the back pair must agree in sign.
    const ab = imageDiff(base, image(20, 10, 100, 2), 20, 10)
    expect(ambientShift(ab, noise, imageDiff(image(20, 10, 100, 4), image(20, 10, 100, 2), 20, 10))).toBe(false)
    expect(ambientShift(ab, noise, imageDiff(base, image(20, 10, 100, 2), 20, 10))).toBe(true)
  })
})

describe('leftovers', () => {
  it('names what a switch left behind; with batching on only meshes no region batch owns', () => {
    const clean = { batchMeshes: 0, strayMeshes: 0, groupMaterials: 0, regionBatches: 0, slots: 0, batcher: false }
    expect(leftoverProblems(clean, false)).toEqual([])
    const on = { batchMeshes: 12, strayMeshes: 0, groupMaterials: 4, regionBatches: 3, slots: 9, batcher: true }
    expect(leftoverProblems(on, true)).toEqual([])
    expect(leftoverProblems({ ...on, strayMeshes: 2 }, true)).toEqual(['2 batch mesh(es) owned by no region batch'])
    expect(leftoverProblems(on, false)).toHaveLength(5)
    expect(countGrowth({ meshes: 5, materials: 2, textures: 1, geometries: 4 }, { meshes: 5, materials: 3, textures: 1, geometries: 3 })).toEqual(['materials 2 → 3'])
    expect(tableBytes({ albedoBytes: 1, nraoBytes: 2, lightmapBytes: 4, slots: 9 })).toBe(7)
  })
})

describe('the toggle rebuilds without leftovers (World.setBatching, the Advanced row\'s call)', () => {
  async function world(): Promise<{ s: W10Setup; made: FakeBatch[] }> {
    const made: FakeBatch[] = []
    // A slot stands for a converted material the batch does not own (the model cache's): one per model, kept.
    const converted = new Map<number, PBRMaterial>()
    const slots = (model: WorldModel, scene: Scene) => {
      let m = converted.get(model.index)
      if (!m) converted.set(model.index, m = new PBRMaterial(`converted ${model.index}`, scene))
      return [{ model, material: m as unknown as BatchSlot['material'], record: null, cls: 'merge' as const }]
    }
    const factory: BatchFactory = host => {
      const b = new FakeBatch(host.scene, { slots })
      made.push(b)
      return b
    }
    const s = await w10World({ parts: { batch: factory } })
    cleanups.push(s.dispose)
    await s.run()
    return { s, made }
  }

  it('off leaves no batch mesh, region batch or batcher; on batches again; the scene does not grow per cycle', async () => {
    const { s, made } = await world()
    expect(worldIdle(s.world)).toBe(true)
    const first = findLeftovers(s.scene, s.world)
    expect(first.batchMeshes).toBeGreaterThan(0)
    expect(first.regionBatches).toBe(s.stream.stats.ready)
    expect(leftoverProblems(first, true)).toEqual([])
    // A mesh another part made for a live region batch (BT-S's caster names the batch's owner) is owned; a dead owner's is not.
    const owner = [...s.world.objects.regionBatches.keys()][0]!
    const caster = MeshBuilder.CreateBox(`cutoutCaster:${owner}:0`, { size: 1 }, s.scene)
    caster.metadata = { sroWorld: 'shadowProxy', sroBatch: 'cutoutCaster' }
    const orphan = MeshBuilder.CreateBox('cutoutCaster:999999:1', { size: 1 }, s.scene)
    orphan.metadata = { sroWorld: 'shadowProxy', sroBatch: 'cutoutCaster' }
    expect(findLeftovers(s.scene, s.world).strayMeshes).toBe(1)
    caster.dispose()
    orphan.dispose()
    const onCounts = sceneCounts(s.scene)
    expect(formatCounters(s.world, 10, 20)[0]).toMatch(/batching {2}on · part live/)

    let offCounts = null as ReturnType<typeof sceneCounts> | null
    for (let cycle = 0; cycle < 3; cycle++) {
      s.world.setBatching(false)
      await s.run()
      const off = findLeftovers(s.scene, s.world)
      expect(leftoverProblems(off, false)).toEqual([])
      expect(s.world.objects.stats.chunks).toBe(s.stream.stats.ready)
      expect(formatCounters(s.world, 10, 20)).toHaveLength(2)
      const oc = sceneCounts(s.scene)
      if (offCounts) expect(countGrowth(offCounts, oc)).toEqual([])
      offCounts = oc

      s.world.setBatching(true)
      await s.run()
      const on = findLeftovers(s.scene, s.world)
      expect(leftoverProblems(on, true)).toEqual([])
      expect(on.regionBatches).toBe(s.stream.stats.ready)
      expect(s.world.objects.stats.chunks).toBe(0)
      expect(countGrowth(onCounts, sceneCounts(s.scene))).toEqual([])
    }
    expect(made).toHaveLength(4)
    for (const b of made.slice(0, 3)) {
      expect(b.released).toBe(1)
      expect(b.live.size).toBe(0)
    }
  })
})
