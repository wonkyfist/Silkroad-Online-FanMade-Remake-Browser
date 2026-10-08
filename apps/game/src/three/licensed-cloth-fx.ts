// The seal armour's motion (docs/CHARACTERS.md §16.9): the clock the cloth plugin animates by (licensed-cloth.ts
// ClothClock) and the few particles off the hems of the nearest sealed outfits: Star sparkles that blink as they drift
// up, Moon's soft silver mist, Sun's embers rising and cooling. Like the rare weapons' motes (weapon-rarity.ts): your
// own first, then the nearest on screen within range, at most the preset's cap; none on Low / Classic (the cloth's
// static look) or at the far LODs. One quad batch of its own (one draw for every sealed outfit).
import { Vector3, type Camera, type Nullable, type Observer, type Scene, type TransformNode } from '@babylonjs/core'
import type { RarityTier } from '@sro/shared'
import { sceneExposure } from '@sro/world-render'
import { FxBatch } from '../world/rarity/batch.ts'
import { Painter } from '../world/rarity/paint.ts'
import { clothClockOf, type ClothClock } from './licensed-cloth.ts'
import { hash2, MOTE_RANGE_M, type RarityMode } from './weapon-rarity.ts'

/** A body wearing a sealed outfit, as the particles read it (CharacterActor). */
export interface ClothWearer {
  readonly root: TransformNode
  readonly isOffscreen: boolean
  readonly licensedLod: number
  readonly lodFull: boolean
  joint(name: string): TransformNode | undefined
}

/** Particles per sealed outfit (Medium; High / Ultra the same: the cap of outfits grows instead). */
export const HEM_PARTICLES: Readonly<Record<RarityTier, number>> = { star: 9, moon: 6, sun: 8 }
const SPRITE = { star: 'flare', moon: 'mist', sun: 'ember' } as const
const COLOURS: Readonly<Record<RarityTier, readonly [readonly number[], readonly number[]]>> = {
  star: [[0.85, 0.78, 1.0], [0.5, 0.35, 1.0]],
  moon: [[0.82, 0.88, 1.0], [0.62, 0.7, 0.86]],
  sun: [[1.0, 0.78, 0.32], [1.0, 0.32, 0.06]],
}

/** One hem particle at `seconds` (pure, tests): where it starts (0 hem, 1 cuff), its rise, outward drift, size, alpha. */
export interface HemParticle {
  cuff: boolean
  angle: number
  h: number
  up: number
  out: number
  size: number
  alpha: number
  mix: number
}

export function hemParticleAt(tier: RarityTier, i: number, phase: number, seconds: number, out: HemParticle = { cuff: false, angle: 0, h: 0, up: 0, out: 0, size: 0, alpha: 0, mix: 0 }): HemParticle {
  const seed = Math.floor(phase * 9973) + i * 131
  const h1 = hash2(seed, 1)
  const period = tier === 'star' ? 1.3 + 0.9 * h1 : tier === 'moon' ? 2.8 + 1.4 * h1 : 1.8 + 1.0 * h1
  const cyc = seconds / period + hash2(seed, 2)
  const n = Math.floor(cyc)
  const u = cyc - n
  const s = Math.sin(Math.PI * u)
  out.cuff = hash2(seed, n * 7 + 3) < 0.3
  out.angle = hash2(seed, n * 7 + 4) * Math.PI * 2
  out.h = hash2(seed, n * 7 + 5)
  out.mix = u
  if (tier === 'star') {
    out.up = u * 0.22
    out.out = 0.03 + u * 0.08
    out.size = 0.5 + 0.8 * s
    out.alpha = s * s * (0.6 + 0.4 * Math.sin(seconds * 9 + i))
  } else if (tier === 'moon') {
    out.up = -0.04 + u * 0.12
    out.out = 0.04 + u * 0.12
    out.size = 0.9 + 1.4 * u
    out.alpha = 0.3 * s
  } else {
    out.up = Math.pow(u, 0.8) * 0.75
    out.out = 0.02 + Math.sin(u * 6 + h1 * 9) * 0.04
    out.size = 0.6 * (1 - 0.5 * u)
    out.alpha = (1 - u) * Math.min(1, u * 8)
  }
  return out
}

/** Sprite half-size (m) at size 1, per tier. */
const UNIT: Readonly<Record<RarityTier, number>> = { star: 0.045, moon: 0.1, sun: 0.035 }
const BRIGHT: Readonly<Record<RarityTier, number>> = { star: 2, moon: 0.8, sun: 2 }

interface Entry {
  tiers: RarityTier[]
  phase: number
}

/** The scene's seal cloth motion: the clock, the wearers, the hem particles. */
export class ClothFx {
  readonly clock: ClothClock
  private readonly wearers = new Map<ClothWearer, Entry>()
  private batch: FxBatch | null = null
  private painter: Painter | null = null
  private readonly obs: Nullable<Observer<Scene>>
  private readonly shown: ClothWearer[] = []
  private readonly keys: number[] = []
  private readonly p: HemParticle = { cuff: false, angle: 0, h: 0, up: 0, out: 0, size: 0, alpha: 0, mix: 0 }
  private readonly a = new Vector3()
  private readonly b = new Vector3()
  private readonly c = new Vector3()
  /** LAB: the hem particles off (the cloth's own look stays). */
  particles = true
  /** Per frame (the lab, the bench). */
  readonly stats = { wearers: 0, near: 0, quads: 0, ms: 0 }
  private disposed = false

  constructor(readonly scene: Scene, private readonly modeOf: () => RarityMode) {
    this.clock = clothClockOf(scene)
    this.obs = scene.onBeforeRenderObservable.add(() => this.frame())
  }

  /** A body's sealed tiers (empty: none, it leaves the list). */
  set(w: ClothWearer, tiers: readonly RarityTier[]): void {
    if (!tiers.length) {
      this.wearers.delete(w)
      return
    }
    const e = this.wearers.get(w)
    if (e) e.tiers = [...tiers]
    else this.wearers.set(w, { tiers: [...tiers], phase: Math.random() })
  }

  frame(): void {
    if (this.disposed) return
    const t0 = performance.now()
    const mode = this.modeOf()
    const c = this.clock
    c.lite = mode.lite
    // the clock wraps every hour (float precision in the shader); stopped on the static look
    if (!c.lite) c.seconds = (t0 / 1000) % 3600
    this.stats.wearers = this.wearers.size
    this.stats.near = 0
    if (!this.wearers.size && !this.batch) return
    const batch = (this.batch ??= new FxBatch(this.scene, 64))
    const p = (this.painter ??= new Painter(batch))
    batch.begin()
    const camera: Camera | null = this.scene.activeCamera
    if (camera && !mode.lite && this.particles && !c.off) {
      const exposure = sceneExposure(this.scene)
      batch.setGain(1 / Math.max(1e-3, exposure), true)
      p.frame(camera)
      const near = this.pick(mode.moteCap, p.eye)
      this.stats.near = near.length
      for (const w of near) this.drawWearer(w, this.wearers.get(w)!, c.seconds, p)
    }
    this.stats.quads = batch.count
    batch.end()
    this.stats.ms = this.stats.ms * 0.95 + (performance.now() - t0) * 0.05
  }

  /** Your own first, then the nearest on screen within range at LOD0 / LOD1, at most `cap`. */
  private pick(cap: number, eye: Vector3): ClothWearer[] {
    const out = this.shown
    const keys = this.keys
    out.length = 0
    keys.length = 0
    for (const w of this.wearers.keys()) {
      if (w.root.isDisposed()) {
        this.wearers.delete(w)
        continue
      }
      if (w.isOffscreen || w.licensedLod >= 2 || !w.root.isEnabled()) continue
      const d = Vector3.Distance(eye, w.root.getAbsolutePosition())
      if (!w.lodFull && d > MOTE_RANGE_M) continue
      const key = w.lodFull ? -1 : d
      let i = out.length
      out.push(w)
      keys.push(key)
      while (i > 0 && keys[i - 1]! > key) {
        out[i] = out[i - 1]!
        keys[i] = keys[i - 1]!
        i--
      }
      out[i] = w
      keys[i] = key
    }
    if (out.length > cap) {
      out.length = cap
      keys.length = cap
    }
    return out
  }

  private jointPos(w: ClothWearer, names: readonly string[], to: Vector3): boolean {
    for (const n of names) {
      const j = w.joint(n)
      if (j) {
        to.copyFrom(j.getAbsolutePosition())
        return true
      }
    }
    return false
  }

  private drawWearer(w: ClothWearer, e: Entry, seconds: number, p: Painter): void {
    // the hem: a ring around the legs a little above the feet; the cuffs: the hands
    const root = w.root.getAbsolutePosition()
    const fl = this.jointPos(w, ['foot_l', 'Bip01 L Foot'], this.a)
    const fr = this.jointPos(w, ['foot_r', 'Bip01 R Foot'], this.b)
    let cx = root.x
    let cy = root.y
    let cz = root.z
    if (fl && fr) {
      cx = (this.a.x + this.b.x) / 2
      cy = Math.min(this.a.y, this.b.y)
      cz = (this.a.z + this.b.z) / 2
    }
    const scale = w.root.scaling.y || 1
    for (const tier of e.tiers) {
      const n = HEM_PARTICLES[tier]
      const [core, edge] = COLOURS[tier]
      for (let i = 0; i < n; i++) {
        const q = hemParticleAt(tier, i + (tier === 'moon' ? 50 : tier === 'sun' ? 100 : 0), e.phase, seconds, this.p)
        if (q.alpha <= 0.01) continue
        let x: number, y: number, z: number
        const ca = Math.cos(q.angle)
        const sa = Math.sin(q.angle)
        if (q.cuff && this.jointPos(w, i & 1 ? ['hand_l', 'Bip01 L Hand'] : ['hand_r', 'Bip01 R Hand'], this.c)) {
          x = this.c.x + ca * (0.05 + q.out)
          y = this.c.y + 0.04 + q.up
          z = this.c.z + sa * (0.05 + q.out)
        } else {
          const r = (0.24 + q.out) * scale
          x = cx + ca * r
          y = cy + (0.15 + 0.35 * q.h) * scale + q.up
          z = cz + sa * r
        }
        const k = Math.min(1, q.mix)
        const col = p.rgb(core[0]! + (edge[0]! - core[0]!) * k, core[1]! + (edge[1]! - core[1]!) * k, core[2]! + (edge[2]! - core[2]!) * k, q.alpha * BRIGHT[tier])
        const spin = tier === 'star' ? seconds * 1.4 + i : tier === 'moon' ? i * 1.7 + seconds * 0.2 : 0
        p.billboard(x, y, z, UNIT[tier] * q.size, spin, SPRITE[tier], col)
      }
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.obs) this.scene.onBeforeRenderObservable.remove(this.obs)
    this.batch?.dispose()
    this.wearers.clear()
  }
}

const REGISTRY = new WeakMap<Scene, ClothFx>()

/** The scene's seal cloth motion (made on first use; `mode` the rare weapons' mode: Low / Classic lite, the cap). */
export function clothFxFor(scene: Scene, mode: () => RarityMode): ClothFx {
  let fx = REGISTRY.get(scene)
  if (!fx) {
    fx = new ClothFx(scene, mode)
    REGISTRY.set(scene, fx)
    scene.onDisposeObservable.addOnce(() => fx!.dispose())
    // the look lab and the bench: stats, the particles and the seal looks off (A/B)
    ;(globalThis as { __sroClothFx?: unknown }).__sroClothFx = {
      stats: () => ({ ...fx!.stats, lite: fx!.clock.lite }),
      particles: (on: boolean) => (fx!.particles = on),
      seals: (on: boolean) => (fx!.clock.off = !on),
      freeze: (s: number | null) => {
        // a fixed clock (the animation strip): the frame loop keeps it while frozen
        const c = fx!.clock
        Object.defineProperty(c, 'seconds', s === null ? { value: c.seconds, writable: true, configurable: true } : { get: () => s, set: () => {}, configurable: true })
      },
    }
  }
  return fx
}

export function clothFxOf(scene: Scene): ClothFx | null {
  return REGISTRY.get(scene) ?? null
}
