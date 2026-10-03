/**
 * TL-C, the town's crowd runtime (docs/TOWN_LIFE.md §2.2, §3, §4, §8; docs/WAVE_PLAN7.md §6.1 TL-C, §5.3):
 *
 * - draws = the variants with someone in range (one draw each); a variant with no instance is `isVisible = false`;
 * - no allocation per frame after the warm-up (the crowd's update, buffers included);
 * - the caps per preset and per player count (TOWN_LIFE §8.1, F2), kept by rank (the same people on every client);
 * - nothing on Classic (World.town is null), and a PBR → Classic → PBR switch leaves no town mesh or VAT texture;
 * - the time base (F5): `manager.time` stays < 3,600 s with a 2026 epoch clock, and the frame the GPU draws (Babylon's
 *   VAT formula, replicated) is the schedule's clip phase, across re-bases;
 * - a click on a walker picks it (the app's pick never consumes the click: apps/game test town-feature) and the meshes
 *   are not pickable, so the ground ray passes through them;
 * - the pigeons never land within 6 m of a route edge or a dwell spot;
 * - the alarm sends the walkers to the doors (the stand-in schedule; TL-R's schedule has its own test);
 * - the fade plugin: GLSL and WGSL carry the same discard, no uniform, no sampler; the crowd's material compiles.
 */
import { ArcRotateCamera, NullEngine, PBRMaterial, Ray, Scene, ShaderLanguage, Vector3, type Mesh } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { TownFile } from '../../shared/src/town.ts'
import type { World } from '../src/world.ts'
import { AnimalSchedule, LANDING_CLEAR_ROUTE_M, nearRoute, plazaHabitat, segmentDist2 } from '../src/town/animals.ts'
import { BUBBLE_S, CALL_SLOT_S, DEFAULT_LINES, clickText, nearestBubbles, newBubble, vendorCallAt } from '../src/town/bubbles.ts'
import {
  REBASE_MAX_S,
  REBASE_MIN_S,
  SRO_TOWN_FADE_PLUGIN,
  TOWN_PRESETS,
  TownCrowd,
  animalCap,
  folkCap,
  newPose,
  stubCrowdAssets,
  townFadeFragmentCode,
  vatDrawnFrame,
  vatOffsetFor,
  type CrowdAgent,
  type CrowdAssets,
  type CrowdPose,
  type CrowdQuery,
  type CrowdSchedule,
} from '../src/town/crowd.ts'
import { PLAZA, PLAZA_DOORS, PlazaStandIn, TownLife, plazaStandIn, schedulePlan, townPartWith, type TownPlan } from '../src/town/index.ts'
import { isTownMesh } from '../src/town/types.ts'
import { w10World } from './w10-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function rig(): { engine: NullEngine; scene: Scene; camera: ArcRotateCamera } {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  const camera = new ArcRotateCamera('cam', 0, 1, 20, Vector3.Zero(), scene)
  cleanups.push(() => {
    scene.dispose()
    engine.dispose()
  })
  return { engine, scene, camera }
}

const EPOCH_2026 = 1_790_000_000

/**
 * A test schedule: agent i stands (STAND1, phase i) or walks (WALK, a ring) at distance `dist(i)` from the origin.
 */
class RingSchedule implements CrowdSchedule {
  readonly agents: CrowdAgent[]
  /** Per agent (typed: a closure returning a double would box it per call, which the allocation test would see). */
  private readonly dist: Float64Array
  private readonly walks: Uint8Array
  constructor(n: number, dist: (i: number) => number, walking: (i: number) => boolean = () => false) {
    this.agents = Array.from({ length: n }, (_, i) => ({ id: i + 1, role: 'walker', female: i % 2 === 1, rank: (i + 0.5) / n }))
    this.dist = Float64Array.from({ length: n }, (_, i) => dist(i))
    this.walks = Uint8Array.from({ length: n }, (_, i) => (walking(i) ? 1 : 0))
  }

  pose(i: number, q: Readonly<CrowdQuery>, out: CrowdPose): boolean {
    const r = this.dist[i]!
    const a = (i * 2.399) % (Math.PI * 2)
    out.y = 0
    out.alpha = 1
    out.rate = 1
    if (this.walks[i]) {
      const s = q.nowS * 1.4
      const th = a + s / Math.max(1, r)
      out.x = Math.cos(th) * r
      out.z = Math.sin(th) * r
      out.yaw = Math.atan2(-Math.sin(th), Math.cos(th))
      out.clip = 'WALK'
      out.clipT = q.nowS
      out.distM = s + i
      out.speed = 1.4
      return true
    }
    out.x = Math.cos(a) * r
    out.z = Math.sin(a) * r
    out.yaw = a
    out.clip = 'STAND1'
    out.clipT = q.nowS + i * 0.37
    out.distM = Number.NaN
    out.speed = 0
    return true
  }
}

const query = (nowS: number, extra: Partial<CrowdQuery> = {}): CrowdQuery => ({ nowS, solarT: 0.5, alarmFromS: 0, alarmUntilS: 0, rain: 0, ...extra })

/** Runs `frames` crowd frames of `dt` from nowS; returns the last T. */
function run(crowd: TownCrowd, assets: CrowdAssets, nowS: number, frames: number, dt = 0.1, fx = 0, fz = 0): number {
  const threats = new Float32Array(2)
  let T = 0
  for (let k = 0; k < frames; k++) {
    const t = nowS + k * dt
    T = REBASE_MIN_S + (t - nowS)
    for (const v of assets.vats) v.manager.time = T
    crowd.update(query(t), T, fx, fz, dt, threats, 0)
  }
  return T
}

function drawnMeshes(crowd: TownCrowd): Mesh[] {
  return crowd.meshes().filter(m => m.isVisible && m.thinInstanceCount > 0)
}

describe('caps per preset and per player count (TOWN_LIFE §8.1, §8.2)', () => {
  it('max(15, cap − 3 × (players − 5)) × the Town life scale; animals halve beyond 10 players', () => {
    expect(folkCap(TOWN_PRESETS.low, 0)).toBe(0)
    // Medium gives the crowd up from 15 players in range (WAVE_PLAN7 cut 20, applied by I-11 after LAB-11)
    expect([0, 5, 6, 14, 15, 20, 40].map(p => folkCap(TOWN_PRESETS.medium, p))).toEqual([60, 60, 57, 33, 0, 0, 0])
    expect(TOWN_PRESETS.medium.noFolkFrom).toBe(15)
    const floorOnly = { ...TOWN_PRESETS.medium, noFolkFrom: undefined }
    expect([15, 20, 40].map(p => folkCap(floorOnly, p))).toEqual([30, 15, 15])
    expect(folkCap(TOWN_PRESETS.high, 20)).toBe(55)
    expect(folkCap(TOWN_PRESETS.ultra, 0)).toBe(140)
    expect(folkCap(TOWN_PRESETS.medium, 0, 0.5)).toBe(30)
    expect(folkCap(TOWN_PRESETS.medium, 0, 0)).toBe(0)
    expect(TOWN_PRESETS.medium.rangeM).toBe(60)
    expect(TOWN_PRESETS.high.rangeM).toBe(90)
    expect(TOWN_PRESETS.ultra.rangeM).toBe(120)
    expect([10, 11].map(p => animalCap(TOWN_PRESETS.medium, p))).toEqual([12, 6])
    expect(animalCap(TOWN_PRESETS.high, 0, 0.5)).toBe(8)
  })

  it('the crowd keeps the lowest ranks when the cap shrinks (20 players: 15 folk), fading the others out', () => {
    const { scene } = rig()
    const assets = stubCrowdAssets(scene)
    cleanups.push(() => assets.dispose())
    const sched = new RingSchedule(120, i => 5 + (i % 40))
    const crowd = new TownCrowd(assets, sched, { kinds: ['folk'], variants: 10 })
    crowd.configure(folkCap(TOWN_PRESETS.medium, 0), 60)
    run(crowd, assets, EPOCH_2026, 12)
    expect(crowd.frame.drawn).toBe(60)
    crowd.configure(folkCap({ ...TOWN_PRESETS.medium, noFolkFrom: undefined }, 20), 60)
    run(crowd, assets, EPOCH_2026 + 2, 2)
    // fading out (0.6 s): still drawn a moment, then gone
    expect(crowd.frame.drawn).toBeGreaterThan(15)
    run(crowd, assets, EPOCH_2026 + 3, 10)
    expect(crowd.frame.drawn).toBe(15)
    const ranks = sched.agents.map((a, i) => [a.rank, i] as const).sort((a, b) => a[0] - b[0]).slice(0, 15).map(([, i]) => i)
    for (const i of ranks) expect(crowd.isDrawn(i)).toBe(true)
  })
})

describe('draws, visibility and allocation (WAVE_PLAN7 §5.3 TL-C)', () => {
  it('draws = the variants with someone in range; a variant with nobody is isVisible false; nobody in range: no draw', () => {
    const { scene } = rig()
    const assets = stubCrowdAssets(scene)
    cleanups.push(() => assets.dispose())
    const crowd = new TownCrowd(assets, new RingSchedule(40, () => 20), { kinds: ['folk', 'guard', 'elder'], variants: 10 })
    for (const m of crowd.meshes()) {
      expect(isTownMesh(m)).toBe(true)
      expect(m.isPickable).toBe(false)
      expect(m.isVisible).toBe(false)
    }
    crowd.configure(60, 60)
    run(crowd, assets, EPOCH_2026, 10)
    expect(crowd.frame.drawn).toBe(40)
    const vis = drawnMeshes(crowd)
    expect(crowd.frame.draws).toBe(vis.length)
    expect(vis.length).toBeGreaterThan(1)
    expect(vis.length).toBeLessThanOrEqual(10)
    for (const m of crowd.meshes()) expect(m.isVisible).toBe(m.thinInstanceCount > 0)
    // everyone beyond the range: fade out, then no draw at all
    crowd.configure(60, 10)
    run(crowd, assets, EPOCH_2026 + 1, 10)
    expect(crowd.frame.drawn).toBe(0)
    expect(crowd.frame.draws).toBe(0)
    for (const m of crowd.meshes()) {
      expect(m.thinInstanceCount).toBe(0)
      expect(m.isVisible).toBe(false)
    }
  })

  it('one draw per variant: the drawn instances of a variant share its one mesh (thin instances)', () => {
    const { scene } = rig()
    const assets = stubCrowdAssets(scene)
    cleanups.push(() => assets.dispose())
    const crowd = new TownCrowd(assets, new RingSchedule(60, () => 15), { kinds: ['folk'], variants: 10 })
    crowd.configure(60, 60)
    run(crowd, assets, EPOCH_2026, 10)
    const total = drawnMeshes(crowd).reduce((n, m) => n + m.thinInstanceCount, 0)
    expect(total).toBe(60)
    for (const m of crowd.meshes()) expect(m.subMeshes.length).toBe(1)
  })

  it('does not allocate per frame after the warm-up (typed buffers, reused pose, string identity)', () => {
    const { scene } = rig()
    const assets = stubCrowdAssets(scene)
    cleanups.push(() => assets.dispose())
    const sched = new RingSchedule(80, i => 4 + (i % 50), i => i % 3 !== 0)
    const crowd = new TownCrowd(assets, sched, { kinds: ['folk'], variants: 10 })
    crowd.configure(60, 60)
    const threats = new Float32Array([3, 3, -5, 8])
    const q = query(EPOCH_2026)
    let t = 0
    const step = () => {
      t += 1 / 60
      q.nowS = EPOCH_2026 + t
      for (const v of assets.vats) v.manager.time = REBASE_MIN_S + t
      crowd.update(q, REBASE_MIN_S + t, 0, 0, 1 / 60, threats, 2)
    }
    for (let k = 0; k < 3000; k++) step()
    const rounds: number[] = []
    for (let r = 0; r < 12; r++) {
      const before = process.memoryUsage().heapUsed
      for (let k = 0; k < 200; k++) step()
      const grown = process.memoryUsage().heapUsed - before
      if (grown >= 0) rounds.push(grown)
    }
    const cleanest = rounds.length ? Math.min(...rounds) : 0
    // 200 frames of 60 drawn agents: one boxed number per agent per frame would be 200 × 60 × 16 B ≈ 190 KB (the first
    // version, with the frame's numbers as place() arguments, measured 390 KB); what is left is the test harness's own
    // per-frame boxes (≈ 50 KB under vitest's module runner, ≈ 13 KB in plain Node)
    expect(cleanest).toBeLessThan(96 * 1024)
  })

  it('the plaza stand-in schedule stays near allocation-free too (150 agents evaluated per frame)', () => {
    const { scene } = rig()
    const assets = stubCrowdAssets(scene)
    cleanups.push(() => assets.dispose())
    const crowd = new TownCrowd(assets, new PlazaStandIn(), { kinds: ['folk', 'guard'], variants: 10 })
    crowd.configure(60, 60)
    const q = query(EPOCH_2026)
    const threats = new Float32Array([PLAZA.x + 3, PLAZA.z + 20])
    let t = 0
    const step = () => {
      t += 1 / 60
      q.nowS = EPOCH_2026 + t
      crowd.update(q, REBASE_MIN_S + t, PLAZA.x, PLAZA.z - 8, 1 / 60, threats, 1)
    }
    for (let k = 0; k < 6000; k++) step()
    const rounds: number[] = []
    for (let r = 0; r < 12; r++) {
      const before = process.memoryUsage().heapUsed
      for (let k = 0; k < 200; k++) step()
      const grown = process.memoryUsage().heapUsed - before
      if (grown >= 0) rounds.push(grown)
    }
    // the first version (an array and a closure per agent per frame) allocated ≈ 58 MB here
    expect(rounds.length ? Math.min(...rounds) : 0).toBeLessThan(200 * 1024)
  })
})

describe('the time base (F5) and the drawn clip phase', () => {
  it('manager.time stays in [60, 3540) s with a 2026 epoch clock, across two hours of re-bases', () => {
    const { scene, camera } = rig()
    let now = EPOCH_2026
    const plan = testPlan(new RingSchedule(30, () => 10, i => i % 2 === 0))
    const life = new TownLife({ scene, world: fakeWorld(scene) }, { plan: () => plan, assets: (s, d) => stubCrowdAssets(s, d) })
    cleanups.push(() => life.dispose())
    life.setClock(() => now)
    const seen: number[] = []
    for (let k = 0; k < 7300; k++) {
      now += 1
      life.update(camera, 1)
      seen.push(life.stats().vatTime!)
      for (const v of life.assets!.vats) expect(v.manager.time).toBe(life.stats().vatTime)
    }
    expect(Math.max(...seen)).toBeLessThan(REBASE_MAX_S)
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(REBASE_MIN_S)
    expect(Math.max(...seen)).toBeLessThan(3600)
  })

  it('the GPU draws the schedule\'s clip phase: standing (clipT) and walking (distance ÷ the clip\'s loop), re-based or not', () => {
    const { scene } = rig()
    const assets = stubCrowdAssets(scene)
    cleanups.push(() => assets.dispose())
    const sched = new RingSchedule(24, () => 10, i => i % 2 === 0)
    const crowd = new TownCrowd(assets, sched, { kinds: ['folk'], variants: 10 })
    crowd.configure(60, 60)
    const pose = newPose()
    const check = (nowS: number, T: number) => {
      for (const v of assets.vats) v.manager.time = T
      crowd.update(query(nowS), T, 0, 0, 0.1, new Float32Array(0), 0)
      let checked = 0
      for (const d of crowd.draws) {
        for (let s = 0; s < d.count; s++) {
          const i = d.slotAgent[s]!
          sched.pose(i, query(nowS), pose)
          const clip = d.variant.vat.clips.get(pose.clip)!
          const frames = clip.end - clip.start + 1
          const natural = clip.loopM / (frames / clip.fps)
          const clipT = clip.loopM > 0 && Number.isFinite(pose.distM) ? pose.distM / natural : pose.clipT
          const st = d.settings
          const drawn = vatDrawnFrame(T, st[s * 4]!, st[s * 4 + 1]!, st[s * 4 + 2]!, st[s * 4 + 3]!)
          // the frame the schedule's phase names (past the first cycle: rows start+1..end over one loop)
          const want = clip.start + 1 + Math.floor((((clipT * clip.fps) / frames) % 1) * (frames - 1))
          const n = frames - 1
          const diff = Math.min(Math.abs(drawn - want), n - Math.abs(drawn - want))
          expect(diff, `agent ${i} ${pose.clip}`).toBeLessThanOrEqual(1)
          checked++
        }
      }
      expect(checked).toBe(24)
    }
    check(EPOCH_2026, REBASE_MIN_S)
    check(EPOCH_2026 + 0.73, REBASE_MIN_S + 0.73)
    check(EPOCH_2026 + 1.21, REBASE_MIN_S + 1.21)
    // a re-base: T jumps back; every offset is written again in that frame
    crowd.invalidateClips()
    check(EPOCH_2026 + 1.5, REBASE_MIN_S)
    check(EPOCH_2026 + 2.9, REBASE_MIN_S + 1.4)
    // the offset is the shader's inverse
    expect(vatDrawnFrame(100, 10, 44, vatOffsetFor(0.5, 30, 1, 35, 100), 30)).toBe(10 + 1 + Math.floor(((0.5 * 30) / 35) * 34))
  })
})

describe('nothing on Classic; a path switch leaves nothing behind (the Low guard)', () => {
  it('Classic: World.town is null and no town mesh exists; PBR → Classic → PBR leaves no town mesh or VAT texture', async () => {
    const plan = testPlan(new RingSchedule(20, () => 8))
    const make = townPartWith({ plan: () => plan, assets: (s, d) => stubCrowdAssets(s, d) })
    const classic = await w10World({ render: 'classic', parts: { batch: null, ocean: null, town: make } })
    cleanups.push(classic.dispose)
    expect(classic.world.town).toBeNull()
    expect(classic.scene.meshes.filter(m => isTownMesh(m))).toHaveLength(0)
    expect(classic.scene.textures.filter(t => t.name.startsWith('town:'))).toHaveLength(0)

    const s = await w10World({ render: 'pbr', parts: { batch: null, ocean: null, town: make } })
    cleanups.push(s.dispose)
    const town = s.world.town as TownLife
    expect(town).toBeInstanceOf(TownLife)
    s.world.update(s.scene.activeCamera ?? new ArcRotateCamera('c', 0, 1, 10, new Vector3(0, 0, 0), s.scene))
    expect(s.scene.meshes.filter(m => isTownMesh(m) && !m.isDisposed()).length).toBeGreaterThan(0)
    s.world.setRenderMode('classic')
    expect(s.world.town).toBeNull()
    expect(s.scene.meshes.filter(m => isTownMesh(m) && !m.isDisposed())).toHaveLength(0)
    expect(s.scene.textures.filter(t => t.name.startsWith('town:'))).toHaveLength(0)
    expect(s.scene.materials.filter(m => m.name.startsWith('town:'))).toHaveLength(0)
    s.world.setRenderMode('pbr')
    expect(s.world.town).toBeInstanceOf(TownLife)
    s.world.setRenderMode('classic')
    expect(s.scene.meshes.filter(m => isTownMesh(m) && !m.isDisposed())).toHaveLength(0)
  })

  it('a non-Jangan world has no plan (the stand-in only runs on Jangan)', () => {
    expect(plazaStandIn({ manifest: { name: 'synthetic' } } as unknown as World)).toBeNull()
    expect(plazaStandIn({ manifest: { name: 'jangan-fields' } } as unknown as World)).not.toBeNull()
  })
})

describe('the click and the pick (TOWN_LIFE §3.6)', () => {
  it('a ray through a townsperson picks it within 25 m; the meshes are not pickable, so the ground ray passes', () => {
    const { scene, camera } = rig()
    const plan = testPlan(new RingSchedule(10, () => 6))
    const life = new TownLife({ scene, world: fakeWorld(scene) }, { plan: () => plan, assets: (s, d) => stubCrowdAssets(s, d) })
    cleanups.push(() => life.dispose())
    life.setClock(() => EPOCH_2026)
    for (let k = 0; k < 10; k++) life.update(camera, 0.1)
    const d = { x: 0, y: 0, z: 0, h: 0, yaw: 0, scale: 1, alpha: 0 }
    expect(life.folk!.drawnOf(3, d)).toBe(true)
    // from above and to the side, through the body at 1 m
    const o = new Vector3(d.x + 10, 1, d.z)
    const dir = new Vector3(-1, 0, 0)
    expect(life.pickFolk(o.x, o.y, o.z, dir.x, dir.y, dir.z)).toBe(3)
    expect(life.pickFolk(o.x, 5, o.z, dir.x, 0, dir.z)).toBe(-1)
    expect(scene.pickWithRay(new Ray(o, dir), m => isTownMesh(m))?.hit ?? false).toBe(false)
    // a click: a flavour line, the clicked bubble first, for BUBBLE_S
    expect(life.say(3)).toBe(true)
    const out = Array.from({ length: 8 }, newBubble)
    expect(life.bubbles(out)).toBeGreaterThanOrEqual(1)
    expect(out[0]!.click).toBe(true)
    expect(out[0]!.agent).toBe(3)
    expect(DEFAULT_LINES.flavour.walker).toContain(out[0]!.text)
    life.setClock(() => EPOCH_2026 + BUBBLE_S + 0.1)
    life.update(camera, 0.1)
    expect(life.bubbles(out)).toBe(0)
  })
})

describe('the pigeons and the animals (TOWN_LIFE §4)', () => {
  it('the plaza habitat never lands within 6 m of a route edge or a dwell spot', () => {
    const plan = plazaStandIn({ manifest: { name: 'jangan-fields' } } as unknown as World)!
    const hab = plazaHabitat(plan.plaza!, plan.routes, () => -3.3)
    const s = plan.routes.segments
    const p = plan.routes.spots
    let landed = 0
    for (let k = 0; k < 4000; k++) {
      const x = PLAZA.box.x0 + ((k * 0.6180339) % 1) * (PLAZA.box.x1 - PLAZA.box.x0)
      const z = PLAZA.box.z0 + ((k * 0.7548776) % 1) * (PLAZA.box.z1 - PLAZA.box.z0)
      const y = hab.landing!(x, z)
      if (y === null) continue
      landed++
      expect(y).toBe(-3.3)
      let best = Infinity
      for (let j = 0; j < s.length; j += 4) best = Math.min(best, segmentDist2(x, z, s[j]!, s[j + 1]!, s[j + 2]!, s[j + 3]!))
      for (let j = 0; j < p.length; j += 2) best = Math.min(best, (p[j]! - x) ** 2 + (p[j + 1]! - z) ** 2)
      expect(Math.sqrt(best)).toBeGreaterThanOrEqual(LANDING_CLEAR_ROUTE_M)
    }
    expect(landed).toBeGreaterThan(50)
    // the fountain basin and outside the plaza: no weight, no landing
    expect(hab.weight(PLAZA.x, PLAZA.z)).toBe(0)
    expect(hab.weight(PLAZA.box.x1 + 10, PLAZA.z)).toBe(0)
    expect(nearRoute(plan.routes, PLAZA.x + 17, PLAZA.z)).toBe(true)
  })

  it('the animals are pure in the clock: hens stay in their yard, the dog trails its owner', () => {
    const plan = plazaStandIn({ manifest: { name: 'jangan-fields' } } as unknown as World)!
    const animals = new AnimalSchedule(plan.animals!, plan.folk)
    const a = newPose()
    const b = newPose()
    const yard = plan.animals!.yard!
    for (let k = 0; k < 200; k++) {
      const q = query(EPOCH_2026 + k * 3.7)
      for (let i = 0; i < animals.agents.length; i++) {
        expect(animals.pose(i, q, a)).toBe(animals.pose(i, q, b))
        expect([a.x, a.z, a.yaw, a.clip]).toEqual([b.x, b.z, b.yaw, b.clip])
        if (animals.agents[i]!.role === 'chicken') expect(Math.hypot(a.x - yard.x, a.z - yard.z)).toBeLessThanOrEqual(yard.r)
      }
    }
    const dog = animals.agents.findIndex(x => x.role === 'dog')
    const owner = plan.animals!.dogOwner
    const q = query(EPOCH_2026 + 50)
    expect(animals.pose(dog, q, a)).toBe(true)
    plan.folk.pose(owner, query(EPOCH_2026 + 50 - 1.1), b)
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(0.6)
  })
})

describe('the stand-in schedule and the alarm (D19)', () => {
  it('is pure in the clock (two clients 80 ms apart within 0.15 m)', () => {
    const s = new PlazaStandIn()
    const a = newPose()
    const b = newPose()
    for (let k = 0; k < 50; k++) {
      const t = EPOCH_2026 + k * 61.3
      for (let i = 0; i < s.agents.length; i++) {
        const oa = s.pose(i, query(t), a)
        const ob = s.pose(i, query(t + 0.08), b)
        if (!oa || !ob || a.clip !== b.clip) continue
        // walkers (1.46 m/s): 0.15 m (TOWN_LIFE §2.1); the running children (2.6 m/s) their 80 ms of running
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThanOrEqual(Math.max(0.15, a.speed * 0.08 + 0.01))
      }
    }
  })

  it('sends the walkers to the nearest door and in; the vendors stay; after the alarm everyone is back', () => {
    const s = new PlazaStandIn()
    const t0 = EPOCH_2026 + 1000
    const alarm = { alarmFromS: t0, alarmUntilS: t0 + 60 }
    const p = newPose()
    const at0 = newPose()
    const walkers = s.agents.map((a, i) => [a, i] as const).filter(([a]) => a.role === 'walker').map(([, i]) => i)
    const doorDist = (x: number, z: number) => Math.min(...PLAZA_DOORS.map(([dx, dz]) => Math.hypot(dx - x, dz - z)))
    let closer = 0
    let inside = 0
    for (const i of walkers) {
      if (!s.pose(i, query(t0), at0)) continue
      const d0 = doorDist(at0.x, at0.z)
      if (s.pose(i, query(t0 + 2, alarm), p) && d0 > 4) {
        expect(doorDist(p.x, p.z)).toBeLessThan(d0)
        expect(p.clip).toBe('WALK')
        expect(p.rate).toBeGreaterThan(1.2)
        closer++
      }
      if (!s.pose(i, query(t0 + 59, alarm), p) || doorDist(p.x, p.z) < 0.01) inside++
    }
    expect(closer).toBeGreaterThan(20)
    expect(inside).toBe(walkers.filter(i => s.pose(i, query(t0), at0)).length)
    // vendors keep selling
    const vendor = s.agents.findIndex(a => a.role === 'vendor')
    expect(s.pose(vendor, query(t0 + 30, alarm), p)).toBe(true)
    expect(p.clip).toBe('VENDOR01')
    // a second after the alarm: back on the schedule
    const w = walkers.find(i => s.pose(i, query(t0 + 61), at0))!
    expect(s.pose(w, query(t0 + 61, alarm), p)).toBe(true)
    expect([p.x, p.z]).toEqual([at0.x, at0.z])
  })

  it('the town part forwards the alarm to a schedule that keeps it (TL-R\'s)', () => {
    const { scene } = rig()
    const sched = new RingSchedule(4, () => 5)
    const calls: Array<[number, number]> = []
    ;(sched as CrowdSchedule).alarm = (n, sec) => void calls.push([n, sec])
    const life = new TownLife({ scene, world: fakeWorld(scene) }, { plan: () => testPlan(sched), assets: (s, d) => stubCrowdAssets(s, d) })
    cleanups.push(() => life.dispose())
    life.alarm(EPOCH_2026, 60)
    expect(calls).toEqual([[EPOCH_2026, 60]])
  })
})

describe('the bubbles (TOWN_LIFE §3.7)', () => {
  it('a vendor calls about every 12–25 s for 4 s, the same on every client; the nearest three show, the click first', () => {
    const starts: number[] = []
    let was = false
    for (let t = EPOCH_2026; t < EPOCH_2026 + 600; t += 0.25) {
      const c = vendorCallAt(7, t)
      if (c && !was) starts.push(c.startS)
      was = !!c
      expect(vendorCallAt(7, t)).toEqual(c)
    }
    const gaps = starts.slice(1).map((s, i) => s - starts[i]!)
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(CALL_SLOT_S - 6.5 - 0.01)
    expect(Math.max(...gaps)).toBeLessThanOrEqual(CALL_SLOT_S + 6.5 + 0.01)
    const list = [0, 1, 2, 3].map(k => ({ ...newBubble(), agent: k, dist: [9, 3, 12, 5][k]!, click: k === 2 }))
    expect(nearestBubbles(list, 4)).toBe(3)
    expect(list.slice(0, 3).map(b => b.agent)).toEqual([2, 1, 3])
    expect(clickText(DEFAULT_LINES, 'guard', 3, EPOCH_2026)).toBe(clickText(DEFAULT_LINES, 'guard', 3, EPOCH_2026 + 30 - (EPOCH_2026 % 60)))
  })
})

describe('the fade plugin and the crowd material', () => {
  it('GLSL and WGSL discard by the same ordered dither of the instance alpha, with no uniform or sampler', () => {
    const g = townFadeFragmentCode('glsl').CUSTOM_FRAGMENT_MAIN_BEGIN!
    const w = townFadeFragmentCode('wgsl').CUSTOM_FRAGMENT_MAIN_BEGIN!
    for (const code of [g, w]) {
      expect(code.startsWith('#if defined(SRO_TOWN_FADE) && defined(INSTANCESCOLOR) && defined(INSTANCES)')).toBe(true)
      expect(code).toContain('discard')
      expect(code).toContain('0.03125')
      expect(code).not.toMatch(/uniform|sampler|texture/)
    }
    expect(g).toContain('gl_FragCoord')
    expect(w).toContain('fragmentInputs.position')
    expect(w).not.toContain('gl_FragCoord')
  })

  it('a stand-in variant compiles with the VAT, thin instances, the instance colour and the fade (NullEngine)', async () => {
    const { scene } = rig()
    const assets = stubCrowdAssets(scene)
    cleanups.push(() => assets.dispose())
    const crowd = new TownCrowd(assets, new RingSchedule(4, () => 3), { kinds: ['folk'], variants: 10 })
    crowd.configure(60, 60)
    run(crowd, assets, EPOCH_2026, 10)
    const mesh = drawnMeshes(crowd)[0]!
    const mat = mesh.material as PBRMaterial
    expect(mat.pluginManager?.getPlugin(SRO_TOWN_FADE_PLUGIN)).toBeTruthy()
    let ready = false
    for (let k = 0; k < 400 && !ready; k++) {
      ready = mesh.isReady(true, true) // a real engine has instanced arrays (NullEngine's caps say no)
      if (!ready) await new Promise(r => setTimeout(r, 5))
    }
    expect(ready).toBe(true)
    const defs = (mesh.subMeshes[0]!.materialDefines as unknown as Record<string, unknown>)
    expect([defs.BAKED_VERTEX_ANIMATION_TEXTURE, defs.INSTANCES, defs.THIN_INSTANCES, defs.INSTANCESCOLOR, defs.SRO_TOWN_FADE]).toEqual([true, true, true, true, true])
    expect(ShaderLanguage.WGSL).toBeDefined()
  })
})

describe('TL-R\'s schedule behind the crowd (ScheduleAdapter)', () => {
  it('a town file\'s agents are drawn by the crowd at their schedule poses', () => {
    const { scene } = rig()
    const plan = schedulePlan(MINI_TOWN, fakeWorld(scene), [])
    expect(plan.folk.agents.length).toBeGreaterThan(0)
    expect(plan.routes.segments.length).toBe(MINI_TOWN.graph.edges.length * 4)
    const assets = stubCrowdAssets(scene)
    cleanups.push(() => assets.dispose())
    const crowd = new TownCrowd(assets, plan.folk, { kinds: ['folk', 'guard'], variants: 10 })
    crowd.configure(60, 200)
    let best = 0
    for (let k = 0; k < 40; k++) {
      run(crowd, assets, EPOCH_2026 + k * 37, 8, 0.1, 20, 20)
      best = Math.max(best, crowd.frame.drawn)
    }
    expect(best).toBeGreaterThan(0)
  })
})

// ---- fixtures ------------------------------------------------------------------------------------------------------

function testPlan(folk: CrowdSchedule): TownPlan {
  return {
    folk, routes: { segments: new Float32Array(0), spots: new Float32Array(0) }, plaza: null, animals: null, pond: null,
    lines: DEFAULT_LINES as TownPlan['lines'], area: { x: 0, z: 0, r: 50 },
  }
}

/** The world pieces TownLife reads (a NullEngine scene; no nav, no life, no post). */
function fakeWorld(scene: Scene, quality = 'medium'): World {
  return {
    scene, quality, manifest: { name: 'test' }, heightAt: () => 0, waterLevelAt: () => null, skyState: { t: 0.5 },
    weatherState: { rain: 0 }, life: null, render: { post: null }, materials: null, worldClock: null, assets: null,
  } as unknown as World
}

/** A small town file: a square of streets with a door, a stall, a bench and a chat spot. */
const MINI_TOWN: TownFile = {
  schema: 1, kind: 'town', world: 'test', town: 'test', seed: 7,
  graph: {
    nodes: [{ id: 'a', x: 0, z: 0 }, { id: 'b', x: 40, z: 0 }, { id: 'c', x: 40, z: 40 }, { id: 'd', x: 0, z: 40 }, { id: 'e', x: 20, z: 20 }],
    edges: [{ a: 'a', b: 'b' }, { a: 'b', b: 'c' }, { a: 'c', b: 'd' }, { a: 'd', b: 'a' }, { a: 'a', b: 'e' }, { a: 'e', b: 'c' }],
  },
  places: [
    { id: 'door-a', kind: 'door', x: 0, z: 0, yaw: 0, node: 'a' },
    { id: 'gate-south', kind: 'door', x: 40, z: 40, yaw: 0, node: 'c' },
    { id: 'stall-1', kind: 'stall', x: 40, z: 2, yaw: 0, node: 'b', goods: 'fruit', seats: [{ x: 40, z: 2, yaw: 0, pose: 'stand' }] },
    { id: 'bench-1', kind: 'bench', x: 2, z: 40, yaw: 0, node: 'd', seats: [{ x: 2, z: 40, yaw: 0, pose: 'chair' }, { x: 3, z: 40, yaw: 0, pose: 'chair' }] },
    { id: 'chat-1', kind: 'chatSpot', x: 20, z: 21, yaw: 0, node: 'e', seats: [{ x: 19, z: 21, yaw: 1, pose: 'stand' }, { x: 21, z: 21, yaw: -1, pose: 'stand' }, { x: 20, z: 22, yaw: 3, pose: 'stand' }] },
  ],
  folk: { population: 12, roles: { walker: 6, chatter: 3, sitter: 2 }, female: 0.5, fixed: [{ role: 'vendor', place: 'stall-1', seat: 0 }] },
  schedule: { bands: [{ from: 0, to: 24, share: 1 }] },
  lines: { calls: { fruit: ['Peaches!'] }, flavour: { walker: ['Hello.'] } },
} as unknown as TownFile
