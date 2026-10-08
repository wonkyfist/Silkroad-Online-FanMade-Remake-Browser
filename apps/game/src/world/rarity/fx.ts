/**
 * The rare weapons' effects around the weapon (docs/RARITY.md §5.3–§5.7): everything a Seal of Star / Moon / Sun does
 * besides the blade's own material (three/weapon-rarity.ts), per tier and weapon kind (kinds.ts):
 *  - the aura while it is worn, all on the weapon: Star a nebula shell, orbiting stars and a trail of twinkling stardust;
 *    Moon silver mist pouring off and edge glints; Sun flames
 *    licking off the blade's surface, rising embers and a heat shell (no emblems behind the wearer, nothing on the floor);
 *    a rare shield carries its tier's emblem on its face (a constellation, a crescent, the sun-disc);
 *  - the swing: a ribbon that follows the blade (sword, blade), a wide sweep thrown past it (glaive) or a lance shot
 *    from the tip (spear) in the tier's strip (stardust, moonlight mist, fire), lingering; a bow's arrows fly as
 *    shooting stars, moon-bolts or sunfire comets;
 *  - the crit and the kill: shooting stars and a starburst; a crescent shockwave on the ground and a rising crescent;
 *    a solar flare with god rays, embers and a sunburst that scorches the ground;
 *  - the equip flare (your own new seal) and the drop moment: a constellation drawing itself and falling as a shooting
 *    star; a moonbeam from the sky; a pillar of sunfire with the sun-disc on the ground.
 * Performance: one draw (batch.ts) for all of it; your own weapon and the nearest (MOTE_CAPS per preset, within
 * FULL_RANGE_M) get the full set, the next ones within MOTE_RANGE_M their motes and swing ribbon, the rest only the
 * blade material. Pools are fixed and reused: nothing is allocated per frame once warm. Classic (Low) draws your own at
 * reduced counts. A lab can freeze the clock (debug/rarity-lab.ts).
 */
import { Vector3, type Camera, type Nullable, type Observer, type Scene, type TransformNode } from '@babylonjs/core'
import type { RarityTier } from '@sro/shared'
import { sceneExposure } from '@sro/world-render'
import {
  EQUIP_FLARE_S,
  MOTE_RANGE_M,
  RarityMotes,
  hash2,
  nightOf,
  pickMotes,
  type RareItem,
  type RareItemsListener,
  type RarityMode,
  type WeaponRarity,
} from '../../three/weapon-rarity.ts'
import { HitLights } from '../fx/hit-light.ts'
import { FxBatch, type Rgba } from './batch.ts'
import { rareKindOf, rareProfile, type RareKind, type RareProfile } from './kinds.ts'
import { P_EMBER, P_FLAME, P_FLARE, P_MIST, P_ORB, P_SMOKE, Painter, Particles } from './paint.ts'

const DEFAULT_MODE: RarityMode = { lite: false, moteCap: 6 }

/** Others' rare weapons nearer than this (and within the preset's cap) get the full effects (m). */
export const FULL_RANGE_M = 18
/** Others' crits, kills and arrows farther than this are not drawn (m). */
export const BURST_RANGE_M = 45
/** Bursts and arrow trails alive at once (pools). */
export const BURST_POOL = 40
export const ARROW_POOL = 24
/** Swing samples kept per weapon (about 0.6 s at 60 fps). */
const SAMPLES = 40
const SAMPLE_F = 8
/** The blade tip's speed from which a swing draws its ribbon (m/s), and the speed of a full-strength one. */
export const SWING_MIN_SPEED = 2.2
const SWING_FULL_SPEED = 6

export type Lod = 'full' | 'mid' | 'far'

export interface LodCaps {
  full: number
  mid: number
  lite: boolean
}

/** Full and mid caps of a mode: Low/Classic your own only (lite), else the preset's cap full and twice that mid. */
export function lodCaps(mode: RarityMode): LodCaps {
  return { full: Math.max(1, mode.moteCap), mid: mode.lite ? 0 : mode.moteCap * 2, lite: mode.lite }
}

/**
 * The LOD of each shown rare item (pure, tests): `ordered` nearest first (your own first, pickMotes) with distances;
 * the first `caps.full` within FULL_RANGE_M (your own always) are full, the next `caps.mid` mid, the rest far.
 */
export function lodOf(index: number, self: boolean, distance: number, fullSoFar: number, caps: LodCaps): Lod {
  if (self) return 'full'
  if (caps.lite) return 'far'
  if (fullSoFar < caps.full && distance <= FULL_RANGE_M) return 'full'
  if (index < caps.full + caps.mid && distance <= MOTE_RANGE_M) return 'mid'
  return 'far'
}

type V3 = [number, number, number]

const STAR_V: V3 = [0.72, 0.5, 1]
const STAR_W: V3 = [0.95, 0.88, 1]
const STAR_DEEP: V3 = [0.45, 0.3, 1]
const MOON_S: V3 = [1.08, 1.02, 0.9]
const MOON_B: V3 = [0.8, 0.86, 1]
const SUN_G: V3 = [1, 0.8, 0.42]
const SUN_W: V3 = [1, 0.96, 0.82]
const SUN_O: V3 = [1, 0.55, 0.16]
const SUN_R: V3 = [1, 0.32, 0.06]
const WHITE: V3 = [1, 1, 1]
/** Light colours (× the hit light's peak): a crit's flash per tier, your own weapon's glow. */
const FLASH_COLOR: Readonly<Record<RarityTier, V3>> = { star: [0.55, 0.35, 1], moon: [0.6, 0.7, 1], sun: [1, 0.6, 0.2] }
const SUN_GLOW: V3 = [0.75, 0.38, 0.1]
const MOON_GLOW: V3 = [0.32, 0.38, 0.55]

/** A worn rare item's per-frame state. */
interface Carrier {
  item: RareItem
  profile: RareProfile
  lod: Lod
  parts: Particles | null
  swingFrom: number
  swingUntil: number
  /** Ring of samples: t, inner xyz, outer xyz (world). */
  samples: Float32Array
  head: number
  n: number
  lastTip: Vector3
  hasLast: boolean
  /** The tip's speed (m/s) last frame. */
  speed: number
  emit: number
  emit2: number
  emit3: number
  /** Seen this frame (stale ones are dropped). */
  frame: number
}

/** A crit, kill, equip flare or arrow impact. */
interface Burst {
  on: boolean
  kind: 'crit' | 'kill' | 'equip' | 'lance'
  tier: RarityTier
  /** A lance: its direction (unit) and reach (m). */
  dx: number
  dy: number
  dz: number
  reach: number
  wkind: RareKind
  x: number
  y: number
  z: number
  /** The ground under it. */
  gy: number
  t0: number
  seed: number
  /** Follows a root (the equip flare) with this height. */
  follow: TransformNode | null
  height: number
}

interface ArrowTrail {
  on: boolean
  tier: RarityTier
  at: () => { pos: readonly number[] } | null
  done: () => boolean
  doneAt: number
  samples: Float32Array
  head: number
  n: number
  seed: number
}

/** A rare drop on the ground (drops.ts through rarity-beam.ts). */
export interface DropFx {
  readonly tier: RarityTier
  readonly node: TransformNode
  t0: number
  enabled: boolean
  readonly seed: number
}

const v1 = new Vector3()
const v2 = new Vector3()
const v3 = new Vector3()
const wBase = new Vector3()
const wTip = new Vector3()
const wDir = new Vector3()
const wAcross = new Vector3()
const wNormal = new Vector3()
const wFeet = new Vector3()
const wFwd = new Vector3()
const wLeft = new Vector3()
const wButt = new Vector3()
const tD = new Vector3()
const c0: Rgba = { r: 0, g: 0, b: 0, a: 0 }
const c1: Rgba = { r: 0, g: 0, b: 0, a: 0 }
const c2: Rgba = { r: 0, g: 0, b: 0, a: 0 }
const c3: Rgba = { r: 0, g: 0, b: 0, a: 0 }
/** Ribbon smoothing: pieces per sample gap, scratch for the ordered samples and two interpolated points. */
const RIBBON_SUB = 3
const RIB_IDX = new Int16Array(64)
const RIB_RUN = new Uint8Array(64)
const RP0 = new Float32Array(8)
const RP1 = new Float32Array(8)
/** Catmull-Rom of four values at f in [0, 1] between b and c. */
const cr = (a: number, b: number, c: number, d: number, f: number): number => {
  const f2 = f * f
  return 0.5 * (2 * b + (c - a) * f + (2 * a - 5 * b + 4 * c - d) * f2 + (3 * b - a - 3 * c + d) * f2 * f)
}

const set = (c: Rgba, col: readonly number[], k: number, a = 0): Rgba => {
  c.r = col[0]! * k
  c.g = col[1]! * k
  c.b = col[2]! * k
  c.a = a
  return c
}
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}
const easeOut = (x: number) => 1 - (1 - clamp01(x)) ** 3

const it0 = (c: Carrier): RareItem => c.item

const REGISTRY = new WeakMap<Scene, RarityFx>()

/** The scene's rare-weapon effects (made on first use). */
export function rarityFx(scene: Scene): RarityFx {
  let fx = REGISTRY.get(scene)
  if (!fx) {
    fx = new RarityFx(scene)
    REGISTRY.set(scene, fx)
  }
  return fx
}

/** The scene's rare-weapon effects if any exist (hooks: nothing is made for a page without rare weapons). */
export function rarityFxOf(scene: Scene): RarityFx | null {
  return REGISTRY.get(scene) ?? null
}

export class RarityFx implements RareItemsListener {
  readonly batch: FxBatch
  readonly painter: Painter
  private readonly motes: RarityMotes
  private readonly sources = new Set<WeaponRarity>()
  private readonly carriers = new Map<RareItem, Carrier>()
  private readonly shown: RareItem[] = []
  private readonly itemList: RareItem[] = []
  private readonly keys: number[] = []
  private readonly bursts: Burst[] = []
  private readonly arrows: ArrowTrail[] = []
  private readonly drops = new Set<DropFx>()
  private readonly partsPool: Particles[] = []
  /** Light flashes of crits and kills, and the flicker your own Sun / Moon weapon casts (world/fx/hit-light.ts). */
  private readonly flashes: HitLights
  private readonly glow: HitLights
  private glowNext = 0
  private readonly obs: Nullable<Observer<Scene>>
  private t = 0
  private lastT = 0
  private frameNo = 0
  private frozen = false
  /** LAB: the effects layer off (A/B frame timing; the blade materials stay). */
  enabled = true
  private night = 0
  private disposed = false
  /** Per-frame counts (the lab, the bench). */
  readonly counts = { full: 0, mid: 0, far: 0, bursts: 0, arrows: 0, drops: 0, quads: 0, ms: 0 }

  constructor(readonly scene: Scene) {
    this.batch = new FxBatch(scene, 512)
    this.painter = new Painter(this.batch)
    this.motes = new RarityMotes(scene, this.batch, this.painter)
    for (let i = 0; i < BURST_POOL; i++) this.bursts.push({ on: false, kind: 'crit', tier: 'star', wkind: 'sword', dx: 0, dy: 0, dz: 1, reach: 2, x: 0, y: 0, z: 0, gy: 0, t0: 0, seed: 0, follow: null, height: 0 })
    for (let i = 0; i < ARROW_POOL; i++) this.arrows.push({ on: false, tier: 'star', at: () => null, done: () => true, doneAt: 0, samples: new Float32Array(SAMPLES * 4), head: 0, n: 0, seed: 0 })
    this.flashes = new HitLights(scene, () => performance.now(), 2)
    this.glow = new HitLights(scene, () => performance.now(), 1)
    this.t = this.lastT = performance.now() / 1000
    this.obs = scene.onBeforeRenderObservable.add(() => this.frame())
  }

  /** A WeaponRarity whose items this draws. */
  attach(source: WeaponRarity): void {
    if (this.sources.has(source)) return
    this.sources.add(source)
    source.listener = this
  }

  detach(source: WeaponRarity): void {
    this.sources.delete(source)
    if (source.listener === this) source.listener = null
  }

  /** An item was lit: the equip flare on your own new seal. */
  lit(item: RareItem): void {
    if (!item.flare) return
    const b = this.burst()
    if (!b) return
    const r = item.owner.root
    const p = r.getAbsolutePosition()
    this.fillBurst(b, 'equip', item.tier, item.kind, p.x, p.y + 1.2, p.z, p.y)
    b.follow = r
    b.height = 1.2
  }

  /** Freezes the clock (the lab's still frames); the blade materials hold too. */
  freeze(on: boolean): void {
    this.frozen = on
    for (const s of this.sources) s.hold(on ? s.time : null)
    if (!on) this.lastT = this.t = performance.now() / 1000
  }

  /** The time the effects run on (s). */
  get now(): number {
    return this.t
  }

  private carrierOf(owner: object): Carrier | null {
    for (const c of this.carriers.values()) if (c.item.owner === owner && c.item.kind !== 'shield') return c
    for (const s of this.sources) for (const it of s.live) if (it.owner === owner && it.kind !== 'shield') return this.carrier(it)
    return null
  }

  private carrier(item: RareItem): Carrier {
    let c = this.carriers.get(item)
    if (!c) {
      // the wearer's weapon family is final once the item is drawn (it may be set after the item was lit)
      if (item.kind !== 'shield') (item as { kind: RareKind }).kind = rareKindOf('weapon', (item.owner as { family?: string | null }).family)
      c = {
        item,
        profile: rareProfile(item.tier, item.kind),
        lod: 'far',
        parts: null,
        swingFrom: -1,
        swingUntil: -1,
        samples: new Float32Array(SAMPLES * SAMPLE_F),
        head: 0,
        n: 0,
        lastTip: new Vector3(),
        hasLast: false,
        speed: 0,
        emit: 0,
        emit2: 0,
        emit3: 0,
        frame: this.frameNo,
      }
      this.carriers.set(item, c)
    }
    return c
  }

  /** A swing of `owner`'s rare weapon from now for `seconds` (SkillFx.swing; the lab). */
  swing(owner: object, seconds: number): boolean {
    const c = this.carrierOf(owner)
    if (!c) return false
    if (this.t > c.swingUntil) c.swingFrom = this.t
    c.swingUntil = Math.max(c.swingUntil, this.t + Math.max(0.15, seconds))
    return true
  }

  /** A crit or a kill by `owner` at `at` (the victim's chest; the ground ~1.1 m under it). */
  impact(owner: object, at: Vector3, kind: 'crit' | 'kill', ground = at.y - 1.1): boolean {
    const c = this.carrierOf(owner)
    if (!c) return false
    const cam = this.scene.activeCamera
    if (cam && !c.item.owner.lodFull && Vector3.Distance(cam.globalPosition, at) > BURST_RANGE_M) return false
    const b = this.burst()
    if (!b) return false
    this.fillBurst(b, kind, c.item.tier, c.item.kind, at.x, at.y, at.z, ground)
    return true
  }

  /** The equip flare on `owner` now (the lab). */
  equipFlare(owner: { root: TransformNode }): boolean {
    const c = this.carrierOf(owner)
    if (!c) return false
    const b = this.burst()
    if (!b) return false
    const p = owner.root.getAbsolutePosition()
    this.fillBurst(b, 'equip', c.item.tier, c.item.kind, p.x, p.y + 1.2, p.z, p.y)
    b.follow = owner.root
    b.height = 1.2
    return true
  }

  /** An arrow of `owner`'s rare bow: `at()` its position while it flies, `done()` once it has arrived. */
  arrow(owner: object, at: () => { pos: readonly number[] } | null, done: () => boolean): boolean {
    const c = this.carrierOf(owner)
    if (!c) return false
    const a = this.arrows.find(x => !x.on) ?? null
    if (!a) return false
    a.on = true
    a.tier = c.item.tier
    a.at = at
    a.done = done
    a.doneAt = -1
    a.head = 0
    a.n = 0
    a.seed = Math.floor(Math.random() * 1e6)
    return true
  }

  /** A rare drop's effects (its moment when `fresh`, then its standing mark) under `node` (at the ground). */
  addDrop(tier: RarityTier, node: TransformNode, fresh: boolean): DropFx {
    const d: DropFx = { tier, node, t0: fresh ? this.t : this.t - 30, enabled: true, seed: Math.floor(Math.random() * 1e6) }
    this.drops.add(d)
    return d
  }

  removeDrop(d: DropFx): void {
    this.drops.delete(d)
  }

  /** The lab: a drop moment of `tier` at `at` with no item (removed after 12 s). */
  labDrop(tier: RarityTier, node: TransformNode): DropFx {
    const d = this.addDrop(tier, node, true)
    setTimeout(() => this.removeDrop(d), 12_000)
    return d
  }

  stats(): Record<string, number> {
    return { ...this.counts, peakQuads: this.batch.peak, carriers: this.carriers.size }
  }

  private burst(): Burst | null {
    let best: Burst | null = null
    for (const b of this.bursts) {
      if (!b.on) return b
      if (!best || b.t0 < best.t0) best = b
    }
    return best
  }

  private fillBurst(b: Burst, kind: Burst['kind'], tier: RarityTier, wkind: RareKind, x: number, y: number, z: number, gy: number): void {
    b.on = true
    b.kind = kind
    b.tier = tier
    b.wkind = wkind
    b.x = x
    b.y = y
    b.z = z
    b.gy = gy
    b.t0 = this.t
    b.seed = Math.floor(Math.random() * 1e6)
    b.follow = null
    b.height = 0
    if (kind === 'crit' || kind === 'kill') this.flashes.flash([x, y, z], FLASH_COLOR[tier], kind === 'kill' ? 750 : 420)
  }

  private particles(): Particles {
    return this.partsPool.pop() ?? new Particles(640)
  }

  // ---- the frame --------------------------------------------------------------------------------------------------

  frame(): void {
    if (this.disposed) return
    this.frameNo++
    const t0 = performance.now()
    const now = t0 / 1000
    if (!this.frozen) this.t = now
    const dt = this.frozen ? 0 : Math.min(0.1, Math.max(0, this.t - this.lastT))
    this.lastT = this.t
    const camera: Camera | null = this.scene.activeCamera
    this.batch.begin()
    if (!this.enabled) {
      this.batch.end()
      return
    }
    const cnt = this.counts
    cnt.full = cnt.mid = cnt.far = cnt.bursts = cnt.arrows = cnt.drops = 0
    if (!camera) {
      this.batch.end()
      return
    }
    const p = this.painter
    p.frame(camera)
    const exposure = sceneExposure(this.scene)
    this.night = nightOf(exposure)
    let mode: RarityMode = DEFAULT_MODE
    for (const s of this.sources) mode = s.mode
    this.batch.setGain(mode.lite ? 1 : 1 / Math.max(1e-3, exposure), !mode.lite)
    const caps = lodCaps(mode)
    this.flashes.setEnabled(!mode.lite)
    this.glow.setEnabled(!mode.lite)
    this.flashes.update()
    this.glow.update()

    // the worn rare items: LOD, auras, swings
    const items = this.itemList
    items.length = 0
    for (const s of this.sources) for (const it of s.live) items.push(it)
    const all = items.length
    const shown = pickMotes(items, caps.full + caps.mid, p.eye, this.shown, this.keys)
    let full = 0
    for (let i = 0; i < shown.length; i++) {
      const it = shown[i]!
      const self = it.owner.lodFull
      const lod = lodOf(i, self, this.keys[i]!, full, caps)
      if (lod === 'full') full++
      const c = this.carrier(it)
      c.frame = this.frameNo
      this.setLod(c, lod)
      if (lod === 'far') continue
      this.drawCarrier(c, dt, mode.lite)
      if (lod === 'full') cnt.full++
      else cnt.mid++
    }
    cnt.far = all - cnt.full - cnt.mid
    // carriers not shown this frame: release their pools; forgotten items (unlit): drop them
    for (const [item, c] of this.carriers) {
      if (c.frame === this.frameNo) continue
      this.setLod(c, 'far')
      if (!this.isLive(item)) this.carriers.delete(item)
    }

    for (const b of this.bursts) if (b.on && this.drawBurst(b, mode.lite)) cnt.bursts++
    for (const a of this.arrows) if (a.on && this.drawArrow(a, dt)) cnt.arrows++
    for (const d of this.drops) {
      if (d.node.isDisposed()) {
        this.drops.delete(d)
        continue
      }
      if (!d.enabled) continue
      this.drawDrop(d)
      cnt.drops++
    }
    cnt.quads = this.batch.count
    this.batch.end()
    cnt.ms = cnt.ms * 0.95 + (performance.now() - t0) * 0.05
  }

  private isLive(item: RareItem): boolean {
    for (const s of this.sources) if (s.live.has(item)) return true
    return false
  }

  private setLod(c: Carrier, lod: Lod): void {
    if (c.lod === lod) return
    c.lod = lod
    if (lod === 'full' && !c.parts) c.parts = this.particles()
    if (lod !== 'full' && c.parts) {
      c.parts.clear()
      this.partsPool.push(c.parts)
      c.parts = null
    }
    if (lod === 'far') {
      c.n = 0
      c.hasLast = false
    }
  }

  /** The carrier's world frame into the w* scratch vectors; false when its mesh is gone. */
  private worldFrame(c: Carrier): boolean {
    const it = c.item
    const m = it.meshes[0]
    if (!m || m.isDisposed()) return false
    const w = m.getWorldMatrix()
    Vector3.TransformCoordinatesToRef(it.base, w, wBase)
    Vector3.TransformCoordinatesToRef(it.tip, w, wTip)
    wTip.subtractToRef(wBase, wDir)
    const len = wDir.length()
    if (len > 1e-6) wDir.scaleInPlace(1 / len)
    Vector3.TransformNormalToRef(it.across, w, wAcross)
    wAcross.normalize()
    Vector3.TransformNormalToRef(it.normal, w, wNormal)
    wNormal.normalize()
    const r = it.owner.root
    const rw = r.getWorldMatrix().m
    wFeet.set(rw[12]!, rw[13]!, rw[14]!)
    wFwd.set(rw[8]!, 0, rw[10]!)
    if (wFwd.lengthSquared() < 1e-8) wFwd.set(0, 0, 1)
    wFwd.normalize()
    wLeft.set(wFwd.z, 0, -wFwd.x)
    return true
  }

  private drawCarrier(c: Carrier, dt: number, lite: boolean): void {
    if (!this.worldFrame(c)) return
    const it = c.item
    const p = this.painter
    const vis = it.meshes[0]!.visibility
    const len = Vector3.Distance(wBase, wTip)
    const speed = c.hasLast && dt > 0 ? Vector3.Distance(wTip, c.lastTip) / dt : c.speed
    if (dt > 0) c.speed = speed
    c.lastTip.copyFrom(wTip)
    c.hasLast = true
    // swing samples (full and mid): only the fast part of a swing draws (no ribbon over the wind-up)
    const swinging = this.t <= c.swingUntil
    if (swinging && dt > 0 && speed > SWING_MIN_SPEED) this.sample(c, speed)
    if (c.n) this.drawRibbon(c, vis * (c.lod === 'mid' ? 0.75 : 1))

    if (c.lod === 'mid') {
      this.motes.drawItem(it, lite, this.t, 0.85)
      return
    }
    const parts = c.parts!
    // your own Sun / Moon weapon casts a flickering light on you and around (re-lit before it fades)
    if (it.owner.lodFull && it.tier !== 'star' && it.kind !== 'shield' && this.t >= this.glowNext && !this.frozen) {
      this.glowNext = this.t + 0.16
      this.glow.flash([(wBase.x + wTip.x) / 2, (wBase.y + wTip.y) / 2 + 0.2, (wBase.z + wTip.z) / 2], it.tier === 'sun' ? SUN_GLOW : MOON_GLOW, 420)
    }
    const k = lite ? 0.5 : 1
    if (it.kind === 'shield') this.shieldAura(c, parts, dt, k, vis)
    else if (it.tier === 'star') this.starAura(c, parts, len, dt, speed, k, vis, swinging)
    else if (it.tier === 'moon') this.moonAura(c, parts, len, dt, speed, k, vis, swinging)
    else this.sunAura(c, parts, len, dt, speed, k, vis, swinging)
    parts.step(dt, it.tier === 'sun' ? 0.25 : it.tier === 'moon' ? -0.06 : -0.03, it.tier === 'moon' ? 0.9 : 0.6)
    parts.draw(p, vis)
  }

  // ---- auras --------------------------------------------------------------------------------------------------------

  /** A point along the blade at `t` (0 base .. 1 tip) into `out`. */
  private bladeAt(t: number, out: Vector3): Vector3 {
    return Vector3.LerpToRef(wBase, wTip, t, out)
  }

  private starAura(c: Carrier, parts: Particles, len: number, dt: number, speed: number, k: number, vis: number, swinging: boolean): void {
    const p = this.painter
    const t = this.t
    const ph = c.item.phase * 37
    // thin orbit arcs circling the weapon (two tilted ellipses, each drawn over most of its turn and fading at its tail)
    {
      const mx = (wBase.x + wTip.x) / 2
      const my = (wBase.y + wTip.y) / 2
      const mz = (wBase.z + wTip.z) / 2
      const A = len * 0.62
      const Bw = Math.max(0.07, len * 0.16)
      for (let r = 0; r < 2; r++) {
        const tilt = r ? 0.9 : -0.5
        const ct = Math.cos(tilt)
        const st = Math.sin(tilt)
        // the ellipse's minor axis: across turned about the blade axis by the tilt
        const qx = wAcross.x * ct + wNormal.x * st
        const qy = wAcross.y * ct + wNormal.y * st
        const qz = wAcross.z * ct + wNormal.z * st
        const head = t * (r ? 1.3 : -1.0) + c.item.phase * 6
        const segs = 22
        let px = 0
        let py = 0
        let pz = 0
        for (let i = 0; i <= segs; i++) {
          const a = head - (i / segs) * 4.4
          const x = mx + wDir.x * Math.cos(a) * A + qx * Math.sin(a) * Bw
          const y = my + wDir.y * Math.cos(a) * A + qy * Math.sin(a) * Bw
          const z = mz + wDir.z * Math.cos(a) * A + qz * Math.sin(a) * Bw
          if (i) p.line(px, py, pz, x, y, z, 0.006, p.rgb(STAR_W[0], STAR_W[1], STAR_W[2], 1.6 * (1 - i / segs) * vis))
          if (i === 0) p.billboard(x, y, z, 0.05, t * 2, 'flare', p.rgb(WHITE[0], WHITE[1], WHITE[2], 3.5 * vis))
          px = x
          py = y
          pz = z
        }
      }
    }
    // stars orbiting the blade (sized for the default camera: a few pixels at least)
    const camD = Math.max(1, Vector3.Distance(wTip, p.eye))
    const n = Math.round(16 * c.profile.motes * (k < 1 ? 0.6 : 1))
    for (let i = 0; i < n; i++) {
      const h = hash2(i, 77)
      const tt = 0.12 + 0.9 * ((i + 0.5) / n) + 0.04 * Math.sin(t * 0.7 + i)
      const a = t * (1.3 + 0.8 * h) + i * 2.399 + ph
      const rad = Math.max(0.06, len * 0.1) * (0.8 + 1.2 * hash2(i, 13))
      this.bladeAt(Math.min(1.05, tt), v1)
      const ca = Math.cos(a) * rad
      const sa = Math.sin(a) * rad
      v1.x += wAcross.x * ca + wNormal.x * sa
      v1.y += wAcross.y * ca + wNormal.y * sa
      v1.z += wAcross.z * ca + wNormal.z * sa
      const tw = 0.35 + 0.65 * Math.max(0, Math.sin(t * (3 + 3 * h) + i * 5.1)) ** 3
      const sz = Math.max(0.05, 0.016 * camD, len * (0.08 + 0.06 * h)) * (0.7 + 0.6 * tw)
      p.billboard(v1.x, v1.y, v1.z, sz, t * 0.8 + i, 'flare', p.rgb(STAR_W[0], STAR_W[1], STAR_W[2], 5 * tw * vis))
      p.billboard(v1.x, v1.y, v1.z, sz * 0.5, 0, 'orb', p.rgb(STAR_V[0], STAR_V[1], STAR_V[2], 1.6 * tw * vis))
    }
    // a trail of twinkling stardust: more the faster the blade moves
    const fast = swinging && speed > SWING_MIN_SPEED
    // idle: a steady drift of stardust off the blade; moving: more; swinging: a dense trail
    const rate = (34 + Math.min(40, speed * 8) + (fast ? 650 : 0)) * k
    c.emit += rate * dt
    while (c.emit >= 1) {
      c.emit -= 1
      this.bladeAt(fast ? 0.45 + 0.75 * Math.random() : 0.25 + 0.8 * Math.random(), v1)
      if (fast) {
        const j = (Math.random() - 0.5) * len * 0.25
        v1.addInPlaceFromFloats(wAcross.x * j, wAcross.y * j, wAcross.z * j)
      }
      const big = Math.random() < 0.25
      parts.emit(v1.x, v1.y, v1.z, (Math.random() - 0.5) * 0.08, (Math.random() - 0.5) * 0.06, (Math.random() - 0.5) * 0.08, 0.9 + Math.random() * (fast ? 1.6 : 1.0), Math.max(0.022, 0.006 * camD, len * (big ? 0.09 : 0.035)) * (0.6 + Math.random() * 0.8), -0.4, big ? P_FLARE : P_ORB, STAR_W, STAR_V, big ? 3.6 : 3, Math.random() * 6)
    }
  }

  private moonAura(c: Carrier, parts: Particles, len: number, dt: number, speed: number, k: number, vis: number, swinging: boolean): void {
    const p = this.painter
    const t = this.t
    const nb = 1 + this.night * 0.7
    // the moonstone glow along the blade
    for (let i = 0; i < 3; i++) {
      this.bladeAt(0.3 + i * 0.3, v1)
      p.billboard(v1.x, v1.y, v1.z, len * 0.22, 0, 'orb', p.rgb(MOON_B[0], MOON_B[1], MOON_B[2], 0.38 * vis * nb))
    }
    // silver mist pouring off the blade
    const rate = (22 + Math.min(30, speed * 6) + (swinging ? 40 : 0)) * k
    c.emit += rate * dt
    while (c.emit >= 1) {
      c.emit -= 1
      this.bladeAt(0.2 + 0.85 * Math.random(), v1)
      const s = (Math.random() - 0.5) * 0.25
      parts.emit(v1.x, v1.y, v1.z, wAcross.x * s + (Math.random() - 0.5) * 0.08, -0.08 - Math.random() * 0.1, wAcross.z * s + (Math.random() - 0.5) * 0.08, 1.4 + Math.random() * 1.1, len * (0.06 + Math.random() * 0.05), 2.4, Math.random() < 0.6 ? P_MIST : P_SMOKE, MOON_S, MOON_B, 0.45 * nb, Math.random() * 6)
    }
    // the swing throws moonlight mist off the tip
    if (swinging && speed > SWING_MIN_SPEED) {
      c.emit3 += 60 * k * dt
      while (c.emit3 >= 1) {
        c.emit3 -= 1
        this.bladeAt(0.75 + 0.45 * Math.random(), v1)
        parts.emit(v1.x, v1.y, v1.z, (Math.random() - 0.5) * 0.2, -0.05, (Math.random() - 0.5) * 0.2, 0.9 + Math.random() * 0.6, len * 0.1, 2.2, P_MIST, MOON_S, MOON_B, 0.9, Math.random() * 6)
      }
    }
    // glints along the edge
    for (let i = 0; i < 3; i++) {
      const tw = Math.max(0, Math.sin(t * 2.1 + i * 2.3 + c.item.phase * 9)) ** 6
      if (tw < 0.02) continue
      this.bladeAt(0.35 + 0.3 * i, v1)
      p.billboard(v1.x, v1.y, v1.z, len * 0.06, t + i, 'flare', p.rgb(WHITE[0], WHITE[1], WHITE[2], 3 * tw * vis))
    }
  }

  private sunAura(c: Carrier, parts: Particles, len: number, dt: number, speed: number, k: number, vis: number, swinging: boolean): void {
    const p = this.painter
    const t = this.t
    // the white-hot glow along the blade
    for (let i = 0; i < 3; i++) {
      this.bladeAt(0.3 + i * 0.3, v1)
      const fl = 0.85 + 0.15 * Math.sin(t * 9 + i * 2)
      p.billboard(v1.x, v1.y, v1.z, len * 0.24, 0, 'orb', p.rgb(SUN_O[0], SUN_O[1], SUN_O[2], 0.32 * fl * vis))
    }
    // flames licking off the blade
    const rate = (110 + Math.min(60, speed * 10) + (swinging ? 40 : 0)) * k
    c.emit += rate * dt
    const hw = Math.max(0.012, it0(c).halfWidth)
    while (c.emit >= 1) {
      c.emit -= 1
      // fire from points on the blade's surface (anywhere across its width, both faces), rising and curling;
      // small soft camera-facing puffs of varied size, turn and life (a white-hot core puff now and then)
      this.bladeAt(0.04 + 0.98 * Math.random(), v1)
      const e = (Math.random() * 2 - 1) * hw
      const d = (Math.random() - 0.5) * hw * 0.4
      v1.addInPlaceFromFloats(wAcross.x * e + wNormal.x * d, wAcross.y * e + wNormal.y * d, wAcross.z * e + wNormal.z * d)
      const core = Math.random() < 0.3
      const sz = Math.max(0.018, len * (core ? 0.025 : 0.035 + Math.random() * 0.045))
      parts.emit(v1.x, v1.y, v1.z, wAcross.x * e * 2 + (Math.random() - 0.5) * 0.12, 0.25 + Math.random() * 0.5, wAcross.z * e * 2 + (Math.random() - 0.5) * 0.12, 0.22 + Math.random() * 0.35, sz, core ? -0.3 : 0.6 + Math.random() * 0.8, core ? P_ORB : P_FLAME, SUN_W, core ? SUN_G : SUN_O, core ? 2.6 : 1.7, Math.random() * 6.28)
    }
    // the swing's fire arc: flames torn off the outer edge
    if (swinging && speed > SWING_MIN_SPEED) {
      c.emit3 += 70 * k * dt
      while (c.emit3 >= 1) {
        c.emit3 -= 1
        this.bladeAt(0.7 + 0.5 * Math.random(), v1)
        parts.emit(v1.x, v1.y, v1.z, (Math.random() - 0.5) * 0.3, 0.2 + Math.random() * 0.4, (Math.random() - 0.5) * 0.3, 0.25 + Math.random() * 0.3, len * (0.1 + Math.random() * 0.08), -0.2, P_FLAME, SUN_W, SUN_O, 2.4, (Math.random() - 0.5) * 0.6)
      }
    }
    // rising embers (falling as a rain while swinging)
    c.emit2 += (40 + (swinging ? 90 : 0)) * k * dt
    while (c.emit2 >= 1) {
      c.emit2 -= 1
      this.bladeAt(0.4 + 0.7 * Math.random(), v1)
      const fall = swinging && Math.random() < 0.7
      parts.emit(v1.x, v1.y, v1.z, (Math.random() - 0.5) * 0.6, fall ? -0.5 - Math.random() : 0.4 + Math.random() * 0.6, (Math.random() - 0.5) * 0.6, 0.9 + Math.random() * 1.4, 0.02 + Math.random() * 0.03, 0, P_EMBER, SUN_W, SUN_R, 4, 0, true)
    }
  }

  /** A rare shield: its tier's emblem on both faces, a rim light and the tier's particles. */
  private shieldAura(c: Carrier, parts: Particles, dt: number, k: number, vis: number): void {
    const p = this.painter
    const t = this.t
    const it = c.item
    // the outer face: the shield's normal on the side away from the wearer's body (chest height); every particle,
    // the orbit and the stars sit there and on the rim, nothing between the shield and the body
    const mx = (wBase.x + wTip.x) / 2
    const my = (wBase.y + wTip.y) / 2
    const mz = (wBase.z + wTip.z) / 2
    const out = (mx - wFeet.x) * wNormal.x + (my - wFeet.y - 1.1) * wNormal.y + (mz - wFeet.z) * wNormal.z >= 0 ? 1 : -1
    tD.set(wNormal.x * out, wNormal.y * out, wNormal.z * out)
    const lift = Math.max(0.02, it.halfWidth * 0.12)
    const cx = mx + tD.x * lift
    const cy = my + tD.y * lift
    const cz = mz + tD.z * lift
    // the tier material is on the shield's own mesh (weapon-rarity.ts); around it only light particles
    const R = Math.min(Vector3.Distance(wBase, wTip) / 2, it.halfWidth) * 0.96
    const h = R
    if (it.tier === 'star') {
      // stars orbiting the rim
      for (let i = 0; i < 8; i++) {
        const a = t * 0.8 + (i / 8) * 6.28
        const r = R * (1.15 + 0.1 * Math.sin(t * 2 + i))
        const tw = 0.5 + 0.5 * Math.sin(t * 3 + i * 1.7)
        p.billboard(cx + (wAcross.x * Math.cos(a) + wDir.x * Math.sin(a)) * r + tD.x * 0.04, cy + (wAcross.y * Math.cos(a) + wDir.y * Math.sin(a)) * r + tD.y * 0.04, cz + (wAcross.z * Math.cos(a) + wDir.z * Math.sin(a)) * r + tD.z * 0.04, 0.05 + 0.03 * tw, t + i, 'flare', p.rgb(STAR_W[0], STAR_W[1], STAR_W[2], 4 * tw * vis))
      }
    }
    // Star: a thin orbit arc round the face
    if (it.tier === 'star') {
      let px = 0
      let py = 0
      let pz = 0
      const head = t * 1.1 + it.phase * 6
      for (let i = 0; i <= 26; i++) {
        const a = head - (i / 26) * 4.8
        const r = R * 1.18
        const x = cx + (wAcross.x * Math.cos(a) + wDir.x * Math.sin(a) * 0.8) * r + tD.x * r * 0.18
        const y = cy + (wAcross.y * Math.cos(a) + wDir.y * Math.sin(a) * 0.8) * r + tD.y * r * 0.18
        const z = cz + (wAcross.z * Math.cos(a) + wDir.z * Math.sin(a) * 0.8) * r + tD.z * r * 0.18
        if (i) p.line(px, py, pz, x, y, z, 0.005, p.rgb(STAR_V[0], STAR_V[1], STAR_V[2], 1.8 * (1 - i / 26) * vis))
        px = x
        py = y
        pz = z
      }
    }
    // the tier's particles around the rim
    const rate = (it.tier === 'moon' ? 30 : it.tier === 'sun' ? 45 : 16) * k
    c.emit += rate * dt
    while (c.emit >= 1) {
      c.emit -= 1
      // on the outer face (biased to the rim), drifting outward
      const a = Math.random() * 6.28
      const rr = h * (it.tier === 'star' ? Math.sqrt(Math.random()) : 0.75 + 0.25 * Math.random())
      v1.set(cx + (wDir.x * Math.cos(a) + wAcross.x * Math.sin(a)) * rr, cy + (wDir.y * Math.cos(a) + wAcross.y * Math.sin(a)) * rr, cz + (wDir.z * Math.cos(a) + wAcross.z * Math.sin(a)) * rr)
      const ox = tD.x * 0.12
      const oy = tD.y * 0.12
      const oz = tD.z * 0.12
      if (it.tier === 'star') parts.emit(v1.x, v1.y, v1.z, ox, oy + 0.02, oz, 1, 0.025, -0.4, P_FLARE, STAR_W, STAR_V, 2, Math.random() * 6)
      else if (it.tier === 'moon') parts.emit(v1.x, v1.y, v1.z, (v1.x - mx) * 0.25 + ox, 0.02 + oy, (v1.z - mz) * 0.25 + oz, 1.4, 0.05, 2.4, P_MIST, MOON_S, MOON_B, 0.5, Math.random() * 6)
      else {
        parts.emit(v1.x, v1.y, v1.z, (Math.random() - 0.5) * 0.15 + ox, 0.35 + Math.random() * 0.3, (Math.random() - 0.5) * 0.15 + oz, 0.25 + Math.random() * 0.25, 0.03 + Math.random() * 0.03, 0.6, P_FLAME, SUN_W, SUN_O, 1.7, Math.random() * 6.28)
        if (Math.random() < 0.3) parts.emit(v1.x, v1.y, v1.z, (Math.random() - 0.5) * 0.4, 0.5 + Math.random() * 0.6, (Math.random() - 0.5) * 0.4, 0.8 + Math.random() * 0.6, 0.015, 0, P_EMBER, SUN_W, SUN_R, 3.5, 0, true)
      }
    }
  }

  // ---- swings ---------------------------------------------------------------------------------------------------------

  /** Records this frame's ribbon edge (inner, outer) of a swinging weapon. */
  private sample(c: Carrier, speed: number): void {
    const pr = c.profile
    if (pr.swing === 'none' || pr.swing === 'shot') return
    let inner: number
    let outer: number
    if (pr.swing === 'thrust') {
      inner = 0.82
      outer = 1.05
    } else if (pr.swing === 'sweep') {
      inner = 0.62
      outer = pr.reach
    } else {
      inner = 0.5
      outer = pr.reach
    }
    const s = c.samples
    const o = c.head * SAMPLE_F
    s[o] = this.t
    s[o + 1] = wBase.x + (wTip.x - wBase.x) * inner
    s[o + 2] = wBase.y + (wTip.y - wBase.y) * inner
    s[o + 3] = wBase.z + (wTip.z - wBase.z) * inner
    s[o + 4] = wBase.x + (wTip.x - wBase.x) * outer
    s[o + 5] = wBase.y + (wTip.y - wBase.y) * outer
    s[o + 6] = wBase.z + (wTip.z - wBase.z) * outer
    s[o + 7] = clamp01((speed - SWING_MIN_SPEED) / (SWING_FULL_SPEED - SWING_MIN_SPEED)) ** 0.5
    c.head = (c.head + 1) % SAMPLES
    c.n = Math.min(SAMPLES, c.n + 1)
  }

  /**
   * The swing ribbon: newest to oldest, smoothed (Catmull-Rom between the frames' samples, RIBBON_SUB pieces each),
   * fading with age and the swing's speed; Moon's drifts outward like a thrown crescent.
   */
  private drawRibbon(c: Carrier, vis: number): void {
    const it = c.item
    const linger = c.profile.linger
    const s = c.samples
    const strip = it.tier === 'star' ? 'stripStar' : it.tier === 'moon' ? 'stripMoon' : 'stripFire'
    const col = it.tier === 'star' ? WHITE : it.tier === 'moon' ? MOON_S : WHITE
    const bright = (it.tier === 'star' ? 1.2 : it.tier === 'moon' ? 2.3 : 2.6) * vis
    const drift = it.tier === 'moon' ? 0.9 : it.tier === 'sun' ? 0.25 : 0.1
    // the live samples, newest first, and where each run (no gap) starts
    const idx = RIB_IDX
    let m = 0
    let prevAge = -1
    for (let k = 0; k < c.n; k++) {
      const i = (c.head - 1 - k + SAMPLES * 2) % SAMPLES
      const age = this.t - s[i * SAMPLE_F]!
      if (age > linger) {
        c.n = k
        break
      }
      RIB_RUN[m] = prevAge >= 0 && age - prevAge < 0.07 ? 0 : 1
      idx[m++] = i
      prevAge = age
    }
    for (let j = 0; j + 1 < m; j++) {
      if (RIB_RUN[j + 1]) continue
      const a = idx[j > 0 && !RIB_RUN[j] ? j - 1 : j]! * SAMPLE_F
      const b = idx[j]! * SAMPLE_F
      const cc = idx[j + 1]! * SAMPLE_F
      const d = idx[j + 2 < m && !RIB_RUN[j + 2] ? j + 2 : j + 1]! * SAMPLE_F
      for (let q = 0; q < RIBBON_SUB; q++) {
        const f0 = q / RIBBON_SUB
        const f1 = (q + 1) / RIBBON_SUB
        this.ribPoint(s, a, b, cc, d, f0, RP0)
        this.ribPoint(s, a, b, cc, d, f1, RP1)
        const age0 = RP0[6]!
        const age1 = RP1[6]!
        const a0 = (1 - age0 / linger) ** 1.4 * RP0[7]!
        const a1 = (1 - age1 / linger) ** 1.4 * RP1[7]!
        const d0 = age0 * drift
        const d1 = age1 * drift
        this.outwardXY(RP0[3]!, RP0[5]!, v1)
        this.outwardXY(RP1[3]!, RP1[5]!, v2)
        set(c0, col, bright * a0)
        set(c1, col, bright * a1)
        set(c2, col, bright * a1 * 0.9)
        set(c3, col, bright * a0 * 0.9)
        this.batch.ribbon(
          RP0[3]! + v1.x * d0, RP0[4]!, RP0[5]! + v1.z * d0,
          RP1[3]! + v2.x * d1, RP1[4]!, RP1[5]! + v2.z * d1,
          RP1[0]! + v2.x * d1 * 0.6, RP1[1]!, RP1[2]! + v2.z * d1 * 0.6,
          RP0[0]! + v1.x * d0 * 0.6, RP0[1]!, RP0[2]! + v1.z * d0 * 0.6,
          strip, clamp01(age0 / linger), clamp01(age1 / linger), c0, c1, c2, c3,
        )
      }
    }
  }

  /** A point between samples b and c (a, d their neighbours) at f: inner xyz, outer xyz, age, strength into out. */
  private ribPoint(s: Float32Array, a: number, b: number, c: number, d: number, f: number, out: Float32Array): void {
    for (let k = 0; k < 6; k++) out[k] = cr(s[a + 1 + k]!, s[b + 1 + k]!, s[c + 1 + k]!, s[d + 1 + k]!, f)
    out[6] = this.t - (s[b]! + (s[c]! - s[b]!) * f)
    out[7] = s[b + 7]! + (s[c + 7]! - s[b + 7]!) * f
  }

  private outwardXY(x: number, z: number, out: Vector3): void {
    out.set(x - wFeet.x, 0, z - wFeet.z)
    const l = out.length()
    if (l > 1e-4) out.scaleInPlace(1 / l)
  }

  /** The horizontal unit vector from the wearer's feet to a sample's outer point. */
  private outward(s: Float32Array, o: number, out: Vector3): void {
    out.set(s[o + 4]! - wFeet.x, 0, s[o + 6]! - wFeet.z)
    const l = out.length()
    if (l > 1e-4) out.scaleInPlace(1 / l)
  }

  /**
   * A spear's thrust lands (the attack's or skill's hit; the lab): a lance of the tier fired from the tip along the
   * wearer's facing (a little of the spear's pitch), as long as the spear reaches. False without a rare spear.
   */
  thrust(owner: object): boolean {
    const c = this.carrierOf(owner)
    if (!c || c.item.kind !== 'spear' || !this.worldFrame(c)) return false
    const b = this.burst()
    if (!b) return false
    const len = Vector3.Distance(wBase, wTip)
    // from in front of the chest, straight along the facing (the attack clips swing the head about: the lance reads
    // as the thrust, not as the frame's tip)
    v1.set(wFwd.x, 0, wFwd.z).normalize()
    this.fillBurst(b, 'lance', c.item.tier, c.item.kind, wFeet.x + v1.x * 0.7, wFeet.y + 1.15, wFeet.z + v1.z * 0.7, wFeet.y)
    b.dx = v1.x
    b.dy = v1.y
    b.dz = v1.z
    b.reach = Math.max(2.4, Math.min(4, len * c.profile.reach * 1.6))
    return true
  }

  /** The kind of `owner`'s rare weapon (null: none). */
  kindOf(owner: object): RareKind | null {
    return this.carrierOf(owner)?.item.kind ?? null
  }

  private drawLance(b: Burst, age: number, k: number): void {
    const p = this.painter
    const life = this.burstLife(b)
    const grow = easeOut(age / 0.14)
    const fade = 1 - smooth(life * 0.45, life, age)
    const e = fade * Math.min(1, age / 0.04 + 0.2)
    const L = b.reach * (0.35 + 0.65 * grow)
    const cx = b.x + b.dx * L * 0.5
    const cy = b.y + b.dy * L * 0.5
    const cz = b.z + b.dz * L * 0.5
    const ex = b.x + b.dx * L
    const ey = b.y + b.dy * L
    const ez = b.z + b.dz * L
    // across the lance, level (the scorch line, the rings)
    v2.set(-b.dz, 0, b.dx).normalize()
    if (b.tier === 'star') {
      // a comet lance of stardust: violet bloom, a stardust body, a core and a star racing to its end
      p.alongAxis(cx, cy, cz, b.dx, b.dy, b.dz, L * 0.55, 0.45 * k, 'orb', p.rgb(STAR_DEEP[0], STAR_DEEP[1], STAR_DEEP[2], 0.9 * e))
      this.lanceStrip(cx, cy, cz, b, L, 0.32 * k, 'stripStar', p.rgb(WHITE[0], WHITE[1], WHITE[2], 2.4 * e))
      p.alongAxis(cx, cy, cz, b.dx, b.dy, b.dz, L * 0.52, 0.11 * k, 'pillar', p.rgb(STAR_V[0], STAR_V[1], STAR_V[2], 3.2 * e))
      for (let i = 0; i < 26; i++) {
        const u = hash2(b.seed, i) * grow
        const r = (0.05 + 0.3 * hash2(b.seed, i + 40)) * u
        const an = hash2(b.seed, i + 80) * 6.28 + age * 3
        const tw = 0.5 + 0.5 * Math.sin(age * 25 + i)
        p.billboard(b.x + b.dx * L * u + v2.x * Math.cos(an) * r, b.y + b.dy * L * u + Math.sin(an) * r, b.z + b.dz * L * u + v2.z * Math.cos(an) * r, 0.05 + 0.05 * hash2(b.seed, i + 9), i, 'flare', p.rgb(STAR_W[0], STAR_W[1], STAR_W[2], 3.5 * tw * e))
      }
      p.billboard(ex, ey, ez, 0.35 * k, age * 4, 'flare', p.rgb(WHITE[0], WHITE[1], WHITE[2], 5 * e))
      const sb = age / 0.5
      if (sb < 1) p.billboard(b.x, b.y, b.z, (0.25 + 0.75 * easeOut(sb)) * k, 0.3, 'starburst', p.rgb(WHITE[0], WHITE[1], WHITE[2], 3.2 * (1 - sb) ** 1.4))
    } else if (b.tier === 'moon') {
      const nb = 1 + this.night * 0.5
      p.alongAxis(cx, cy, cz, b.dx, b.dy, b.dz, L * 0.55, 0.5 * k, 'orb', p.rgb(MOON_B[0], MOON_B[1], MOON_B[2], 0.7 * e * nb))
      this.lanceStrip(cx, cy, cz, b, L, 0.3 * k, 'stripMoon', p.rgb(MOON_S[0], MOON_S[1], MOON_S[2], 2.2 * e * nb))
      p.alongAxis(cx, cy, cz, b.dx, b.dy, b.dz, L * 0.52, 0.13 * k, 'pillar', p.rgb(WHITE[0], WHITE[1], WHITE[2], 3 * e * nb))
      // crescent rings spiralling out along the lance, growing as they travel
      for (let i = 0; i < 5; i++) {
        const u = Math.min(1, ((i + 0.6) / 5) * grow * 1.15)
        const r = (0.22 + 0.11 * i) * k * (0.6 + 0.4 * grow)
        const an = age * 5 + i * 1.25
        const cs = Math.cos(an) * r
        const sn = Math.sin(an) * r
        // the ring's plane: across (v2) and up, perpendicular to the lance
        p.oriented(b.x + b.dx * L * u, b.y + b.dy * L * u, b.z + b.dz * L * u, v2.x * cs, sn, v2.z * cs, -v2.x * sn, cs, -v2.z * sn, 'shockwave', p.rgb(MOON_S[0], MOON_S[1], MOON_S[2], 2.6 * e * (1 - u * 0.4) * nb))
      }
      p.billboard(ex, ey, ez, 0.3 * k, -0.4, 'halo', p.rgb(MOON_S[0], MOON_S[1], MOON_S[2], 2.6 * e * nb))
      for (let i = 0; i < 8; i++) {
        const u = hash2(b.seed, i) * grow
        p.billboard(b.x + b.dx * L * u, b.y + b.dy * L * u + (hash2(b.seed, i + 5) - 0.5) * 0.3, b.z + b.dz * L * u, 0.22 + 0.3 * age, i, 'mist', p.rgb(MOON_S[0], MOON_S[1], MOON_S[2], 0.6 * e * nb, 0.05 * e))
      }
    } else {
      // a blazing fire lance: a cone of flame widening forward, a white-hot core, an ember blast, a scorch line
      p.alongAxis(cx, cy, cz, b.dx, b.dy, b.dz, L * 0.6, 0.8 * k, 'orb', p.rgb(SUN_O[0], SUN_O[1], SUN_O[2], 1.1 * e))
      for (let i = 0; i < 4; i++) {
        const u0 = i / 4
        const u1 = (i + 1) / 4
        const w = (0.12 + 0.55 * (u0 + u1) * 0.5) * k
        const mx = b.x + b.dx * L * (u0 + u1) * 0.5
        const my = b.y + b.dy * L * (u0 + u1) * 0.5
        const mz = b.z + b.dz * L * (u0 + u1) * 0.5
        for (const side of [1, -1]) p.besideAxis(mx, my, mz, b.dx, b.dy, b.dz, (L / 8) * 1.15, w, side, 'stripFire', p.rgb(1, 0.8, 0.5, 1.7 * e * (1 - u0 * 0.3)))
      }
      for (let i = 0; i < 7; i++) {
        const u = ((i + 0.3 + 0.5 * hash2(b.seed, i + 200)) / 7) * grow
        const ww = (0.25 + 0.6 * u) * k * (0.6 + 0.8 * hash2(b.seed, i + 210))
        p.billboard(b.x + b.dx * L * u, b.y + b.dy * L * u + (hash2(b.seed, i + 220) - 0.5) * ww * 0.4, b.z + b.dz * L * u, ww * 0.7, hash2(b.seed, i + 230) * 6.28 + age * (hash2(b.seed, i) - 0.5) * 3, 'flame', p.rgb(SUN_W[0], SUN_W[1], SUN_W[2], 1.8 * e))
      }
      p.alongAxis(cx, cy, cz, b.dx, b.dy, b.dz, L * 0.5, 0.14 * k, 'pillar', p.rgb(SUN_W[0], SUN_W[1], SUN_W[2], 4.5 * e))
      const sb = age / 0.45
      if (sb < 1) p.billboard(b.x, b.y, b.z, (0.3 + 0.7 * easeOut(sb)) * k, sb, 'solarBurst', p.rgb(WHITE[0], WHITE[1], WHITE[2], 3.4 * (1 - sb)))
      p.billboard(ex, ey, ez, 0.5 * k * grow, age * 3, 'solarBurst', p.rgb(SUN_G[0], SUN_G[1], SUN_G[2], 2.6 * e))
      // the ember blast, flung forward and out
      const eb = age / 0.9
      if (eb < 1) {
        for (let i = 0; i < 30; i++) {
          const sp = 2 + 4 * hash2(b.seed, i)
          const side = (hash2(b.seed, i + 30) - 0.5) * 2.2
          const up = 0.5 + 2 * hash2(b.seed, i + 60)
          const tt = eb * 0.9
          const vx = b.dx * sp + v2.x * side
          const vz = b.dz * sp + v2.z * side
          const vy = up - 9.8 * tt
          const vl = Math.hypot(vx, vy, vz) || 1
          p.alongAxis(b.x + vx * tt, b.y + up * tt - 4.9 * tt * tt, b.z + vz * tt, vx / vl, vy / vl, vz / vl, 0.07, 0.022, 'ember', p.rgb(SUN_W[0], SUN_W[1], SUN_W[2], 4 * (1 - eb)))
        }
      }
      // the scorch line burnt along the ground under the lance
      const sl = 1 - smooth(life - 0.6, life, age)
      const gl = L * 0.5
      p.oriented(b.x + b.dx * gl, b.gy + 0.04, b.z + b.dz * gl, b.dx * gl, 0, b.dz * gl, v2.x * 0.45 * k, 0, v2.z * 0.45 * k, 'scorch', p.rgb(SUN_O[0], SUN_O[1], SUN_O[2], 1.8 * sl, 0.3 * sl))
    }
  }

  /** The lance's body: the tier's strip both sides of its axis, bright edges on the axis. */
  private lanceStrip(cx: number, cy: number, cz: number, b: Burst, L: number, w: number, name: 'stripStar' | 'stripMoon' | 'stripFire', col: Rgba): void {
    void cx
    void cy
    void cz
    // in pieces, faded in at the spear and out at the far end (the strip has no ends of its own)
    const n = 6
    const r = col.r
    const g = col.g
    const bl = col.b
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) / n
      const f = Math.min(1, u * 4) * Math.min(1, (1 - u) * 2.2)
      const x = b.x + b.dx * L * u
      const y = b.y + b.dy * L * u
      const z = b.z + b.dz * L * u
      const ww = w * (0.55 + 0.65 * u)
      col.r = r * f
      col.g = g * f
      col.b = bl * f
      for (const side of [1, -1]) this.painter.besideAxis(x, y, z, b.dx, b.dy, b.dz, (L / n) * 0.62, ww, side, name, col)
    }
  }

  // ---- arrows ---------------------------------------------------------------------------------------------------------

  private drawArrow(a: ArrowTrail, dt: number): boolean {
    const t = this.t
    const done = a.doneAt >= 0 || a.done()
    if (done && a.doneAt < 0) a.doneAt = t
    if (!done && dt > 0) {
      const at = a.at()
      if (at) {
        const o = a.head * 4
        a.samples[o] = t
        a.samples[o + 1] = at.pos[0]!
        a.samples[o + 2] = at.pos[1]!
        a.samples[o + 3] = at.pos[2]!
        a.head = (a.head + 1) % SAMPLES
        a.n = Math.min(SAMPLES, a.n + 1)
      }
    }
    const life = a.tier === 'moon' ? 0.7 : 0.5
    if (done && t - a.doneAt > life) {
      a.on = false
      return false
    }
    if (a.n < 1) return true
    const p = this.painter
    const s = a.samples
    const col = a.tier === 'star' ? STAR_V : a.tier === 'moon' ? MOON_S : SUN_O
    const headI = (a.head - 1 + SAMPLES) % SAMPLES
    const hx = s[headI * 4 + 1]!
    const hy = s[headI * 4 + 2]!
    const hz = s[headI * 4 + 3]!
    const fadeAll = done ? 1 - (t - a.doneAt) / life : 1
    // the trail: soft segments back along the path
    let px = hx
    let py = hy
    let pz = hz
    for (let k = 1; k < a.n; k++) {
      const i = (a.head - 1 - k + SAMPLES * 2) % SAMPLES
      const age = t - s[i * 4]!
      if (age > life) break
      const f = (1 - age / life) * fadeAll
      const x = s[i * 4 + 1]!
      const y = s[i * 4 + 2]!
      const z = s[i * 4 + 3]!
      p.line(px, py, pz, x, y, z, (a.tier === 'star' ? 0.07 : a.tier === 'moon' ? 0.11 : 0.1) * (0.4 + 0.6 * f), p.rgb(col[0], col[1], col[2], 2.8 * f))
      if (k % 2 === 0) {
        const h = hash2(a.seed, k)
        const sp = a.tier === 'star' ? 'flare' : a.tier === 'moon' ? 'mist' : 'ember'
        p.billboard(x + (h - 0.5) * 0.12, y + (hash2(a.seed, k + 9) - 0.5) * 0.12, z + (hash2(a.seed, k + 17) - 0.5) * 0.12, (a.tier === 'moon' ? 0.09 : 0.035) * (0.5 + f), h * 6, sp, p.rgb(a.tier === 'sun' ? 1 : WHITE[0], a.tier === 'sun' ? 0.8 : 1, a.tier === 'sun' ? 0.5 : 1, (a.tier === 'moon' ? 0.5 : 2.4) * f))
      }
      px = x
      py = y
      pz = z
    }
    if (!done) {
      // the head
      if (a.tier === 'star') p.billboard(hx, hy, hz, 0.34, t * 3, 'flare', p.rgb(STAR_W[0], STAR_W[1], STAR_W[2], 3.2))
      else if (a.tier === 'moon') {
        p.billboard(hx, hy, hz, 0.24, 0, 'orb', p.rgb(MOON_S[0], MOON_S[1], MOON_S[2], 1.6))
        p.billboard(hx, hy, hz, 0.2, -0.4, 'halo', p.rgb(MOON_S[0], MOON_S[1], MOON_S[2], 2))
        p.billboard(hx, hy, hz, 0.12, t * 2, 'flare', p.rgb(WHITE[0], WHITE[1], WHITE[2], 2.4))
      } else {
        p.billboard(hx, hy, hz, 0.36, t * 4, 'solarBurst', p.rgb(SUN_G[0], SUN_G[1], SUN_G[2], 2.2))
        p.billboard(hx, hy, hz, 0.1, 0, 'orb', p.rgb(SUN_W[0], SUN_W[1], SUN_W[2], 2.5))
      }
    }
    return true
  }

  // ---- bursts ---------------------------------------------------------------------------------------------------------

  /** Seconds a burst lasts by kind and tier. */
  private burstLife(b: Burst): number {
    if (b.kind === 'equip') return EQUIP_FLARE_S + 0.4
    if (b.kind === 'lance') return b.tier === 'moon' ? 0.85 : b.tier === 'sun' ? 1.1 : 0.7
    const base = b.tier === 'star' ? 1.1 : b.tier === 'moon' ? 1.4 : 1.3
    return b.kind === 'kill' ? base + (b.tier === 'sun' ? 2.2 : 0.8) : base
  }

  private drawBurst(b: Burst, lite: boolean): boolean {
    const age = this.t - b.t0
    if (age > this.burstLife(b)) {
      b.on = false
      return false
    }
    if (b.follow) {
      if (b.follow.isDisposed()) {
        b.on = false
        return false
      }
      const r = b.follow.getAbsolutePosition()
      b.x = r.x
      b.y = r.y + b.height
      b.z = r.z
      b.gy = r.y
    }
    const k = (b.kind === 'kill' ? 1.45 : b.kind === 'equip' ? 1.2 : 1) * (lite ? 0.8 : 1)
    if (b.kind === 'lance') this.drawLance(b, age, lite ? 0.8 : 1)
    else if (b.tier === 'star') this.starBurst(b, age, k)
    else if (b.tier === 'moon') this.moonBurst(b, age, k)
    else this.sunBurst(b, age, k)
    return true
  }

  private starBurst(b: Burst, age: number, k: number): void {
    const p = this.painter
    const t = this.t
    // shooting stars falling onto the point
    const n = b.kind === 'equip' ? 0 : b.kind === 'kill' ? 5 : 3
    for (let i = 0; i < n; i++) {
      const delay = i * 0.06
      const u = clamp01((age - delay) / 0.3)
      if (u <= 0 || u >= 1) continue
      const a = hash2(b.seed, i) * 6.28
      const sx = b.x + Math.cos(a) * 1.6
      const sy = b.y + 2.4 + hash2(b.seed, i + 5) * 0.8
      const sz = b.z + Math.sin(a) * 1.6
      const e = u * u
      const hx = sx + (b.x - sx) * e
      const hy = sy + (b.y - sy) * e
      const hz = sz + (b.z - sz) * e
      const tx = sx + (b.x - sx) * Math.max(0, e - 0.35)
      const ty = sy + (b.y - sy) * Math.max(0, e - 0.35)
      const tz = sz + (b.z - sz) * Math.max(0, e - 0.35)
      p.line(tx, ty, tz, hx, hy, hz, 0.08, p.rgb(STAR_V[0], STAR_V[1], STAR_V[2], 2.8 * k))
      p.billboard(hx, hy, hz, 0.12, 0, 'orb', p.rgb(STAR_W[0], STAR_W[1], STAR_W[2], 2 * k))
      p.billboard(hx, hy, hz, 0.32, t * 4, 'flare', p.rgb(STAR_W[0], STAR_W[1], STAR_W[2], 3.5 * k))
    }
    // the starburst
    const t0 = b.kind === 'equip' ? 0 : 0.27
    const u = (age - t0) / 0.75
    if (u > 0 && u < 1) {
      const size = (0.3 + 0.8 * easeOut(u)) * k
      p.billboard(b.x, b.y, b.z, size, hash2(b.seed, 1) * 6, 'starburst', p.rgb(WHITE[0], WHITE[1], WHITE[2], 2.6 * (1 - u) ** 1.5 * k))
      p.billboard(b.x, b.y, b.z, size * 0.7, 0, 'orb', p.rgb(STAR_V[0], STAR_V[1], STAR_V[2], 0.8 * (1 - u) * k))
      // sparkles thrown out
      const m = b.kind === 'kill' ? 26 : 14
      for (let i = 0; i < m; i++) {
        const a = hash2(b.seed, i + 30) * 6.28
        const el = (hash2(b.seed, i + 60) - 0.3) * 1.6
        const sp = (0.8 + 1.4 * hash2(b.seed, i + 90)) * k
        const d = easeOut(u) * sp
        const x = b.x + Math.cos(a) * Math.cos(el) * d
        const y = b.y + Math.sin(el) * d - 0.4 * u * u
        const z = b.z + Math.sin(a) * Math.cos(el) * d
        const tw = 0.5 + 0.5 * Math.sin(t * 20 + i)
        p.billboard(x, y, z, 0.05 + 0.04 * tw, t * 2 + i, 'flare', p.rgb(STAR_W[0], STAR_W[1], STAR_W[2], 2.6 * (1 - u) * k))
      }
    }
    // a kill: the constellation flashes around the victim
    if (b.kind === 'kill' && age > 0.3 && age < 1.8) {
      const f = Math.sin(Math.PI * clamp01((age - 0.3) / 1.5))
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * 6.28 + hash2(b.seed, i) * 0.6
        const r = 0.7 + 0.5 * hash2(b.seed, i + 3)
        v1.set(b.x + p.right.x * Math.cos(a) * r + p.up.x * Math.sin(a) * r, b.y + p.right.y * Math.cos(a) * r + p.up.y * Math.sin(a) * r + 0.3, b.z + p.right.z * Math.cos(a) * r + p.up.z * Math.sin(a) * r)
        if (i) p.line(v2.x, v2.y, v2.z, v1.x, v1.y, v1.z, 0.012, p.rgb(STAR_V[0], STAR_V[1], STAR_V[2], 1.8 * f))
        p.billboard(v1.x, v1.y, v1.z, 0.08, i, 'flare', p.rgb(WHITE[0], WHITE[1], WHITE[2], 3 * f))
        v2.copyFrom(v1)
      }
    }
  }

  private moonBurst(b: Burst, age: number, k: number): void {
    const p = this.painter
    const t = this.t
    const nb = 1 + this.night * 0.5
    // the crescent shockwave on the ground
    const u = age / (b.kind === 'kill' ? 1.3 : 1.0)
    if (u < 1) {
      const r = (0.4 + (b.kind === 'kill' ? 3.2 : 2.4) * easeOut(u)) * k
      p.flat(b.x, b.gy + 0.04, b.z, r, hash2(b.seed, 2) * 6.28 + u * 0.8, 'shockwave', p.rgb(MOON_S[0], MOON_S[1], MOON_S[2], 2.4 * (1 - u) ** 1.3 * nb))
      p.flat(b.x, b.gy + 0.035, b.z, r * 0.7, -u * 0.5, 'ripples', p.rgb(MOON_S[0], MOON_S[1], MOON_S[2], 1.1 * (1 - u) * nb))
    }
    // the crescent flash (a kill: a big crescent rising)
    const v = age / (b.kind === 'kill' ? 1.6 : 0.6)
    if (v < 1) {
      const rise = b.kind === 'kill' ? easeOut(v) * 1.4 : 0
      const size = (b.kind === 'kill' ? 0.65 : 0.5) * (0.7 + 0.3 * easeOut(v * 3)) * k
      p.billboard(b.x, b.y + rise, b.z, size * 1.4, 0, 'orb', p.rgb(MOON_B[0], MOON_B[1], MOON_B[2], 0.35 * (1 - v) * nb))
      p.billboard(b.x, b.y + rise, b.z, size, -0.4 + hash2(b.seed, 4) * 0.3, 'halo', p.rgb(MOON_S[0], MOON_S[1], MOON_S[2], 2.6 * (1 - v) ** 1.2 * nb))
    }
    // a burst of mist
    const w = age / 1.2
    if (w < 1) {
      const m = b.kind === 'kill' ? 10 : 6
      for (let i = 0; i < m; i++) {
        const a = hash2(b.seed, i + 40) * 6.28
        const d = easeOut(w) * (0.6 + 0.8 * hash2(b.seed, i + 50)) * k
        p.billboard(b.x + Math.cos(a) * d, b.y - 0.3 + hash2(b.seed, i) * 0.6, b.z + Math.sin(a) * d, 0.25 + 0.4 * w, a, 'mist', p.rgb(MOON_S[0], MOON_S[1], MOON_S[2], 0.6 * Math.sin(Math.PI * w) * nb, 0.06))
      }
      for (let i = 0; i < 8; i++) {
        const a = hash2(b.seed, i + 70) * 6.28
        const d = easeOut(w) * (1 + hash2(b.seed, i + 80)) * k
        p.billboard(b.x + Math.cos(a) * d, b.y + (hash2(b.seed, i + 90) - 0.3) * d, b.z + Math.sin(a) * d, 0.05, t + i, 'flare', p.rgb(WHITE[0], WHITE[1], WHITE[2], 2.4 * (1 - w)))
      }
    }
  }

  private sunBurst(b: Burst, age: number, k: number): void {
    const p = this.painter
    // the solar flare
    const u = age / 0.7
    if (u < 1) {
      const size = (0.35 + 0.75 * easeOut(u)) * k
      p.flat(b.x, b.gy + 0.05, b.z, 2.2 * k, 0, 'orb', p.rgb(SUN_O[0], SUN_O[1], SUN_O[2], 0.6 * (1 - u)))
      p.billboard(b.x, b.y, b.z, size * 1.3, 0, 'orb', p.rgb(SUN_O[0], SUN_O[1], SUN_O[2], 1.2 * (1 - u) * k))
      p.billboard(b.x, b.y, b.z, size, hash2(b.seed, 1) * 6.28 + u * 0.6, 'solarBurst', p.rgb(WHITE[0], WHITE[1], WHITE[2], 3.2 * (1 - u) ** 1.2 * k))
    }
    // god rays up from the point
    const g = age / (b.kind === 'kill' ? 1.6 : 1.0)
    if (g < 1) {
      const a = Math.sin(Math.PI * Math.min(1, g * 1.6)) * (1 - g)
      v1.set(p.right.x, 0, p.right.z)
      if (v1.lengthSquared() < 1e-6) v1.set(1, 0, 0)
      v1.normalize()
      const h = (b.kind === 'kill' ? 2.4 : 1.6) * k
      p.oriented(b.x, b.gy + h, b.z, v1.x * h * 0.8, 0, v1.z * h * 0.8, 0, h, 0, 'godrays', p.rgb(SUN_G[0], SUN_G[1], SUN_G[2], 2.2 * a * k))
    }
    // embers flung out
    const e = age / 1.1
    if (e < 1) {
      const m = b.kind === 'kill' ? 30 : 18
      for (let i = 0; i < m; i++) {
        const a = hash2(b.seed, i + 30) * 6.28
        const vy = 1.5 + 2.5 * hash2(b.seed, i + 60)
        const sp = (1 + 2.2 * hash2(b.seed, i + 90)) * k
        const tt = e * 1.1
        const x = b.x + Math.cos(a) * sp * tt
        const y = b.y + vy * tt - 4.9 * tt * tt
        const z = b.z + Math.sin(a) * sp * tt
        const vx = Math.cos(a) * sp
        const vyy = vy - 9.8 * tt
        const vz = Math.sin(a) * sp
        const vl = Math.hypot(vx, vyy, vz) || 1
        p.alongAxis(x, y, z, vx / vl, vyy / vl, vz / vl, 0.06, 0.02, 'ember', p.rgb(SUN_W[0], SUN_W[1], SUN_W[2], 3.5 * (1 - e)))
      }
    }
    // a kill: the sunburst and the scorched ground
    if (b.kind === 'kill') {
      const s = age / 0.9
      if (s < 1) p.billboard(b.x, b.y, b.z, (0.5 + 0.95 * easeOut(s)) * k, -s, 'flareRing', p.rgb(SUN_G[0], SUN_G[1], SUN_G[2], 2.6 * (1 - s) ** 1.5))
      const life = this.burstLife(b)
      const f = 1 - smooth(life - 1.2, life, age)
      p.flat(b.x, b.gy + 0.04, b.z, 1.3 * k, hash2(b.seed, 3) * 6, 'scorch', p.rgb(SUN_O[0], SUN_O[1], SUN_O[2], 1.6 * f * (0.8 + 0.2 * Math.sin(age * 9)), 0.4 * f))
    }
  }

  // ---- drops --------------------------------------------------------------------------------------------------------

  private drawDrop(d: DropFx): void {
    const pos = d.node.getAbsolutePosition()
    const age = this.t - d.t0
    if (d.tier === 'star') this.dropStar(d, pos, age)
    else if (d.tier === 'moon') this.dropMoon(d, pos, age)
    else this.dropSun(d, pos, age)
  }

  /** The constellation drawing itself above the drop, then falling onto it as a shooting star; then a violet mark. */
  private dropStar(d: DropFx, pos: Vector3, age: number): void {
    const p = this.painter
    const t = this.t
    const cx = pos.x
    const cy = pos.y + 1.9
    const cz = pos.z
    const S = 1.25
    const draw = 2.0
    if (age < draw + 0.5) {
      const f = age < draw ? 1 : 1 - (age - draw) / 0.5
      let prevX = 0
      let prevY = 0
      let prevZ = 0
      for (let i = 0; i < STAR_SHAPE.length; i++) {
        const [sx, sy] = STAR_SHAPE[i]!
        const x = cx + (p.right.x * sx + 0) * S
        const y = cy + sy * S
        const z = cz + p.right.z * sx * S
        const reach = i * (draw / STAR_SHAPE.length)
        if (age < reach) break
        if (i) {
          const seg = clamp01((age - reach + draw / STAR_SHAPE.length) / (draw / STAR_SHAPE.length))
          const ex = prevX + (x - prevX) * seg
          const ey = prevY + (y - prevY) * seg
          const ez = prevZ + (z - prevZ) * seg
          p.line(prevX, prevY, prevZ, ex, ey, ez, 0.035, p.rgb(STAR_V[0], STAR_V[1], STAR_V[2], 3 * f))
        }
        const pop = Math.max(0, 1 - (age - reach) / 0.4)
        p.billboard(x, y, z, 0.16 + 0.25 * pop, t + i, 'flare', p.rgb(STAR_W[0], STAR_W[1], STAR_W[2], (3.2 + 3 * pop) * f))
        prevX = x
        prevY = y
        prevZ = z
      }
      p.billboard(cx, cy, cz, 1.6, 0, 'orb', p.rgb(STAR_DEEP[0], STAR_DEEP[1], STAR_DEEP[2], 0.18 * f))
    }
    // the fall
    const fall = (age - draw) / 0.45
    if (fall > 0 && fall < 1) {
      const e = fall * fall
      const hy = cy + (pos.y + 0.3 - cy) * e
      p.line(cx, Math.min(cy, hy + 1.2), cz, cx, hy, cz, 0.06, p.rgb(STAR_V[0], STAR_V[1], STAR_V[2], 2.6))
      p.billboard(cx, hy, cz, 0.3, t * 4, 'flare', p.rgb(WHITE[0], WHITE[1], WHITE[2], 4))
    }
    const land = age - draw - 0.45
    if (land > 0 && land < 0.8) {
      const u = land / 0.8
      p.billboard(pos.x, pos.y + 0.4, pos.z, 0.4 + 1.2 * easeOut(u), 0.3, 'starburst', p.rgb(WHITE[0], WHITE[1], WHITE[2], 3 * (1 - u) ** 1.5))
    }
    if (land > 0) {
      const a = Math.min(1, land / 0.6) * (0.85 + 0.15 * Math.sin(t * 2.2 + d.seed))
      p.alongAxis(pos.x, pos.y + 1.3, pos.z, 0, 1, 0, 1.3, 0.16, 'pillar', p.rgb(STAR_V[0], STAR_V[1], STAR_V[2], 1.3 * a))
      p.flat(pos.x, pos.y + 0.03, pos.z, 0.55, t * 0.3, 'starburst', p.rgb(STAR_V[0], STAR_V[1], STAR_V[2], 0.9 * a))
      for (let i = 0; i < 4; i++) {
        const an = t * 1.2 + i * 1.57
        const tw = 0.5 + 0.5 * Math.sin(t * 4 + i * 2)
        p.billboard(pos.x + Math.cos(an) * 0.35, pos.y + 0.35 + 0.15 * Math.sin(t + i), pos.z + Math.sin(an) * 0.35, 0.05 + 0.03 * tw, t + i, 'flare', p.rgb(STAR_W[0], STAR_W[1], STAR_W[2], 2.5 * tw * a))
      }
    }
  }

  /** A moonbeam from the sky onto the drop, a crescent above it and ripples; then the beam stays, softer. */
  private dropMoon(d: DropFx, pos: Vector3, age: number): void {
    const p = this.painter
    const t = this.t
    const nb = 1 + this.night * 0.6
    const top = 16
    const down = easeOut(age / 0.7)
    const bottom = top - (top - 0) * down
    const intro = age < 1.6 ? 1 + 1.5 * (1 - age / 1.6) : 1
    const steady = 0.6 + 0.1 * Math.sin(t * 1.1 + d.seed)
    const h = (top - bottom) / 2
    if (h > 0.01) p.alongAxis(pos.x, pos.y + bottom + h, pos.z, 0, 1, 0, h, 0.55 * (0.8 + 0.4 * (intro - 1)), 'pillar', p.rgb(MOON_S[0], MOON_S[1], MOON_S[2], steady * intro * nb))
    if (age > 0.6) {
      const u = (age - 0.6) / 1.2
      if (u < 1) p.flat(pos.x, pos.y + 0.04, pos.z, 0.4 + 2.6 * easeOut(u), u, 'shockwave', p.rgb(MOON_S[0], MOON_S[1], MOON_S[2], 2.2 * (1 - u) * nb))
      const a = Math.min(1, (age - 0.6) / 0.5)
      p.billboard(pos.x, pos.y + 1.5 + 0.06 * Math.sin(t), pos.z, 0.42, -0.35, 'halo', p.rgb(MOON_S[0], MOON_S[1], MOON_S[2], 1.5 * a * nb))
      for (let i = 0; i < 2; i++) {
        const v = ((t * 0.3 + i * 0.5) % 1 + 1) % 1
        p.flat(pos.x, pos.y + 0.03, pos.z, 0.4 + 1.0 * v, t * 0.05, 'ripples', p.rgb(MOON_S[0], MOON_S[1], MOON_S[2], 0.8 * Math.sin(Math.PI * v) * a * nb))
      }
    }
  }

  /** A pillar of sunfire erupting from the drop with the sun-disc on the ground; then a burning column. */
  private dropSun(d: DropFx, pos: Vector3, age: number): void {
    const p = this.painter
    const t = this.t
    const up = easeOut(age / 0.45)
    const tall = 3 + 7 * up * (age < 1.5 ? 1 : Math.max(0.55, 1 - (age - 1.5) / 2))
    const intro = age < 1.8 ? 1 + 1.6 * (1 - age / 1.8) : 1
    const fl = 0.85 + 0.15 * Math.sin(t * 8 + d.seed) * Math.sin(t * 3.7)
    p.alongAxis(pos.x, pos.y + tall / 2, pos.z, 0, 1, 0, tall / 2, 0.42 * (0.85 + 0.3 * (intro - 1)), 'pillar', p.rgb(SUN_G[0], SUN_G[1], SUN_G[2], 1.5 * intro * fl))
    p.alongAxis(pos.x, pos.y + tall * 0.3, pos.z, 0, 1, 0, tall * 0.3, 0.7, 'pillar', p.rgb(SUN_O[0], SUN_O[1], SUN_O[2], 0.6 * intro))
    // flames climbing the column
    for (let i = 0; i < 10; i++) {
      const u = ((t * 0.9 + hash2(d.seed, i)) % 1 + 1) % 1
      const a = hash2(d.seed, i + 20) * 6.28
      const r = 0.12 + 0.12 * hash2(d.seed, i + 40)
      p.billboard(pos.x + Math.cos(a + t) * r, pos.y + u * tall * 0.55, pos.z + Math.sin(a + t) * r, 0.22 * (1 - u * 0.6), 0, 'flame', p.rgb(SUN_W[0], SUN_W[1], SUN_W[2], 1.8 * Math.sin(Math.PI * u)))
    }
    if (age < 0.8) {
      const u = age / 0.8
      p.billboard(pos.x, pos.y + 0.4, pos.z, 0.5 + 1.6 * easeOut(u), u, 'solarBurst', p.rgb(WHITE[0], WHITE[1], WHITE[2], 3.2 * (1 - u)))
    }
    if (age < 2) {
      const g = age / 2
      v1.set(p.right.x, 0, p.right.z)
      if (v1.lengthSquared() < 1e-6) v1.set(1, 0, 0)
      v1.normalize()
      p.oriented(pos.x, pos.y + 2.4, pos.z, v1.x * 2.2, 0, v1.z * 2.2, 0, 2.4, 0, 'godrays', p.rgb(SUN_G[0], SUN_G[1], SUN_G[2], 2.2 * Math.sin(Math.PI * g)))
    }
    // the sun-disc on the ground, turning
    const ds = Math.min(1, age / 0.9)
    const r = 1.25 * easeOut(ds)
    const a = t * 0.25
    p.oriented(pos.x, pos.y + 0.04, pos.z, Math.cos(a) * r, 0, Math.sin(a) * r, -Math.sin(a) * r, 0, Math.cos(a) * r, 'mandala', p.rgb(SUN_G[0], SUN_G[1], SUN_G[2], 1.3 * fl))
    // embers
    for (let i = 0; i < 8; i++) {
      const u = ((t * 0.45 + hash2(d.seed, i + 60)) % 1 + 1) % 1
      const an = hash2(d.seed, i + 70) * 6.28
      p.billboard(pos.x + Math.cos(an) * (0.2 + u * 0.6), pos.y + u * 3, pos.z + Math.sin(an) * (0.2 + u * 0.6), 0.03, 0, 'ember', p.rgb(SUN_W[0], SUN_W[1], SUN_W[2], 3 * (1 - u)))
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.obs) this.scene.onBeforeRenderObservable.remove(this.obs)
    for (const s of this.sources) if (s.listener === this) s.listener = null
    this.sources.clear()
    this.carriers.clear()
    this.drops.clear()
    this.batch.dispose()
    this.flashes.dispose()
    this.glow.dispose()
    REGISTRY.delete(this.scene)
  }
}

/** The drop's constellation (a dipper with a tail; x across the camera, y up, roughly −1..1). */
const STAR_SHAPE: readonly (readonly [number, number])[] = [
  [-0.95, 0.15], [-0.55, 0.45], [-0.15, 0.3], [0.2, 0.55], [0.55, 0.2], [0.35, -0.3], [0.85, -0.55],
]

/** Used by the tests: the LOD per index of a nearest-first list (your own first). */
export function lodList(entries: readonly { self: boolean; distance: number }[], caps: LodCaps): Lod[] {
  const out: Lod[] = []
  let full = 0
  entries.forEach((e, i) => {
    const l = lodOf(i, e.self, e.distance, full, caps)
    if (l === 'full') full++
    out.push(l)
  })
  return out
}

