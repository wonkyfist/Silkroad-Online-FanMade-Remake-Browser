/**
 * T12-N, the band byte and its slots (docs/TREES.md Part W §W3.3; docs/WAVE_PLAN8.md §6.2 T12-N, D24):
 * - the bands × the range scale (trees 40 / 110 m, plants 25 m; distance − radius), the 3 m hysteresis, never near
 *   while a species' overlay is not ready, plants never near;
 * - band 3 (the editor's hide) and back;
 * - the crowded-plaza rule at 14 / 15 players (Medium only; the app's count or the town part's);
 * - the slot free list (lowest first, kept across a reload's second owner, freed with the last, refused when full);
 * - the R8 128 × 64 texture: set on the foliage plugins with the first slot, uploaded once per refill that changed a
 *   byte, cleared and disposed with the part.
 */
import { Constants, NullEngine, Scene, Vector3, type Camera } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldModel, WorldPlacement } from '../../convert/src/world/manifest.ts'
import type { RegionListener } from '../src/objects.ts'
import { TREE_BAND_TEX_H, TREE_BAND_TEX_W } from '../src/pbr/foliage-plugin.ts'
import {
  BAND_FAR,
  BAND_HIDDEN,
  BAND_MID,
  BAND_NEAR,
  BAND_NONE,
  BAND_SLOTS,
  CROWD_PLAYERS,
  PLANT_NEAR_M,
  REFILL_STEP_M,
  TREE_MID_M,
  TREE_NEAR_M,
  TreeSlots,
  TreesNearField,
  bandFor,
  bandIndex,
  bandRule,
  placementKey,
} from '../src/trees/index.ts'
import type { TreesHost } from '../src/trees/types.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

// ---- the pure rule ------------------------------------------------------------------------------------------------

describe('the bands (TREES §W3.3): distance − radius × the range scale, 3 m hysteresis', () => {
  const rule = bandRule(1)

  it('trees: near < 40 m, mid < 110 m, far beyond; scaled by the range scale', () => {
    expect(rule).toMatchObject({ nearM: TREE_NEAR_M, midM: TREE_MID_M, plantM: PLANT_NEAR_M, hysteresisM: 3 })
    expect(bandFor(0, false, BAND_NONE, rule)).toBe(BAND_NEAR)
    expect(bandFor(-5, false, BAND_NONE, rule)).toBe(BAND_NEAR)
    expect(bandFor(39.9, false, BAND_NONE, rule)).toBe(BAND_NEAR)
    expect(bandFor(40, false, BAND_NONE, rule)).toBe(BAND_MID)
    expect(bandFor(109.9, false, BAND_NONE, rule)).toBe(BAND_MID)
    expect(bandFor(110, false, BAND_NONE, rule)).toBe(BAND_FAR)
    expect(bandFor(5000, false, BAND_NONE, rule)).toBe(BAND_FAR)
    // Options' sight / the create screen's 0.6
    const s = bandRule(0.6)
    expect(s.nearM).toBeCloseTo(24)
    expect(s.midM).toBeCloseTo(66)
    expect(s.plantM).toBeCloseTo(15)
    expect(bandFor(30, false, BAND_NONE, s)).toBe(BAND_MID)
    expect(bandFor(70, false, BAND_NONE, s)).toBe(BAND_FAR)
    expect(bandFor(14, true, BAND_NONE, s)).toBe(BAND_MID)
    expect(bandFor(16, true, BAND_NONE, s)).toBe(BAND_FAR)
    // a bad scale is 1
    expect(bandRule(Number.NaN)).toEqual(rule)
    expect(bandRule(0)).toEqual(rule)
  })

  it('hysteresis: outward 3 m past a boundary, inward at it', () => {
    // near → mid
    expect(bandFor(42.9, false, BAND_NEAR, rule)).toBe(BAND_NEAR)
    expect(bandFor(43, false, BAND_NEAR, rule)).toBe(BAND_MID)
    expect(bandFor(40.5, false, BAND_MID, rule)).toBe(BAND_MID)
    expect(bandFor(39.9, false, BAND_MID, rule)).toBe(BAND_NEAR)
    // mid → far
    expect(bandFor(112.9, false, BAND_MID, rule)).toBe(BAND_MID)
    expect(bandFor(113, false, BAND_MID, rule)).toBe(BAND_FAR)
    expect(bandFor(110.5, false, BAND_FAR, rule)).toBe(BAND_FAR)
    expect(bandFor(109.9, false, BAND_FAR, rule)).toBe(BAND_MID)
    // a jump across both boundaries
    expect(bandFor(200, false, BAND_NEAR, rule)).toBe(BAND_FAR)
    expect(bandFor(1, false, BAND_FAR, rule)).toBe(BAND_NEAR)
    // hidden (band 3) and a fresh entry carry no hysteresis
    expect(bandFor(41, false, BAND_HIDDEN, rule)).toBe(BAND_MID)
    expect(bandFor(41, false, BAND_NONE, rule)).toBe(BAND_MID)
    // the index helper
    expect(bandIndex(41, [40, 110], 0, 3)).toBe(0)
    expect(bandIndex(41, [40, 110], -1, 3)).toBe(1)
  })

  it('plants: never near (no overlay); P-LOD0 within 25 m, P-LOD1 beyond, with the same hysteresis', () => {
    expect(bandFor(0, true, BAND_NONE, rule)).toBe(BAND_MID)
    expect(bandFor(24.9, true, BAND_NONE, rule)).toBe(BAND_MID)
    expect(bandFor(25, true, BAND_NONE, rule)).toBe(BAND_FAR)
    expect(bandFor(27.9, true, BAND_MID, rule)).toBe(BAND_MID)
    expect(bandFor(28, true, BAND_MID, rule)).toBe(BAND_FAR)
    expect(bandFor(24.9, true, BAND_FAR, rule)).toBe(BAND_MID)
    expect(bandFor(-1, true, BAND_NEAR, rule)).toBe(BAND_MID)
  })

  it('a tree whose overlay is not ready (or the rule\'s near is 0: cut 17) stays mid however near', () => {
    expect(bandFor(0, false, BAND_NONE, rule, false)).toBe(BAND_MID)
    expect(bandFor(5, false, BAND_NEAR, rule, false)).toBe(BAND_MID)
    expect(bandFor(120, false, BAND_MID, rule, false)).toBe(BAND_FAR)
    const cut = bandRule(1, true, 0)
    expect(cut.nearM).toBe(0)
    expect(bandFor(0, false, BAND_NONE, cut)).toBe(BAND_MID)
  })

  it('the crowded-plaza rule (D24): the overlay\'s near boundary at 20 m', () => {
    const c = bandRule(1, true)
    expect(c.nearM).toBe(20)
    expect(c.midM).toBe(TREE_MID_M)
    expect(bandFor(19.9, false, BAND_NONE, c)).toBe(BAND_NEAR)
    expect(bandFor(25, false, BAND_NONE, c)).toBe(BAND_MID)
    // a near tree past the new boundary (+ hysteresis) leaves at once
    expect(bandFor(30, false, BAND_NEAR, c)).toBe(BAND_MID)
    expect(bandRule(0.5, true).nearM).toBe(10)
  })
})

// ---- the slots ----------------------------------------------------------------------------------------------------

describe('the slots: a free list keyed by the placement key', () => {
  it('lowest first; a second owner keeps the slot; freed with the last owner; refused when full', () => {
    const s = new TreeSlots(4)
    const a = s.acquire(placementKey(0x6464, 1), 7)!
    const b = s.acquire(placementKey(0x6464, 2), 7)!
    expect([a.entry.slot, b.entry.slot]).toEqual([0, 1])
    expect(a.fresh && b.fresh).toBe(true)
    // a reload: the same key under a new owner before the old goes
    const again = s.acquire(placementKey(0x6464, 1), 9)!
    expect(again.fresh).toBe(false)
    expect(again.entry).toBe(a.entry)
    expect(a.entry.owners).toEqual([7, 9])
    expect(s.releaseOwner(7).map(e => e.slot)).toEqual([1])
    expect(s.slotOf(placementKey(0x6464, 1))).toBe(0)
    expect(s.slotOf(placementKey(0x6464, 2))).toBeNull()
    expect(s.used).toBe(1)
    // the freed slot is handed out again first
    expect(s.acquire(placementKey(0x6565, 3), 9)!.entry.slot).toBe(1)
    s.acquire(placementKey(0x6565, 4), 9)
    s.acquire(placementKey(0x6565, 5), 9)
    expect(s.used).toBe(4)
    expect(s.acquire(placementKey(0x6565, 6), 9)).toBeNull()
    expect(s.refused).toBe(1)
    expect(s.releaseOwner(9).length).toBe(4)
    expect(s.used).toBe(0)
    expect(new TreeSlots().capacity).toBe(BAND_SLOTS)
    expect(BAND_SLOTS).toBe(TREE_BAND_TEX_W * TREE_BAND_TEX_H)
    expect(BAND_SLOTS).toBe(8192)
  })
})

// ---- the part on a fake world (no overlay: the batch has no table) ------------------------------------------------

interface FakeWorld {
  host: TreesHost
  part: TreesNearField
  listeners: RegionListener[]
  band: { tex: unknown }
  world: { quality: string; objects: { drawRangeScale: number; showStatic: boolean }; town: { stats(): Record<string, number> } | null }
  townPlayers: { n: number }
  /** Places `n` swapped trees of species `plant`/tree at x = 0, 10, 20 … (owner `owner`, region 0x6464). */
  place(owner: number, xs: number[], opts?: { plant?: boolean; uid0?: number }): WorldPlacement[]
  cam(x: number, z?: number): Camera
}

function species(index: number, plant: boolean): WorldModel {
  return {
    index, source: `res\\nature\\common\\tree\\w12\\sp${index}.bsr#species`, glb: `models/trees/sp${index}/far.glb`, sidecar: plant ? 'plant' : 'tree',
    kind: 'static', animations: [], defaultClip: null, lightmappedMeshes: 0, boundsMin: [-1, 0, -1], boundsMax: [1, 2, 1], bytes: 0, validatorErrors: null,
  } as WorldModel
}

function fakeWorld(quality = 'medium'): FakeWorld {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  const listeners: RegionListener[] = []
  const band = { tex: null as unknown }
  const townPlayers = { n: 0 }
  const tree = species(1, false)
  const plant = species(2, true)
  const retailTree = { index: 3, source: 'res\\nature\\common\\tree\\tre_pine07_03.bsr' } as WorldModel
  const retailPlant = { index: 4, source: 'res\\nature\\common\\tree\\tre_dry02.bsr' } as WorldModel
  const world = {
    quality,
    objects: {
      drawRangeScale: 1,
      showStatic: true,
      addRegionListener(l: RegionListener) {
        listeners.push(l)
        return () => listeners.splice(listeners.indexOf(l), 1)
      },
    },
    town: { stats: () => ({ players: townPlayers.n }) } as { stats(): Record<string, number> } | null,
    foliage: { shared: { get band() { return band.tex }, setBand(t: unknown) { band.tex = t } } },
    materials: {},
    assets: {},
    manifest: { models: [tree, plant] },
    batch: {
      trees: {
        swapOf: (m: WorldModel) => (m.index === 3 ? { species: tree, fit: [1, 1, 1], tint: 0 } : m.index === 4 ? { species: plant, fit: [1, 1, 1], tint: 0 } : null),
        materials: null,
        tints: null,
      },
    },
  }
  const host = { scene, world } as unknown as TreesHost
  const part = new TreesNearField(host, {
    load: async () => null,
    kindOf: async m => (m.sidecar === 'plant' ? 'plant' : 'tree'),
  })
  cleanups.push(() => {
    part.dispose()
    scene.dispose()
    engine.dispose()
  })
  let uid = 0
  return {
    host, part, listeners, band, world, townPlayers,
    place(owner, xs, opts = {}) {
      const ps = xs.map((x, i) => ({ position: [x, 0, 0], rotation: [0, 0, 0, 1], region: 0x6464, uid: opts.uid0 !== undefined ? opts.uid0 + i : uid++ }) as unknown as WorldPlacement)
      const m = opts.plant ? retailPlant : retailTree
      for (const l of listeners) l.placed(owner, m, { index: m.index, source: m.source, heightM: 2, isFoliage: true, kind: 'static' }, [], ps)
      return ps
    },
    cam: (x, z = 0) => ({ globalPosition: new Vector3(x, 1, z) }) as unknown as Camera,
  }
}

/** Lets the kind loads resolve. */
const tick = () => new Promise(r => setTimeout(r, 0))

describe('the trees part\'s bands on a world (fake objects and batch)', () => {
  it('hands out slots for swapped placements only (claimed: no meshes), sets the band texture first, frees with the region', async () => {
    const f = fakeWorld()
    expect(f.band.tex).toBeNull()
    expect(f.part.bandTexture).toBeNull()
    // a chunk placement (meshes) and a retail model without a swap get nothing
    for (const l of f.listeners) l.placed(5, { index: 9, source: 'x' } as WorldModel, { index: 9, source: 'x', heightM: 1, isFoliage: false, kind: 'static' }, [], [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], region: 1, uid: 1 } as unknown as WorldPlacement])
    expect(f.part.slots.used).toBe(0)
    expect(f.band.tex).toBeNull()
    const ps = f.place(5, [0, 50, 200])
    expect(f.part.slots.used).toBe(3)
    expect(f.band.tex).not.toBeNull()
    expect(f.band.tex).toBe(f.part.bandTexture)
    const tex = f.part.bandTexture!
    expect(tex.getSize()).toEqual({ width: TREE_BAND_TEX_W, height: TREE_BAND_TEX_H })
    expect(tex.textureFormat).toBe(Constants.TEXTUREFORMAT_R)
    expect(f.part.slotOf(placementKey(ps[0]!.region, ps[0]!.uid))).toBe(0)
    expect(f.part.slotOf(placementKey(ps[2]!.region, ps[2]!.uid))).toBe(2)
    // before any camera: mid (the merged LOD1 shows)
    expect([...f.part.bands.bytes.subarray(0, 4)]).toEqual([BAND_MID, BAND_MID, BAND_MID, BAND_HIDDEN])
    await tick()
    f.part.update(f.cam(0), 0.016)
    // the tree species' overlay is not ready (no near.glb here): never near
    expect([...f.part.bands.bytes.subarray(0, 3)]).toEqual([BAND_MID, BAND_MID, BAND_FAR])
    for (const l of f.listeners) l.removed(5)
    expect(f.part.slots.used).toBe(0)
    expect([...f.part.bands.bytes.subarray(0, 3)]).toEqual([BAND_HIDDEN, BAND_HIDDEN, BAND_HIDDEN])
    f.part.dispose()
    expect(f.band.tex).toBeNull()
    expect(tex.getInternalTexture()).toBeNull()
  })

  it('plants: P-LOD0 within 25 m, P-LOD1 beyond, refilled every 4 m and once per range-scale change; one upload per change', async () => {
    const f = fakeWorld()
    f.place(5, [0, 20, 30, 60], { plant: true })
    await tick()
    f.part.update(f.cam(0), 0.016)
    expect([...f.part.bands.bytes.subarray(0, 4)]).toEqual([BAND_MID, BAND_MID, BAND_FAR, BAND_FAR])
    const uploads = f.part.stats().bandUploads!
    const refills = f.part.stats().refills!
    // under 4 m: no refill
    f.part.update(f.cam(REFILL_STEP_M - 0.1), 0.016)
    expect(f.part.stats().refills).toBe(refills)
    // 4 m: a refill; 20 m (+ 2 m radius) is still within 25 m + 3 m of hysteresis for the second plant
    f.part.update(f.cam(-REFILL_STEP_M), 0.016)
    expect(f.part.stats().refills).toBe(refills + 1)
    expect([...f.part.bands.bytes.subarray(0, 4)]).toEqual([BAND_MID, BAND_MID, BAND_FAR, BAND_FAR])
    expect(f.part.stats().bandUploads).toBe(uploads)
    // the range scale halves: 12.5 m
    f.world.objects.drawRangeScale = 0.5
    f.part.update(f.cam(-REFILL_STEP_M), 0.016)
    expect(f.part.stats().refills).toBe(refills + 2)
    expect([...f.part.bands.bytes.subarray(0, 4)]).toEqual([BAND_MID, BAND_FAR, BAND_FAR, BAND_FAR])
    expect(f.part.stats().bandUploads).toBe(uploads + 1)
  })

  it('band 3: the editor\'s hide and preview hide a placement at once and give it back', async () => {
    const f = fakeWorld()
    const [p] = f.place(5, [60])
    const key = placementKey(p!.region, p!.uid)
    await tick()
    f.part.update(f.cam(0), 0.016)
    expect(f.part.bands.bytes[0]).toBe(BAND_MID)
    f.part.setHidden(key, true)
    f.part.update(f.cam(0), 0.016)
    expect(f.part.bands.bytes[0]).toBe(BAND_HIDDEN)
    expect(f.part.stats()).toMatchObject({ hidden: 1, band3: 1 })
    f.part.setHidden(key, false)
    f.part.update(f.cam(0), 0.016)
    expect(f.part.bands.bytes[0]).toBe(BAND_MID)
    f.part.preview(key, 'sp1', null)
    f.part.update(f.cam(0), 0.016)
    expect(f.part.bands.bytes[0]).toBe(BAND_HIDDEN)
    expect(f.part.stats().previews).toBe(1)
    f.part.preview(key, null)
    f.part.update(f.cam(0), 0.016)
    expect(f.part.bands.bytes[0]).toBe(BAND_MID)
    // a key hidden before its placement arrives starts hidden
    f.part.setHidden(placementKey(0x6464, 77), true)
    f.place(6, [10], { uid0: 77 })
    expect(f.part.bands.bytes[f.part.slotOf(placementKey(0x6464, 77))!]).toBe(BAND_HIDDEN)
  })
})

describe('the crowded-plaza rule (D24): Medium, ≥ 15 players in range → the overlay within 20 m', () => {
  it('14 players: off; 15: on; the app\'s count wins over the town part\'s; never on another preset', () => {
    const f = fakeWorld('medium')
    f.townPlayers.n = CROWD_PLAYERS
    // nothing swapped yet: the town's count is not even read
    f.part.update(f.cam(0), 1)
    expect(f.part.stats().players).toBe(0)
    f.place(5, [60])
    f.townPlayers.n = CROWD_PLAYERS - 1
    f.part.update(f.cam(0), 1)
    expect(f.part.crowded).toBe(false)
    expect(f.part.stats()).toMatchObject({ crowded: 0, players: 14 })
    f.townPlayers.n = CROWD_PLAYERS
    f.part.update(f.cam(0), 1)
    expect(f.part.crowded).toBe(true)
    expect(f.part.stats()).toMatchObject({ crowded: 1, players: 15 })
    // the app's count (World.trees.setPlayers) takes over from the poll; the switch holds until 3 below the line
    // (H-12 CR-1: a count on the 14/15 line never flickers the rule)
    f.part.setPlayers(14)
    f.part.update(f.cam(0), 1)
    expect(f.part.crowded).toBe(true)
    f.part.setPlayers(12)
    f.part.update(f.cam(0), 1)
    expect(f.part.crowded).toBe(false)
    f.part.setPlayers(14)
    expect(f.part.crowded).toBe(false)
    f.part.setPlayers(40)
    expect(f.part.crowded).toBe(true)
    const h = fakeWorld('high')
    h.place(5, [60])
    h.townPlayers.n = 40
    h.part.update(h.cam(0), 1)
    expect(h.part.crowded).toBe(false)
    h.part.setPlayers(40)
    expect(h.part.crowded).toBe(false)
  })

  it('the rule\'s flip refills the bands without the camera moving', () => {
    const f = fakeWorld('medium')
    f.place(5, [60])
    f.part.update(f.cam(0), 1)
    const refills = f.part.stats().refills!
    f.part.update(f.cam(0), 0.1)
    expect(f.part.stats().refills).toBe(refills)
    f.part.setPlayers(CROWD_PLAYERS)
    f.part.update(f.cam(0), 0.1)
    expect(f.part.stats().refills).toBe(refills + 1)
  })
})

describe('the refill budget (WAVE_PLAN8 §5.3: ≤ 0.1 ms at 1,600 resident placements)', () => {
  it('1,600 swapped placements: a refill costs well under a millisecond (median of 201, warmed)', async () => {
    const f = fakeWorld('medium')
    const xs = Array.from({ length: 1600 }, (_, i) => (i % 40) * 9 - 180)
    f.place(5, xs.slice(0, 800))
    f.place(6, xs.slice(800), { plant: true })
    await tick()
    const times: number[] = []
    // warmed (the JIT), then 201 timed refills, every one moving the camera 4 m
    for (let i = 0; i < 301; i++) {
      const t0 = performance.now()
      f.part.update(f.cam(i % 2 ? REFILL_STEP_M : 0, i * 0.37), 0.016)
      if (i >= 100) times.push(performance.now() - t0)
    }
    times.sort((a, b) => a - b)
    const median = times[100]!
    expect(f.part.stats().refills).toBeGreaterThanOrEqual(301)
    console.log(`[tree-bands] refill at 1,600 placements: median ${median.toFixed(3)} ms, p95 ${times[190]!.toFixed(3)} ms`)
    // the browser budget is 0.1 ms; the test only guards against an accidental O(n²) (a loaded CI machine)
    expect(median).toBeLessThan(1)
  })
})
