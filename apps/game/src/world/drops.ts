/**
 * Ground items (EntityState kind 'item'), drawn as retail does (docs/EFFECTS.md §3.6): the item's own drop model
 * (`ItemDef.dropModel`, AssocFileDrop128: gold piles by amount `drop_ch_money_small/normal/large`, `drop_ch_equip`
 * bundles, `drop_ch_acc`, `drop_ch_bag` pouches, `drop_scroll`, ...) with the sparkle its BSR binds to it (sidecar
 * `particles`: the money glow, the yellow equipment twinkles, the red potion twinkles), lying still at a yaw seeded
 * by the entity id (every viewer agrees). No spin or bob; a rare weapon (Seal of Star / Moon / Sun) stands in its tier's
 * beam once it has landed (rarity-beam.ts, docs/RARITY.md §5.5).
 * A fresh drop (`EntityState.droppedAt` within TOSS_FRESH_MS) is tossed from `dropFrom` (the corpse) in an arc to its
 * spot, then equipment and accessories play their ATTREADY bounce once and rest on STAND1. Drops already on the ground
 * when they come into view skip the toss. Items without a drop model use the quest bundle, then a small box.
 * The public API is the one EntityView uses (constructor, setPickable, setHighlight, update, dispose) plus `place`,
 * which the fx-world feature calls with the entity's state once the view has loaded.
 */
import { Color3, CreateBox, StandardMaterial, TransformNode, type Mesh, type Scene } from '@babylonjs/core'
import { rarityOf, type ItemDef, type RarityTier, type Vec3 } from '@sro/shared'
import { HIGHLIGHT_COLOR, setHighlightOverlay } from '@sro/world-render'
import { ModelLibrary, type CharacterActor, type ModelSource } from '../three/models.ts'
import { ModelParticles, readParticles } from './fx/model-particles.ts'
import { fxBudget } from './fx/quality.ts'
import { systemFxFor, type FxRunner } from './fx/system-fx.ts'
import { RarityBeam } from './rarity-beam.ts'

/** A drop is fresh (tossed) when its spawn arrives within this of `droppedAt` (ms). */
export const TOSS_FRESH_MS = 1500
/** Length of the toss arc (ms), its apex over the straight line (m), and the throw height above the corpse (m). */
export const TOSS_MS = 450
export const TOSS_APEX_M = 0.6
export const TOSS_FROM_UP_M = 0.8
/** Drops whose sparkle plays at once (the N100 budget, docs/EFFECTS.md §6.5); the rest lie there without one. */
export const MAX_DROP_SPARKLES = 30

/** Drops that may sparkle at once now: MAX_DROP_SPARKLES and the graphics preset's budget. */
export function sparkleCap(): number {
  return Math.min(MAX_DROP_SPARKLES, fxBudget().dropSparkles)
}

/** Used for items whose ItemDef has no drop model (custom quest items): the retail quest bundle. */
export const QUEST_DROP: ModelSource = { code: 'DROP_CH_QUEST', glb: '/out/item/etc/drop_ch_quest.glb', sidecar: '/out/item/etc/drop_ch_quest.json' }

/** The model a ground item is drawn with: its ItemDef drop model (gold: the pile of its ITEM_ETC_GOLD_0N), else the quest bundle. */
export function dropModelOf(def: ItemDef | undefined): ModelSource {
  const m = def?.dropModel
  if (m?.glb) return { code: `DROP:${def!.code}`, glb: m.glb, ...(m.sidecar ? { sidecar: m.sidecar } : {}) }
  return QUEST_DROP
}

/** Seeded yaw of a ground item (radians, [0, 2π)): the same on every client. */
export function dropYaw(id: number): number {
  let h = (id | 0) ^ 0x9e3779b9
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h ^= h >>> 16
  return ((h >>> 0) / 4294967296) * Math.PI * 2
}

/** Is a drop that reached the ground at `droppedAt` (server ms) fresh at `now` (server ms)? */
export function isFreshDrop(droppedAt: number | undefined, now: number): boolean {
  return typeof droppedAt === 'number' && now - droppedAt < TOSS_FRESH_MS && now - droppedAt > -TOSS_FRESH_MS
}

/**
 * The toss offset from the resting spot at `t` (0..1 of TOSS_MS): starts at `from` (relative to the spot, metres) and
 * lands at the origin along a parabola with its apex TOSS_APEX_M above the straight line.
 */
export function tossOffset(t: number, from: readonly [number, number, number]): [number, number, number] {
  const u = Math.min(1, Math.max(0, t))
  if (u >= 1) return [0, 0, 0]
  const k = 1 - u
  return [from[0] * k, from[1] * k + 4 * TOSS_APEX_M * u * k, from[2] * k]
}

export interface DropPlacement {
  /** Entity id (seeds the yaw). */
  id: number
  /** Server ms now, and when the item reached the ground (EntityState.droppedAt). */
  now: number
  droppedAt?: number
  /** Where it was thrown from (EntityState.dropFrom), and where it lies (EntityState.pos): server coordinates. */
  from?: Vec3
  at: Vec3
  /** A fresh drop out of a victim whose death is not shown yet: hidden at the corpse until `release()`. */
  hold?: boolean
}

export class DropAssets {
  private lib: ModelLibrary | null = null
  private fallbackMat: StandardMaterial | null = null
  /** Drops with a live sparkle. */
  sparkles = 0
  private disposed = false
  /** Landed drops with a sparkle, and those waiting for a slot (the budget: MAX_DROP_SPARKLES, the preset's cap). */
  private readonly lit = new Set<DropVisual>()
  private readonly unlit = new Set<DropVisual>()
  private cap = -1

  constructor(readonly scene: Scene) {}

  /** Drop models load through their own ModelLibrary (one glb load per model, instanced per drop). */
  get library(): ModelLibrary {
    this.lib ??= new ModelLibrary(this.scene)
    return this.lib
  }

  /** The scene's shared effect runner (sparkles). */
  get runner(): FxRunner {
    return systemFxFor(this.scene).runner
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /** A landed drop with a sparkle asks for a slot (it gets one now, or when one frees up). */
  wantSparkle(d: DropVisual): void {
    if (this.lit.has(d)) return
    this.unlit.add(d)
    this.fill()
  }

  /** A drop leaves (picked up, out of view): its slot goes to the nearest drop still waiting. */
  releaseSparkle(d: DropVisual): void {
    this.unlit.delete(d)
    if (this.lit.delete(d)) this.fill()
    this.sparkles = this.lit.size
  }

  /** Re-applies the budget when the graphics preset changed it (drops call this from their update). */
  checkBudget(): void {
    if (sparkleCap() !== this.cap) this.fill()
  }

  /** Hands out the slots: the nearest waiting drops get free ones; over the budget, the farthest stop. */
  private fill(): void {
    const cap = sparkleCap()
    this.cap = cap
    if (this.lit.size > cap) {
      const far = [...this.lit].sort((a, b) => this.distance(b) - this.distance(a))
      for (const d of far.slice(0, this.lit.size - cap)) {
        this.lit.delete(d)
        this.unlit.add(d)
        d.setSparkle(false)
      }
    } else if (this.lit.size < cap && this.unlit.size) {
      const near = [...this.unlit].sort((a, b) => this.distance(a) - this.distance(b))
      for (const d of near.slice(0, cap - this.lit.size)) {
        this.unlit.delete(d)
        this.lit.add(d)
        d.setSparkle(true)
      }
    }
    this.sparkles = this.lit.size
  }

  private distance(d: DropVisual): number {
    const cam = this.scene.activeCamera
    if (!cam) return 0
    const p = d.root.getAbsolutePosition()
    const c = cam.globalPosition
    return Math.hypot(p.x - c.x, p.z - c.z)
  }

  /** A plain box's material, for items whose model cannot load. */
  fallback(): StandardMaterial {
    if (!this.fallbackMat) {
      const m = new StandardMaterial('drop:fallback', this.scene)
      m.diffuseColor = new Color3(0.62, 0.5, 0.32)
      m.specularColor = new Color3(0.1, 0.1, 0.1)
      this.fallbackMat = m
    }
    return this.fallbackMat
  }

  dispose(): void {
    this.disposed = true
    this.lib?.dispose()
    this.lib = null
    this.fallbackMat?.dispose()
    this.fallbackMat = null
    this.lit.clear()
    this.unlit.clear()
    this.sparkles = 0
  }
}

let serial = 0

export class DropVisual {
  readonly root: TransformNode
  /** Carries the toss offset; the model hangs under it. */
  private readonly body: TransformNode
  private actor: CharacterActor | null = null
  private box: Mesh | null = null
  private particles: ModelParticles | null = null
  private sparkleOn = false
  /** Hidden at the corpse, waiting for the kill to be shown (place with `hold`). */
  private held = false
  private mine = true
  private highlight = false
  private disposed = false
  /** Toss: offset of the start (metres, relative to the spot) and progress in ms; null = at rest. */
  private toss: { from: [number, number, number]; ms: number } | null = null
  private landed = true
  private placed = false
  private readonly model: ModelSource
  /** A seal's tier (docs/RARITY.md §5.5) and its beam, made when it lands. */
  readonly rarity: RarityTier | null
  private beam: RarityBeam | null = null
  /** Dropped just now (the seal's drop moment plays) or found lying there (only its mark). */
  private fresh = true

  constructor(private readonly assets: DropAssets, readonly isGold: boolean, readonly def: ItemDef | undefined) {
    const id = ++serial
    this.root = new TransformNode(`drop${id}`, assets.scene)
    this.body = new TransformNode(`dropBody${id}`, assets.scene)
    this.body.parent = this.root
    this.model = dropModelOf(def)
    this.rarity = rarityOf(def?.code)
    void this.load(this.model)
  }

  private async load(model: ModelSource): Promise<void> {
    const lib = this.assets.library
    try {
      const loaded = await lib.load(model.glb, model.sidecar)
      const actor = await lib.character(model)
      if (this.disposed || this.assets.isDisposed) {
        actor.dispose()
        return
      }
      this.actor = actor
      actor.root.parent = this.body
      if (this.highlight) actor.setHighlight(true)
      actor.play('STAND1')
      const list = readParticles(loaded.sidecar)
      if (list.length) {
        this.particles = new ModelParticles(this.assets.runner, list, { root: actor.root, joint: n => actor.joint(n) }, { ambient: false })
        this.particles.onClip('STAND1')
      }
      if (this.landed) this.land(false)
    } catch (err) {
      if (this.disposed) return
      if (model !== QUEST_DROP) {
        console.warn('[drops] model unavailable, using the quest bundle', model.glb, err)
        return this.load(QUEST_DROP)
      }
      console.warn('[drops] no drop model', err)
      this.makeBox()
    }
  }

  private makeBox(): void {
    const b = CreateBox(`dropBox${this.root.name}`, { width: 0.28, height: 0.18, depth: 0.22 }, this.assets.scene)
    b.position.y = 0.09
    b.material = this.assets.fallback()
    b.isPickable = false
    b.parent = this.body
    setHighlightOverlay(b, this.highlight ? HIGHLIGHT_COLOR : null)
    this.box = b
  }

  /**
   * Places the drop (fx-world feature, once the view has loaded): the seeded yaw, and the toss when the drop is fresh
   * and was thrown from somewhere else.
   */
  place(p: DropPlacement): void {
    if (this.placed || this.disposed) return
    this.placed = true
    this.body.rotation.y = dropYaw(p.id)
    this.fresh = isFreshDrop(p.droppedAt, p.now)
    // landed before it was placed (its model came first): an old drop shows only its mark
    if (!this.fresh && this.beam && this.rarity) {
      this.beam.dispose()
      this.beam = new RarityBeam(this.assets.scene, this.rarity, this.root, false)
    }
    if (p.from && isFreshDrop(p.droppedAt, p.now)) {
      const from: [number, number, number] = [p.from[0] - p.at[0], p.from[1] - p.at[1] + TOSS_FROM_UP_M, p.from[2] - p.at[2]]
      if (Math.hypot(from[0], from[1], from[2]) > 0.05) {
        this.toss = { from, ms: 0 }
        this.landed = false
        this.body.position.set(from[0], from[1], from[2])
        if (p.hold) {
          this.held = true
          this.body.setEnabled(false)
        }
      }
    }
  }

  /** The victim's death is shown (or the wait timed out): a held drop appears at the corpse and its toss starts. */
  release(): void {
    if (!this.held || this.disposed) return
    this.held = false
    this.body.setEnabled(true)
  }

  /** True while the toss arc plays (or waits to start, held). */
  get tossing(): boolean {
    return this.toss !== null
  }

  /** True while held at the corpse (hidden). */
  get holding(): boolean {
    return this.held
  }

  /** Landed: the bounce clip (equipment, accessories) when it was tossed, then the sparkle (a slot of the budget). */
  private land(bounce: boolean): void {
    this.landed = true
    if (this.rarity && !this.beam && !this.disposed) this.beam = new RarityBeam(this.assets.scene, this.rarity, this.root, this.fresh)
    const a = this.actor
    if (!a) return
    if (bounce) a.playClip('ATTREADY')
    if (this.particles?.hasAmbient) this.assets.wantSparkle(this)
  }

  /** DropAssets hands out or takes back a sparkle slot. */
  setSparkle(on: boolean): void {
    if (on === this.sparkleOn || this.disposed) return
    this.sparkleOn = on
    if (on) this.particles?.startAmbient()
    else this.particles?.stopAmbient()
  }

  /** `mine` = the viewer may pick it up now (own drop, free drop, or ownership expired): the label shows it. */
  setPickable(mine: boolean): void {
    this.mine = mine
  }

  get pickable(): boolean {
    return this.mine
  }

  setHighlight(on: boolean): void {
    if (on === this.highlight) return
    this.highlight = on
    this.actor?.setHighlight(on)
    // W9 LOOK: exposure-aware (on the PBR presets a plain overlay tone-mapped to a white silhouette).
    if (this.box) setHighlightOverlay(this.box, on ? HIGHLIGHT_COLOR : null)
  }

  update(dt: number): void {
    this.assets.checkBudget()
    if (this.toss && !this.held) {
      this.toss.ms += dt * 1000
      const [x, y, z] = tossOffset(this.toss.ms / TOSS_MS, this.toss.from)
      this.body.position.set(x, y, z)
      if (this.toss.ms >= TOSS_MS) {
        this.toss = null
        this.body.position.set(0, 0, 0)
        this.land(true)
      }
    }
    this.particles?.update(dt * 1000)
    this.beam?.update(dt)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.particles?.dispose()
    this.particles = null
    this.sparkleOn = false
    this.assets.releaseSparkle(this)
    this.actor?.dispose()
    this.actor = null
    this.beam?.dispose()
    this.beam = null
    this.box?.dispose()
    this.root.dispose(false, false)
  }
}
