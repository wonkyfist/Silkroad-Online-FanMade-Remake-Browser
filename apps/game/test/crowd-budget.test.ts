/**
 * G1 rescue: the crowd budget (world/crowd-budget.ts) and its two mechanisms, the actors' crowd LOD (three/models.ts
 * setCrowdLod) and the renderer's per-character cascade count (world-render WorldShadows.setCharacterCascades).
 * - the own character, party members and the current target always keep full quality (every cascade, no blob, no
 *   rate floor), however many characters are near and however far they are;
 * - the casters are capped at the preset's count (the nearest other characters), the rest cast nothing and get a blob
 *   on Medium, or cast into the first cascade on High and Ultra; a caster keeps its place within HYSTERESIS_M;
 * - the pose-rate floors follow the camera distance and only start with ANIM_FROM others near; within CLOSE_M nothing
 *   changes (no pop at close range); off screen, a character that casts nothing slows down, and freezes beyond NEAR_M;
 * - nothing at all without shadows and the animation LOD (the Low guard).
 */
import { MeshBuilder, NullEngine, Scene, TransformNode, Vector3, type AbstractMesh } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { RENDER_PRESETS } from '@sro/world-render'
import {
  ANIM_FROM,
  ANIM_TIERS,
  CLOSE_M,
  CROWD_SHADOWS,
  CrowdBudget,
  HYSTERESIS_M,
  MERGES_PER_PLAN,
  NEAR_M,
  crowdAnimMs,
  crowdShadowRule,
  planCrowd,
  type CrowdBlobs,
  type CrowdEntry,
  type CrowdView,
} from '../src/world/crowd-budget.ts'
import type { CharacterActor, CrowdOffscreen } from '../src/three/models.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const others = (ds: readonly number[]): CrowdEntry[] => ds.map(d => ({ d, keep: false, wasCasting: false }))

describe('planCrowd (pure)', () => {
  const medium = CROWD_SHADOWS.medium
  const high = CROWD_SHADOWS.high

  it('the preset rule comes from the shadow block: Medium caps and blobs, High and Ultra the first cascade, none without shadows', () => {
    expect(crowdShadowRule(RENDER_PRESETS.medium.shadows)).toBe(CROWD_SHADOWS.medium)
    expect(crowdShadowRule(RENDER_PRESETS.high.shadows)).toBe(CROWD_SHADOWS.high)
    expect(crowdShadowRule(RENDER_PRESETS.ultra.shadows)).toBe(CROWD_SHADOWS.high)
    expect(crowdShadowRule(RENDER_PRESETS.low.shadows)).toBeNull()
    expect(medium).toEqual({ casters: medium.casters, restCascades: 0, blobs: true })
    expect(high.restCascades).toBe(1)
    expect(high.blobs).toBe(false)
    expect(medium.casters).toBeGreaterThanOrEqual(4)
    expect(high.casters).toBeGreaterThanOrEqual(medium.casters)
  })

  it('caps the casters at the nearest N others; the rest cast nothing and get a blob (Medium)', () => {
    const ds = Array.from({ length: 20 }, (_, i) => 4 + i * 2) // 4 .. 42 m
    const out = planCrowd(others(ds), medium, true)
    const casting = out.filter(o => o.cascades === Infinity).length
    expect(casting).toBe(medium.casters)
    for (let i = 0; i < ds.length; i++) {
      if (i < medium.casters) expect(out[i]).toMatchObject({ cascades: Infinity, blob: false })
      else expect(out[i]).toMatchObject({ cascades: 0, blob: true })
    }
    // High: the rest cast into the first cascade, no blob.
    const hi = planCrowd(others(ds), high, true)
    expect(hi.filter(o => o.cascades === Infinity)).toHaveLength(high.casters)
    for (const o of hi.filter(x => x.cascades !== Infinity)) expect(o).toMatchObject({ cascades: 1, blob: false })
    // A few others: nobody changes.
    const few = planCrowd(others([3, 8, 20]), medium, true)
    for (const o of few) expect(o).toMatchObject({ cascades: Infinity, blob: false, animMs: 0 })
  })

  it('the own character, party members and the target keep full quality, near or far, in any crowd', () => {
    const entries: CrowdEntry[] = [
      { d: 60, keep: true, wasCasting: false }, // the target, far away
      { d: 45, keep: true, wasCasting: false }, // a party member
      ...others(Array.from({ length: 30 }, (_, i) => 2 + i)),
      { d: 1, keep: true, wasCasting: true }, // the own character
    ]
    for (const rule of [medium, high]) {
      const out = planCrowd(entries, rule, true)
      for (const i of [0, 1, entries.length - 1]) expect(out[i]).toEqual({ cascades: Infinity, blob: false, animMs: 0, offscreen: 'normal', merge: false })
      // The keep ones do not take places: still N others cast.
      expect(out.filter((o, i) => !entries[i]!.keep && o.cascades === Infinity)).toHaveLength(rule.casters)
    }
  })

  it('a caster keeps its place until another is HYSTERESIS_M nearer (no flicker at the rank boundary)', () => {
    const n = medium.casters
    // n − 1 near ones, then A (casting, 20 m) and B (not casting, 20 − (HYSTERESIS_M − 0.5) m): A keeps it.
    const near = others(Array.from({ length: n - 1 }, (_, i) => 5 + i * 0.1))
    const a: CrowdEntry = { d: 20, keep: false, wasCasting: true }
    const b: CrowdEntry = { d: 20 - (HYSTERESIS_M - 0.5), keep: false, wasCasting: false }
    let out = planCrowd([...near, a, b], medium, false)
    expect(out[n - 1]!.cascades).toBe(Infinity)
    expect(out[n]!.cascades).toBe(0)
    // B now more than HYSTERESIS_M nearer: they trade.
    b.d = 20 - (HYSTERESIS_M + 0.5)
    out = planCrowd([...near, a, b], medium, false)
    expect(out[n - 1]!.cascades).toBe(0)
    expect(out[n]!.cascades).toBe(Infinity)
  })

  it('pose-rate floors by distance, only with ANIM_FROM others near, never within CLOSE_M', () => {
    expect(crowdAnimMs(0)).toBe(0)
    expect(crowdAnimMs(CLOSE_M)).toBe(0)
    expect(crowdAnimMs(CLOSE_M + 0.1)).toBeCloseTo(1000 / ANIM_TIERS[0]![1], 9)
    expect(crowdAnimMs(30)).toBeCloseTo(1000 / 15, 9)
    expect(crowdAnimMs(500)).toBeCloseTo(1000 / 10, 9)
    // Slower with distance.
    let prev = 0
    for (const d of [16, 26, 41, 90]) {
      expect(crowdAnimMs(d)).toBeGreaterThanOrEqual(prev)
      prev = crowdAnimMs(d)
    }
    // ANIM_FROM − 1 others near: no floor anywhere; ANIM_FROM: floors beyond CLOSE_M only.
    const few = planCrowd(others([...Array.from({ length: ANIM_FROM - 2 }, () => 10), 30]), null, true)
    expect(few.every(o => o.animMs === 0)).toBe(true)
    const ds = [...Array.from({ length: ANIM_FROM - 1 }, () => 8), 14.9, 20, 35, 48]
    const many = planCrowd(others(ds), null, true)
    ds.forEach((d, i) => expect(many[i]!.animMs).toBe(d <= CLOSE_M ? 0 : crowdAnimMs(d)))
    // The animation LOD off (Low): no floors.
    expect(planCrowd(others(ds), null, false).every(o => o.animMs === 0 && o.offscreen === 'normal')).toBe(true)
  })

  it('off screen: no shadow cast slows down (within NEAR_M) or freezes (beyond); a caster freezes only beyond NEAR_M', () => {
    const ds = [...Array.from({ length: 20 }, (_, i) => 3 + i), NEAR_M + 5]
    const out = planCrowd(others(ds), medium, true)
    ds.forEach((d, i) => {
      const o = out[i]!
      const want: CrowdOffscreen = d > NEAR_M ? 'freeze' : o.cascades === 0 ? 'slow' : 'normal'
      expect(o.offscreen).toBe(want)
    })
    expect(out.some(o => o.offscreen === 'slow')).toBe(true)
  })

  it('no shadow rule and no animation LOD: everyone as without the budget (the Low guard)', () => {
    const out = planCrowd(others(Array.from({ length: 40 }, (_, i) => 2 + i)), crowdShadowRule(RENDER_PRESETS.low.shadows), false)
    for (const o of out) expect(o).toEqual({ cascades: Infinity, blob: false, animMs: 0, offscreen: 'normal', merge: false })
  })
})

describe('CrowdBudget (runtime, NullEngine)', () => {
  function setup(shadows: typeof RENDER_PRESETS.medium.shadows = RENDER_PRESETS.medium.shadows) {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    cleanups.push(() => {
      scene.dispose()
      engine.dispose()
    })
    const told = new Map<AbstractMesh, number>()
    const lods = new Map<CharacterActor, { ms: number; off: CrowdOffscreen }>()
    const merges: Array<[string, boolean]> = []
    const blobs: Array<[number, number, number, number]> = []
    let blobSets = 0
    const set: CrowdBlobs = {
      begin: () => {
        blobs.length = 0
      },
      add: (x, y, z, r) => {
        blobs.push([x, y, z, r])
      },
      end: () => {},
      dispose: () => {},
    }
    let clock = 0
    let target: CrowdView | null = null
    const eye = new Vector3(0, 0, 0)
    const budget = new CrowdBudget({
      renderer: { setCharacterCascades: (m, k) => (k === Infinity ? told.delete(m) : told.set(m, k)) },
      eye: () => eye,
      target: () => target,
      shadows: () => shadows,
      anim: () => true,
      blobs: () => {
        blobSets++
        return set
      },
      now: () => clock,
    })
    cleanups.push(() => budget.dispose())
    const view = (name: string, z: number, extra: Partial<CrowdView> = {}) => {
      const root = new TransformNode(name, scene)
      root.position.set(0, 0, z)
      const mesh = MeshBuilder.CreateBox(`${name}_mesh`, { size: 1 }, scene)
      mesh.parent = root
      const fake = {
        isDisposed: false,
        mergedParts: false,
        mergeVersion: 0,
        setCrowdLod: (ms: number, off: CrowdOffscreen) => lods.set(actor, { ms, off }),
        setMergeParts: (on: boolean) => {
          const built = on && !fake.mergedParts
          if (on !== fake.mergedParts) fake.mergeVersion++
          fake.mergedParts = on
          merges.push([name, on])
          return built
        },
      }
      const actor = fake as unknown as CharacterActor
      const v: CrowdView = { isSelf: false, isDisposed: false, kind: 'player', root, actor, ...extra }
      budget.track(v, [mesh], () => 1.8)
      return { v, mesh, actor }
    }
    const step = (ms = 300) => {
      clock += ms
      budget.update()
    }
    return { budget, told, lods, merges, blobs, view, step, setTarget: (v: CrowdView | null) => (target = v), blobSets: () => blobSets }
  }

  it('20 others: the casters capped, the rest told 0 cascades with a blob; own, party and target full', () => {
    const { budget, told, lods, blobs, view, step, setTarget } = setup()
    const own = view('own', 1, { isSelf: true })
    const mate = view('mate', 40, { partyMate: true })
    const crowd = Array.from({ length: 20 }, (_, i) => view(`p${i}`, 3 + i * 2))
    const tgt = crowd[19]!
    setTarget(tgt.v)
    step()
    for (const k of [own, mate, tgt]) {
      expect(told.has(k.mesh)).toBe(false)
      expect(lods.get(k.actor) ?? { ms: 0, off: 'normal' }).toEqual({ ms: 0, off: 'normal' })
      expect(budget.decisionOf(k.v)).toEqual({ cascades: Infinity, blob: false, animMs: 0, offscreen: 'normal', merge: false })
    }
    const full = crowd.filter(c => !told.has(c.mesh))
    expect(full).toHaveLength(CROWD_SHADOWS.medium.casters + 1) // the nearest N and the target
    expect(full.slice(0, CROWD_SHADOWS.medium.casters).map(c => c.v)).toEqual(crowd.slice(0, CROWD_SHADOWS.medium.casters).map(c => c.v))
    const none = crowd.filter(c => told.get(c.mesh) === 0)
    expect(none).toHaveLength(20 - CROWD_SHADOWS.medium.casters - 1)
    // The blobs grow in over 0.3 s under the ones that cast nothing (nothing else gets one).
    step(100)
    step(300)
    expect(blobs).toHaveLength(none.length)
    expect(budget.stats()).toMatchObject({ none: none.length, blobs: none.length })
    // Within CLOSE_M no rate floor; beyond, the tier's.
    for (const c of crowd) {
      if (c === tgt) continue
      const d = c.v.root.getAbsolutePosition().z
      expect(lods.get(c.actor)?.ms ?? 0).toBe(crowdAnimMs(d))
    }
    // Untracked: back to every cascade.
    budget.untrack(none[0]!.v)
    expect(told.has(none[0]!.mesh)).toBe(false)
  })

  it('the target changes: the new one is full at the next plan, the old one budgeted again', () => {
    const { told, view, step, setTarget } = setup()
    const crowd = Array.from({ length: 16 }, (_, i) => view(`p${i}`, 3 + i * 2))
    step()
    const far = crowd[15]!
    expect(told.get(far.mesh)).toBe(0)
    setTarget(far.v)
    step()
    expect(told.has(far.mesh)).toBe(false)
    setTarget(null)
    step()
    expect(told.get(far.mesh)).toBe(0)
  })

  it('High: the rest cast into the first cascade, no blob set is ever made', () => {
    const { told, view, step, blobSets } = setup(RENDER_PRESETS.high.shadows)
    const crowd = Array.from({ length: 20 }, (_, i) => view(`p${i}`, 3 + i * 2))
    step()
    step()
    expect(crowd.filter(c => told.get(c.mesh) === 1)).toHaveLength(20 - CROWD_SHADOWS.high.casters)
    expect(blobSets()).toBe(0)
  })

  it('merges the parts of other characters at most MERGES_PER_PLAN per plan, never the own, party or target, and re-reads the roots', () => {
    const { budget, merges, view, step, setTarget } = setup()
    const own = view('own', 1, { isSelf: true })
    const crowd = Array.from({ length: 12 }, (_, i) => view(`p${i}`, 3 + i * 2))
    setTarget(crowd[0]!.v)
    let rescans = 0
    budget.track(crowd[1]!.v, [crowd[1]!.mesh], () => 1.8, () => rescans++)
    step()
    expect(merges.filter(([, on]) => on)).toHaveLength(MERGES_PER_PLAN)
    for (let k = 0; k < 6; k++) step()
    const merged = new Set(merges.filter(([, on]) => on).map(([n]) => n))
    expect(merged.size).toBe(11) // every other but the target
    expect(merged.has('own')).toBe(false)
    expect(merged.has('p0')).toBe(false)
    expect(rescans).toBe(1)
    // The target changes: the old one merges, the new one is back to its parts at once.
    setTarget(crowd[5]!.v)
    step()
    expect(merges.at(-1)).toEqual(['p5', false])
    expect((own.actor as unknown as { mergedParts: boolean }).mergedParts).toBe(false)
    // The crowd thins out below half of ANIM_FROM: back to the parts (the hysteresis keeps them merged above it).
    for (const c of crowd.slice(2)) budget.untrack(c.v)
    step()
    expect((crowd[1]!.actor as unknown as { mergedParts: boolean }).mergedParts).toBe(false)
  })

  it('a view that goes while merged leaves the budget for good (no re-read hands it back)', () => {
    const { budget, view, step } = setup()
    const crowd = Array.from({ length: 12 }, (_, i) => view(`p${i}`, 3 + i * 2))
    const gone = crowd[3]!
    let rescans = 0
    // The graphics link re-tracks the view when asked to re-read its roots (world/graphics.ts refresh(true)).
    budget.track(gone.v, [gone.mesh], () => 1.8, () => {
      rescans++
      budget.track(gone.v, [gone.mesh], () => 1.8)
    })
    for (let k = 0; k < 6; k++) step()
    expect((gone.actor as unknown as { mergedParts: boolean }).mergedParts).toBe(true)
    const before = rescans
    budget.untrack(gone.v)
    expect((gone.actor as unknown as { mergedParts: boolean }).mergedParts).toBe(false)
    expect(rescans).toBe(before)
    expect(budget.decisionOf(gone.v)).toBeNull()
    expect(budget.size).toBe(11)
  })

  it('off (the LAB A/B) and no shadows: every root back to every cascade, no floors', () => {
    const { budget, told, lods, view, step } = setup()
    const crowd = Array.from({ length: 20 }, (_, i) => view(`p${i}`, 3 + i * 2))
    step()
    expect(told.size).toBeGreaterThan(0)
    budget.enabled = false
    step()
    expect(told.size).toBe(0)
    for (const c of crowd) expect(lods.get(c.actor)).toEqual({ ms: 0, off: 'normal' })
  })
})

describe('AmbientBudget (G1 rescue: the always-on model glows on the nearest models)', () => {
  it('gives the slots to the nearest models, keeps a slot within AMBIENT_HYSTERESIS_M, follows the preset cap', async () => {
    const { AmbientBudget, AMBIENT_HYSTERESIS_M, AMBIENT_RANK_MS } = await import('../src/world/features/fx-world.ts')
    const { FX_BUDGETS } = await import('../src/world/fx/quality.ts')
    expect(FX_BUDGETS.low.ambientModels).toBe(0)
    expect(FX_BUDGETS.medium.ambientModels).toBeLessThan(FX_BUDGETS.high.ambientModels)
    let clock = 0
    const eye = { x: 0, y: 0, z: 0 }
    const budget = new AmbientBudget(() => eye, () => clock)
    budget.capOverride = 3
    const slot = (z: number) => {
      const s = { z, slotted: false, position: () => ({ x: 0, y: 0, z: s.z }), setSlot: (on: boolean) => (s.slotted = on) }
      return s
    }
    const models = [50, 40, 30, 20, 10, 60].map(slot)
    for (const m of models) budget.join(m)
    expect(models.filter(m => m.slotted).map(m => m.z).sort((a, b) => a - b)).toEqual([10, 20, 30])
    expect(budget.playing).toBe(3)
    // The 40 m one comes to 28 m: within the hysteresis of the 30 m one, nothing changes; to 25 m, they trade.
    models[1]!.z = 30 - AMBIENT_HYSTERESIS_M + 1
    clock += AMBIENT_RANK_MS
    budget.check()
    expect(models[1]!.slotted).toBe(false)
    models[1]!.z = 30 - AMBIENT_HYSTERESIS_M - 1
    clock += AMBIENT_RANK_MS
    budget.check()
    expect(models[1]!.slotted).toBe(true)
    expect(models[2]!.slotted).toBe(false)
    // Not re-ranked before AMBIENT_RANK_MS; a lower cap applies at once.
    models[5]!.z = 1
    budget.check()
    expect(models[5]!.slotted).toBe(false)
    budget.capOverride = 1
    budget.check()
    expect(models.filter(m => m.slotted).map(m => m.z)).toEqual([1])
    budget.leave(models[5]!)
    expect(budget.playing).toBe(1)
  })
})
